// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Anchor-input parity between the two engines (tools/nearfield/smear/REPORT.txt point 2/4: the same photo and
// pose anchored at quality 0.95 in one renderer and 0.00 in the other, bottom row 6.8 m vs 31.7 m).
//
// Since near-dem.ts the inputs of fitAnchor are built the SAME way in both engines
// (deck/engine.ts and deck-webgpu/engine.ts nearFieldDemRange: nearFieldDemRangeFrom(nearDem ?? terrain, view, w,
// h, sampleAt fallback)). What can still differ, and what this helper makes visible:
//   1. nearDem load failed in one engine (null): `this.terrain` (engine DEM, engine eye) answers instead of the
//      shared z16 DEM, so within 400 m the two grids come from different heights and eye altitudes.
//   2. the fallback `sampleAt(u, v).range` beyond NEAR_DEM_CPU_MAX (400 m) or where the CPU profiles see no
//      terrain: GPU range buffers, y orientation and the geometry-ready state differ per engine.
//   3. a stale pose or geometry (grid built before the engine's range buffer matched the pose).
// Hook point to wire it (not wired: it needs both engines in one page, i.e. a harness): in
// nearfield/controller.ts after `engine.nearFieldDemRange(w, h)` is gridded by geom.sampleDemGrid, a dev check
// can compare the grid against one built from the other engine's range function with anchorInputsAgree.
import type { DemRangeAt } from "./geom";

export type DemGridDiff = {
	/** Cells where both grids have terrain. */
	both: number;
	/** Cells where exactly one grid has terrain (coverage mismatch). */
	onlyOne: number;
	/** Cells of `both` whose |ln(a/b)| exceeds ln(1 + relTol). */
	disagree: number;
	/** disagree / both (0 when no overlap). */
	disagreeFrac: number;
	/** Median |ln(a/b)| over `both`. */
	medianLogDiff: number;
	/** Largest |ln(a/b)| over `both`, and its row (the bottom rows are where the engines used to differ). */
	maxLogDiff: number;
	maxRow: number;
	/** Per row fraction of disagreeing cells among `both` (length height). */
	rowDisagree: Float32Array;
};

const isRange = (r: number) => r > 0 && Number.isFinite(r);

/** Compare two DEM range grids (geom.sampleDemGrid layout, NaN / ≤ 0 = no terrain) cell by cell. */
export function compareDemGrids(
	a: ArrayLike<number>,
	b: ArrayLike<number>,
	width: number,
	height: number,
	relTol = 0.1,
): DemGridDiff {
	if (a.length !== width * height || b.length !== width * height)
		throw new Error("compareDemGrids: grid size mismatch");
	const lt = Math.log(1 + relTol);
	const rowBoth = new Float32Array(height);
	const rowBad = new Float32Array(height);
	const diffs: number[] = [];
	let onlyOne = 0;
	let disagree = 0;
	let maxLogDiff = 0;
	let maxRow = 0;
	for (let j = 0; j < height; j++)
		for (let i = 0; i < width; i++) {
			const k = j * width + i;
			const ha = isRange(a[k]);
			const hb = isRange(b[k]);
			if (ha !== hb) onlyOne++;
			if (!(ha && hb)) continue;
			const e = Math.abs(Math.log(a[k] / b[k]));
			diffs.push(e);
			rowBoth[j]++;
			if (e > lt) {
				disagree++;
				rowBad[j]++;
			}
			if (e > maxLogDiff) {
				maxLogDiff = e;
				maxRow = j;
			}
		}
	diffs.sort((x, y) => x - y);
	const m = diffs.length >> 1;
	const medianLogDiff = !diffs.length
		? 0
		: diffs.length & 1
			? diffs[m]
			: 0.5 * (diffs[m - 1] + diffs[m]);
	for (let j = 0; j < height; j++)
		rowBad[j] = rowBoth[j] ? rowBad[j] / rowBoth[j] : 0;
	return {
		both: diffs.length,
		onlyOne,
		disagree,
		disagreeFrac: diffs.length ? disagree / diffs.length : 0,
		medianLogDiff,
		maxLogDiff,
		maxRow,
		rowDisagree: rowBad,
	};
}

export type AnchorAgreeOpts = {
	/** Per-cell relative range tolerance. Default 0.1 (10 %; the engines' placements agree within 3 % when the inputs match). */
	relTol: number;
	/** Largest tolerated share of disagreeing cells. Default 0.02. */
	maxDisagreeFrac: number;
	/** Largest tolerated share of cells with terrain in only one grid. Default 0.02. */
	maxOnlyOneFrac: number;
};

/** Do two engines' DEM grids describe the same anchor input, within tolerance? */
export function anchorInputsAgree(
	a: ArrayLike<number>,
	b: ArrayLike<number>,
	width: number,
	height: number,
	opts: Partial<AnchorAgreeOpts> = {},
): { agree: boolean; diff: DemGridDiff } {
	const o = {
		relTol: 0.1,
		maxDisagreeFrac: 0.02,
		maxOnlyOneFrac: 0.02,
		...opts,
	};
	const diff = compareDemGrids(a, b, width, height, o.relTol);
	const n = width * height;
	return {
		agree:
			diff.disagreeFrac <= o.maxDisagreeFrac &&
			diff.onlyOne <= o.maxOnlyOneFrac * n,
		diff,
	};
}

/**
 * The canonical way both engines turn their range function into the anchor's DEM grid: one cell-centre sample
 * per depth cell, row 0 = top of the photo (v = 0), NaN for no terrain. Identical to geom.sampleDemGrid but
 * additionally refuses a wrong-size reuse, so a grid cached for another depth size is rebuilt, not reused.
 */
export function canonicalDemGrid(
	width: number,
	height: number,
	demRangeAt: DemRangeAt,
	reuse?: Float32Array | null,
): Float32Array {
	const g =
		reuse && reuse.length === width * height
			? reuse
			: new Float32Array(width * height);
	for (let j = 0; j < height; j++)
		for (let i = 0; i < width; i++) {
			const r = demRangeAt((i + 0.5) / width, (j + 0.5) / height);
			g[j * width + i] =
				r != null && r > 0 && Number.isFinite(r) ? r : Number.NaN;
		}
	return g;
}
