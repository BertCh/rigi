// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The Gipfelbuch inks as hex, with no stylesheet import, so node checks (tsx) can load modules
// that draw with them. palette.ts re-exports SWISS together with the theme.

import { BREZINE } from "#/brand/khipu";

const mixHex = (a: string, b: string, t: number): string => {
	const pa = Number.parseInt(a.slice(1), 16);
	const pb = Number.parseInt(b.slice(1), 16);
	const channel = (shift: number) =>
		Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
	return `#${((channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16).padStart(6, "0")}`;
};

/** Role to hex for canvas, SVG attributes and anywhere a CSS var cannot reach. */
export const SWISS = {
	/** page ground: W 96% + YY 4%, a soft warm white (no cream, no grain) */
	paper: mixHex(BREZINE.W.hex, BREZINE.YY.hex, 0.04),
	/** panels and figure wells: paper 91% + LG 9% */
	paperDeep: mixHex(
		mixHex(BREZINE.W.hex, BREZINE.YY.hex, 0.04),
		BREZINE.LG.hex,
		0.09,
	),
	/** LK: text, rock drawing */
	ink: BREZINE.LK.hex,
	/** NB: contour brown, rules */
	contour: BREZINE.NB.hex,
	/** GL: water ink, links */
	water: BREZINE.GL.hex,
	/** GG: forest, "result" */
	forest: BREZINE.GG.hex,
	/** BL: relief shading, hairlines */
	relief: BREZINE.BL.hex,
	/** SR: route red, Swiss cross, primary accent */
	red: BREZINE.SR.hex,
	/** YY: Wegweiser yellow, light */
	signLight: BREZINE.YY.hex,
	/** SY: Wegweiser yellow, strong */
	sign: BREZINE.SY.hex,
	/** BG: secondary text, coordinates, tick labels */
	secondary: BREZINE.BG.hex,
	/** GR: pencil */
	pencil: BREZINE.GR.hex,
	/** PB: peak lettering. PB also stands in for Alpinwanderweg blue RAL 5015; not a colour match (Brezine has no saturated blue) */
	navy: BREZINE.PB.hex,
} as const;
