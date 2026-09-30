// GA5 (reports/geometry-first-pose.md G7): physical and visibility checks on a hypothesised eye, as a
// VETO only (guard-rail 2: eye priors are vetoes and tie-breaks, never pulls).
//
//   eye below ground   eye z < DEM(eye) − belowTolM: nobody photographs from inside the terrain
//                      (catches wrong-eye solves and GT eyes under a lake/slope, cf. 6958).
//   eye above ground   eye z − DEM(eye) > maxAboveGroundM (default off: towers, cable cars, drones).
//   eye vs DSM         reported (aboveDsmM) but not vetoed by default: under a tree canopy the eye is
//                      legitimately metres below the DSM (concord/occl/ndsm.ts nearHeightAt "dsm").
//   occlusion          every matched far point must be visible from the eye: a straight segment eye →
//                      point in the scene frame (curvature + refraction are folded into the frame's
//                      heights, as concord/cues/raycast.ts) is sampled at growing steps; the point is
//                      occluded when the DEM rises above the segment by more than tolM(s) = tolM0 +
//                      tolPerKm·s/1000 anywhere between minD and D − max(endMarginM, endFrac·D). The
//                      veto fires when the occluded fraction exceeds maxOccludedFrac over ≥ minPoints.
//
// Heights: HeightFn from concord/cues/raycast.ts (scene-frame z at (e, n), d = distance for the DEM
// level). The horizon-fast visibility.ts classifyPeak test is the same idea on (lon, lat); the scene-
// frame segment test is used here so the checker runs in the solver's own frame.
import type { HeightFn } from "../../concord/cues/raycast";
import type { Vec3 } from "../core";

export type ViewshedInput = {
	/** DEM, scene frame. */
	height: HeightFn;
	/** Optional surface model (buildings, trees), scene frame z at (e, n). */
	dsm?: (e: number, n: number) => number;
};

export type ViewshedOpts = {
	belowTolM?: number;
	maxAboveGroundM?: number;
	/** Veto when eye z − DSM < −this (m). Default off (Infinity). */
	dsmBelowTolM?: number;
	tolM0?: number;
	tolPerKm?: number;
	minD?: number;
	endMarginM?: number;
	endFrac?: number;
	maxOccludedFrac?: number;
	minPoints?: number;
	/** Cap on the points tested (evenly subsampled). Default 400. */
	maxPoints?: number;
};

export const VIEWSHED_DEFAULTS = {
	belowTolM: 1,
	maxAboveGroundM: Number.POSITIVE_INFINITY,
	dsmBelowTolM: Number.POSITIVE_INFINITY,
	tolM0: 2,
	tolPerKm: 1,
	minD: 30,
	endMarginM: 60,
	endFrac: 0.03,
	maxOccludedFrac: 0.2,
	minPoints: 10,
	maxPoints: 400,
};

export type ViewshedResult = {
	ok: boolean;
	reasons: string[];
	/** eye z − DEM at the eye (m). */
	aboveDemM: number;
	/** eye z − DSM at the eye (m), NaN without a DSM. */
	aboveDsmM: number;
	eyeBelowGround: boolean;
	/** Occluded fraction of the tested far points (NaN when fewer than minPoints). */
	occludedFrac: number;
	nTested: number;
	nOccluded: number;
};

/** True when the DEM blocks the straight segment eye → p (scene frame). */
export function segmentOccluded(
	height: HeightFn,
	eye: Vec3,
	p: Vec3,
	o: ViewshedOpts = {},
): boolean {
	const tol0 = o.tolM0 ?? VIEWSHED_DEFAULTS.tolM0;
	const tolK = o.tolPerKm ?? VIEWSHED_DEFAULTS.tolPerKm;
	const minD = o.minD ?? VIEWSHED_DEFAULTS.minD;
	const de = p[0] - eye[0];
	const dn = p[1] - eye[1];
	const D = Math.hypot(de, dn);
	const stop =
		D -
		Math.max(
			o.endMarginM ?? VIEWSHED_DEFAULTS.endMarginM,
			(o.endFrac ?? VIEWSHED_DEFAULTS.endFrac) * D,
		);
	if (!(stop > minD)) return false;
	const se = de / D;
	const sn = dn / D;
	for (let s = minD; s < stop; s += Math.max(5, 0.004 * s)) {
		const z = height(eye[0] + s * se, eye[1] + s * sn, s);
		if (!Number.isFinite(z)) continue;
		const rayZ = eye[2] + ((p[2] - eye[2]) * s) / D;
		if (z > rayZ + tol0 + (tolK * s) / 1000) return true;
	}
	return false;
}

/** Physical + visibility veto of an eye (scene frame) given matched far points (scene frame). */
export function viewshedVeto(
	inp: ViewshedInput,
	eye: Vec3,
	farPoints: Vec3[],
	o: ViewshedOpts = {},
): ViewshedResult {
	const reasons: string[] = [];
	const g = inp.height(eye[0], eye[1], 0);
	const aboveDemM = eye[2] - g;
	const aboveDsmM = inp.dsm ? eye[2] - inp.dsm(eye[0], eye[1]) : Number.NaN;
	const below = aboveDemM < -(o.belowTolM ?? VIEWSHED_DEFAULTS.belowTolM);
	if (below) reasons.push(`eye ${(-aboveDemM).toFixed(1)} m below the DEM`);
	const maxAbove = o.maxAboveGroundM ?? VIEWSHED_DEFAULTS.maxAboveGroundM;
	if (aboveDemM > maxAbove)
		reasons.push(`eye ${aboveDemM.toFixed(0)} m above the DEM > ${maxAbove}`);
	const dsmTol = o.dsmBelowTolM ?? VIEWSHED_DEFAULTS.dsmBelowTolM;
	if (Number.isFinite(aboveDsmM) && aboveDsmM < -dsmTol)
		reasons.push(`eye ${(-aboveDsmM).toFixed(1)} m below the DSM`);
	const maxPts = o.maxPoints ?? VIEWSHED_DEFAULTS.maxPoints;
	const stride = Math.max(1, farPoints.length / maxPts);
	let nT = 0;
	let nO = 0;
	for (let k = 0; k < farPoints.length; k += stride) {
		const p = farPoints[Math.floor(k)];
		if (!p.every(Number.isFinite)) continue;
		nT++;
		if (segmentOccluded(inp.height, eye, p, o)) nO++;
	}
	const minPts = o.minPoints ?? VIEWSHED_DEFAULTS.minPoints;
	const frac = nT >= minPts ? nO / nT : Number.NaN;
	const maxFrac = o.maxOccludedFrac ?? VIEWSHED_DEFAULTS.maxOccludedFrac;
	if (frac > maxFrac)
		reasons.push(
			`${(100 * frac).toFixed(0)}% of ${nT} matched points occluded > ${(100 * maxFrac).toFixed(0)}%`,
		);
	return {
		ok: reasons.length === 0,
		reasons,
		aboveDemM,
		aboveDsmM,
		eyeBelowGround: below,
		occludedFrac: frac,
		nTested: nT,
		nOccluded: nO,
	};
}
