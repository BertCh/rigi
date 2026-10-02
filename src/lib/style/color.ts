// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Colour helpers for style values (no renderer imports).
import { srgbToLinear } from "#/lib/color/srgb";
import type { Hex } from "./types";

const HEX_RE = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function isHex(v: unknown): v is Hex {
	if (typeof v === "string") return HEX_RE.test(v);
	return (
		Array.isArray(v) &&
		(v.length === 3 || v.length === 4) &&
		v.every((x) => typeof x === "number" && Number.isFinite(x))
	);
}

/** sRGB 0..1 rgba. Float tuples pass through exactly (alpha defaults to 1). */
export function hexToRgba01(c: Hex): [number, number, number, number] {
	if (typeof c !== "string")
		return [c[0], c[1], c[2], c.length === 4 ? (c[3] as number) : 1];
	const n = (i: number) => Number.parseInt(c.slice(i, i + 2), 16) / 255;
	return [n(1), n(3), n(5), c.length === 9 ? n(7) : 1];
}

export function hexToRgb01(c: Hex): [number, number, number] {
	const [r, g, b] = hexToRgba01(c);
	return [r, g, b];
}

/** '#rrggbb' (or '#rrggbbaa' when alpha < 1), rounding floats to 8 bits. For UI colour inputs. */
export function toHexString(c: Hex, withAlpha = true): `#${string}` {
	const [r, g, b, a] = hexToRgba01(c);
	const h = (x: number) =>
		Math.round(Math.min(1, Math.max(0, x)) * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${h(r)}${h(g)}${h(b)}${withAlpha && a < 1 ? h(a) : ""}`;
}

/** CSS colour string. Float alphas are kept exactly (e.g. white/75 → rgba(255,255,255,0.75)). */
export function toCss(c: Hex): string {
	const [r, g, b, a] = hexToRgba01(c);
	const q = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);
	return a >= 1
		? `rgb(${q(r)},${q(g)},${q(b)})`
		: `rgba(${q(r)},${q(g)},${q(b)},${+a.toFixed(4)})`;
}

export { srgbToLinear };

/**
 * The hex as linear-sRGB (the haze colour's first linearisation).
 * The terrain shader then applies toLinear (pow 2.2) again to the haze colour: that double
 * linearisation is today's look and is preserved on purpose (styling.md §1.1, §2.3). For docs/tests.
 */
export function hexToLinearHaze(c: Hex): [number, number, number] {
	const [r, g, b] = hexToRgb01(c);
	return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

/** The haze colour as the classic shader finally uses it: pow(hexToLinearHaze, 2.2). */
export function hazeColorAsRendered(c: Hex): [number, number, number] {
	const [r, g, b] = hexToLinearHaze(c);
	return [r ** 2.2, g ** 2.2, b ** 2.2];
}
