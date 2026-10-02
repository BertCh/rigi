// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Constants and the CPU twin of the photo-drape visibility vote shared by the WebGL terrain shader
// (terrain-layer.ts, `drapeSeen`) and the WebGPU drape plugin (deck-webgpu/layers/drape.ts,
// `drape_visibility`): a 2x2 PCF vote over the photo camera's range texels with a slope-scaled
// slack. The roll multi-drape (roll/map/multi-drape-layer.ts) uses the same constants.

/**
 * The slope-scaled range bias grows as 1/sin(incidence) down to this (about 0.7 deg). Lakes and
 * meadows seen from a few tens of metres above them sit at 1-3 deg from the camera; a larger floor
 * (0.03) left them striped with rejected rows.
 */
export const MIN_SIN_INC = 0.012;

/** The slope-scaled bias the shaders add (m): 1.5 r dTheta / max(sin incidence, MIN_SIN_INC). */
export function drapeSlack(
	r: number,
	sinInc: number,
	tanHalfY: number,
	geometryHeight: number,
) {
	const radPx = (2 * Math.atan(tanHalfY)) / geometryHeight;
	return (1.5 * r * radPx) / Math.max(sinInc, MIN_SIN_INC);
}

/** One range texel's vote: 1 when a point at range r is visible from the photo camera. */
export function drapeSeenTexel(seen: number, r: number, slack: number) {
	return seen > 0 && r < seen * 1.015 + 15 + slack ? 1 : 0;
}

/** The people cut-out and vote to drape weight: seen = smoothstep(0, 0.75, vis) * keep. */
export function drapeSeenWeight(vis: number, mask: number, fgOn: boolean) {
	const smooth = (a: number, b: number, x: number) => {
		const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
		return t * t * (3 - 2 * t);
	};
	const keep = fgOn ? 1 - smooth(0.4, 0.6, mask) : 1;
	return smooth(0, 0.75, vis) * keep;
}
