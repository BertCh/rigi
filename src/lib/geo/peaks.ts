// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * OSM peaks: Overpass query/parse, direction + visibility from the eye
 * (consistent with horizon.ts: curvature + refraction as a d² / (2 R_eff)
 * drop), and label layout for a camera.
 */

import {
	DEG,
	destination,
	distanceBearing,
	EARTH_R,
	M_PER_DEG_LAT,
	REFRACTION_K,
} from "../geodesy";
import type { Height } from "../ontology/core/quantity";
import { parseOsmMetres } from "../osm/metres";
import { type Camera, directionENU, project } from "./camera";
import type { TerrainSampler } from "./terrain";

export { parseOsmMetres };

export interface Peak {
	id: string;
	name?: string;
	lat: number;
	lon: number;
	/** summit height, metres above mean sea level (OSM `ele`) */
	ele?: Height<"msl">;
	prominence?: number;
	wikidata?: string;
}

/** Overpass QL for natural=peak / volcano nodes within `radiusM` of a point. */
export function overpassPeaksQuery(
	lat: number,
	lon: number,
	radiusM: number,
): string {
	const around = `around:${Math.round(radiusM)},${lat.toFixed(5)},${lon.toFixed(5)}`;
	return `[out:json][timeout:90];(node["natural"="peak"](${around});node["natural"="volcano"](${around}););out body;`;
}

export function parseOverpassPeaks(json: unknown): Peak[] {
	const elements = (json as { elements?: unknown[] })?.elements;
	if (!Array.isArray(elements)) return [];
	const peaks: Peak[] = [];
	for (const e of elements as {
		type?: string;
		id?: number;
		lat?: number;
		lon?: number;
		tags?: Record<string, string>;
	}[]) {
		if (e.type !== "node" || e.lat === undefined || e.lon === undefined)
			continue;
		const t = e.tags ?? {};
		peaks.push({
			id: `node/${e.id}`,
			name: t.name ?? t["name:de"] ?? t["name:en"],
			lat: e.lat,
			lon: e.lon,
			ele: parseOsmMetres(t.ele),
			prominence: parseOsmMetres(t.prominence),
			wikidata: t.wikidata,
		});
	}
	return peaks;
}

export interface PeakView {
	peak: Peak;
	/** Degrees clockwise from true north. */
	azimuth: number;
	/** Apparent elevation angle incl. curvature + refraction, degrees. */
	elevation: number;
	/** Great-circle distance, metres. */
	distance: number;
	/** Terrain elevation used */
	height: number;
	visible: boolean;
}

/** Apparent elevation angle (deg) of height h at distance d from the eye. */
export function apparentElevation(h: number, eye: number, d: number) {
	const rEff = EARTH_R / (1 - REFRACTION_K);
	return Math.atan2(h - eye - (d * d) / (2 * rEff), d) / DEG;
}

/**
 * The summit search radius for a peak `distanceM` from the photo: min(250, 60 + 0.004·d) m. OSM
 * nodes sit a little off the DEM summit, and farther peaks are drawn from coarser tiles.
 */
export const peakSnapRadiusM = (distanceM: number) =>
	Math.min(250, 60 + distanceM * 0.004);

/**
 * The DEM summit near an OSM node over any height lookup: the start point, then a 9 × 9 grid over
 * ±radiusM, highest wins (h = −Infinity when nothing answers). The one snap rule: the app's peaks
 * (deck/scene.ts snapPeaksNear via TerrainSet.localMax) and viewPeaks below. The calls are made in
 * this order (the GPU gathers record and replay them, deck-webgpu/height-gather.ts).
 *
 * `interior` (flag peakSnapInterior, off): a maximum on the grid's outer ring is a slope still
 * rising towards a higher neighbour, not a summit (dev study 2026-10-02: 22 % of catalogue peaks,
 * 84 % of those still climbing at 2× radius), so the node keeps its own position and DEM height.
 * A start point without a height keeps the grid maximum.
 */
export function localMaxOf(
	heightAt: (lat: number, lon: number) => number | null,
	lat: number,
	lon: number,
	radiusM = 150,
	interior = false,
) {
	const start = {
		lat,
		lon,
		h: heightAt(lat, lon) ?? Number.NEGATIVE_INFINITY,
	};
	let best = start;
	let onRing = false;
	const dLat = radiusM / M_PER_DEG_LAT;
	const dLon = radiusM / (M_PER_DEG_LAT * Math.cos(lat * DEG));
	for (let i = -4; i <= 4; i++)
		for (let j = -4; j <= 4; j++) {
			const la = lat + (i / 4) * dLat;
			const lo = lon + (j / 4) * dLon;
			const h = heightAt(la, lo);
			if (h != null && h > best.h) {
				best = { lat: la, lon: lo, h };
				onRing = Math.abs(i) === 4 || Math.abs(j) === 4;
			}
		}
	return interior && onRing && Number.isFinite(start.h) ? start : best;
}

/**
 * Direction to each peak from the eye, after snapping it to the DEM summit (localMaxOf within
 * peakSnapRadiusM, as the app does). Height = max(DEM summit, OSM ele). visible = no terrain along
 * the ray rises above the peak's elevation angle (minus a small tolerance), ignoring the last few
 * hundred metres around the summit itself. This is the baseline's ray-march test (/baseline,
 * Gipfelbuch bakes); the app tests visibility against its rendered range buffer instead
 * (deck/geo-query.ts).
 */
export function viewPeaks(
	peaks: Peak[],
	terrain: TerrainSampler,
	lat: number,
	lon: number,
	eye: number,
	opts: { maxDistance?: number; toleranceDeg?: number } = {},
): PeakView[] {
	const maxDistance = opts.maxDistance ?? 150_000;
	const tol = opts.toleranceDeg ?? 0.05;
	const out: PeakView[] = [];
	for (const peak of peaks) {
		const node = distanceBearing(lat, lon, peak.lat, peak.lon);
		const snap = localMaxOf(
			(la, lo) => {
				const h = terrain.sampleAt(lo, la, node.distance);
				return Number.isNaN(h) ? null : h;
			},
			peak.lat,
			peak.lon,
			peakSnapRadiusM(node.distance),
		);
		const { distance, bearing } = Number.isFinite(snap.h)
			? distanceBearing(lat, lon, snap.lat, snap.lon)
			: node;
		if (distance > maxDistance || distance < 50) continue;
		const height = Math.max(snap.h, peak.ele ?? Number.NEGATIVE_INFINITY);
		if (!Number.isFinite(height)) continue;
		const elevation = apparentElevation(height, eye, distance);
		const stopAt = distance - Math.max(150, distance * 0.02);
		let visible = true;
		for (let d = 20; d < stopAt; d += Math.max(10, d * 0.004)) {
			const p = destination(lat, lon, bearing, d);
			const h = terrain.sampleAt(p.lon, p.lat, d);
			if (Number.isNaN(h)) continue;
			if (apparentElevation(h, eye, d) > elevation + tol) {
				visible = false;
				break;
			}
		}
		out.push({ peak, azimuth: bearing, elevation, distance, height, visible });
	}
	return out;
}

export interface PeakLabelPx extends PeakView {
	x: number;
	y: number;
}

/**
 * Ranking score: prominence (rarely tagged), notability (wikidata, name),
 * height, apparent elevation angle (how much it stands out), closeness.
 */
function score(v: PeakView) {
	const p = v.peak;
	return (
		(p.prominence ?? 0) +
		(p.wikidata ? 800 : 0) +
		(p.name ? 0 : -3000) +
		0.1 * v.height +
		400 * v.elevation -
		0.002 * v.distance
	);
}

/**
 * Projects visible peaks into the camera, ranks by prominence / height /
 * closeness and greedily keeps labels at least `minSpacingPx` apart
 * horizontally. Returns at most `maxLabels`, sorted left to right.
 */
export function layoutPeakLabels(
	views: PeakView[],
	cam: Camera,
	opts: { maxLabels?: number; minSpacingPx?: number } = {},
): PeakLabelPx[] {
	const maxLabels = opts.maxLabels ?? 20;
	const minSpacing = opts.minSpacingPx ?? cam.width * 0.03;
	const candidates: PeakLabelPx[] = [];
	for (const v of views) {
		if (!v.visible) continue;
		const p = project(cam, directionENU(v.azimuth, v.elevation));
		if (!p) continue;
		const [x, y] = p;
		if (x < 0 || x > cam.width || y < 0 || y > cam.height) continue;
		candidates.push({ ...v, x, y });
	}
	candidates.sort((a, b) => score(b) - score(a));
	const kept: PeakLabelPx[] = [];
	for (const c of candidates) {
		if (kept.length >= maxLabels) break;
		if (kept.every((k) => Math.abs(k.x - c.x) >= minSpacing)) kept.push(c);
	}
	return kept.sort((a, b) => a.x - b.x);
}
