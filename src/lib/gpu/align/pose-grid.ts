// Host side of the pose-grid kernel (./pose-grid.wgsl.ts): align.ts scorePose for many poses in
// one dispatch. The CPU twin and reference is align.ts scorePose; the per-cell error is f32
// rounding only (see the WGSL header), and autoAlign's `grid` option re-scores near-winners on the
// CPU, so callers get the CPU's exact result.
//
// Buffers live in the gpu/core pool ("align/…" slots, one lease "align" per grid), so warm calls
// allocate nothing. The edge map's `coarse` and `fg` planes (~1 MB each at 512 px) never change
// after buildEdgeMap, so they are uploaded once per photo: a slot remembers which array it holds
// and skips the write when the same one comes back. `skyCum` is refit IN PLACE by fitPriorSky
// (it depends on the prior), so it is uploaded on every call.
//
// Graph path (default; ./graph.ts): the same kernel on a core ComputeGraph, `scores` a cleared graph
// transient read through a read node; the pooled single dispatch below stays as `{ graph: false }`.
//
// Readback: all scores (nPoses × 4 B, 10 KB for the 2525-pose grid) through a core/readback slot.
// A GPU top-K would save nothing measurable at that size, and autoAlign needs every column's
// near-maximum cells anyway.
import { Buffer, type Device } from "@luma.gl/core";
import type { EdgeMap } from "#/lib/align";
import { type Pose, poseBasis } from "#/lib/camera";
import {
	defineKernel,
	dispatch,
	kernel,
	stage,
	submit,
	warmKernels,
	warmKernelsAsync,
} from "#/lib/gpu/core/kernel";
import {
	acquire,
	pooledStorage,
	pooledUniform,
	withLease,
} from "#/lib/gpu/core/pool";
import { runPoseGraph } from "./graph";
import { POSE_GRID_WGSL } from "./pose-grid.wgsl";

const D = Math.PI / 180;

/** core/kernel warm-up group of this module. */
export const ALIGN_GROUP = "align";

const ro = "read-only-storage" as const;
const POSE_GRID = defineKernel(
	"align-pose-grid",
	POSE_GRID_WGSL,
	[
		["u", "uniform"],
		["poses", ro],
		["dirs", ro],
		["coarse", ro],
		["fg", ro],
		["skyCum", ro],
		["scores", "storage"],
	],
	// the label is the shader/pipeline id and the core/profile pass label
	{ group: ALIGN_GROUP, label: "align-pose-grid" },
);

/** Compiles the pipeline now (first-use shader compile is otherwise on the autoAlign path). */
export function warmPoseGrid(device: Device) {
	warmKernels(device, ALIGN_GROUP);
}

/** warmPoseGrid without blocking the thread (createComputePipelineAsync). Resolves the failure count. */
export const warmPoseGridAsync = (device: Device) =>
	warmKernelsAsync(device, ALIGN_GROUP);

export const STORAGE = Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC;

// pooled buffer → the array last written into it (the edge-map planes that don't change)
const resident = new WeakMap<Buffer, Float32Array>();

/** The pooled slot `key` holding `data`, written only if it holds a different array (or grew); `up` counts the bytes. */
export function uploadOnce(
	device: Device,
	key: string,
	data: Float32Array,
	up: PoseGridStats,
): Buffer {
	const b = acquire(device, key, Math.max(16, data.byteLength), STORAGE);
	if (resident.get(b) !== data) {
		b.write(data);
		resident.set(b, data);
		up.uploadBytes += data.byteLength;
	}
	return b;
}

/** Path selection of scorePoseGridGpu / poseBoundSession. */
export type AlignGraphOptions = {
	/** default (true): a core ComputeGraph encoding (./graph.ts); false: the pooled single dispatch */
	graph?: boolean;
};

export type PoseGridStats = {
	/** bytes written to the GPU by this grid (inputs; the cached edge planes count only when uploaded) */
	uploadBytes: number;
};

/**
 * Bytes written to the GPU by the last scorePoseGridGpu to finish. Racy with concurrent grids: pass
 * `stats` to scorePoseGridGpu instead (filled under the lease, for that call only).
 */
export let lastUploadBytes = 0;

/**
 * scorePose(p, aspect, dirs, edge, false, stride) for every pose (coarse edge map), on the GPU.
 * Resolves the scores in pose order. Throws on GPU errors (callers fall back to the CPU). Grids run
 * one at a time (the "align" lease: its pooled buffers are shared state).
 *
 * `edge.coarse` and `edge.fg` must not be modified in place after the first call with this edge map
 * (buildEdgeMap never does); `edge.skyCum` may be (fitPriorSky), it is re-uploaded every call.
 * `stats` (optional) receives this call's upload bytes. `opts.graph: false` takes the pooled single
 * dispatch instead of the graph (bit-identical results).
 */
export function scorePoseGridGpu(
	device: Device,
	poses: Pose[],
	aspect: number,
	dirs: Float32Array,
	edge: EdgeMap,
	stride = 3,
	stats?: PoseGridStats,
	opts: AlignGraphOptions = {},
): Promise<Float32Array> {
	const graph = opts.graph !== false;
	return withLease(ALIGN_GROUP, async () => {
		const up: PoseGridStats = { uploadBytes: 0 };
		try {
			return await scoreOnce(
				device,
				poses,
				aspect,
				dirs,
				edge,
				stride,
				up,
				graph,
			);
		} finally {
			// written while the lease is still held: no other grid's bytes can land in between
			lastUploadBytes = up.uploadBytes;
			if (stats) stats.uploadBytes = up.uploadBytes;
		}
	});
}

async function scoreOnce(
	device: Device,
	poses: Pose[],
	aspect: number,
	dirs: Float32Array,
	edge: EdgeMap,
	stride: number,
	up: PoseGridStats,
	graph: boolean,
): Promise<Float32Array> {
	const nPoses = poses.length;
	if (!nPoses) return new Float32Array(0);
	const { w, h } = edge;
	// same subsampling and `total` as scorePose
	const nDirs = Math.ceil(dirs.length / (3 * stride));
	const dirs4 = new Float32Array(Math.max(1, nDirs) * 4);
	for (let i = 0, k = 0; i < dirs.length; i += 3 * stride, k++) {
		dirs4[k * 4] = dirs[i];
		dirs4[k * 4 + 1] = dirs[i + 1];
		dirs4[k * 4 + 2] = dirs[i + 2];
	}
	const pose4 = new Float32Array(nPoses * 12);
	for (let i = 0; i < nPoses; i++) {
		const p = poses[i];
		const b = poseBasis(p);
		pose4.set(b.forward, i * 12);
		pose4[i * 12 + 3] = Math.tan((p.vfov * D) / 2);
		pose4.set(b.right, i * 12 + 4);
		pose4[i * 12 + 7] = p.vfov;
		pose4.set(b.up, i * 12 + 8);
	}
	const uw = new ArrayBuffer(32);
	const ui = new Uint32Array(uw);
	const ii = new Int32Array(uw);
	const uf = new Float32Array(uw);
	ui[0] = w;
	ui[1] = h;
	ui[2] = nDirs;
	ui[3] = nPoses;
	ii[4] = Math.max(2, Math.round(h * 0.035)); // band, as scorePose
	ii[5] = Math.max(1, Math.round(h * 0.012)); // gap (coarse)
	uf[6] = aspect;
	uf[7] = nDirs;

	// every slot below is read only within its first w·h / nDirs / nPoses entries, and `scores` is
	// fully overwritten for pi < nPoses, so pool capacity and stale bytes don't reach the result
	const inputs = {
		u: pooledUniform(device, "align/u", uw),
		poses: pooledStorage(device, "align/poses", pose4),
		dirs: pooledStorage(device, "align/dirs", dirs4),
		coarse: uploadOnce(device, "align/coarse", edge.coarse, up),
		fg: uploadOnce(device, "align/fg", edge.fg, up),
		skyCum: pooledStorage(device, "align/skycum", edge.skyCum),
	};
	up.uploadBytes +=
		32 + pose4.byteLength + dirs4.byteLength + edge.skyCum.byteLength;
	if (graph)
		return new Float32Array(
			await runPoseGraph(device, POSE_GRID, inputs, "scores", 4, nPoses),
		);
	const bindings = {
		...inputs,
		scores: acquire(device, "align/scores", nPoses * 4, STORAGE),
	};
	const enc = device.createCommandEncoder({ id: "align-pose-grid" });
	dispatch(enc, kernel(device, POSE_GRID), bindings, nPoses);
	const staged = stage(device, enc, bindings.scores, nPoses * 4);
	try {
		submit(device, enc);
	} catch (e) {
		staged.cancel();
		throw e;
	}
	return new Float32Array(await staged.read());
}
