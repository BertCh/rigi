// Roadmap R5, pure part: which roll photos may anchor, which neighbours to try, and how a relative
// rotation becomes a SUGGESTION (never an accept). No DOM, no fetch: node-testable (propagate.check.ts).
//
// Rules (tools/nearfield/propagate/PREREG_DRAFT.txt §2, reports/roadmap.md "precision beats recall"):
//  - Anchor = a photo whose pose a person or the product accepted: 'saved' (user) or 'solved' by the roll
//    aligner. Never a propagated pose (no chaining). Ground truth only in the dev mode (?propagate=dev).
//  - Estimator = "rot" only (ALIKED+LightGlue pure-rotation RANSAC, tools/nearfield/propagate/service.py).
//  - Gate = PROPAGATE_GATE unchanged (src/lib/nearfield/propagate.ts). A gated result is still a
//    suggestion: kind "suggestion", provenance "propagated-suggestion", confidence never set.

import type { Pose } from "../../camera";
import { distanceM } from "../../geodesy";
import {
	type Mat3,
	mul3,
	overlapFraction,
	type PoseSuggestion,
	PROPAGATE_GATE,
	proposePose,
	relRFromPoses,
	rotAngleDeg,
	transpose3,
} from "../../nearfield/propagate";
import type { Roll, RollPhoto } from "../types";

export const PROVENANCE = "propagated-suggestion" as const;
/** Method tag stored with saveSolvedPose when the user accepts a suggestion. */
export const ACCEPTED_METHOD = PROVENANCE;

export type PropagateMode = "off" | "on" | "dev";

/** At most this many neighbours are sent to the estimator per anchor (nearest first). */
export const MAX_NEIGHBOURS = 8;
/**
 * Compass pre-filter: skip (mode "on") when the target's compass prior predicts no overlap with a margin
 * for phone-compass error. Only a skip, never a pass; dev mode runs the estimator anyway.
 */
export const COMPASS_MARGIN_DEG = 45;
/**
 * REPORT.txt post-hoc: pure-rotation bias ≈ baseline / matched-terrain distance (1.2–1.7° at 73 m, ~3 km).
 * Above this baseline a gated suggestion carries a parallax caution (the gate itself stays at 250 m).
 */
export const PARALLAX_CAUTION_M = 50;
export const PARALLAX_TERRAIN_M = 3000;

export type AnchorKind = "saved" | "solved" | "ground-truth";

/**
 * `solvedMethod` = loadSolvedPose(id)?.method (roll.ts), passed in so this file stays free of the
 * photo catalogue (virtual:photos) and runs under node.
 */
export function anchorKind(
	p: RollPhoto,
	mode: PropagateMode,
	solvedMethod: string | null,
): AnchorKind | null {
	if (mode === "off") return null;
	if (p.poseSource === "saved") return "saved";
	if (p.poseSource === "solved")
		// a pose the user took from a suggestion never anchors further suggestions (no chaining)
		return solvedMethod && solvedMethod !== ACCEPTED_METHOD ? "solved" : null;
	if (p.poseSource === "ground-truth" && mode === "dev") return "ground-truth";
	return null;
}

/** Targets: mode "on" = photos with only the EXIF prior; dev = every other photo (compared to its pose). */
export function isTarget(p: RollPhoto, mode: PropagateMode): boolean {
	if (mode === "off") return false;
	if (mode === "dev") return true;
	return p.poseSource === "prior";
}

export type Candidate = {
	target: RollPhoto;
	baselineM: number;
	dtS: number;
	/** Overlap of the anchor pose with the target's compass prior (null = target has no compass). */
	compassOverlap: number | null;
	compassDeltaDeg: number | null;
	/** Set when the pair is not sent to the estimator. */
	skip: string | null;
};

const aspect = (p: RollPhoto) => p.meta.width / p.meta.height;
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const hfov = (vfov: number, asp: number) =>
	(2 * Math.atan(Math.tan((vfov * Math.PI) / 360) * asp) * 180) / Math.PI;

/** Neighbours of an anchor worth trying, nearest (then closest in time) first, with skip reasons. */
export function candidatesFor(
	roll: Roll,
	anchor: RollPhoto,
	mode: PropagateMode,
	gate = PROPAGATE_GATE,
): Candidate[] {
	const out: Candidate[] = [];
	for (const t of roll.photos) {
		if (t.meta.id === anchor.meta.id || !isTarget(t, mode)) continue;
		const baselineM = distanceM(anchor.meta, t.meta);
		const dtS = Math.abs(
			(Date.parse(t.meta.takenAt) - Date.parse(anchor.meta.takenAt)) / 1000,
		);
		let compassOverlap: number | null = null;
		let compassDeltaDeg: number | null = null;
		if (t.meta.heading != null) {
			// the EXIF prior, as roll.ts priorPose
			const prior: Pose = {
				yaw: t.meta.heading,
				pitch: t.meta.pitch,
				roll: t.meta.roll,
				vfov: t.meta.vfov,
			};
			compassOverlap = overlapFraction(
				relRFromPoses(anchor.pose, prior),
				{ vfov: anchor.pose.vfov, aspect: aspect(anchor) },
				{ vfov: prior.vfov, aspect: aspect(t) },
			);
			compassDeltaDeg = wrap180(prior.yaw - anchor.pose.yaw);
		}
		let skip: string | null = null;
		if (baselineM > gate.maxBaselineM)
			skip = `baseline ${Math.round(baselineM)} m > ${gate.maxBaselineM} m`;
		else if (
			compassDeltaDeg != null &&
			Math.abs(compassDeltaDeg) >
				hfov(anchor.pose.vfov, aspect(anchor)) / 2 +
					hfov(t.meta.vfov, aspect(t)) / 2 +
					COMPASS_MARGIN_DEG &&
			mode !== "dev"
		)
			skip = `compass: no overlap expected (Δheading ${Math.round(compassDeltaDeg)}°)`;
		out.push({
			target: t,
			baselineM,
			dtS,
			compassOverlap,
			compassDeltaDeg,
			skip,
		});
	}
	out.sort((a, b) => a.baselineM - b.baselineM || a.dtS - b.dtS);
	// keep every skip row for the dev panel; cap only the rows that would hit the estimator
	let n = 0;
	for (const c of out)
		if (!c.skip && ++n > MAX_NEIGHBOURS)
			c.skip = `beyond the ${MAX_NEIGHBOURS} nearest neighbours`;
	return out;
}

/** What the relative-rotation service returns (tools/nearfield/propagate/service.py /relrot). */
export type RelRotResult = {
	method: "rot";
	relR: number[] | null;
	inliers: number;
	n: number;
	rmsPx: number | null;
	bwd: { relR: number[]; inliers: number; rmsPx: number | null } | null;
	fwdBwdDeg: number | null;
	sizeA: [number, number];
	sizeB: [number, number];
	seconds: number;
};

/** Angle of relR_CA · relR_BC · relR_AB (identity when the three estimates agree). */
export function cycleDeg(ab: Mat3, bc: Mat3, ac: Mat3): number {
	return rotAngleDeg(mul3(transpose3(ac), mul3(bc, ab)));
}

export type Proposal = {
	suggestion: PoseSuggestion | null;
	/** Why the estimator gave nothing (no relR). */
	error: string | null;
	/** Non-blocking notes shown next to a gated suggestion (parallax). */
	cautions: string[];
};

export function propose(
	anchor: RollPhoto,
	c: Candidate,
	r: RelRotResult,
	cycle?: number,
	gate = PROPAGATE_GATE,
): Proposal {
	if (!r.relR || r.relR.length !== 9)
		return {
			suggestion: null,
			error: `estimator: no rotation (${r.n} matches)`,
			cautions: [],
		};
	const t = c.target;
	const s = proposePose(
		anchor.pose,
		r.relR as Mat3,
		t.meta.vfov,
		{ a: r.sizeA[0] / r.sizeA[1], b: r.sizeB[0] / r.sizeB[1] },
		{
			method: r.method,
			inliers: r.inliers,
			rmsPx: r.rmsPx ?? undefined,
			fwdBwdDeg: r.fwdBwdDeg ?? undefined,
			cycleDeg: cycle,
			gravity: t.meta.gravity
				? { pitch: t.meta.pitch, roll: t.meta.roll }
				: null,
			baselineM: c.baselineM,
		},
		gate,
	);
	const cautions: string[] = [];
	if (c.baselineM > PARALLAX_CAUTION_M)
		cautions.push(
			`parallax: ${Math.round(c.baselineM)} m baseline ≈ ${((c.baselineM / PARALLAX_TERRAIN_M) * (180 / Math.PI)).toFixed(1)}° bias at ${PARALLAX_TERRAIN_M / 1000} km terrain`,
		);
	if (anchor.meta.vfov > 80 || t.meta.vfov > 80)
		cautions.push(
			"ultrawide lens: rot may carry a lens-model bias (REPORT.txt, 7059)",
		);
	return { suggestion: s, error: null, cautions };
}

/** Geodesic angle (deg) between two poses' rotations (dev comparison against the current pose). */
export function poseDeltaDeg(a: Pose, b: Pose): number {
	return rotAngleDeg(relRFromPoses(a, b));
}
