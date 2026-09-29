// Photo-camera queries on a TerrainSet: range map (the drape's shadow map), monoplotting,
// and occlusion-tested peak labels.

import * as THREE from "three";
import type { Pose } from "../camera";
import { distanceM } from "../geodesy";
import { declutterClassic, peakRank, rankPeaks } from "../look/labels/rank";
import { projectPoint, unprojectDir } from "../pose";
import type { TerrainSet } from "./terrain-data";
import type { PhotoRangeMap } from "./terrain-layer";

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

/**
 * Range from the photo camera to the first terrain hit for a coarse grid of pixels
 * (row 0 = top). Chunked so the UI keeps breathing; 0 means sky.
 */
export async function computeRangeMap(
	terrain: TerrainSet,
	pose: Pose,
	eye: [number, number, number],
	aspect: number,
	width = 192,
	signal?: AbortSignal,
): Promise<PhotoRangeMap | null> {
	const height = Math.round(width / aspect);
	const data = new Float32Array(width * height);
	for (let y = 0; y < height; y++) {
		if (signal?.aborted) return null;
		for (let x = 0; x < width; x++) {
			const d = unprojectDir(
				pose,
				aspect,
				(x + 0.5) / width,
				(y + 0.5) / height,
			);
			data[y * width + x] = terrain.raycast(eye, [d.x, d.y, d.z]) ?? 0;
		}
		if (y % 8 === 7) await new Promise((r) => setTimeout(r, 0));
	}
	// Dilate so texel-boundary lookups on ridges don't see the (farther) background.
	const out = new Float32Array(data);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			let m = data[y * width + x] || Number.POSITIVE_INFINITY;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const xx = Math.min(Math.max(x + dx, 0), width - 1);
					const yy = Math.min(Math.max(y + dy, 0), height - 1);
					const v = data[yy * width + xx];
					if (v > 0 && v < m) m = v;
				}
			out[y * width + x] = Number.isFinite(m) ? m : 0;
		}
	return { width, height, data: out };
}

/** Monoplotting: the terrain point under a photo pixel (u, v in 0..1, y down). */
export function pickTerrain(
	terrain: TerrainSet,
	pose: Pose,
	eye: [number, number, number],
	aspect: number,
	u: number,
	v: number,
) {
	const d = unprojectDir(pose, aspect, u, v);
	const range = terrain.raycast(eye, [d.x, d.y, d.z]);
	if (range == null) return null;
	const position: [number, number, number] = [
		eye[0] + d.x * range,
		eye[1] + d.y * range,
		eye[2] + d.z * range,
	];
	const geo = terrain.frame.toGeo(...position);
	return {
		position,
		range,
		lat: geo.lat,
		lon: geo.lon,
		ele: terrain.heightAt(geo.lat, geo.lon) ?? geo.h,
	};
}

/**
 * Eye height (m MSL), as engine.ts eyeAltitude: the (barometer-aided) GPS altitude unless that is
 * underground; near summits the horizontal fix puts the DEM point down the slope.
 */
export function eyeAltitude(alt: number | null | undefined, dem: number) {
	return alt != null ? Math.max(alt, dem + 1.6) : dem + 1.8;
}

/** Contour near-fade from the GPS horizontal accuracy (PhotoWorkspace's nearFade default). */
export function nearFadeFor(hAccuracy: number | null | undefined) {
	return (
		Math.round(Math.min(200, Math.max(30, (hAccuracy ?? 20) * 3)) / 10) * 10
	);
}

/**
 * Colour-ramp elevation range: local relief within 25 km, at least 500 m (engine.ts:369-381).
 * three only holds the viewing-wedge tiles (+ everything within 3 km) at that point, so read the
 * same set here: deck's out-of-wedge context tiles (e.g. the 4000 m Oberland behind a Lake Thun
 * camera) would otherwise stretch the ramp and wash the colours out.
 */
export function localElevRange(terrain: TerrainSet): [number, number] {
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const t of terrain.tiles) {
		if (t.distance > 25000 || !(t.focus || t.distance < 3000)) continue;
		const h = t.heights;
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

/**
 * engine.ts buildPeaks: peaks 150 m – 110 km away, snapped to the DEM summit within
 * min(250, 60 + dist·0.004) m. Lazily: three snaps every peak up front, but on deck's z17 set
 * that is ~2 s for a region's ~2.6k peaks, so only peaks near the frame (15 % margin: snapping
 * moves a summit ≤ 250 m) are snapped, and the verdict is cached in `cache` (per terrain).
 * Returns every peak snapped so far.
 */
export function snapPeaksNear(
	terrain: TerrainSet,
	peaks: Peak[],
	at: { lat: number; lon: number },
	pose: Pose,
	eye: [number, number, number],
	aspect: number,
	cache: Map<Peak, SnappedPeak | null>,
): SnappedPeak[] {
	const eyeV = new THREE.Vector3(...eye);
	const m = 0.15;
	for (const p of peaks) {
		if (cache.has(p)) continue;
		const dist = distanceM(at, p);
		if (dist > 110000 || dist < 150) {
			cache.set(p, null);
			continue;
		}
		const raw = terrain.frame.fromGeo(p.lat, p.lon, p.ele ?? eye[2]);
		const pr = projectPoint(pose, aspect, eyeV, raw);
		if (!pr || pr.u < -m || pr.u > 1 + m || pr.v < -m - 0.3 || pr.v > 1 + m)
			continue; // not now; maybe once the view turns
		const snap = terrain.localMax(
			p.lat,
			p.lon,
			Math.min(250, 60 + dist * 0.004),
		);
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
 * Occlusion, as engine.ts peakLabels reads its geometry buffer: look 0.4 % and 0.9 % of the frame
 * height below the summit (the summit pixel itself often reads as sky); the peak is visible if
 * either ray reaches sky or lands no nearer than range·0.97 − 50 m. Adds verdicts for peaks in
 * frame that `known` lacks (occlusion depends on the eye, not the rotation, so keep the map
 * until the eye or terrain changes).
 */
export function testPeakVisibility(
	terrain: TerrainSet,
	peaks: SnappedPeak[],
	pose: Pose,
	eye: [number, number, number],
	aspect: number,
	known: Map<SnappedPeak, boolean>,
) {
	const eyeV = new THREE.Vector3(...eye);
	for (const p of peaks) {
		if (known.has(p)) continue;
		const pr = projectPoint(pose, aspect, eyeV, p.position);
		if (!pr || pr.u < 0 || pr.u > 1 || pr.v < 0 || pr.v > 1) continue;
		const range = Math.hypot(
			p.position[0] - eye[0],
			p.position[1] - eye[1],
			p.position[2] - eye[2],
		);
		let visible = false;
		for (const dv of [0.004, 0.009]) {
			const d = unprojectDir(pose, aspect, pr.u, pr.v + dv);
			const hit = terrain.raycast(
				eye,
				[d.x, d.y, d.z],
				Math.max(range * 0.97 - 50, 10),
			);
			if (hit == null) {
				visible = true;
				break;
			}
		}
		known.set(p, visible);
	}
	return known;
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
