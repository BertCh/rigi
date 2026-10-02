// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ScanResult } from "../track/skyline-cpu";
// The tracker's heavy skyline for /live: the real sky segmenter (src/lib/sky, U²-Net-P on src/lib/nn
// in a worker) run on a snapshot of the video frame, then reduced to the tracker's observation shape
// (per-column skyline rows at a reduced grid, edge coordinates, weights 0..1). It runs at a low rate
// (the tracker asks every ~2 s, one at a time) and never blocks pushFrame: the snapshot is taken
// synchronously, everything else is awaited by the tracker's own promise handling.
import type { HeavySkyline } from "../track/types";

/** A per-column skyline in the mask's own pixels (sky/skyline.ts skylineFromSky output). */
export interface MaskSkyline {
	width: number;
	height: number;
	rows: Float32Array;
	weight: Float32Array;
}

/** Columns the tracker's solver gets from a heavy skyline (the cheap scan runs at 320). */
const TARGET_COLUMNS = 320;

/**
 * Reduce a mask skyline to the tracker grid: an integer decimation of both axes (so the pixel stays
 * square and the focal length derived from the grid height stays right), keeping the strongest
 * column of each group; rows scale with the grid height. NaN rows get weight 0.
 */
export function skylineToScan(
	sky: MaskSkyline,
	targetColumns = TARGET_COLUMNS,
): ScanResult {
	const group = Math.max(1, Math.floor(sky.width / targetColumns));
	const width = Math.floor(sky.width / group);
	const height = Math.max(8, Math.round(sky.height / group));
	const rowScale = height / sky.height;
	const rows = new Float32Array(width).fill(Number.NaN);
	const weights = new Float32Array(width);
	for (let x = 0; x < width; x++) {
		let best = -1;
		let bestWeight = 0;
		for (let k = 0; k < group; k++) {
			const source = x * group + k;
			const w = sky.weight[source];
			if (Number.isFinite(sky.rows[source]) && w > bestWeight) {
				bestWeight = w;
				best = source;
			}
		}
		if (best < 0) continue;
		rows[x] = sky.rows[best] * rowScale;
		weights[x] = bestWeight;
	}
	return { width, height, rows, weights };
}

/** Model-input long side for the live heavy skyline (the segmenter clamps its output to 512 or more). */
const LIVE_LONG_SIDE = 512;

/**
 * The tracker's `heavySkyline` over the real segmenter. Resolves null when the frame cannot be
 * snapshotted or the segmenter throws (the tracker then simply skips this correction).
 */
export function createHeavySkyline(): HeavySkyline {
	const sky = import("../sky");
	void sky.then((m) => m.preloadSkyModel()).catch(() => {});
	return async (frame) => {
		// snapshot first (synchronous start): the source is only valid during this call
		let bitmap: ImageBitmap;
		try {
			bitmap = await createImageBitmap(frame.source as ImageBitmapSource);
		} catch {
			return null;
		}
		try {
			const { segmentSky, skylineFromSky } = await sky;
			const mask = await segmentSky(bitmap, { longSide: LIVE_LONG_SIDE });
			return skylineToScan(skylineFromSky(mask));
		} catch {
			return null;
		} finally {
			try {
				bitmap.close();
			} catch {
				// already transferred to the worker
			}
		}
	};
}
