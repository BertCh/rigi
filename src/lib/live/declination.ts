// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Magnetic declination (true heading = magnetic heading + declination, east positive) from a compact
// geomagnetic main-field model: the degree and order 4 terms of the World Magnetic Model (WMM2020 epoch
// 2020.0 Gauss coefficients and secular variation, NOAA NCEI / BGS, US government work, public domain).
// Truncating at degree 4 keeps the table to 14 rows and drops the crustal and small-scale terms, so the
// declination is good to about 1 degree in the Alps and up to about 3 degrees elsewhere (measured against
// published 2026 values for eight cities in __tests__/declination.spec.ts), and the 2020 epoch plus linear secular variation drifts a few tenths of
// a degree per decade in the Alps. That is the same order as a phone compass; the tracker refines yaw
// from the skyline anyway. Do not use it near the magnetic poles.

const DEGREES_TO_RADIANS = Math.PI / 180;

/** [n, m, g, h, gDot, hDot]: nT and nT/yr, WMM2020 epoch 2020.0. */
const WMM_TERMS: readonly (readonly [
	number,
	number,
	number,
	number,
	number,
	number,
])[] = [
	[1, 0, -29404.5, 0, 6.7, 0],
	[1, 1, -1450.7, 4652.9, 7.7, -25.1],
	[2, 0, -2500.0, 0, -11.5, 0],
	[2, 1, 2982.0, -2991.6, -7.1, -30.2],
	[2, 2, 1676.8, -734.8, -2.2, -23.9],
	[3, 0, 1363.9, 0, 2.8, 0],
	[3, 1, -2381.2, -82.2, -6.2, 5.7],
	[3, 2, 1236.2, 241.8, 3.4, -1.0],
	[3, 3, 525.7, -542.9, -12.2, 1.1],
	[4, 0, 903.1, 0, -1.1, 0],
	[4, 1, 809.4, 282.0, -1.6, 0.2],
	[4, 2, 86.2, -158.4, -6.0, 6.9],
	[4, 3, -309.4, 199.8, 5.4, 3.7],
	[4, 4, 48.0, -349.7, -5.5, -5.6],
];

/** Schmidt semi-normalised associated Legendre function P_n^m(cos colatitude), no Condon-Shortley phase. */
function schmidtLegendre(
	degree: number,
	order: number,
	colatitude: number,
): number {
	const x = Math.cos(colatitude);
	const s = Math.sin(colatitude);
	let pmm = 1;
	for (let i = 1; i <= order; i++) pmm *= (2 * i - 1) * s;
	let value = pmm;
	if (degree > order) {
		let previous = pmm;
		value = x * (2 * order + 1) * pmm;
		for (let n = order + 2; n <= degree; n++) {
			const next =
				(x * (2 * n - 1) * value - (n + order - 1) * previous) / (n - order);
			previous = value;
			value = next;
		}
	}
	if (order === 0) return value;
	let ratio = 1; // (n-m)! / (n+m)!
	for (let k = degree - order + 1; k <= degree + order; k++) ratio /= k;
	return Math.sqrt(2 * ratio) * value;
}

/** Decimal year of a Date (UTC). */
export function decimalYear(date: Date): number {
	const year = date.getUTCFullYear();
	const start = Date.UTC(year, 0, 1);
	const end = Date.UTC(year + 1, 0, 1);
	return year + (date.getTime() - start) / (end - start);
}

/**
 * Magnetic declination in degrees (east positive) at a geodetic position, at sea level on a sphere.
 * `year` is a decimal year (default: now); the secular variation is applied linearly from 2020.0.
 */
export function magneticDeclination(
	lat: number,
	lon: number,
	year: number = decimalYear(new Date()),
): number {
	const clampedLat = Math.max(-89.9, Math.min(89.9, lat));
	const colatitude = (90 - clampedLat) * DEGREES_TO_RADIANS;
	const longitude = lon * DEGREES_TO_RADIANS;
	const dt = year - 2020;
	const step = 1e-4;
	let north = 0;
	let east = 0;
	for (const [n, m, g0, h0, gDot, hDot] of WMM_TERMS) {
		const g = g0 + gDot * dt;
		const h = h0 + hDot * dt;
		const cosine = Math.cos(m * longitude);
		const sine = Math.sin(m * longitude);
		const p = schmidtLegendre(n, m, colatitude);
		const dp =
			(schmidtLegendre(n, m, colatitude + step) -
				schmidtLegendre(n, m, colatitude - step)) /
			(2 * step);
		// B = -grad V at r = a: X (north) = dV/dtheta / a, Y (east) = -(1/sin theta) dV/dphi / a
		north += (g * cosine + h * sine) * dp;
		east += (m * (g * sine - h * cosine) * p) / Math.sin(colatitude);
	}
	return Math.atan2(east, north) / DEGREES_TO_RADIANS;
}
