// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Roadmap S3 "3D Tiles T2" (reports/step-inside-google-3d-tiles.md): a measured above-ground-object prior for
// the depth split. The depth-only split classes huts and trees at 100-300 m as Far (reports/negative-results.md,
// "Step Inside and near-field 3D"); swisstopo building / vegetation tiles and the nDSM (swissSURFACE3D minus
// swissALTI3D, concord/occl) know they are there. This promotes Far / Terrain cells to Object when a measured
// object explains them. Pure CPU; the flag is ?tiles3dObjects= (default off) and the caller owns the data.
//
//   Licence gate: only measurable sources may feed it (ObjectEvidenceSource). A display-only source (Google
//   3D Tiles) THROWS in assertMeasurableSources, before any cell is touched: never ignored silently.
//   Precision over recall: a cell is promoted only when ALL hold
//     - it is Far or Terrain (Sky, Unknown, Object and people cells are never changed, nothing is demoted)
//     - a DEM range exists and is within maxRange (the cap)
//     - the measured object height at the cell's DEM hit is >= minHeight (nDSM, default 2.5 m)
//     - an independent range agrees with the object's range (the DEM range, which the nDSM height is sampled
//       at, or the swisstopo tile hit range when given): the anchored model range, or the tile range against
//       the DEM range, within max(tolAbsM, tolRel * range). nDSM height alone never promotes.
import { isMeasurableSource } from "../tiles3d/config";
import type { AnchorLike } from "./anchor";
import { anchoredRange } from "./anchor";
import { type IntrinsicsNorm, modelDepth, rayFactor } from "./geom";
import { type NearFieldDepth, PixelClass, type SplitResult } from "./types";

/** A source of measured object evidence: the nDSM, or a swisstopo 3D Tiles source id (config.ts). */
export type ObjectEvidenceSource = string;

export type ObjectPriorParams = {
	/** nDSM height (m) at the cell's DEM hit for an above-ground object. */
	minHeight: number;
	/** DEM range cap (m): beyond it nothing is promoted. */
	maxRange: number;
	/** Agreement tolerance: |a - b| <= max(tolAbsM, tolRel * b). */
	tolRel: number;
	tolAbsM: number;
};
export const DEFAULT_OBJECT_PRIOR: ObjectPriorParams = {
	minHeight: 2.5,
	maxRange: 400,
	tolRel: 0.25,
	tolAbsM: 3,
};

export type ObjectPriorInput = {
	split: SplitResult;
	depth: NearFieldDepth;
	anchor: AnchorLike;
	K: IntrinsicsNorm;
	/** DEM ray range per cell (NaN = none), depth-grid size (geom.sampleDemGrid). */
	demGrid: ArrayLike<number>;
	/** nDSM height (m) above terrain at each cell's DEM hit (NaN = no data), depth-grid size. */
	objectHeight: ArrayLike<number>;
	/** Optional swisstopo tile hit range (m) along each cell's ray (NaN = no hit), depth-grid size. */
	tileRange?: ArrayLike<number> | null;
	/** Every source that produced objectHeight / tileRange; any display-only one throws. */
	sources: readonly ObjectEvidenceSource[];
	params?: Partial<ObjectPriorParams>;
};

export type ObjectPriorResult = {
	split: SplitResult;
	/** Cells promoted to Object, by the class they had (Far, Terrain). */
	promotedFromFar: number;
	promotedFromTerrain: number;
	/** Candidates (height and range ok) rejected because no independent range agreed. */
	rejectedDisagree: number;
};

/** Licence gate: throws when any source is display-only (Google) or unknown. */
export function assertMeasurableSources(
	sources: readonly ObjectEvidenceSource[],
): void {
	for (const s of sources)
		if (!isMeasurableSource(s))
			throw new Error(
				`object prior: source "${s}" is display-only or unknown and cannot feed the split`,
			);
}

const agrees = (a: number, b: number, p: ObjectPriorParams): boolean =>
	Number.isFinite(a) &&
	Number.isFinite(b) &&
	Math.abs(a - b) <= Math.max(p.tolAbsM, p.tolRel * b);

/** Promote Far / Terrain cells that a measured object explains. Returns a new SplitResult; input untouched. */
export function applyObjectPrior(input: ObjectPriorInput): ObjectPriorResult {
	assertMeasurableSources(input.sources);
	const p = { ...DEFAULT_OBJECT_PRIOR, ...input.params };
	const { split, depth, anchor, K } = input;
	const { width: W, height: H } = split;
	const cls = Uint8Array.from(split.cls);
	const counts = [...split.counts];
	let fromFar = 0;
	let fromTerrain = 0;
	let rejected = 0;
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			const c = cls[k];
			if (c !== PixelClass.Far && c !== PixelClass.Terrain) continue;
			const dem = input.demGrid[k];
			if (!(dem > 0 && dem <= p.maxRange)) continue;
			if (!(input.objectHeight[k] >= p.minHeight)) continue;
			const z = modelDepth(depth, k);
			const model = Number.isNaN(z)
				? Number.NaN
				: anchoredRange(anchor, z * rayFactor(K, (i + 0.5) / W, (j + 0.5) / H));
			const tile = input.tileRange ? input.tileRange[k] : Number.NaN;
			if (!(agrees(model, dem, p) || agrees(tile, dem, p))) {
				rejected++;
				continue;
			}
			cls[k] = PixelClass.Object;
			counts[c]--;
			counts[PixelClass.Object]++;
			if (c === PixelClass.Far) fromFar++;
			else fromTerrain++;
		}
	return {
		split: { width: W, height: H, cls, counts },
		promotedFromFar: fromFar,
		promotedFromTerrain: fromTerrain,
		rejectedDisagree: rejected,
	};
}
