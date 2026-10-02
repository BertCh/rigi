// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure helpers of the live depth input: the grids one video frame is resized to (the net's token grid and
// the output depth grid) and the RGBA → planar RGB 0..1 conversion of the net's input. The browser side
// (canvas draw, GPU upload) is components/live/liveStep.ts.
import { MOGE2_VITS, tokenGrid } from "../local/depth-net";

export type LiveDepthGrid = {
	/** token grid */
	bh: number;
	bw: number;
	/** network input size in pixels (14 · tokens) */
	inputWidth: number;
	inputHeight: number;
	/** depth output grid the splat lift runs on */
	width: number;
	height: number;
};

/** The live LOD grids for a `frameWidth` × `frameHeight` video at `tokens` base tokens, depth long side `maxSide`. */
export function liveDepthGrid(
	frameWidth: number,
	frameHeight: number,
	tokens: number,
	maxSide = 512,
): LiveDepthGrid {
	const [bh, bw] = tokenGrid(tokens, frameWidth / frameHeight);
	const s = Math.min(1, maxSide / Math.max(frameWidth, frameHeight));
	return {
		bh,
		bw,
		inputWidth: bw * MOGE2_VITS.patch,
		inputHeight: bh * MOGE2_VITS.patch,
		width: Math.max(1, Math.round(frameWidth * s)),
		height: Math.max(1, Math.round(frameHeight * s)),
	};
}

/** RGBA bytes → [3, h, w] planar floats 0..1 into `out` (length ≥ 3·w·h); returns `out`. */
export function rgbaToPlanes(
	rgba: Uint8Array | Uint8ClampedArray,
	pixelCount: number,
	out: Float32Array,
): Float32Array {
	for (let k = 0; k < pixelCount; k++) {
		out[k] = rgba[4 * k] / 255;
		out[pixelCount + k] = rgba[4 * k + 1] / 255;
		out[2 * pixelCount + k] = rgba[4 * k + 2] / 255;
	}
	return out;
}
