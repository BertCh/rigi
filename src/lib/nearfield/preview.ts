// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside terrain-only preview: while the depth model downloads or runs, the controller builds a scene
// from the DEM range alone (a synthetic NearFieldDepth whose z-depth IS the DEM range along each pixel ray)
// and swaps the real depth-model scene in when it lands. Every pixel agrees with the DEM, so the split
// classes them Terrain / Far / Sky: no splats, the terrain drape renders the near field, and the step camera
// can move at once. A preview scene carries no measure grid and no splats, so it never measures or exports.
import {
	type IntrinsicsNorm,
	type MaskLike,
	maskSampler,
	rayFactor,
} from "./geom";
import type { NearFieldDepth, NearFieldScene } from "./types";

/** NearFieldDepth.model (and the scene's model) of a DEM-only preview. */
export const PREVIEW_DEPTH_MODEL = "dem-preview";

/** Long side (cells) of the preview's DEM grid: coarse is enough, the drape carries the detail. */
export const PREVIEW_GRID_LONG_SIDE = 160;

/** Preview grid size for a photo aspect (W/H), long side `longSide`. */
export function previewGridSize(
	aspect: number,
	longSide = PREVIEW_GRID_LONG_SIDE,
): { width: number; height: number } {
	const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
	return a >= 1
		? { width: longSide, height: Math.max(1, Math.round(longSide / a)) }
		: { width: Math.max(1, Math.round(longSide * a)), height: longSide };
}

/**
 * A NearFieldDepth from a DEM range grid (geom.sampleDemGrid: ray length in m, NaN = no terrain) at the
 * photo intrinsics `K`: z-depth = range / rayFactor, invalid where there is no terrain hit or the sky
 * mask says sky. intrinsicsNorm = K, so a lift / anchor fit sees exactly the DEM.
 */
export function demPreviewDepth(
	demGrid: Float32Array,
	width: number,
	height: number,
	K: IntrinsicsNorm,
	skyMask?: MaskLike | null,
): NearFieldDepth {
	const n = width * height;
	const depth = new Float32Array(n);
	const valid = new Uint8Array(n);
	const sky = maskSampler(skyMask);
	for (let j = 0; j < height; j++)
		for (let i = 0; i < width; i++) {
			const k = j * width + i;
			const r = demGrid[k];
			if (!(r > 0) || !Number.isFinite(r)) continue;
			const u = (i + 0.5) / width;
			const v = (j + 0.5) / height;
			if (sky?.(u, v)) continue;
			depth[k] = r / rayFactor(K, u, v);
			valid[k] = 1;
		}
	return {
		width,
		height,
		depth,
		valid,
		intrinsicsNorm: { ...K },
		model: PREVIEW_DEPTH_MODEL,
		seconds: 0,
	};
}

/** True for a terrain-only preview scene (no photo-measured geometry). */
export function isPreviewScene(
	scene: NearFieldScene | null | undefined,
): boolean {
	return !!scene?.preview;
}
