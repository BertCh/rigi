// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * GPU pose scoring for autoAlign (src/lib/align.ts is the CPU twin and the reference).
 *
 *   const res = await autoAlignAsync(prior, aspect, dirs, edge, 25);   // same AlignResult as autoAlign
 *
 * The 101 × 25 coarse yaw/pitch grid (2525 scorePose calls at stride 3, most of autoAlign's
 * search time) runs as one WGSL dispatch (./pose-grid.ts). autoAlign then re-scores on the CPU the
 * few cells per yaw column within GRID_TOL of the GPU's best, so the per-column winners and their
 * scores are bit-identical to the CPU path. The coordinate descent over ≤ 5 hypotheses (align.ts
 * Descent) then runs with its neighbours pre-screened on the GPU (./pose-bound.ts): one dispatch
 * per round gives a CERTIFIED upper bound of the CPU score for every speculated neighbour of every
 * live hypothesis; the CPU skips only neighbours whose bound proves it would reject them, and
 * scores every other one exactly, deciding each move with its own rule. Final poses and scores are
 * bit-identical to autoAlign (the proof is in align.ts Descent; the bound's in pose-bound.ts).
 * `alignGpuOptions.refine = "cpu"` (or the `refine` option) keeps the refine on the plain CPU loop.
 * Any GPU failure, no WebGPU, or the kill switch (?gpu=off, src/lib/flags) → plain autoAlign.
 *
 * Runs on gpu/core: both kernels on a core ComputeGraph (./graph.ts: cleared output transient + read
 * node over the pooled input slots; the only GPU path since 2026-10-01), the edge map's static planes
 * uploaded once per photo, and the core/profile labels "align-pose-grid" and "align-pose-bound".
 */

import type { Device } from "@luma.gl/core";
import {
	type AlignResult,
	autoAlign,
	autoAlignRefined,
	type CoarseGridScores,
	coarseGridPoses,
	type EdgeMap,
	fitPriorSky,
	newRefineStats,
	REFINE_SPECULATION,
	RefineBoundViolation,
	type RefineSpeculation,
	type RefineStats,
	type ScoreBounds,
	type SkipVerifier,
} from "#/lib/align";
import type { Pose } from "#/lib/camera";
import { getComputeDevice } from "#/lib/gpu/core/device";
import { fitPriorSkyGpu } from "#/lib/gpu/photoprep";
import { type PoseBoundStats, poseBoundSession } from "./pose-bound";
import {
	type PoseGridStats,
	scorePoseGridGpu,
	warmPoseGridAsync,
} from "./pose-grid";

/**
 * Re-score window around each yaw column's GPU maximum. f32 error per cell is ~1e-4 at worst (a
 * direction flipping into the neighbouring pixel changes one of ~1k samples); measured max
 * |GPU − CPU| over the 4 eval photos is in scripts/gpu/w2-align-parity.mjs. The window must be
 * ≥ 2 × that error for exact parity; wider only costs a few extra CPU cells.
 */
export const GRID_TOL = 5e-3;

export type AlignGpuTiming = {
	/** "gpu" or "cpu" (fallback / kill switch) */
	path: "gpu" | "cpu";
	/** whole autoAlignAsync, ms */
	totalMs: number;
	/** GPU grid: upload + dispatch + readback, ms (0 on the CPU path) */
	gridMs: number;
	/** cells re-scored on the CPU (of 2525) */
	rescored: number;
	/** bytes uploaded for the GPU grid (the edge map's coarse/fg planes only on a photo's first grid) */
	uploadBytes?: number;
	/** refine: "gpu" (bound-screened descent) or "cpu" (plain loop), with its counters */
	refine?: "gpu" | "cpu";
	refineStats?: RefineStats;
	/** refine bound dispatches: count, poses, unbounded poses, upload bytes, ms awaiting the GPU */
	boundStats?: PoseBoundStats;
	/** autoAlign after the grid: the CPU re-score of the near-best cells plus the whole refine, ms */
	searchMs?: number;
	/** set when this call hit a bound violation (refine re-run on the CPU, device's GPU refine off) */
	violation?: string;
	error?: string;
};

/**
 * Process-wide default of autoAlignAsync's refine: "gpu" = neighbours pre-screened by certified GPU
 * bounds (same result), "cpu" = the plain CPU loop. For A/B harnesses; not a src/lib/flags flag.
 */
export const alignGpuOptions: {
	refine: "gpu" | "cpu";
	speculation: RefineSpeculation;
	/**
	 * TEST ONLY, dev builds only (import.meta.env.DEV; absent from production bundles): subtracted
	 * from every GPU bound (forces a bound violation and the fallback). scripts/gpu/align-refine-ab.mjs.
	 */
	faultDeflate?: number;
} = {
	refine: "gpu",
	speculation: { ...REFINE_SPECULATION },
	...(import.meta.env?.DEV ? { faultDeflate: 0 } : {}),
};

/**
 * Runtime verification of the GPU bounds, per device. The bounds are certified only as long as the
 * device's f32 arithmetic stays within the slack the derivation assumes (WGSL's accuracy rules; a
 * fast-math or non-conformant driver could break them), so the refine re-scores on the CPU:
 *  - every skip whose margin below `cur` is under 2 × the bound's error allowance (the skips that
 *    lean on the allowance),
 *  - the device's first VERIFY_FIRST skips, then 1 in VERIFY_EVERY at random.
 * On any violation the GPU refine is disabled for that device (like the colour-stats subgroup
 * fallback) and the call re-runs the plain CPU refine, so it still returns the exact CPU result.
 */
export const VERIFY_FIRST = 64;
export const VERIFY_EVERY = 128;
type RefineDeviceState = {
	checked: number;
	disabled: boolean;
	violation?: string;
};
const refineDevices = new WeakMap<Device, RefineDeviceState>();
const refineState = (device: Device) => {
	let st = refineDevices.get(device);
	if (!st) {
		st = { checked: 0, disabled: false };
		refineDevices.set(device, st);
	}
	return st;
};
/** True once a bound violation turned the GPU refine off for `device`. */
export const gpuRefineDisabled = (device: Device) =>
	refineDevices.get(device)?.disabled ?? false;
/** Forget `device`'s verification state (tests). */
export const resetGpuRefine = (device: Device) => {
	refineDevices.delete(device);
};
/**
 * The GPU refine of one call under the device's verification policy: `gpu(verify)` runs the bounded
 * refine with this device's SkipVerifier; on a RefineBoundViolation the device's GPU refine is turned
 * off for good and the call's result is `cpu()` (the plain CPU refine, i.e. the exact CPU result).
 * Exported for the node fault test (src/lib/gpu/align/refine-guard.check.ts).
 */
export async function guardedRefine(
	device: Device,
	gpu: (verify: SkipVerifier) => Promise<AlignResult>,
	cpu: () => AlignResult,
): Promise<{ res: AlignResult; violation?: string }> {
	const st = refineState(device);
	try {
		return { res: await gpu(skipVerifier(st)) };
	} catch (e) {
		if (!(e instanceof RefineBoundViolation)) throw e;
		// the device broke the bounds' premise: no more GPU refine on it; this call's result comes
		// from the plain CPU refine (same snapshot, same grid)
		st.disabled = true;
		st.violation = e.message;
		console.warn("[gpu] autoAlign refine bound violated; GPU refine off", e);
		return { res: cpu(), violation: e.message };
	}
}

function skipVerifier(st: RefineDeviceState): SkipVerifier {
	return {
		check: (margin, eps) => {
			if (margin < 2 * eps) return true;
			if (st.checked < VERIFY_FIRST) {
				st.checked++;
				return true;
			}
			return Math.random() < 1 / VERIFY_EVERY;
		},
	};
}

/** Timing of the last autoAlignAsync call (for benchmarks and the engines' stats). */
export let lastAlignTiming: AlignGpuTiming | null = null;

/**
 * Create the compute device and compile the kernel ahead of the first autoAlign (async pipeline
 * creation, so the thread is not blocked). Never throws.
 */
export async function warmAlignGpu() {
	try {
		const device = await getComputeDevice();
		if (device) await warmPoseGridAsync(device);
	} catch {}
}

/** autoAlign with the coarse grid scored on the GPU. Same arguments and result as autoAlign. */
export async function autoAlignAsync(
	prior: Pose,
	aspect: number,
	dirs: Float32Array,
	edge: EdgeMap,
	yawRange = 25,
	opts: { refine?: "gpu" | "cpu" } = {},
): Promise<AlignResult> {
	const t0 = performance.now();
	const mode = opts.refine ?? alignGpuOptions.refine;
	let device = null;
	try {
		device = await getComputeDevice();
	} catch {}
	if (!device) {
		const res = autoAlign(prior, aspect, dirs, edge, yawRange);
		lastAlignTiming = {
			path: "cpu",
			totalMs: performance.now() - t0,
			gridMs: 0,
			rescored: 0,
		};
		return res;
	}
	// the grid scores depend on the prior's sky fit, so fit first (autoAlign then skips it). The GPU
	// fit (../photoprep, bit-identical) leaves `edge` alone while it runs; its planes are written into
	// `edge` here, exactly where (and as) the CPU fit writes them, with no await until the copy below
	const fit = await fitPriorSkyGpu(device, prior, aspect, dirs, edge);
	if (fit) {
		edge.sky = fit.sky;
		edge.skyCum.set(fit.skyCum);
	} else fitPriorSky(prior, aspect, dirs, edge);
	// Everything below awaits, and a concurrent autoAlign's fitPriorSky rewrites the sky planes in
	// place: take a private copy NOW (no await since the fit), where the synchronous autoAlign would
	// read them, and use it for the grid, the bounds, the refine and every CPU fallback (coarse /
	// fine / fg are never written after buildEdgeMap, so they stay shared and keep their uploads).
	const own: EdgeMap = {
		...edge,
		sky: edge.sky.slice(),
		skyCum: edge.skyCum.slice(),
	};
	let grid: CoarseGridScores | undefined;
	let error: string | undefined;
	let uploadBytes: number | undefined;
	const tg = performance.now();
	try {
		const { poses } = coarseGridPoses(prior, yawRange);
		// this call's own upload stat, filled inside the lease (a module global read here could
		// already hold a concurrent grid's bytes)
		const st: PoseGridStats = { uploadBytes: 0 };
		const scores = await scorePoseGridGpu(
			device,
			poses,
			aspect,
			dirs,
			own,
			3,
			st,
		);
		grid = { scores, tol: GRID_TOL, skyFitted: true };
		uploadBytes = st.uploadBytes;
	} catch (e) {
		error = String(e);
		console.warn("[gpu] autoAlign grid failed, using the CPU", e);
	}
	const gridMs = performance.now() - tg;
	const coarse = grid ?? {
		scores: new Float32Array(0),
		tol: 0,
		skyFitted: true,
	};
	const rs = newRefineStats();
	const tr = performance.now();
	let res: AlignResult;
	let boundStats: PoseBoundStats | undefined;
	const devState = refineState(device);
	let refine: "gpu" | "cpu" =
		grid && mode === "gpu" && !devState.disabled ? "gpu" : "cpu";
	let violation: string | undefined;
	if (refine === "gpu") {
		boundStats = { uploadBytes: 0, calls: 0, poses: 0, unbounded: 0, gpuMs: 0 };
		let bounds: ScoreBounds = poseBoundSession(
			device,
			aspect,
			dirs,
			own,
			boundStats,
		);
		const deflate = import.meta.env?.DEV ? alignGpuOptions.faultDeflate : 0;
		if (deflate) {
			const inner = bounds;
			bounds = async (probes) =>
				(await inner(probes)).map((b) =>
					b ? { ub: b.ub - deflate, eps: b.eps } : b,
				);
		}
		const g = await guardedRefine(
			device,
			(verify) =>
				autoAlignRefined(
					prior,
					aspect,
					dirs,
					own,
					yawRange,
					coarse,
					bounds,
					rs,
					alignGpuOptions.speculation,
					verify,
				),
			() => {
				Object.assign(rs, newRefineStats());
				return autoAlign(prior, aspect, dirs, own, yawRange, coarse, rs);
			},
		);
		res = g.res;
		violation = g.violation;
		if (violation) refine = "cpu";
	} else res = autoAlign(prior, aspect, dirs, own, yawRange, coarse, rs);
	lastAlignTiming = {
		path: grid ? "gpu" : "cpu",
		totalMs: performance.now() - t0,
		gridMs,
		rescored: grid?.rescored ?? 0,
		uploadBytes,
		refine,
		refineStats: rs,
		boundStats,
		searchMs: performance.now() - tr,
		violation,
		error,
	};
	return res;
}
