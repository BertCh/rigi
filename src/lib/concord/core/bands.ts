// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Distance / image-radius bands used by every concordance report.
import type { DistanceBand, RadiusBand } from "./types";

export function distanceBand(m: number): DistanceBand {
	if (m < 500) return "<0.5km";
	if (m < 2000) return "0.5-2km";
	if (m < 5000) return "2-5km";
	if (m < 15000) return "5-15km";
	return ">15km";
}

/** Radius from the image centre as a fraction of the half-diagonal (aspect = W/H, uv normalised). */
export function radiusFrac(u: number, v: number, aspect: number): number {
	return (
		Math.hypot((u - 0.5) * aspect, v - 0.5) / (0.5 * Math.hypot(aspect, 1))
	);
}

export function radiusBand(u: number, v: number, aspect: number): RadiusBand {
	const r = radiusFrac(u, v, aspect);
	return r < 0.35 ? "centre" : r < 0.7 ? "mid" : "corner";
}
