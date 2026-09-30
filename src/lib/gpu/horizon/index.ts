/**
 * GPU horizon: the horizon-fast ray march (src/lib/horizon-fast/march.ts, the CPU twin and reference) as one
 * WGSL invocation per (eye, azimuth), for batches of eyes that share one ring-mosaic set (pose6dof's eye
 * search, several eye heights in the app worker).
 *
 *   const dev = await getComputeDevice();              // null → CPU
 *   const profs = await computeHorizonGpu(dev, mosaics, eyes, { noRidges: true });
 *   const prof = await computeHorizonAuto(mosaics, eye, opts);   // GPU when possible, else CPU; same shape
 *
 * Same step schedule, great-circle segmenting, bilinear sampling, max-mip block skipping and curvature +
 * refraction model as marchRay. Differences are f32 rounding only (see horizon.wgsl.ts); measured parity is
 * in scripts/gpu/horizon-bench.mjs.
 *
 * Mosaic upload: each mosaic's heights and max-mips go into ≤ 4 read-only storage "pages" (each ≤ the
 * device's maxStorageBufferBindingSize), once per mosaics array (WeakMap on the array's identity). Mosaics
 * are treated as immutable after the first GPU call; call releaseHorizonGpu(mosaics) to free the VRAM
 * early (otherwise it's freed when the device goes away).
 *
 * Plumbing (src/lib/gpu/core): the kernel is a core defineKernel (group "horizon", pass label
 * "horizon-march" for core/profile); the per-call buffers (uniform, params, output, stats) are pooled
 * slots under "horizon/…", reused by every chunk (WebGPU orders a chunk's writeBuffer after the previous
 * chunk's dispatch and staging copy, so no second set is needed); chunk c+1 is packed and submitted before
 * chunk c is collected, so the CPU packing overlaps the GPU march. (core/readback.ts maps with the raw
 * mapAsync, so collecting chunk c waits only for chunk c's work, not for c+1.)
 * Readback goes through core/readback's staging slots on the dispatch's own encoder;
 * bindings are set per pass. A call holds the "horizon" lease from upload to its last read, so
 * overlapping callers (several eye heights in the worker, the eye search) run one after another
 * instead of sharing buffers, and releaseHorizonGpu destroys pages only after in-flight calls finish.
 * Pooled slots are bound with their original byte sizes (core range()), so the kernel sees exactly
 * what it saw with per-call buffers: outputs are bit-identical to the pre-core path.
 *
 * Ridges and peaks (decision): the GPU doesn't record ridges. Ridge lists are variable-length per azimuth
 * and only the Overlay / refine paths use them; the app worker and eye search pass noRidges. So
 * computeHorizonGpu always returns an empty ridge list per azimuth (the shape computeHorizonFast gives with
 * noRidges), and computeHorizonAuto takes the CPU path whenever ridges are wanted (opts.noRidges falsy).
 * `opts.peaks` is classified on the CPU with peakVisibilityFast (one ray per peak; cheap), which is exactly
 * what computeHorizonFast does for them.
 *
 * App wiring (on by default since 2026-09-28, not opt-in): the horizon-fast-app worker marches on the GPU
 * wherever WebGPU exists (off with ?gpuHorizon=off or ?gpu=off; see opt-in.ts). autoAlign reacts to
 * last-bit changes in the skyline (IMG_6958's pose moves by ~0.01° yaw / 0.07° roll); that drift was
 * accepted when the default flipped. The eye search (../eye) and the page's eye suggestion use it
 * whenever getComputeDevice() gives a device. Only the unknown-pose 360° horizon (scene-profile.ts) is
 * still opt-in (?unknownGpu=on, unknown-opt-in.ts).
 */
import { Buffer, type Device } from "@luma.gl/core";
import { DEG, EARTH_R, REFRACTION_K } from "#/lib/geodesy";
import {
	defineKernel,
	dispatch,
	kernel,
	submit,
	warmKernels,
	warmKernelsAsync,
} from "#/lib/gpu/core/kernel";
import {
	acquire,
	pooledStorage,
	pooledUniform,
	range,
	withLease,
} from "#/lib/gpu/core/pool";
import { type StagedRead, stageReads } from "#/lib/gpu/core/readback";
import {
	computeHorizonFast,
	type Eye,
	type FastHorizonOptions,
	type FastHorizonProfile,
	peakVisibilityFast,
} from "#/lib/horizon-fast/march";
import { buildMips, type Mosaic } from "#/lib/horizon-fast/mosaic";
import { getComputeDevice } from "../device";
import { HORIZON_WGSL } from "./horizon.wgsl";

const RING_STRIDE = 40;
const MAX_PAGES = 4;
const MAX_MIPS = 8;
/** Rays per submit: keeps each command buffer well under a second (GPU watchdogs). */
const RAYS_PER_SUBMIT = 7200 * 24;
/** core/pool lease: every "horizon/…" slot, and the mosaic pages' lifetime. */
const LEASE = "horizon";

// ---------- mosaic upload (cached per mosaics array) ----------

interface RingLayout {
	page: number;
	dataOff: number;
	mipOff: number[];
}

interface MosaicSet {
	device: Device;
	pages: Buffer[];
	rings: RingLayout[];
	bytes: number;
	uploadMs: number;
}

const sets = new WeakMap<Mosaic[], MosaicSet>();

/**
 * Frees the GPU copy of these mosaics (the next GPU call re-uploads them). The pages are destroyed
 * once the calls already running (or queued) on the "horizon" lease are done with them.
 */
export function releaseHorizonGpu(mosaics: Mosaic[]) {
	const s = sets.get(mosaics);
	if (!s) return;
	sets.delete(mosaics);
	destroySet(s);
}

function destroySet(s: MosaicSet) {
	withLease(LEASE, () => {
		for (const p of s.pages) p.destroy();
	}).catch(() => {});
}

/** Uploads (once) the mosaics' heights + max-mips; builds missing mips like the CPU march does. */
export function uploadMosaics(device: Device, mosaics: Mosaic[]): MosaicSet {
	const hit = sets.get(mosaics);
	if (hit && hit.device === device) return hit;
	if (hit) releaseHorizonGpu(mosaics);
	const t0 = performance.now();
	const limit = Math.min(
		device.limits.maxStorageBufferBindingSize,
		device.limits.maxBufferSize,
	);
	// Greedy page packing, whole rings (data then its mip levels) per page.
	const sizes = mosaics.map((m) => {
		m.mip ??= buildMips(m);
		if (m.mip.mips.length > MAX_MIPS) throw new Error("too many mip levels");
		return (m.data.length + m.mip.mips.reduce((a, x) => a + x.length, 0)) * 4;
	});
	const pageBytes: number[] = [];
	const rings: RingLayout[] = [];
	for (let r = 0; r < mosaics.length; r++) {
		if (sizes[r] > limit)
			throw new Error(`ring ${r} (${sizes[r]} B) exceeds a storage binding`);
		let p = pageBytes.length - 1;
		if (p < 0 || pageBytes[p] + sizes[r] > limit) {
			pageBytes.push(0);
			p++;
		}
		if (p >= MAX_PAGES) throw new Error("mosaics need more than 4 GPU pages");
		const m = mosaics[r];
		const mip = m.mip as NonNullable<Mosaic["mip"]>;
		let off = pageBytes[p] / 4;
		const dataOff = off;
		off += m.data.length;
		const mipOff: number[] = [];
		for (const x of mip.mips) {
			mipOff.push(off);
			off += x.length;
		}
		rings.push({ page: p, dataOff, mipOff });
		pageBytes[p] = off * 4;
	}
	const pages = pageBytes.map((b, i) =>
		device.createBuffer({
			id: `horizon-page-${i}`,
			usage: Buffer.STORAGE | Buffer.COPY_DST,
			byteLength: Math.max(16, b),
		}),
	);
	try {
		for (let r = 0; r < mosaics.length; r++) {
			const m = mosaics[r];
			const L = rings[r];
			const pg = pages[L.page];
			pg.write(m.data, L.dataOff * 4);
			const mips = (m.mip as NonNullable<Mosaic["mip"]>).mips;
			for (let i = 0; i < mips.length; i++) pg.write(mips[i], L.mipOff[i] * 4);
		}
	} catch (e) {
		for (const p of pages) p.destroy();
		throw e;
	}
	const s: MosaicSet = {
		device,
		pages,
		rings,
		bytes: pageBytes.reduce((a, b) => a + b, 0),
		uploadMs: performance.now() - t0,
	};
	// No device.lost listener here: it would keep `mosaics` (and the pages) reachable for the device's
	// whole life, defeating the WeakMap. A hit on another device is re-uploaded above instead.
	sets.set(mosaics, s);
	return s;
}

// ---------- kernel (core/kernel: one pipeline per device) ----------

const MARCH = defineKernel(
	"horizon-march",
	HORIZON_WGSL,
	[
		["u", "uniform"],
		["params", "read-only-storage"],
		["pg0", "read-only-storage"],
		["pg1", "read-only-storage"],
		["pg2", "read-only-storage"],
		["pg3", "read-only-storage"],
		["outTD", "storage"],
		["stats", "storage"],
	],
	{ group: "horizon", label: "horizon-march" },
);

/** Creates the kernel's pipeline now (e.g. while tiles still decode). Never throws. */
export function warmHorizonGpu(device: Device) {
	warmKernels(device, "horizon");
}

/** warmHorizonGpu without blocking the thread (createComputePipelineAsync). Never rejects. */
export function warmHorizonGpuAsync(device: Device): Promise<void> {
	return warmKernelsAsync(device, "horizon").then(() => {});
}

// ---------- per-eye segmenting (mirrors march.ts makeCtx) ----------

interface EyeSegs {
	segD: number[];
	segRing: number[];
}

function segments(
	mosaics: Mosaic[],
	eye: Eye,
	minDistance: number,
	maxDistance: number,
	eps: number,
): EyeSegs {
	const kappa =
		Math.max(0.05, Math.tan(Math.min(80, Math.abs(eye.lat) + 3) * DEG)) /
		EARTH_R;
	const segD: number[] = [minDistance];
	const segRing: number[] = [];
	let d = minDistance;
	let ri = 0;
	while (d < maxDistance) {
		while (ri < mosaics.length - 1 && d >= mosaics[ri].maxDistance) ri++;
		const ringEnd =
			ri < mosaics.length - 1 ? mosaics[ri].maxDistance : maxDistance;
		const len = Math.max(200, Math.sqrt((8 * eps * d) / kappa));
		const next = Math.min(d + len, ringEnd, maxDistance);
		segRing.push(ri);
		segD.push(next);
		d = next;
	}
	return { segD, segRing };
}

// ---------- the call ----------

export interface GpuHorizonTiming {
	/** Mosaic upload in this call (0 when cached). */
	uploadMs: number;
	/** Params pack + dispatch + readback, all chunks. */
	gpuMs: number;
	/** Whole call. */
	totalMs: number;
	chunks: number;
}

/** Timing of the latest computeHorizonGpu call in this realm (benchmarks). */
export let lastGpuHorizonTiming: GpuHorizonTiming | null = null;

/**
 * Horizon profiles for a batch of eyes over one mosaic set. Same output as computeHorizonFast per eye,
 * except `ridges` is always one empty list per azimuth (see the header) and stats.ms is the batch's wall
 * time divided by the number of eyes. Throws on any GPU error (callers fall back to the CPU).
 */
export async function computeHorizonGpu(
	device: Device,
	mosaics: Mosaic[],
	eyes: Eye[],
	opts: FastHorizonOptions = {},
): Promise<FastHorizonProfile[]> {
	const t0 = performance.now();
	if (!eyes.length) return [];
	const out = await withLease(LEASE, () =>
		marchLocked(device, mosaics, eyes, opts, t0),
	);
	if (opts.peaks)
		for (let j = 0; j < eyes.length; j++)
			out[j].peaks = peakVisibilityFast(mosaics, eyes[j], opts.peaks, opts);
	const t2 = performance.now();
	for (const p of out) p.stats.ms = (t2 - t0) / eyes.length;
	if (lastGpuHorizonTiming) lastGpuHorizonTiming.totalMs = t2 - t0;
	return out;
}

/** The per-call slots, shared by every chunk of a call (queue order keeps chunks apart). */
function slots(device: Device, paramsBytes: number, outBytes: number) {
	return {
		u: `${LEASE}/u`,
		params: acquire(
			device,
			`${LEASE}/params`,
			paramsBytes,
			Buffer.STORAGE | Buffer.COPY_DST,
		),
		out: acquire(
			device,
			`${LEASE}/out`,
			outBytes,
			Buffer.STORAGE | Buffer.COPY_SRC,
		),
		stats: `${LEASE}/stats`,
	};
}

/** A submitted chunk: its readback and where its eyes go in the output. */
interface Pending {
	c0: number;
	nE: number;
	read: StagedRead;
}

/** computeHorizonGpu's body, holding the "horizon" lease (pooled slots and pages are ours). */
async function marchLocked(
	device: Device,
	mosaics: Mosaic[],
	eyes: Eye[],
	opts: FastHorizonOptions,
	t0: number,
): Promise<FastHorizonProfile[]> {
	const tu = performance.now();
	const set = uploadMosaics(device, mosaics);
	const t1 = performance.now();
	const uploadMs = t1 - tu;
	const k = kernel(device, MARCH);
	// unused pages bind a 16-byte dummy, as before
	const dummy = range(
		acquire(device, `${LEASE}/dummy`, 16, Buffer.STORAGE),
		16,
	);

	const kR = opts.k ?? REFRACTION_K;
	const maxDistance = Math.min(
		opts.maxDistance ?? 150_000,
		mosaics[mosaics.length - 1].maxDistance,
	);
	const minDistance = opts.minDistance ?? 20;
	const mipSkip = opts.mipSkip ?? true;
	const cellSteps = opts.cellSteps ?? 0.5;
	const eps = opts.segmentTolerance ?? 2e-5;
	const step = opts.step ?? 0.05;
	const n = Math.round(360 / step);
	const i0 = opts.i0 ?? 0;
	const i1 = opts.i1 ?? n;
	const nAz = i1 - i0;
	const nR = mosaics.length;

	const segs = eyes.map((e) =>
		segments(mosaics, e, minDistance, maxDistance, eps),
	);
	const maxNb = Math.max(...segs.map((s) => s.segD.length));
	const eyeStride = 8 + 4 * nR + 4 * maxNb;
	const eyesPerChunk = Math.max(
		1,
		Math.min(eyes.length, Math.floor(RAYS_PER_SUBMIT / Math.max(1, nAz))),
	);
	const ringOff = 0;
	const azOff = ringOff + RING_STRIDE * nR;
	const eyeOff = azOff + 2 * nAz;
	const chunkWords = eyeOff + eyeStride * eyesPerChunk;
	const buf = new ArrayBuffer(chunkWords * 4);
	const pu = new Uint32Array(buf);
	const pF = new Float32Array(buf);
	const pi = new Int32Array(buf);
	// Rings.
	for (let r = 0; r < nR; r++) {
		const m = mosaics[r];
		const mip = m.mip as NonNullable<Mosaic["mip"]>;
		const L = set.rings[r];
		const b = ringOff + r * RING_STRIDE;
		pu[b] = L.page;
		pu[b + 1] = L.dataOff;
		pu[b + 2] = m.width;
		pu[b + 3] = mip.mips.length;
		pu[b + 4] = m.height;
		pF[b + 6] = m.worldPx;
		pF[b + 7] = m.cellMeters * cellSteps;
		pu[b + 8] = 1 << mip.minLevel;
		for (let i = 0; i < mip.mips.length; i++) {
			pu[b + 16 + i] = L.mipOff[i];
			pu[b + 24 + i] = mip.widths[i];
			pu[b + 32 + i] = mip.heights[i];
		}
	}
	// Azimuths (f64 sin/cos, like marchRay).
	for (let i = 0; i < nAz; i++) {
		const a = (i0 + i) * step * DEG;
		pF[azOff + 2 * i] = Math.sin(a);
		pF[azOff + 2 * i + 1] = Math.cos(a);
	}

	// The byte sizes the per-call buffers had; pooled slots are bound with exactly these.
	const paramsBytes = buf.byteLength;
	const outBytes = eyesPerChunk * nAz * 8;
	const statsBytes = Math.max(16, eyesPerChunk * 12);
	const pages = [0, 1, 2, 3].map((i) => set.pages[i] ?? dummy);
	const ub = new ArrayBuffer(64);
	const uu = new Uint32Array(ub);
	const uf = new Float32Array(ub);

	const out: FastHorizonProfile[] = new Array(eyes.length);
	let chunks = 0;
	/** Reads chunk `p` back into `out` (throws on the kernel's iteration cap). */
	const collect = async (p: Pending) => {
		const [td, st] = await p.read.read();
		chunks++;
		const T = new Float32Array(td, 0, p.nE * nAz * 2);
		const S = new Uint32Array(st, 0, p.nE * 3);
		for (let j = 0; j < p.nE; j++) {
			if (S[3 * j + 2] > 0)
				throw new Error("horizon kernel hit its iteration cap");
			const elevation = new Float32Array(nAz);
			const distance = new Float32Array(nAz);
			for (let i = 0; i < nAz; i++) {
				const t = T[2 * (j * nAz + i)];
				elevation[i] = t <= -3e38 ? -90 : Math.atan(t) / DEG;
				distance[i] = T[2 * (j * nAz + i) + 1];
			}
			out[p.c0 + j] = {
				step,
				elevation,
				distance,
				ridges: Array.from({ length: nAz }, () => []),
				i0,
				stats: {
					azimuths: nAz,
					samples: S[3 * j],
					skips: S[3 * j + 1],
					ms: 0,
				},
			};
		}
	};

	let prev: Pending | null = null;
	try {
		for (let c0 = 0; c0 < eyes.length; c0 += eyesPerChunk) {
			const nE = Math.min(eyesPerChunk, eyes.length - c0);
			for (let j = 0; j < nE; j++) {
				const eye = eyes[c0 + j];
				const { segD, segRing } = segs[c0 + j];
				const eb = eyeOff + j * eyeStride;
				const phi = eye.lat * DEG;
				const sinP1 = Math.sin(phi);
				pF[eb] = eye.h;
				pF[eb + 1] = sinP1;
				pF[eb + 2] = Math.cos(phi);
				pu[eb + 3] = segD.length;
				pF[eb + 4] = eye.h - pF[eb]; // low part of the eye height
				// Eye's Mercator pixel position in each ring window, in f64 (marchRay's bx·sx − ox at d = 0).
				const bx = (eye.lon * DEG + Math.PI) / (2 * Math.PI);
				const by = 0.5 - Math.atanh(sinP1) / (2 * Math.PI);
				for (let r = 0; r < nR; r++) {
					const m = mosaics[r];
					// integer part + fraction, so the GPU adds its (small) march offsets to the fraction only
					const u = bx * m.worldPx - (m.x0 + 0.5);
					const v = by * m.worldPx - (m.y0 + 0.5);
					const pe = eb + 8 + 4 * r;
					pi[pe] = Math.floor(u);
					pF[pe + 1] = u - Math.floor(u);
					pi[pe + 2] = Math.floor(v);
					pF[pe + 3] = v - Math.floor(v);
				}
				const sb = eb + 8 + 4 * nR;
				for (let s = 0; s < segD.length; s++) {
					const D = segD[s] / EARTH_R;
					const h = Math.sin(D / 2);
					pF[sb + 4 * s] = segD[s];
					pF[sb + 4 * s + 1] = Math.sin(D);
					pF[sb + 4 * s + 2] = 2 * h * h;
					pu[sb + 4 * s + 3] = segRing[s] ?? 0;
				}
			}
			uu[0] = nAz;
			uu[1] = nE;
			uu[2] = eyeStride;
			uu[3] = azOff;
			uu[4] = eyeOff;
			uu[5] = ringOff;
			uu[6] = nR;
			uu[7] = mipSkip ? 1 : 0;
			uf[8] = opts.stepFactor ?? 3.5e-4;
			uf[9] = opts.nearFactor ?? 0.01;
			uf[10] = (1 - kR) / (2 * EARTH_R);
			uu[11] = 1_000_000;
			uu[12] = 0; // U.zero
			// Same slots every chunk: this chunk's writes queue after the previous chunk's dispatch + copy.
			const sl = slots(device, paramsBytes, outBytes);
			const u = pooledUniform(device, sl.u, ub);
			sl.params.write(new Uint8Array(buf, 0, (eyeOff + nE * eyeStride) * 4));
			const stats = pooledStorage(device, sl.stats, statsBytes); // zeroed
			const enc = device.createCommandEncoder({ id: "horizon-march" });
			dispatch(
				enc,
				k,
				{
					u,
					params: range(sl.params, paramsBytes),
					pg0: pages[0],
					pg1: pages[1],
					pg2: pages[2],
					pg3: pages[3],
					outTD: range(sl.out, outBytes),
					stats: range(stats, statsBytes),
				},
				Math.ceil(nAz / 64),
				nE,
				1,
			);
			const read = stageReads(device, enc, [
				{ buffer: sl.out, size: nE * nAz * 8 },
				{ buffer: stats, size: nE * 12 },
			]);
			try {
				submit(device, enc);
			} catch (e) {
				read.cancel();
				throw e;
			}
			const cur: Pending = { c0, nE, read };
			// Collect the previous chunk now that this one is packed and submitted.
			const p = prev;
			prev = cur;
			if (p) await collect(p);
		}
		const last = prev;
		prev = null;
		if (last) await collect(last);
	} finally {
		// an error left a chunk submitted: wait for it (and return its staging slot) before the
		// lease lets anyone else reuse the slots
		if (prev) await prev.read.read().catch(() => {});
	}
	const t2 = performance.now();
	lastGpuHorizonTiming = {
		uploadMs,
		gpuMs: t2 - t1,
		totalMs: t2 - t0,
		chunks,
	};
	return out;
}

/** True when a GPU march can give the same output as computeHorizonFast for these options. */
const gpuCanServe = (opts: FastHorizonOptions) => !!opts.noRidges;

/**
 * computeHorizonFast over mosaics, on the GPU when available (and ridges aren't wanted), else on the CPU.
 * Any GPU failure falls back to the CPU (with a console warning).
 */
export async function computeHorizonAuto(
	mosaics: Mosaic[],
	eye: Eye,
	opts: FastHorizonOptions = {},
): Promise<FastHorizonProfile> {
	return (await computeHorizonsAuto(mosaics, [eye], opts))[0];
}

/** Batch version of computeHorizonAuto. */
export async function computeHorizonsAuto(
	mosaics: Mosaic[],
	eyes: Eye[],
	opts: FastHorizonOptions = {},
): Promise<FastHorizonProfile[]> {
	if (gpuCanServe(opts)) {
		const device = await getComputeDevice();
		if (device) {
			try {
				return await computeHorizonGpu(device, mosaics, eyes, opts);
			} catch (e) {
				console.warn("[gpu] horizon kernel failed, using the CPU", e);
			}
		}
	}
	return eyes.map((e) => computeHorizonFast(mosaics, e, opts));
}
