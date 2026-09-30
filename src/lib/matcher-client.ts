// Client for the optional render-and-match escalation service (tools/matcher/server, default :8765).
// Everything here degrades to `false` / `null` when the service isn't running: it never throws.
import type { Pose } from "./camera";

const BASE = (
	import.meta.env?.VITE_MATCHER_URL ?? "http://localhost:8765"
).replace(/\/+$/, "");
const HEALTH_TIMEOUT_MS = 800;
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
	/** server renders the views and exports the skyline cue itself by driving the app headlessly (dev only) */
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
	 * ad-hoc photo (tools/matcher/server/app.py match_adhoc): the server renders the views itself from the
	 * position; unknown prior fields are simply omitted (two-stage 360° sweep when yaw is missing)
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
	m.confidenceLevel ? m.confidenceLevel === "high" : m.confidence >= 0.5;

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

function linkedSignal(timeoutMs: number, outer?: AbortSignal) {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	const onAbort = () => ctl.abort();
	if (outer?.aborted) ctl.abort();
	else outer?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: ctl.signal,
		done: () => {
			clearTimeout(timer);
			outer?.removeEventListener("abort", onAbort);
		},
	};
}

/** Cached health check (short timeout). */
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
		const l = linkedSignal(HEALTH_TIMEOUT_MS);
		let ok = false;
		try {
			const r = await fetch(`${BASE}/health`, { signal: l.signal });
			ok = r.ok && (await r.json())?.ok === true;
		} catch {
			ok = false;
		} finally {
			l.done();
		}
		health = { ok, at: Date.now() };
		healthInFlight = null;
		return ok;
	})();
	return healthInFlight;
}

function buildBody(
	req: MatchRequest,
	serverTimeoutMs: number,
): { body: BodyInit; headers?: HeadersInit } {
	// discriminate on the photo Blob: the views variant may carry a photoId too, and must stay multipart
	if (!("photo" in req))
		return {
			body: JSON.stringify({
				...req,
				timeoutMs: serverTimeoutMs,
			}),
			headers: { "Content-Type": "application/json" },
		};
	if ("meta" in req) {
		const fd = new FormData();
		const {
			meta,
			prior,
			fused,
			freeFocal,
			positionUncertainM,
			yawSeeds,
			poseSeeds,
		} = req;
		fd.append(
			"request",
			JSON.stringify({
				meta,
				prior,
				fused,
				freeFocal,
				positionUncertainM,
				yawSeeds,
				poseSeeds,
				timeoutMs: serverTimeoutMs,
			}),
		);
		fd.append("photo", req.photo, "photo.jpg");
		return { body: fd };
	}
	const f32 = (a: Float32Array) =>
		new Blob(
			[new Uint8Array(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength)],
			{ type: "application/octet-stream" },
		);
	const fd = new FormData();
	const views = req.views.map(({ tag, pose, W, H }) => ({ tag, pose, W, H }));
	const sk = req.skyline;
	fd.append(
		"request",
		JSON.stringify({
			prior: req.prior,
			eye: req.eye,
			views,
			fused: req.fused,
			freeFocal: req.freeFocal,
			photoId: req.photoId,
			skyline: sk && {
				w: sk.w,
				h: sk.h,
				pose: sk.pose,
				confidence: sk.confidence,
				accepted: sk.accepted,
			},
			timeoutMs: serverTimeoutMs,
		}),
	);
	fd.append("photo", req.photo, "photo.jpg");
	for (const v of req.views) {
		fd.append(`rgb:${v.tag}`, v.rgb, `${v.tag}.jpg`);
		fd.append(`xyz:${v.tag}`, f32(v.xyz), `${v.tag}.f32`);
	}
	if (sk)
		for (const k of ["horizon", "fine", "fg", "sky"] as const)
			fd.append(`skyline:${k}`, f32(sk[k]), `${k}.f32`);
	return { body: fd }; // browser sets the multipart boundary
}

/** Retry a 503 only when a job still fits after the wait (v0.3 takes 34–77 s idle): a retry that times out holds the lock for nothing. */
const MIN_JOB_MS = 30_000;
/**
 * The deadline is the real bound; this only stops a runaway loop. A deferred request retries in the
 * background at no cost to the user, and with 4 attempts it lost the single waiter slot to a competing
 * client every time (out/lead/matcher-e2e/run-v033.txt).
 */
const MAX_ATTEMPTS = 20;

/**
 * POST /match. Resolves to null when the service is down, times out, is aborted or finds no pose.
 * `onBusy(retryAfterS)` fires on each 503 (another job holds the renderer) before the retry wait.
 */
export async function requestMatch(
	req: MatchRequest,
	opts: {
		signal?: AbortSignal;
		timeoutMs?: number;
		onBusy?: (retryAfterS: number) => void;
	} = {},
): Promise<MatchResult | null> {
	const timeoutMs = opts.timeoutMs ?? 60_000;
	if (opts.signal?.aborted || !(await matcherAvailable())) return null;
	const l = linkedSignal(timeoutMs, opts.signal);
	const deadline = Date.now() + timeoutMs;
	try {
		// v0.3.4 fairness: echo the 503's X-Queue-Ticket so the oldest waiting client gets the next slot
		let ticket: string | null = null;
		const post = () => {
			const { body, headers } = buildBody(
				req,
				Math.max(1000, deadline - Date.now() - 500),
			);
			const h = new Headers(headers);
			if (ticket) h.set("X-Queue-Ticket", ticket);
			return fetch(`${BASE}/match`, {
				method: "POST",
				body,
				headers: h,
				signal: l.signal,
			});
		};
		let r = await post();
		// v0.3.2 answers 503 + Retry-After (estimated remaining job time, ≤ 60 s) at once when busy.
		// Retry-After is null if the server doesn't expose it over CORS: then poll every 5 s.
		for (
			let attempt = 1;
			r.status === 503 && attempt < MAX_ATTEMPTS;
			attempt++
		) {
			const retryAfterS = Number(r.headers.get("Retry-After")) || 5;
			ticket = r.headers.get("X-Queue-Ticket") ?? ticket;
			opts.onBusy?.(retryAfterS);
			const waitMs = retryAfterS * 1000;
			if (Date.now() + waitMs + MIN_JOB_MS > deadline) break;
			console.debug("[matcher] busy, retrying in", retryAfterS, "s");
			await new Promise<void>((resolve, reject) => {
				const t = setTimeout(resolve, waitMs);
				l.signal.addEventListener(
					"abort",
					() => (clearTimeout(t), reject(l.signal.reason)),
					{ once: true },
				);
			});
			r = await post();
		}
		const j = await r.json().catch(() => null);
		if (!r.ok || !j?.ok || !j.pose) {
			if (j?.error) console.warn("[matcher]", j.error.code, j.error.message);
			return null;
		}
		return j as MatchResult;
	} catch (e) {
		// network failure → mark down so the next call skips straight to null
		if (!(e instanceof DOMException && e.name === "AbortError"))
			health = { ok: false, at: Date.now() };
		return null;
	} finally {
		l.done();
	}
}

/**
 * Uncached /health load probe. v0.3.2 adds a `queue` field; accepted shapes: a number of waiters, or
 * `{ waiting | depth, etaS | remainingS | retryAfterS }`. Older servers only report `busy`.
 */
export async function matcherLoad(): Promise<{
	busy: boolean;
	waiting: number;
	etaS: number | null;
} | null> {
	const l = linkedSignal(HEALTH_TIMEOUT_MS);
	try {
		const r = await fetch(`${BASE}/health`, { signal: l.signal });
		const j = r.ok ? await r.json() : null;
		if (j?.ok !== true) return null;
		const q = j.queue;
		const num = (...xs: unknown[]) => {
			const x = xs.find((v) => typeof v === "number" && Number.isFinite(v));
			return x === undefined ? null : (x as number);
		};
		const waiting =
			typeof q === "number" ? q : (num(q?.waiting, q?.depth) ?? 0);
		return {
			busy: j.busy === true || q?.running != null || waiting > 0,
			waiting,
			etaS: num(q?.etaS, q?.remainingS, q?.retryAfterS),
		};
	} catch {
		return null;
	} finally {
		l.done();
	}
}

/**
 * requestMatch with an early out for a contended service: `{ deferred }` (the same request, still running
 * under `opts.signal`) as soon as /health shows another job running or queued, or the first 503 arrives;
 * otherwise `{ result }` when the match settles.
 * Any contention defers: the e2e (out/lead/matcher-e2e/report.md) showed short Retry-Afters stacking to
 * 50–90 s of overlay and the server's etaS under-reading overrunning jobs, while deferring costs nothing
 * (a confident match still upgrades the pose).
 */
export async function requestMatchOrDefer(
	req: MatchRequest,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<
	{ result: MatchResult | null } | { deferred: Promise<MatchResult | null> }
> {
	const load = await matcherLoad();
	const contended = !!load?.busy;
	let onBusy: () => void = () => {};
	const busy = new Promise<"busy">((resolve) => {
		onBusy = () => resolve("busy");
	});
	const match = requestMatch(req, {
		signal: opts.signal,
		timeoutMs: opts.timeoutMs,
		onBusy: () => onBusy(),
	});
	if (contended) {
		console.debug("[matcher] contended, deferring", load);
		return { deferred: match };
	}
	const first = await Promise.race([match, busy]);
	if (first === "busy") {
		console.debug("[matcher] busy, deferring");
		return { deferred: match };
	}
	return { result: first };
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
