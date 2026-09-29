// Host side of the pose-grid kernel (./pose-grid.wgsl.ts): align.ts scorePose for many poses in
// one dispatch. The CPU twin and reference is align.ts scorePose; the per-cell error is f32
// rounding only (see the WGSL header), and autoAlign's `grid` option re-scores near-winners on the
// CPU, so callers get the CPU's exact result.
//
// Readback: all scores (nPoses × 4 B, 10 KB for the 2525-pose grid). A GPU top-K would save
// nothing measurable at that size, and autoAlign needs every column's near-maximum cells anyway.
import { Buffer, type ComputePipeline, type Device } from "@luma.gl/core";
import type { EdgeMap } from "#/lib/align";
import { type Pose, poseBasis } from "#/lib/camera";
import { POSE_GRID_WGSL } from "./pose-grid.wgsl";

const D = Math.PI / 180;

const pipelines = new WeakMap<Device, ComputePipeline>();

function pipeline(device: Device): ComputePipeline {
	let p = pipelines.get(device);
	if (p) return p;
	const shader = device.createShader({
		id: "align-pose-grid",
		source: POSE_GRID_WGSL,
		language: "wgsl",
		stage: "compute",
	});
	const ro = "read-only-storage" as const;
	p = device.createComputePipeline({
		id: "align-pose-grid",
		shader,
		entryPoint: "main",
		shaderLayout: {
			bindings: [
				{ name: "u", type: "uniform", group: 0, location: 0 },
				{ name: "poses", type: ro, group: 0, location: 1 },
				{ name: "dirs", type: ro, group: 0, location: 2 },
				{ name: "coarse", type: ro, group: 0, location: 3 },
				{ name: "fg", type: ro, group: 0, location: 4 },
				{ name: "skyCum", type: ro, group: 0, location: 5 },
				{ name: "scores", type: "storage", group: 0, location: 6 },
			],
		},
	});
	pipelines.set(device, p);
	return p;
}

/** Compiles the pipeline now (first-use shader compile is otherwise on the autoAlign path). */
export function warmPoseGrid(device: Device) {
	pipeline(device);
}

// one grid at a time per device: the pipeline's bindings are shared state
let queue: Promise<unknown> = Promise.resolve();

/**
 * scorePose(p, aspect, dirs, edge, false, stride) for every pose (coarse edge map), on the GPU.
 * Resolves the scores in pose order. Throws on GPU errors (callers fall back to the CPU).
 */
export function scorePoseGridGpu(
	device: Device,
	poses: Pose[],
	aspect: number,
	dirs: Float32Array,
	edge: EdgeMap,
	stride = 3,
): Promise<Float32Array> {
	const run = queue.then(() =>
		scoreOnce(device, poses, aspect, dirs, edge, stride),
	);
	queue = run.catch(() => {});
	return run;
}

async function scoreOnce(
	device: Device,
	poses: Pose[],
	aspect: number,
	dirs: Float32Array,
	edge: EdgeMap,
	stride: number,
): Promise<Float32Array> {
	const { w, h } = edge;
	// same subsampling and `total` as scorePose
	const nDirs = Math.ceil(dirs.length / (3 * stride));
	const dirs4 = new Float32Array(Math.max(1, nDirs) * 4);
	for (let i = 0, k = 0; i < dirs.length; i += 3 * stride, k++) {
		dirs4[k * 4] = dirs[i];
		dirs4[k * 4 + 1] = dirs[i + 1];
		dirs4[k * 4 + 2] = dirs[i + 2];
	}
	const nPoses = poses.length;
	const pose4 = new Float32Array(Math.max(1, nPoses) * 12);
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

	const ro = Buffer.STORAGE | Buffer.COPY_DST;
	const bufs: Buffer[] = [];
	const mk = (id: string, data: Float32Array) => {
		const b = device.createBuffer({ id: `align-${id}`, usage: ro, data });
		bufs.push(b);
		return b;
	};
	try {
		const uBuf = device.createBuffer({
			id: "align-u",
			usage: Buffer.UNIFORM | Buffer.COPY_DST,
			data: new Uint8Array(uw),
		});
		bufs.push(uBuf);
		const outBytes = Math.max(16, nPoses * 4);
		const out = device.createBuffer({
			id: "align-scores",
			usage: Buffer.STORAGE | Buffer.COPY_SRC,
			byteLength: outBytes,
		});
		bufs.push(out);
		const staging = device.createBuffer({
			id: "align-scores-read",
			usage: Buffer.MAP_READ | Buffer.COPY_DST,
			byteLength: outBytes,
		});
		bufs.push(staging);
		const pl = pipeline(device);
		pl.setBindings({
			u: uBuf,
			poses: mk("poses", pose4),
			dirs: mk("dirs", dirs4),
			coarse: mk("coarse", edge.coarse),
			fg: mk("fg", edge.fg),
			skyCum: mk("skycum", edge.skyCum),
			scores: out,
		});
		const enc = device.createCommandEncoder({ id: "align-pose-grid" });
		const pass = enc.beginComputePass({ id: "align-pose-grid" });
		pass.setPipeline(pl);
		pass.dispatch(nPoses);
		pass.end();
		enc.copyBufferToBuffer({
			sourceBuffer: out,
			destinationBuffer: staging,
			size: outBytes,
		});
		device.submit(enc.finish());
		const u8 = await staging.readAsync(0, nPoses * 4);
		return new Float32Array(
			u8.buffer.slice(u8.byteOffset, u8.byteOffset + nPoses * 4),
		);
	} finally {
		for (const b of bufs) b.destroy();
	}
}
