// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU twin of look/haze-fit.ts fitHaze. The GPU (haze.wgsl.ts) does the per-pixel work (photo
// resample, depth edges, dilations, log-range bins), the per-bin 1st / 9th percentiles (exact order
// statistics by radix select, replacing the CPU's sorts), the representative pixel lists and the
// airlight band's values (compacted / gathered, so the per-pixel lin + bins stay on the GPU), and
// the physical fit's 5 550-cell grid scan. The CPU keeps what is small or sequential: the airlight
// statistics, the dark-subset sums and representative paths, the free-β IRLS, the refinement
// passes and the quality terms. Those parts mirror haze-fit.ts (keep in sync): the same arithmetic
// in the same order, with three bit-identical shortcuts (atmPath's exp(−eyeAlt / H) hoisted, a
// per-pass memo of the refinement's revisited points, typed-array sorts for the airlight). The node
// check haze-tail.check.ts proves the tail equals fitHaze bit for bit on synthetic scenes;
// look-bench.mjs compares the whole GPU fit with the CPU on captured inputs. Both submits run as
// core ComputeGraphs (./haze-graph.ts); the pooled dispatch path and its full-readback
// (compact: false) mode were removed on 2026-10-01.
import type { Device } from "@luma.gl/core";
import {
	ATM_CURV,
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
import type { ComputeGraph, GraphBinding, GraphRange } from "../core/graph";
import {
	GPUGather,
	GPUHistogram,
	GPUScan,
	GPUSort,
	type GraphBufferHandle,
} from "../core/luma";
import { LOOK_SUBGROUP_GROUP, statsSubgroupsOn } from "./color-stats";
import {
	HZ_BIN,
	HZ_DILH,
	HZ_GRID,
	HZ_HIST,
	HZ_LIST_INDEX,
	HZ_LIST_KEY,
	HZ_PREP,
	HZ_SCAN,
	HZ_SCAN_SG,
	HZ_SEL_INIT,
	LIST_KEY_BITS,
	LISTS,
	SEL,
} from "./haze.wgsl";
import { defineKernel } from "./kernel";
import { HAZE_GRID_PARAMS, HAZE_PREP_PARAMS } from "./uniform-blocks";

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
const SCAN_LAYOUT: [string, "uniform" | "read-only-storage" | "storage"][] = [
	["prm", "uniform"],
	["hist", "read-only-storage"],
	["state", "storage"],
];
export const K_HZ_SCAN = defineKernel("hz-scan", HZ_SCAN, SCAN_LAYOUT);
/** HZ_SCAN by subgroupInclusiveAdd (same bits; needs the "subgroups" feature, its own warm-up group). */
export const K_HZ_SCAN_SG = defineKernel(
	"hz-scan-sg",
	HZ_SCAN_SG,
	SCAN_LAYOUT,
	{ group: LOOK_SUBGROUP_GROUP },
);
/** The subgroup scan applies: the device has subgroups and subgroups is not off. */
export const hazeScanSubgroupsOn = (device: Device) => statsSubgroupsOn(device);
export const K_HZ_LIST_KEY = defineKernel("hz-list-key", HZ_LIST_KEY, [
	["prm", "uniform"],
	["bins", "read-only-storage"],
	["lin", "read-only-storage"],
	["state", "read-only-storage"],
	["keys", "storage"],
	["vals", "storage"],
]);
export const K_HZ_LIST_INDEX = defineKernel("hz-list-index", HZ_LIST_INDEX, [
	["prm", "uniform"],
	["sortedVals", "read-only-storage"],
	["outIdx", "storage"],
]);
export const K_HZ_GRID = defineKernel("hz-grid", HZ_GRID, [
	["prm", "uniform"],
	["reps", "read-only-storage"],
	["repOff", "read-only-storage"],
	["Iw", "read-only-storage"],
	["hmPrior", "read-only-storage"],
	["err", "storage"],
]);

/** hz-scan's dispatch: one workgroup per selection. */
export const SCAN_GROUPS = SEL;

/** Elements the list compaction sorts: (pixel, channel) pairs. */
export const listElements = (N: number) => 3 * N;

/**
 * The 72 representative lists on a ComputeGraph, from core primitives (replaces the old per-block
 * count / scan / scatter): a key kernel over the 3N (pixel, channel) elements (key = list id or
 * LIST_NONE, value = element), a stable GPUSort (radix, LIST_KEY_BITS) into list-major order with
 * pixels ascending within a list, a GPUHistogram of the keys (73 exact one-wide bins over [0, 73]; the
 * LIST_NONE keys fall outside and are ignored) and an exclusive GPUScan of it into `starts`
 * (starts[L], starts[LISTS] = total), a GPUGather of the elements' lin bits into `outVal` and a
 * trivial e / 3 into `outIdx`. Only [0, total) of outIdx / outVal is meaningful (the rest is the
 * unlisted elements in element order), exactly the range every reader takes. `cprm` is the
 * HAZE_COUNT_PARAMS block (N). `lin` / `outIdx` / `outVal` must be declared at their full size
 * (3N words: views are checked against the declared length); dispatches are 3N / 256 groups, so N
 * stays below 5.6 M (65 535 groups). Stability makes the lists identical to the CPU's.
 */
export function addListCompaction<P>(
	g: ComputeGraph<P>,
	b: {
		cprm: GraphBinding;
		bins: GraphBinding | GraphRange<P>;
		state: GraphBinding | GraphRange<P>;
		lin: GraphBufferHandle;
		outIdx: GraphBufferHandle;
		outVal: GraphBufferHandle;
		starts: GraphBufferHandle;
	},
	N: number,
) {
	const M = listElements(N);
	const keys = g.transientBuffer("listKeys", M * 4);
	const vals = g.transientBuffer("listVals", M * 4);
	const sortedKeys = g.transientBuffer("listSortedKeys", M * 4);
	const sortedVals = g.transientBuffer("listSortedVals", M * 4);
	const counts = g.transientBuffer("listCounts", (LISTS + 1) * 4);
	const groups: [number] = [Math.ceil(M / 256)];
	g.addKernel({
		id: "list-key",
		spec: K_HZ_LIST_KEY,
		bindings: {
			prm: b.cprm,
			bins: b.bins,
			lin: b.lin,
			state: b.state,
			keys,
			vals,
		},
		workgroups: groups,
	});
	g.add(
		new GPUSort({
			id: "list-sort",
			keys: g.view(keys, "uint32", M),
			values: g.view(vals, "uint32", M),
			outputKeys: g.view(sortedKeys, "uint32", M),
			outputValues: g.view(sortedVals, "uint32", M),
			algorithm: "radix",
			keyBits: LIST_KEY_BITS,
		}),
	);
	g.add(
		new GPUHistogram({
			id: "list-hist",
			input: g.view(keys, "uint32", M),
			output: g.view(counts, "uint32", LISTS + 1),
			domain: [0, LISTS + 1],
		}),
	);
	g.add(
		new GPUScan({
			id: "list-starts",
			input: g.view(counts, "uint32", LISTS + 1),
			output: g.view(b.starts, "uint32", LISTS + 1),
			mode: "exclusive",
		}),
	);
	g.add(
		new GPUGather({
			id: "list-vals",
			source: g.view(b.lin, "uint32", M),
			indices: g.view(sortedVals, "uint32", M),
			output: g.view(b.outVal, "uint32", M),
		}),
	);
	g.addKernel({
		id: "list-index",
		spec: K_HZ_LIST_INDEX,
		bindings: { prm: b.cprm, sortedVals, outIdx: b.outIdx },
		workgroups: groups,
		writes: { outIdx: "full" },
	});
}

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
/** The physical grid's cells (H_M candidates × kR × β_M). */
export const GRID_CELLS = H_M_CANDIDATES.length * GRID_A * GRID_B;
export const HM_PRIOR = Float32Array.from(
	H_M_CANDIDATES,
	(h) => 8 * Math.log2(h / H_M) ** 2,
);

/** Timings of the last fitHazeGpu (ms), for the bench. */
export const hazeGpuTimes: Record<string, number> = {};

/** fitHazeGpu's test hooks. Only the representative lists and the airlight band's values come back (the GPU compacts them). */
export type HazeGpuOptions = {
	/**
	 * Test hook: list slots in the first readback instead of the adaptive estimate
	 * (./haze-graph.ts headFor). A small value forces the second, exact-length tail read (the bench
	 * checks it gives the very same fit).
	 */
	listHead?: number;
};

/**
 * One (bin, channel)'s candidate pixels in pixel order: indices and their lin values, and (when the
 * airlight band ran on the GPU, ./haze-band.ts) their range values, bit for bit range[idx[k]].
 */
type List = { idx: ArrayLike<number>; val: Float32Array; range?: Float32Array };

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
	const lo = Math.log(DMIN);
	// 36 B of fields; the block packs to 48
	const words = HAZE_PREP_PARAMS.pack({
		W,
		H,
		pw: photo.width,
		rad,
		fgRad,
		lo,
		span: Math.log(DMAX) - lo,
		rmin: Math.max(150, DMIN),
		rmax: DMAX,
	}).slice(0, 36);
	return { xb, yb, words };
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
	const words = HAZE_GRID_PARAMS.pack({
		S,
		NH,
		NA: GRID_A,
		NB: GRID_B,
		air: [airlight[0], airlight[1], airlight[2], 0],
		betaR0: [BETA_R0[0], BETA_R0[1], BETA_R0[2], 0],
		lam,
		jBar,
		priorK,
	});
	const cells = NH * GRID_A * GRID_B;
	return { flat, off, iw, words, cells };
}

/**
 * What the GPU grid arg-min program (./haze-argmin.ts) reads back instead of the whole grid: the
 * grid's minimum `gMin` (exact: a NaN-skipping min of the f32 cells), how many cells `count` lie
 * within its f32 superset tolerance (≥ gridTolerance(gMin)), and up to GRID_PICK_CAP of them (`idx`,
 * their `err`): all of them when count ≤ GRID_PICK_CAP, else the GRID_PICK_CAP smallest by (err,
 * index). gridCandidates gives the same candidates as from the whole grid (haze-argmin.check.ts).
 */
export type GridPick = {
	gMin: number;
	count: number;
	idx: Uint32Array;
	err: Float32Array;
};

/** The most grid candidates the CPU re-evaluates (hazeFitTail), = the GPU pick's read slots. */
export const GRID_PICK_CAP = 256;

/** hazeFitTail's candidate tolerance around the grid minimum (f64). */
export const gridTolerance = (gMin: number) =>
	gMin + Math.abs(gMin) * 1e-3 + 1e-12;

/**
 * The cells hazeFitTail re-evaluates in f64, in index order: those within gridTolerance of the
 * grid's minimum (NaN cells never), at most GRID_PICK_CAP (the smallest by err, ties by index).
 * From the whole grid, or from the GPU pick (the same cells: the pick's superset is a prefix-closed
 * superset of them in (err, index) order, and the exact f64 test is re-applied here).
 */
export function gridCandidates(g: Float32Array | GridPick): number[] {
	if (!(g instanceof Float32Array)) {
		const tol = gridTolerance(g.gMin);
		const n = Math.min(g.count, GRID_PICK_CAP);
		const cand: number[] = [];
		for (let k = 0; k < n; k++) if (g.err[k] <= tol) cand.push(g.idx[k]);
		return cand.sort((p, q) => p - q);
	}
	let gMin = Number.POSITIVE_INFINITY;
	for (const e of g) if (e < gMin) gMin = e;
	const tol = gridTolerance(gMin);
	let cand: number[] = [];
	for (let k = 0; k < g.length; k++) if (g[k] <= tol) cand.push(k);
	if (cand.length > GRID_PICK_CAP)
		cand = cand
			.sort((p, q) => g[p] - g[q])
			.slice(0, GRID_PICK_CAP)
			.sort((p, q) => p - q);
	return cand;
}

/**
 * Submit 2: the physical grid's cost per cell (index = (hk·25 + a)·37 + b), whole or as the GPU
 * arg-min program's pick; ./haze-graph.ts gridGraph.
 */
export type GridFn = (
	device: Device,
	reps: Float64Array[][],
	Ic: number[][],
	wp: number[][],
	airlight: Vec3,
	lam: number,
	jBar: number,
	priorK: number,
) => Promise<Float32Array | GridPick>;

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
	// both submits on core ComputeGraphs (./haze-graph.ts imports this module, hence the dynamic import)
	const g = await import("./haze-graph");
	const prep = await g.prepGraph(...args, opts.listHead);
	const t2 = performance.now();
	return hazeFitTail(
		device,
		{ range, skyIdx, pointAt, eyeAlt, sunDir: input.sunDir, T0, t1, t2 },
		prep,
		g.gridGraph,
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
	const { a0, a1 } = bandRows(W);
	const band: number[] = [];
	for (let x = 0; x < W; x += 2)
		airlightBandColumn(range, pSky, W, H, x, a0, a1, band);
	if (band.length < 20) {
		band.length = 0;
		for (let i = 0; i < N; i++) if (range[i] <= 0) band.push(i);
	}
	return Uint32Array.from(band);
}

/** The airlight band's length before airlightBand's fallback (all its columns' pixels). */
export function bandLength(
	range: Float32Array,
	pSky: Float32Array,
	W: number,
	H: number,
) {
	const { a0, a1 } = bandRows(W);
	const band: number[] = [];
	for (let x = 0; x < W; x += 2)
		airlightBandColumn(range, pSky, W, H, x, a0, a1, band);
	return band.length;
}

/** The airlight band's rows above the topmost terrain row: [top − a1, top − a0] (as the CPU). */
export function bandRows(W: number) {
	const pxScale = W / 1024;
	const a0 = Math.max(2, Math.round(20 * pxScale));
	const a1 = Math.max(a0 + 2, Math.round(60 * pxScale));
	return { a0, a1 };
}

/** One column x of airlightBand: pushes its band pixels (row 0 = top), in row order. */
export function airlightBandColumn(
	range: Float32Array,
	pSky: Float32Array,
	W: number,
	H: number,
	x: number,
	a0: number,
	a1: number,
	band: number[],
) {
	let top = -1;
	for (let y = 0; y < H; y++) {
		const i = y * W + x;
		if (range[i] > 0 && pSky[i] < 0.5) {
			top = y;
			break;
		}
	}
	if (top < 0) return;
	for (let y = Math.max(0, top - a1); y <= top - a0; y++) {
		const i = y * W + x;
		if (range[i] > 0 || pSky[i] < 0.7) continue;
		band.push(i);
	}
}

/**
 * atmPath(h0, h1, L, H) with its exp(−h0 / H) passed in (`e0`): the same expression in the same
 * order, `e0 · L · f`, so the same bits when e0 = Math.exp(−h0 / H) (haze-tail.check.ts).
 */
export function pathFrom(
	e0: number,
	h0: number,
	h1: number,
	L: number,
	H: number,
) {
	const x = (h1 - h0) / H;
	const f = Math.abs(x) < 1e-3 ? 1 - 0.5 * x : (1 - Math.exp(-x)) / x;
	return e0 * L * f;
}

/** evalPhys's memo key: the exact doubles (JS number → string round-trips) and the H_M index. */
const evalKey = (kR: number, bM: number, hk: number) => `${kR} ${bM} ${hk}`;

/**
 * look/haze-fit.ts robustSky on the tail's band values (no fallback lin: with fewer than 20 values
 * it returns robustSky's default), with typed-array sorts instead of comparator sorts. The values
 * picked are the same: a numeric sort's k-th element is unique except for NaN and the order of ±0,
 * so inputs holding either take robustSky itself.
 */
export function robustSkyExact(
	r: number[],
	g: number[],
	b: number[],
	l: number[],
): Vec3 {
	const plain = (a: number[]) => {
		for (const v of a) if (Number.isNaN(v) || Object.is(v, -0)) return false;
		return true;
	};
	if (r.length < 20 || !plain(r) || !plain(g) || !plain(b) || !plain(l)) {
		const none = new Float32Array(0);
		return robustSky(r, g, b, l, none, none);
	}
	const sortedL = Float64Array.from(l).sort();
	const thr = sortedL[Math.floor(l.length * 0.4)];
	const pick = (a: number[]) => {
		let n = 0;
		for (const v of l) if (v >= thr) n++;
		const s = new Float64Array(n);
		let k = 0;
		for (let i = 0; i < a.length; i++) if (l[i] >= thr) s[k++] = a[i];
		s.sort();
		return s[Math.floor(n / 2)];
	};
	return [pick(r), pick(g), pick(b)];
}

/** What the CPU tail needs besides the prep's lists (timestamps for hazeGpuTimes). */
export type HazeTailContext = {
	/** range, row 0 = top (as the CPU); unused (may be empty) when every list carries its range */
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
	const airlight = robustSkyExact(skyR, skyG, skyB, skyL);

	// --- bins (from the GPU), then the CPU's per-bin loop with the GPU's order statistics
	let total = 0;
	for (const c of counts) total += c;
	const minCount = Math.max(40, Math.round(total * 0.002));
	const samples: HazeSample[] = [];
	const pathMs: number[][] = [];
	const REPS = 24;
	const NH = H_M_CANDIDATES.length;
	const reps: Float64Array[][] = [[], [], []];
	// atmPath's exp(−h0 / H) depends on the scale height only: hoisted (pathFrom, same bits)
	const eyeFactorR = Math.exp(-eyeAlt / H_R);
	const eyeFactorM = H_M_CANDIDATES.map((h) => Math.exp(-eyeAlt / h));
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
			const { idx, val, range: listRange } = list(b * 3 + c);
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
				const ri = listRange ? listRange[k] : range[i];
				low[c] += val[k];
				const keep = m % stride === 0 && nr * (1 + NH) < rep.length;
				m++;
				if (!keep && c !== 1) continue;
				const [px, py, pz] = pointAt(i);
				const h1 = pz + (px * px + py * py) * ATM_CURV;
				const r0 = pathFrom(eyeFactorR, eyeAlt, h1, ri, H_R);
				if (keep) rep[nr * (1 + NH)] = r0;
				for (let q = 0; q < NH; q++) {
					const v = pathFrom(eyeFactorM[q], eyeAlt, h1, ri, H_M_CANDIDATES[q]);
					if (keep) rep[nr * (1 + NH) + 1 + q] = v;
					if (c === 1) pM[q] += v;
				}
				if (keep) nr++;
				if (c === 1) {
					logR += Math.log(ri);
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
	let memoHits = 0;
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
	const cand = gridCandidates(gErr);
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
	// evalPhys is a pure function of (kR, bM, hk) while wp is fixed: the descent revisits points
	// bit for bit (a move keeps the other coordinate's exp(0) = 1 factor), so their err is reused.
	// Cleared whenever reweight changes wp. Same decisions, same bits (haze-tail.check.ts).
	const seen = new Map<string, number>();
	for (let pass = 0; pass < 4; pass++) {
		if (pass > 0) {
			seen.clear();
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
				seen.set(evalKey(best.kR, best.bM, hk), e);
				if (e < b2.err) b2 = { ...best, hk, err: e };
			}
			best = b2;
		} else if (best.err < Number.POSITIVE_INFINITY)
			// the candidates' winner, evaluated with this pass's wp (the default start is not)
			seen.set(evalKey(best.kR, best.bM, best.hk), best.err);
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
				const key = evalKey(k2, b2, hk);
				let e = seen.get(key);
				if (e === undefined) {
					e = evalPhys(k2, b2, hk).err;
					seen.set(key, e);
				} else memoHits++;
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
		refineMemoHits: memoHits,
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
