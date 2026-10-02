// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The exact sRGB transfer curves (IEC 61966-2-1), scalar, 0..1. One CPU copy; the shader twins are
// look/glsl/common.ts (SRGB_DECODE_GLSL, SRGB_ENCODE_GLSL) and deck-webgpu/wgsl.ts (colorWGSL).

/** sRGB EOTF: encoded 0..1 -> linear light. */
export function srgbToLinear(encoded: number): number {
	return encoded <= 0.04045
		? encoded / 12.92
		: ((encoded + 0.055) / 1.055) ** 2.4;
}

/** Inverse of srgbToLinear (the OETF): linear light -> encoded 0..1. */
export function linearToSrgb(linear: number): number {
	return linear <= 0.0031308
		? linear * 12.92
		: 1.055 * linear ** (1 / 2.4) - 0.055;
}
