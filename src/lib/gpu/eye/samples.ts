// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Photo skyline samples for the eye search, as the W6 bench and scripts/eval.ts build them:
 * detectSkyline on an 800 px wide copy of the photo, every 3rd column with a finite row and weight.
 * Works in a window or a worker (fetch + createImageBitmap + OffscreenCanvas).
 */
import { detectSkylineAsync } from "#/lib/geo/skyline";
import type { SkylineSample } from "#/lib/pose6dof/eye";

export const SAMPLE_WORK_WIDTH = 800;

/** Samples (u, v normalised, weight) plus the work image size (residuals are px of height H). */
export async function photoSamples(url: string) {
	const blob = await (await fetch(url)).blob();
	const bmp = await createImageBitmap(blob);
	const W = SAMPLE_WORK_WIDTH;
	const H = Math.round((bmp.height * W) / bmp.width);
	const cv = new OffscreenCanvas(W, H);
	const ctx = cv.getContext("2d");
	if (!ctx) throw new Error("no 2d context");
	ctx.drawImage(bmp, 0, 0, W, H);
	bmp.close();
	const img = { width: W, height: H, data: ctx.getImageData(0, 0, W, H).data };
	const sky = await detectSkylineAsync(img, { returnSky: false });
	const stride = 3;
	const samples: SkylineSample[] = [];
	for (let x = 1; x < W; x += stride)
		if (Number.isFinite(sky.rows[x]) && sky.weight[x] > 0)
			samples.push({ u: (x + 0.5) / W, v: sky.rows[x] / H, w: sky.weight[x] });
	return { W, H, samples };
}
