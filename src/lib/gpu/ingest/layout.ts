// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure layout math of gpu/ingest (no luma runtime): which texture format a typed-array raster
// uploads as, byte sizes, and the WebGPU copy alignment rules the upload and copy nodes rely on.
// Node-checked by ingest.check.ts.

/** Raster texture formats uploadRaster writes (one entry per typed array kind × band count). */
export type RasterFormat =
	| "r8unorm"
	| "rg8unorm"
	| "rgba8unorm"
	| "r8uint"
	| "rgba8uint"
	| "r16uint"
	| "r16sint"
	| "r32float"
	| "rg32float"
	| "rgba32float"
	| "r32uint"
	| "r32sint";

/** Bitmap destination formats (copyExternalImageToTexture). */
export type BitmapFormat = "rgba8unorm" | "rgba8unorm-srgb";

/** Typed arrays uploadRaster takes (the element type picks the texel type). */
export type RasterArray =
	| Uint8Array
	| Uint8ClampedArray
	| Uint16Array
	| Int16Array
	| Uint32Array
	| Int32Array
	| Float32Array;

export type RasterBands = 1 | 2 | 4;

const KIND: Record<string, Partial<Record<RasterBands, RasterFormat>>> = {
	// normalised by default: Uint8 bytes are usually image data (masks, RGBA); pass `integer: true`
	// for r8uint / rgba8uint
	Uint8Array: { 1: "r8unorm", 2: "rg8unorm", 4: "rgba8unorm" },
	Uint8ClampedArray: { 1: "r8unorm", 2: "rg8unorm", 4: "rgba8unorm" },
	Uint16Array: { 1: "r16uint" },
	Int16Array: { 1: "r16sint" },
	Uint32Array: { 1: "r32uint" },
	Int32Array: { 1: "r32sint" },
	Float32Array: { 1: "r32float", 2: "rg32float", 4: "rgba32float" },
};

const INTEGER_U8: Partial<Record<RasterBands, RasterFormat>> = {
	1: "r8uint",
	4: "rgba8uint",
};

/** The texture format of a `bands`-band raster held in `data` (throws when there is none). */
export function rasterFormatOf(
	data: RasterArray,
	bands: RasterBands = 1,
	integer = false,
): RasterFormat {
	const name = data.constructor.name;
	const table =
		integer && (name === "Uint8Array" || name === "Uint8ClampedArray")
			? INTEGER_U8
			: KIND[name];
	const format = table?.[bands];
	if (!format)
		throw new Error(
			`gpu/ingest: no texture format for ${bands}-band ${name}${integer ? " (integer)" : ""}`,
		);
	return format;
}

const BYTES: Record<RasterFormat | BitmapFormat, number> = {
	r8unorm: 1,
	r8uint: 1,
	rg8unorm: 2,
	rgba8unorm: 4,
	"rgba8unorm-srgb": 4,
	rgba8uint: 4,
	r16uint: 2,
	r16sint: 2,
	r32float: 4,
	r32uint: 4,
	r32sint: 4,
	rg32float: 8,
	rgba32float: 16,
};

/** Bytes per texel of an ingest format. */
export const bytesPerTexel = (format: RasterFormat | BitmapFormat) =>
	BYTES[format];

/** Elements a `width × height × layers` raster of `bands` bands must hold. */
export const rasterLength = (
	width: number,
	height: number,
	bands: RasterBands = 1,
	layers = 1,
) => width * height * bands * layers;

/** WebGPU's bytesPerRow alignment for buffer ↔ texture copies (copyBufferToTexture / ToBuffer). */
export const COPY_BYTES_PER_ROW_ALIGNMENT = 256;

/** Storage-buffer binding offset alignment (minStorageBufferOffsetAlignment default). */
export const STORAGE_OFFSET_ALIGNMENT = 256;

/** The padded bytesPerRow of a buffer ↔ texture copy of `width` texels. */
export const copyBytesPerRow = (
	width: number,
	format: RasterFormat | BitmapFormat,
) =>
	Math.ceil((width * bytesPerTexel(format)) / COPY_BYTES_PER_ROW_ALIGNMENT) *
	COPY_BYTES_PER_ROW_ALIGNMENT;

/**
 * Whether a tightly packed `width`-texel row is already copy-aligned, i.e. a buffer of
 * `width × height` texels maps 1:1 onto the texture with no row padding (true for every DEM tile
 * size: 256 and 512 px r32float / rgba8 rows are 1024 / 2048 bytes).
 */
export const isCopyAligned = (
	width: number,
	format: RasterFormat | BitmapFormat,
) => (width * bytesPerTexel(format)) % COPY_BYTES_PER_ROW_ALIGNMENT === 0;

/** A buffer upload's byteLength: WebGPU buffers are sized in multiples of 4 bytes. */
export const bufferByteLength = (bytes: number) =>
	Math.max(4, Math.ceil(bytes / 4) * 4);

/** Workgroup counts for an 8 × 8 per-texel kernel over `width × height`. */
export const texelWorkgroups = (
	width: number,
	height: number,
	size = 8,
): [number, number] => [Math.ceil(width / size), Math.ceil(height / size)];
