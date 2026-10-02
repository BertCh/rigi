// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Geolocation → EyeFix, and the "the eye moved" detector that tells the tracker to re-localise.

import { distanceM } from "../geodesy";
import type { EyeFix } from "./contract";

/** Moving farther than this from the anchor fix means the horizon and the DEM view are stale. */
export const MOVE_THRESHOLD_M = 100;

export function eyeFixFromPosition(
	position: GeolocationPosition,
	time = performance.now(),
): EyeFix {
	const c = position.coords;
	const fix: EyeFix = {
		lat: c.latitude,
		lon: c.longitude,
		accuracy: c.accuracy,
		time,
	};
	if (c.altitude != null && Number.isFinite(c.altitude)) fix.alt = c.altitude;
	return fix;
}

export interface MoveDetector {
	/** The fix the current localisation was made at, or null before the first fix. */
	readonly anchor: EyeFix | null;
	/**
	 * Feed a fix. Returns true once when it is more than the threshold from the anchor and accurate enough to
	 * say so (accuracy no worse than the threshold); the anchor then moves to this fix. The first fix only
	 * sets the anchor.
	 */
	update(fix: EyeFix): boolean;
	/** Make this fix the anchor without reporting a move (after a manual re-localisation). */
	rebase(fix: EyeFix): void;
}

export function createMoveDetector(
	thresholdM = MOVE_THRESHOLD_M,
): MoveDetector {
	let anchor: EyeFix | null = null;
	return {
		get anchor() {
			return anchor;
		},
		update(fix) {
			if (!anchor) {
				anchor = fix;
				return false;
			}
			if (fix.accuracy > thresholdM) return false;
			if (distanceM(anchor, fix) <= thresholdM) return false;
			anchor = fix;
			return true;
		},
		rebase(fix) {
			anchor = fix;
		},
	};
}

export interface LocationFeed {
	latest(): EyeFix | null;
	dispose(): void;
}

/** watchPosition with high accuracy. `onFix` gets every fix, `onMoved` once per > threshold move. Never throws. */
export function startLocation(handlers: {
	onFix?: (fix: EyeFix) => void;
	onMoved?: (fix: EyeFix) => void;
	onError?: (message: string) => void;
	thresholdM?: number;
}): LocationFeed {
	const detector = createMoveDetector(handlers.thresholdM);
	let latest: EyeFix | null = null;
	if (typeof navigator === "undefined" || !navigator.geolocation) {
		handlers.onError?.("geolocation unsupported");
		return { latest: () => null, dispose() {} };
	}
	const id = navigator.geolocation.watchPosition(
		(position) => {
			const fix = eyeFixFromPosition(position);
			latest = fix;
			handlers.onFix?.(fix);
			if (detector.update(fix)) handlers.onMoved?.(fix);
		},
		(error) =>
			handlers.onError?.(error.message || `geolocation error ${error.code}`),
		{ enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
	);
	return {
		latest: () => latest,
		dispose: () => navigator.geolocation.clearWatch(id),
	};
}
