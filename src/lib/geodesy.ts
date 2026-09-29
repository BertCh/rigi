// Geodesy helpers: WGS84 ↔ ECEF ↔ camera-local ENU, spherical great-circle helpers, angle wrapping.
// All ENU work is float64 on the CPU; only camera-relative offsets reach the GPU. Tile math: src/lib/dem.

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
/** WGS84 ellipsoid: equatorial radius (also the Web-Mercator ground scale), flattening, e². Never EARTH_R. */
export const WGS84 = { A, F, E2 } as const;
/** Mean Earth radius (IUGG) for every spherical model: curvature drop, great circles. */
export const EARTH_R = 6371008.8;
/** Coefficient of atmospheric refraction used to lift distant terrain (k ≈ 0.13). */
export const REFRACTION_K = 0.13;

const DEG = Math.PI / 180;

export type LatLon = { lat: number; lon: number };

export function toEcef(
	lat: number,
	lon: number,
	h: number,
): [number, number, number] {
	const phi = lat * DEG;
	const lam = lon * DEG;
	const s = Math.sin(phi);
	const n = A / Math.sqrt(1 - E2 * s * s);
	const c = Math.cos(phi);
	return [
		(n + h) * c * Math.cos(lam),
		(n + h) * c * Math.sin(lam),
		(n * (1 - E2) + h) * s,
	];
}

/** Local East-North-Up frame anchored at an origin. x = east, y = north, z = up (metres). */
export class EnuFrame {
	readonly lat: number;
	readonly lon: number;
	readonly h: number;
	private o: [number, number, number];
	private r: number[];

	constructor(lat: number, lon: number, h: number) {
		this.lat = lat;
		this.lon = lon;
		this.h = h;
		this.o = toEcef(lat, lon, h);
		const phi = lat * DEG;
		const lam = lon * DEG;
		const sp = Math.sin(phi);
		const cp = Math.cos(phi);
		const sl = Math.sin(lam);
		const cl = Math.cos(lam);
		// rows: east, north, up
		this.r = [-sl, cl, 0, -sp * cl, -sp * sl, cp, cp * cl, cp * sl, sp];
	}

	/** WGS84 → ENU, with an effective-radius refraction correction. */
	fromGeo(
		lat: number,
		lon: number,
		h: number,
		out: number[] = [0, 0, 0],
	): number[] {
		const [x, y, z] = toEcef(lat, lon, h);
		const dx = x - this.o[0];
		const dy = y - this.o[1];
		const dz = z - this.o[2];
		const r = this.r;
		const e = r[0] * dx + r[1] * dy + r[2] * dz;
		const n = r[3] * dx + r[4] * dy + r[5] * dz;
		const u = r[6] * dx + r[7] * dy + r[8] * dz;
		const d2 = e * e + n * n;
		out[0] = e;
		out[1] = n;
		out[2] = u + (REFRACTION_K * d2) / (2 * EARTH_R);
		return out;
	}

	/** ENU → approximate WGS84 (inverse of the local tangent plane; good to ~cm at <200 km). */
	toGeo(
		e: number,
		n: number,
		u: number,
	): { lat: number; lon: number; h: number } {
		const r = this.r;
		const d2 = e * e + n * n;
		const uu = u - (REFRACTION_K * d2) / (2 * EARTH_R);
		const x = this.o[0] + r[0] * e + r[3] * n + r[6] * uu;
		const y = this.o[1] + r[1] * e + r[4] * n + r[7] * uu;
		const z = this.o[2] + r[2] * e + r[5] * n + r[8] * uu;
		// Bowring's method
		const p = Math.hypot(x, y);
		const b = A * (1 - F);
		const ep2 = (A * A - b * b) / (b * b);
		const th = Math.atan2(z * A, p * b);
		const lat = Math.atan2(
			z + ep2 * b * Math.sin(th) ** 3,
			p - E2 * A * Math.cos(th) ** 3,
		);
		const lon = Math.atan2(y, x);
		const s = Math.sin(lat);
		const nn = A / Math.sqrt(1 - E2 * s * s);
		const h = p / Math.cos(lat) - nn;
		return { lat: lat / DEG, lon: lon / DEG, h };
	}
}

/** Great-circle-ish distance in metres (equirectangular; fine for < 300 km). */
export function distanceM(a: LatLon, b: LatLon) {
	const x = (b.lon - a.lon) * DEG * Math.cos(((a.lat + b.lat) / 2) * DEG);
	const y = (b.lat - a.lat) * DEG;
	return Math.hypot(x, y) * EARTH_R;
}

export function bearingDeg(a: LatLon, b: LatLon) {
	const x = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * DEG);
	const y = b.lat - a.lat;
	return (Math.atan2(x, y) / DEG + 360) % 360;
}

/** Great-circle destination point (spherical, EARTH_R). */
export function destination(
	lat: number,
	lon: number,
	azimuth: number,
	distance: number,
) {
	const d = distance / EARTH_R;
	const a = azimuth * DEG;
	const p1 = lat * DEG;
	const sinP2 =
		Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(a);
	const p2 = Math.asin(sinP2);
	const l2 =
		lon * DEG +
		Math.atan2(
			Math.sin(a) * Math.sin(d) * Math.cos(p1),
			Math.cos(d) - Math.sin(p1) * sinP2,
		);
	return { lat: p2 / DEG, lon: l2 / DEG };
}

/** Great-circle (haversine) distance (m) and initial bearing (deg) from 1 to 2. */
export function distanceBearing(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
) {
	const p1 = lat1 * DEG;
	const p2 = lat2 * DEG;
	const dl = (lon2 - lon1) * DEG;
	const a =
		Math.sin((p2 - p1) / 2) ** 2 +
		Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
	const distance = 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
	const y = Math.sin(dl) * Math.cos(p2);
	const x =
		Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
	const bearing = (((Math.atan2(y, x) / DEG) % 360) + 360) % 360;
	return { distance, bearing };
}

/** Angle in degrees → [−180, 180). */
export const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
/** Angle in degrees → [0, 360). */
export const wrap360 = (a: number) => ((a % 360) + 360) % 360;
