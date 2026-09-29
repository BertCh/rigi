/**
 * GPU pose scoring for autoAlign (src/lib/align.ts is the CPU twin and the reference).
 *
 *   const res = await autoAlignAsync(prior, aspect, dirs, edge, 25);   // same AlignResult as autoAlign
 *
 * The 101 × 25 coarse yaw/pitch grid (2525 scorePose calls at stride 3, most of autoAlign's
 * search time) runs as one WGSL dispatch (./pose-grid.ts). autoAlign then re-scores on the CPU the
 * few cells per yaw column within GRID_TOL of the GPU's best, so the per-column winners and their
 * scores are bit-identical to the CPU path; the coordinate descent over ≤ 5 hypotheses stays on the
 * CPU (it's sequential, and its fine-map evaluations are few). Any GPU failure, no WebGPU, or the
 * kill switch (?gpu=off, localStorage rigi.gpu=off) → plain autoAlign.
 */
import {
	type AlignResult,
	autoAlign,
	type CoarseGridScores,
	coarseGridPoses,
	type EdgeMap,
	fitPriorSky,
} from "#/lib/align";
import type { Pose } from "#/lib/camera";
import { getComputeDevice } from "../device";
import { scorePoseGridGpu, warmPoseGrid } from "./pose-grid";

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
	error?: string;
};

/** Timing of the last autoAlignAsync call (for benchmarks and the engines' stats). */
export let lastAlignTiming: AlignGpuTiming | null = null;

/** Create the compute device and compile the kernel ahead of the first autoAlign. Never throws. */
export async function warmAlignGpu() {
	try {
		const device = await getComputeDevice();
		if (device) warmPoseGrid(device);
	} catch {}
}

/** autoAlign with the coarse grid scored on the GPU. Same arguments and result as autoAlign. */
export async function autoAlignAsync(
	prior: Pose,
	aspect: number,
	dirs: Float32Array,
	edge: EdgeMap,
	yawRange = 25,
): Promise<AlignResult> {
	const t0 = performance.now();
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
	// the grid scores depend on the prior's sky fit, so fit first (autoAlign then skips it)
	fitPriorSky(prior, aspect, dirs, edge);
	let grid: CoarseGridScores | undefined;
	let error: string | undefined;
	const tg = performance.now();
	try {
		const { poses } = coarseGridPoses(prior, yawRange);
		const scores = await scorePoseGridGpu(device, poses, aspect, dirs, edge, 3);
		grid = { scores, tol: GRID_TOL, skyFitted: true };
	} catch (e) {
		error = String(e);
		console.warn("[gpu] autoAlign grid failed, using the CPU", e);
	}
	const gridMs = performance.now() - tg;
	const res = autoAlign(
		prior,
		aspect,
		dirs,
		edge,
		yawRange,
		grid ?? { scores: new Float32Array(0), tol: 0, skyFitted: true },
	);
	lastAlignTiming = {
		path: grid ? "gpu" : "cpu",
		totalMs: performance.now() - t0,
		gridMs,
		rescored: grid?.rescored ?? 0,
		error,
	};
	return res;
}
