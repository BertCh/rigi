// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Engine-agnostic projection for terroir overlays: geographic point → stage pixels through the
// Renderer's pose, with a terrain occlusion test against the geometry buffer (sampleAt). Works for
// both engines in overlay and Blend (photo camera). In the world view the photo camera is not the
// view camera, so callers skip (TerroirLayer passes mode).
import { projectPoint } from "#/lib/camera";
import type { Renderer } from "#/lib/renderer";

export type Projected = {
	/** stage pixels */
	x: number;
	y: number;
	/** metres from the eye */
	dist: number;
	/** true when the terrain in front of the point (geometry buffer) is not nearer than it */
	visible: boolean;
};

/** Project (lat, lon, h) to the stage. null when behind the camera or off the image (with margin). */
export function projectGeo(
	eng: Renderer,
	lat: number,
	lon: number,
	h: number,
	stageW: number,
	stageH: number,
	opts: { margin?: number; occlusionTolM?: number; liftM?: number } = {},
): Projected | null {
	const margin = opts.margin ?? 0.05;
	const lift = opts.liftM ?? 0;
	const p = eng.frame.fromGeo(lat, lon, h + lift);
	const e = eng.eye;
	const q = projectPoint(eng.pose, eng.aspect, [e.x, e.y, e.z], p);
	if (!q) return null;
	if (q.u < -margin || q.u > 1 + margin || q.v < -margin || q.v > 1 + margin)
		return null;
	const dist = Math.hypot(p[0] - e.x, p[1] - e.y, p[2] - e.z);
	let visible = true;
	if (q.u >= 0 && q.u <= 1 && q.v >= 0 && q.v <= 1) {
		const s = eng.sampleAt(q.u, Math.min(1, q.v + 0.002));
		// nearer terrain in front of the point hides it; a tolerance grows with range (DEM + pose error)
		const tol = opts.occlusionTolM ?? Math.max(60, dist * 0.02);
		if (s && s.range < dist - tol) visible = false;
	}
	return { x: q.u * stageW, y: q.v * stageH, dist, visible };
}

/** Project a [lon, lat] ring at a fixed height offset above the terrain heights in `hs` (or h0). */
export function projectRing(
	eng: Renderer,
	ring: [number, number][],
	h: number | ((i: number) => number),
	stageW: number,
	stageH: number,
): ({ x: number; y: number; dist: number } | null)[] {
	const e = eng.eye;
	const eye = [e.x, e.y, e.z];
	return ring.map(([lon, lat], i) => {
		const hh = typeof h === "number" ? h : h(i);
		const p = eng.frame.fromGeo(lat, lon, hh);
		const q = projectPoint(eng.pose, eng.aspect, eye, p);
		if (!q) return null;
		return {
			x: q.u * stageW,
			y: q.v * stageH,
			dist: Math.hypot(p[0] - e.x, p[1] - e.y, p[2] - e.z),
		};
	});
}
