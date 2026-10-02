// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * /baseline Auto-align options for a prior with missing sensors. Without them the worker ran the
 * default cascade (a ±25° search at the 0.5 bar) around a made-up north heading, which is the
 * "app auto-align with no heading: 3/11 correct, 7 false accepts" trap (reports/bench-ablation.md).
 * A missing sensor gets the unknown-pose cascade's options (unknown-pose-core.ts `options`) and,
 * for a missing heading or focal, its 0.75 bar on whichever stage answers (solve or refine).
 */
import type { CascadeOptions } from "#/lib/geo/pipeline";
import { FULL_SEARCH_CONFIDENCE } from "#/lib/geo/solve";
import { options } from "#/lib/integration/unknown-pose-core";
import type { PriorUnknowns } from "./types";

export const NO_UNKNOWNS: PriorUnknowns = {
	yaw: false,
	gravity: false,
	focal: false,
};

export type BaselineAlignOptions = {
	cascade: CascadeOptions;
	/** The cascade's answer is accepted only at or above this confidence (0 = its own bars). */
	minConfidence: number;
};

export function baselineAlignOptions(
	unknown: PriorUnknowns = NO_UNKNOWNS,
): BaselineAlignOptions {
	if (!unknown.yaw && !unknown.gravity && !unknown.focal)
		return { cascade: {}, minConfidence: 0 };
	const { solve, refine } = options(!unknown.yaw, !unknown.gravity);
	return {
		cascade: { solve, refine },
		minConfidence: unknown.yaw || unknown.focal ? FULL_SEARCH_CONFIDENCE : 0,
	};
}

/** `accepted` after the bar: a stage that accepted below `minConfidence` is a low-confidence reject. */
export function applyMinConfidence<
	R extends { accepted: boolean; confidence: number; rejectReason?: string },
>(r: R, minConfidence: number): R {
	if (!r.accepted || r.confidence >= minConfidence) return r;
	return { ...r, accepted: false, rejectReason: "low-confidence" };
}
