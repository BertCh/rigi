// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Cliff-lip anchoring (roadmap S1 prep; reports/step-inside-results.md item 6 / next step 2).
//
// Why a cliff-lip eye (IMG_7059, 7063) anchors at quality 0: the anchor fit pairs the model's ray length with the
// DEM range per pixel. Standing on a lip, the DEM range grid has a one-pixel-wide wall of huge range jumps:
// rays just above the lip edge graze the far valley (hundreds of metres to kilometres) while the rays one row
// lower hit the drop's floor or face (tens of metres). The z16 near DEM (0.8 m/px, bilinear) rounds the edge, so
// the range step sits a few rows away from the silhouette the model sees (monocular depth smooths across the
// edge, and the bilinear lip moves the DEM step), and the cells below the step lie on a steep face whose DEM
// range is hypersensitive to a decimetre of eye height (eyeAltitude: max(GPS, DEM + 1.6 m)). Those pairs are
// off by factors of 2 to 10 in opposite directions, they land in every octave of the octave-weighted curve fit,
// and the median |log residual| over ALL candidates (the quality term) collapses.
//
// The rule: find cells where the DEM range jumps by more than `jumpRatio` against a 4-neighbour (both finite),
// widen them by `dilate` cells, and, per column, also exclude `shadowRows` rows below a far-to-near jump going
// down (the lip's face). The fit then runs on the remaining cells instead of failing the whole photo. When no
// jump is found the mask is empty and fitAnchor sees the original range function untouched (flat meadows are
// byte-identical). Opt-in: AnchorOpts.cliffLip / the `anchorCliff` flag; the default anchor is unchanged.
// Caveat: any near ridge occluding a far one is also a far-above / near-below step, so the rule fires on ordinary
// occlusion edges too (excluding those mixed cells is harmless to the fit, but such photos are NOT byte-identical
// with the flag on). Untested on IMG_7059 / 7063: judge in the next browser batch.
import type { DemRangeAt } from "./geom";

export type CliffLipOpts = {
	/** Neighbouring DEM ranges differing by more than this ratio mark a discontinuity. Default 1.8. */
	jumpRatio: number;
	/** Cells the discontinuity mask is widened by in every direction, as a fraction of the grid height (min 1 cell). Default 0.012. */
	dilateFrac: number;
	/** Rows below a downward far-to-near jump that are excluded too (the lip face), fraction of height. Default 0.05. */
	shadowFrac: number;
	/** Fewer jump cells than this fraction of the finite cells do not count as a cliff (noise). Default 0.002. */
	minJumpFrac: number;
	/** If more than this fraction of the finite cells would be excluded, keep the original cells (no cliff recipe fits). Default 0.6. */
	maxExcludedFrac: number;
};
export const CLIFF_LIP_DEFAULTS: CliffLipOpts = {
	jumpRatio: 1.8,
	dilateFrac: 0.012,
	shadowFrac: 0.05,
	minJumpFrac: 0.002,
	maxExcludedFrac: 0.6,
};

export type CliffLipResult = {
	/** 1 = excluded from the anchor fit; length width·height. Empty (all 0) when no cliff was found. */
	mask: Uint8Array;
	/** A cliff-lip configuration was detected and `mask` is in force. */
	detected: boolean;
	/** Cells with a range jump, before dilation / shadow. */
	jumpCells: number;
	/** Excluded cells (dilated jumps + lip shadows). */
	excludedCells: number;
	/** Finite DEM cells in the grid. */
	finiteCells: number;
};

/**
 * Detect the cliff-lip configuration on a DEM range grid (geom.sampleDemGrid: row-major, NaN or ≤ 0 = no
 * terrain). Pure; the grid is not modified.
 */
export function detectCliffLip(
	grid: ArrayLike<number>,
	width: number,
	height: number,
	opts: Partial<CliffLipOpts> = {},
): CliffLipResult {
	const o = { ...CLIFF_LIP_DEFAULTS, ...opts };
	const n = width * height;
	const none = (finiteCells: number, jumpCells = 0): CliffLipResult => ({
		mask: new Uint8Array(n),
		detected: false,
		jumpCells,
		excludedCells: 0,
		finiteCells,
	});
	const lr = new Float32Array(n);
	let finite = 0;
	for (let k = 0; k < n; k++) {
		const r = grid[k];
		if (r > 0 && Number.isFinite(r)) {
			lr[k] = Math.log(r);
			finite++;
		} else lr[k] = Number.NaN;
	}
	if (!finite) return none(0);
	const lj = Math.log(o.jumpRatio);
	const jump = new Uint8Array(n);
	const lip = new Uint8Array(n); // far above, near below: marks the NEAR cell below the step
	let jumpCells = 0;
	for (let j = 0; j < height; j++)
		for (let i = 0; i < width; i++) {
			const k = j * width + i;
			const a = lr[k];
			if (Number.isNaN(a)) continue;
			if (i + 1 < width) {
				const b = lr[k + 1];
				if (!Number.isNaN(b) && Math.abs(a - b) > lj) {
					jump[k] = jump[k + 1] = 1;
				}
			}
			if (j + 1 < height) {
				const b = lr[k + width];
				if (!Number.isNaN(b) && Math.abs(a - b) > lj) {
					jump[k] = jump[k + width] = 1;
					if (a - b > lj) lip[k + width] = 1;
				}
			}
		}
	for (let k = 0; k < n; k++) jumpCells += jump[k];
	if (jumpCells < o.minJumpFrac * finite) return none(finite, jumpCells);
	// a lip is a vertical far-to-near step: without one the jumps are building / tree edges, not a cliff
	let lips = 0;
	for (let k = 0; k < n; k++) lips += lip[k];
	if (lips < Math.max(2, o.minJumpFrac * finite))
		return none(finite, jumpCells);

	const d = Math.max(1, Math.round(o.dilateFrac * height));
	const sh = Math.max(1, Math.round(o.shadowFrac * height));
	// separable box dilation of the jump cells, then the lip shadows below the near side of each lip
	const hor = new Uint8Array(n);
	for (let j = 0; j < height; j++)
		for (let i = 0; i < width; i++)
			if (jump[j * width + i])
				for (let x = Math.max(0, i - d); x <= Math.min(width - 1, i + d); x++)
					hor[j * width + x] = 1;
	const mask = new Uint8Array(n);
	for (let j = 0; j < height; j++)
		for (let i = 0; i < width; i++)
			if (hor[j * width + i])
				for (let y = Math.max(0, j - d); y <= Math.min(height - 1, j + d); y++)
					mask[y * width + i] = 1;
	for (let j = 0; j < height; j++)
		for (let i = 0; i < width; i++)
			if (lip[j * width + i])
				for (let y = j; y <= Math.min(height - 1, j + sh); y++)
					mask[y * width + i] = 1;
	let excluded = 0;
	for (let k = 0; k < n; k++) if (mask[k] && !Number.isNaN(lr[k])) excluded++;
	if (excluded > o.maxExcludedFrac * finite) return none(finite, jumpCells);
	return {
		mask,
		detected: true,
		jumpCells,
		excludedCells: excluded,
		finiteCells: finite,
	};
}

/**
 * A DemRangeAt that answers null on the cells the cliff mask excludes (grid cells, nearest like
 * geom.gridDemRange). Returns `demRangeAt` itself, same identity, when nothing is excluded.
 */
export function maskCliffRange(
	demRangeAt: DemRangeAt,
	cliff: CliffLipResult,
	width: number,
	height: number,
): DemRangeAt {
	if (!cliff.detected) return demRangeAt;
	return (u, v) => {
		const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
		const y = Math.min(height - 1, Math.max(0, Math.floor(v * height)));
		return cliff.mask[y * width + x] ? null : demRangeAt(u, v);
	};
}
