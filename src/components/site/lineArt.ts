// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Line art for the live landing views (04 · 3D, 05 · Step inside): baked strokes (scripts/demo/
// bake-live-lines.ts) turned into 3D polylines in a local ENU frame (x east, y north, z up, metres),
// then projected every frame through the live camera onto a 2D canvas around the frame (LiveLines.tsx).
// Two bakes share one container: u32 header length, a JSON header, then typed arrays each starting
// on a 4-byte boundary (names, types and lengths in the header). Pure: no DOM or Node APIs.
//   "ridges": a viewpoint's ridgelines (src/lib/roll/mosaic/ridgelines.ts) as az/el at 0.01° per point
//     and a distance slab per stroke; a point sits at eye + slab distance × its direction.
//   "contours": DEM contours as x/y at 1 m per point and a level per stroke; z drops with the earth's
//     curvature (refraction as in EnuFrame) so far contours sit where the engine's terrain does.

import { poseBasis } from "#/lib/camera";
import { DEG as D2R, EARTH_R, REFRACTION_K } from "#/lib/geodesy";

const TYPES = {
	u8: Uint8Array,
	u16: Uint16Array,
	i16: Int16Array,
	u32: Uint32Array,
};
type TypeName = keyof typeof TYPES;
type Typed = InstanceType<(typeof TYPES)[TypeName]>;

const pad4 = (n: number) => (n + 3) & ~3;

export function encodeBlob(
	header: Record<string, unknown>,
	arrays: Record<string, Typed>,
): Uint8Array {
	const layout = Object.entries(arrays).map(([name, a]) => ({
		name,
		type: (Object.keys(TYPES) as TypeName[]).find(
			(t) => a instanceof TYPES[t],
		) as TypeName,
		length: a.length,
	}));
	const head = new TextEncoder().encode(JSON.stringify({ ...header, layout }));
	let size = pad4(4 + head.length);
	for (const a of Object.values(arrays)) size = pad4(size + a.byteLength);
	const out = new Uint8Array(size);
	new DataView(out.buffer).setUint32(0, head.length, true);
	out.set(head, 4);
	let at = pad4(4 + head.length);
	for (const a of Object.values(arrays)) {
		out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), at);
		at = pad4(at + a.byteLength);
	}
	return out;
}

function decodeBlob(buf: ArrayBuffer) {
	const n = new DataView(buf).getUint32(0, true);
	const header = JSON.parse(
		new TextDecoder().decode(new Uint8Array(buf, 4, n)),
	);
	const arrays: Record<string, Typed> = {};
	let at = pad4(4 + n);
	for (const { name, type, length } of header.layout as {
		name: string;
		type: TypeName;
		length: number;
	}[]) {
		const T = TYPES[type];
		arrays[name] = new T(buf.slice(at, at + length * T.BYTES_PER_ELEMENT));
		at = pad4(at + length * T.BYTES_PER_ELEMENT);
	}
	return { header, arrays };
}

/** One stroke style: alpha (0..1) and width (CSS px). */
export type LineStyle = { alpha: number; width: number };

export type Lines = {
	/** Where the frame's origin is (contours: the engine's frame is shifted onto it). */
	origin: { lat: number; lon: number };
	/** Points (x, y, z) back to back; stroke i spans start[i] .. start[i + 1]. */
	pts: Float32Array;
	start: Uint32Array;
	/** Per stroke: an index into `styles`. */
	style: Uint8Array;
	styles: LineStyle[];
	/** Fade strokes out with distance from the camera between these (m); none if absent. */
	fade?: [number, number];
	labels: { name: string; ele: number; p: [number, number, number] }[];
	/** The camera the bake was made for (ridges: the photo's), for drawing before the engine is up. */
	rest?: View;
};

/** A camera in the lines' frame: eye, unit axes (forward = look direction), vertical FOV (deg). */
export type View = {
	pos: [number, number, number];
	right: [number, number, number];
	up: [number, number, number];
	fwd: [number, number, number];
	fov: number;
};

const BUCKETS = 8;

/** Ridge strokes (the panorama strip's styling, terrainLayer.ts drawTerrain): slope then ridge, 8 depth buckets each. */
const RIDGE_STYLES: LineStyle[] = [0, 1].flatMap((ridge) =>
	Array.from({ length: BUCKETS }, (_, b) => {
		const t = b / (BUCKETS - 1);
		return ridge
			? { alpha: 0.85 - 0.5 * t, width: 1.3 - 0.6 * t }
			: { alpha: 0.32 - 0.16 * t, width: 0.7 };
	}),
);
/** Contours: plain, then index. */
const CONTOUR_STYLES: LineStyle[] = [
	{ alpha: 0.3, width: 0.6 },
	{ alpha: 0.6, width: 1 },
];

export function decodeLines(buf: ArrayBuffer): Lines {
	const { header: h, arrays: a } = decodeBlob(buf);
	if (h.kind === "ridges") {
		const { az, el, start, slab, ridge } = a;
		const eyeH = h.eye.h as number;
		const pts = new Float32Array(az.length * 3);
		const style = new Uint8Array(slab.length);
		const dist = (s: number) =>
			h.dMin * (h.dMax / h.dMin) ** ((s + 0.5) / h.slabs);
		for (let i = 0; i < slab.length; i++) {
			const d = dist(slab[i]);
			const b = Math.min(
				BUCKETS - 1,
				Math.floor((slab[i] / Math.max(1, h.slabs - 1)) * BUCKETS),
			);
			style[i] = ridge[i] * BUCKETS + b;
			for (let k = start[i]; k < start[i + 1]; k++) {
				const [x, y, z] = dirOf(az[k] / 100, el[k] / 100);
				pts[k * 3] = x * d;
				pts[k * 3 + 1] = y * d;
				pts[k * 3 + 2] = eyeH + z * d;
			}
		}
		const labels = (
			h.peaks as {
				name: string;
				ele: number;
				az: number;
				el: number;
				d: number;
			}[]
		).map((p) => {
			const [x, y, z] = dirOf(p.az, p.el);
			return {
				name: p.name,
				ele: p.ele,
				p: [x * p.d, y * p.d, eyeH + z * p.d] as [number, number, number],
			};
		});
		return {
			origin: { lat: h.eye.lat, lon: h.eye.lon },
			pts,
			start: start as Uint32Array,
			style,
			styles: RIDGE_STYLES,
			labels,
			rest: viewOfPose(h.pose, [0, 0, h.restEyeZ ?? eyeH]),
		};
	}
	// contours
	const { xy, start, level, index } = a;
	const n = xy.length / 2;
	const pts = new Float32Array(n * 3);
	const drop = (1 - REFRACTION_K) / (2 * EARTH_R);
	for (let i = 0; i < level.length; i++)
		for (let k = start[i]; k < start[i + 1]; k++) {
			const x = xy[k * 2];
			const y = xy[k * 2 + 1];
			pts[k * 3] = x;
			pts[k * 3 + 1] = y;
			pts[k * 3 + 2] = level[i] - (x * x + y * y) * drop;
		}
	return {
		origin: h.origin,
		pts,
		start: start as Uint32Array,
		style: index as Uint8Array,
		styles: CONTOUR_STYLES,
		fade: h.fade,
		labels: [],
	};
}

export function dirOf(az: number, el: number): [number, number, number] {
	const ce = Math.cos(el * D2R);
	return [Math.sin(az * D2R) * ce, Math.cos(az * D2R) * ce, Math.sin(el * D2R)];
}

/** The camera of a photo pose (src/lib/camera poseBasis: yaw from north, pitch up, roll right side down). */
export function viewOfPose(
	p: { yaw: number; pitch: number; roll: number; vfov: number },
	pos: [number, number, number],
): View {
	const { forward, right, up } = poseBasis({ ...p });
	return {
		pos,
		fwd: forward,
		right,
		up,
		fov: p.vfov,
	};
}

/** The camera of a three.js-style camera (looks down −z, y up) from its position and quaternion. */
export function viewOfCamera(
	pos: { x: number; y: number; z: number },
	q: { x: number; y: number; z: number; w: number },
	fov: number,
	shift: ArrayLike<number> = [0, 0, 0],
): View {
	const rot = (
		vx: number,
		vy: number,
		vz: number,
	): [number, number, number] => {
		// v' = q v q*
		const ix = q.w * vx + q.y * vz - q.z * vy;
		const iy = q.w * vy + q.z * vx - q.x * vz;
		const iz = q.w * vz + q.x * vy - q.y * vx;
		const iw = -q.x * vx - q.y * vy - q.z * vz;
		return [
			ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
			iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
			iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
		];
	};
	return {
		pos: [pos.x - shift[0], pos.y - shift[1], pos.z - shift[2]],
		right: rot(1, 0, 0),
		up: rot(0, 1, 0),
		fwd: rot(0, 0, -1),
		fov,
	};
}

/** Each stroke's middle point (x, y, z) back to back: what the draw buckets by distance. */
export function midpointsOf(L: Pick<Lines, "pts" | "start" | "style">) {
	const n = L.style.length;
	const out = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		const m = ((L.start[i] + L.start[i + 1]) >> 1) * 3;
		out[i * 3] = L.pts[m];
		out[i * 3 + 1] = L.pts[m + 1];
		out[i * 3 + 2] = L.pts[m + 2];
	}
	return out;
}

/** A text width measured once per name (the font never changes). */
export function cachedWidth(
	cache: Map<string, number>,
	name: string,
	measure: (name: string) => number,
) {
	let w = cache.get(name);
	if (w === undefined) {
		w = measure(name);
		cache.set(name, w);
	}
	return w;
}
