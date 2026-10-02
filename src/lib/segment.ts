// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Browser-side foreground (people) segmentation on src/lib/nn: the MediaPipe selfie-multiclass and
// DeepLab v3 networks as WGSL kernels, the whole pipeline (resample, both nets, upsample, smoothstep,
// dilation, blur) in ONE nn forward on the page's WebGPU device (segment/people-gpu.ts). GPU only: without
// WebGPU segmentForeground returns null (no CPU nn forward on the page's thread).
//
// segmentForeground() returns a soft 0..255 mask (255 = person, incl. hair,
// clothes and held accessories) at long side MASK_LONG_SIDE, row 0 = top.

import { getNn, perNn } from "./nn";
import type { GpuNn } from "./nn/gpu/gpu-nn";
import type { ByteMask } from "./ontology/core/geometry";
import { loadPeopleNet, type PeopleModel } from "./segment/people";
import {
	createRgbaTexture,
	maskSize,
	segmentTextureGpu,
} from "./segment/people-gpu";

/** 0..255, 255 = foreground person (a ByteMask: row-major, row 0 = TOP of image). */
export type ForegroundMask = ByteMask;

export type SegmentModel = PeopleModel | "combined";

const DEFAULT_MODEL: SegmentModel = "multiclass";

const netOf: Record<PeopleModel, ReturnType<typeof perNn<PeopleNetT>>> = {
	multiclass: perNn((nn) => loadPeopleNet(nn, "multiclass")),
	deeplab: perNn((nn) => loadPeopleNet(nn, "deeplab")),
};
type PeopleNetT = Awaited<ReturnType<typeof loadPeopleNet>>;

const modelsOf = (model: SegmentModel): PeopleModel[] =>
	model === "combined" ? ["multiclass", "deeplab"] : [model];

let warnedNoGpu = false;
async function peopleNn() {
	const nn = await getNn("people");
	if (!nn && !warnedNoGpu) {
		warnedNoGpu = true;
		console.warn("[segment] people masks need WebGPU (no live WebGPU device)");
	}
	return nn;
}

/**
 * Start loading the weights (and the compute device) without an image, so it overlaps the photo decode /
 * region JSON / tiles. Idempotent; never throws.
 */
export function preloadSegmenter(model: SegmentModel = DEFAULT_MODEL): void {
	peopleNn()
		.then((nn) => {
			if (nn) for (const m of modelsOf(model)) netOf[m](nn).catch(() => {});
		})
		.catch(() => {});
}

/**
 * Segment people in the foreground of a photo.
 * Returns null (never throws) without WebGPU or if the model can't be loaded or run.
 * `model` is exposed for experimentation; the default is the tuned choice.
 */
export async function segmentForeground(
	img: HTMLImageElement | ImageBitmap,
	model: SegmentModel = DEFAULT_MODEL,
): Promise<ForegroundMask | null> {
	try {
		const iw = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
		const ih = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
		if (!iw || !ih) throw new Error("image has no size (not loaded?)");
		const nn = await peopleNn();
		if (!nn) return null;
		const { w, h } = maskSize(iw, ih);
		const nets = await Promise.all(modelsOf(model).map((m) => netOf[m](nn)));
		// the w x h working copy straight into a texture: no canvas, no getImageData
		const bitmap = await createImageBitmap(img, {
			resizeWidth: w,
			resizeHeight: h,
			resizeQuality: "high",
		});
		try {
			const tex = createRgbaTexture((nn as GpuNn).device, bitmap, w, h);
			try {
				return await segmentTextureGpu(nn, nets, tex, w, h);
			} finally {
				tex.destroy();
			}
		} finally {
			bitmap.close();
		}
	} catch (err) {
		console.warn("[segment] segmentForeground failed", err);
		return null;
	}
}
