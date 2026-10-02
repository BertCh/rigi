// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Live Step Inside (reports/realtime-investigation-2026-10-02.md RT-3): the types the session
// (./session.ts), the WebGPU splat layer (deck-webgpu/layers/splats.ts) and the engines meet through.
import type { Buffer } from "@luma.gl/core";

/** u32 words per splat in the layer's storage layout (deck-webgpu/layers/splats.ts SPLAT_WORDS). */
export const LIVE_SPLAT_WORDS = 12;

/**
 * A GPU-resident splat set the WebGPU splat layer draws directly (no cloud, no upload). `buffer` holds
 * `capacity` splats in the layer's storage layout; the first `count` (a GPU-side value, see
 * `countBuffer`) are live and the rest are dead (NaN position, alpha 0, so the sorter drops them and the
 * vertex stage culls them). The layer draws `capacity` instances; it never reads the count.
 */
export type LiveSplatSource = {
	buffer: Buffer;
	/** One u32: the number of live splats (compaction counter). For diagnostics and indirect draws. */
	countBuffer: Buffer;
	capacity: number;
	/** Bumped whenever positions changed (a depth run): the layer re-sorts, colour refreshes keep it. */
	getVersion(): number;
};

/** What a depth run takes from the depth net: f32 GPU buffers, row-major, on the session's device. */
export type LiveDepthInputs = {
	/** [H·W] z of the affine point map (DepthNetOutput.z) */
	z: Buffer;
	/** [H·W] P(geometry) (DepthNetOutput.mask) */
	mask: Buffer;
	/** [3·H·W] unit camera-frame normals (DepthNetOutput.normal), or null: derived from the depth in-kernel */
	normal?: Buffer | null;
	/** [1] metric scale (DepthNetOutput.metricScale), read in-kernel when the session uses the live scale */
	metricScale?: Buffer | null;
};

export type LiveCameraState = {
	/** Row-major camera → ENU rotation (nearfield/lift.ts camToEnuMatrix(pose)). */
	camToEnu: readonly number[];
	/** Eye in ENU metres. */
	eye: readonly [number, number, number];
	/** Normalised photo intrinsics (geom.intrinsicsFromPose(pose, aspect)). */
	K: { fx: number; fy: number; cx: number; cy: number };
};
