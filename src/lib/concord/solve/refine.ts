// concordRefine: the one call the pipeline makes behind ?concord=solve (WP-D). It never runs at LOW
// pose confidence; it extracts cues at the current camera (WP-C, plus WP-G inliers if the caller has
// them), solves the joint problem, re-extracts at the refined camera (the cue search window is only
// ±12 px) and solves again, then gates the result. The caller writes ctx.cam's pose/eye only when
// `accepted` is true; otherwise `cam` is ctx.cam unchanged.
import type {
	EyeHorizon,
	HorizonsAtEyes,
	SkylineSample,
} from "../../pose6dof/eye";
import type { CameraX } from "../core";
import { isLowConfidence, type PoseConfidence } from "../field/fit";
import type { EyePrior } from "../priors/altitude";
import {
	type CrossCheck,
	cueCrossCheck,
	type GateOpts,
	gate,
	type HoldoutScore,
} from "./gate";
import {
	type JointCue,
	type JointFree,
	type JointInput,
	type JointOpts,
	type JointResult,
	solveJoint,
} from "./joint";

export type ConcordRefineCtx = {
	/** Current (skyline-solved) camera; its eye is in the frame of the horizons, cues and prior. */
	cam: CameraX;
	confidence: PoseConfidence | null | undefined;
	eyePrior: EyePrior;
	/** Near DEM in the camera frame, absolute (e, n) → z (optional; see JointInput.ground). */
	ground?: (e: number, n: number) => number;
	skyline: SkylineSample[];
	horizonsAtEyes: HorizonsAtEyes;
	focal: JointInput["focal"];
	/** Cues observed at a camera (WP-C extractCues at that camera, plus any fixed WP-G inliers). */
	cuesAt: (cam: CameraX) => JointCue[] | Promise<JointCue[]>;
	free?: Partial<JointFree>;
	frame?: JointInput["frame"];
	/** Extraction + solve rounds (default 2). */
	rounds?: number;
	/** Held-out pins scorer, if any; otherwise the 2-fold cue cross-check is the holdout evidence. */
	holdout?: (cam: CameraX) => HoldoutScore;
	opts?: JointOpts;
	gateOpts?: GateOpts;
};

export type ConcordRefineOut = {
	/** The camera to use: the refined one if accepted, else ctx.cam. */
	cam: CameraX;
	accepted: boolean;
	reasons: string[];
	result: JointResult | null;
	/** Per-round raw solutions (before gating). */
	rounds: { nCues: number; cam: CameraX; cueRmsAfter: number }[];
	crossCheck?: CrossCheck;
	/** Cues of the last round (for the display field, WP-E). */
	cues: JointCue[];
	ms: number;
};

/**
 * Memoising wrapper for a horizon provider: eyes are keyed at `quantumM` (the solver already
 * quantises its requests), so repeated linearisations cost nothing.
 */
export function cachedHorizons(
	h: HorizonsAtEyes,
	quantumM = 0.25,
	max = 256,
): HorizonsAtEyes {
	const memo = new Map<string, EyeHorizon>();
	const key = (e: number[]) => e.map((x) => Math.round(x / quantumM)).join(",");
	return async (eyes) => {
		const miss = eyes.filter((e) => !memo.has(key(e)));
		const uniq = [...new Map(miss.map((e) => [key(e), e])).values()];
		if (uniq.length) {
			const got = await h(uniq);
			uniq.forEach((e, i) => {
				if (memo.size >= max) memo.delete(memo.keys().next().value as string);
				memo.set(key(e), got[i]);
			});
		}
		return eyes.map((e) => memo.get(key(e)) as EyeHorizon);
	};
}

export async function concordRefine(
	ctx: ConcordRefineCtx,
): Promise<ConcordRefineOut> {
	const t0 = Date.now();
	const none = (why: string): ConcordRefineOut => ({
		cam: ctx.cam,
		accepted: false,
		reasons: [why],
		result: null,
		rounds: [],
		cues: [],
		ms: Date.now() - t0,
	});
	if (isLowConfidence(ctx.confidence)) return none("pose confidence LOW");
	if (ctx.skyline.length < 20) return none("too few skyline samples");
	const horizonsAtEyes = cachedHorizons(ctx.horizonsAtEyes);
	const free: JointFree = {
		eye: true,
		fScale: true,
		k1: false,
		...(ctx.free ?? {}),
	};
	const rounds: ConcordRefineOut["rounds"] = [];
	let cur = ctx.cam;
	let res: JointResult | null = null;
	let inp: JointInput | null = null;
	let cues: JointCue[] = [];
	for (let k = 0; k < (ctx.rounds ?? 2); k++) {
		cues = await ctx.cuesAt(cur);
		inp = {
			cam0: ctx.cam,
			start: cur,
			eyePrior: ctx.eyePrior,
			ground: ctx.ground,
			skyline: ctx.skyline,
			horizonsAtEyes,
			cues,
			focal: ctx.focal,
			free,
			frame: ctx.frame,
		};
		res = await solveJoint(inp, ctx.opts);
		rounds.push({
			nCues: cues.length,
			cam: res.cam,
			cueRmsAfter: res.cueRmsAfter,
		});
		cur = res.cam;
	}
	if (!res || !inp) return none("no rounds");
	let crossCheck: CrossCheck | undefined;
	if (!ctx.holdout) crossCheck = await cueCrossCheck(inp, ctx.opts);
	const g = gate(res, ctx.holdout, { crossCheck, opts: ctx.gateOpts });
	return {
		cam: g.accepted ? g.cam : ctx.cam,
		accepted: g.accepted,
		reasons: g.reasons,
		result: g,
		rounds,
		crossCheck,
		cues,
		ms: Date.now() - t0,
	};
}
