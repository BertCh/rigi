// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Texture helpers shared by the layer ports: the photo (sRGB, mipmapped), byte masks (people,
// brush, sky), float fields. One place for formats / usages so every port samples the same way.
import { type Device, Texture } from "@luma.gl/core";

const LINEAR_CLAMP = {
	minFilter: "linear",
	magFilter: "linear",
	mipmapFilter: "linear",
	addressModeU: "clamp-to-edge",
	addressModeV: "clamp-to-edge",
} as const;

/**
 * An image (photo, drape, sprite) as rgba8unorm-srgb with a full mip chain: samples come back
 * LINEAR (hardware decode), filtering is gamma-correct. Rows top → bottom (uv v down).
 *
 * NEVER call this with mips (the default) from inside a GpuLayerCore.draw(), i.e. while a render
 * pass is open: luma's generateMipmapsWebGPU encodes its own render passes and submits,
 * which invalidates the open pass ("CommandEncoder locked while RenderPassEncoder … is open" /
 * "Parent encoder already finished"). Upload in a setter outside the frame, or draw one frame
 * with `mips: false` and swap the mipmapped texture in afterwards (layers/tiles3d.ts flushMips).
 */
export function imageTexture(
	device: Device,
	image: ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas,
	opts: { id?: string; mips?: boolean } = {},
): Texture {
	// HTMLImageElement.width is the layout size when the element is in the DOM: use the natural size
	const img = image as {
		width: number;
		height: number;
		naturalWidth?: number;
		naturalHeight?: number;
	};
	const width = img.naturalWidth || img.width;
	const height = img.naturalHeight || img.height;
	const mips = opts.mips ?? true;
	const mipLevels = mips ? device.getMipLevelCount(width, height) : 1;
	const tex = device.createTexture({
		id: opts.id ?? "image",
		format: "rgba8unorm-srgb",
		width,
		height,
		mipLevels,
		usage: Texture.SAMPLE | Texture.COPY_DST | Texture.RENDER,
		sampler: { ...LINEAR_CLAMP, maxAnisotropy: mips ? 8 : 1 },
	});
	tex.copyExternalImage({ image: image as never, width, height });
	if (mips) device.generateMipmapsWebGPU(tex);
	return tex;
}

/**
 * The live video photo: rgba8unorm-srgb at the source's size, one mip level, no anisotropy. Allocated
 * once and refilled each frame with copyExternalImage (no mip regeneration per frame).
 */
export function liveTexture(
	device: Device,
	width: number,
	height: number,
): Texture {
	return device.createTexture({
		id: "rigi-photo-live",
		format: "rgba8unorm-srgb",
		width,
		height,
		mipLevels: 1,
		usage: Texture.SAMPLE | Texture.COPY_DST | Texture.RENDER,
		sampler: { ...LINEAR_CLAMP, mipmapFilter: "nearest", maxAnisotropy: 1 },
	});
}

/** A byte mask (0..255, row 0 = top) as r8unorm, linear-filtered (people / brush / sky masks). */
export function maskTexture(
	device: Device,
	data: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number,
	id = "mask",
): Texture {
	const tex = device.createTexture({
		id,
		format: "r8unorm",
		width,
		height,
		usage: Texture.SAMPLE | Texture.COPY_DST,
		sampler: LINEAR_CLAMP,
	});
	tex.writeData(data as never, { width, height, bytesPerRow: width });
	return tex;
}

/** A float field (r32float, e.g. relief / range maps). Sample with textureLoad (unfilterable
 * unless the device has float32-filterable). */
export function floatTexture(
	device: Device,
	data: Float32Array,
	width: number,
	height: number,
	id = "field",
): Texture {
	const tex = device.createTexture({
		id,
		format: "r32float",
		width,
		height,
		usage: Texture.SAMPLE | Texture.COPY_DST,
		sampler: {
			...LINEAR_CLAMP,
			minFilter: "nearest",
			magFilter: "nearest",
			mipmapFilter: "nearest",
		},
	});
	tex.writeData(data as never, { width, height, bytesPerRow: width * 4 });
	return tex;
}

/** 1×1 placeholders so pipelines always have something bound. */
export function placeholderTextures(device: Device) {
	const white = device.createTexture({
		id: "white",
		format: "rgba8unorm-srgb",
		width: 1,
		height: 1,
		usage: Texture.SAMPLE | Texture.COPY_DST,
	});
	white.writeData(new Uint8Array([255, 255, 255, 255]) as never, {
		width: 1,
		height: 1,
	});
	const zeroMask = device.createTexture({
		id: "mask0",
		format: "r8unorm",
		width: 1,
		height: 1,
		usage: Texture.SAMPLE | Texture.COPY_DST,
	});
	zeroMask.writeData(new Uint8Array([0, 0, 0, 0]) as never, {
		width: 1,
		height: 1,
		bytesPerRow: 1,
	});
	return { white, zeroMask };
}
