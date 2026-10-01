// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Solar position for a photo: NOAA / Meeus low-precision ephemeris (≈0.01° over 1950–2050),
// plus the direction in the camera-local ENU frame (x east, y north, z up) the terrain uses.
// takenAt in photos.json is UTC (EXIF DateTimeOriginal + OffsetTime), so no timezone guessing.

import type { Vec3 } from "../ontology/core/geometry";
import type { Sun } from "../style/types";

const D = Math.PI / 180;

export type SunPosition = {
	/** Degrees clockwise from true north. */
	azimuth: number;
	/** Degrees above the astronomical horizon, including a standard refraction correction. */
	elevation: number;
	/** Unit vector toward the sun in ENU. */
	dir: [number, number, number];
};

export function sunPosition(
	date: Date | string,
	lat: number,
	lon: number,
): SunPosition {
	const t = typeof date === "string" ? new Date(date) : date;
	const jd = t.getTime() / 86400000 + 2440587.5;
	const T = (jd - 2451545) / 36525; // Julian centuries since J2000

	const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
	const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
	const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
	const C =
		Math.sin(M * D) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
		Math.sin(2 * M * D) * (0.019993 - 0.000101 * T) +
		Math.sin(3 * M * D) * 0.000289;
	const trueLong = L0 + C;
	const omega = 125.04 - 1934.136 * T;
	const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * D);
	const eps0 =
		23 +
		(26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
	const eps = eps0 + 0.00256 * Math.cos(omega * D);
	const decl = Math.asin(Math.sin(eps * D) * Math.sin(lambda * D));

	// equation of time (minutes)
	const y = Math.tan((eps / 2) * D) ** 2;
	const eot =
		(4 / D) *
		(y * Math.sin(2 * L0 * D) -
			2 * e * Math.sin(M * D) +
			4 * e * y * Math.sin(M * D) * Math.cos(2 * L0 * D) -
			0.5 * y * y * Math.sin(4 * L0 * D) -
			1.25 * e * e * Math.sin(2 * M * D));

	const utcMin =
		t.getUTCHours() * 60 + t.getUTCMinutes() + t.getUTCSeconds() / 60;
	const tst = (((utcMin + eot + 4 * lon) % 1440) + 1440) % 1440; // true solar time, minutes
	const ha = (tst / 4 - 180) * D; // hour angle

	const phi = lat * D;
	const cosZen =
		Math.sin(phi) * Math.sin(decl) +
		Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
	const zen = Math.acos(Math.min(1, Math.max(-1, cosZen)));
	let el = 90 - zen / D;
	// Bennett refraction (degrees); negligible above ~20°
	if (el > -1) el += 1.02 / (60 * Math.tan((el + 10.3 / (el + 5.11)) * D));

	const az =
		(Math.atan2(
			Math.sin(ha),
			Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi),
		) /
			D +
			180 +
			360) %
		360;

	const ce = Math.cos(el * D);
	return {
		azimuth: az,
		elevation: el,
		dir: [ce * Math.sin(az * D), ce * Math.cos(az * D), Math.sin(el * D)],
	};
}

/**
 * Clear-sky sun colour (linear) from elevation in degrees, or from an ENU direction toward the sun:
 * Rayleigh + a little Mie along the Kasten–Young air mass, normalised so the high sun is ~white.
 * Low sun turns warm on its own.
 */
export function sunColor(sun: number | Vec3): Vec3 {
	const elev =
		typeof sun === "number"
			? sun
			: Math.asin(
					Math.max(-1, Math.min(1, sun[2] / (Math.hypot(...sun) || 1))),
				) / D;
	const el = Math.max(elev, -1);
	const m =
		1 /
		(Math.sin(Math.max(el, 0.5) * D) +
			0.50572 * (Math.max(el, 0.5) + 6.07995) ** -1.6364);
	const betaR = [5.8e-6, 13.5e-6, 33.1e-6];
	const tauM = 0.06;
	const c = betaR.map((b) => Math.exp(-b * 8000 * m - tauM * m));
	const ref = betaR.map((b) => Math.exp(-b * 8000 * 1.0 - tauM));
	const fade = Math.min(1, Math.max(0, (el + 1) / 4));
	return [
		(c[0] / ref[0]) * fade,
		(c[1] / ref[1]) * fade,
		(c[2] / ref[2]) * fade,
	];
}

export type SunContext = {
	takenAt?: string | null;
	lat?: number;
	lon?: number;
};

/** ENU unit vector toward the style's sun. Normalised like THREE.Vector3.normalize (the classic uSunDir). */
export function sunDirFromStyle(sun: Sun, ctx: SunContext = {}): Vec3 {
	if (sun.mode === "azel") {
		const az = sun.azimuthDeg * D;
		const el = sun.elevationDeg * D;
		return norm([
			Math.sin(az) * Math.cos(el),
			Math.cos(az) * Math.cos(el),
			Math.sin(el),
		]);
	}
	if (
		sun.mode === "photo-time" &&
		ctx.takenAt &&
		ctx.lat != null &&
		ctx.lon != null
	) {
		try {
			const p = sunPosition(ctx.takenAt, ctx.lat, ctx.lon);
			// a sun below the horizon lights nothing: keep a low grazing light from its azimuth instead
			if (Number.isFinite(p.azimuth))
				return sunDirFromStyle({
					mode: "azel",
					azimuthDeg: p.azimuth,
					elevationDeg: Math.max(p.elevation, 8),
				});
		} catch {
			// bad timestamp: fall through to the classic direction
		}
	}
	return norm(sun.mode === "fixed" ? sun.dir : [-0.5, -0.4, 0.75]);
}

function norm(v: Vec3): Vec3 {
	const k = 1 / (Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1);
	return [v[0] * k, v[1] * k, v[2] * k];
}
