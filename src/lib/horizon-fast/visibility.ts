/**
 * Peak summit snapping and occlusion classification (§5). The occlusion
 * angle itself comes from the march (march.ts marches one extra ray at each
 * peak's exact bearing and records the running maximum before the summit).
 */
import { distanceBearing, EARTH_R } from "../geodesy";
import { type Mosaic, mosaicFor, mosaicHeight } from "./mosaic";

const DEG = Math.PI / 180;

export interface PeakInput {
	id?: string;
	name?: string;
	lat: number;
	lon: number;
	/** OSM `ele`, metres. */
	ele?: number;
}

export interface SnappedPeak<P extends PeakInput = PeakInput> {
	peak: P;
	/** Index of the peak in the input array. */
	index: number;
	/** Summit position used (snapped DEM local max, or the OSM node). */
	lat: number;
	lon: number;
	/** max(DEM summit, OSM ele), metres. */
	height: number;
	/** DEM height at the summit position used. */
	demHeight: number;
	snapped: boolean;
	/** How far the snap moved the summit, metres (0 when not snapped). */
	snapDistance: number;
	/** Great-circle distance and bearing from the eye. */
	distance: number;
	azimuth: number;
	/** Ground size of a DEM cell at this distance, metres. */
	cell: number;
}

export interface PeakVisibility<P extends PeakInput = PeakInput>
	extends SnappedPeak<P> {
	/** Apparent elevation of the summit, degrees. */
	elevation: number;
	/** Max apparent elevation of terrain nearer than the summit's guard zone. */
	occluderElevation: number;
	/** Distance of that occluding terrain, metres (0 if none). */
	occluderDistance: number;
	/** Skyline elevation along the summit's exact bearing, degrees. */
	skylineElevation: number;
	/** Distance of the skyline point on that bearing, metres. */
	skylineDistance: number;
	visible: boolean;
	/** Visible or hidden within the tolerance band: draw dimmed. */
	marginal: boolean;
	onSkyline: boolean;
}

export interface SnapOptions {
	/** Search radius floor, metres (radius = max(this, cells · cell)). */
	minRadius?: number;
	cells?: number;
	/** Reject snaps moving further than this, metres. */
	maxMove?: number;
	/** Reject snaps changing the height by more than this, metres. */
	maxHeightChange?: number;
	maxDistance?: number;
	minDistance?: number;
}

export interface ClassifyOptions {
	/** DEM vertical error σ_z, metres. */
	sigmaZ?: number;
	/** Angular tolerance, degrees. */
	tolerance?: number;
	/** onSkyline threshold, degrees. */
	skylineTolerance?: number;
}

/** Height sampler: lon, lat and the distance from the eye (ring choice). */
export type HeightAt = (lon: number, lat: number, distance: number) => number;

export const mosaicHeightAt =
	(mosaics: Mosaic[]): HeightAt =>
	(lon, lat, d) =>
		mosaicHeight(mosaicFor(mosaics, d), lon, lat);

/**
 * Snaps each peak to the DEM local maximum of a dense 7×7 grid within
 * max(minRadius, cells · cell) of the OSM node. Height = max(DEM, OSM ele)
 * (DEMs smooth summits low). Snaps that move > maxMove or change the height
 * by > maxHeightChange (vs OSM ele, else DEM at the node) are rejected.
 * Peaks outside [minDistance, maxDistance] or without data are dropped.
 */
export function snapPeaks<P extends PeakInput>(
	peaks: P[],
	heightAt: HeightAt,
	cellAt: (distance: number) => number,
	eye: { lat: number; lon: number },
	opts: SnapOptions = {},
): SnappedPeak<P>[] {
	const minRadius = opts.minRadius ?? 150;
	const cells = opts.cells ?? 3;
	const maxMove = opts.maxMove ?? 300;
	const maxDh = opts.maxHeightChange ?? 80;
	const maxDistance = opts.maxDistance ?? Number.POSITIVE_INFINITY;
	const minDistance = opts.minDistance ?? 50;
	const out: SnappedPeak<P>[] = [];
	for (let index = 0; index < peaks.length; index++) {
		const peak = peaks[index];
		const db = distanceBearing(eye.lat, eye.lon, peak.lat, peak.lon);
		if (db.distance > maxDistance || db.distance < minDistance) continue;
		const cell = cellAt(db.distance);
		const r = Math.max(minRadius, cells * cell);
		const mPerLat = EARTH_R * DEG;
		const mPerLon = mPerLat * Math.cos(peak.lat * DEG);
		const h0 = heightAt(peak.lon, peak.lat, db.distance);
		let best = h0;
		let bi = 0;
		let bj = 0;
		for (let j = -3; j <= 3; j++)
			for (let i = -3; i <= 3; i++) {
				if (!i && !j) continue;
				const e = (i * r) / 3;
				const n = (j * r) / 3;
				const h = heightAt(
					peak.lon + e / mPerLon,
					peak.lat + n / mPerLat,
					db.distance,
				);
				if (h > best || (Number.isNaN(best) && !Number.isNaN(h))) {
					best = h;
					bi = i;
					bj = j;
				}
			}
		const ele = peak.ele;
		if (Number.isNaN(best) && ele === undefined) continue;
		const move = Math.hypot(bi, bj) * (r / 3);
		const ref = ele ?? h0;
		const ok =
			!Number.isNaN(best) &&
			move <= maxMove &&
			(Number.isNaN(ref) || Math.abs(best - ref) <= maxDh);
		let lat = peak.lat;
		let lon = peak.lon;
		let dem = h0;
		if (ok && (bi || bj)) {
			lat = peak.lat + (bj * r) / 3 / mPerLat;
			lon = peak.lon + (bi * r) / 3 / mPerLon;
			dem = best;
		}
		const snapped = ok && (bi !== 0 || bj !== 0);
		const height = Math.max(
			Number.isNaN(dem) ? Number.NEGATIVE_INFINITY : dem,
			ele ?? Number.NEGATIVE_INFINITY,
		);
		if (!Number.isFinite(height)) continue;
		const pos = snapped ? distanceBearing(eye.lat, eye.lon, lat, lon) : db;
		out.push({
			peak,
			index,
			lat,
			lon,
			height,
			demHeight: dem,
			snapped,
			snapDistance: snapped ? move : 0,
			distance: pos.distance,
			azimuth: pos.bearing,
			cell,
		});
	}
	return out;
}

/** Distance before the summit where the occlusion test stops, metres. */
export const occlusionStop = (p: SnappedPeak) =>
	p.distance - Math.max(2 * p.cell, 150);

/**
 * visible   = α_p ≥ α_occ − (tol + σ_z / d_p)
 * marginal  = |α_p − α_occ| < tol + σ_z / d_p
 * onSkyline = visible and α_p ≥ α_sky − skylineTolerance
 * where α_occ is the running max before occlusionStop and α_sky the skyline
 * on the peak's exact bearing (all in degrees, t = tan α).
 */
export function classifyPeak<P extends PeakInput>(
	p: SnappedPeak<P>,
	eyeH: number,
	inv2R: number,
	tOcc: number,
	dOcc: number,
	tSky: number,
	dSky: number,
	opts: ClassifyOptions = {},
): PeakVisibility<P> {
	const sigmaZ = opts.sigmaZ ?? 5;
	const tol =
		(opts.tolerance ?? 0.02) + ((sigmaZ / p.distance) * 180) / Math.PI;
	const skyTol = opts.skylineTolerance ?? 0.05;
	const d = p.distance;
	const elevation = Math.atan((p.height - eyeH) / d - d * inv2R) / DEG;
	const occluderElevation =
		tOcc === Number.NEGATIVE_INFINITY ? -90 : Math.atan(tOcc) / DEG;
	const skylineElevation =
		tSky === Number.NEGATIVE_INFINITY ? -90 : Math.atan(tSky) / DEG;
	const visible = elevation >= occluderElevation - tol;
	return {
		...p,
		elevation,
		occluderElevation,
		occluderDistance: dOcc,
		skylineElevation,
		skylineDistance: dSky,
		visible,
		marginal: Math.abs(elevation - occluderElevation) < tol,
		onSkyline: visible && elevation >= skylineElevation - skyTol,
	};
}
