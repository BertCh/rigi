// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The "swisstopo" label preset: Swiss national-map typography on the photo. Hydrography in blue
// italic, ranges and regions in letter-spaced capitals, peaks upright with the elevation in a
// lighter weight, contour numerals brown. The Landeskarte preset (style/presets.ts "swiss") spreads
// SWISSTOPO_LABELS into its labels and picks SWISSTOPO_NAME_TYPO for place names
// (terroir.names.typography "swisstopo"); CLASSIC references neither, so classic output is untouched.
//
// Fonts: only faces self-hosted in public/fonts/gipfelbuch are used (src/components/gipfelbuch/swiss/
// fonts.css, family "GB Sans"): upright 300 / 400 / 500 / 600 and italic 400. There is no 700 and
// no italic 500 or 600, so the major peak is set in 600 at a larger size and hydrography in italic
// 400. SWISSTOPO_FONT_NEEDS lists what a fonts stream could add for a closer match.
import type { DeepPartial, LabelStyle } from "../../style/types";
import type { NameTypography } from "../classes";
import type { NameClass } from "../types";

/** GB Sans first (self-hosted Fira Sans), then the app face, so an unloaded face degrades quietly. */
export const SWISSTOPO_FONT_FAMILY =
	'"GB Sans", "Fira Sans", system-ui, sans-serif';

/** Faces the preset would take if self-hosted (none is required). */
export const SWISSTOPO_FONT_NEEDS = [
	"Fira Sans normal 700 (major peaks)",
	"Fira Sans italic 500 (hydrography)",
] as const;

/** Hydrography blue, light enough to read on a photographed sky and water. */
export const SWISSTOPO_WATER = "#9fd0ee";
/** Land names: peaks, places. */
export const SWISSTOPO_INK = "#ffffff";
/** Ranges, regions, relief names (warm off-white, as on the sheet's grey relief type). */
export const SWISSTOPO_RELIEF = "#efe6d6";
/**
 * Contour numerals: Brezine "Light Yellowish Brown" (YB #bb8b54) lifted to a light tan. YB itself is
 * too dark to read over a photo under the dark label halo.
 */
export const SWISSTOPO_CONTOUR_NUMERAL = "#ecd3ad";

const typo = (
	size: number,
	weight: number,
	over: Partial<NameTypography> & Pick<NameTypography, "color" | "priority">,
): NameTypography => ({
	size,
	weight,
	italic: false,
	tracking: 0,
	upper: false,
	nearReachM: Infinity,
	...over,
});

/** Per-class typography; same shape as NAME_TYPO, so it can replace it where a caller takes a table. */
export const SWISSTOPO_NAME_TYPO: Record<NameClass, NameTypography> = {
	"peak-major": typo(1.22, 600, {
		color: SWISSTOPO_INK,
		priority: 100,
	}),
	peak: typo(1.0, 600, { color: SWISSTOPO_INK, priority: 80 }),
	"peak-minor": typo(0.86, 500, {
		color: SWISSTOPO_INK,
		nearReachM: 15000,
		priority: 50,
	}),
	massif: typo(0.95, 500, {
		tracking: 0.3,
		upper: true,
		color: SWISSTOPO_RELIEF,
		priority: 70,
	}),
	region: typo(0.9, 400, {
		tracking: 0.34,
		upper: true,
		color: SWISSTOPO_RELIEF,
		priority: 45,
	}),
	ridge: typo(0.82, 400, {
		tracking: 0.24,
		upper: true,
		color: SWISSTOPO_RELIEF,
		nearReachM: 20000,
		priority: 40,
	}),
	valley: typo(0.86, 400, {
		tracking: 0.2,
		upper: true,
		color: SWISSTOPO_RELIEF,
		nearReachM: 25000,
		priority: 42,
	}),
	pass: typo(0.86, 400, {
		color: SWISSTOPO_INK,
		nearReachM: 25000,
		priority: 55,
	}),
	glacier: typo(0.9, 400, {
		italic: true,
		tracking: 0.1,
		color: SWISSTOPO_WATER,
		priority: 65,
	}),
	lake: typo(1.05, 400, {
		italic: true,
		tracking: 0.06,
		color: SWISSTOPO_WATER,
		priority: 90,
	}),
	river: typo(0.82, 400, {
		italic: true,
		tracking: 0.08,
		color: SWISSTOPO_WATER,
		nearReachM: 15000,
		priority: 35,
	}),
	waterfall: typo(0.78, 400, {
		italic: true,
		color: SWISSTOPO_WATER,
		nearReachM: 6000,
		priority: 25,
	}),
	city: typo(1.05, 600, {
		tracking: 0.02,
		color: SWISSTOPO_INK,
		priority: 85,
	}),
	town: typo(0.95, 500, {
		color: SWISSTOPO_INK,
		nearReachM: 40000,
		priority: 60,
	}),
	village: typo(0.86, 400, {
		color: SWISSTOPO_INK,
		nearReachM: 20000,
		priority: 48,
	}),
	hamlet: typo(0.78, 400, {
		color: SWISSTOPO_INK,
		nearReachM: 6000,
		priority: 20,
	}),
	alp: typo(0.78, 400, {
		italic: true,
		color: SWISSTOPO_RELIEF,
		nearReachM: 6000,
		priority: 22,
	}),
	hut: typo(0.78, 500, {
		color: SWISSTOPO_INK,
		nearReachM: 12000,
		priority: 30,
	}),
	field: typo(0.74, 400, {
		italic: true,
		color: SWISSTOPO_RELIEF,
		nearReachM: 3000,
		priority: 10,
	}),
	lift: typo(0.74, 400, {
		color: SWISSTOPO_RELIEF,
		nearReachM: 5000,
		priority: 12,
	}),
	other: typo(0.74, 400, {
		color: SWISSTOPO_RELIEF,
		nearReachM: 3000,
		priority: 5,
	}),
};

/**
 * The labels half of a ViewStyle override (a DeepPartial<LabelStyle>): upright peak names in 600,
 * the elevation line in weight 400 at 11 px, in the light contour-numeral tan. Apply it
 * with the style overrides; it is not part of any default.
 */
export const SWISSTOPO_LABELS: DeepPartial<LabelStyle> = {
	fontFamily: SWISSTOPO_FONT_FAMILY,
	name: { px: 12, weight: 600, color: SWISSTOPO_INK },
	sub: { px: 11, weight: 400, color: SWISSTOPO_CONTOUR_NUMERAL, show: "ele" },
	halo: {
		kind: "shadow",
		color: [0, 0, 0, 0.85],
		blurPx: 3,
		offsetY: 1,
		strokePx: 0,
		adaptive: 1,
	},
};
