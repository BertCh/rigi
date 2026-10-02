// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import GROUND_PALETTES from "./ground-palette.json";

// The explainer grammar's ground half (reports/gipfelbuch-explainers-2026-10-02/grammar.md §3): a
// figure's ground takes its cue from its own photo. `scripts/gipfelbuch/bake-ground.ts` measures each
// demo photo once (sky above the eye's skyline, terrain below it, a band around it) into
// `ground-palette.json`; the pure functions here turn that into `--fig-*` CSS custom properties, every
// ink held to a contrast floor on its ground. Photos are never filtered: only the ground around them
// moves. No CSS or React imports, so node checks can load it.

export interface GroundPalette {
	/** Median of the photo's pixels above the skyline. */
	sky: string;
	/** Median below it. */
	terrain: string;
	/** Median of a band around it. */
	horizon: string;
	/** Relative luminance (WCAG) of each. */
	skyL: number;
	terrainL: number;
	horizonL: number;
}

/** Light paper (the sheet), or an always-dark plate (a `data-theme="dark"` island). */
export type GroundSurface = "paper" | "plate-dark";

/** The custom properties a Figure sets. Read each with its fallback: `var(--fig-wash, var(--gb-paper-deep))`. */
export type GroundVar =
	| "--fig-wash"
	| "--fig-sky-ink"
	| "--fig-terrain-ink"
	| "--fig-horizon-ink"
	| "--fig-halo";

/** Hex stand-ins for the sheet tokens (swiss/theme.css computes them with color-mix). */
export const GROUND_BASE = {
	/** --gb-paper: W 96 % + YY 4 %. */
	paper: "#f4f3f0",
	/** --gb-paper-deep: paper 91 % + LG 9 %. */
	paperDeep: "#efede8",
	/** The dark plate's ground (LK). */
	plate: "#131313",
	ink: "#131313",
	navy: "#002f55",
	contour: "#95500c",
	/** Ink on a dark plate (the site's paper). */
	plateInk: "#ece6da",
} as const;

/** Contrast floors (WCAG ratios): line art 3:1, text-bearing ink 4.5:1. */
export const GROUND_CONTRAST = { line: 3, text: 4.5 } as const;

type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
	let h = hex.trim().replace(/^#/, "");
	if (h.length === 3)
		h = h
			.split("")
			.map((c) => c + c)
			.join("");
	const n = Number.parseInt(h.slice(0, 6), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: readonly number[]): string {
	const c = (v: number) =>
		Math.round(Math.min(255, Math.max(0, v)))
			.toString(16)
			.padStart(2, "0");
	return `#${c(r)}${c(g)}${c(b)}`;
}

/** `a` mixed toward `b` by t (0 = a, 1 = b), in sRGB as CSS color-mix(in srgb) does. */
export function mixHex(a: string, b: string, t: number): string {
	const p = hexToRgb(a);
	const q = hexToRgb(b);
	return rgbToHex(p.map((v, i) => v + (q[i] - v) * t));
}

/** WCAG relative luminance, 0..1. */
export function relativeLuminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex).map((v) => {
		const s = v / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * `ink`, darkened or lightened (toward black or white, whichever side of `ground` it is on) just enough
 * to reach `min` contrast on `ground`. An ink that already passes comes back unchanged.
 */
export function ensureContrast(
	ink: string,
	ground: string,
	min: number,
): string {
	if (contrastRatio(ink, ground) >= min) return rgbToHex(hexToRgb(ink));
	const target = relativeLuminance(ground) > 0.18 ? "#000000" : "#ffffff";
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 24; i++) {
		const mid = (lo + hi) / 2;
		if (contrastRatio(mixHex(ink, target, mid), ground) >= min) hi = mid;
		else lo = mid;
	}
	return mixHex(ink, target, hi);
}

/** `hex` with its chroma cut to `keep` (0 = its grey, 1 = itself). */
export function desaturate(hex: string, keep: number): string {
	const [r, g, b] = hexToRgb(hex);
	const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return rgbToHex([r, g, b].map((v) => y + (v - y) * keep));
}

/** The baked palette of a demo photo ("demo-09"), or undefined. */
export function groundPalette(photoId: string): GroundPalette | undefined {
	return (GROUND_PALETTES as Record<string, GroundPalette>)[photoId];
}

/**
 * The `--fig-*` values for a photo's palette on a surface. Paper: the wash is the paper-deep ground 6 %
 * toward the photo's sky (chroma halved), the sky ink is navy a quarter toward the sky hue, the terrain
 * ink is contour brown 30 % toward the terrain; dark plate: the plate 10 % toward the terrain, inks
 * lightened from the photo's own tones. Line inks hold 3:1 on the wash, the horizon ink 4.5:1. The halo
 * behind photo-ink lines is dark over a bright horizon band, light over a dark one. Unknown photo: {}.
 */
export function groundVars(
	source: string | GroundPalette | undefined,
	surface: GroundSurface = "paper",
): Partial<Record<GroundVar, string>> {
	const p = typeof source === "string" ? groundPalette(source) : source;
	if (!p) return {};
	const halo = p.horizonL > 0.35 ? GROUND_BASE.ink : GROUND_BASE.paper;
	if (surface === "plate-dark") {
		const wash = mixHex(GROUND_BASE.plate, desaturate(p.terrain, 0.6), 0.1);
		return {
			"--fig-wash": wash,
			"--fig-sky-ink": ensureContrast(
				mixHex(p.sky, GROUND_BASE.plateInk, 0.35),
				wash,
				GROUND_CONTRAST.line,
			),
			"--fig-terrain-ink": ensureContrast(
				mixHex(p.terrain, GROUND_BASE.plateInk, 0.5),
				wash,
				GROUND_CONTRAST.line,
			),
			"--fig-horizon-ink": ensureContrast(
				mixHex(p.horizon, GROUND_BASE.plateInk, 0.6),
				wash,
				GROUND_CONTRAST.text,
			),
			"--fig-halo": halo,
		};
	}
	const wash = mixHex(GROUND_BASE.paperDeep, desaturate(p.sky, 0.5), 0.06);
	return {
		"--fig-wash": wash,
		"--fig-sky-ink": ensureContrast(
			mixHex(GROUND_BASE.navy, p.sky, 0.25),
			wash,
			GROUND_CONTRAST.line,
		),
		"--fig-terrain-ink": ensureContrast(
			mixHex(GROUND_BASE.contour, p.terrain, 0.3),
			wash,
			GROUND_CONTRAST.line,
		),
		"--fig-horizon-ink": ensureContrast(
			mixHex(GROUND_BASE.ink, p.horizon, 0.3),
			wash,
			GROUND_CONTRAST.text,
		),
		"--fig-halo": halo,
	};
}

/**
 * Medians of an RGB image above the skyline (sky), below it (terrain) and within `band` × height of it
 * (horizon). `rows[x]` is the skyline's row at column x in the image's px (null: no skyline there);
 * `rgb` is row-major, 3 bytes a pixel. Columns and rows are sampled every `step` px. Used by the bake.
 */
export function measurePalette(
	rgb: ArrayLike<number>,
	width: number,
	height: number,
	rows: readonly (number | null)[],
	{ band = 0.02, step = 2 }: { band?: number; step?: number } = {},
): GroundPalette | null {
	const half = band * height;
	const sky: number[][] = [[], [], []];
	const terrain: number[][] = [[], [], []];
	const horizon: number[][] = [[], [], []];
	const scale = rows.length / width;
	for (let x = 0; x < width; x += step) {
		const row = rows[Math.min(rows.length - 1, Math.floor(x * scale))];
		if (row == null) continue;
		const y0 = row / scale;
		for (let y = 0; y < height; y += step) {
			const into = y < y0 - half ? sky : y > y0 + half ? terrain : horizon;
			const i = (y * width + x) * 3;
			into[0].push(rgb[i]);
			into[1].push(rgb[i + 1]);
			into[2].push(rgb[i + 2]);
		}
	}
	if (!sky[0].length || !terrain[0].length || !horizon[0].length) return null;
	const median = (v: number[]) => {
		const s = [...v].sort((a, b) => a - b);
		return s[s.length >> 1];
	};
	const tone = (c: number[][]) => rgbToHex(c.map(median));
	const s = tone(sky);
	const t = tone(terrain);
	const h = tone(horizon);
	const l = (hex: string) => Math.round(relativeLuminance(hex) * 1000) / 1000;
	return {
		sky: s,
		terrain: t,
		horizon: h,
		skyL: l(s),
		terrainL: l(t),
		horizonL: l(h),
	};
}
