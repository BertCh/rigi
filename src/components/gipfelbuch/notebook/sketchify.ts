// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Turn exact vector geometry into pen-and-pencil strokes. Approach after rough.js (MIT, Preet Shihn):
// each line is drawn twice with independent low-frequency jitter, ends overshoot a little, and areas
// are filled with hachures instead of flat colour. Unlike rough.js the jitter is bounded by a
// tolerance (default 0.9 px), so a sketched data series still sits on its measured pixels.
// Everything is seeded: the same input and seed always give the same strokes.

import { createRandom, hashSeed, type Point } from "./sketch";

export interface SketchOptions {
	/** Max perpendicular offset from the true line, px (in the SVG's own units). */
	tolerance?: number;
	/** Pen passes: 2 reads as a hand-ruled line, 1 for dense series. */
	passes?: 1 | 2;
	/** Distance between jitter knots, px; longer = lazier wobble. */
	wavelength?: number;
	/** Overshoot at open ends, px. */
	overshoot?: number;
}

const format = (value: number) =>
	Number.isFinite(value) ? value.toFixed(1) : "0";

/** Seed from anything printable (ids, numbers). */
export const seedOf = (key: string | number) =>
	typeof key === "number" ? key >>> 0 : hashSeed(key);

/** Resample a polyline so knots are at most `step` apart (keeps every original vertex). */
function densify(points: Point[], step: number): Point[] {
	const out: Point[] = [];
	for (let i = 0; i < points.length; i++) {
		const current = points[i];
		out.push(current);
		const next = points[i + 1];
		if (!next) break;
		const length = Math.hypot(next[0] - current[0], next[1] - current[1]);
		const pieces = Math.floor(length / step);
		for (let k = 1; k < pieces; k++) {
			const t = k / pieces;
			out.push([
				current[0] + (next[0] - current[0]) * t,
				current[1] + (next[1] - current[1]) * t,
			]);
		}
	}
	return out;
}

/** Drop vertices closer than `minGap` (long data series stay cheap). */
function thin(points: Point[], minGap: number): Point[] {
	if (points.length < 3) return points;
	const out: Point[] = [points[0]];
	for (let i = 1; i < points.length - 1; i++) {
		const last = out[out.length - 1];
		if (Math.hypot(points[i][0] - last[0], points[i][1] - last[1]) >= minGap)
			out.push(points[i]);
	}
	out.push(points[points.length - 1]);
	return out;
}

/** Smooth 1-D noise: random knots every `wavelength` px of arc length, cosine-interpolated. */
function makeNoise(random: () => number, amplitude: number) {
	const knots: number[] = [];
	return (index: number, fraction: number) => {
		while (knots.length <= index + 1)
			knots.push((random() * 2 - 1) * amplitude);
		const a = knots[index];
		const b = knots[index + 1];
		const t = (1 - Math.cos(fraction * Math.PI)) / 2;
		return a + (b - a) * t;
	};
}

/**
 * One pen pass along a polyline: every point is pushed sideways by smooth noise bounded by `tolerance`.
 * `closed` joins the end back to the start with a slight overlap, the way a pen closes a loop.
 */
function pass(
	points: Point[],
	random: () => number,
	tolerance: number,
	wavelength: number,
	overshoot: number,
	closed: boolean,
): string {
	if (points.length < 2) return "";
	const ring = closed ? [...points, points[0], points[1] ?? points[0]] : points;
	const dense = densify(ring, wavelength / 3);
	const noise = makeNoise(random, tolerance);
	let travelled = 0;
	const shifted: Point[] = [];
	for (let i = 0; i < dense.length; i++) {
		const previous = dense[i - 1] ?? dense[i];
		const next = dense[i + 1] ?? dense[i];
		if (i > 0)
			travelled += Math.hypot(
				dense[i][0] - previous[0],
				dense[i][1] - previous[1],
			);
		const dx = next[0] - previous[0];
		const dy = next[1] - previous[1];
		const length = Math.hypot(dx, dy) || 1;
		const position = travelled / wavelength;
		const offset = noise(Math.floor(position), position % 1);
		shifted.push([
			dense[i][0] + (-dy / length) * offset,
			dense[i][1] + (dx / length) * offset,
		]);
	}
	if (!closed && overshoot > 0) {
		const extend = (from: Point, toward: Point, amount: number): Point => {
			const dx = from[0] - toward[0];
			const dy = from[1] - toward[1];
			const length = Math.hypot(dx, dy) || 1;
			return [
				from[0] + (dx / length) * amount,
				from[1] + (dy / length) * amount,
			];
		};
		shifted[0] = extend(shifted[0], shifted[1], (random() - 0.2) * overshoot);
		const last = shifted.length - 1;
		shifted[last] = extend(
			shifted[last],
			shifted[last - 1],
			(random() - 0.2) * overshoot,
		);
	}
	let d = `M${format(shifted[0][0])} ${format(shifted[0][1])}`;
	for (let i = 1; i < shifted.length; i++)
		d += `L${format(shifted[i][0])} ${format(shifted[i][1])}`;
	return d;
}

/** Sketched strokes for a polyline: one path string per pen pass. */
export function sketchPolyline(
	points: Point[],
	seed: string | number,
	options: SketchOptions & { closed?: boolean } = {},
): string[] {
	const {
		tolerance = 0.9,
		passes = 2,
		wavelength = 14,
		overshoot = 1.6,
		closed = false,
	} = options;
	const clean = thin(points, points.length > 600 ? 1.5 : 0.25);
	const random = createRandom(seedOf(seed));
	const result: string[] = [];
	for (let p = 0; p < passes; p++)
		result.push(
			pass(
				clean,
				random,
				tolerance * (p === 0 ? 1 : 0.8),
				wavelength * (p === 0 ? 1 : 1.3),
				overshoot,
				closed,
			),
		);
	return result;
}

/** A hand-ruled rectangle (corners overshoot, sides bow a little). */
export function sketchRect(
	x: number,
	y: number,
	width: number,
	height: number,
	seed: string | number,
	options: SketchOptions = {},
): string[] {
	const corners: Point[] = [
		[x, y],
		[x + width, y],
		[x + width, y + height],
		[x, y + height],
	];
	const random = createRandom(seedOf(seed));
	const passes = options.passes ?? 2;
	const result: string[] = [];
	for (let p = 0; p < passes; p++) {
		let d = "";
		for (let side = 0; side < 4; side++) {
			const segment = sketchPolyline(
				[corners[side], corners[(side + 1) % 4]],
				Math.floor(random() * 1e9),
				{ ...options, passes: 1, overshoot: options.overshoot ?? 2.4 },
			)[0];
			d += segment;
		}
		result.push(d);
	}
	return result;
}

// ---- SVG path parsing -------------------------------------------------------------------------

type Subpath = { points: Point[]; closed: boolean };

const COMMAND = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

function sampleCubic(p0: Point, p1: Point, p2: Point, p3: Point): Point[] {
	const length =
		Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) +
		Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) +
		Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
	const steps = Math.max(4, Math.min(64, Math.ceil(length / 4)));
	const out: Point[] = [];
	for (let i = 1; i <= steps; i++) {
		const t = i / steps;
		const u = 1 - t;
		out.push([
			u * u * u * p0[0] +
				3 * u * u * t * p1[0] +
				3 * u * t * t * p2[0] +
				t * t * t * p3[0],
			u * u * u * p0[1] +
				3 * u * u * t * p1[1] +
				3 * u * t * t * p2[1] +
				t * t * t * p3[1],
		]);
	}
	return out;
}

/** SVG elliptical arc (endpoint parameterisation, spec F.6.5) sampled as points after `from`. */
function sampleArc(
	from: Point,
	rx: number,
	ry: number,
	rotationDeg: number,
	largeArc: boolean,
	sweep: boolean,
	to: Point,
): Point[] {
	if (rx === 0 || ry === 0) return [to];
	const phi = (rotationDeg * Math.PI) / 180;
	const cos = Math.cos(phi);
	const sin = Math.sin(phi);
	const dx = (from[0] - to[0]) / 2;
	const dy = (from[1] - to[1]) / 2;
	const x1 = cos * dx + sin * dy;
	const y1 = -sin * dx + cos * dy;
	let rxa = Math.abs(rx);
	let rya = Math.abs(ry);
	const lambda = (x1 * x1) / (rxa * rxa) + (y1 * y1) / (rya * rya);
	if (lambda > 1) {
		rxa *= Math.sqrt(lambda);
		rya *= Math.sqrt(lambda);
	}
	const sign = largeArc === sweep ? -1 : 1;
	const numerator =
		rxa * rxa * rya * rya - rxa * rxa * y1 * y1 - rya * rya * x1 * x1;
	const denominator = rxa * rxa * y1 * y1 + rya * rya * x1 * x1;
	const coefficient =
		sign * Math.sqrt(Math.max(0, numerator / (denominator || 1)));
	const cx1 = (coefficient * rxa * y1) / rya;
	const cy1 = (-coefficient * rya * x1) / rxa;
	const cx = cos * cx1 - sin * cy1 + (from[0] + to[0]) / 2;
	const cy = sin * cx1 + cos * cy1 + (from[1] + to[1]) / 2;
	const angle = (ux: number, uy: number, vx: number, vy: number) =>
		Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
	const start = angle(1, 0, (x1 - cx1) / rxa, (y1 - cy1) / rya);
	let delta = angle(
		(x1 - cx1) / rxa,
		(y1 - cy1) / rya,
		(-x1 - cx1) / rxa,
		(-y1 - cy1) / rya,
	);
	if (!sweep && delta > 0) delta -= Math.PI * 2;
	if (sweep && delta < 0) delta += Math.PI * 2;
	const steps = Math.max(
		6,
		Math.ceil((Math.abs(delta) * Math.max(rxa, rya)) / 4),
	);
	const out: Point[] = [];
	for (let i = 1; i <= steps; i++) {
		const theta = start + (delta * i) / steps;
		const ex = rxa * Math.cos(theta);
		const ey = rya * Math.sin(theta);
		out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
	}
	return out;
}

/** Parse an SVG path `d` into polylines (curves and arcs sampled about every 4 px). */
export function parsePath(d: string): Subpath[] {
	const subpaths: Subpath[] = [];
	let current: Subpath | null = null;
	let pen: Point = [0, 0];
	let start: Point = [0, 0];
	let lastControl: Point | null = null;
	let lastCommand = "";
	const begin = (point: Point) => {
		current = { points: [point], closed: false };
		subpaths.push(current);
		start = point;
	};
	const add = (points: Point[]) => {
		if (!current) begin(pen);
		(current as Subpath).points.push(...points);
	};
	for (const match of d.matchAll(COMMAND)) {
		const command = match[1];
		const values = (match[2].match(NUMBER) ?? []).map(Number);
		const relative = command === command.toLowerCase();
		const upper = command.toUpperCase();
		const rel = (x: number, y: number): Point =>
			relative ? [pen[0] + x, pen[1] + y] : [x, y];
		switch (upper) {
			case "M": {
				for (let i = 0; i + 1 < values.length; i += 2) {
					const point = rel(values[i], values[i + 1]);
					if (i === 0) begin(point);
					else add([point]);
					pen = point;
				}
				lastControl = null;
				break;
			}
			case "L":
				for (let i = 0; i + 1 < values.length; i += 2) {
					pen = rel(values[i], values[i + 1]);
					add([pen]);
				}
				lastControl = null;
				break;
			case "H":
				for (const value of values) {
					pen = [relative ? pen[0] + value : value, pen[1]];
					add([pen]);
				}
				lastControl = null;
				break;
			case "V":
				for (const value of values) {
					pen = [pen[0], relative ? pen[1] + value : value];
					add([pen]);
				}
				lastControl = null;
				break;
			case "C":
				for (let i = 0; i + 5 < values.length; i += 6) {
					const c1 = rel(values[i], values[i + 1]);
					const c2 = rel(values[i + 2], values[i + 3]);
					const end = rel(values[i + 4], values[i + 5]);
					add(sampleCubic(pen, c1, c2, end));
					lastControl = c2;
					pen = end;
				}
				break;
			case "S":
				for (let i = 0; i + 3 < values.length; i += 4) {
					const c1: Point =
						lastControl && /[CcSs]/.test(lastCommand)
							? [2 * pen[0] - lastControl[0], 2 * pen[1] - lastControl[1]]
							: pen;
					const c2 = rel(values[i], values[i + 1]);
					const end = rel(values[i + 2], values[i + 3]);
					add(sampleCubic(pen, c1, c2, end));
					lastControl = c2;
					pen = end;
				}
				break;
			case "Q":
				for (let i = 0; i + 3 < values.length; i += 4) {
					const q = rel(values[i], values[i + 1]);
					const end = rel(values[i + 2], values[i + 3]);
					const c1: Point = [
						pen[0] + (2 / 3) * (q[0] - pen[0]),
						pen[1] + (2 / 3) * (q[1] - pen[1]),
					];
					const c2: Point = [
						end[0] + (2 / 3) * (q[0] - end[0]),
						end[1] + (2 / 3) * (q[1] - end[1]),
					];
					add(sampleCubic(pen, c1, c2, end));
					lastControl = q;
					pen = end;
				}
				break;
			case "T":
				for (let i = 0; i + 1 < values.length; i += 2) {
					const q: Point =
						lastControl && /[QqTt]/.test(lastCommand)
							? [2 * pen[0] - lastControl[0], 2 * pen[1] - lastControl[1]]
							: pen;
					const end = rel(values[i], values[i + 1]);
					const c1: Point = [
						pen[0] + (2 / 3) * (q[0] - pen[0]),
						pen[1] + (2 / 3) * (q[1] - pen[1]),
					];
					const c2: Point = [
						end[0] + (2 / 3) * (q[0] - end[0]),
						end[1] + (2 / 3) * (q[1] - end[1]),
					];
					add(sampleCubic(pen, c1, c2, end));
					lastControl = q;
					pen = end;
				}
				break;
			case "A":
				for (let i = 0; i + 6 < values.length; i += 7) {
					const end = rel(values[i + 5], values[i + 6]);
					add(
						sampleArc(
							pen,
							values[i],
							values[i + 1],
							values[i + 2],
							values[i + 3] !== 0,
							values[i + 4] !== 0,
							end,
						),
					);
					pen = end;
				}
				lastControl = null;
				break;
			case "Z":
				if (current) (current as Subpath).closed = true;
				pen = start;
				current = null;
				lastControl = null;
				break;
		}
		lastCommand = command;
	}
	return subpaths.filter((subpath) => subpath.points.length > 1);
}

/** Sketch any SVG path: parse, then draw each subpath with `sketchPolyline`. One `d` per pen pass. */
export function sketchify(
	d: string,
	seed: string | number,
	options: SketchOptions = {},
): string[] {
	const subpaths = parsePath(d);
	const passes = options.passes ?? 2;
	const result = Array.from({ length: passes }, () => "");
	const random = createRandom(seedOf(seed));
	for (const subpath of subpaths) {
		const strokes = sketchPolyline(subpath.points, Math.floor(random() * 1e9), {
			...options,
			closed: subpath.closed,
		});
		strokes.forEach((stroke, index) => {
			result[index] += stroke;
		});
	}
	return result;
}

// ---- Fills ------------------------------------------------------------------------------------

/** Polygons (rings) from a path `d`, for fills. */
export const pathRings = (d: string): Point[][] =>
	parsePath(d).map((subpath) => subpath.points);

/**
 * Hachure lines inside polygons (even-odd), at `angle` degrees with `gap` px spacing. Each line is
 * clipped exactly to the shape, then drawn with a light wobble, like rough.js's hachure fill.
 */
export function hachureFill(
	rings: Point[][],
	seed: string | number,
	{
		angle = -41,
		gap = 6,
		tolerance = 0.6,
		inset = 0.8,
		indication,
	}: {
		angle?: number;
		gap?: number;
		tolerance?: number;
		inset?: number;
		/** Keep only the parts of each line within this many px of the ring boundary (after Winkenbach and Salesin). */
		indication?: number;
	} = {},
): string {
	if (!rings.length) return "";
	const random = createRandom(seedOf(seed));
	const radians = (angle * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	// Rotate the shape so hachures become horizontal scanlines, intersect, rotate back.
	const rotate = ([x, y]: Point): Point => [
		x * cos + y * sin,
		-x * sin + y * cos,
	];
	const unrotate = ([x, y]: Point): Point => [
		x * cos - y * sin,
		x * sin + y * cos,
	];
	const rotated = rings.map((ring) => ring.map(rotate));
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const ring of rotated)
		for (const [, y] of ring) {
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
	let d = "";
	for (let y = minY + gap / 2; y < maxY; y += gap) {
		const crossings: number[] = [];
		for (const ring of rotated)
			for (let i = 0; i < ring.length; i++) {
				const a = ring[i];
				const b = ring[(i + 1) % ring.length];
				if (a[1] === b[1]) continue;
				if ((y >= a[1] && y < b[1]) || (y >= b[1] && y < a[1]))
					crossings.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
			}
		crossings.sort((p, q) => p - q);
		for (let i = 0; i + 1 < crossings.length; i += 2) {
			const x0 = crossings[i] + inset;
			const x1 = crossings[i + 1] - inset;
			if (x1 - x0 < 1.5) continue;
			const pieces: [number, number][] =
				indication !== undefined && x1 - x0 > indication * 2
					? [
							[x0, x0 + indication],
							[x1 - indication, x1],
						]
					: [[x0, x1]];
			for (const [from, to] of pieces) {
				if (indication !== undefined && to - from < 1.5) continue;
				const wobble = (random() - 0.5) * tolerance;
				const [stroke] = sketchPolyline(
					[unrotate([from, y + wobble]), unrotate([to, y - wobble])],
					Math.floor(random() * 1e9),
					{ passes: 1, tolerance, overshoot: 0 },
				);
				d += stroke;
			}
		}
	}
	return d;
}

/** Stipple (scree dots) inside polygons: jittered grid, `spacing` px apart. Draw with round caps. */
export function stippleFill(
	rings: Point[][],
	seed: string | number,
	{ spacing = 7 }: { spacing?: number } = {},
): string {
	const random = createRandom(seedOf(seed));
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const ring of rings)
		for (const [x, y] of ring) {
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
	const inside = (x: number, y: number) => {
		let hit = false;
		for (const ring of rings)
			for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
				const [xi, yi] = ring[i];
				const [xj, yj] = ring[j];
				if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
					hit = !hit;
			}
		return hit;
	};
	let d = "";
	for (let y = minY + spacing / 2; y < maxY; y += spacing)
		for (let x = minX + spacing / 2; x < maxX; x += spacing) {
			const px = x + (random() - 0.5) * spacing * 0.8;
			const py = y + (random() - 0.5) * spacing * 0.8;
			if (inside(px, py)) d += `M${format(px)} ${format(py)}h0.01`;
		}
	return d;
}

/**
 * Scree stones inside polygons: the same jittered lattice as `stippleFill`, but each stone is a small
 * convex 4- to 8-gon (seeded rotation, radius 0.6 to 1.1 px times `scale`), growing linearly from 1x at
 * the top of the bounding box to `grow`x at the bottom, so scree is coarser toward the foot of a slope.
 */
export function screeFill(
	rings: Point[][],
	seed: string | number,
	{
		spacing = 6,
		grow = 1.3,
		scale = 1,
	}: { spacing?: number; grow?: number; scale?: number } = {},
): { d: string } {
	const random = createRandom(seedOf(seed));
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const ring of rings)
		for (const [x, y] of ring) {
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
	if (!Number.isFinite(minX)) return { d: "" };
	const inside = (x: number, y: number) => {
		let hit = false;
		for (const ring of rings)
			for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
				const [xi, yi] = ring[i];
				const [xj, yj] = ring[j];
				if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
					hit = !hit;
			}
		return hit;
	};
	const height = maxY - minY || 1;
	let d = "";
	for (let y = minY + spacing / 2; y < maxY; y += spacing)
		for (let x = minX + spacing / 2; x < maxX; x += spacing) {
			const px = x + (random() - 0.5) * spacing * 0.8;
			const py = y + (random() - 0.5) * spacing * 0.8;
			// Always draw the same random numbers per lattice cell so stones stay put when the ring changes.
			const sides = 4 + Math.floor(random() * 5);
			const rotation = random() * Math.PI * 2;
			const base = 0.6 + 0.5 * random();
			if (!inside(px, py)) continue;
			const radius =
				base * scale * (1 + (grow - 1) * clamp01((py - minY) / height));
			for (let k = 0; k < sides; k++) {
				const angle = rotation + (k / sides) * Math.PI * 2;
				d += `${k ? "L" : "M"}${(px + Math.cos(angle) * radius).toFixed(2)} ${(py + Math.sin(angle) * radius).toFixed(2)}`;
			}
			d += "Z";
		}
	return { d };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

// ---- Canvas -----------------------------------------------------------------------------------

/** Sketched polyline on a 2D canvas (same algorithm as SVG). Caller sets strokeStyle/lineWidth. */
export function strokeSketchCanvas(
	context: CanvasRenderingContext2D,
	points: Point[],
	seed: string | number,
	options: SketchOptions & { closed?: boolean } = {},
) {
	const strokes = sketchPolyline(points, seed, options);
	const alpha = context.globalAlpha;
	strokes.forEach((d, index) => {
		context.globalAlpha = alpha * (index === 0 ? 1 : 0.6);
		context.stroke(new Path2D(d));
	});
	context.globalAlpha = alpha;
}

/** Hachure fill on a 2D canvas. Caller sets strokeStyle/lineWidth. */
export function hachureCanvas(
	context: CanvasRenderingContext2D,
	rings: Point[][],
	seed: string | number,
	options: Parameters<typeof hachureFill>[2] = {},
) {
	context.stroke(new Path2D(hachureFill(rings, seed, options)));
}
