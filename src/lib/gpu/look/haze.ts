// GPU twin of look/haze-fit.ts fitHaze. The GPU (haze.wgsl.ts) does the per-pixel work (photo
// resample, depth edges, dilations, log-range bins), the per-bin 1st / 9th percentiles (exact order
// statistics by radix select, replacing the CPU's sorts), the representative pixel lists and the
// airlight band's values (compacted / gathered, so the per-pixel lin + bins stay on the GPU), and
// the physical fit's 5 550-cell grid scan. The CPU keeps what is small or sequential: the airlight
// statistics, the dark-subset sums and representative paths, the free-β IRLS, the refinement
// passes and the quality terms. Those parts mirror haze-fit.ts line for line (keep in sync;
// look-bench.mjs catches drift). Buffers are pooled (lease "look-haze").
import type { Device } from "@luma.gl/core";
import {
	ATM_CURV,
	atmPath,
	BETA_M0,
	BETA_R0,
	H_M,
	H_R,
	MIE_G,
	type Vec3,
} from "../../look/atmosphere";
import {
	type HazeFit,
	type HazeFitInput,
	type HazeSample,
	minimise1D,
	reweight,
	robustSky,
	solveJ0,
	sse,
	sum,
} from "../../look/haze-fit";
import { sunColor } from "../../look/sun";
import { srgbToLinear } from "../../style/color";
import {
	BLOCK,
	BUCKETS,
	HZ_BIN,
	HZ_CNT,
	HZ_DILH,
	HZ_GATHER,
	HZ_GRID,
	HZ_HIST,
	HZ_OFFS,
	HZ_PREP,
	HZ_SCAN,
	HZ_SCATTER,
	HZ_SEL_INIT,
	LISTS,
	SEL,
} from "./haze.wgsl";
import {
	clear,
	defineKernel,
	dispatch,
	kernel,
	pooledStorage,
	pooledUniform,
	type ReadRange,
	readBack,
	stageReads,
	submit,
	withLease,
} from "./kernel";

export const K_HZ_PREP = defineKernel("hz-prep", HZ_PREP, [
	["prm", "uniform"],
	["photo", "read-only-storage"],
	["xb", "read-only-storage"],
	["yb", "read-only-storage"],
	["lut", "read-only-storage"],
	["range", "read-only-storage"],
	["fgm", "read-only-storage"],
	["lin", "storage"],
	["flags", "storage"],
]);
export const K_HZ_DILH = defineKernel("hz-dilh", HZ_DILH, [
	["prm", "uniform"],
	["flags", "read-only-storage"],
	["outf", "storage"],
]);
export const K_HZ_BIN = defineKernel("hz-bin", HZ_BIN, [
	["prm", "uniform"],
	["flagsH", "read-only-storage"],
	["range", "read-only-storage"],
	["psky", "read-only-storage"],
	["bins", "storage"],
	["counts", "storage"],
]);
export const K_HZ_SEL_INIT = defineKernel("hz-sel-init", HZ_SEL_INIT, [
	["counts", "read-only-storage"],
	["state", "storage"],
]);
export const K_HZ_HIST = defineKernel("hz-hist", HZ_HIST, [
	["prm", "uniform"],
	["bins", "read-only-storage"],
	["lin", "read-only-storage"],
	["state", "read-only-storage"],
	["hist", "storage"],
]);
export const K_HZ_SCAN = defineKernel("hz-scan", HZ_SCAN, [
	["prm", "uniform"],
	["hist", "read-only-storage"],
	["state", "storage"],
]);
export const K_HZ_CNT = defineKernel("hz-cnt", HZ_CNT, [
	["prm", "uniform"],
	["bins", "read-only-storage"],
	["lin", "read-only-storage"],
	["state", "read-only-storage"],
	["blk", "storage"],
]);
export const K_HZ_OFFS = defineKernel("hz-offs", HZ_OFFS, [
	["prm", "uniform"],
	["blk", "storage"],
	["starts", "storage"],
]);
export const K_HZ_SCATTER = defineKernel("hz-scatter", HZ_SCATTER, [
	["prm", "uniform"],
	["bins", "read-only-storage"],
	["lin", "read-only-storage"],
	["state", "read-only-storage"],
	["blk", "read-only-storage"],
	["starts", "read-only-storage"],
	["outIdx", "storage"],
	["outVal", "storage"],
]);
export const K_HZ_GATHER = defineKernel("hz-gather", HZ_GATHER, [
	["prm", "uniform"],
	["idx", "read-only-storage"],
	["lin", "read-only-storage"],
	["outv", "storage"],
]);
export const K_HZ_GRID = defineKernel("hz-grid", HZ_GRID, [
	["prm", "uniform"],
	["reps", "read-only-storage"],
	["repOff", "read-only-storage"],
	["Iw", "read-only-storage"],
	["hmPrior", "read-only-storage"],
	["err", "storage"],
]);

// mirror of haze-fit.ts (keep in sync)
export const NBINS = 24;
const DMIN = 200;
const DMAX = 150000;
const H_M_CANDIDATES = [600, 900, 1200, 1800, 2700, 4000];
export const SRGB_LUT = (() => {
	const t = new Float32Array(256);
	for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255);
	return t;
})();
const GRID_A = 25;
const GRID_B = 37;
export const HM_PRIOR = Float32Array.from(
	H_M_CANDIDATES,
	(h) => 8 * Math.log2(h / H_M) ** 2,
);

/** Timings of the last fitHazeGpu (ms), for the bench. */
export const hazeGpuTimes: Record<string, number> = {};

/** How fitHazeGpu gets the per-pixel results to the CPU. */
export type HazeGpuOptions = {
	/**
	 * true (default): only the representative lists and the airlight band's values come back (the
	 * GPU compacts them). false: the whole lin + bins come back and the CPU walks every pixel, as
	 * before (kept for the bench; the result is the same).
	 */
	compact?: boolean;
	/**
	 * Test hook (compact only): list slots in the first readback instead of the 0.27·N + 512
	 * estimate. A small value forces the second, exact-length tail read (the bench checks it gives
	 * the very same fit).
	 */
	listHead?: number;
	/**
	 * Run both submits on core ComputeGraphs (./haze-graph.ts: shape-keyed cache, aliased transients,
	 * clear nodes, an adaptive first-read length). Default false (the dispatch path below). Compact
	 * only: with compact: false the dispatch path runs. The fit is bit-identical either way.
	 */
	graph?: boolean;
};

/** One (bin, channel)'s candidate pixels in pixel order: indices and their lin values. */
type List = { idx: ArrayLike<number>; val: Float32Array };

export type Prep = {
	counts: Uint32Array;
	/** order statistic per (bin, channel, slot), as f32 */
	stat: Float32Array;
	/** lin (3 per pixel) at the `skyIdx` pixels, in order */
	sky: Float32Array;
	/** list L = bin·3 + channel: a superset of the CPU's [v0, v1] pixels, in pixel order */
	list: (L: number) => List;
	/** bytes read back */
	bytes: number;
	/** the compacted lists overflowed the first readback (one more round trip) */
	tail: boolean;
};

/** Submit 1's small uploads: the photo box footprints (f64, as the CPU) and the prep uniform. */
export function prepUploads(
	photo: HazeFitInput["photo"],
	W: number,
	H: number,
	rad: number,
	fgRad: number,
) {
	// the box footprints, in f64 as the CPU
	const sx = photo.width / W;
	const sy = photo.height / H;
	const xb = new Uint32Array(2 * W);
	for (let x = 0; x < W; x++) {
		const x0 = Math.floor(x * sx);
		xb[2 * x] = x0;
		xb[2 * x + 1] = Math.max(
			x0 + 1,
			Math.min(photo.width, Math.floor((x + 1) * sx)),
		);
	}
	const yb = new Uint32Array(2 * H);
	for (let y = 0; y < H; y++) {
		const y0 = Math.floor(y * sy);
		yb[2 * y] = y0;
		yb[2 * y + 1] = Math.max(
			y0 + 1,
			Math.min(photo.height, Math.floor((y + 1) * sy)),
		);
	}
	const words = new ArrayBuffer(36);
	new Uint32Array(words, 0, 5).set([W, H, photo.width, rad, fgRad]);
	const lo = Math.log(DMIN);
	new Float32Array(words, 20, 4).set([
		lo,
		Math.log(DMAX) - lo,
		Math.max(150, DMIN),
		DMAX,
	]);
	return { xb, yb, words };
}

/** Submit 1: per-pixel prep, bins, the percentile order statistics and (compact) the lists. */
function prepGpu(
	device: Device,
	photo: HazeFitInput["photo"],
	W: number,
	H: number,
	range: Float32Array,
	pSky: Float32Array,
	fgBits: Uint32Array,
	rad: number,
	fgRad: number,
	skyIdx: Uint32Array,
	compact: boolean,
	listHead?: number,
): Promise<Prep> {
	const N = W * H;
	const { xb, yb, words } = prepUploads(photo, W, H, rad, fgRad);
	const K = skyIdx.length;
	const nBlk = Math.ceil(N / BLOCK);
	return withLease("look-haze", async () => {
		const up = (key: string, data: ArrayBufferView | number) =>
			pooledStorage(device, `look-haze/${key}`, data);
		// outputs every pixel / slot of which its kernel writes: no zeroing needed
		const scratch = (key: string, bytes: number) =>
			pooledStorage(device, `look-haze/${key}`, bytes, { zero: false });
		const prm = pooledUniform(device, "look-haze/prm", words);
		const gPhoto = up(
			"photo",
			new Uint8Array(
				photo.data.buffer,
				photo.data.byteOffset,
				photo.data.byteLength,
			),
		);
		const gxb = up("xb", xb);
		const gyb = up("yb", yb);
		const lut = up("lut", SRGB_LUT);
		const gRange = up("range", range);
		const gSky = up("psky", pSky);
		const gFg = up("fgm", fgBits);
		const lin = scratch("lin", N * 12);
		const flags = scratch("flags", N * 4);
		const flagsH = scratch("flagsH", N * 4);
		const bins = scratch("bins", N * 4);
		const counts = up("counts", NBINS * 4); // atomics: zeroed
		const state = scratch("state", SEL * 8);
		const hist = scratch("hist", SEL * BUCKETS * 4); // cleared per pass
		// one uniform per radix pass: all three are recorded before the submit
		const passPrm = [0, 1, 2].map((p) =>
			pooledUniform(
				device,
				`look-haze/pass${p}`,
				new Uint32Array([W, H, p, 0]),
			),
		);
		const groups = Math.ceil(N / 256);
		const enc = device.createCommandEncoder({ id: "look-haze-prep" });
		dispatch(
			enc,
			kernel(device, K_HZ_PREP),
			{
				prm,
				photo: gPhoto,
				xb: gxb,
				yb: gyb,
				lut,
				range: gRange,
				fgm: gFg,
				lin,
				flags,
			},
			groups,
		);
		dispatch(
			enc,
			kernel(device, K_HZ_DILH),
			{ prm, flags, outf: flagsH },
			groups,
		);
		dispatch(
			enc,
			kernel(device, K_HZ_BIN),
			{ prm, flagsH, range: gRange, psky: gSky, bins, counts },
			groups,
		);
		dispatch(
			enc,
			kernel(device, K_HZ_SEL_INIT),
			{ counts, state },
			Math.ceil(SEL / 64),
		);
		const kHist = kernel(device, K_HZ_HIST);
		const kScan = kernel(device, K_HZ_SCAN);
		for (let p = 0; p < 3; p++) {
			clear(enc, hist, 0, SEL * BUCKETS * 4);
			dispatch(enc, kHist, { prm: passPrm[p], bins, lin, state, hist }, groups);
			dispatch(
				enc,
				kScan,
				{ prm: passPrm[p], hist, state },
				Math.ceil(SEL / 64),
			);
		}
		const head: ReadRange[] = [
			{ buffer: counts, size: NBINS * 4 },
			{ buffer: state, size: SEL * 8 },
		];
		if (!compact) {
			head.push({ buffer: lin, size: N * 12 }, { buffer: bins, size: N * 4 });
			const rd = stageReads(device, enc, head);
			submit(device, enc);
			const [c, s, l, b] = await rd.read();
			const linF = new Float32Array(l);
			const binsI = new Int32Array(b);
			const cnt = new Uint32Array(c);
			// the CPU's walk: every pixel of the bin, in pixel order
			const start = new Int32Array(NBINS + 1);
			for (let k = 0; k < NBINS; k++) start[k + 1] = start[k] + cnt[k];
			const fill = start.slice(0, NBINS);
			const order = new Int32Array(start[NBINS]);
			for (let i = 0; i < N; i++)
				if (binsI[i] >= 0) order[fill[binsI[i]]++] = i;
			const sky = new Float32Array(3 * K);
			for (let k = 0; k < K; k++)
				for (let ch = 0; ch < 3; ch++)
					sky[3 * k + ch] = linF[skyIdx[k] * 3 + ch];
			return {
				counts: cnt,
				stat: statOf(s),
				sky,
				list: (L: number) => {
					const bin = Math.floor(L / 3);
					const ch = L - bin * 3;
					const idx = order.subarray(start[bin], start[bin + 1]);
					const val = new Float32Array(idx.length);
					for (let k = 0; k < idx.length; k++) val[k] = linF[idx[k] * 3 + ch];
					return { idx, val };
				},
				bytes: NBINS * 4 + SEL * 8 + N * 16,
				tail: false,
			};
		}
		// compact: the lists' block counts → starts → scatter, and the airlight band gather
		const cprm = pooledUniform(
			device,
			"look-haze/cprm",
			new Uint32Array([N, nBlk, K, 0]),
		);
		const blk = scratch("blk", nBlk * LISTS * 4);
		const starts = scratch("starts", (LISTS + 1) * 4);
		// capacity: every binned pixel in all three channels' lists
		const outIdx = scratch("outIdx", 3 * N * 4);
		const outVal = scratch("outVal", 3 * N * 4);
		const blocks = Math.ceil(nBlk / 64);
		dispatch(
			enc,
			kernel(device, K_HZ_CNT),
			{ prm: cprm, bins, lin, state, blk },
			blocks,
		);
		dispatch(enc, kernel(device, K_HZ_OFFS), { prm: cprm, blk, starts }, 1);
		dispatch(
			enc,
			kernel(device, K_HZ_SCATTER),
			{ prm: cprm, bins, lin, state, blk, starts, outIdx, outVal },
			blocks,
		);
		let skyOut = null;
		if (K) {
			const idx = up("skyIdx", skyIdx);
			skyOut = scratch("skyOut", 3 * K * 4);
			dispatch(
				enc,
				kernel(device, K_HZ_GATHER),
				{ prm: cprm, idx, lin, outv: skyOut },
				Math.ceil(K / 64),
			);
		}
		// the lists hold ~8 % of the binned pixels per channel (+ ties): read a guess with the rest,
		// then whatever did not fit
		const guess = Math.min(
			3 * N,
			Math.max(1, Math.floor(listHead ?? Math.ceil(0.27 * N) + 512)),
		);
		head.push(
			{ buffer: starts, size: (LISTS + 1) * 4 },
			{ buffer: outIdx, size: guess * 4 },
			{ buffer: outVal, size: guess * 4 },
		);
		if (skyOut) head.push({ buffer: skyOut, size: 3 * K * 4 });
		const rd = stageReads(device, enc, head);
		submit(device, enc);
		const got = await rd.read();
		const st = new Uint32Array(got[2]);
		const total = st[LISTS];
		let idxAll = new Uint32Array(got[3]);
		let valAll = new Float32Array(got[4]);
		let bytes = NBINS * 4 + SEL * 8 + (LISTS + 1) * 4 + guess * 8 + 12 * K;
		if (total > guess) {
			const rest = (total - guess) * 4;
			const [ti, tv] = await readBack(
				device,
				() => {},
				[
					{ buffer: outIdx, offset: guess * 4, size: rest },
					{ buffer: outVal, offset: guess * 4, size: rest },
				],
				{ id: "look-haze-tail" },
			);
			const i2 = new Uint32Array(total);
			i2.set(idxAll);
			i2.set(new Uint32Array(ti), guess);
			const v2 = new Float32Array(total);
			v2.set(valAll);
			v2.set(new Float32Array(tv), guess);
			idxAll = i2;
			valAll = v2;
			bytes += 2 * rest;
		}
		return {
			counts: new Uint32Array(got[0]),
			stat: statOf(got[1]),
			sky: skyOut ? new Float32Array(got[5]) : new Float32Array(0),
			list: (L: number) => ({
				idx: idxAll.subarray(st[L], st[L + 1]),
				val: valAll.subarray(st[L], st[L + 1]),
			}),
			bytes,
			tail: total > guess,
		};
	});
}

/** The selected f32 bit patterns out of the radix-select state (prefix, remaining rank) pairs. */
export function statOf(state: ArrayBuffer): Float32Array {
	const st = new Uint32Array(state);
	const stat = new Float32Array(SEL);
	const bits = new Uint32Array(stat.buffer);
	for (let k = 0; k < SEL; k++) bits[k] = st[2 * k];
	return stat;
}

/** Submit 2's uploads: the flat representative paths, their offsets, (I, w) and the grid uniform. */
export function gridUploads(
	reps: Float64Array[][],
	Ic: number[][],
	wp: number[][],
	airlight: Vec3,
	lam: number,
	jBar: number,
	priorK: number,
) {
	const S = Ic[0].length;
	const NH = H_M_CANDIDATES.length;
	let total = 0;
	for (let c = 0; c < 3; c++) for (const r of reps[c]) total += r.length;
	const flat = new Float32Array(Math.max(1, total));
	const off = new Uint32Array(3 * S * 2);
	const iw = new Float32Array(3 * S * 2);
	let o = 0;
	for (let c = 0; c < 3; c++)
		for (let s = 0; s < S; s++) {
			const r = reps[c][s];
			flat.set(r, o);
			off[(c * S + s) * 2] = o;
			off[(c * S + s) * 2 + 1] = r.length / (1 + NH);
			o += r.length;
			iw[(c * S + s) * 2] = Ic[c][s];
			iw[(c * S + s) * 2 + 1] = wp[c][s];
		}
	const words = new ArrayBuffer(64);
	new Uint32Array(words, 0, 4).set([S, NH, GRID_A, GRID_B]);
	new Float32Array(words, 16, 12).set([
		airlight[0],
		airlight[1],
		airlight[2],
		0,
		BETA_R0[0],
		BETA_R0[1],
		BETA_R0[2],
		0,
		lam,
		jBar,
		priorK,
		0,
	]);
	const cells = NH * GRID_A * GRID_B;
	return { flat, off, iw, words, cells };
}

/** The grid's signature (submit 2), for ./haze-graph.ts's twin. */
export type GridFn = typeof gridGpu;

/** Submit 2: the physical grid's cost per cell (index = (hk·25 + a)·37 + b). */
async function gridGpu(
	device: Device,
	reps: Float64Array[][],
	Ic: number[][],
	wp: number[][],
	airlight: Vec3,
	lam: number,
	jBar: number,
	priorK: number,
): Promise<Float32Array> {
	const { flat, off, iw, words, cells } = gridUploads(
		reps,
		Ic,
		wp,
		airlight,
		lam,
		jBar,
		priorK,
	);
	return withLease("look-haze", async () => {
		const up = (key: string, data: ArrayBufferView) =>
			pooledStorage(device, `look-haze/${key}`, data);
		const prm = pooledUniform(device, "look-haze/gprm", words);
		const gReps = up("reps", flat);
		const gOff = up("repOff", off);
		const gIw = up("Iw", iw);
		const hm = up("hmPrior", HM_PRIOR);
		// every cell is written
		const err = pooledStorage(device, "look-haze/err", cells * 4, {
			zero: false,
		});
		const [e] = await readBack(
			device,
			(enc) =>
				dispatch(
					enc,
					kernel(device, K_HZ_GRID),
					{ prm, reps: gReps, repOff: gOff, Iw: gIw, hmPrior: hm, err },
					Math.ceil(cells / 64),
				),
			[{ buffer: err, size: cells * 4 }],
			{ id: "look-haze-grid" },
		);
		return new Float32Array(e);
	});
}

/** GPU twin of fitHaze(input): the same HazeFit, up to f32 rounding in the GPU parts. */
export async function fitHazeGpu(
	device: Device,
	input: HazeFitInput,
	opts: HazeGpuOptions = {},
): Promise<HazeFit> {
	const T0 = performance.now();
	const { photo, geo, geoW: W, geoH: H, sky, foreground: fg, eyeAlt } = input;
	const N = W * H;
	const pointAt = pointAtOf(geo, W, H, eyeAlt);

	// range and sky probability, row 0 = top (as the CPU)
	const range = new Float32Array(N);
	const pSky = new Float32Array(N);
	for (let y = 0; y < H; y++) {
		const gy = H - 1 - y;
		for (let x = 0; x < W; x++)
			range[y * W + x] =
				geo.kind === "xyzr"
					? geo.data[(gy * W + x) * 4 + 3]
					: geo.data[gy * W + x];
	}
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			if (sky) {
				const mx = Math.min(
					sky.width - 1,
					Math.floor(((x + 0.5) * sky.width) / W),
				);
				const my = Math.min(
					sky.height - 1,
					Math.floor(((y + 0.5) * sky.height) / H),
				);
				pSky[i] = sky.data[my * sky.width + mx] / 255;
			} else pSky[i] = range[i] > 0 ? 0 : 1;
		}
	const pxScale = W / 1024;
	const rad = Math.max(1, Math.round(3 * pxScale));
	// the people mask, 1 bit per pixel (bit i & 31 of word i >> 5)
	const fgBits = new Uint32Array(Math.ceil(N / 32));
	if (fg)
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const mx = Math.min(
					fg.width - 1,
					Math.floor(((x + 0.5) * fg.width) / W),
				);
				const my = Math.min(
					fg.height - 1,
					Math.floor(((y + 0.5) * fg.height) / H),
				);
				if (fg.data[my * fg.width + mx] > 64) {
					const i = y * W + x;
					fgBits[i >> 5] |= 1 << (i & 31);
				}
			}
	const fgRad = fg ? Math.max(2, Math.round(8 * pxScale)) : 0;

	const skyIdx = airlightBand(range, pSky, W, H);
	const t1 = performance.now();
	const args = [
		device,
		photo,
		W,
		H,
		range,
		pSky,
		fgBits,
		rad,
		fgRad,
		skyIdx,
	] as const;
	// opt-in: both submits on core ComputeGraphs (./haze-graph.ts, compact lists only)
	const g =
		opts.graph && (opts.compact ?? true) ? await import("./haze-graph") : null;
	const prep = g
		? await g.prepGraph(...args, opts.listHead)
		: await prepGpu(...args, opts.compact ?? true, opts.listHead);
	const t2 = performance.now();
	return hazeFitTail(
		device,
		{ range, skyIdx, pointAt, eyeAlt, sunDir: input.sunDir, T0, t1, t2 },
		prep,
		g ? g.gridGraph : gridGpu,
	);
}

/** The geo buffer's ENU point of pixel i (row 0 = top), as the CPU. */
export function pointAtOf(
	geo: HazeFitInput["geo"],
	W: number,
	H: number,
	eyeAlt: number,
): (i: number) => Vec3 {
	return (i: number): Vec3 => {
		const gx = i % W;
		const gy = H - 1 - Math.floor(i / W);
		if (geo.kind === "xyzr") {
			const g = (gy * W + gx) * 4;
			return [geo.data[g], geo.data[g + 1], geo.data[g + 2]];
		}
		const r = geo.data[gy * W + gx];
		const d = geo.ray(gx, gy);
		return [d[0] * r, d[1] * r, eyeAlt + d[2] * r];
	};
}

/**
 * The airlight band's pixels (as the CPU; range and sky only, row 0 = top), or, with fewer than 20
 * of them, robustSky's fallback (every range-0 pixel): the GPU gathers their lin.
 */
export function airlightBand(
	range: Float32Array,
	pSky: Float32Array,
	W: number,
	H: number,
): Uint32Array {
	const N = W * H;
	const pxScale = W / 1024;
	const a0 = Math.max(2, Math.round(20 * pxScale));
	const a1 = Math.max(a0 + 2, Math.round(60 * pxScale));
	const band: number[] = [];
	for (let x = 0; x < W; x += 2) {
		let top = -1;
		for (let y = 0; y < H; y++) {
			const i = y * W + x;
			if (range[i] > 0 && pSky[i] < 0.5) {
				top = y;
				break;
			}
		}
		if (top < 0) continue;
		for (let y = Math.max(0, top - a1); y <= top - a0; y++) {
			const i = y * W + x;
			if (range[i] > 0 || pSky[i] < 0.7) continue;
			band.push(i);
		}
	}
	if (band.length < 20) {
		band.length = 0;
		for (let i = 0; i < N; i++) if (range[i] <= 0) band.push(i);
	}
	return Uint32Array.from(band);
}

/** What the CPU tail needs besides the prep's lists (timestamps for hazeGpuTimes). */
export type HazeTailContext = {
	/** range, row 0 = top (as the CPU) */
	range: Float32Array;
	/** the airlight band's pixels (airlightBand), in the prep's gather order */
	skyIdx: Uint32Array;
	pointAt: (i: number) => Vec3;
	eyeAlt: number;
	sunDir?: Vec3;
	T0: number;
	t1: number;
	t2: number;
};

/**
 * Everything after submit 1, on the CPU as haze-fit.ts (f64): the airlight, the per-bin loop, the
 * free β, then the physical fit around submit 2 (`grid`) and the quality terms.
 */
export async function hazeFitTail(
	device: Device,
	ctx: HazeTailContext,
	prep: Prep,
	grid: GridFn,
): Promise<HazeFit> {
	const { range, skyIdx, pointAt, eyeAlt, T0, t1, t2 } = ctx;
	const { counts, stat, sky: skyLin, list, bytes, tail } = prep;

	// --- airlight (as the CPU)
	const skyR: number[] = [];
	const skyG: number[] = [];
	const skyB: number[] = [];
	const skyL: number[] = [];
	for (let k = 0; k < skyIdx.length; k++) {
		const r = skyLin[3 * k];
		const g = skyLin[3 * k + 1];
		const b = skyLin[3 * k + 2];
		skyR.push(r);
		skyG.push(g);
		skyB.push(b);
		skyL.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
	}
	// ≥ 20 values: robustSky uses them as they are; fewer (only when even the fallback has < 20)
	// it returns its default without looking at lin
	const none = new Float32Array(0);
	const airlight = robustSky(skyR, skyG, skyB, skyL, none, none);

	// --- bins (from the GPU), then the CPU's per-bin loop with the GPU's order statistics
	let total = 0;
	for (const c of counts) total += c;
	const minCount = Math.max(40, Math.round(total * 0.002));
	const samples: HazeSample[] = [];
	const pathMs: number[][] = [];
	const REPS = 24;
	const NH = H_M_CANDIDATES.length;
	const reps: Float64Array[][] = [[], [], []];
	// percentile(val, n, q) of the CPU from the selected order statistics
	const pct = (b: number, c: number, n: number, q: 0.01 | 0.09) => {
		const s0 = (b * 3 + c) * 4 + (q === 0.01 ? 0 : 2);
		const m = n - 1;
		const gi = q === 0.01 ? Math.floor(m / 100) : Math.floor((9 * m) / 100);
		const x = q * (n - 1);
		const i = Math.floor(x);
		if (i === gi)
			return i + 1 < n
				? stat[s0] + (stat[s0 + 1] - stat[s0]) * (x - i)
				: stat[s0];
		// f64 put q·(n−1) a hair under the integer gi: weight ≈ 1 on s[gi]
		if (i === gi - 1) return stat[s0];
		throw new Error(`haze percentile rank ${i} vs ${gi}`);
	};
	for (let b = 0; b < NBINS; b++) {
		const n = counts[b];
		if (n < minCount) continue;
		const low: Vec3 = [0, 0, 0];
		const binReps: Float64Array[] = [];
		let logR = 0;
		let pR = 0;
		const pM = H_M_CANDIDATES.map(() => 0);
		let mG = 0;
		let ok = true;
		for (let c = 0; c < 3; c++) {
			// the bin's pixels in pixel order (compact: only those between the bracketing order
			// statistics, a superset of [v0, v1]); the CPU's own test picks [v0, v1] from them
			const { idx, val } = list(b * 3 + c);
			const len = val.length;
			const v0 = pct(b, c, n, 0.01);
			const v1 = pct(b, c, n, 0.09);
			let sel = 0;
			for (let k = 0; k < len; k++) if (val[k] >= v0 && val[k] <= v1) sel++;
			const stride = Math.max(1, Math.floor(sel / REPS));
			const rep = new Float64Array(Math.min(REPS, sel) * (1 + NH));
			let nr = 0;
			let m = 0;
			for (let k = 0; k < len; k++) {
				if (val[k] < v0 || val[k] > v1) continue;
				const i = idx[k];
				low[c] += val[k];
				const keep = m % stride === 0 && nr * (1 + NH) < rep.length;
				m++;
				if (!keep && c !== 1) continue;
				const [px, py, pz] = pointAt(i);
				const h1 = pz + (px * px + py * py) * ATM_CURV;
				const r0 = atmPath(eyeAlt, h1, range[i], H_R);
				if (keep) rep[nr * (1 + NH)] = r0;
				for (let q = 0; q < NH; q++) {
					const v = atmPath(eyeAlt, h1, range[i], H_M_CANDIDATES[q]);
					if (keep) rep[nr * (1 + NH) + 1 + q] = v;
					if (c === 1) pM[q] += v;
				}
				if (keep) nr++;
				if (c === 1) {
					logR += Math.log(range[i]);
					pR += r0;
				}
			}
			if (m < 5) ok = false;
			low[c] /= Math.max(1, m);
			if (c === 1) mG = m;
			binReps.push(rep.subarray(0, nr * (1 + NH)));
		}
		if (!ok) continue;
		for (let c = 0; c < 3; c++) reps[c].push(binReps[c]);
		samples.push({
			range: Math.exp(logR / mG),
			n,
			low,
			fit: [0, 0, 0],
			pathR: pR / mG,
			pathM: 0,
		});
		pathMs.push(pM.map((v) => v / mG));
	}
	const t3 = performance.now();

	const sunDir: Vec3 = ctx.sunDir ?? [-0.5, -0.4, 0.75];
	if (samples.length < 3) {
		Object.assign(hazeGpuTimes, {
			cpuPrep: t1 - T0,
			gpuPrep: t2 - t1,
			cpuBins: t3 - t2,
			total: performance.now() - T0,
			readKB: bytes / 1024,
			tailRead: tail ? 1 : 0,
		});
		return {
			betaR: [...BETA_R0],
			betaM: BETA_M0,
			hR: H_R,
			hM: H_M,
			airlight,
			sunDir,
			sunColor: sunColor(sunDir),
			mieG: MIE_G,
			strength: 1,
			airlightMix: 1,
			beta: [0, 0, 0],
			j0: [0.03, 0.03, 0.03],
			rayleighScale: 1,
			mieScale: 1,
			visibility: 3.912 / (BETA_R0[1] + BETA_M0),
			quality: 0,
			rms: 0,
			samples,
		};
	}

	const w0 = samples.map((s) => Math.sqrt(s.n));
	const ds = samples.map((s) => s.range);
	const Ic = [0, 1, 2].map((c) => samples.map((s) => s.low[c]));

	// --- free per-channel β (as the CPU)
	const beta: Vec3 = [0, 0, 0];
	const j0: Vec3 = [0, 0, 0];
	const wc = [0, 1, 2].map(() => w0.slice());
	let jBar = -1;
	for (let pass = 0; pass < 4; pass++) {
		const res: number[][] = [];
		for (let c = 0; c < 3; c++) {
			const I = Ic[c];
			const lam = jBar < 0 ? 0 : 0.5 * sum(wc[c]);
			const cost = (lb: number) => {
				const bt = Math.exp(lb);
				const t = ds.map((d) => Math.exp(-bt * d));
				const J = solveJ0(I, t, wc[c], airlight[c], lam, jBar);
				return { err: sse(I, t, wc[c], airlight[c], J), J, t };
			};
			const lb = minimise1D(
				(x) => cost(x).err,
				Math.log(1e-7),
				Math.log(1e-3),
				64,
			);
			const r = cost(lb);
			beta[c] = Math.exp(lb);
			j0[c] = r.J;
			res.push(
				I.map((v, i) => v - (r.J * r.t[i] + airlight[c] * (1 - r.t[i]))),
			);
		}
		jBar = (j0[0] + j0[1] + j0[2]) / 3;
		reweight(res, w0, wc);
	}

	// --- physical fit (as the CPU), the initial grid scanned on the GPU
	const wp = [0, 1, 2].map(() => w0.slice());
	const lam = 0.1 * sum(w0);
	const evalPhys = (kR: number, bM: number, hk: number) => {
		let err = 0;
		const J: number[] = [];
		const T: number[][] = [];
		for (let c = 0; c < 3; c++) {
			const bR = kR * BETA_R0[c];
			const t = reps[c].map((rep) => {
				let acc = 0;
				const nr = rep.length / (1 + NH);
				for (let k = 0; k < nr; k++)
					acc += Math.exp(
						-bR * rep[k * (1 + NH)] - bM * rep[k * (1 + NH) + 1 + hk],
					);
				return acc / nr;
			});
			T.push(t);
			J.push(solveJ0(Ic[c], t, wp[c], airlight[c], lam, jBar));
			err += sse(Ic[c], t, wp[c], airlight[c], J[c]);
		}
		const prior =
			sum(wp[1]) *
			1e-5 *
			(Math.log(kR) ** 2 * 0.5 + 8 * Math.log2(H_M_CANDIDATES[hk] / H_M) ** 2);
		return { err: err + prior, raw: err, J, T };
	};
	const gridKR = (a: number) =>
		Math.exp(Math.log(0.25) + (a / 24) * Math.log(40 / 0.25));
	const gridBM = (b: number) =>
		Math.exp(Math.log(1e-7) + (b / 36) * Math.log(3e-2 / 1e-7));
	const t4 = performance.now();
	const gErr = await grid(
		device,
		reps,
		Ic,
		wp,
		airlight,
		lam,
		jBar,
		sum(wp[1]) * 1e-5,
	);
	const t5 = performance.now();
	// the CPU's argmin (first strict minimum in loop order) among the cells the GPU puts within
	// 0.1 % of its own minimum, re-evaluated in f64
	let gMin = Number.POSITIVE_INFINITY;
	for (const e of gErr) if (e < gMin) gMin = e;
	const tol = gMin + Math.abs(gMin) * 1e-3 + 1e-12;
	let cand: number[] = [];
	for (let k = 0; k < gErr.length; k++) if (gErr[k] <= tol) cand.push(k);
	if (cand.length > 256)
		cand = cand
			.sort((p, q) => gErr[p] - gErr[q])
			.slice(0, 256)
			.sort((p, q) => p - q);
	let best = { kR: 1, bM: BETA_M0, hk: 2, err: Number.POSITIVE_INFINITY };
	for (const k of cand) {
		const hk = Math.floor(k / (GRID_A * GRID_B));
		const a = Math.floor((k - hk * GRID_A * GRID_B) / GRID_B);
		const b = k - hk * GRID_A * GRID_B - a * GRID_B;
		const kR = gridKR(a);
		const bM = gridBM(b);
		const e = evalPhys(kR, bM, hk).err;
		if (e < best.err) best = { kR, bM, hk, err: e };
	}
	for (let pass = 0; pass < 4; pass++) {
		if (pass > 0) {
			const cur = evalPhys(best.kR, best.bM, best.hk);
			reweight(
				[0, 1, 2].map((c) =>
					Ic[c].map(
						(v, i) =>
							v - (cur.J[c] * cur.T[c][i] + airlight[c] * (1 - cur.T[c][i])),
					),
				),
				w0,
				wp,
			);
			let b2 = { ...best, err: Number.POSITIVE_INFINITY };
			for (let hk = 0; hk < NH; hk++) {
				const e = evalPhys(best.kR, best.bM, hk).err;
				if (e < b2.err) b2 = { ...best, hk, err: e };
			}
			best = b2;
		}
		let stepR = Math.log(40 / 0.25) / 24;
		let stepM = Math.log(3e-2 / 1e-7) / 36;
		for (let it = 0; it < 24; it++) {
			const { kR, bM, hk } = best;
			for (const [dr, dm] of [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
				[1, 1],
				[-1, -1],
				[1, -1],
				[-1, 1],
			]) {
				const k2 = Math.min(40, Math.max(0.25, kR * Math.exp(dr * stepR)));
				const b2 = Math.min(3e-2, Math.max(1e-7, bM * Math.exp(dm * stepM)));
				const e = evalPhys(k2, b2, hk).err;
				if (e < best.err) best = { kR: k2, bM: b2, hk, err: e };
			}
			if (best.kR === kR && best.bM === bM) {
				stepR /= 2;
				stepM /= 2;
			}
		}
	}
	const fin = evalPhys(best.kR, best.bM, best.hk);
	const hM = H_M_CANDIDATES[best.hk];
	samples.forEach((s, i) => {
		s.pathM = pathMs[i][best.hk];
		s.fit = [0, 1, 2].map(
			(c) => fin.J[c] * fin.T[c][i] + airlight[c] * (1 - fin.T[c][i]),
		) as Vec3;
	});

	// --- quality (as the CPU)
	const rms = Math.sqrt(fin.raw / (sum(wp[0]) + sum(wp[1]) + sum(wp[2])));
	const inliers = (sum(wp[0]) + sum(wp[1]) + sum(wp[2])) / (3 * sum(w0));
	const contrast = Math.max(
		1e-3,
		(airlight[0] + airlight[1] + airlight[2]) / 3 -
			(fin.J[0] + fin.J[1] + fin.J[2]) / 3,
	);
	const spanQ = Math.min(
		1,
		Math.log10(ds[ds.length - 1] / ds[0]) / Math.log10(30),
	);
	const binQ = Math.min(1, (samples.length * inliers) / 10);
	const resQ = Math.exp(-4 * (rms / contrast));
	const tFar = fin.T[1][fin.T[1].length - 1];
	const haveQ = Math.min(1, (1 - tFar) / 0.15);
	const quality = Math.max(
		0,
		Math.min(1, spanQ * binQ * resQ * (0.5 + 0.5 * haveQ)),
	);
	const eyeR = BETA_R0[1] * best.kR * Math.exp(-eyeAlt / H_R);
	const eyeM = best.bM * Math.exp(-eyeAlt / hM);
	Object.assign(hazeGpuTimes, {
		cpuPrep: t1 - T0,
		gpuPrep: t2 - t1,
		cpuBins: t3 - t2,
		cpuFreeBeta: t4 - t3,
		gpuGrid: t5 - t4,
		gridCandidates: cand.length,
		cpuRefine: performance.now() - t5,
		total: performance.now() - T0,
		readKB: bytes / 1024,
		tailRead: tail ? 1 : 0,
	});
	return {
		betaR: [BETA_R0[0] * best.kR, BETA_R0[1] * best.kR, BETA_R0[2] * best.kR],
		betaM: best.bM,
		hR: H_R,
		hM,
		airlight,
		sunDir,
		sunColor: sunColor(sunDir),
		mieG: MIE_G,
		strength: 1,
		airlightMix: 1,
		beta,
		j0: [fin.J[0], fin.J[1], fin.J[2]],
		rayleighScale: best.kR,
		mieScale: best.bM / BETA_M0,
		visibility: 3.912 / (eyeR + eyeM),
		quality,
		rms,
		samples,
	};
}
