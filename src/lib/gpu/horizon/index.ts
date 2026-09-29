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
 * Ridges and peaks (decision): the GPU doesn't record ridges. Ridge lists are variable-length per azimuth
 * and only the Overlay / refine paths use them; the app worker and eye search pass noRidges. So
 * computeHorizonGpu always returns an empty ridge list per azimuth (the shape computeHorizonFast gives with
 * noRidges), and computeHorizonAuto takes the CPU path whenever ridges are wanted (opts.noRidges falsy).
 * `opts.peaks` is classified on the CPU with peakVisibilityFast (one ray per peak; cheap), which is exactly
 * what computeHorizonFast does for them.
 *
 * App wiring: the horizon-fast-app worker marches on the GPU only when opted in (?gpuHorizon=1 or
 * localStorage rigi.gpuHorizon=1; see opt-in.ts), because autoAlign reacts to last-bit changes in the
 * skyline (IMG_6958's pose moves by ~0.01° yaw / 0.07° roll). Default app output stays on the CPU march.
 */
import { Buffer, type ComputePipeline, type Device } from "@luma.gl/core";
import { EARTH_R, REFRACTION_K } from "#/lib/geodesy";
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

const DEG = Math.PI / 180;
const RING_STRIDE = 40;
const MAX_PAGES = 4;
const MAX_MIPS = 8;
/** Rays per submit: keeps each command buffer well under a second (GPU watchdogs). */
const RAYS_PER_SUBMIT = 7200 * 24;

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

/** Frees the GPU copy of these mosaics (the next GPU call re-uploads them). */
export function releaseHorizonGpu(mosaics: Mosaic[]) {
	const s = sets.get(mosaics);
	if (!s) return;
	for (const p of s.pages) p.destroy();
	sets.delete(mosaics);
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
	sets.set(mosaics, s);
	return s;
}

// ---------- pipeline (one per device) ----------

interface Kernel {
	pipeline: ComputePipeline;
	dummy: Buffer;
}
const kernels = new WeakMap<Device, Kernel>();

function kernel(device: Device): Kernel {
	let k = kernels.get(device);
	if (k) return k;
	const shader = device.createShader({
		id: "horizon-march",
		source: HORIZON_WGSL,
		language: "wgsl",
		stage: "compute",
	});
	const ro = "read-only-storage" as const;
	const pipeline = device.createComputePipeline({
		id: "horizon-march",
		shader,
		entryPoint: "main",
		shaderLayout: {
			bindings: [
				{ name: "u", type: "uniform", group: 0, location: 0 },
				{ name: "params", type: ro, group: 0, location: 1 },
				{ name: "pg0", type: ro, group: 0, location: 2 },
				{ name: "pg1", type: ro, group: 0, location: 3 },
				{ name: "pg2", type: ro, group: 0, location: 4 },
				{ name: "pg3", type: ro, group: 0, location: 5 },
				{ name: "outTD", type: "storage", group: 0, location: 6 },
				{ name: "stats", type: "storage", group: 0, location: 7 },
			],
		},
	});
	const dummy = device.createBuffer({
		id: "horizon-dummy",
		usage: Buffer.STORAGE,
		byteLength: 16,
	});
	k = { pipeline, dummy };
	kernels.set(device, k);
	return k;
}

/** Creates the kernel's pipeline now (e.g. while tiles still decode). Never throws. */
export function warmHorizonGpu(device: Device) {
	try {
		kernel(device);
	} catch (e) {
		console.warn("[gpu] horizon kernel compile failed", e);
	}
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
	const set = uploadMosaics(device, mosaics);
	const t1 = performance.now();
	const uploadMs = t1 - t0;
	const { pipeline, dummy } = kernel(device);

	const k = opts.k ?? REFRACTION_K;
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

	const uniform = device.createBuffer({
		id: "horizon-u",
		usage: Buffer.UNIFORM | Buffer.COPY_DST,
		byteLength: 64,
	});
	const paramsBuf = device.createBuffer({
		id: "horizon-params",
		usage: Buffer.STORAGE | Buffer.COPY_DST,
		byteLength: buf.byteLength,
	});
	const outBuf = device.createBuffer({
		id: "horizon-out",
		usage: Buffer.STORAGE | Buffer.COPY_SRC,
		byteLength: eyesPerChunk * nAz * 8,
	});
	const statsBuf = device.createBuffer({
		id: "horizon-stats",
		usage: Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST,
		byteLength: Math.max(16, eyesPerChunk * 12),
	});
	const out: FastHorizonProfile[] = [];
	let chunks = 0;
	try {
		pipeline.setBindings({
			u: uniform,
			params: paramsBuf,
			pg0: set.pages[0] ?? dummy,
			pg1: set.pages[1] ?? dummy,
			pg2: set.pages[2] ?? dummy,
			pg3: set.pages[3] ?? dummy,
			outTD: outBuf,
			stats: statsBuf,
		});
		const ub = new ArrayBuffer(64);
		const uu = new Uint32Array(ub);
		const uf = new Float32Array(ub);
		const zeroStats = new Uint32Array(statsBuf.byteLength / 4);
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
			uf[10] = (1 - k) / (2 * EARTH_R);
			uu[11] = 1_000_000;
			uu[12] = 0; // U.zero
			uniform.write(new Uint8Array(ub));
			paramsBuf.write(new Uint8Array(buf, 0, (eyeOff + nE * eyeStride) * 4));
			statsBuf.write(zeroStats);
			const enc = device.createCommandEncoder({ id: "horizon-march" });
			const pass = enc.beginComputePass({ id: "horizon-march" });
			pass.setPipeline(pipeline);
			pass.dispatch(Math.ceil(nAz / 64), nE, 1);
			pass.end();
			device.submit(enc.finish());
			const [td, st] = await Promise.all([
				outBuf.readAsync(0, nE * nAz * 8),
				statsBuf.readAsync(0, nE * 12),
			]);
			chunks++;
			const T = new Float32Array(td.buffer, td.byteOffset, nE * nAz * 2);
			const S = new Uint32Array(st.buffer, st.byteOffset, nE * 3);
			for (let j = 0; j < nE; j++) {
				if (S[3 * j + 2] > 0)
					throw new Error("horizon kernel hit its iteration cap");
				const elevation = new Float32Array(nAz);
				const distance = new Float32Array(nAz);
				for (let i = 0; i < nAz; i++) {
					const t = T[2 * (j * nAz + i)];
					elevation[i] = t <= -3e38 ? -90 : Math.atan(t) / DEG;
					distance[i] = T[2 * (j * nAz + i) + 1];
				}
				out.push({
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
				});
			}
		}
	} finally {
		uniform.destroy();
		paramsBuf.destroy();
		outBuf.destroy();
		statsBuf.destroy();
	}
	if (opts.peaks)
		for (let j = 0; j < eyes.length; j++)
			out[j].peaks = peakVisibilityFast(mosaics, eyes[j], opts.peaks, opts);
	const t2 = performance.now();
	for (const p of out) p.stats.ms = (t2 - t0) / eyes.length;
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
