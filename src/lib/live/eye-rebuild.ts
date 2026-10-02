// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// When /live rebuilds its engine at a new eye. The engines fix the eye and EnuFrame at construction, so a
// moved phone (src/lib/live/geolocation.ts move detector) needs a new engine; this is the pure decision
// logic (accuracy gate, debounce, one in flight, region change). The browser side is useLiveSession.

import { distanceM } from "../geodesy";
import type { PhotoMeta } from "../photos";
import type { EyeFix } from "./contract";
import { nearestRegion } from "./eye-photo";
import { MOVE_THRESHOLD_M } from "./geolocation";

/** A fix less accurate than this cannot say the eye moved (same gate as the horizon warmer). */
export const REBUILD_MAX_ACCURACY_M = 150;
/** Rebuilds are at least this far apart in time, unless the move is longer than REBUILD_FORCE_DISTANCE_M. */
export const REBUILD_MIN_INTERVAL_MS = 10_000;
export const REBUILD_FORCE_DISTANCE_M = 1000;

export type RebuildDecision =
	| { action: "rebuild"; reason: string }
	| { action: "wait"; reason: string }
	| { action: "skip"; reason: string };

export function decideRebuild(input: {
	/** The eye the running engine was built at. */
	engineEye: Pick<EyeFix, "lat" | "lon">;
	candidate: EyeFix;
	now: number;
	/** `now` of the last rebuild's start, null when there was none. */
	lastRebuildAt: number | null;
	inFlight: boolean;
	thresholdM?: number;
}): RebuildDecision {
	const { candidate, now } = input;
	if (candidate.accuracy > REBUILD_MAX_ACCURACY_M)
		return { action: "skip", reason: "fix too coarse" };
	const moved = distanceM(input.engineEye, candidate);
	if (moved <= (input.thresholdM ?? MOVE_THRESHOLD_M))
		return { action: "skip", reason: "within the engine's eye" };
	if (input.inFlight) return { action: "wait", reason: "rebuild in flight" };
	if (
		input.lastRebuildAt != null &&
		now - input.lastRebuildAt < REBUILD_MIN_INTERVAL_MS &&
		moved <= REBUILD_FORCE_DISTANCE_M
	)
		return { action: "wait", reason: "debounced" };
	return { action: "rebuild", reason: `moved ${Math.round(moved)} m` };
}

export type RebuildRequest = {
	eye: EyeFix;
	/** Region of the new eye (null = none within reach). */
	region: string | null;
	regionChanged: boolean;
};

export interface RebuildScheduler {
	/** A move was detected (or any newer fix): remember it as the wanted eye. The latest offer wins. */
	offer(fix: EyeFix): void;
	/** Poll: the rebuild to start now, or null. Marks it in flight; end it with complete() or fail(). */
	next(now: number): RebuildRequest | null;
	complete(request: RebuildRequest, now: number): void;
	fail(now: number): void;
	readonly inFlight: boolean;
	readonly engineEye: EyeFix;
	readonly region: string | null;
}

export function createRebuildScheduler(
	initialEye: EyeFix,
	photos: readonly Pick<PhotoMeta, "lat" | "lon" | "region">[],
): RebuildScheduler {
	let engineEye = initialEye;
	let region = nearestRegion(initialEye, photos);
	let pending: EyeFix | null = null;
	let inFlight = false;
	let lastRebuildAt: number | null = null;
	return {
		offer(fix) {
			pending = fix;
		},
		next(now) {
			const candidate = pending;
			if (!candidate) return null;
			const decision = decideRebuild({
				engineEye,
				candidate,
				now,
				lastRebuildAt,
				inFlight,
			});
			if (decision.action === "skip") pending = null;
			if (decision.action !== "rebuild") return null;
			const eye = candidate;
			pending = null;
			inFlight = true;
			lastRebuildAt = now;
			const nextRegion = nearestRegion(eye, photos);
			return { eye, region: nextRegion, regionChanged: nextRegion !== region };
		},
		complete(request, now) {
			inFlight = false;
			engineEye = request.eye;
			region = request.region;
			lastRebuildAt = now;
		},
		fail(now) {
			// the same move is not retried until the debounce interval has passed (a newer offer replaces it)
			inFlight = false;
			lastRebuildAt = now;
		},
		get inFlight() {
			return inFlight;
		},
		get engineEye() {
			return engineEye;
		},
		get region() {
			return region;
		},
	};
}
