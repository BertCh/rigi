// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The cartographic palette: one named source for every map colour that more than one place uses
// (presets, terroir inks, hatching, the engines' world sky, the Alpine tint shaders). Consumers
// import a token; they never re-type the literal. Report: reports/swiss-cartography-review.md §3.4.
//
// Provenance of each token, in its doc comment:
//   classic   the pre-style hard-coded look; CLASSIC must stay pixel-identical, so never retune it
//   rigi      tuned in this repo (presets, terroir); retune here and every consumer follows
// Swiss references (swisstopo basemap style.json, Landeskarte sheets) are recorded in the report;
// none of these values is an official swisstopo ink.
//
// Colour spaces: '#rrggbb' hex is display sRGB. Float triples say which space they are in: the
// composite ink tuples are LINEAR (they go to the shaders as is), the Alpine tint is sRGB that the
// shaders raise to 2.2.

/** An exact float triple (presets keep floats where hex rounding would move pixels). */
export type Rgb = [number, number, number];

// ---- contours and line ink ------------------------------------------------------------------

/**
 * Swiss-map contour brown over relief and photo (rigi): minor lines and the 100 m index lines.
 * Shared by the Landeskarte, Terroir and Field sketch presets. The paper sheets of the Gipfelbuch
 * and the landeskarte example use Brezine NB #95500c instead (open decision, see the report).
 */
export const CONTOUR_BROWN = { minor: "#b98a5e", major: "#8a5a32" } as const;

/**
 * Line ink by ground cover (rigi): soil takes the index brown, rock a warm black-grey, ice and water
 * a glacier blue. terroir.contours.inkByCover (terroir/classes.ts CONTOUR_INK) and the Landeskarte
 * hachures (terroir/hatch-lk.ts HATCH_LK_INK) both read these.
 */
export const COVER_INK = {
	soil: CONTOUR_BROWN.major,
	rock: "#2b2724",
	ice: "#3f7fb3",
} as const satisfies Record<string, `#${string}`>;

/** Warm sepia ridge, skyline and crease ink (rigi, LINEAR): Landeskarte, Terroir, Field sketch. */
export const WARM_INK: { inner: Rgb; skyline: Rgb } = {
	inner: [0.16, 0.11, 0.07],
	skyline: [0.1, 0.07, 0.05],
};

/** Berann's blue-black ridge ink (rigi, LINEAR). */
export const BERANN_INK: { inner: Rgb; skyline: Rgb } = {
	inner: [0.1, 0.12, 0.22],
	skyline: [0.08, 0.1, 0.2],
};

/** Near-black pen ink (rigi, LINEAR, from the former studio): Topo ink. */
export const DARK_INK: Rgb = [0.02, 0.025, 0.04];

/** Dark brown contour casing under Terroir's contours (rigi, LINEAR). */
export const CONTOUR_CASING_BROWN: Rgb = [0.12, 0.08, 0.04];

// ---- paper and sky --------------------------------------------------------------------------

/** Warm paper of the Topo map preset (rigi): contour casing, imagery tint and map sky. */
export const TOPO_PAPER = "#f4ecd8";

/** Flat world-view sky behind the terrain (classic): style.world.sky.background. */
export const WORLD_SKY = "#a9c2da";
/** The world view's clear colour (classic): style.world.sky.clear. */
export const WORLD_CLEAR = "#9fb8d0";
/** Grey-blue aerial haze (classic): style.terrain.hazeColor. */
export const CLASSIC_HAZE = "#b9cde0";

// ---- Alpine natural tint (LOOK_ALPINE) ------------------------------------------------------

/**
 * Patterson-style natural tint keyed to absolute Alpine elevations (rigi, sRGB). One source for the
 * GLSL (look/glsl/ramps.ts alpineBase), the WGSL (deck-webgpu terrain-styles ts_alpine_base) and the
 * 'patterson' ramp. Each belt colour holds from `from` and blends to the next one over [from, to] m.
 */
export const ALPINE_TINT = {
	belts: [
		{ name: "valley floor, pale green", c: [0.56, 0.66, 0.45] as Rgb },
		{ name: "mixed forest", c: [0.4, 0.53, 0.34] as Rgb },
		{ name: "conifer belt", c: [0.35, 0.47, 0.31] as Rgb },
		{ name: "alpine meadow above the treeline", c: [0.6, 0.65, 0.42] as Rgb },
		{ name: "rockline, tan scree", c: [0.64, 0.62, 0.52] as Rgb },
		{ name: "high rock, cool grey", c: [0.64, 0.64, 0.63] as Rgb },
	],
	/** belt i → i+1: [segment end (the `h <` test), blend start, blend end] in m */
	steps: [
		[900, 400, 900],
		[1500, 900, 1500],
		[2050, 1650, 2050],
		[2450, 2050, 2450],
	] as const,
	/** the last blend, above the final step */
	top: [2450, 2950] as const,
	/** steep-slope rock: low rock mixed to high grey between 1500 and 3000 m */
	rockLow: [0.54, 0.52, 0.48] as Rgb,
	rockHigh: 0.6,
	snow: [0.95, 0.97, 1.0] as Rgb,
	/** flat DEM lakes (LOOK_WATER, when on, paints them instead) */
	lake: [0.33, 0.5, 0.6] as Rgb,
} as const;

/** A float as a GLSL / WGSL literal: always with a decimal point, never an exponent. */
export function shaderFloat(x: number): string {
	const s = String(x);
	return /[.e]/.test(s) ? s : `${s}.0`;
}

/** The alpineBase(h) body over ALPINE_TINT for either shading language (`srgb` = the 2.2 helper). */
export function alpineBaseBody(
	lang: "glsl" | "wgsl",
	srgb: string,
	indent = "  ",
): string {
	const v3 = lang === "glsl" ? "vec3" : "vec3<f32>";
	const decl = (i: number) => {
		const c = ALPINE_TINT.belts[i].c.map(shaderFloat).join(", ");
		return lang === "glsl"
			? `${indent}vec3 c${i} = ${srgb}(${v3}(${c})); // ${ALPINE_TINT.belts[i].name}`
			: `${indent}let c${i} = ${srgb}(${v3}(${c}));`;
	};
	const ret = (i: number, a: number, b: number) =>
		`return mix(c${i}, c${i + 1}, smoothstep(${shaderFloat(a)}, ${shaderFloat(b)}, h));`;
	const lines = ALPINE_TINT.belts.map((_, i) => decl(i));
	ALPINE_TINT.steps.forEach(([end, a, b], i) => {
		lines.push(
			lang === "glsl"
				? `${indent}if (h < ${shaderFloat(end)}) ${ret(i, a, b)}`
				: `${indent}if (h < ${shaderFloat(end)}) { ${ret(i, a, b)} }`,
		);
	});
	const last = ALPINE_TINT.steps.length;
	lines.push(`${indent}${ret(last, ...ALPINE_TINT.top)}`);
	return lines.join("\n");
}

/** '#rrggbb' → [r, g, b] bytes. */
export function hexToBytes(hex: `#${string}`): Rgb {
	const n = Number.parseInt(hex.slice(1, 7), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
