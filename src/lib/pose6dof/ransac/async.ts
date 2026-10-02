// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Async RANSAC entry points: the same loops as the sync CPU functions, with large batches scored on
// the GPU (src/lib/gpu/ransac, a ComputeGraph: score K × N, arg-max, read back the winner). Small
// batches, a missing device (?gpu=off, WebGL2, node) or a GPU failure take the CPU scorer. The GPU
// code is imported lazily, so the sync solvers stay free of luma.
import {
	type AbsolutePoseOptions,
	type AbsolutePoseResult,
	absolutePoseLoop,
} from "./absolute";
import {
	type BatchScorer,
	driveAsync,
	type HypothesisBatch,
	scoreBatchCpu,
} from "./batch";
import {
	type CameraRotationOptions,
	type CameraRotationResult,
	cameraRotationLoop,
	type Intrinsics,
} from "./camera-rotation";
import {
	type RotationRansacOptions,
	type RotationRansacResult,
	rotationRansacLoop,
} from "./rotation";

export type GpuScoringOptions = {
	/** "auto" (default): GPU when a compute device exists and a batch is large; "off": CPU only; "on": GPU for every batch. */
	gpu?: "auto" | "on" | "off";
	/** Hypotheses × correspondences below which "auto" scores on the CPU (default 2^19). */
	minGpuWork?: number;
	/** Called once per batch with the path that scored it (tests, benches). */
	onBatch?: (path: "gpu" | "cpu", hypotheses: number) => void;
};

/** A scorer for one solve: GPU for big batches (packed correspondences reused across batches). */
export async function createScorer(
	o: GpuScoringOptions = {},
): Promise<BatchScorer> {
	const cpu = (b: HypothesisBatch) => {
		o.onBatch?.("cpu", b.count);
		return scoreBatchCpu(b);
	};
	if (o.gpu === "off") return cpu;
	let gpu:
		| ((b: HypothesisBatch) => Promise<ReturnType<typeof scoreBatchCpu>>)
		| null = null;
	try {
		const { getComputeDevice } = await import("../../gpu/device");
		const device = await getComputeDevice();
		if (device) {
			const { scoreBatchGpu, packCorrespondences } = await import(
				"../../gpu/ransac/score"
			);
			const packed = new WeakMap<Float64Array, Float32Array>();
			gpu = (b) => {
				let corr = packed.get(b.a);
				if (!corr || corr.length !== b.n * 8) {
					corr = packCorrespondences(b);
					packed.set(b.a, corr);
				}
				return scoreBatchGpu(device, b, corr);
			};
		}
	} catch {
		gpu = null;
	}
	const min = o.gpu === "on" ? 0 : (o.minGpuWork ?? 1 << 19);
	let failed = false;
	return async (b) => {
		if (!gpu || failed || b.count * b.n < min) return cpu(b);
		try {
			const w = await gpu(b);
			o.onBatch?.("gpu", b.count);
			return w;
		} catch (e) {
			// a lost device or validation error: finish this solve on the CPU
			failed = true;
			console.warn("[ransac] GPU scoring failed, using the CPU", e);
			return cpu(b);
		}
	};
}

/** rotationRansac with GPU batch scoring. */
export async function rotationRansacAsync(
	bearings0: Float64Array,
	bearings1: Float64Array,
	opts: RotationRansacOptions & GpuScoringOptions = {},
): Promise<RotationRansacResult | null> {
	return driveAsync(
		rotationRansacLoop(bearings0, bearings1, opts),
		await createScorer(opts),
	);
}

/** cameraRotationRansac with GPU batch scoring (all focal candidates in one batch). */
export async function cameraRotationRansacAsync(
	points2d: Float64Array,
	worldDirs: Float64Array,
	camera: Intrinsics,
	opts: CameraRotationOptions & GpuScoringOptions = {},
): Promise<CameraRotationResult | null> {
	return driveAsync(
		cameraRotationLoop(points2d, worldDirs, camera, opts),
		await createScorer(opts),
	);
}

/** absolutePoseRansac with GPU batch scoring (256 samples per batch unless batchSize is given). */
export async function absolutePoseRansacAsync(
	points2d: Float64Array,
	points3d: Float64Array,
	camera: Intrinsics,
	opts: AbsolutePoseOptions & GpuScoringOptions = {},
): Promise<AbsolutePoseResult | null> {
	const scorer = await createScorer(opts);
	return driveAsync(
		absolutePoseLoop(points2d, points3d, camera, { batchSize: 256, ...opts }),
		scorer,
	);
}
