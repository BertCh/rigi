// GPU path of solvePose's coarse (dYaw × dPitch) grid (src/lib/geo/solve.ts solveOnce; CPU twin
// ./cpu.ts). The skyglobal pattern: the GPU scores every cell in float32 and reduces each yaw row to
// its minimum (coarse.wgsl.ts, one dispatch); the CPU treats each row minimum as an interval
// [g − ε, g + ε] with a certified ε (costBound) and re-scores, exactly with cpu.ts coarseRow, only the
// rows the selection cannot decide from intervals: the ones a local-minimum test, the best-first walk
// that picks the seeds and the runner-up, or the median rank lands on. A re-score covers only the
// row's pitch band (pitches within 2.5ε of the GPU minimum), which holds the row's first minimum. So seeds, SolveResult.coarse
// and ambiguity equal solveOnce's bit for bit whenever the error bound holds (the bench checks it and
// reports the observed error against ε).
//
// Readback is the row minima with their pitch bands (16 B per row, ≤ 60 KB for a 360° search), not the grid: the selection
// needs the whole yaw curve (local minima, median), and a top-K would not certify the median.
//
// Library only: not wired into geo/ or integration/ (see ./README.md for the integration note).
// Plumbing (src/lib/gpu/core): pooled buffers under the "solve" lease, bindings per pass, one submit.
import { Buffer, type Device } from "@luma.gl/core";
import type { Camera } from "#/lib/geo/camera";
import type { HorizonProfile } from "#/lib/geo/horizon";
import type { SkylineRows, SolveOptions } from "#/lib/geo/solve";
import { getComputeDevice } from "../core/device";
import { defineKernel, dispatch, kernel, kernelAsync } from "../core/kernel";
import { acquire, pooledStorage, pooledUniform, withLease } from "../core/pool";
import { readBack } from "../core/readback";
import { COARSE_WGSL, PITCH_BLOCK } from "./coarse.wgsl";
import {
	type CoarsePlan,
	type CoarseResult,
	coarseCpu,
	coarseRow,
	finish,
	planCoarse,
	type YawCost,
} from "./cpu";

export {
	type CoarsePlan,
	type CoarseResult,
	coarseCpu,
	fullSearchOptions,
	planCoarse,
	type YawCost,
} from "./cpu";

const K_COARSE = defineKernel(
	"solve-coarse",
	COARSE_WGSL,
	[
		["u", "uniform"],
		["obs", "read-only-storage"],
		["yaws", "read-only-storage"],
		["pitch", "read-only-storage"],
		["hz", "read-only-storage"],
		["rowMin", "storage"],
	],
	{ group: "solve", label: "solve-coarse" },
);

/** Compile the pipeline now, without blocking the thread. */
export async function warmSolveGpu(device: Device) {
	await kernelAsync(device, K_COARSE);
}

export type CoarseGpuStats = {
	/** host packing + upload, ms */
	uploadMs: number;
	/** submit → row minima resolved, ms */
	gpuMs: number;
	/** bounded selection including the exact re-scores, ms */
	selectMs: number;
	nCells: number;
	/** yaw rows re-scored exactly on the CPU (of nYaw) */
	rescored: number;
	/** cells those re-scores evaluated (their pitch bands) */
	rescoredCells: number;
	/** certified per-row error bound ε */
	eps: number;
	/** max |GPU row minimum − exact row minimum| over the re-scored rows (must stay ≤ eps) */
	maxErr: number;
	/** true when the GPU could not be used for this plan and the CPU grid ran instead */
	fellBack: boolean;
	readBytes: number;
};

export type CoarseGpuResult = CoarseResult & {
	ms: number;
	stats: CoarseGpuStats;
};

const OWNER = "solve";
const key = (slot: string) => `${OWNER}/${slot}`;
const STORAGE = Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC;
/** Most yaw rows one dispatch takes (workgroups per dimension). */
const MAX_ROWS = 65535;

/**
 * Certified bound on |GPU cost − exact cost| for any cell of `p` (float32 rounding with u = 2⁻²⁴,
 * × 4 safety): inputs rounded once to f32, the (el − H) + dp residual with |el|, |dp|, |H| ≤ their
 * maxima, the interpolation weight's ≤ 4e-7 bin error times the steepest profile step, recursive
 * summation over nObs terms each ≤ w·trunc, the division by Σw and the prior terms.
 */
export function costBound(p: CoarsePlan, hz: Float32Array) {
	const u = 2 ** -24;
	let el = 0;
	for (const v of p.el) el = Math.max(el, Math.abs(v));
	let dp = 0;
	for (const v of p.dps) dp = Math.max(dp, Math.abs(v));
	let e = 0;
	let jump = 0;
	for (let i = 0; i < hz.length - 1; i++) {
		e = Math.max(e, Math.abs(hz[i]));
		jump = Math.max(jump, Math.abs(hz[i + 1] - hz[i]));
	}
	const prior = priorYaw(p, p.dys[0]) + priorPitch(p, p.dps[0]);
	const priorMax = Math.max(
		prior,
		priorYaw(p, p.dys[p.dys.length - 1]) +
			priorPitch(p, p.dps[p.dps.length - 1]),
	);
	const residual = 8 * u * (el + dp + e) + 4e-7 * jump;
	const sum = u * p.trunc * (p.az.length + 4);
	return 4 * (residual + sum + 4 * u * (priorMax + p.trunc)) + 1e-12;
}

const priorYaw = (p: CoarsePlan, dy: number) =>
	0.02 * p.trunc * (dy / p.sigmaYaw) ** 2;
const priorPitch = (p: CoarsePlan, dp: number) =>
	0.02 * p.trunc * (dp / p.sigmaPitch) ** 2;

/** coarseCpu(p) with the grid on the GPU; resolves the identical CoarseResult. */
export function coarseGpu(
	device: Device,
	p: CoarsePlan,
	o: CoarseGpuOptions = {},
): Promise<CoarseGpuResult> {
	return withLease(OWNER, () => coarseOnce(device, p, o));
}

export type CoarseGpuOptions = {
	/**
	 * Multiply the certified ε (≥ 1; parity checks only): wider intervals and bands make the selection
	 * re-score many more rows and cells, which exercises its every branch. The result stays identical.
	 */
	epsScale?: number;
};

async function coarseOnce(
	device: Device,
	p: CoarsePlan,
	o: CoarseGpuOptions,
): Promise<CoarseGpuResult> {
	const t0 = performance.now();
	const h = p.horizon;
	const nH = h.elevation.length;
	const nObs = p.az.length;
	const nYaw = p.dys.length;
	const nPitch = p.dps.length;
	const nBlk = Math.ceil(nPitch / PITCH_BLOCK);
	const stats: CoarseGpuStats = {
		uploadMs: 0,
		gpuMs: 0,
		selectMs: 0,
		nCells: nYaw * nPitch,
		rescored: 0,
		rescoredCells: 0,
		eps: 0,
		maxErr: 0,
		fellBack: false,
		readBytes: 0,
	};
	// the bin split below needs whole bins around the circle and a finite profile (NaN has no bound)
	const fallback = () => {
		stats.fellBack = true;
		return { ...coarseCpu(p), ms: performance.now() - t0, stats };
	};
	if (
		Math.abs(nH * h.step - 360) > 1e-6 ||
		nYaw > MAX_ROWS ||
		!nPitch ||
		!h.elevation.every(Number.isFinite)
	)
		return fallback();

	const hz = new Float32Array(nH + 1);
	hz.set(h.elevation);
	hz[nH] = h.elevation[0];
	// observation azimuth (as horizonAt reads it) → (bin, fraction)
	const ob = new ArrayBuffer(nObs * 16);
	const obU = new Uint32Array(ob);
	const obF = new Float32Array(ob);
	for (let o = 0; o < nObs; o++) {
		const t = (((p.az[o] % 360) + 360) % 360) / h.step;
		let i = Math.floor(t);
		const f = t - i;
		if (i >= nH) i -= nH;
		obU[o * 4] = i;
		obF[o * 4 + 1] = f;
		obF[o * 4 + 2] = p.el[o];
		obF[o * 4 + 3] = p.w[o];
	}
	const yb = new ArrayBuffer(nYaw * 16);
	const yU = new Uint32Array(yb);
	const yF = new Float32Array(yb);
	for (let k = 0; k < nYaw; k++) {
		const t = p.dys[k] / h.step;
		const i = Math.floor(t);
		yU[k * 4] = ((i % nH) + nH) % nH;
		yF[k * 4 + 1] = t - i;
		yF[k * 4 + 2] = priorYaw(p, p.dys[k]);
	}
	const pitch = new Float32Array(nPitch * 2);
	for (let j = 0; j < nPitch; j++) {
		pitch[j * 2] = p.dps[j];
		pitch[j * 2 + 1] = priorPitch(p, p.dps[j]);
	}
	const ub = new ArrayBuffer(32);
	const uU = new Uint32Array(ub);
	const uF = new Float32Array(ub);
	uU.set([nObs, nPitch, nYaw, nH]);
	uF.set([p.trunc, p.wSum], 4);
	uU[6] = nBlk;
	stats.eps = costBound(p, hz) * Math.max(1, o.epsScale ?? 1);
	// 2ε, plus 0.5ε of slack for the f32 rounding of (minimum + band), which is ≤ u·max cost ≪ ε
	uF[7] = 2.5 * stats.eps;

	const outBytes = nYaw * nBlk * 16;
	const rowMin = acquire(device, key("rowMin"), outBytes, STORAGE);
	const bind = {
		u: pooledUniform(device, key("u"), ub),
		obs: pooledStorage(device, key("obs"), obU),
		yaws: pooledStorage(device, key("yaws"), yU),
		pitch: pooledStorage(device, key("pitch"), pitch),
		hz: pooledStorage(device, key("hz"), hz),
		rowMin,
	};
	const k = kernel(device, K_COARSE);
	const t1 = performance.now();
	const [out] = await readBack(
		device,
		(enc) => dispatch(enc, k, bind, nYaw, nBlk),
		[{ buffer: rowMin, size: outBytes }],
		{ id: "solve-coarse" },
	);
	const t2 = performance.now();
	stats.uploadMs = t1 - t0;
	stats.gpuMs = t2 - t1;
	stats.readBytes = outBytes;
	const bu = new Uint32Array(out);
	const bf = new Float32Array(out);
	const g = new Float64Array(nYaw);
	for (let r = 0; r < nYaw; r++) {
		let m = Number.POSITIVE_INFINITY;
		for (let b = 0; b < nBlk; b++) m = Math.min(m, bf[(r * nBlk + b) * 4]);
		g[r] = m;
	}
	if (!g.every(Number.isFinite)) return fallback();
	// the row's band: the union of its blocks' bands whose minimum is within 2ε of the row's (a block
	// with a higher minimum measured its band from that, so it still covers every pitch ≤ g + 2ε)
	const from = new Int32Array(nYaw).fill(nPitch);
	const to = new Int32Array(nYaw).fill(-1);
	for (let r = 0; r < nYaw; r++)
		for (let b = 0; b < nBlk; b++) {
			const o = (r * nBlk + b) * 4;
			if (bf[o] > g[r] + 2 * stats.eps || bu[o + 1] > bu[o + 2]) continue;
			from[r] = Math.min(from[r], bu[o + 1]);
			to[r] = Math.max(to[r], bu[o + 2]);
		}
	let res: CoarseResult;
	try {
		res = selectBounded(p, g, from, to, stats);
	} catch (e) {
		console.warn("[solve] bounded selection failed, using the CPU grid", e);
		return fallback();
	}
	stats.selectMs = performance.now() - t2;
	return { ...res, ms: performance.now() - t0, stats };
}

/**
 * cpu.ts selectCoarse over row intervals: lo/hi = g ∓ ε until a row is re-scored exactly
 * (then lo = hi = its exact cost). Every decision is taken only when the intervals settle it;
 * otherwise the rows involved are re-scored and the step is re-run.
 */
function selectBounded(
	p: CoarsePlan,
	g: Float64Array,
	from: Int32Array,
	to: Int32Array,
	stats: CoarseGpuStats,
): CoarseResult {
	const N = g.length;
	const eps = stats.eps;
	const ex: (YawCost | null)[] = new Array(N).fill(null);
	const exact = (i: number) => {
		let r = ex[i];
		if (!r) {
			if (from[i] > to[i]) throw new Error(`empty pitch band at row ${i}`);
			r = coarseRow(p, i, from[i], to[i]);
			stats.rescoredCells += to[i] - from[i] + 1;
			ex[i] = r;
			stats.rescored++;
			stats.maxErr = Math.max(stats.maxErr, Math.abs(g[i] - r.c));
		}
		return r;
	};
	const lo = (i: number) => ex[i]?.c ?? g[i] - eps;
	const hi = (i: number) => ex[i]?.c ?? g[i] + eps;
	// c_i ≤ c_j: true / false / undecided
	const le = (i: number, j: number) =>
		hi(i) <= lo(j) ? true : lo(i) > hi(j) ? false : undefined;
	const isMin = (i: number) => {
		const a = i === 0 || le(i, i - 1);
		const b = i === N - 1 || le(i, i + 1);
		if (a === false || b === false) return false;
		return a === true && b === true ? true : undefined;
	};
	/** re-score i (and, if that does not settle it, its neighbours) and return its local-min status */
	const settle = (i: number) => {
		exact(i);
		if (isMin(i) === undefined) {
			if (i > 0) exact(i - 1);
			if (i < N - 1) exact(i + 1);
		}
		return isMin(i) === true;
	};

	// local minima, best first (stable: ties by index), walked only as far as solveOnce reads them
	let best: YawCost | undefined;
	let seeds: YawCost[] = [];
	let runnerUp: YawCost | undefined;
	for (;;) {
		const pot: number[] = [];
		for (let i = 0; i < N; i++) if (isMin(i) !== false) pot.push(i);
		pot.sort((a, b) => lo(a) - lo(b) || a - b);
		best = undefined;
		seeds = [];
		runnerUp = undefined;
		let redo = false;
		let stop = pot.length;
		let last = Number.NEGATIVE_INFINITY;
		for (let k = 0; k < pot.length; k++) {
			const i = pot[k];
			if (!ex[i] || isMin(i) === undefined) {
				settle(i);
				redo = true;
				break;
			}
			if (isMin(i) === false) continue;
			const m = ex[i] as YawCost;
			best ??= m;
			if (seeds.length < 3 && seeds.every((s) => Math.abs(s.dy - m.dy) > 1.5))
				seeds.push(m);
			if (!runnerUp && Math.abs(m.dy - best.dy) > 2) runnerUp = m;
			last = m.c;
			if (seeds.length === 3 && runnerUp) {
				stop = k + 1;
				break;
			}
		}
		if (redo) continue;
		// an unvisited row could still sort before (or tie with) the last one read: settle it
		for (let k = stop; k < pot.length; k++) {
			const i = pot[k];
			if (!ex[i] && lo(i) <= last) {
				settle(i);
				redo = true;
			}
		}
		if (!redo) break;
	}
	if (!best) throw new Error("no local minimum");

	// median of all row costs: rank k lies in [L, U]; only rows whose interval meets it are re-scored
	const k = Math.floor(N / 2);
	const los = Float64Array.from({ length: N }, (_, i) => lo(i)).sort();
	const his = Float64Array.from({ length: N }, (_, i) => hi(i)).sort();
	const L = los[k];
	const U = his[k];
	let below = 0;
	const mid: number[] = [];
	for (let i = 0; i < N; i++) {
		if (hi(i) < L) below++;
		else if (lo(i) <= U) mid.push(i);
	}
	const vals = mid.map((i) => exact(i).c).sort((a, b) => a - b);
	const r = k - below;
	if (r < 0 || r >= vals.length)
		throw new Error("median rank outside the band");
	return finish(best, seeds, runnerUp, vals[r], N, p.dps.length);
}

export type SolveCoarseOptions = {
	/** undefined: getComputeDevice(); null: the CPU grid */
	device?: Device | null;
};

/**
 * Drop-in for solveOnce's coarse stage: `opts` are the options solveOnce receives (for solvePose's
 * 360° pass, fullSearchOptions(opts)). null where solveOnce returns "no-skyline". GPU when a compute
 * device is available (identical result), else the CPU grid.
 */
export async function solveCoarse(
	prior: Camera,
	horizon: HorizonProfile,
	sky: SkylineRows,
	opts: SolveOptions = {},
	o: SolveCoarseOptions = {},
): Promise<(CoarseResult & { on: "gpu" | "cpu" }) | null> {
	const p = planCoarse(prior, horizon, sky, opts);
	if (!p) return null;
	const device = o.device === undefined ? await getComputeDevice() : o.device;
	if (device)
		try {
			const r = await coarseGpu(device, p);
			return { ...r, on: r.stats.fellBack ? "cpu" : "gpu" };
		} catch (e) {
			console.warn("[solve] GPU coarse grid failed, using the CPU", e);
		}
	return { ...coarseCpu(p), on: "cpu" };
}
