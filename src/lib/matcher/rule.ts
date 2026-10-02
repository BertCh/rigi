// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// T6 selection policy and confidence rule, an exact port of tools/matcher/stage1/rule.py (frozen) plus the
// `_veto` response helper of tools/matcher/server/t6.py. Python semantics kept on purpose: `x or 0` maps
// null / undefined / 0 / NaN to 0, `max(key=...)` returns the FIRST maximal element, and `dang` uses the
// floored modulo (result takes the sign of the divisor).
import type { Pose } from "#/lib/camera";

export type T6Fused = {
	pose: Pose | null;
	level?: "high" | "low" | null;
	checks?: {
		cueAgreeDeg?: number | null;
		skylineMedPx?: number | null;
		matchSupport?: number | null;
	} | null;
	inliers?: number | null;
	cues?: { match?: { pose?: Pose } | null } | null;
	basinGap?: { gap?: number | null; error?: string } | null;
	[k: string]: unknown;
};

export type T6Candidate = {
	source: string;
	alsoFrom?: string[];
	pose: Pose;
	inliers?: number;
	rank?: number;
	error?: string;
	fused?: T6Fused;
};

export type T6Record = {
	positionSource: string;
	baselineSeed?: string | null;
	candidates: T6Candidate[];
};

/** A candidate whose stage-2 fused pose exists (the `verified` list of the Python rule). */
export type VerifiedCandidate = T6Candidate & {
	fused: T6Fused & { pose: Pose };
};

export type T6Level = "HIGH" | "LOW";

export type T6Checks = {
	cueAgreeDeg?: number | null;
	skylineMedPx?: number | null;
	matchSupport?: number | null;
	apriori: boolean;
	matchDominant: boolean;
	basinGap: number | null;
	gapOK: boolean;
	ambiguity: number;
	inliers: number;
	unmet: string[];
	[k: string]: unknown;
};

export const RULE_ID = "t6-rule-v1";
/** sha1 of the text between the RULE BEGIN / RULE END markers of tools/matcher/stage1/rule.py. */
export const FROZEN_RULE_SHA1 = "292fb74f35f6f402b5e81f1b832bac565edd6807";

// Constants copied from the frozen RULE block of tools/matcher/stage1/rule.py; do not retune.
const AGREE_DEG = 1.0;
const SKY_PX = 4.0;
const SUPPORT = 0.3;
const MD_SUPPORT = 0.7;
const MD_INLIERS = 1000;
const MD_MATCH_DEG = 0.3;
const STRONG_SUPPORT = 0.5;
const STRONG_INLIERS = 300;
const GAP_MIN = 0.2;
export const AMBIG_DEG = 2.0;

export function dang(a: number, b: number): number {
	const x = a - b + 540.0;
	return (((x % 360.0) + 360.0) % 360.0) - 180.0;
}

/** Python `x or 0.0`. */
function orZero(x: number | null | undefined): number {
	return x ? x : 0;
}

export function verified(rec: T6Record): VerifiedCandidate[] {
	return (rec.candidates ?? []).filter(
		(c): c is VerifiedCandidate => !!c.fused?.pose,
	);
}

export function supportOf(c: VerifiedCandidate): number {
	return orZero(c.fused.checks?.matchSupport);
}

export function inliersOf(c: VerifiedCandidate): number {
	return orZero(c.fused.inliers);
}

export function poseDistance(p: Pose, q: Pose): number {
	return Math.abs(dang(p.yaw, q.yaw)) + Math.abs(p.pitch - q.pitch);
}

export function apriori(c: VerifiedCandidate): boolean {
	const ch = c.fused.checks ?? {};
	return (
		ch.cueAgreeDeg != null &&
		ch.cueAgreeDeg < AGREE_DEG &&
		ch.skylineMedPx != null &&
		ch.skylineMedPx < SKY_PX &&
		supportOf(c) >= SUPPORT
	);
}

export function matchdom(c: VerifiedCandidate): boolean {
	const m = c.fused.cues?.match?.pose;
	return (
		!!m &&
		Object.keys(m).length > 0 &&
		supportOf(c) >= MD_SUPPORT &&
		inliersOf(c) >= MD_INLIERS &&
		poseDistance(c.fused.pose, m) <= MD_MATCH_DEG
	);
}

export function strong(c: VerifiedCandidate): boolean {
	return supportOf(c) >= STRONG_SUPPORT && inliersOf(c) >= STRONG_INLIERS;
}

export function gapOk(rec: T6Record, c: VerifiedCandidate): boolean {
	if (rec.positionSource === "exif-gps") return true;
	const g = c.fused.basinGap?.gap;
	return g != null && g >= GAP_MIN;
}

export function high(rec: T6Record, c: VerifiedCandidate): boolean {
	return (apriori(c) || matchdom(c)) && gapOk(rec, c);
}

export function baseline(rec: T6Record): VerifiedCandidate | null {
	const s = rec.baselineSeed;
	return (
		verified(rec).find(
			(c) => c.source === s || (s != null && (c.alsoFrom ?? []).includes(s)),
		) ?? null
	);
}

/** Python `max(items, key=key)`: the first element with the maximal key. */
function firstMax(items: VerifiedCandidate[]): VerifiedCandidate {
	let best = items[0];
	let bestKey = supportOf(best) * inliersOf(best);
	for (const c of items.slice(1)) {
		const k = supportOf(c) * inliersOf(c);
		if (k > bestKey) {
			best = c;
			bestKey = k;
		}
	}
	return best;
}

export function select(rec: T6Record): VerifiedCandidate | null {
	const vs = verified(rec);
	const hs = vs.filter((c) => high(rec, c));
	if (hs.length) return firstMax(hs);
	const st = vs.filter(strong);
	if (st.length) return firstMax(st);
	return baseline(rec) ?? vs[0] ?? null;
}

export function confidence(
	rec: T6Record,
	c: VerifiedCandidate,
): [T6Level, T6Checks] {
	const failed: string[] = [];
	if (!apriori(c)) failed.push("apriori");
	if (!matchdom(c)) failed.push("matchDominant");
	if (!gapOk(rec, c)) failed.push("basinGap");
	const amb = verified(rec).filter(
		(q) =>
			q !== c &&
			strong(q) &&
			poseDistance(q.fused.pose, c.fused.pose) > AMBIG_DEG,
	);
	if (amb.length) failed.push("ambiguity");
	const checks: T6Checks = {
		...(c.fused.checks ?? {}),
		apriori: apriori(c),
		matchDominant: matchdom(c),
		basinGap: c.fused.basinGap?.gap ?? null,
		gapOK: gapOk(rec, c),
		ambiguity: amb.length,
		inliers: inliersOf(c),
		unmet: failed,
	};
	return [high(rec, c) && !amb.length ? "HIGH" : "LOW", checks];
}

/** Why a candidate with apriori/matchdom evidence still ended LOW (t6.py `_veto`), or null. */
export function veto(
	rec: T6Record,
	c: VerifiedCandidate,
	checks: { ambiguity?: number },
): string | null {
	if (!(apriori(c) || matchdom(c))) return null;
	if (!gapOk(rec, c)) {
		const bg = c.fused.basinGap ?? {};
		return bg.gap != null
			? "basinGap"
			: `basinGap unavailable (${bg.error ? bg.error : "not computed"})`;
	}
	if (checks.ambiguity) return "ambiguity";
	return null;
}
