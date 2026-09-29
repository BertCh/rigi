// Acceptance gate for the joint solve (WP-D). The pose never moves unless:
//   - the skyline RMS stays ≤ before + 0.5 px (and its inlier fraction does not collapse),
//   - the cues themselves fit no worse,
//   - the eye stays within 3σH of the start and the focal within 4σ of its prior,
//   - HOLDOUT evidence improves: held-out pins (callback) or, without pins, a 2-fold spatial
//     cross-check on the cues (fit on one half of the image, score the other half, both ways),
//   - no holdout p90 regresses by more than 1 px.
// k1 is only ever freed with ≥ 6 corner cues (enforced in joint.ts, reported here).
import type { CameraX } from "../core";
import {
	cueResidualPx,
	type JointCue,
	type JointInput,
	type JointOpts,
	type JointResult,
	solveJoint,
} from "./joint";

/** Held-out score of a camera: median px, optionally with p90. */
export type HoldoutScore =
	| number
	| { medPx: number; p90Px?: number; n?: number };

export type GateOpts = {
	skylineTolPx?: number;
	inlierFracTol?: number;
	cueTolPx?: number;
	maxShiftSigmaH?: number;
	maxFocalZ?: number;
	/** Required held-out median gain (px, > 0 means strictly better by this much). Default 0. */
	minHoldoutGainPx?: number;
	p90TolPx?: number;
};

export const GATE_DEFAULTS: Required<GateOpts> = {
	skylineTolPx: 0.5,
	inlierFracTol: 0.05,
	cueTolPx: 0.05,
	maxShiftSigmaH: 3,
	maxFocalZ: 4,
	minHoldoutGainPx: 0,
	p90TolPx: 1,
};

export type CrossCheck = {
	pass: boolean;
	folds: { nTrain: number; nTest: number; beforePx: number; afterPx: number }[];
	reason: string;
};

const asScore = (s: HoldoutScore) =>
	typeof s === "number" ? { medPx: s, p90Px: undefined } : s;

/**
 * Gate a joint result. `holdout` scores a camera on data the solve did not see (median px, lower is
 * better). Without `holdout` the result must carry cross-check evidence (`extra.crossCheck`), else it
 * is rejected: no holdout evidence ⇒ no move.
 */
export function gate(
	r: JointResult,
	holdout?: (cam: CameraX) => HoldoutScore,
	extra: { crossCheck?: CrossCheck; opts?: GateOpts } = {},
): JointResult {
	const o = { ...GATE_DEFAULTS, ...(extra.opts ?? {}) };
	const reasons = [...r.reasons];
	let ok = r.accepted;
	const fail = (why: string) => {
		ok = false;
		reasons.push(`REJECT ${why}`);
	};
	if (!Number.isFinite(r.skylineRmsAfter)) fail("no skyline after");
	else if (r.skylineRmsAfter > r.skylineRmsBefore + o.skylineTolPx)
		fail(
			`skyline ${r.skylineRmsBefore.toFixed(2)} → ${r.skylineRmsAfter.toFixed(2)} px (> +${o.skylineTolPx})`,
		);
	if (r.skylineInlierAfter < r.skylineInlierBefore - o.inlierFracTol)
		fail(
			`skyline inliers ${r.skylineInlierBefore.toFixed(2)} → ${r.skylineInlierAfter.toFixed(2)}`,
		);
	if (
		Number.isFinite(r.cueRmsBefore) &&
		r.cueRmsAfter > r.cueRmsBefore + o.cueTolPx
	)
		fail(
			`cue rms ${r.cueRmsBefore.toFixed(2)} → ${r.cueRmsAfter.toFixed(2)} px`,
		);
	if (r.eyeShiftSigmaH > o.maxShiftSigmaH)
		fail(`eye shift ${r.eyeShiftSigmaH.toFixed(1)}σH`);
	if (Math.abs(r.focalZ) > o.maxFocalZ)
		fail(`focal ${r.focalZ.toFixed(1)}σ from prior`);
	if (holdout) {
		const b = asScore(holdout(r.cam0));
		const a = asScore(holdout(r.cam));
		reasons.push(
			`holdout median ${b.medPx.toFixed(2)} → ${a.medPx.toFixed(2)} px${b.p90Px !== undefined && a.p90Px !== undefined ? `, p90 ${b.p90Px.toFixed(2)} → ${a.p90Px.toFixed(2)}` : ""}`,
		);
		if (!(a.medPx < b.medPx - o.minHoldoutGainPx))
			fail("holdout median did not improve");
		if (
			b.p90Px !== undefined &&
			a.p90Px !== undefined &&
			a.p90Px > b.p90Px + o.p90TolPx
		)
			fail(`holdout p90 regressed by > ${o.p90TolPx} px`);
	} else if (extra.crossCheck) {
		reasons.push(`cross-check: ${extra.crossCheck.reason}`);
		if (!extra.crossCheck.pass) fail("cue cross-check did not improve");
	} else fail("no holdout evidence");
	return { ...r, accepted: ok, reasons };
}

/** Held-out cue score (median |px|) of a camera; edge cues use the given edge offset. */
export function cueScore(
	cam: CameraX,
	cues: JointCue[],
	edgeBias: number,
	frame?: JointInput["frame"],
): number {
	const v: number[] = [];
	for (const c of cues) {
		const r = cueResidualPx(cam, c, c.kind === "edge" ? edgeBias : 0, frame);
		const m = Math.hypot(...r);
		if (Number.isFinite(m)) v.push(m);
	}
	v.sort((a, b) => a - b);
	if (!v.length) return Number.NaN;
	const k = v.length >> 1;
	return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
}

const medianOf = (a: number[]) => {
	const s = a.filter(Number.isFinite).sort((x, y) => x - y);
	return s.length ? s[s.length >> 1] : 0;
};

/**
 * 2-fold spatial cross-check: cues split on a 4×4 image checkerboard; fit on one colour, score the
 * other (median |px|) at cam0 and at the fit, both ways. Pass iff the summed held-out score drops and
 * neither fold gets worse by more than `tolPx`. Pins (source "pin") always stay in training.
 */
export async function cueCrossCheck(
	inp: JointInput,
	opts: JointOpts = {},
	o: { minTest?: number; tolPx?: number; tiles?: number } = {},
): Promise<CrossCheck> {
	const tiles = o.tiles ?? 4;
	const minTest = o.minTest ?? 10;
	const tol = o.tolPx ?? 0.25;
	const foldOf = (c: JointCue) =>
		(Math.floor(c.u * tiles) + Math.floor(c.v * tiles)) % 2;
	const folds: CrossCheck["folds"] = [];
	for (const k of [0, 1]) {
		const test = inp.cues.filter(
			(c) => !c.source.startsWith("pin") && foldOf(c) === k,
		);
		const train = inp.cues.filter(
			(c) => c.source.startsWith("pin") || foldOf(c) !== k,
		);
		if (test.length < minTest)
			return {
				pass: false,
				folds,
				reason: `fold ${k}: ${test.length} test cues < ${minTest}`,
			};
		const r = await solveJoint({ ...inp, cues: train }, opts);
		const b0 = medianOf(
			train
				.filter((c) => c.kind === "edge")
				.map((c) => cueResidualPx(inp.cam0, c, 0, inp.frame)[0]),
		);
		folds.push({
			nTrain: train.length,
			nTest: test.length,
			beforePx: cueScore(inp.cam0, test, b0, inp.frame),
			afterPx: cueScore(r.cam, test, r.edgeBiasPx, inp.frame),
		});
	}
	const sb = folds.reduce((a, f) => a + f.beforePx, 0);
	const sa = folds.reduce((a, f) => a + f.afterPx, 0);
	const worse = folds.some((f) => f.afterPx > f.beforePx + tol);
	const txt = folds
		.map(
			(f, i) =>
				`f${i} ${f.beforePx.toFixed(2)}→${f.afterPx.toFixed(2)} (n ${f.nTest})`,
		)
		.join(", ");
	return {
		pass: sa < sb && !worse,
		folds,
		reason: `${txt}${worse ? "; a fold got worse" : ""}`,
	};
}
