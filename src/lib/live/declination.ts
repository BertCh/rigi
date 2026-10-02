// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Magnetic declination (true heading = magnetic heading + declination, east positive) from the full World
// Magnetic Model WMM2025 (degree and order 12, main field plus linear secular variation, epoch 2025.0, valid
// 2025 to 2030; NOAA NCEI and BGS, public domain). Coefficients: wmmCoefficients.ts, generated from the
// official WMM.COF by scripts/live/wmm-gen.ts. Synthesis follows the WMM technical report: geodetic to
// geocentric conversion, Schmidt semi-normalised associated Legendre functions, rotation back to geodetic.
// Outside 2025 to 2030 the secular variation is extrapolated linearly, so the error grows with distance from
// that window. Do not use it near the magnetic poles (declination is ill-conditioned there).

import { WMM_DEGREE, WMM_EPOCH, WMM_TERMS } from "./wmmCoefficients";

const DEGREES_TO_RADIANS = Math.PI / 180;
const WGS84_SEMI_MAJOR_KM = 6378.137;
const WGS84_ECCENTRICITY_SQUARED =
	(1 / 298.257223563) * (2 - 1 / 298.257223563);
const WMM_REFERENCE_RADIUS_KM = 6371.2;

export interface MagneticField {
	/** Declination in degrees, east positive. */
	declination: number;
	/** Inclination (dip) in degrees, positive downward. */
	inclination: number;
	/** North, east and down components in nT. */
	north: number;
	east: number;
	down: number;
	horizontal: number;
	total: number;
}

/** Decimal year of a Date (UTC). */
export function decimalYear(date: Date): number {
	const year = date.getUTCFullYear();
	const start = Date.UTC(year, 0, 1);
	const end = Date.UTC(year + 1, 0, 1);
	return year + (date.getTime() - start) / (end - start);
}

/**
 * The WMM2025 main field at a geodetic position. `year` is a decimal year (default: now) and
 * `heightKm` the height above the WGS84 ellipsoid.
 */
export function magneticField(
	lat: number,
	lon: number,
	year: number = decimalYear(new Date()),
	heightKm = 0,
): MagneticField {
	const latitude =
		Math.max(-89.9999, Math.min(89.9999, lat)) * DEGREES_TO_RADIANS;
	const longitude = lon * DEGREES_TO_RADIANS;
	// geodetic to geocentric spherical
	const sinLat = Math.sin(latitude);
	const primeVertical =
		WGS84_SEMI_MAJOR_KM /
		Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * sinLat * sinLat);
	const rho = (primeVertical + heightKm) * Math.cos(latitude);
	const z =
		(primeVertical * (1 - WGS84_ECCENTRICITY_SQUARED) + heightKm) * sinLat;
	const radius = Math.hypot(rho, z);
	const geocentricLatitude = Math.asin(z / radius);
	const sinTheta = Math.cos(geocentricLatitude);
	const cosTheta = Math.sin(geocentricLatitude);

	// Gauss-normalised Legendre functions and their theta derivatives, then Schmidt scaling
	const size = WMM_DEGREE + 1;
	const legendre = new Float64Array(size * size);
	const legendreDerivative = new Float64Array(size * size);
	const at = (n: number, m: number) => n * size + m;
	legendre[0] = 1;
	for (let n = 1; n <= WMM_DEGREE; n++) {
		for (let m = 0; m <= n; m++) {
			const index = at(n, m);
			if (n === m) {
				legendre[index] = sinTheta * legendre[at(n - 1, m - 1)];
				legendreDerivative[index] =
					sinTheta * legendreDerivative[at(n - 1, m - 1)] +
					cosTheta * legendre[at(n - 1, m - 1)];
			} else if (n === 1 || m > n - 2) {
				legendre[index] = cosTheta * legendre[at(n - 1, m)];
				legendreDerivative[index] =
					cosTheta * legendreDerivative[at(n - 1, m)] -
					sinTheta * legendre[at(n - 1, m)];
			} else {
				const k = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
				legendre[index] =
					cosTheta * legendre[at(n - 1, m)] - k * legendre[at(n - 2, m)];
				legendreDerivative[index] =
					cosTheta * legendreDerivative[at(n - 1, m)] -
					sinTheta * legendre[at(n - 1, m)] -
					k * legendreDerivative[at(n - 2, m)];
			}
		}
	}
	let schmidtDiagonal = 1; // m = 0 factor, (2n-1)!!/n!
	for (let n = 1; n <= WMM_DEGREE; n++) {
		schmidtDiagonal *= (2 * n - 1) / n;
		let factor = schmidtDiagonal;
		for (let m = 0; m <= n; m++) {
			if (m > 0)
				factor *= Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m));
			legendre[at(n, m)] *= factor;
			legendreDerivative[at(n, m)] *= factor;
		}
	}

	const dt = year - WMM_EPOCH;
	let radial = 0;
	let theta = 0;
	let phi = 0;
	for (const [n, m, g0, h0, gDot, hDot] of WMM_TERMS) {
		const g = g0 + gDot * dt;
		const h = h0 + hDot * dt;
		const cosine = Math.cos(m * longitude);
		const sine = Math.sin(m * longitude);
		const scale = (WMM_REFERENCE_RADIUS_KM / radius) ** (n + 2);
		const p = legendre[at(n, m)];
		const dp = legendreDerivative[at(n, m)];
		radial += scale * (n + 1) * (g * cosine + h * sine) * p;
		theta -= scale * (g * cosine + h * sine) * dp;
		phi += (scale * m * (g * sine - h * cosine) * p) / sinTheta;
	}
	// spherical (r, theta, phi) to geocentric north/east/down, then rotate to geodetic
	const northPrime = -theta;
	const downPrime = -radial;
	const rotation = geocentricLatitude - latitude;
	const north =
		northPrime * Math.cos(rotation) - downPrime * Math.sin(rotation);
	const down = northPrime * Math.sin(rotation) + downPrime * Math.cos(rotation);
	const east = phi;
	const horizontal = Math.hypot(north, east);
	return {
		declination: Math.atan2(east, north) / DEGREES_TO_RADIANS,
		inclination: Math.atan2(down, horizontal) / DEGREES_TO_RADIANS,
		north,
		east,
		down,
		horizontal,
		total: Math.hypot(horizontal, down),
	};
}

/** Magnetic declination in degrees (east positive) at sea level (WGS84 ellipsoid). `year` is a decimal year (default: now). */
export function magneticDeclination(
	lat: number,
	lon: number,
	year: number = decimalYear(new Date()),
): number {
	return magneticField(lat, lon, year).declination;
}
