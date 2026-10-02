// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Render-and-match escalation, in the browser: the former optional Python service (tools/matcher/server,
// :8765) now runs on the page's own engine and GPU (src/lib/matcher). The API is unchanged for callers:
// everything degrades to `false` / `null` when the matcher is unavailable (no engine bound, keypoint
// models missing); nothing here throws. "Busy" means another match job is running in this page.
import type { Pose } from "./camera";
import { levelOf } from "./ontology/core/confidence";

/** The matcher (solvers, GPU kernels, keypoint models) loads on first use, off the workspace's critical path. */
const service = () => import("./matcher/service");
const HEALTH_TTL_OK_MS = 60_000;
const HEALTH_TTL_DOWN_MS = 15_000;

export type MatchView = {
	tag: string;
	pose: Pose;
	W: number;
	H: number;
	/** satellite-style colour render, W×H */
	rgb: Blob;
	/** ENU xyz in the engine frame, H×W×3, rows top→bottom, sky = 0 */
	xyz: Float32Array;
};

/** The app's skyline evidence (engine.horizonDirs, engine.edge.{fine,fg,sky} after autoAlign) for the fused solve. */
export type SkylineCueInput = {
	w: number;
	h: number;
	/** skyline pose after the app's acceptance rule */
	pose: Pose;
	confidence?: number | null;
	accepted?: string;
	horizon: Float32Array;
	fine: Float32Array;
	fg: Float32Array;
	sky: Float32Array;
};

type Common = {
	prior: Pose;
	/** false = v0.1 behaviour (render-match only, heuristic confidence). Default true (fused). */
	fused?: boolean;
	freeFocal?: boolean;
};

export type MatchRequest =
	/** the bound engine (showing `photoId`) renders the views and exports the skyline cue itself */
	| (Common & { photoId: string; offsets?: number[] })
	/** caller supplies the photo and pre-rendered views; skyline cue from `skyline`, else exported for `photoId`, else none */
	| (Common & {
			photo: Blob;
			eye: [number, number, number];
			views: MatchView[];
			skyline?: SkylineCueInput;
			photoId?: string;
	  })
	/**
	 * ad-hoc photo (src/lib/matcher/pipeline.ts matchAdhoc, the former app.py match_adhoc): the bound engine
	 * renders the views from the photo's position; unknown prior fields are simply omitted (two-stage 360°
	 * sweep when yaw is missing; ?matcherPolicy=t6 for the T6 search)
	 */
	| (Omit<Common, "prior"> & {
			photo: Blob;
			meta: {
				lat: number;
				lon: number;
				altitudeM: number | null;
				/** "exif-gps" (trusted) or e.g. "manual": anything else turns on the basin-gap LOW check */
				positionSource?: string;
			};
			prior: Partial<Pick<Pose, "yaw" | "pitch" | "roll" | "vfov">>;
			/** position uncertainty (m); > 50 turns on the basin-gap LOW check (like a non-GPS positionSource) */
			positionUncertainM?: number;
			/**
			 * search hints for stage 1 (e.g. the cascade's rejected candidate): each is tried first with a local
			 * render + match; ≥ 30 consistent inliers skips the 360° sweep. Never changes the confidence rule.
			 */
			yawSeeds?: number[];
			poseSeeds?: (Pick<Pose, "yaw"> &
				Partial<Pick<Pose, "pitch" | "roll" | "vfov">>)[];
	  });

export type MatchResult = {
	/** fused pose (method "fused"), or the render-match pose */
	pose: Pose;
	/** match statistics at `pose` (inliers = lifted matches within 6 px) */
	inliers: number;
	inlierFrac: number;
	nLifted: number;
	residualPx: number | null;
	/** fraction of a 4×3 photo grid with ≥ 3 inliers */
	coverage: number;
	/** 0.9 when confidenceLevel is "high", 0.2 when "low"; with fused:false the v0.1 0..1 heuristic */
	confidence: number;
	deltaYawFromPrior: number;
	timingMs: Record<string, number | boolean>;
	version: string;
	/** "fused" (skyline + render-match), or "render-match" (fused:false, or no skyline cue) */
	method?: "fused" | "render-match";
	/** a-priori rule (reports/fusion.md): high iff cueAgreeDeg < 1 and skylineMedPx < 4 and matchSupport ≥ 0.3 */
	confidenceLevel?: "high" | "low";
	confidenceChecks?: {
		cueAgreeDeg: number | null;
		skylineMedPx: number | null;
		matchSupport: number | null;
		/** ad-hoc requests with an untrusted position only: position-grid basin gap; < 0.2 forces "low" */
		basinGap?: number | null;
		positionTrusted?: boolean;
	};
	/** why a fused pose was forced to "low" beyond the three checks (e.g. "basinGap") */
	lowReason?: string;
	cues?: {
		skyline: {
			pose: Pose;
			residualPx: number | null;
			appConfidence?: number | null;
			accepted?: string;
		} | null;
		match: { pose: Pose; inliers: number; residualPx: number | null } | null;
	};
	/** exp(−agree/1°)·exp(−skyMed/4 px)·min(1, support/0.3), a monotone summary of the checks */
	fusionScore?: number;
	/** the v0.1 render-match heuristic, kept for reference */
	matchConfidence?: number;
	skylineUnavailable?: string;
};

/** The service's own verdict: HIGH (fused) or, with fused:false, the v0.1 heuristic. Not enough on its own to apply a pose. */
export const matchIsConfident = (m: MatchResult) =>
	m.confidenceLevel
		? m.confidenceLevel === "high"
		: levelOf("matcher-v01", m.confidence) === "high";

/** Agreement tolerance between the match and the app's skyline cascade for the product rule. */
export const MATCH_AGREE_DEG = 0.5;

/**
 * Product accept rule: apply a match only when it is HIGH AND (the position is a trusted EXIF GPS fix, OR the
 * app's own skyline cascade landed within 0.5° of it). Everything else is shown as unverified ("check this").
 * Wild benchmark test set (reports/test-results.md): 11/11 correct on the current service, 15/17 (2 unsure)
 * with T6, where bare HIGH also let through untrusted-position poses with no independent check.
 * `cascadePose` is the cascade's final pose whether or not it accepted (as in the benchmark).
 */
export function matchAccepted(
	m: MatchResult,
	ctx: { positionTrusted: boolean; cascadePose?: Pose | null },
): boolean {
	if (!matchIsConfident(m)) return false;
	if (m.confidenceChecks?.positionTrusted ?? ctx.positionTrusted) return true;
	const c = ctx.cascadePose;
	return (
		!!c &&
		angDist(c.yaw, m.pose.yaw) <= MATCH_AGREE_DEG &&
		Math.abs(c.pitch - m.pose.pitch) <= MATCH_AGREE_DEG
	);
}

let health: { ok: boolean; at: number } | null = null;
let healthInFlight: Promise<boolean> | null = null;

/** Cached availability: an engine is bound and the keypoint models load. */
export function matcherAvailable(force = false): Promise<boolean> {
	const now = Date.now();
	if (
		!force &&
		health &&
		now - health.at < (health.ok ? HEALTH_TTL_OK_MS : HEALTH_TTL_DOWN_MS)
	)
		return Promise.resolve(health.ok);
	if (healthInFlight) return healthInFlight;
	healthInFlight = (async () => {
		let ok = false;
		try {
			ok = await (await service()).modelsAvailable();
		} catch {
			ok = false;
		}
		health = { ok, at: Date.now() };
		healthInFlight = null;
		return ok;
	})();
	return healthInFlight;
}

/**
 * Run one match in the browser. Resolves to null when the matcher is unavailable, times out, is aborted
 * or finds no pose. `onBusy` fires when the request has to wait for another job in this page.
 */
export async function requestMatch(
	req: MatchRequest,
	opts: {
		signal?: AbortSignal;
		timeoutMs?: number;
		onBusy?: (retryAfterS: number) => void;
	} = {},
): Promise<MatchResult | null> {
	if (opts.signal?.aborted || !(await matcherAvailable())) return null;
	return (await service()).runMatch(req, {
		signal: opts.signal,
		timeoutMs: opts.timeoutMs,
		onBusy: () => opts.onBusy?.(0),
	});
}

/** The page's match queue: `busy` while a job runs or waits (no HTTP; etaS is not estimated). */
export async function matcherLoad(): Promise<{
	busy: boolean;
	waiting: number;
	etaS: number | null;
} | null> {
	const q = (await service()).queueState();
	return { busy: q.running || q.waiting > 0, waiting: q.waiting, etaS: null };
}

/**
 * requestMatch with an early out for a contended matcher: `{ deferred }` (the same request, still
 * running under `opts.signal`) when another job is running or queued in this page; otherwise
 * `{ result }` when the match settles. Deferring costs nothing: a confident match still upgrades the pose.
 */
export async function requestMatchOrDefer(
	req: MatchRequest,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<
	{ result: MatchResult | null } | { deferred: Promise<MatchResult | null> }
> {
	const load = await matcherLoad();
	const match = requestMatch(req, opts);
	if (load?.busy) {
		console.debug("[matcher] busy, deferring", load);
		return { deferred: match };
	}
	return { result: await match };
}

const angDist = (a: number, b: number) =>
	Math.abs(((((a - b) % 360) + 540) % 360) - 180);

/**
 * Escalate to render-and-match only when skyline alignment is missing, weak, or two independent skyline
 * solvers disagree. Skyline vs compass prior is NOT a trigger: compass error of a few degrees is the normal
 * case and the skyline is almost always right there.
 * `skylineConfidence` is AlignResult.confidence (src/lib/align.ts); null/undefined = no skyline result.
 * `altSkylinePose` is a second, independent skyline solve (e.g. the CPU cascade or refine+sky), if available.
 */
export function shouldEscalate({
	skylineConfidence,
	skylinePose,
	altSkylinePose,
	minConfidence = 0.5,
	maxSolverDisagreeDeg = 1,
}: {
	skylineConfidence: number | null | undefined;
	skylinePose: Pose | null | undefined;
	altSkylinePose?: Pose | null;
	minConfidence?: number;
	maxSolverDisagreeDeg?: number;
}): boolean {
	if (
		skylineConfidence == null ||
		!skylinePose ||
		!Number.isFinite(skylineConfidence)
	)
		return true;
	if (skylineConfidence < minConfidence) return true;
	if (!altSkylinePose) return false;
	return (
		angDist(skylinePose.yaw, altSkylinePose.yaw) > maxSolverDisagreeDeg ||
		Math.abs(skylinePose.pitch - altSkylinePose.pitch) > maxSolverDisagreeDeg
	);
}
