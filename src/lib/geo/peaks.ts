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
	REFRACTION_K,
} from "../geodesy";
import { type Camera, directionENU, project } from "./camera";
import type { TerrainSampler } from "./terrain";

export interface Peak {
	id: string;
	name?: string;
	lat: number;
	lon: number;
	ele?: number;
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

/** Parses "1234", "1234 m", "1,234.5" etc. to metres; undefined if unusable. */
function parseMetres(v: unknown): number | undefined {
	if (typeof v !== "string") return undefined;
	const m = v
		.replace(/(?<=\d),(?=\d{3}(?!\d))/g, "")
		.replace(/,/g, ".")
		.match(/-?\d+(\.\d+)?/);
	if (!m) return undefined;
	let n = Number.parseFloat(m[0]);
	if (/ft|feet|'/.test(v)) n *= 0.3048;
	return Number.isFinite(n) ? n : undefined;
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
			ele: parseMetres(t.ele),
			prominence: parseMetres(t.prominence),
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

/** Max DEM height in a small neighbourhood (OSM nodes are often a bit off the DEM summit). */
function localMax(
	terrain: TerrainSampler,
	lat: number,
	lon: number,
	distance: number,
	radius: number,
) {
	let best = terrain.sampleAt(lon, lat, distance);
	for (const r of [radius / 2, radius])
		for (let az = 0; az < 360; az += 45) {
			const p = destination(lat, lon, az, r);
			const h = terrain.sampleAt(p.lon, p.lat, distance);
			if (Number.isNaN(h)) continue;
			if (!(h <= best)) best = Number.isNaN(best) ? h : Math.max(best, h);
		}
	return best;
}

/**
 * Direction to each peak from the eye. Height = max(DEM local max near the
 * node, OSM ele). visible = no terrain along the ray rises above the peak's
 * elevation angle (minus a small tolerance), ignoring the last few hundred
 * metres around the summit itself.
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
		const { distance, bearing } = distanceBearing(lat, lon, peak.lat, peak.lon);
		if (distance > maxDistance || distance < 50) continue;
		const dem = localMax(terrain, peak.lat, peak.lon, distance, 60);
		const height = Math.max(
			Number.isNaN(dem) ? Number.NEGATIVE_INFINITY : dem,
			peak.ele ?? Number.NEGATIVE_INFINITY,
		);
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

export interface PeakLabel extends PeakView {
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
): PeakLabel[] {
	const maxLabels = opts.maxLabels ?? 20;
	const minSpacing = opts.minSpacingPx ?? cam.width * 0.03;
	const candidates: PeakLabel[] = [];
	for (const v of views) {
		if (!v.visible) continue;
		const p = project(cam, directionENU(v.azimuth, v.elevation));
		if (!p) continue;
		const [x, y] = p;
		if (x < 0 || x > cam.width || y < 0 || y > cam.height) continue;
		candidates.push({ ...v, x, y });
	}
	candidates.sort((a, b) => score(b) - score(a));
	const kept: PeakLabel[] = [];
	for (const c of candidates) {
		if (kept.length >= maxLabels) break;
		if (kept.every((k) => Math.abs(k.x - c.x) >= minSpacing)) kept.push(c);
	}
	return kept.sort((a, b) => a.x - b.x);
}
