// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The resident 360° horizon for a live eye: DEM tiles around the eye (the page's shared tile
// cache), then the horizon march (GPU when available, CPU otherwise). The tracker calls this itself
// when it is given only an eye; call it earlier to warm the tiles while the camera permission prompt
// is up. Cold loads take seconds; the tracker runs sensor-only until it resolves.
import type { HorizonProfile } from "../geo/horizon";
import type { EyeFix } from "../live/contract";

const TIMEOUT_MS = 90_000;

export async function prepareTrackerHorizon(
	eye: Pick<EyeFix, "lat" | "lon">,
	signal?: AbortSignal,
): Promise<HorizonProfile> {
	const [{ computeUnknownScene, UNKNOWN_POSE_DEM }, { fetchDemTileCached }] =
		await Promise.all([
			import("../integration/unknown-pose-core"),
			import("../dem"),
		]);
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
	// a failed tile stays a hole; a timeout fails the load (a horizon with holes must not be trusted)
	const loadTile = (key: Parameters<typeof fetchDemTileCached>[1]) => {
		if (stop.aborted) return Promise.reject(stop.reason);
		return fetchDemTileCached(UNKNOWN_POSE_DEM, key, stop).catch(() => {
			if (stop.aborted) throw new Error("terrain tiles timed out or aborted");
			return undefined;
		});
	};
	// altitude null: the eye rule (DEM ground + eye height); a GPS ellipsoidal height is not MSL
	const scene = await computeUnknownScene(
		eye.lat,
		eye.lon,
		null,
		loadTile,
		true,
	);
	return scene.horizon;
}
