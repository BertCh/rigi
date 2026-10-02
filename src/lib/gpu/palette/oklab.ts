// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// sRGB8 <-> OKLab (Bjorn Ottosson's matrices), CPU, f64. The WGSL unpack kernel in palette.ts
// repeats the same maths in f32.

export type Oklab = [number, number, number];

/** sRGB electro-optical transfer: encoded 0..1 -> linear light. */
export const srgbToLinear = (encoded: number): number =>
	encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;

/** Inverse of srgbToLinear. */
export const linearToSrgb = (linear: number): number =>
	linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;

const cubeRoot = (value: number) => (value > 0 ? Math.cbrt(value) : 0);

/** Linear sRGB (0..1) -> OKLab. */
export function linearRgbToOklab(
	red: number,
	green: number,
	blue: number,
): Oklab {
	const l = cubeRoot(
		0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue,
	);
	const m = cubeRoot(
		0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue,
	);
	const s = cubeRoot(
		0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue,
	);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

/** OKLab -> linear sRGB (unclamped). */
export function oklabToLinearRgb(
	lightness: number,
	a: number,
	b: number,
): [number, number, number] {
	const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
}

/** sRGB bytes (0..255) -> OKLab. */
export function srgb8ToOklab(red: number, green: number, blue: number): Oklab {
	return linearRgbToOklab(
		srgbToLinear(red / 255),
		srgbToLinear(green / 255),
		srgbToLinear(blue / 255),
	);
}

const toByte = (linear: number) =>
	Math.max(
		0,
		Math.min(
			255,
			Math.round(linearToSrgb(Math.max(0, Math.min(1, linear))) * 255),
		),
	);

/** OKLab -> sRGB bytes (clamped to the gamut cube). */
export function oklabToSrgb8(
	lightness: number,
	a: number,
	b: number,
): [number, number, number] {
	const [red, green, blue] = oklabToLinearRgb(lightness, a, b);
	return [toByte(red), toByte(green), toByte(blue)];
}

/** Euclidean OKLab distance (Delta E OK). */
export const deltaEOk = (p: ArrayLike<number>, q: ArrayLike<number>): number =>
	Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
