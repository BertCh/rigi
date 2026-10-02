// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Meadow-slab diagnosis (research_notes/completion_integration_2026-09.md §1.4 "Meadow slabs with gaps" and
// §2.6a). Near-camera ground that the split wrongly classed Object is lifted as flattened discs; at grazing
// incidence the capped in-plane stretch leaves rows of discs apart, the "slabs". The fix is to hand those cells
// back to the exact DEM drape (Terrain), not to complete anything.
//
// A cell is a slab cell when ALL of:
//   - it is Object and not protected (e.g. the people mask);
//   - its ray looks down (ENU dir.z < -minDownSlope) and the model point lies between minBelowEyeM and
//     maxBelowEyeM below the eye, within maxRangeM;
//   - the model normal, oriented towards the camera, points up (ENU z >= minUpNormal) when normals exist;
//   - the model point is DEM-consistent: |vertical gap between the model point and the DEM point on the same
//     ray| <= maxVerticalGapM.
// Provenance: reclassifying and removing splats drops OBSERVED data, nothing is invented; surviving splats
// keep their provenance. Pure and deterministic.
import { type IntrinsicsNorm, rayFactor } from "../geom";
import { PixelClass, type SplitResult } from "../types";

export type SlabParams = {
	/** Farthest model range (m) considered "near camera". Default 40. */
	maxRangeM?: number;
	/** Model point at most this far below the eye (m). Default 8. */
	maxBelowEyeM?: number;
	/** ... and at least this far (m), so head-height content is never ground. Default 0.2. */
	minBelowEyeM?: number;
	/** Camera-facing model normal's ENU up component at least this. Default 0.8 (about 37 degrees of tilt). */
	minUpNormal?: number;
	/** Max vertical gap (m) between the model point and the DEM point on the ray. Default 1. */
	maxVerticalGapM?: number;
	/** Rays at least this steep downward (-dir.z). Default 0.02. */
	minDownSlope?: number;
};

export const DEFAULT_SLAB: Required<SlabParams> = {
	maxRangeM: 40,
	maxBelowEyeM: 8,
	minBelowEyeM: 0.2,
	minUpNormal: 0.8,
	maxVerticalGapM: 1,
	minDownSlope: 0.02,
};

export type SlabInput = {
	split: SplitResult;
	/** DEM ray length (m) per cell, NaN = none (geom.sampleDemGrid). */
	demGrid: ArrayLike<number>;
	/** Model ray length (m) per cell after anchoring, NaN = invalid. */
	modelRange: ArrayLike<number>;
	/** Model normals in the camera frame (3 per cell), if the depth model gave them. */
	normals?: ArrayLike<number>;
	/** Camera -> ENU rotation, row-major 3x3 (lift.camToEnuMatrix). */
	camToEnu: ArrayLike<number>;
	K: IntrinsicsNorm;
	/** 1 = never reclassify (people mask). */
	protect?: ArrayLike<number>;
};

export type SlabDiagnosis = {
	/** 1 on cells diagnosed as near-camera ground wrongly classed Object. */
	mask: Uint8Array;
	/** Cells in `mask`. */
	count: number;
	/** Object cells in the split. */
	objectCount: number;
	/** count / objectCount (0 when no Object). */
	fraction: number;
	/** Whether the normal test ran (false: the depth model gave no normals). */
	usedNormals: boolean;
};

/** Find the slab cells. Reads the inputs only. */
export function diagnoseGroundSlabs(
	input: SlabInput,
	params: SlabParams = {},
): SlabDiagnosis {
	const p = { ...DEFAULT_SLAB, ...params };
	const { width: W, height: H, cls } = input.split;
	const m = input.camToEnu;
	const mask = new Uint8Array(W * H);
	const nrm = input.normals && input.normals.length >= 3 * W * H;
	let count = 0;
	let objectCount = 0;
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			if (cls[k] !== PixelClass.Object) continue;
			objectCount++;
			if (input.protect?.[k]) continue;
			const range = input.modelRange[k];
			const dem = input.demGrid[k];
			if (!(range > 0 && range <= p.maxRangeM) || !(dem > 0)) continue;
			const u = (i + 0.5) / W;
			const v = (j + 0.5) / H;
			const cx = (u - input.K.cx) / input.K.fx;
			const cy = (v - input.K.cy) / input.K.fy;
			const f = rayFactor(input.K, u, v); // = sqrt(1 + cx^2 + cy^2)
			const dx = cx / f;
			const dy = cy / f;
			const dz = 1 / f;
			const dirUp = m[6] * dx + m[7] * dy + m[8] * dz;
			if (!(dirUp < -p.minDownSlope)) continue;
			const below = -range * dirUp;
			if (below < p.minBelowEyeM || below > p.maxBelowEyeM) continue;
			if (Math.abs((dem - range) * dirUp) > p.maxVerticalGapM) continue;
			if (nrm) {
				const n = input.normals as ArrayLike<number>;
				let nx = n[3 * k];
				let ny = n[3 * k + 1];
				let nz = n[3 * k + 2];
				const nl = Math.hypot(nx, ny, nz);
				if (!(nl > 1e-6)) continue;
				nx /= nl;
				ny /= nl;
				nz /= nl;
				// orient towards the camera (against the ray)
				if (nx * dx + ny * dy + nz * dz > 0) {
					nx = -nx;
					ny = -ny;
					nz = -nz;
				}
				const up = m[6] * nx + m[7] * ny + m[8] * nz;
				if (!(up >= p.minUpNormal)) continue;
			}
			mask[k] = 1;
			count++;
		}
	return {
		mask,
		count,
		objectCount,
		fraction: objectCount ? count / objectCount : 0,
		usedNormals: !!nrm,
	};
}

/** A copy of the split with the diagnosed cells Terrain (counts recomputed). */
export function reclassifySlabs(
	split: SplitResult,
	mask: ArrayLike<number>,
): SplitResult {
	const cls = split.cls.slice();
	const counts = split.counts.slice();
	for (let k = 0; k < cls.length; k++)
		if (mask[k] && cls[k] === PixelClass.Object) {
			cls[k] = PixelClass.Terrain;
			counts[PixelClass.Object]--;
			counts[PixelClass.Terrain]++;
		}
	return { width: split.width, height: split.height, cls, counts };
}
