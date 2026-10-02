// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Deterministic hand-drawn strokes for the notebook. Only furniture wobbles (arrows, circles,
// underlines, boxes); data lines are drawn exactly. The same seed always gives the same path, so
// screenshots and style baselines stay stable. Jitter stays under about 1.5 px.

export type Point = [number, number];

/** Mulberry32: a tiny seeded PRNG returning [0, 1). */
export function createRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** String to seed (FNV-1a), so a stroke can be keyed by its id. */
export function hashSeed(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

const format = (value: number) => value.toFixed(1);

/** One hand-ruled segment: a gentle bow with slightly overshooting ends. */
export function sketchLine(
	from: Point,
	to: Point,
	seed: number,
	{ bow = 1, overshoot = 1.2 }: { bow?: number; overshoot?: number } = {},
): string {
	const random = createRandom(seed);
	const [x1, y1] = from;
	const [x2, y2] = to;
	const length = Math.hypot(x2 - x1, y2 - y1) || 1;
	const ux = (x2 - x1) / length;
	const uy = (y2 - y1) / length;
	const jitter = Math.min(1.5, length / 60) * bow;
	const startShift = (random() - 0.3) * overshoot;
	const endShift = (random() - 0.3) * overshoot;
	const sx = x1 - ux * startShift;
	const sy = y1 - uy * startShift;
	const ex = x2 + ux * endShift;
	const ey = y2 + uy * endShift;
	const t = 0.4 + random() * 0.2;
	const offset = (random() - 0.5) * 2 * jitter;
	const cx = sx + (ex - sx) * t - uy * offset;
	const cy = sy + (ey - sy) * t + ux * offset;
	return `M${format(sx)} ${format(sy)}Q${format(cx)} ${format(cy)} ${format(ex)} ${format(ey)}`;
}

/** A hand-drawn curve through points (Catmull-Rom to cubic), each knot nudged by under 1 px. */
export function sketchCurve(
	points: Point[],
	seed: number,
	wobble = 0.8,
): string {
	if (points.length < 2) return "";
	const random = createRandom(seed);
	const nudged = points.map(
		([x, y], i): Point =>
			i === 0 || i === points.length - 1
				? [x, y]
				: [x + (random() - 0.5) * wobble, y + (random() - 0.5) * wobble],
	);
	let path = `M${format(nudged[0][0])} ${format(nudged[0][1])}`;
	for (let i = 0; i < nudged.length - 1; i++) {
		const p0 = nudged[i - 1] ?? nudged[i];
		const p1 = nudged[i];
		const p2 = nudged[i + 1];
		const p3 = nudged[i + 2] ?? p2;
		const c1: Point = [
			p1[0] + (p2[0] - p0[0]) / 6,
			p1[1] + (p2[1] - p0[1]) / 6,
		];
		const c2: Point = [
			p2[0] - (p3[0] - p1[0]) / 6,
			p2[1] - (p3[1] - p1[1]) / 6,
		];
		path += `C${format(c1[0])} ${format(c1[1])} ${format(c2[0])} ${format(c2[1])} ${format(p2[0])} ${format(p2[1])}`;
	}
	return path;
}

/** A loop drawn around a point the way a pen circles a word: just over one turn, not closed. */
export function sketchCircle(
	center: Point,
	radiusX: number,
	radiusY: number,
	seed: number,
): string {
	const random = createRandom(seed);
	const start = random() * Math.PI * 2;
	const turn = Math.PI * 2 * (1.08 + random() * 0.1);
	const steps = 22;
	const points: Point[] = [];
	for (let i = 0; i <= steps; i++) {
		const angle = start + (turn * i) / steps;
		const grow = 1 + (i / steps) * 0.08 + (random() - 0.5) * 0.04;
		points.push([
			center[0] + Math.cos(angle) * radiusX * grow,
			center[1] + Math.sin(angle) * radiusY * grow,
		]);
	}
	return sketchCurve(points, seed + 1, 0.4);
}

/** A curved arrow from `from` to `to`; `bend` bows the shaft sideways (fraction of its length). */
export function sketchArrow(
	from: Point,
	to: Point,
	seed: number,
	{ bend = 0.18, head = 7 }: { bend?: number; head?: number } = {},
): { shaft: string; head: string } {
	const random = createRandom(seed);
	const [x1, y1] = from;
	const [x2, y2] = to;
	const length = Math.hypot(x2 - x1, y2 - y1) || 1;
	const nx = -(y2 - y1) / length;
	const ny = (x2 - x1) / length;
	const sway = bend * length * (0.85 + random() * 0.3);
	const control: Point = [(x1 + x2) / 2 + nx * sway, (y1 + y2) / 2 + ny * sway];
	const shaft = `M${format(x1)} ${format(y1)}Q${format(control[0])} ${format(control[1])} ${format(x2)} ${format(y2)}`;
	// The head follows the tangent at the tip (from the control point to the end).
	const tangent = Math.atan2(y2 - control[1], x2 - control[0]);
	const spread = 0.42 + random() * 0.12;
	const left: Point = [
		x2 - Math.cos(tangent - spread) * head,
		y2 - Math.sin(tangent - spread) * head,
	];
	const right: Point = [
		x2 - Math.cos(tangent + spread) * head * (0.9 + random() * 0.2),
		y2 - Math.sin(tangent + spread) * head * (0.9 + random() * 0.2),
	];
	return {
		shaft,
		head: `M${format(left[0])} ${format(left[1])}L${format(x2)} ${format(y2)}L${format(right[0])} ${format(right[1])}`,
	};
}

/** Diagonal hachures inside the area under a profile (points sorted by x), clipped by the caller. */
export function hachureLines(
	minX: number,
	maxX: number,
	top: number,
	bottom: number,
	gap: number,
	seed: number,
): string {
	const random = createRandom(seed);
	const height = bottom - top;
	let path = "";
	for (let x = minX - height; x < maxX; x += gap) {
		const drift = (random() - 0.5) * 1.2;
		path += `M${format(x + drift)} ${format(bottom)}L${format(x + height + drift)} ${format(top)}`;
	}
	return path;
}

// ---- Tapered pen outlines ---------------------------------------------------------------------
// Variable-width pen strokes after perfect-freehand (MIT, Steve Ruiz): a centre line is resampled,
// given a pressure profile (thin ends, fuller middle, thinner in tight turns) and offset left and
// right into one filled polygon. Written in-house; no dependency.

const clamp = (value: number, low: number, high: number) =>
	Math.min(high, Math.max(low, value));
const smoothstep = (value: number) => {
	const t = clamp(value, 0, 1);
	return t * t * (3 - 2 * t);
};
const fixed = (value: number) =>
	Number.isFinite(value) ? value.toFixed(2) : "0.00";

/**
 * Flatten the M/L/Q/C path strings made by sketchLine, sketchCurve, sketchCircle and sketchArrow
 * into one polyline per subpath (curves sampled about every 3 px).
 */
export function flattenStroke(d: string): Point[][] {
	const subpaths: Point[][] = [];
	let current: Point[] = [];
	let pen: Point = [0, 0];
	for (const match of d.matchAll(/([MLQC])([^MLQC]*)/g)) {
		const values = (match[2].match(/-?(?:\d+\.?\d*|\.\d+)/g) ?? []).map(Number);
		switch (match[1]) {
			case "M":
				pen = [values[0], values[1]];
				current = [pen];
				subpaths.push(current);
				break;
			case "L":
				for (let i = 0; i + 1 < values.length; i += 2) {
					pen = [values[i], values[i + 1]];
					current.push(pen);
				}
				break;
			case "Q":
				for (let i = 0; i + 3 < values.length; i += 4) {
					const [x0, y0] = pen;
					const [cx, cy, x1, y1] = values.slice(i, i + 4);
					const steps = clamp(
						Math.ceil(
							(Math.hypot(cx - x0, cy - y0) + Math.hypot(x1 - cx, y1 - cy)) / 3,
						),
						2,
						80,
					);
					for (let k = 1; k <= steps; k++) {
						const t = k / steps;
						const u = 1 - t;
						current.push([
							u * u * x0 + 2 * u * t * cx + t * t * x1,
							u * u * y0 + 2 * u * t * cy + t * t * y1,
						]);
					}
					pen = [x1, y1];
				}
				break;
			case "C":
				for (let i = 0; i + 5 < values.length; i += 6) {
					const [x0, y0] = pen;
					const [c1x, c1y, c2x, c2y, x1, y1] = values.slice(i, i + 6);
					const steps = clamp(
						Math.ceil(
							(Math.hypot(c1x - x0, c1y - y0) +
								Math.hypot(c2x - c1x, c2y - c1y) +
								Math.hypot(x1 - c2x, y1 - c2y)) /
								3,
						),
						2,
						80,
					);
					for (let k = 1; k <= steps; k++) {
						const t = k / steps;
						const u = 1 - t;
						current.push([
							u * u * u * x0 +
								3 * u * u * t * c1x +
								3 * u * t * t * c2x +
								t * t * t * x1,
							u * u * u * y0 +
								3 * u * u * t * c1y +
								3 * u * t * t * c2y +
								t * t * t * y1,
						]);
					}
					pen = [x1, y1];
				}
				break;
		}
	}
	return subpaths.filter((subpath) => subpath.length > 1);
}

/** Resample a polyline at an even `step`, keeping the first and last point. */
function resample(points: Point[], step: number, closed: boolean): Point[] {
	const source = closed ? [...points, points[0]] : points;
	const out: Point[] = [source[0]];
	let carry = 0;
	for (let i = 1; i < source.length; i++) {
		const [ax, ay] = source[i - 1];
		const [bx, by] = source[i];
		const length = Math.hypot(bx - ax, by - ay);
		if (length === 0) continue;
		let at = step - carry;
		while (at <= length) {
			out.push([
				ax + ((bx - ax) * at) / length,
				ay + ((by - ay) * at) / length,
			]);
			at += step;
		}
		carry = length - (at - step);
	}
	const end = source[source.length - 1];
	const tail = out[out.length - 1];
	if (closed) {
		if (
			out.length > 1 &&
			Math.hypot(tail[0] - end[0], tail[1] - end[1]) < step * 0.5
		)
			out.pop();
	} else if (tail[0] !== end[0] || tail[1] !== end[1]) {
		if (
			Math.hypot(tail[0] - end[0], tail[1] - end[1]) < step * 0.4 &&
			out.length > 1
		)
			out[out.length - 1] = end;
		else out.push(end);
	}
	return out;
}

/**
 * A closed polygon path for a pen stroke along `points`: width swells in the middle, thins at both
 * ends (not for a closed loop) and in tight turns, with a little seeded pressure noise.
 * `width` is the mean full width in px.
 */
export function taperedOutline(
	points: Point[],
	seed: number,
	{
		width = 1.3,
		taperStart = 0.06,
		taperEnd = 0.12,
		closed = false,
	}: {
		width?: number;
		taperStart?: number;
		taperEnd?: number;
		closed?: boolean;
	} = {},
): string {
	const clean = points.filter(
		([x, y]) => Number.isFinite(x) && Number.isFinite(y),
	);
	if (clean.length < 2) return "";
	const step = 1.5;
	const samples = resample(clean, step, closed);
	const count = samples.length;
	if (count < 2) return "";
	const random = createRandom(seed);
	// Arc length and normalised position t.
	const arc: number[] = [0];
	for (let i = 1; i < count; i++)
		arc.push(
			arc[i - 1] +
				Math.hypot(
					samples[i][0] - samples[i - 1][0],
					samples[i][1] - samples[i - 1][1],
				),
		);
	const total = arc[count - 1] || 1;
	const left: Point[] = [];
	const right: Point[] = [];
	let pressure = 0;
	for (let i = 0; i < count; i++) {
		const previous =
			samples[closed ? (i - 1 + count) % count : Math.max(0, i - 1)];
		const next = samples[closed ? (i + 1) % count : Math.min(count - 1, i + 1)];
		const tx = next[0] - previous[0];
		const ty = next[1] - previous[1];
		const tangentLength = Math.hypot(tx, ty) || 1;
		const t = arc[i] / total;
		let w = width * (0.55 + 0.45 * Math.sin(Math.PI * t) ** 0.6);
		if (!closed) {
			if (taperStart > 0) w *= smoothstep(t / taperStart);
			if (taperEnd > 0) w *= smoothstep((1 - t) / taperEnd);
		}
		// Curvature: turning angle per unit length, from the incoming and outgoing segments.
		const here = samples[i];
		const a1 = Math.atan2(here[1] - previous[1], here[0] - previous[0]);
		const a2 = Math.atan2(next[1] - here[1], next[0] - here[0]);
		let turn = a2 - a1;
		while (turn > Math.PI) turn -= Math.PI * 2;
		while (turn < -Math.PI) turn += Math.PI * 2;
		const kappa = Math.abs(turn) / step;
		w *= 1 - 0.25 * clamp(kappa * w * 4, 0, 1);
		// Pressure noise: smoothed random walk of about +-6 %.
		pressure = pressure * 0.7 + (random() * 2 - 1) * 0.3;
		w *= 1 + 0.06 * clamp(pressure * 1.6, -1, 1);
		const nx = -ty / tangentLength;
		const ny = tx / tangentLength;
		left.push([samples[i][0] + (nx * w) / 2, samples[i][1] + (ny * w) / 2]);
		right.push([samples[i][0] - (nx * w) / 2, samples[i][1] - (ny * w) / 2]);
	}
	const ring = [...left, ...right.reverse()];
	return `${ring.map(([x, y], i) => `${i ? "L" : "M"}${fixed(x)} ${fixed(y)}`).join("")}Z`;
}

/** A small ink pool where the pen lands: a 7-gon of radius 0.45 * width with seeded radius noise. */
export function inkBlob(point: Point, width: number, seed: number): string {
	const random = createRandom(seed);
	const sides = 7;
	const turn = random() * Math.PI * 2;
	const ring: Point[] = [];
	for (let i = 0; i < sides; i++) {
		const angle = turn + (i / sides) * Math.PI * 2;
		const radius = 0.45 * width * (0.85 + random() * 0.25);
		ring.push([
			point[0] + Math.cos(angle) * radius,
			point[1] + Math.sin(angle) * radius,
		]);
	}
	return `${ring.map(([x, y], i) => `${i ? "L" : "M"}${fixed(x)} ${fixed(y)}`).join("")}Z`;
}
