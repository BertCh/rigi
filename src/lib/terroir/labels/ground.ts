// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Terrain height under a (lat, lon) through the engine's geometry buffer: scan a vertical line from
// high to low until the viewing ray through it meets the terrain (sampleAt range ≈ the point's
// range). Heights are a property of the terrain, so a hit is cached per engine. Names without an
// elevation (rivers, valleys, ridges, regions) need this to sit on the ground.
import type { Renderer } from "#/lib/renderer";
import { projectGeo } from "../ui/project";

const cache = new WeakMap<object, Map<string, number>>();

/** Height (m) of the terrain at (lat, lon) where it is visible on screen; null when hidden / off-screen / unknown. */
export function groundAt(
	eng: Renderer,
	lat: number,
	lon: number,
	w: number,
	h: number,
): number | null {
	let m = cache.get(eng);
	if (!m) {
		m = new Map();
		cache.set(eng, m);
	}
	const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
	const hit = m.get(key);
	if (hit !== undefined) return hit;
	const lo = Math.max(0, eng.demAtCamera - 600);
	for (let z = 4800; z >= lo; z -= 60) {
		const p = projectGeo(eng, lat, lon, z, w, h, { margin: 0 });
		if (!p) continue;
		const u = p.x / w;
		const v = p.y / h;
		if (u < 0 || u > 1 || v < 0 || v > 1) continue;
		const s = eng.sampleAt(u, v);
		if (!s) continue;
		const tol = Math.max(40, p.dist * 0.015);
		if (s.range > p.dist + tol) continue; // terrain behind the point: still above the ground
		if (s.range < p.dist - tol) return null; // nearer terrain hides it
		m.set(key, z);
		return z;
	}
	return null;
}
