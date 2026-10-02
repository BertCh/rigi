// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * The whole people-mask pipeline in ONE nn forward (one ComputeGraph submission, one readback): the
 * working-copy texture is resampled + normalised on load (nn.fromTexture), each net gives P(person) at
 * model resolution, bilinear up to the mask size, max over the models, smoothstep(0.3, 0.6), a dilation
 * of radius max(1, round(w/100)) (maxPool2d; the values are >= 0 so zero padding equals the clamped
 * window max) and two radius-1 box blurs (avgPool2d without the padded cells = the clamped-window mean).
 * Output: the 0..255 ByteMask (row 0 = top). GPU only: callers hold the runtime from getNn("people").
 */
import { type Device, Texture } from "@luma.gl/core";
import type { Nn, Tensor } from "#/lib/nn";
import { type PeopleNet, personProbability } from "./people";

/** Long side of the mask (the working copy) in pixels. */
export const MASK_LONG_SIDE = 512;

/** Working size of the mask for an iw x ih image: long side MASK_LONG_SIDE, aspect kept, >= 1 px. */
export function maskSize(iw: number, ih: number): { w: number; h: number } {
	const scale = MASK_LONG_SIDE / Math.max(iw, ih);
	return {
		w: Math.max(1, Math.round(iw * scale)),
		h: Math.max(1, Math.round(ih * scale)),
	};
}

/** Dilation radius (pixels) of the mask grow step. */
export const dilationRadius = (w: number) => Math.max(1, Math.round(w * 0.01));

/** 0..1 floats to bytes, rounded and clamped. */
export function toByteMask(values: ArrayLike<number>): Uint8Array {
	const out = new Uint8Array(values.length);
	for (let i = 0; i < out.length; i++)
		out[i] = Math.min(255, Math.max(0, Math.round(values[i])));
	return out;
}

/**
 * A w x h rgba8unorm texture holding the working copy: from RGBA bytes (node / tests) or an ImageBitmap
 * already at w x h (the browser, copyExternalImage as in gpu/sky/prep.ts). The caller destroys it.
 */
export function createRgbaTexture(
	device: Device,
	source: Uint8Array | Uint8ClampedArray | ImageBitmap,
	w: number,
	h: number,
): Texture {
	if (ArrayBuffer.isView(source)) {
		const bytes = source;
		return device.createTexture({
			id: "people-rgba",
			width: w,
			height: h,
			format: "rgba8unorm",
			usage: Texture.SAMPLE | Texture.COPY_DST,
			data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
		});
	}
	const tex = device.createTexture({
		id: "people-rgba",
		width: w,
		height: h,
		format: "rgba8unorm",
		// copyExternalImage needs COPY_DST | RENDER_ATTACHMENT on the destination
		usage: Texture.SAMPLE | Texture.COPY_DST | Texture.RENDER_ATTACHMENT,
	});
	try {
		tex.copyExternalImage({
			image: source as ImageBitmap,
			width: w,
			height: h,
			flipY: false,
			premultipliedAlpha: false,
			colorSpace: "srgb",
		});
	} catch (e) {
		tex.destroy();
		throw e;
	}
	return tex;
}

/** smoothstep(a, b, p) from clamp / mul ops. */
function smoothstepTensor(nn: Nn, p: Tensor, a: number, b: number): Tensor {
	const t = nn.clamp(nn.mul(nn.sub(p, a), 1 / (b - a)), 0, 1);
	return nn.mul(nn.mul(t, t), nn.sub(3, nn.mul(t, 2)));
}

/**
 * The mask pipeline on a w x h rgba8unorm luma Texture (sampleable), for one or both nets. Returns the
 * ByteMask; the caller owns (and destroys) the texture.
 */
export async function segmentTextureGpu(
	nn: Nn,
	nets: readonly PeopleNet[],
	tex: unknown,
	w: number,
	h: number,
): Promise<{ width: number; height: number; data: Uint8Array }> {
	if (!nn.fromTexture)
		throw new Error("people: the nn runtime has no fromTexture");
	const fromTexture = nn.fromTexture.bind(nn);
	const r = dilationRadius(w);
	const out = await nn.forward(() => {
		let p: Tensor | null = null;
		for (const net of nets) {
			const [, mh, mw] = net.net.inputShape;
			// texel unorm v: (v - m/255) / (s/255) == (byte - m) / s
			const x = nn.permute(
				fromTexture(tex, {
					shape: [1, 3, mh, mw],
					mean: [net.net.mean / 255, net.net.mean / 255, net.net.mean / 255],
					std: [net.net.std / 255, net.net.std / 255, net.net.std / 255],
				}),
				[0, 2, 3, 1],
			);
			const up = nn.interpolate(personProbability(net, x), {
				size: [h, w],
				mode: "bilinear",
				alignCorners: false,
			});
			p = p ? nn.maximum(p, up) : up;
		}
		if (!p) throw new Error("people: no nets");
		let m = nn.maxPool2d(smoothstepTensor(nn, p, 0.3, 0.6), {
			kernel: [2 * r + 1, 2 * r + 1],
			stride: [1, 1],
			padding: [r, r],
		});
		for (let i = 0; i < 2; i++)
			m = nn.avgPool2d(m, {
				kernel: [3, 3],
				stride: [1, 1],
				padding: [1, 1],
				countIncludePad: false,
			});
		return nn.mul(m, 255);
	});
	try {
		const v = await nn.read(out);
		return { width: w, height: h, data: toByteMask(v) };
	} finally {
		nn.dispose(out);
	}
}
