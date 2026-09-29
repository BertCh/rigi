/**
 * Pose propagation within a viewpoint (Step Inside P2 exploration; tools/nearfield/propagate/REPORT.txt).
 *
 * An anchor photo A with an ACCEPTED pose proposes a pose for a neighbour B from the relative rotation
 * relR (A-camera → B-camera, OpenCV axes x right, y down, z forward):
 *
 *     R_B = relR · R_A,   R = world(ENU) → OpenCV camera = [right; −up; forward]
 *
 * (tools/research/tm/cache/FORMAT.md "Frames and conventions" = tools/matcher/common.py pose_to_R).
 *
 * The result is a SUGGESTION ONLY (`kind: "suggestion"`, never "accepted"): the frozen product accept rule
 * requires a preregistered, blind-verified validation (tools/nearfield/propagate/PREREG_DRAFT.txt) before
 * anything derived from this may be auto-accepted. Intended use: a seed / prior for the existing
 * DEM matcher or cascade, or a "looks like the photo next to it" hint the user confirms.
 *
 * Pure math, no DOM / three.js; the relative rotation comes from elsewhere (classical ALIKED+LightGlue
 * pure-rotation RANSAC was the only estimator whose error was both small and predictable in the study;
 * DA3 /multiview relative rotations had no usable confidence signal and are gated out by default).
 */
import { type Pose, poseBasis } from "../camera";

/** 3×3 row-major. */
export type Mat3 = [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
];

const D = Math.PI / 180;

/** World(ENU) → OpenCV camera rotation of a pose: rows right, −up, forward. */
export function poseToR(p: Pose): Mat3 {
	const { forward: f, right: r, up: u } = poseBasis(p);
	return [r[0], r[1], r[2], -u[0], -u[1], -u[2], f[0], f[1], f[2]];
}

/** Inverse of poseToR (mirror of tools/matcher/common.py R_to_pose); vfov passes through. */
export function rToPose(R: Mat3, vfov: number): Pose {
	const right = [R[0], R[1], R[2]];
	const f = [R[6], R[7], R[8]];
	const yaw = Math.atan2(f[0], f[1]);
	const pitch = Math.asin(Math.max(-1, Math.min(1, f[2])));
	const r0 = [Math.cos(yaw), -Math.sin(yaw), 0];
	// u0 = r0 × f
	const u0 = [
		r0[1] * f[2] - r0[2] * f[1],
		r0[2] * f[0] - r0[0] * f[2],
		r0[0] * f[1] - r0[1] * f[0],
	];
	const dot = (a: number[], b: number[]) =>
		a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	const roll = Math.atan2(-dot(right, u0), dot(right, r0));
	return {
		yaw: (((yaw / D) % 360) + 360) % 360,
		pitch: pitch / D,
		roll: roll / D,
		vfov,
	};
}

export function mul3(a: Mat3, b: Mat3): Mat3 {
	const o = new Array(9).fill(0) as Mat3;
	for (let i = 0; i < 3; i++)
		for (let j = 0; j < 3; j++) {
			let s = 0;
			for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
			o[i * 3 + j] = s;
		}
	return o;
}

export const transpose3 = (a: Mat3): Mat3 => [
	a[0],
	a[3],
	a[6],
	a[1],
	a[4],
	a[7],
	a[2],
	a[5],
	a[8],
];

/** Rotation angle of R in degrees. */
export function rotAngleDeg(R: Mat3): number {
	const c = (R[0] + R[4] + R[8] - 1) / 2;
	return Math.acos(Math.max(-1, Math.min(1, c))) / D;
}

/** Relative rotation A-camera → B-camera from two world poses (for tests / cycle checks). */
export const relRFromPoses = (a: Pose, b: Pose): Mat3 =>
	mul3(poseToR(b), transpose3(poseToR(a)));

/**
 * Fraction of A's image (a coarse grid) whose rays land inside B under a pure rotation.
 * Aspect = W/H of each image; square pixels, centred principal point.
 */
export function overlapFraction(
	relR: Mat3,
	a: { vfov: number; aspect: number },
	b: { vfov: number; aspect: number },
): number {
	const ta = Math.tan((a.vfov * D) / 2);
	const tb = Math.tan((b.vfov * D) / 2);
	let n = 0;
	let inside = 0;
	for (let j = 0; j < 12; j++)
		for (let i = 0; i < 16; i++) {
			const x = (((i + 0.5) / 16) * 2 - 1) * ta * a.aspect;
			const y = (((j + 0.5) / 12) * 2 - 1) * ta;
			const bx = relR[0] * x + relR[1] * y + relR[2];
			const by = relR[3] * x + relR[4] * y + relR[5];
			const bz = relR[6] * x + relR[7] * y + relR[8];
			n++;
			if (bz <= 1e-6) continue;
			if (Math.abs(bx / bz) <= tb * b.aspect && Math.abs(by / bz) <= tb)
				inside++;
		}
	return inside / n;
}

/**
 * Evidence that came with relR. `inliers` and `rmsPx` are REQUIRED to pass (missing = fail); the
 * consistency checks (fwdBwd, cycle, gravity, baseline) are applied only when supplied.
 */
export type RelRotationEvidence = {
	/** "rot" = ALIKED+LightGlue + pure-rotation RANSAC (recommended); "ess" = essential matrix; "da3" = /multiview. */
	method: "rot" | "ess" | "da3";
	/** RANSAC inliers of the pure-rotation model. */
	inliers?: number;
	/** Inlier reprojection RMS in px at a 1024 px long side. */
	rmsPx?: number;
	/** Angle (deg) of relR_BA·relR_AB, i.e. the forward/backward disagreement (estimate B→A as well). */
	fwdBwdDeg?: number;
	/** Angle (deg) of a triplet cycle relR_CA·relR_BC·relR_AB, when a third overlapping photo exists. */
	cycleDeg?: number;
	/** Target's own gravity (phone EXIF/motion) pitch & roll, deg, if known. */
	gravity?: { pitch: number; roll: number } | null;
	/** Metres between A and B (GPS), if known. */
	baselineM?: number | null;
};

/**
 * The gate, derived from tools/nearfield/propagate/results.json (dev data only: the GT viewpoint
 * pairs + pure-rotation synthetic pairs from GT-12 and wild DEV photos). See REPORT.txt for the
 * precision/recall behind each number. NOT validated on held-out data (PREREG_DRAFT.txt).
 */
export const PROPAGATE_GATE = {
	methods: ["rot"] as const,
	/**
	 * Wrong pairs (60 different-place pairs, 14 real non-overlapping viewpoint pairs, 9 synthetic
	 * non-overlapping) had ≤ 11 inliers; every pair with ≥ 15 inliers was within 5° (≤ 0.13° on
	 * synthetic). 40 keeps a ~4× margin over the worst wrong pair.
	 */
	minInliers: 40,
	/** Gated pairs: real 2.3–2.6 px, synthetic ≤ 1.4 px (at 1024 px long side). */
	maxRmsPx: 3.5,
	minOverlap: 0.1,
	/**
	 * Weak signal: with the same matcher, B→A is nearly the exact inverse of A→B even when wrong
	 * (observed 0.0° on wrong synthetic pairs). Real pairs 0.02–0.61°. Kept as a sanity check only.
	 */
	maxFwdBwdDeg: 1.5,
	/** Real 7059/7063/7068 triplet: 0.63° / 0.99°. */
	maxCycleDeg: 1.5,
	/** Only checked when target gravity is known. Real gated pairs: |Δpitch| ≤ 2.2°, |Δroll| ≤ 1.8°. */
	maxGravityPitchDeg: 3,
	maxGravityRollDeg: 3,
	/** Untested beyond this (real overlapping pairs were 7–74 m apart): parallax breaks pure rotation. */
	maxBaselineM: 250,
	/**
	 * Search radius (deg) for using the suggestion as a matcher seed. Gated real viewpoint pairs erred
	 * 1.5–3.7° vs "approx" GT (median 2.2°; GT noise and parallax not separable with n = 6);
	 * synthetic pure rotation median 0.015°, max 0.13°.
	 */
	seedRadiusDeg: 5,
};

export type PoseSuggestion = {
	kind: "suggestion";
	pose: Pose;
	/** true = passed PROPAGATE_GATE; still a suggestion, never an accept. */
	gated: boolean;
	reasons: string[];
	overlap: number;
	/** Suggested search radius (deg) if used as a seed for the DEM matcher/cascade. */
	seedRadiusDeg: number;
	source: { anchorPose: Pose; method: RelRotationEvidence["method"] };
};

/**
 * Propose B's pose from an accepted anchor pose and relR (A-camera → B-camera, OpenCV axes).
 * `targetVfov` is B's own vfov (EXIF / focal estimate); `aspects` are W/H of A and B.
 */
export function proposePose(
	anchorPose: Pose,
	relR: Mat3,
	targetVfov: number,
	aspects: { a: number; b: number },
	evidence: RelRotationEvidence,
	gate = PROPAGATE_GATE,
): PoseSuggestion {
	const pose = rToPose(mul3(relR, poseToR(anchorPose)), targetVfov);
	const overlap = overlapFraction(
		relR,
		{ vfov: anchorPose.vfov, aspect: aspects.a },
		{ vfov: targetVfov, aspect: aspects.b },
	);
	const reasons: string[] = [];
	if (!(gate.methods as readonly string[]).includes(evidence.method))
		reasons.push(`method ${evidence.method} not trusted`);
	if (!(evidence.inliers !== undefined && evidence.inliers >= gate.minInliers))
		reasons.push(`inliers ${evidence.inliers ?? "?"} < ${gate.minInliers}`);
	if (!(evidence.rmsPx !== undefined && evidence.rmsPx <= gate.maxRmsPx))
		reasons.push(`rms ${evidence.rmsPx?.toFixed(2) ?? "?"} > ${gate.maxRmsPx}`);
	if (overlap < gate.minOverlap)
		reasons.push(`overlap ${overlap.toFixed(2)} < ${gate.minOverlap}`);
	if (
		evidence.fwdBwdDeg !== undefined &&
		evidence.fwdBwdDeg > gate.maxFwdBwdDeg
	)
		reasons.push(
			`fwd/bwd ${evidence.fwdBwdDeg.toFixed(2)} > ${gate.maxFwdBwdDeg}`,
		);
	if (evidence.cycleDeg !== undefined && evidence.cycleDeg > gate.maxCycleDeg)
		reasons.push(`cycle ${evidence.cycleDeg.toFixed(2)} > ${gate.maxCycleDeg}`);
	if (evidence.gravity) {
		const dp = pose.pitch - evidence.gravity.pitch;
		const dr = ((pose.roll - evidence.gravity.roll + 540) % 360) - 180;
		if (Math.abs(dp) > gate.maxGravityPitchDeg)
			reasons.push(`gravity pitch off ${dp.toFixed(1)}°`);
		if (Math.abs(dr) > gate.maxGravityRollDeg)
			reasons.push(`gravity roll off ${dr.toFixed(1)}°`);
	}
	if (evidence.baselineM != null && evidence.baselineM > gate.maxBaselineM)
		reasons.push(
			`baseline ${Math.round(evidence.baselineM)} m > ${gate.maxBaselineM} m`,
		);
	return {
		kind: "suggestion",
		pose,
		gated: reasons.length === 0,
		reasons,
		overlap,
		seedRadiusDeg: gate.seedRadiusDeg,
		source: { anchorPose, method: evidence.method },
	};
}
