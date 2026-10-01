// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Compact lake geometry (GEO GA0/GA4): OSM natural=water polygons reduced to what the eye floor and the
// waterline factors need, small enough to keep with an upload region in IndexedDB (region.ts, flag
// ?geoLakes). Rings are stitched with concord's stitchRings (the same rule as lakesFromOverpass), cut to
// still water, simplified (Douglas–Peucker, tolM) and stored as flat [lat, lon, …] arrays at 1e-6°.
//
// Only still water: rivers, streams and canals are not horizontal, so a single "level" is meaningless
// for them (FLOWING). Reservoirs and basins are kept here (their outline is useful for display and GA4)
// but carry `water` so the floor rule can skip them (floor.ts).

import { type Lake, ringArea, stitchRings } from "../../concord/cues/water";
import { DEG, EARTH_R } from "../../geodesy";
import { parseEle as parseMetres } from "./levels";

type LL = { lat: number; lon: number };
/** Overpass "out geom" element (relation members carry `role` at runtime; overpass.ts's type omits it). */
export type WaterElement = {
	type: string;
	id?: number;
	tags?: Record<string, string>;
	geometry?: LL[];
	members?: { role?: string; geometry?: LL[] }[];
};

export type LakeGeo = {
	/** "way/123" / "relation/456". */
	id: string;
	name?: string;
	/** OSM water=* (lake, reservoir, pond, …); absent when untagged. */
	water?: string;
	/** OSM ele (m), parsed; null when absent or unparsable. */
	ele: number | null;
	/** Largest outer ring, flat [lat, lon, lat, lon, …] (not repeated at the end). */
	outer: number[];
	/** Other outer rings and inner rings (islands), even-odd with `outer` (concord Lake.holes). */
	holes?: number[][];
	/** Area of `outer` minus nothing (m², planar approximation). */
	areaM2: number;
};

/** water=* values that are not a horizontal surface. */
export const FLOWING = new Set([
	"river",
	"stream",
	"canal",
	"ditch",
	"drain",
	"rapids",
	"fish_pass",
	"stream_pool",
	"lock",
	"wastewater",
]);

export type CompactOpts = {
	/** Douglas–Peucker tolerance (m). Default 10. */
	tolM?: number;
	/** Drop outer rings smaller than this (m²). Default 20 000 (concord lakesFromOverpass). */
	minAreaM2?: number;
};

/** Local equirectangular metres around lat0 (errors ≪ 1 m over a lake's extent). */
function toXY(r: LL[], lat0: number, lon0: number): [number, number][] {
	const kx = EARTH_R * DEG * Math.cos(lat0 * DEG);
	const ky = EARTH_R * DEG;
	return r.map((p) => [(p.lon - lon0) * kx, (p.lat - lat0) * ky]);
}

/** Douglas–Peucker on a polyline (indices kept). Iterative; endpoints always kept. */
export function simplifyIdx(pts: [number, number][], tol: number): number[] {
	const n = pts.length;
	if (n <= 2) return pts.map((_, i) => i);
	const keep = new Uint8Array(n);
	keep[0] = keep[n - 1] = 1;
	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length) {
		const [a, b] = stack.pop() as [number, number];
		const [ax, ay] = pts[a];
		const dx = pts[b][0] - ax;
		const dy = pts[b][1] - ay;
		const L2 = dx * dx + dy * dy;
		let best = -1;
		let bi = -1;
		for (let i = a + 1; i < b; i++) {
			const px = pts[i][0] - ax;
			const py = pts[i][1] - ay;
			let d: number;
			if (L2 === 0) d = Math.hypot(px, py);
			else {
				const t = Math.max(0, Math.min(1, (px * dx + py * dy) / L2));
				d = Math.hypot(px - t * dx, py - t * dy);
			}
			if (d > best) {
				best = d;
				bi = i;
			}
		}
		if (bi >= 0 && best > tol) {
			keep[bi] = 1;
			stack.push([a, bi], [bi, b]);
		}
	}
	const out: number[] = [];
	for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
	return out;
}

/** A closed ring (first == last) → simplified open ring, flat [lat, lon, …] at 1e-6°; null if degenerate. */
function compactRing(r: LL[], tolM: number): number[] | null {
	const open =
		r.length > 1 &&
		r[0].lat === r[r.length - 1].lat &&
		r[0].lon === r[r.length - 1].lon
			? r.slice(0, -1)
			: r;
	if (open.length < 3) return null;
	const xy = toXY([...open, open[0]], open[0].lat, open[0].lon);
	let idx = simplifyIdx(xy, tolM).filter((i) => i < open.length);
	if (idx.length < 3) idx = open.map((_, i) => i);
	const out: number[] = [];
	for (const i of idx)
		out.push(
			Math.round(open[i].lat * 1e6) / 1e6,
			Math.round(open[i].lon * 1e6) / 1e6,
		);
	return out;
}

const areaOf = (r: LL[]) =>
	r.length < 3 ? 0 : Math.abs(ringArea(toXY(r, r[0].lat, r[0].lon)));

/** OSM water elements (region.ts regionQueries().water, or any natural=water "out geom") → LakeGeo[]. */
export function compactLakes(
	els: readonly WaterElement[],
	opts: CompactOpts = {},
): LakeGeo[] {
	const tolM = opts.tolM ?? 10;
	const minArea = opts.minAreaM2 ?? 20_000;
	const seen = new Set<string>();
	const out: LakeGeo[] = [];
	for (const e of els) {
		const t = e.tags ?? {};
		if (t.natural !== "water") continue;
		if (t.water && FLOWING.has(t.water)) continue;
		const id = `${e.type}/${e.id ?? out.length}`;
		if (seen.has(id)) continue;
		seen.add(id);
		let outer: LL[][] = [];
		let inner: LL[][] = [];
		if (e.type === "way" && e.geometry) outer = stitchRings([e.geometry]);
		else if (e.type === "relation" && e.members) {
			outer = stitchRings(
				e.members
					.filter((m) => m.role !== "inner")
					.map((m) => m.geometry ?? []),
			);
			inner = stitchRings(
				e.members
					.filter((m) => m.role === "inner")
					.map((m) => m.geometry ?? []),
			);
		}
		const rings = outer
			.map((r) => ({ r, a: areaOf(r) }))
			.filter((x) => x.a >= minArea)
			.sort((a, b) => b.a - a.a);
		if (!rings.length) continue;
		const main = compactRing(rings[0].r, tolM);
		if (!main) continue;
		const holes = [...rings.slice(1).map((x) => x.r), ...inner]
			.map((r) => compactRing(r, tolM))
			.filter((r): r is number[] => !!r);
		out.push({
			id,
			...(t.name ? { name: t.name } : {}),
			...(t.water ? { water: t.water } : {}),
			ele: parseMetres(t.ele),
			outer: main,
			...(holes.length ? { holes } : {}),
			areaM2: Math.round(rings[0].a),
		});
	}
	return out;
}

/** Scene-frame lake (concord Lake) plus where its level came from. */
export type SceneLake = Lake & {
	id?: string;
	water?: string;
	levelSource?: "osm" | "table" | "dem" | "none";
};

const ringEN = (
	flat: number[],
	toEN: (lat: number, lon: number) => [number, number],
): [number, number][] => {
	const r: [number, number][] = [];
	for (let i = 0; i + 1 < flat.length; i += 2)
		r.push(toEN(flat[i], flat[i + 1]));
	return r;
};

/**
 * LakeGeo[] → concord Lake[] in a scene frame. `level(lake)` supplies the absolute level (lakeLevelOf in
 * levels.ts); lakes without one get levelM NaN (concord's waterCuesX skips them).
 */
export function toSceneLakes(
	lakes: readonly LakeGeo[],
	toEN: (lat: number, lon: number) => [number, number],
	level: (
		lake: LakeGeo,
	) => { levelM: number; source: "osm" | "table" | "dem" } | null = () => null,
): SceneLake[] {
	return lakes.map((l) => {
		const lv = level(l);
		return {
			polygon: ringEN(l.outer, toEN),
			holes: (l.holes ?? []).map((h) => ringEN(h, toEN)),
			levelM: lv?.levelM ?? Number.NaN,
			...(l.name ? { name: l.name } : {}),
			id: l.id,
			...(l.water ? { water: l.water } : {}),
			levelSource: lv?.source ?? "none",
		};
	});
}
