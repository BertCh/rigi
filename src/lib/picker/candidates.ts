// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Top-3 picker (roadmap R4): pure candidate maths, no DOM / three.js. Node-testable
// (src/lib/picker/candidates.check.ts).
//
// Rules (reports/roadmap.md): precision beats recall. Nothing here ever marks a pose HIGH: a candidate
// is a suggestion, and a pose the user picks is "user-confirmed" provenance, never an auto accept.
import { type Pose, poseBasis, projectPoint, unprojectDir } from "#/lib/camera";
import type { AlignState, Verify } from "#/lib/ontology/crosswalk/pose";

const D = Math.PI / 180;

/** Where a candidate came from (logged with every correction). */
export type CandidateSource =
	| "shown" // the pose the app was showing when the picker opened
	| "align" // engine.autoAlign alternatives (skyline search + silhouette re-rank)
	| "cascade" // unknown-pose worker candidates (solve / refine per focal seed)
	| "tap"; // re-solved from the user's tapped peak(s)

export type Candidate = {
	pose: Pose;
	/** the solver's own score (higher = better); comparable only within one source */
	score: number | null;
	source: CandidateSource;
	/** 0-based rank in the source's own ranking (before dedupe) */
	sourceRank: number;
};

const dot = (a: number[], b: number[]) =>
	a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angDeg = (a: number[], b: number[]) =>
	Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) / D;

/**
 * Separation of two poses in degrees: the larger of the optical-axis angle, |Δroll| and |Δvfov|.
 * Two candidates within DEDUPE_DEG are the same basin for the picker.
 */
export function poseSepDeg(a: Pose, b: Pose): number {
	const fa = poseBasis(a).forward;
	const fb = poseBasis(b).forward;
	const dRoll = Math.abs(((((a.roll - b.roll) % 360) + 540) % 360) - 180);
	return Math.max(angDeg(fa, fb), dRoll, Math.abs(a.vfov - b.vfov));
}

export const DEDUPE_DEG = 0.5;

/**
 * The first `n` candidates of `ranked` (already in preference order) that are pairwise more than
 * `minSepDeg` apart. A later near-duplicate is dropped, never merged: the higher-ranked pose stands.
 */
export function topDistinct(
	ranked: Candidate[],
	n = 3,
	minSepDeg = DEDUPE_DEG,
): Candidate[] {
	const out: Candidate[] = [];
	for (const c of ranked) {
		if (out.every((o) => poseSepDeg(o.pose, c.pose) > minSepDeg)) out.push(c);
		if (out.length >= n) break;
	}
	return out;
}

/** Index of the candidate within `minSepDeg` of `pose`, else -1. */
export function indexNear(
	cands: Candidate[],
	pose: Pose,
	minSepDeg = DEDUPE_DEG,
): number {
	return cands.findIndex((c) => poseSepDeg(c.pose, pose) <= minSepDeg);
}

/** A named summit in the engine's ENU frame (metres). */
export type PoolPeak = {
	name: string;
	ele: number | null;
	prominence: number | null;
	world: [number, number, number];
};

export type NearbyPeak = PoolPeak & {
	/** smallest angle (deg) between the tap ray under any of the candidate poses and the summit */
	sepDeg: number;
	distKm: number;
};

/**
 * Peaks the user may have tapped: the tap at (u, v) is a ray under each candidate pose (the shown one
 * may be tens of degrees off, so every candidate gets a vote); a summit's distance to the tap is its
 * smallest angle to any of those rays. Returns up to `max` within `windowDeg`, nearest first, with
 * prominent summits breaking near-ties (0.5° per 1000 m of prominence, capped at 1°).
 */
export function nearbyPeaks(
	pool: PoolPeak[],
	eye: [number, number, number],
	aspect: number,
	u: number,
	v: number,
	poses: Pose[],
	opts: { windowDeg?: number; max?: number } = {},
): NearbyPeak[] {
	const windowDeg = opts.windowDeg ?? 15;
	const max = opts.max ?? 8;
	const rays = poses.map((p) => unprojectDir(p, aspect, u, v));
	const out: (NearbyPeak & { key: number })[] = [];
	const seen = new Set<string>();
	for (const pk of pool) {
		const id = `${pk.name}|${pk.world.map((x) => Math.round(x)).join(",")}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const d = [
			pk.world[0] - eye[0],
			pk.world[1] - eye[1],
			pk.world[2] - eye[2],
		];
		const r = Math.hypot(d[0], d[1], d[2]);
		if (!(r > 1)) continue;
		const dn = [d[0] / r, d[1] / r, d[2] / r];
		let sep = Number.POSITIVE_INFINITY;
		for (const ray of rays) sep = Math.min(sep, angDeg(ray as number[], dn));
		if (sep > windowDeg) continue;
		const bonus = Math.min(1, ((pk.prominence ?? 0) / 1000) * 0.5);
		out.push({ ...pk, sepDeg: sep, distKm: r / 1000, key: sep - bonus });
	}
	return out
		.sort((a, b) => a.key - b.key)
		.slice(0, max)
		.map(({ key: _k, ...rest }) => rest);
}

export type TapPin = { world: [number, number, number]; u: number; v: number };

/** Mean pixel residual (on a `w`-px-wide image) of the tapped peaks under `pose`; Infinity if behind. */
export function tapResidualPx(
	pose: Pose,
	aspect: number,
	eye: [number, number, number],
	taps: TapPin[],
	w: number,
): number {
	if (!taps.length) return 0;
	const h = w / aspect;
	let s = 0;
	for (const t of taps) {
		const q = projectPoint(pose, aspect, eye, t.world);
		if (!q) return Number.POSITIVE_INFINITY;
		s += Math.hypot((q.u - t.u) * w, (q.v - t.v) * h);
	}
	return s / taps.length;
}

export type TapSolved = Candidate & {
	/** tapped-peak residual, px on a 1000-px-wide image */
	tapPx: number;
	/** skyline score (align.ts scorePose, fine) at the solved pose, null when unavailable */
	skyline: number | null;
	/** which start pose this came from */
	from: CandidateSource;
	fromRank: number;
};

/** A solved pose is consistent with the taps when their mean residual is at most this (1000-px image). */
export const TAP_MAX_PX = 12;

/**
 * Re-solve with the tap constraint from every start pose (`solve` = the engine's pin solver, rotation
 * only), then rank: tap-consistent solutions first, by skyline score, then by tap residual. One tap
 * fixes yaw + pitch (roll / vfov come from the start pose, which is why every candidate is a start);
 * two fix the full rotation. Near-duplicate solutions collapse onto the better-ranked one.
 */
export function rerankWithTaps(
	starts: Candidate[],
	taps: TapPin[],
	solve: (from: Pose) => Pose,
	measure: {
		aspect: number;
		eye: [number, number, number];
		skyline?: (p: Pose) => number | null;
	},
): TapSolved[] {
	const solved: TapSolved[] = starts.map((s, i) => {
		const pose = solve(s.pose);
		const tapPx = tapResidualPx(pose, measure.aspect, measure.eye, taps, 1000);
		const skyline = measure.skyline?.(pose) ?? null;
		return {
			pose,
			score: skyline,
			source: "tap" as const,
			sourceRank: i,
			tapPx,
			skyline,
			from: s.source,
			fromRank: s.sourceRank,
		};
	});
	const ok = (s: TapSolved) => s.tapPx <= TAP_MAX_PX;
	solved.sort((a, b) => {
		if (ok(a) !== ok(b)) return ok(a) ? -1 : 1;
		const sa = a.skyline ?? Number.NEGATIVE_INFINITY;
		const sb = b.skyline ?? Number.NEGATIVE_INFINITY;
		if (sa !== sb) return sb - sa;
		return a.tapPx - b.tapPx;
	});
	return topDistinct(solved, solved.length) as TapSolved[];
}

/**
 * The picker's HIGH test, mirroring the app's accept states (nearfield/controller.ts poseAccepted minus
 * the user states, concord useConcordDisplay): only an automatic, verified accept is HIGH. A user pick
 * ("manual"), a pin, a saved or restored pose are never HIGH here.
 */
export function isAutoHigh(
	alignState: AlignState | null | undefined,
	verify: Verify | undefined,
): boolean {
	if (alignState === "accepted") return true;
	return (
		alignState === "auto" &&
		(verify === "verified" || verify === "refined" || verify === "matched")
	);
}
