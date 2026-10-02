// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Photo-camera queries on a TerrainSet: eye altitude, peak snapping and occlusion-tested peak labels.

import * as THREE from "three";
import { makeProjector, type Pose } from "../camera";
import { getCpuHeights } from "../dem/cpu-heights";
import { distanceM } from "../geodesy";
import { declutterClassic, peakRank, rankPeaks } from "../look/labels/rank";
import { projectPoint } from "../pose";
import type { TerrainSet } from "./terrain-data";

export type Photo = {
	id: string;
	src: string;
	width: number;
	height: number;
	takenAt?: string;
	lat: number;
	lon: number;
	alt: number;
	hAccuracy?: number;
	heading: number;
	f35?: number;
	vfov: number;
	pitch: number;
	roll: number;
	region: string;
};

export type Peak = {
	name: string;
	lat: number;
	lon: number;
	ele: number | null;
	prominence: number | null;
};

export type PeakLabel = {
	name: string;
	/** OSM elevation (m), null if unknown. */
	ele: number | null;
	/** OSM prominence (m), null if unknown. */
	prominence: number | null;
	distKm: number;
	/** engine.ts rank: prom·3 + ele − range·0.012. */
	rank: number;
	position: [number, number, number];
	u: number;
	v: number;
};

/** Contour near-fade from the GPS horizontal accuracy (PhotoWorkspace's nearFade default). */
export function nearFadeFor(hAccuracy: number | null | undefined) {
	return (
		Math.round(Math.min(200, Math.max(30, (hAccuracy ?? 20) * 3)) / 10) * 10
	);
}

/**
 * Colour-ramp elevation range: local relief within 25 km, at least 500 m (as the removed three.js
 * engine). three only held the viewing-wedge tiles (+ everything within 3 km) at that point, so read the
 * same set here: deck's out-of-wedge context tiles (e.g. the 4000 m Oberland behind a Lake Thun
 * camera) would otherwise stretch the ramp and wash the colours out.
 */
export function localElevRange(terrain: TerrainSet): [number, number] {
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const t of terrain.tiles) {
		if (t.distance > 25000 || !(t.focus || t.distance < 3000)) continue;
		// a GPU-decoded tile brings the exact every-7th-sample range (dem/cpu-heights.ts heightStats)
		const s = t.heights ? undefined : t.heightStats;
		if (s) {
			if (s.lo7 < lo) lo = s.lo7;
			if (s.hi7 > hi) hi = s.hi7;
			continue;
		}
		const h = getCpuHeights(t);
		for (let i = 0; i < h.length; i += 7) {
			if (h[i] < lo) lo = h[i];
			if (h[i] > hi) hi = h[i];
		}
	}
	if (!Number.isFinite(lo)) return [400, 4200];
	return [lo, Math.max(hi, lo + 500)];
}

/** An OSM peak snapped onto the DEM summit, in ENU. */
export type SnappedPeak = {
	name: string;
	ele: number | null;
	prominence: number | null;
	position: [number, number, number];
};

/** Pose-independent per-peak values (distance from the photo, raw ENU), valid for one frame/photo/eye height. */
type PeakPrecompute = {
	peaks: Peak[];
	frame: TerrainSet["frame"];
	lat: number;
	lon: number;
	eyeZ: number;
	dist: Float64Array; // NaN = not computed yet
	enu: Float64Array;
};
const peakPrecompute_ = new WeakMap<object, PeakPrecompute>();

function peakPrecompute(
	cache: object,
	terrain: TerrainSet,
	peaks: Peak[],
	at: { lat: number; lon: number },
	eyeZ: number,
): PeakPrecompute {
	let c = peakPrecompute_.get(cache);
	if (
		!c ||
		c.peaks !== peaks ||
		c.frame !== terrain.frame ||
		c.lat !== at.lat ||
		c.lon !== at.lon ||
		c.eyeZ !== eyeZ ||
		c.dist.length !== peaks.length
	) {
		c = {
			peaks,
			frame: terrain.frame,
			lat: at.lat,
			lon: at.lon,
			eyeZ,
			dist: new Float64Array(peaks.length).fill(Number.NaN),
			enu: new Float64Array(peaks.length * 3),
		};
		peakPrecompute_.set(cache, c);
	}
	return c;
}

/**
 * engine.ts buildPeaks: peaks 150 m – 110 km away, snapped to the DEM summit within
 * min(250, 60 + dist·0.004) m. Lazily: three snaps every peak up front, but on deck's z17 set
 * that is ~2 s for a region's ~2.6k peaks, so only peaks near the frame (15 % margin: snapping
 * moves a summit ≤ 250 m) are snapped, and the verdict is cached in `cache` (per terrain).
 * Returns every peak snapped so far. `localMax` replaces terrain.localMax (the WebGPU engine's GPU
 * height gathers, deck-webgpu/height-gather.ts); undefined from it = not known yet (the peak is
 * retried on a later call, like a peak outside the frame).
 */
export function snapPeaksNear(
	terrain: TerrainSet,
	peaks: Peak[],
	at: { lat: number; lon: number },
	pose: Pose,
	eye: [number, number, number],
	aspect: number,
	cache: Map<Peak, SnappedPeak | null>,
	localMax?: (
		p: Peak,
		radiusM: number,
	) => { lat: number; lon: number; h: number } | undefined,
): SnappedPeak[] {
	const m = 0.15;
	const pre = peakPrecompute(cache, terrain, peaks, at, eye[2]);
	let project: ReturnType<typeof makeProjector> | undefined;
	for (let i = 0; i < peaks.length; i++) {
		const p = peaks[i];
		if (cache.has(p)) continue;
		let dist = pre.dist[i];
		if (Number.isNaN(dist)) {
			dist = pre.dist[i] = distanceM(at, p);
			if (!(dist > 110000 || dist < 150)) {
				const w = terrain.frame.fromGeo(p.lat, p.lon, p.ele ?? eye[2]);
				pre.enu[i * 3] = w[0];
				pre.enu[i * 3 + 1] = w[1];
				pre.enu[i * 3 + 2] = w[2];
			}
		}
		if (dist > 110000 || dist < 150) {
			cache.set(p, null);
			continue;
		}
		project ??= makeProjector(pose, aspect, eye);
		const pr = project(pre.enu.subarray(i * 3, i * 3 + 3));
		if (!pr || pr.u < -m || pr.u > 1 + m || pr.v < -m - 0.3 || pr.v > 1 + m)
			continue; // not now; maybe once the view turns
		const radiusM = Math.min(250, 60 + dist * 0.004);
		const snap = localMax
			? localMax(p, radiusM)
			: terrain.localMax(p.lat, p.lon, radiusM);
		if (!snap) continue; // not known yet
		if (!Number.isFinite(snap.h)) {
			cache.set(p, null);
			continue;
		}
		const w = terrain.frame.fromGeo(snap.lat, snap.lon, snap.h);
		cache.set(p, {
			name: p.name,
			ele: p.ele,
			prominence: p.prominence,
			position: [w[0], w[1], w[2]],
		});
	}
	const out: SnappedPeak[] = [];
	for (const v of cache.values()) if (v) out.push(v);
	return out;
}

/**
 * engine.ts peakLabels: in-frame peaks with a visibility verdict, ranked and decluttered by the
 * shared classic code (look/labels rank.ts), at most `max`.
 * `declutter: false` returns every visible in-frame peak, ranked (3D view: the GPU declutters).
 */
export function placePeakLabels(
	peaks: SnappedPeak[],
	visibility: Map<SnappedPeak, boolean>,
	pose: Pose,
	eye: [number, number, number],
	aspect: number,
	{ max = 28, declutter = true } = {},
): PeakLabel[] {
	const eyeV = new THREE.Vector3(...eye);
	const out: PeakLabel[] = [];
	for (const p of peaks) {
		if (visibility.get(p) !== true) continue; // occluded, or unknown for this eye
		const pr = projectPoint(pose, aspect, eyeV, p.position);
		if (!pr || pr.u < 0 || pr.u > 1 || pr.v < 0 || pr.v > 1) continue;
		const range = Math.hypot(
			p.position[0] - eye[0],
			p.position[1] - eye[1],
			p.position[2] - eye[2],
		);
		out.push({
			name: p.name,
			ele: p.ele,
			prominence: p.prominence,
			distKm: range / 1000,
			rank: peakRank(p.prominence, p.ele, range),
			position: p.position,
			u: pr.u,
			v: pr.v,
		});
	}
	rankPeaks(out);
	return declutter ? declutterClassic(out, max) : out;
}
