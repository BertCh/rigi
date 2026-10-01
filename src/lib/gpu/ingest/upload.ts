// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// gpu/ingest adapters (WAG W2.2, adapter half): loader outputs → resident luma resources, returned
// as Resource refs that a core ComputeGraph imports (importTextureResource / importBufferResource →
// GraphTextureHandle / GraphBufferHandle, bound by id at run()).
//
//   const tex = uploadBitmap(device, bmp, { id: "dem-tile" });        // ImageBitmap → rgba8unorm
//   const h = uploadRaster(device, heights, { width: 512, height: 512 }); // Float32Array → r32float
//   const buf = uploadAttributes(device, positions, { id: "pos" });      // typed array → Buffer
//   const input = importTextureResource(graph, tex);                     // → graph texture handle
//   await graph.run(p, { textures: { [tex.id]: tex.texture } });
//
// Rules:
// - Bytes go in unchanged. uploadBitmap copies with copyExternalImageToTexture into a NON-srgb
//   rgba8unorm texture by default, premultipliedAlpha false, no flip: decode the bitmap with
//   createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" }) as
//   dem/image.ts does. Whether those texel bytes equal the canvas getImageData bytes the CPU path
//   decodes is measured by scripts/gpu/terrarium-ingest-check.mjs, not assumed.
// - `into` writes a layer / range of an existing texture or buffer (the later TextureArrayAtlas);
//   otherwise a new resource is created and the ref owns it (releaseResource destroys it).
// - WebGPU only for graph use (ComputeGraph is WebGPU-only); the uploads themselves are plain luma
//   calls and work on any device. Nothing here is wired into the renderers yet.
import { Buffer, type Device, Texture } from "@luma.gl/core";
import type { ComputeGraph } from "../core/graph";
import type {
	GraphBufferHandle,
	GraphTextureDescriptor,
	GraphTextureHandle,
} from "../core/luma";
import {
	type BitmapFormat,
	bufferByteLength,
	bytesPerTexel,
	type RasterArray,
	type RasterBands,
	type RasterFormat,
	rasterFormatOf,
	rasterLength,
} from "./layout";

/** A resident texture plus the graph descriptor that imports it (must match it exactly). */
export type TextureResource = {
	kind: "texture";
	/** graph resource id (importTextureResource's handle id; run({ textures: { [id]: texture } })) */
	id: string;
	texture: Texture;
	descriptor: GraphTextureDescriptor;
	/** the array layer written (0 for a 2-D texture) */
	layer: number;
	/** bytes written by this upload */
	byteLength: number;
	/** whether releaseResource destroys the texture (false for `into` targets) */
	owned: boolean;
};

/** A resident buffer (or a range of one) a graph imports. */
export type BufferResource = {
	kind: "buffer";
	id: string;
	buffer: Buffer;
	/** byte offset of the data in `buffer` */
	byteOffset: number;
	/** bytes of data (unpadded) */
	byteLength: number;
	owned: boolean;
};

export type IngestResource = TextureResource | BufferResource;

/** Texture usage of ingest textures: sampled by nodes, copy source / destination for atlases. */
export const INGEST_TEXTURE_USAGE =
	Texture.SAMPLE | Texture.COPY_DST | Texture.COPY_SRC;
/** copyExternalImageToTexture also requires RENDER_ATTACHMENT on the destination. */
export const BITMAP_TEXTURE_USAGE = INGEST_TEXTURE_USAGE | Texture.RENDER;
/** Default buffer usage: storage for compute nodes, vertex for render passes, copies both ways. */
export const INGEST_BUFFER_USAGE =
	Buffer.STORAGE | Buffer.VERTEX | Buffer.COPY_DST | Buffer.COPY_SRC;

/** An existing texture layer to write into (instead of creating a texture). */
export type TextureTarget = { texture: Texture; layer?: number };

/** The exact graph descriptor of `texture` (GPUCommandGraph checks imports against it). */
export function textureDescriptor(
	id: string,
	texture: Texture,
): GraphTextureDescriptor {
	return {
		id,
		format: texture.format,
		width: texture.width,
		height: texture.height,
		usage: texture.props.usage ?? 0,
		dimension: texture.dimension,
		depth: texture.depth,
		mipLevels: texture.mipLevels,
		samples: texture.samples,
	};
}

/**
 * A typed-array raster (`bands` interleaved bands, row 0 first) → texture, via queue.writeTexture
 * (luma Texture.writeData; no row alignment needed). Format from the element type (layout.ts
 * rasterFormatOf) unless given. Heights: Float32Array → r32float.
 */
export function uploadRaster(
	device: Device,
	data: RasterArray,
	opts: {
		width: number;
		height: number;
		bands?: RasterBands;
		id?: string;
		/** Uint8 data as r8uint / rgba8uint instead of unorm */
		integer?: boolean;
		format?: RasterFormat;
		usage?: number;
		into?: TextureTarget;
	},
): TextureResource {
	const { width, height } = opts;
	const bands = opts.bands ?? 1;
	const format = opts.format ?? rasterFormatOf(data, bands, opts.integer);
	const need = rasterLength(width, height, bands);
	if (data.length < need)
		throw new Error(
			`gpu/ingest uploadRaster: ${data.length} elements < ${width}×${height}×${bands}`,
		);
	const id = opts.id ?? "raster";
	const layer = opts.into?.layer ?? 0;
	const texture =
		opts.into?.texture ??
		device.createTexture({
			id,
			format,
			width,
			height,
			usage: opts.usage ?? INGEST_TEXTURE_USAGE,
		});
	if (texture.format !== format)
		throw new Error(
			`gpu/ingest uploadRaster: target is ${texture.format}, data is ${format}`,
		);
	const bytesPerRow = width * bytesPerTexel(format);
	texture.writeData(data as never, {
		x: 0,
		y: 0,
		z: layer,
		width,
		height,
		depthOrArrayLayers: 1,
		bytesPerRow,
		rowsPerImage: height,
	});
	return {
		kind: "texture",
		id,
		texture,
		descriptor: textureDescriptor(id, texture),
		layer,
		byteLength: bytesPerRow * height,
		owned: !opts.into,
	};
}

/**
 * An ImageBitmap → rgba8unorm (default) or rgba8unorm-srgb texture with copyExternalImageToTexture:
 * no colour-space conversion beyond what the bitmap was decoded with, premultipliedAlpha false,
 * no flip (row 0 = the image's top row). Decode terrain-RGB bitmaps with
 * `{ colorSpaceConversion: "none", premultiplyAlpha: "none" }`.
 */
export function uploadBitmap(
	device: Device,
	bitmap: ImageBitmap,
	opts: {
		id?: string;
		format?: BitmapFormat;
		usage?: number;
		into?: TextureTarget;
	} = {},
): TextureResource {
	const { width, height } = bitmap;
	const format = opts.format ?? "rgba8unorm";
	const id = opts.id ?? "bitmap";
	const layer = opts.into?.layer ?? 0;
	const texture =
		opts.into?.texture ??
		device.createTexture({
			id,
			format,
			width,
			height,
			usage: opts.usage ?? BITMAP_TEXTURE_USAGE,
		});
	if (texture.format !== format)
		throw new Error(
			`gpu/ingest uploadBitmap: target is ${texture.format}, wanted ${format}`,
		);
	texture.copyExternalImage({
		image: bitmap,
		width,
		height,
		z: layer,
		premultipliedAlpha: false,
		flipY: false,
	});
	return {
		kind: "texture",
		id,
		texture,
		descriptor: textureDescriptor(id, texture),
		layer,
		byteLength: width * height * 4,
		owned: !opts.into,
	};
}

/**
 * A typed array → GPU buffer (padded to 4 bytes), or written into an existing buffer at
 * `into.byteOffset` (a multiple of 4; 256 if a node binds the range as storage).
 */
export function uploadAttributes(
	device: Device,
	data: ArrayBufferView,
	opts: {
		id?: string;
		usage?: number;
		into?: { buffer: Buffer; byteOffset?: number };
	} = {},
): BufferResource {
	const id = opts.id ?? "attributes";
	const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	const padded =
		bytes.byteLength % 4
			? new Uint8Array(bufferByteLength(bytes.length))
			: bytes;
	if (padded !== bytes) padded.set(bytes);
	if (opts.into) {
		const byteOffset = opts.into.byteOffset ?? 0;
		if (byteOffset % 4)
			throw new Error(
				`gpu/ingest uploadAttributes: offset ${byteOffset} is not 4-byte aligned`,
			);
		if (byteOffset + padded.byteLength > opts.into.buffer.byteLength)
			throw new Error(
				`gpu/ingest uploadAttributes: ${padded.byteLength} B at ${byteOffset} overflows ${opts.into.buffer.byteLength} B`,
			);
		opts.into.buffer.write(padded, byteOffset);
		return {
			kind: "buffer",
			id,
			buffer: opts.into.buffer,
			byteOffset,
			byteLength: data.byteLength,
			owned: false,
		};
	}
	const buffer = device.createBuffer({
		id,
		usage: opts.usage ?? INGEST_BUFFER_USAGE,
		data: padded,
	});
	return {
		kind: "buffer",
		id,
		buffer,
		byteOffset: 0,
		byteLength: data.byteLength,
		owned: true,
	};
}

/** Import a texture resource into `graph` (default binding: the resource's texture). */
export function importTextureResource<P>(
	graph: ComputeGraph<P>,
	r: TextureResource,
): GraphTextureHandle {
	return graph.importTexture(r.descriptor, r.texture);
}

/**
 * Import a buffer resource into `graph` with its whole buffer as the default binding (byteLength
 * = the buffer's, so a range resource binds through a GraphRange { offset: byteOffset, size }).
 */
export function importBufferResource<P>(
	graph: ComputeGraph<P>,
	r: BufferResource,
): GraphBufferHandle {
	return graph.importBuffer(
		r.id,
		r.buffer.byteLength,
		r.buffer,
		r.buffer.usage,
	);
}

/** Destroy what an upload created (no-op for `into` targets, which belong to the caller). */
export function releaseResource(r: IngestResource) {
	if (!r.owned) return;
	if (r.kind === "texture") r.texture.destroy();
	else r.buffer.destroy();
}
