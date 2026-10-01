// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Object grounding: place each near-field object at the DEM range where it stands on the terrain.
//
// The range-dependent curve (anchor.ts) calibrates the model on terrain, but a monocular model's depth for an
// object can still be off relative to the terrain it stands on, and an object nearer than any calibrated terrain is
// only extrapolated. Where an object visibly touches the ground, the DEM range at that contact is the best metric
// reference we have. For every connected component of Object cells on the depth grid (4-connected, split where the
// model depth jumps by more than maxLogStep):
//   contacts = the lowest cell of each column in the component's bottom band whose cell just below (≤ searchRows) is
//              Terrain with a DEM hit, the model depth continuous across the contact (|log| ≤ contactLog: the object
//              stands there rather than floating in front of that terrain) and that terrain pixel a calibration inlier
//              (|log(DEM / curve)| ≤ maxInlierLog: excludes terraces, roofs and eye-height errors the DEM lacks)
//   factor   = median over contacts of DEM range / object model ray (metres per model unit); the whole component
//              is scaled by it about the camera, which keeps its internal relative depth.
// Components with fewer than minContacts contacts (skyline trees, branches, objects cut by the frame) keep the curve.
// Components whose model depth recedes strongly upward (top-quarter / bottom-quarter median > upright) are not
// standing objects but background terrain the model pulled forward across a ridge silhouette; they are
// reclassified Terrain (the DEM drape renders them).
// Offline validation: tools/nearfield/spike/place.py (Python port; parameters mirror GROUND_DEFAULTS).
import type { AnchorLike } from "./anchor";
import { anchoredRange } from "./anchor";
import {
	type DemRangeAt,
	type IntrinsicsNorm,
	median,
	modelDepth,
	rayFactor,
} from "./geom";
import { type NearFieldDepth, PixelClass, type SplitResult } from "./types";

export type GroundOpts = {
	/** Max |log| model-depth step between 4-neighbours of one component. Default 0.5. */
	maxLogStep: number;
	/** Bottom band of a component that may carry contacts: max(bottomBandMin, bottomBandFrac·height) rows. */
	bottomBandFrac: number;
	bottomBandMin: number;
	/** Rows searched below a column's lowest cell for the ground. Default 2. */
	searchRows: number;
	/** Max |log(model terrain / model object)| across a contact. Default 0.35. */
	contactLog: number;
	/** Max |log(DEM / curve(model))| at the contact's terrain cell. Default 0.55. 0 disables. */
	maxInlierLog: number;
	/** Contacts needed to ground a component. Default 2. */
	minContacts: number;
	/** Components smaller than this (cells) keep the curve. Default 6. */
	minPixels: number;
	/** Top/bottom model-depth ratio above which a component is terrain, not an object. Default 2. 0 disables. */
	upright: number;
	/** The upright test needs at least this many rows. Default 8. */
	uprightMinRows: number;
};
const GROUND_DEFAULTS: GroundOpts = {
	maxLogStep: 0.5,
	bottomBandFrac: 0.15,
	bottomBandMin: 2,
	searchRows: 2,
	contactLog: 0.35,
	maxInlierLog: 0.55,
	minContacts: 2,
	minPixels: 6,
	upright: 2,
	uprightMinRows: 8,
};

export type GroundedComponent = {
	id: number;
	/** Cells in the component. */
	cells: number;
	/** Inclusive cell bbox [col0, row0, col1, row1]. */
	bbox: [number, number, number, number];
	contacts: number;
	/** Metres per model unit when grounded, else null (the curve places it). */
	factor: number | null;
	/** Median DEM range (m) and object model ray at the contacts, when grounded. */
	contactDem?: number;
	contactModel?: number;
	/** Top-quarter / bottom-quarter median model ray (≈ 1 upright; ≫ 1 receding terrain), null if unknown. */
	recede: number | null;
	/** Set when the component was reclassified Terrain. */
	dropped?: "notUpright";
};

export type GroundResult = {
	width: number;
	height: number;
	/** Component id per cell, −1 = not an Object cell. */
	labels: Int32Array;
	components: GroundedComponent[];
	/** The input split with dropped components reclassified Terrain (a copy when anything changed). */
	split: SplitResult;
	/** 1 = cell of a dropped (not upright) component; null when none was dropped. */
	dropped: Uint8Array | null;
};

/** Model ray length per depth cell (NaN when invalid). */
function modelRayGrid(depth: NearFieldDepth, K: IntrinsicsNorm): Float32Array {
	const { width: W, height: H } = depth;
	const out = new Float32Array(W * H);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			out[k] =
				modelDepth(depth, k) * rayFactor(K, (i + 0.5) / W, (j + 0.5) / H);
		}
	return out;
}

/**
 * Ground the Object components of `split`. `demRangeAt` = terrain ray length at normalised coords (a grid from
 * geom.gridDemRange is fastest); `K` = the photo's normalised intrinsics; `anchor` = the fit (curve) used by
 * the split.
 */
export function groundObjects(
	depth: NearFieldDepth,
	split: SplitResult,
	anchor: AnchorLike,
	demRangeAt: DemRangeAt,
	K: IntrinsicsNorm,
	opts: Partial<GroundOpts> = {},
): GroundResult {
	const o = { ...GROUND_DEFAULTS, ...opts };
	const { width: W, height: H } = depth;
	if (split.width !== W || split.height !== H)
		throw new Error("groundObjects: split and depth grids differ");
	const mr = modelRayGrid(depth, K);
	let cls = split.cls;
	let copied = false;
	let dropped: Uint8Array | null = null;
	const labels = new Int32Array(W * H).fill(-1);
	const comps: GroundedComponent[] = [];
	const dem = (k: number) =>
		demRangeAt(((k % W) + 0.5) / W, (Math.floor(k / W) + 0.5) / H);
	const queue = new Int32Array(W * H);

	for (let k0 = 0; k0 < W * H; k0++) {
		if (cls[k0] !== PixelClass.Object || labels[k0] >= 0) continue;
		const id = comps.length;
		// BFS
		let qh = 0;
		let qt = 0;
		labels[k0] = id;
		queue[qt++] = k0;
		while (qh < qt) {
			const k = queue[qh++];
			const i = k % W;
			const j = (k - i) / W;
			for (let d = 0; d < 4; d++) {
				const ii = i + (d === 0 ? 1 : d === 1 ? -1 : 0);
				const jj = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
				if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
				const kk = jj * W + ii;
				if (cls[kk] !== PixelClass.Object || labels[kk] >= 0) continue;
				const a = mr[k];
				const b = mr[kk];
				if (a > 0 && b > 0 && Math.abs(Math.log(b / a)) > o.maxLogStep)
					continue;
				labels[kk] = id;
				queue[qt++] = kk;
			}
		}
		const cellsIdx = queue.subarray(0, qt);
		let i0 = W;
		let j0 = H;
		let i1 = -1;
		let j1 = -1;
		for (const k of cellsIdx) {
			const i = k % W;
			const j = (k - i) / W;
			if (i < i0) i0 = i;
			if (i > i1) i1 = i;
			if (j < j0) j0 = j;
			if (j > j1) j1 = j;
		}
		const c: GroundedComponent = {
			id,
			cells: qt,
			bbox: [i0, j0, i1, j1],
			contacts: 0,
			factor: null,
			recede: null,
		};
		comps.push(c);
		if (qt < o.minPixels) continue;
		const hgt = j1 - j0 + 1;
		// uprightness
		const q1 = j0 + 0.25 * (hgt - 1);
		const q3 = j0 + 0.75 * (hgt - 1);
		const top: number[] = [];
		const bot: number[] = [];
		for (const k of cellsIdx) {
			const j = Math.floor(k / W);
			if (!(mr[k] > 0)) continue;
			if (j <= q1) top.push(mr[k]);
			if (j >= q3) bot.push(mr[k]);
		}
		if (top.length && bot.length) c.recede = median(top) / median(bot);
		if (
			o.upright > 0 &&
			c.recede != null &&
			hgt >= o.uprightMinRows &&
			c.recede > o.upright
		) {
			c.dropped = "notUpright";
			if (!copied) {
				cls = Uint8Array.from(cls);
				copied = true;
				dropped = new Uint8Array(W * H);
			}
			for (const k of cellsIdx) {
				cls[k] = PixelClass.Terrain;
				if (dropped) dropped[k] = 1;
				labels[k] = -1; // no longer an Object cell (the class check keeps the BFS from revisiting it)
			}
			continue;
		}
		// contacts: per column the lowest cell, in the bottom band
		const band = Math.max(o.bottomBandMin, Math.ceil(o.bottomBandFrac * hgt));
		const colBot = new Int32Array(i1 - i0 + 1).fill(-1);
		for (const k of cellsIdx) {
			const i = k % W;
			const j = (k - i) / W;
			if (j > colBot[i - i0]) colBot[i - i0] = j;
		}
		const ratios: number[] = [];
		const dems: number[] = [];
		const models: number[] = [];
		for (let ci = 0; ci < colBot.length; ci++) {
			const j = colBot[ci];
			if (j < 0 || j < j1 - band + 1) continue;
			const i = ci + i0;
			const mo = mr[j * W + i];
			if (!(mo > 0)) continue;
			for (let s = 1; s <= o.searchRows; s++) {
				const jb = j + s;
				if (jb >= H) break;
				const kb = jb * W + i;
				if (cls[kb] === PixelClass.Object && labels[kb] !== id) break;
				if (cls[kb] !== PixelClass.Terrain) continue;
				const d = dem(kb);
				if (d == null || !(d > 0)) continue;
				const mt = mr[kb];
				if (!(mt > 0) || Math.abs(Math.log(mt / mo)) > o.contactLog) break;
				if (
					o.maxInlierLog > 0 &&
					!(Math.abs(Math.log(d / anchoredRange(anchor, mt))) <= o.maxInlierLog)
				)
					break;
				ratios.push(d / mo);
				dems.push(d);
				models.push(mo);
				break;
			}
		}
		c.contacts = ratios.length;
		if (ratios.length >= o.minContacts) {
			c.factor = median(ratios);
			c.contactDem = median(dems);
			c.contactModel = median(models);
		}
	}
	let out = split;
	if (copied) {
		const counts = [0, 0, 0, 0, 0];
		for (let k = 0; k < cls.length; k++) counts[cls[k]]++;
		out = { width: W, height: H, cls, counts };
	}
	return {
		width: W,
		height: H,
		labels,
		components: comps,
		split: out,
		dropped,
	};
}

/** Placed range (m) of a model ray `modelRay` seen at depth cell `k`: the component's factor if grounded, else the curve. */
export function placedRange(
	g: GroundResult | null | undefined,
	anchor: AnchorLike,
	k: number,
	modelRay: number,
): number {
	const id = g && k >= 0 ? g.labels[k] : -1;
	const f = id >= 0 ? g?.components[id].factor : null;
	return f != null ? f * modelRay : anchoredRange(anchor, modelRay);
}

/** Depth-grid cell of normalised coords (u, v). */
export const cellAt = (
	g: { width: number; height: number },
	u: number,
	v: number,
) =>
	Math.min(g.height - 1, Math.max(0, Math.floor(v * g.height))) * g.width +
	Math.min(g.width - 1, Math.max(0, Math.floor(u * g.width)));

/**
 * The depth with every valid cell replaced by its PLACED z-depth in metres (grounded factor or curve). Lift it
 * with the identity anchor ({ scale: 1, shift: 0 }) to get placed Gaussians.
 */
export function placedDepth(
	depth: NearFieldDepth,
	g: GroundResult | null,
	anchor: AnchorLike,
	K: IntrinsicsNorm,
): NearFieldDepth {
	const { width: W, height: H } = depth;
	const out = new Float32Array(W * H).fill(Number.NaN);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			const z = modelDepth(depth, k);
			if (Number.isNaN(z)) continue;
			const f = rayFactor(K, (i + 0.5) / W, (j + 0.5) / H);
			const r = placedRange(g, anchor, k, z * f);
			if (r > 0) out[k] = r / f;
		}
	return { ...depth, depth: out, model: `${depth.model}+placed` };
}

// ---- far objects: trees / huts beyond nearRadius that stand out from the DEM ----
//
// The split sends everything whose anchored range exceeds nearRadius (150 m) to Far: the DEM drape renders it.
// A tree on a lake shore at 300 m is not terrain, though: draped, it smears across the water behind it in the
// world view. A component of such Far cells becomes Object (a splat, masked out of the drape) only when all of
//   - its cells are in front of the DEM by the split's own margin (range < dem·(1 − objectMargin), gap ≥ minGapM)
//     or have no DEM behind them (silhouetted against the sky), within farRadius;
//   - it is on the SKYLINE (a share of its top-edge columns has sky / no terrain above) and at least minAspect
//     tall for its width, or shows a STRONG depth discontinuity vs the DEM behind it (median DEM / placed range
//     ≥ discontinuity) and is at least discontinuityAspect tall for its width;
//   - it is upright: top/bottom model depth ≤ maxRecede (standing objects ≈ 1; terrain bands recede), and big
//     enough;
//   - grounding finds ≥ minContacts contacts on DEM terrain below it (Terrain or Far cells, the same continuity
//     and calibration-inlier tests as groundObjects), and the contact range is within farRadius.
// It is then placed by its contact factor, exactly like a grounded near object.
// Dev-cache validation (DEV ids, place.py inputs, the real TS split): wide terrain bands (a moraine the model pulls
// forward, a ridge cap, far shores) were the false positives of the bare rule, trees on the skyline the true ones;
// the shape / recede tests separate them there (tuned on that same set: in-sample). Not covered: a tree line whose
// base hides behind a nearer crest has no contact and stays Far (draped).

export type FarObjectOpts = {
	/** Max range (m) of a far object (anchored and placed). Default 600. 0 disables. */
	farRadius: number;
	/** Median DEM-behind / placed range at or above this = a strong depth discontinuity. Default 4. */
	discontinuity: number;
	/** Share of the component's top-edge columns with sky / no terrain above that makes it a skyline object. Default 0.3. */
	skylineFrac: number;
	/** Smallest far component (cells). Default 12. */
	minPixels: number;
	/** Skyline components: min bbox height / width. Default 0.7. */
	minAspect: number;
	/** Discontinuity-only components: min bbox height / width. Default 1.2. */
	discontinuityAspect: number;
	/** Max top/bottom-quarter model-depth ratio (standing ≈ 1). Default 1.3. */
	maxRecede: number;
};
const FAR_OBJECT_DEFAULTS: FarObjectOpts = {
	farRadius: 600,
	discontinuity: 4,
	skylineFrac: 0.3,
	minPixels: 12,
	minAspect: 0.7,
	discontinuityAspect: 1.2,
	maxRecede: 1.3,
};

/** A GroundedComponent promoted from Far by promoteFarObjects (always grounded: `factor` is set). */
export type FarComponent = GroundedComponent & {
	far: true;
	skyline: boolean;
	/** Median DEM-behind / placed range over the cells with a DEM hit (Infinity when none). */
	demRatio: number;
};

export const isFarComponent = (
	c: GroundedComponent | undefined,
): c is FarComponent => !!(c as FarComponent | undefined)?.far;

/**
 * Promote grounded far objects (see above) to Object in `g` (the groundObjects result). Returns a new
 * GroundResult (labels / split copied when anything is promoted; the far components are appended to
 * `components` with `far: true`), or `g` itself when nothing qualifies.
 */
export function promoteFarObjects(
	depth: NearFieldDepth,
	g: GroundResult,
	anchor: AnchorLike,
	demRangeAt: DemRangeAt,
	K: IntrinsicsNorm,
	split: { objectMargin: number; nearRadius: number; minGapM: number },
	opts: Partial<FarObjectOpts> = {},
	groundOpts: Partial<GroundOpts> = {},
): GroundResult {
	const f = { ...FAR_OBJECT_DEFAULTS, ...opts };
	const o = { ...GROUND_DEFAULTS, ...groundOpts };
	if (!(f.farRadius > split.nearRadius)) return g;
	const { width: W, height: H } = depth;
	const cls0 = g.split.cls;
	const mr = modelRayGrid(depth, K);
	const demK = (k: number) =>
		demRangeAt(((k % W) + 0.5) / W, (Math.floor(k / W) + 0.5) / H);
	// candidate cells
	const cand = new Uint8Array(W * H);
	const demC = new Float32Array(W * H).fill(Number.NaN);
	const rngC = new Float32Array(W * H);
	let any = false;
	for (let k = 0; k < W * H; k++) {
		if (cls0[k] !== PixelClass.Far || !(mr[k] > 0)) continue;
		const r = anchoredRange(anchor, mr[k]);
		if (!(r > split.nearRadius && r <= f.farRadius)) continue;
		const d = demK(k);
		const hit = d != null && d > 0;
		if (hit && !(r < d * (1 - split.objectMargin) && d - r >= split.minGapM))
			continue;
		cand[k] = 1;
		rngC[k] = r;
		if (hit) demC[k] = d;
		any = true;
	}
	if (!any) return g;
	const lab = new Int32Array(W * H).fill(-1);
	const queue = new Int32Array(W * H);
	const promoted: FarComponent[] = [];
	const promotedCells: Int32Array[] = [];
	let nComp = 0;
	for (let k0 = 0; k0 < W * H; k0++) {
		if (!cand[k0] || lab[k0] >= 0) continue;
		const id = nComp++;
		let qh = 0;
		let qt = 0;
		lab[k0] = id;
		queue[qt++] = k0;
		while (qh < qt) {
			const k = queue[qh++];
			const i = k % W;
			const j = (k - i) / W;
			for (let d = 0; d < 4; d++) {
				const ii = i + (d === 0 ? 1 : d === 1 ? -1 : 0);
				const jj = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
				if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
				const kk = jj * W + ii;
				if (!cand[kk] || lab[kk] >= 0) continue;
				if (Math.abs(Math.log(mr[kk] / mr[k])) > o.maxLogStep) continue;
				lab[kk] = id;
				queue[qt++] = kk;
			}
		}
		if (qt < Math.max(f.minPixels, o.minPixels)) continue;
		const cells = queue.slice(0, qt);
		let i0 = W;
		let j0 = H;
		let i1 = -1;
		let j1 = -1;
		for (const k of cells) {
			const i = k % W;
			const j = (k - i) / W;
			if (i < i0) i0 = i;
			if (i > i1) i1 = i;
			if (j < j0) j0 = j;
			if (j > j1) j1 = j;
		}
		const hgt = j1 - j0 + 1;
		// upright (groundObjects' ridge-silhouette test)
		const q1 = j0 + 0.25 * (hgt - 1);
		const q3 = j0 + 0.75 * (hgt - 1);
		const top: number[] = [];
		const bot: number[] = [];
		for (const k of cells) {
			const j = Math.floor(k / W);
			if (j <= q1) top.push(mr[k]);
			if (j >= q3) bot.push(mr[k]);
		}
		const recede = top.length && bot.length ? median(top) / median(bot) : null;
		if (recede == null || recede > Math.min(f.maxRecede, o.upright || Infinity))
			continue;
		const aspect = hgt / (i1 - i0 + 1);
		// per column: top and bottom cell
		const colTop = new Int32Array(i1 - i0 + 1).fill(H);
		const colBot = new Int32Array(i1 - i0 + 1).fill(-1);
		for (const k of cells) {
			const i = k % W;
			const j = (k - i) / W;
			if (j < colTop[i - i0]) colTop[i - i0] = j;
			if (j > colBot[i - i0]) colBot[i - i0] = j;
		}
		// skyline: sky (or no terrain and no model depth) right above the column's top cell
		let cols = 0;
		let skyCols = 0;
		for (let ci = 0; ci < colTop.length; ci++) {
			const j = colTop[ci];
			if (j >= H || j === 0) continue;
			cols++;
			const ka = (j - 1) * W + ci + i0;
			const ca = cls0[ka];
			if (
				ca === PixelClass.Sky ||
				ca === PixelClass.Unknown ||
				(!cand[ka] && !(mr[ka] > 0) && demK(ka) == null)
			)
				skyCols++;
		}
		const skyline = cols > 0 && skyCols / cols >= f.skylineFrac;
		// contacts
		const band = Math.max(o.bottomBandMin, Math.ceil(o.bottomBandFrac * hgt));
		const ratios: number[] = [];
		const dems: number[] = [];
		const models: number[] = [];
		for (let ci = 0; ci < colBot.length; ci++) {
			const j = colBot[ci];
			if (j < 0 || j < j1 - band + 1) continue;
			const i = ci + i0;
			const mo = mr[j * W + i];
			for (let s = 1; s <= o.searchRows; s++) {
				const jb = j + s;
				if (jb >= H) break;
				const kb = jb * W + i;
				if (cand[kb] || cls0[kb] === PixelClass.Object) break;
				if (cls0[kb] !== PixelClass.Terrain && cls0[kb] !== PixelClass.Far)
					continue;
				const d = demK(kb);
				if (d == null || !(d > 0)) continue;
				const mt = mr[kb];
				if (!(mt > 0) || Math.abs(Math.log(mt / mo)) > o.contactLog) break;
				if (
					o.maxInlierLog > 0 &&
					!(Math.abs(Math.log(d / anchoredRange(anchor, mt))) <= o.maxInlierLog)
				)
					break;
				ratios.push(d / mo);
				dems.push(d);
				models.push(mo);
				break;
			}
		}
		if (ratios.length < o.minContacts) continue;
		const factor = median(ratios);
		const contactDem = median(dems);
		if (!(contactDem <= f.farRadius)) continue;
		// discontinuity with the placed ranges (no DEM behind = unbounded)
		const ratio: number[] = [];
		for (const k of cells)
			ratio.push(
				Number.isNaN(demC[k])
					? Number.POSITIVE_INFINITY
					: demC[k] / (factor * mr[k]),
			);
		const demRatio = median(ratio);
		const bySkyline = skyline && aspect >= f.minAspect;
		const byJump =
			demRatio >= f.discontinuity && aspect >= f.discontinuityAspect;
		if (!bySkyline && !byJump) continue;
		// placed in front of the terrain behind (a factor that pushes it through the DEM is not a far object)
		if (!(demRatio > 1 / (1 - split.objectMargin))) continue;
		promoted.push({
			id: -1,
			cells: qt,
			bbox: [i0, j0, i1, j1],
			contacts: ratios.length,
			factor,
			contactDem,
			contactModel: median(models),
			recede,
			far: true,
			skyline,
			demRatio,
		});
		promotedCells.push(cells);
	}
	if (!promoted.length) return g;
	const labels = Int32Array.from(g.labels);
	const cls = Uint8Array.from(cls0);
	const components = [...g.components];
	for (let p = 0; p < promoted.length; p++) {
		const c = promoted[p];
		c.id = components.length;
		components.push(c);
		for (const k of promotedCells[p]) {
			labels[k] = c.id;
			cls[k] = PixelClass.Object;
		}
	}
	const counts = [0, 0, 0, 0, 0];
	for (let k = 0; k < cls.length; k++) counts[cls[k]]++;
	return {
		width: W,
		height: H,
		labels,
		components,
		split: { width: W, height: H, cls, counts },
		dropped: g.dropped,
	};
}
