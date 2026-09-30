// GeoJSON (RFC 7946) for a solved photo: camera point, view ray, horizontal FOV wedge, visible
// peak labels, and an optional ground footprint sampled through a pixel→geo function.
import { EARTH_R } from "../geodesy";
import { buildCameraModel, type CameraInput, type CameraModel } from "./camera";

type Pos = [number, number] | [number, number, number];
export type Feature = {
	type: "Feature";
	geometry: { type: string; coordinates: unknown };
	properties: Record<string, unknown>;
};
export type FeatureCollection = {
	type: "FeatureCollection";
	features: Feature[];
};

export type PeakInput = {
	name: string;
	ele: number | null;
	lat: number;
	lon: number;
	/** Normalised image coords (0..1, v down), e.g. engine.peakLabels()[i].u/v. */
	u: number;
	v: number;
	/** true/false = occlusion-tested; null = not tested (no fresh geometry buffer), kept and flagged. */
	visible: boolean | null;
	distKm?: number;
};

export type GeoJsonOptions = {
	/** Length of view ray and wedge in metres. Default 30 000. */
	maxRange?: number;
	/** Arc points along the wedge edge. Default 32. */
	arcSteps?: number;
	peaks?: PeakInput[];
	/** Include peaks with visible=false too (flagged). Default false. */
	includeHiddenPeaks?: boolean;
	/**
	 * Pixel→ground function over normalised coords (u right, v down), null for sky/no-hit.
	 * With the engine: (u, v) => engine.sampleAt(u, v).
	 */
	pixelToLatLon?: (
		u: number,
		v: number,
	) => { lat: number; lon: number; h?: number } | null;
	/** Footprint sampling: columns across the image and rows per column search. Default 48 × 96. */
	footprintCols?: number;
	footprintRows?: number;
};

const D = Math.PI / 180;
const round = (v: number, d: number) => Number(v.toFixed(d));

/**
 * GeoJSON position [lon, lat] (lon wrapped, 8 decimals) `dist` metres along initial bearing `brg` (deg).
 * Kept apart from geodesy's destination: it uses sin(p2) where that uses sinP2, which differs by an ULP
 * and could flip the 8th decimal of an export.
 */
export function pointAlong(
	lat: number,
	lon: number,
	brg: number,
	dist: number,
): [number, number] {
	const d = dist / EARTH_R;
	const p1 = lat * D;
	const l1 = lon * D;
	const b = brg * D;
	const p2 = Math.asin(
		Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b),
	);
	const l2 =
		l1 +
		Math.atan2(
			Math.sin(b) * Math.sin(d) * Math.cos(p1),
			Math.cos(d) - Math.sin(p1) * Math.sin(p2),
		);
	return [round(((l2 / D + 540) % 360) - 180, 8), round(p2 / D, 8)];
}

/** Shoelace signed area in lon/lat degrees (> 0 = counter-clockwise). */
export function ringSignedArea(ring: Pos[]) {
	let s = 0;
	for (let i = 0; i < ring.length - 1; i++)
		s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
	return s / 2;
}

/** Close the ring and orient it counter-clockwise (RFC 7946 exterior ring rule). */
function ccwRing(pts: Pos[]): Pos[] {
	const ring = [...pts];
	const a = ring[0];
	const z = ring[ring.length - 1];
	if (a[0] !== z[0] || a[1] !== z[1]) ring.push(a);
	if (ringSignedArea(ring) < 0) ring.reverse();
	return ring;
}

/** `lon` shifted by a multiple of 360 so it lies within ±180 of `ref` (may exceed ±180). */
export function unwrapLon(lon: number, ref: number) {
	return lon + 360 * Math.round((ref - lon) / 360);
}

/** Which antimeridian (+180 / −180) an unwrapped coordinate list crosses, or 0 if none. */
function crossedMeridian(pts: Pos[]): 180 | -180 | 0 {
	if (pts.some((p) => p[0] > 180)) return 180;
	if (pts.some((p) => p[0] < -180)) return -180;
	return 0;
}

const shiftLon = (pts: Pos[], d: number): Pos[] =>
	pts.map((p) => [round(p[0] + d, 8), p[1]] as Pos);

/** Point on segment a→b at longitude `x` (linear in lon/lat, as GeoJSON edges are). */
function cutAt(a: Pos, b: Pos, x: number): Pos {
	const t = (x - a[0]) / (b[0] - a[0]);
	return [x, round(a[1] + t * (b[1] - a[1]), 8)];
}

/** Sutherland–Hodgman clip of a closed ring to the half-plane lon ≤ x (keepLow) or lon ≥ x. */
function clipRing(ring: Pos[], x: number, keepLow: boolean): Pos[] {
	const inside = (p: Pos) => (keepLow ? p[0] <= x : p[0] >= x);
	const out: Pos[] = [];
	for (let i = 0; i < ring.length - 1; i++) {
		const a = ring[i];
		const b = ring[i + 1];
		if (inside(a)) out.push(a);
		if (inside(a) !== inside(b) && a[0] !== x && b[0] !== x)
			out.push(cutAt(a, b, x));
	}
	if (
		out.length &&
		(out[0][0] !== out[out.length - 1][0] ||
			out[0][1] !== out[out.length - 1][1])
	)
		out.push(out[0]);
	return out.length >= 4 ? out : [];
}

/**
 * RFC 7946 §3.1.9: a closed CCW ring (longitudes unwrapped around the camera) → Polygon, or a
 * MultiPolygon split at the antimeridian when it crosses ±180°.
 */
export function polygonGeometry(ring: Pos[]): {
	type: string;
	coordinates: unknown;
} {
	const e = crossedMeridian(ring);
	if (!e) return { type: "Polygon", coordinates: [ring] };
	const home = clipRing(ring, e, e > 0);
	const away = shiftLon(clipRing(ring, e, e < 0), e > 0 ? -360 : 360);
	const parts = [home, away].filter((r) => r.length >= 4);
	return parts.length === 1
		? { type: "Polygon", coordinates: parts }
		: { type: "MultiPolygon", coordinates: parts.map((r) => [r]) };
}

/** LineString (unwrapped longitudes) → LineString or MultiLineString split at the antimeridian. */
export function lineGeometry(pts: Pos[]): {
	type: string;
	coordinates: unknown;
} {
	const e = crossedMeridian(pts);
	if (!e) return { type: "LineString", coordinates: pts };
	const parts: Pos[][] = [[pts[0]]];
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1];
		const b = pts[i];
		const sa = e > 0 ? a[0] > e : a[0] < e;
		const sb = e > 0 ? b[0] > e : b[0] < e;
		if (sa !== sb) {
			const c = cutAt(a, b, e);
			parts[parts.length - 1].push(c);
			parts.push([c]);
		}
		parts[parts.length - 1].push(b);
	}
	const wrap = (line: Pos[]) =>
		line.some((p) => (e > 0 ? p[0] > e : p[0] < e))
			? shiftLon(line, e > 0 ? -360 : 360)
			: line;
	const lines = parts.filter((l) => l.length >= 2).map(wrap);
	return lines.length === 1
		? { type: "LineString", coordinates: lines[0] }
		: { type: "MultiLineString", coordinates: lines };
}

export function buildGeoJson(
	input: CameraInput | CameraModel,
	opts: GeoJsonOptions = {},
): FeatureCollection {
	const m = "K" in input ? input : buildCameraModel(input);
	const pose = m.input.pose;
	const range = opts.maxRange ?? 30000;
	const steps = opts.arcSteps ?? 32;
	// RFC 7946 §4: a third coordinate is height above the WGS84 ellipsoid. We only emit it when the
	// caller supplied a geoid undulation (so altEllipsoid is real); MSL heights stay in properties.
	const N = m.input.geoidUndulation;
	const hasEll = N != null && Number.isFinite(N);
	const lon0 = m.lon;
	const cam: Pos = hasEll
		? [round(m.lon, 8), round(m.lat, 8), round(m.altEllipsoid, 2)]
		: [round(m.lon, 8), round(m.lat, 8)];
	const dest = (b: number): Pos => {
		const [lo, la] = pointAlong(m.lat, m.lon, b, range);
		return [round(unwrapLon(lo, lon0), 8), la];
	};
	const features: Feature[] = [];
	const base = { photoId: m.input.photoId };

	features.push({
		type: "Feature",
		geometry: { type: "Point", coordinates: cam },
		properties: {
			...base,
			kind: "camera",
			yaw: round(pose.yaw, 4),
			pitch: round(pose.pitch, 4),
			roll: round(pose.roll, 4),
			vfov: round(m.vfov, 4),
			hfov: round(m.hfov, 4),
			altMsl: round(m.altMsl, 2),
			altEllipsoid: hasEll ? round(m.altEllipsoid, 2) : null,
			heightDatum: hasEll
				? "z = ellipsoidal (WGS84) height; altMsl = orthometric"
				: "no z: heights are orthometric (MSL, DEM datum) in altMsl / ele",
			takenAt: m.input.takenAt ?? null,
		},
	});
	features.push({
		type: "Feature",
		geometry: lineGeometry([[cam[0], cam[1]], dest(pose.yaw)]),
		properties: {
			...base,
			kind: "view-direction",
			bearing: round(pose.yaw, 4),
			rangeM: range,
		},
	});
	const wedge: Pos[] = [[cam[0], cam[1]]];
	for (let i = 0; i <= steps; i++) {
		const b = pose.yaw - m.hfov / 2 + (m.hfov * i) / steps;
		wedge.push(dest(b));
	}
	features.push({
		type: "Feature",
		geometry: polygonGeometry(ccwRing(wedge)),
		properties: {
			...base,
			kind: "fov-wedge",
			hfov: round(m.hfov, 4),
			rangeM: range,
			note: "horizontal FOV about the yaw bearing; ignores roll/pitch",
		},
	});

	for (const p of opts.peaks ?? []) {
		if (p.visible === false && !opts.includeHiddenPeaks) continue;
		features.push({
			type: "Feature",
			geometry: {
				type: "Point",
				coordinates:
					hasEll && p.ele != null
						? [
								round(p.lon, 8),
								round(p.lat, 8),
								round(p.ele + (N as number), 2),
							]
						: [round(p.lon, 8), round(p.lat, 8)],
			},
			properties: {
				...base,
				kind: "peak",
				name: p.name,
				ele: p.ele,
				visible: p.visible,
				u: round(p.u, 6),
				v: round(p.v, 6),
				px: round(p.u * m.width, 1),
				py: round(p.v * m.height, 1),
				distKm: p.distKm != null ? round(p.distKm, 3) : null,
			},
		});
	}

	if (opts.pixelToLatLon) {
		const fp = sampleFootprint(
			opts.pixelToLatLon,
			opts.footprintCols ?? 48,
			opts.footprintRows ?? 96,
			lon0,
		);
		if (fp)
			features.push({
				type: "Feature",
				geometry: polygonGeometry(ccwRing(fp.ring)),
				properties: {
					...base,
					kind: "footprint",
					samples: fp.samples,
					note: "near edge = lowest ground hit per column, far edge = topmost ground hit (skyline)",
				},
			});
	}
	return { type: "FeatureCollection", features };
}

/**
 * Visible-ground outline: per image column the lowest ground pixel (near edge) and the topmost
 * one (far edge, just under the skyline); polygon = near edge L→R, far edge R→L.
 */
export function sampleFootprint(
	fn: NonNullable<GeoJsonOptions["pixelToLatLon"]>,
	cols: number,
	rows: number,
	refLon?: number,
) {
	const near: Pos[] = [];
	const far: Pos[] = [];
	let samples = 0;
	for (let i = 0; i <= cols; i++) {
		const u = Math.min(0.999, Math.max(0.001, i / cols));
		let top: Pos | null = null;
		let bottom: Pos | null = null;
		for (let j = 0; j <= rows; j++) {
			const v = Math.min(0.999, Math.max(0.001, j / rows));
			const g = fn(u, v);
			samples++;
			if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
			const p: Pos = [
				round(refLon != null ? unwrapLon(g.lon, refLon) : g.lon, 7),
				round(g.lat, 7),
			];
			if (!top) top = p;
			bottom = p;
		}
		if (top && bottom) {
			near.push(bottom);
			far.push(top);
		}
	}
	if (near.length < 2) return null;
	return { ring: [...near, ...far.reverse()], samples };
}
