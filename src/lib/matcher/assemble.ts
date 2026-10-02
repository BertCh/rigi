// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// One stage-2 verdict from correspondences + the skyline cue (port of tools/matcher/server/app.py
// assemble): the legacy render-match solve, upgraded to the fused pose and the a-priori HIGH/LOW rule
// when `fused`. The output is the service's /match response body (MatchResult in matcher-client.ts).

import type { Pose } from "#/lib/camera";
import type { MatchResult } from "#/lib/matcher-client";
import {
	type Correspondences,
	coverage,
	legacySolve,
	subsetCorr,
	type View,
} from "./core";
import {
	fuse,
	HIGH_CONF,
	LOW_CONF,
	matchResid,
	type SkylineCue,
	SUPPORT_PX,
	xFromPose,
} from "./fusion";
import { dang, focalPx, round } from "./geometry";

export const MATCHER_VERSION =
	"rigi-matcher/1.0.0 (in-browser port of matcher-service/0.4.0: fused skyline+render-match, λ=1; policies v034 | t6)";

/** MatchResult plus the fields the pipelines read internally. */
export type StageResult = MatchResult & {
	nLifted?: number;
	perView?: unknown[];
	fusedFrom?: string | null;
	focalPx?: number;
	size?: { W: number; H: number };
	eye?: number[];
	reason?: string;
};

export class Deadline extends Error {
	constructor() {
		super("matching exceeded the request timeout");
		this.name = "Deadline";
	}
}

export async function assemble(
	corr: Correspondences,
	views: Pick<View, "pose">[],
	eye: ArrayLike<number>,
	prior: Pose,
	sk: SkylineCue | null,
	o: {
		fused: boolean;
		freeFocal: boolean;
		deadline?: number;
		skyNote?: string | null;
	},
): Promise<StageResult> {
	const legacy = await legacySolve(corr, views, eye, prior, {
		freeFocal: o.freeFocal,
	});
	const legacyOut = {
		...legacy,
		pose: legacy.pose as Pose,
		inlierFrac: legacy.inlierFrac ?? 0,
		residualPx: legacy.residualPx ?? null,
		coverage: legacy.coverage ?? 0,
		deltaYawFromPrior: legacy.deltaYawFromPrior ?? 0,
		version: MATCHER_VERSION,
		method: "render-match" as const,
	};
	if (!o.fused) return legacyOut;
	if (o.deadline != null && performance.now() > o.deadline)
		throw new Deadline();
	const mcue = legacy.pose
		? {
				pose: legacy.pose,
				inliers: legacy.inliers,
				residualPx: legacy.residualPx ?? null,
			}
		: null;
	const low = {
		confidence: LOW_CONF,
		confidenceLevel: "low" as const,
		matchConfidence: legacy.confidence,
	};
	if (!sk)
		return {
			...legacyOut,
			...low,
			confidenceChecks: {
				cueAgreeDeg: null,
				skylineMedPx: null,
				matchSupport: null,
			},
			cues: { skyline: null, match: mcue },
			skylineUnavailable: o.skyNote ?? "no skyline cue",
		};
	const { W, H } = corr;
	const fr = await fuse(prior, eye, W, H, sk, corr);
	const timingMs = { ...legacy.timingMs, fusion: fr.fusionMs };
	if (!fr.fusedPose)
		return {
			...legacyOut,
			...low,
			timingMs,
			confidenceChecks: fr.checks,
			cues: fr.cues,
		};
	const pose = fr.fusedPose;
	let stats: Pick<
		MatchResult,
		"inliers" | "inlierFrac" | "residualPx" | "coverage"
	>;
	const n = corr.x2d.length / 2;
	if (n) {
		const r = matchResid(xFromPose(pose, H), corr, eye);
		const inl = new Uint8Array(n);
		let k = 0;
		let s2 = 0;
		for (let i = 0; i < n; i++) {
			const e = Math.hypot(r[i * 2], r[i * 2 + 1]);
			if (e < SUPPORT_PX) {
				inl[i] = 1;
				k++;
				s2 += e * e;
			}
		}
		stats = {
			inliers: k,
			inlierFrac: round(k / n, 4),
			residualPx: k ? round(Math.sqrt(s2 / k), 3) : null,
			coverage: round(coverage(subsetCorr(corr, inl).x2d, W, H), 3),
		};
	} else stats = { inliers: 0, inlierFrac: 0, residualPx: null, coverage: 0 };
	const high = fr.level === "high";
	return {
		nLifted: legacy.nLifted,
		perView: legacy.perView,
		...stats,
		pose,
		method: "fused",
		confidence: high ? HIGH_CONF : LOW_CONF,
		confidenceLevel: fr.level,
		confidenceChecks: fr.checks,
		cues: fr.cues,
		fusionScore: fr.fusionScore,
		matchConfidence: legacy.confidence,
		fusedFrom: fr.start,
		deltaYawFromPrior: round(dang(pose.yaw, prior.yaw), 3),
		focalPx: round(focalPx(pose.vfov, H), 2),
		size: { W, H },
		timingMs,
		version: MATCHER_VERSION,
	};
}
