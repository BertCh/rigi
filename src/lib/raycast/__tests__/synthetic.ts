// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Synthetic single-ring Mosaics for the ray-cast specs: heights come from a function of the great-circle
// polar coordinates (distance m, bearing deg) around the eye, sampled at the Mercator pixel centres.
import { DEG, EARTH_R } from "../../geodesy";
import {
	buildMips,
	cellMeters,
	MIP_MAX_LEVEL,
	type Mosaic,
	mercator,
} from "../../horizon-fast/mosaic";

/** Great-circle distance (m, EARTH_R) and bearing (deg) from the eye to a point. */
export function polarFrom(
	eye: { lat: number; lon: number },
	lat: number,
	lon: number,
) {
	const p1 = eye.lat * DEG;
	const p2 = lat * DEG;
	const dl = (lon - eye.lon) * DEG;
	const a =
		Math.sin((p2 - p1) / 2) ** 2 +
		Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
	const dist = 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
	const y = Math.sin(dl) * Math.cos(p2);
	const x =
		Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
	return { dist, bearing: (Math.atan2(y, x) / DEG + 360) % 360 };
}

/** One ring of `radius` metres around the eye at zoom z (512 px tiles), with its max mips. */
export function syntheticMosaic(
	eye: { lat: number; lon: number },
	z: number,
	radius: number,
	height: (dist: number, bearing: number) => number,
	maxDistance = radius,
): Mosaic {
	const T = 512;
	const worldPx = 2 ** z * T;
	const cell = cellMeters(eye.lat, z, T);
	const m = mercator(eye.lon, eye.lat);
	const half = Math.ceil((radius * 1.02) / cell) + 8;
	const A = 1 << MIP_MAX_LEVEL;
	const x0 = Math.floor((m.x * worldPx - half) / A) * A;
	const y0 = Math.floor((m.y * worldPx - half) / A) * A;
	const width = Math.ceil((m.x * worldPx + half - x0) / A) * A;
	const heightPx = Math.ceil((m.y * worldPx + half - y0) / A) * A;
	const data = new Float32Array(width * heightPx);
	for (let j = 0; j < heightPx; j++) {
		const Y = (y0 + j + 0.5) / worldPx;
		const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * Y))) * 180) / Math.PI;
		for (let i = 0; i < width; i++) {
			const lon = ((x0 + i + 0.5) / worldPx) * 360 - 180;
			const p = polarFrom(eye, lat, lon);
			data[j * width + i] = height(p.dist, p.bearing);
		}
	}
	const mosaic: Mosaic = {
		z,
		tileSize: T,
		worldPx,
		x0,
		y0,
		width,
		height: heightPx,
		data,
		minDistance: 0,
		maxDistance,
		cellMeters: cell,
	};
	mosaic.mip = buildMips(mosaic);
	return mosaic;
}
