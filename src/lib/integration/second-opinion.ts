// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Second opinion on the app's autoAlign for photos with full metadata (compass + gravity + focal).
//
// reports/leaderboard.md: the app's GPU aligner makes 1 confident wrong accept on the GT set (IMG_7130,
// +2.98° yaw at confidence 0.40), while 0f's CPU cascade (solvePose → refinePose on reject, default
// options) makes none (11/12 correct accepts, IMG_7130 at −0.02°). The two disagree by > 1° yaw on
// that photo only. So, after first paint, the cascade re-solves from the compass/gravity prior in the
// unknown-pose worker (item 01), and:
//   app accepted + cascade accepted, |Δyaw| ≤ 1°  → keep the app pose            → "verified"
//   cascade accepted, disagrees or app didn't accept → take the cascade pose       → "refined"
//   cascade rejected, shouldEscalate() false      → keep the app pose, no badge   → "kept"
//   cascade rejected, shouldEscalate() true       → "unverified"; if matcherAvailable(), ask render-and-
//                                                   match and take its pose when matchAccepted (product rule) → "matched"
//   matcher contended (another job running/queued, or a 503) → "unverified" at once (unlocks exports); a
//                                                   confident match later arrives as `upgrade`
//   cascade not done within `timeoutMs` (20 s)    → keep the app pose, no badge   → "timeout"
// The deadline bounds the export lock (PhotoWorkspace locks exports while the verdict is pending): the
// cascade's 360° Mapterhorn terrain is tens of MB cold, and a stalled network would otherwise
// hold it forever. The matcher escalation is bounded by its own 150 s request timeout (v0.3 takes 45–77 s idle).

import type { AlignResult } from "#/lib/align";
import type { Pose } from "#/lib/camera";
import {
	type MatchResult,
	matchAccepted,
	matcherAvailable,
	requestMatchOrDefer,
	shouldEscalate,
} from "#/lib/matcher-client";
import { photoKind } from "#/lib/ontology/core/ids";
import type { PhotoMeta } from "#/lib/photos";
import {
	matchUnknownPoseOrDefer,
	positionSource,
	type UnknownPoseResult,
	UnknownPoseSolver,
} from "./unknown-pose";

export type SecondOpinionVerdict =
	| "verified"
	| "refined"
	| "kept"
	| "unverified"
	| "matched"
	| "timeout";

export type SecondOpinion = {
	verdict: SecondOpinionVerdict;
	/** the pose to show: the app pose unless verdict is "refined" or "matched" */
	pose: Pose;
	note: string;
	cascade:
		| (Pick<UnknownPoseResult, "confidence" | "accepted" | "stage" | "ms"> & {
				yaw: number;
		  })
		| null;
	/** |app yaw − cascade yaw|, degrees */
	disagreeDeg: number | null;
	matcher: "unavailable" | "busy" | "no-result" | "low" | "high" | null;
	ms: number;
	/** matcher "busy": the match still runs under the caller's signal; resolves to the "matched" opinion if confident, else null */
	upgrade?: Promise<SecondOpinion | null>;
};

/** How the app pose was obtained (PhotoWorkspace's autoAlign branch). Only "auto" counts as accepted. */
export type AppAlign = {
	pose: Pose;
	confidence: number | null;
	state: "auto" | "near-compass" | "prior";
};

/** Near-compass window (degrees, exclusive) for an ambiguous skyline's alternatives. */
const NEAR_WINDOW = { yaw: 4, pitch: 1.5 };

/**
 * The pose shown at [data-ready]: autoAlign accepted at confidence > 0.2, else a near-compass alternative
 * (reports/pipeline-ab.md: no variant beat this), else the compass/gravity prior.
 */
export function choosePreview(
	res: AlignResult | null,
	prior: Pose,
): { app: AppAlign; note: string } {
	if (res && res.confidence > 0.2)
		return {
			app: { pose: res.pose, confidence: res.confidence, state: "auto" },
			note: `Auto-aligned to skyline · confidence ${(res.confidence * 100).toFixed(0)}%`,
		};
	// ambiguous skyline: trust the compass for heading, the skyline for the fine fit
	const near = res?.alternatives?.find(
		(a) =>
			Math.abs(a.pose.yaw - prior.yaw) < NEAR_WINDOW.yaw &&
			Math.abs(a.pose.pitch - prior.pitch) < NEAR_WINDOW.pitch,
	);
	if (near)
		return {
			app: {
				pose: near.pose,
				confidence: res?.confidence ?? null,
				state: "near-compass",
			},
			note: "Skyline ambiguous: refined near the compass heading",
		};
	return {
		app: { pose: prior, confidence: res?.confidence ?? null, state: "prior" },
		note: "Using phone compass + gravity (skyline match was weak)",
	};
}

export const AGREE_DEG = 1;
/** Default deadline for the cascade, from the secondOpinion() call (i.e. after [data-ready]). */
export const CASCADE_TIMEOUT_MS = 20_000;

const angDist = (a: number, b: number) =>
	Math.abs(((((a - b) % 360) + 540) % 360) - 180);

const NO_UNKNOWNS = { yaw: false, gravity: false, focal: false, any: false };

/** Render-and-match escalation. Bundled photos go by id (server renders them); uploads by ad-hoc mode. */
async function escalate(
	photo: PhotoMeta,
	prior: Pose,
	signal: AbortSignal,
): Promise<
	{ result: MatchResult | null } | { deferred: Promise<MatchResult | null> }
> {
	if (photoKind(photo.id) === "bundled")
		return requestMatchOrDefer(
			{ photoId: photo.id, prior, fused: true },
			{ signal, timeoutMs: 150_000 },
		);
	return matchUnknownPoseOrDefer(photo, prior, NO_UNKNOWNS, signal);
}

/**
 * The cascade in `solver` (or a new worker) under the deadline; the solver is disposed either way.
 * Throws AbortError when `signal` aborts; a timeout or any other failure resolves to `fail`.
 */
async function solveCascade(
	photo: PhotoMeta,
	img: HTMLImageElement,
	prior: Pose,
	opts: { signal: AbortSignal; solver?: UnknownPoseSolver; timeoutMs?: number },
): Promise<{ c: UnknownPoseResult } | { fail: "timeout" | "kept" }> {
	const t0 = performance.now();
	const solver = opts.solver ?? new UnknownPoseSolver(photo);
	// aborts on the caller's signal or at the deadline (no AbortSignal.any: Safari < 17.4)
	const ctl = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		ctl.abort();
	}, opts.timeoutMs ?? CASCADE_TIMEOUT_MS);
	const forward = () => ctl.abort();
	opts.signal.addEventListener("abort", forward, { once: true });
	if (opts.signal.aborted) ctl.abort();
	try {
		return { c: await solver.solve(img, prior, NO_UNKNOWNS, ctl.signal) };
	} catch (e) {
		if (opts.signal.aborted) throw e;
		if (timedOut) {
			console.warn(
				`[second-opinion] cascade not done after ${Math.round(performance.now() - t0)} ms: keeping the app pose`,
			);
			return { fail: "timeout" };
		}
		if ((e as Error)?.name === "AbortError") throw e;
		console.warn("[second-opinion] cascade failed", e);
		return { fail: "kept" };
	} finally {
		clearTimeout(timer);
		opts.signal.removeEventListener("abort", forward);
		solver.dispose();
	}
}

/**
 * Runs the cascade in `solver` (or a new worker) and returns the verdict; the solver is disposed either
 * way. Create the solver early (`new UnknownPoseSolver(photo)`) to overlap its terrain load with the
 * engine's. Throws AbortError when `signal` aborts; any other failure resolves to "kept" (the app pose
 * stands, no badge).
 */
export async function secondOpinion(
	photo: PhotoMeta,
	img: HTMLImageElement,
	prior: Pose,
	app: AppAlign,
	opts: {
		signal: AbortSignal;
		solver?: UnknownPoseSolver;
		onUnverified?: (note: string) => void;
		timeoutMs?: number;
	},
): Promise<SecondOpinion> {
	const t0 = performance.now();
	const r = await solveCascade(photo, img, prior, opts);
	if (!("c" in r))
		return {
			verdict: r.fail,
			pose: app.pose,
			note: "",
			cascade: null,
			disagreeDeg: null,
			matcher: null,
			ms: Math.round(performance.now() - t0),
		};
	return opinionFromCascade(photo, prior, app, r.c, opts, t0);
}

/** The verdict for a finished cascade `c` (see the table at the top). */
async function opinionFromCascade(
	photo: PhotoMeta,
	prior: Pose,
	app: AppAlign,
	c: UnknownPoseResult,
	opts: { signal: AbortSignal; onUnverified?: (note: string) => void },
	t0: number,
): Promise<SecondOpinion> {
	const done = (v: Omit<SecondOpinion, "ms">): SecondOpinion => ({
		...v,
		ms: Math.round(performance.now() - t0),
	});
	const appAccepted = app.state === "auto";
	const cascade = {
		yaw: c.pose.yaw,
		confidence: c.confidence,
		accepted: c.accepted,
		stage: c.stage,
		ms: c.ms,
	};
	const disagreeDeg = angDist(app.pose.yaw, c.pose.yaw);
	const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

	if (c.accepted) {
		if (appAccepted && disagreeDeg <= AGREE_DEG)
			return done({
				verdict: "verified",
				pose: app.pose,
				note: `Auto-aligned · confidence ${pct(app.confidence ?? 0)} · verified by skyline cascade`,
				cascade,
				disagreeDeg,
				matcher: null,
			});
		return done({
			verdict: "refined",
			pose: c.pose,
			note: appAccepted
				? `Refined: skyline cascade (${pct(c.confidence)}) overruled auto-align by ${disagreeDeg.toFixed(1)}°`
				: `Refined by skyline cascade · confidence ${pct(c.confidence)}`,
			cascade,
			disagreeDeg,
			matcher: null,
		});
	}

	const esc = shouldEscalate({
		skylineConfidence: appAccepted ? app.confidence : null,
		skylinePose: app.pose,
		altSkylinePose: c.pose,
	});
	if (!esc)
		return done({
			verdict: "kept",
			pose: app.pose,
			note: "",
			cascade,
			disagreeDeg,
			matcher: null,
		});

	const note = appAccepted
		? `Unverified: auto-align (${pct(app.confidence ?? 0)}) and skyline cascade disagree by ${disagreeDeg.toFixed(1)}°`
		: "Unverified: neither auto-align nor the skyline cascade could confirm a pose";
	if (!(await matcherAvailable()))
		return done({
			verdict: "unverified",
			pose: app.pose,
			note,
			cascade,
			disagreeDeg,
			matcher: "unavailable",
		});
	opts.onUnverified?.(`${note} · asking the match service`);
	const r = await escalate(photo, prior, opts.signal);
	if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");
	const isAccepted = (m: MatchResult) =>
		matchAccepted(m, {
			positionTrusted: positionSource(photo) === "exif-gps",
			cascadePose: c.pose,
		});
	const matched = (m: MatchResult) =>
		done({
			verdict: "matched",
			pose: m.pose,
			note: "Refined by render-and-match (high confidence)",
			cascade,
			disagreeDeg,
			matcher: "high",
		});
	if ("deferred" in r)
		return done({
			verdict: "unverified",
			pose: app.pose,
			note: `${note} · match service busy, still asking`,
			cascade,
			disagreeDeg,
			matcher: "busy",
			upgrade: r.deferred.then((m) => (m && isAccepted(m) ? matched(m) : null)),
		});
	const m = r.result;
	if (m && isAccepted(m)) return matched(m);
	return done({
		verdict: "unverified",
		pose: app.pose,
		note,
		cascade,
		disagreeDeg,
		matcher: m ? "low" : "no-result",
	});
}
