// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Roll coverage, shared maths: a local metric frame (east/north metres around the roll centre), the
// view wedge of a photo on the ground (eye, heading ± half field of view, ground radius) and the exact
// point-in-wedge test. Pure and deterministic: the CPU twins and the GPU paths both build on it.
// Display-only; nothing here feeds the matcher or a pose.
import { PRIOR_FAN_DEG } from "../../terroir/roll/logic";

/** What coverage needs of a photo: eye, true-north heading, horizontal field of view. */
export type CoveragePhoto = {
	lat: number;
	lon: number;
	/** compass heading of the optical axis, degrees clockwise from true north */
	yawDeg: number;
	/** horizontal field of view, degrees */
	hfovDeg: number;
	/** EXIF-only heading (poseSource "prior"): drawn with a wider fan, counted with less weight */
	uncertain?: boolean;
};

/** Equirectangular frame around (lat0, lon0): x east, y north, metres. Fine at roll scale (tens of km). */
export type Frame = {
	lat0: number;
	lon0: number;
	metresPerDegLat: number;
	metresPerDegLon: number;
};

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

export function makeFrame(lat0: number, lon0: number): Frame {
	const metresPerDegLat = EARTH_RADIUS_M * DEG;
	return {
		lat0,
		lon0,
		metresPerDegLat,
		metresPerDegLon: metresPerDegLat * Math.cos(lat0 * DEG),
	};
}

/** The frame at the mean position of `photos` (the roll centre when the caller has none). */
export function frameAround(photos: readonly CoveragePhoto[]): Frame {
	if (!photos.length) return makeFrame(0, 0);
	let lat = 0;
	let lon = 0;
	for (const p of photos) {
		lat += p.lat;
		lon += p.lon;
	}
	return makeFrame(lat / photos.length, lon / photos.length);
}

export function toEnu(frame: Frame, lat: number, lon: number) {
	return {
		x: (lon - frame.lon0) * frame.metresPerDegLon,
		y: (lat - frame.lat0) * frame.metresPerDegLat,
	};
}

export function fromEnu(frame: Frame, x: number, y: number) {
	return {
		lat: frame.lat0 + y / frame.metresPerDegLat,
		lon: frame.lon0 + x / frame.metresPerDegLon,
	};
}

/** A photo's view wedge on the ground, in frame metres. */
export type Wedge = {
	/** index of the photo in the input array */
	index: number;
	x: number;
	y: number;
	/** compass heading, radians clockwise from north */
	yawRad: number;
	/** half opening angle, radians (at most π) */
	halfRad: number;
	radius: number;
	/** contribution to a cell it covers (1 for a measured pose, less for a prior fan) */
	weight: number;
};

export type WedgeOptions = {
	/** ground radius of every wedge, metres (default 4000) */
	radiusM?: number;
	/** extra half angle of an uncertain pose, degrees (default PRIOR_FAN_DEG) */
	fanDeg?: number;
	/** weight of an uncertain photo (default 0.5) */
	uncertainWeight?: number;
};

export const DEFAULT_RADIUS_M = 4000;
export const DEFAULT_UNCERTAIN_WEIGHT = 0.5;

export function wedgesOf(
	photos: readonly CoveragePhoto[],
	frame: Frame,
	opts: WedgeOptions = {},
): Wedge[] {
	const radius = opts.radiusM ?? DEFAULT_RADIUS_M;
	const fan = opts.fanDeg ?? PRIOR_FAN_DEG;
	const uncertainWeight = opts.uncertainWeight ?? DEFAULT_UNCERTAIN_WEIGHT;
	return photos.map((p, index) => {
		const { x, y } = toEnu(frame, p.lat, p.lon);
		const halfDeg =
			Math.min(179, Math.max(0, p.hfovDeg)) / 2 + (p.uncertain ? fan : 0);
		return {
			index,
			x,
			y,
			yawRad: p.yawDeg * DEG,
			halfRad: Math.min(Math.PI, halfDeg * DEG),
			radius,
			weight: p.uncertain ? uncertainWeight : 1,
		};
	});
}

/** Signed difference a - b wrapped to (-π, π]. */
export function wrapAngle(angle: number) {
	const t = Math.PI * 2;
	let a = angle % t;
	if (a > Math.PI) a -= t;
	else if (a <= -Math.PI) a += t;
	return a;
}

/** Exact test: is the ground point (px, py) inside the wedge (distance <= radius, bearing within half angle)? */
export function wedgeContains(wedge: Wedge, px: number, py: number) {
	const dx = px - wedge.x;
	const dy = py - wedge.y;
	const d2 = dx * dx + dy * dy;
	if (d2 > wedge.radius * wedge.radius) return false;
	if (d2 < 1e-12) return true; // at the eye every bearing is inside
	return (
		Math.abs(wrapAngle(Math.atan2(dx, dy) - wedge.yawRad)) <= wedge.halfRad
	);
}

/** Tight axis-aligned box of a wedge: the eye, both edge points and every compass axis inside the arc. */
export function wedgeBounds(wedge: Wedge) {
	let minX = wedge.x;
	let maxX = wedge.x;
	let minY = wedge.y;
	let maxY = wedge.y;
	const add = (bearing: number) => {
		const px = wedge.x + wedge.radius * Math.sin(bearing);
		const py = wedge.y + wedge.radius * Math.cos(bearing);
		minX = Math.min(minX, px);
		maxX = Math.max(maxX, px);
		minY = Math.min(minY, py);
		maxY = Math.max(maxY, py);
	};
	add(wedge.yawRad - wedge.halfRad);
	add(wedge.yawRad + wedge.halfRad);
	for (let k = 0; k < 4; k++) {
		const axis = (k * Math.PI) / 2;
		if (Math.abs(wrapAngle(axis - wedge.yawRad)) <= wedge.halfRad) add(axis);
	}
	return { minX, minY, maxX, maxY };
}

/** Azimuth and range samples per wedge of the coverage heat grid (same on the GPU and in the CPU twin). */
export const AZIMUTH_SAMPLES = 128;
export const RANGE_SAMPLES = 48;
export const SAMPLES_PER_WEDGE = AZIMUTH_SAMPLES * RANGE_SAMPLES;

/**
 * The ground samples of the wedges, exactly as the WGSL kernel generates them: ring `ri` of the
 * RANGE_SAMPLES rings at the mid range of its band, AZIMUTH_SAMPLES bearings per ring (odd rings
 * staggered by half a step), weight = wedge weight * area of the sample's polar patch / `cellArea`
 * (so a cell the wedge fully covers collects about the wedge weight, whatever the range).
 */
export function wedgeSamples(
	wedges: readonly Wedge[],
	cellArea: number,
	capacity = wedges.length,
) {
	const total = capacity * SAMPLES_PER_WEDGE;
	const positions = new Float32Array(total * 2);
	const weights = new Float32Array(total);
	for (let w = 0; w < wedges.length; w++) {
		const wedge = wedges[w];
		const dr = wedge.radius / RANGE_SAMPLES;
		const dtheta = (2 * wedge.halfRad) / AZIMUTH_SAMPLES;
		const scale = (wedge.weight * dr * dtheta) / cellArea;
		for (let k = 0; k < SAMPLES_PER_WEDGE; k++) {
			const i = w * SAMPLES_PER_WEDGE + k;
			const ri = Math.floor(k / AZIMUTH_SAMPLES);
			const ai = k % AZIMUTH_SAMPLES;
			const r = ((ri + 0.5) / RANGE_SAMPLES) * wedge.radius;
			const stagger = ri & 1 ? 0.75 : 0.25;
			const theta =
				wedge.yawRad +
				((ai + stagger) / AZIMUTH_SAMPLES - 0.5) * 2 * wedge.halfRad;
			positions[2 * i] = wedge.x + r * Math.sin(theta);
			positions[2 * i + 1] = wedge.y + r * Math.cos(theta);
			weights[i] = scale * r;
		}
	}
	return { positions, weights };
}
