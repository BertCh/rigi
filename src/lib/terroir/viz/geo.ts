// Pure helpers for the terroir photo overlays (place card, glacier ghost, sun path, furniture).
// No DOM, no engine imports: checked in viz.check.ts. Display-only.
import type { LonLat } from "../types";

const D = Math.PI / 180;

/** Ray-casting point-in-ring (ring of [lon, lat]; open or closed). */
export function pointInRing(lon: number, lat: number, ring: LonLat[]): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		if (
			yi > lat !== yj > lat &&
			lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
		)
			inside = !inside;
	}
	return inside;
}

/** One polygon = outer ring first, then holes. */
export function pointInPolygon(lon: number, lat: number, poly: LonLat[][]) {
	if (!poly.length || !pointInRing(lon, lat, poly[0])) return false;
	for (let i = 1; i < poly.length; i++)
		if (pointInRing(lon, lat, poly[i])) return false;
	return true;
}

export const pointInMulti = (lon: number, lat: number, polys: LonLat[][][]) =>
	polys.some((p) => pointInPolygon(lon, lat, p));

const WORDS = [
	"north",
	"northeast",
	"east",
	"southeast",
	"south",
	"southwest",
	"west",
	"northwest",
];
/** Compass word of a bearing in degrees (the way a slope faces). */
export const aspectWord = (deg: number) =>
	WORDS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

export type Vec3 = [number, number, number];

/**
 * Slope (deg from horizontal) and aspect (deg clockwise from north, the direction the surface faces)
 * from ENU points around a pixel: east/west and up/down neighbours (screen axes, so only the
 * geometry matters). Returns the unit normal (z up) too. null when degenerate.
 */
export function surfaceNormal(
	left: Vec3,
	right: Vec3,
	up: Vec3,
	down: Vec3,
): { slope: number; aspect: number; normal: Vec3 } | null {
	const a: Vec3 = [right[0] - left[0], right[1] - left[1], right[2] - left[2]];
	const b: Vec3 = [up[0] - down[0], up[1] - down[1], up[2] - down[2]];
	let n: Vec3 = [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
	const l = Math.hypot(...n);
	if (!(l > 1e-9)) return null;
	n = [n[0] / l, n[1] / l, n[2] / l];
	if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
	const slope = Math.acos(Math.min(1, Math.max(-1, n[2]))) / D;
	const aspect = (((Math.atan2(n[0], n[1]) / D) % 360) + 360) % 360;
	return { slope, aspect, normal: n };
}

/** Angle (deg) between the surface normal and the sun; < 90 = facing the sun. */
export const sunIncidenceDeg = (normal: Vec3, sunDir: Vec3) =>
	Math.acos(
		Math.min(
			1,
			Math.max(
				-1,
				normal[0] * sunDir[0] + normal[1] * sunDir[1] + normal[2] * sunDir[2],
			),
		),
	) / D;

/** Equirectangular distance in metres (fine for the < 1 km name lookups). */
export function approxDistM(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
) {
	const dy = (lat2 - lat1) * 111320;
	const dx = (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * D);
	return Math.hypot(dx, dy);
}

/** n+1 points along the straight lat/lon line a → b (inclusive), with the distance from a in metres. */
export function resampleLine(
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
	n: number,
) {
	const total = approxDistM(a.lat, a.lon, b.lat, b.lon);
	const out: { lat: number; lon: number; d: number }[] = [];
	for (let i = 0; i <= n; i++) {
		const t = i / n;
		out.push({
			lat: a.lat + (b.lat - a.lat) * t,
			lon: a.lon + (b.lon - a.lon) * t,
			d: total * t,
		});
	}
	return out;
}

export function formatDist(m: number) {
	if (m < 1000) return `${Math.round(m / 10) * 10} m`;
	return `${m < 10000 ? (m / 1000).toFixed(1) : Math.round(m / 1000)} km`;
}

/** "+02:00" → minutes, or null. */
export function parseTz(tz: string | null | undefined): number | null {
	const m = tz?.match(/^([+-])(\d\d):?(\d\d)$/);
	return m
		? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
		: null;
}

/** "15:39" in the photo's own clock; `utc` marks the fallback when the photo has no offset. */
export function clockHM(t: Date | number, offMin: number | null) {
	const ms = (typeof t === "number" ? t : t.getTime()) + (offMin ?? 0) * 60000;
	const d = new Date(ms);
	const p = (x: number) => String(x).padStart(2, "0");
	return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${offMin == null ? " UTC" : ""}`;
}

/** Round-number ticks for an elevation range. */
export function niceTicks(lo: number, hi: number, target = 5) {
	const span = Math.max(1, hi - lo);
	const raw = span / target;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? raw;
	const out: number[] = [];
	for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-6; v += step)
		out.push(v);
	return out;
}
