// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { HorizonProfile } from "../geo/horizon";
// Starts the tracker's DEM horizon as soon as a location fix exists (while the camera permission
// prompt is still up) and shares the result with the tracker: `load` is the tracker's `loadHorizon`.
// A fix farther than the move threshold from the horizon's eye starts a new load (the old one is
// aborted); anything nearer reuses the load in flight or finished. A failed load is forgotten so the
// next call retries.
import { distanceM } from "../geodesy";
import { prepareTrackerHorizon } from "../track/horizon";
import type { EyeFix } from "./contract";
import { MOVE_THRESHOLD_M } from "./geolocation";

const MAX_ANCHOR_ACCURACY_M = 150;

export interface HorizonWarmer {
	/** Start (or reuse) the horizon for this eye. */
	warm(eye: Pick<EyeFix, "lat" | "lon">): Promise<HorizonProfile>;
	/** Same as warm; the shape of TrackerOptions.loadHorizon. */
	load: (eye: EyeFix) => Promise<HorizonProfile>;
	/**
	 * Feed every geolocation fix: the first fix starts the load; later ones re-anchor only when accurate
	 * enough (<= 150 m) to say the eye moved, so coarse early fixes do not thrash the DEM loads.
	 */
	offer(fix: EyeFix): void;
	/** The eye the current horizon is (being) computed for. */
	readonly anchor: Pick<EyeFix, "lat" | "lon"> | null;
	dispose(): void;
}

export function createHorizonWarmer(
	options: {
		prepare?: (
			eye: Pick<EyeFix, "lat" | "lon">,
			signal?: AbortSignal,
		) => Promise<HorizonProfile>;
		thresholdM?: number;
	} = {},
): HorizonWarmer {
	const prepare = options.prepare ?? prepareTrackerHorizon;
	const thresholdM = options.thresholdM ?? MOVE_THRESHOLD_M;
	let anchor: Pick<EyeFix, "lat" | "lon"> | null = null;
	let current: Promise<HorizonProfile> | null = null;
	let controller: AbortController | null = null;
	const warm = (eye: Pick<EyeFix, "lat" | "lon">) => {
		if (current && anchor && distanceM(anchor, eye) <= thresholdM)
			return current;
		controller?.abort();
		const mine = new AbortController();
		controller = mine;
		anchor = { lat: eye.lat, lon: eye.lon };
		const promise = prepare(anchor, mine.signal);
		current = promise;
		promise.catch(() => {
			if (current === promise) {
				current = null;
				anchor = null;
			}
		});
		return promise;
	};
	return {
		warm,
		load: warm,
		offer(fix) {
			if (!anchor || fix.accuracy <= MAX_ANCHOR_ACCURACY_M)
				warm(fix).catch(() => {});
		},
		get anchor() {
			return anchor;
		},
		dispose() {
			controller?.abort();
			controller = null;
			current = null;
			anchor = null;
		},
	};
}
