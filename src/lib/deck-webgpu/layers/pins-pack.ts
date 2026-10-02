// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU half of layers/pins.ts: the instance record of one roll-map selection pin. Pure (no GPU), so
// the spec and the node check can read it.
import type { RollPin } from "#/lib/roll/map/backend";

/** One instance: position f32×3, (radiusPx, lineWidthPx) f32×2, fill rgba8 (sRGB), line rgba8. */
export const PIN_STRIDE_BYTES = 28;
const PIN_FLOATS = PIN_STRIDE_BYTES / 4;

const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** 0..255 RGBA → one little-endian u32 (r in the low byte), as unorm8x4 reads it. */
export function packRGBA8(c: readonly number[]): number {
	return (
		(byte(c[0]) |
			(byte(c[1]) << 8) |
			(byte(c[2]) << 16) |
			(byte(c[3] ?? 255) << 24)) >>>
		0
	);
}

/** Instance data for `pins`: PIN_STRIDE_BYTES each, in array order. */
export function packPins(pins: readonly RollPin[]): ArrayBuffer {
	const buffer = new ArrayBuffer(Math.max(1, pins.length) * PIN_STRIDE_BYTES);
	const f32 = new Float32Array(buffer);
	const u32 = new Uint32Array(buffer);
	pins.forEach((p, i) => {
		const o = i * PIN_FLOATS;
		f32[o] = p.position[0];
		f32[o + 1] = p.position[1];
		f32[o + 2] = p.position[2];
		f32[o + 3] = p.radiusPx;
		f32[o + 4] = p.lineWidthPx;
		u32[o + 5] = packRGBA8(p.fill);
		u32[o + 6] = packRGBA8(p.line);
	});
	return buffer;
}
