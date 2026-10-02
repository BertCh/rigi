// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// C4: the label and drape hooks of the DSM occluder (?concord=occl,labels,drape). Pure CPU, display-only.
// Both are computed from the occluder range grid display.ts already has (no second DSM fetch), with the
// same "behind" rule as the overlay dimming (OCCL_RULE). Precision over recall: a label is hidden only when
// most of the cells around its anchor are clearly in front of the target; sky and no-data never occlude.
import type { ByteMask } from "../../ontology/core/geometry";
import { type GeomBuffer, occludedBy } from "./occluder";

/** The occluder pass in photo space (row 0 = top, cell-centred), as occluderRange returns it. */
export type OccluderGrid = {
	width: number;
	height: number;
	/** Nearest occluder range (m) per cell; Infinity (or NaN) = none. */
	range: Float32Array;
	/** Terrain range (m) at the pose per cell; Infinity (or NaN) = sky / no data. */
	terrain: Float32Array;
};

export type LabelAnchor = {
	id: string;
	/** Photo uv of the peak anchor, u right, v down (row 0 = top). */
	u: number;
	v: number;
	/** Distance eye to the peak (m). */
	rangeM: number;
};

export type OccludedLabelsOpts = {
	/** Minimum number of the 3×3 neighbouring cells that must occlude. Default 6 of 9. */
	k?: number;
};

const finite = (x: number) => Number.isFinite(x) && x > -1;

/** Ids of labels whose anchor sits behind a DSM object in at least k of its 3×3 grid cells. */
export function occludedLabels(
	labels: readonly LabelAnchor[],
	grid: OccluderGrid,
	opts: OccludedLabelsOpts = {},
): Set<string> {
	const k = opts.k ?? 6;
	const out = new Set<string>();
	const { width: w, height: h, range } = grid;
	for (const l of labels) {
		if (!(l.rangeM > 0) || !Number.isFinite(l.u) || !Number.isFinite(l.v))
			continue;
		const ci = Math.floor(l.u * w);
		const cj = Math.floor(l.v * h);
		if (ci < 0 || cj < 0 || ci >= w || cj >= h) continue;
		let n = 0;
		for (let dj = -1; dj <= 1; dj++)
			for (let di = -1; di <= 1; di++) {
				const i = ci + di;
				const j = cj + dj;
				if (i < 0 || j < 0 || i >= w || j >= h) continue; // outside never counts
				const o = range[j * w + i];
				if (finite(o) && occludedBy(l.rangeM, o)) n++;
			}
		if (n >= k) out.add(l.id);
	}
	return out;
}

export type DrapeMaskOpts = {
	/** Grow the mask by one cell (4-neighbourhood, so edge pixels of an object are covered). Default true. */
	dilate?: boolean;
};

/**
 * Photo-space mask (setOccluder's FgMask shape, row 0 = top): 255 where the pixel shows a DSM object well in
 * front of the terrain behind it, so the drape must not paint it onto the terrain. `g` supplies the terrain
 * range and sky flags at the same grid size as `grid`.
 */
export function drapeMaskFromOccluder(
	grid: OccluderGrid,
	g: Pick<GeomBuffer, "w" | "h" | "range" | "sky">,
	opts: DrapeMaskOpts = {},
): ByteMask {
	const { width: w, height: h } = grid;
	const raw = new Uint8Array(w * h);
	if (g.w === w && g.h === h)
		for (let n = 0; n < raw.length; n++) {
			const o = grid.range[n];
			const t = g.range[n];
			if (g.sky[n] || !finite(o) || !(t > 0)) continue;
			if (occludedBy(t, o)) raw[n] = 255;
		}
	if (opts.dilate === false) return { width: w, height: h, data: raw };
	const data = raw.slice();
	for (let j = 0; j < h; j++)
		for (let i = 0; i < w; i++) {
			if (!raw[j * w + i]) continue;
			if (i > 0) data[j * w + i - 1] = 255;
			if (i < w - 1) data[j * w + i + 1] = 255;
			if (j > 0) data[(j - 1) * w + i] = 255;
			if (j < h - 1) data[(j + 1) * w + i] = 255;
		}
	return { width: w, height: h, data };
}
