// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Cartographic sketch kit: the Landeskarte and Kroki conventions as pen-and-pencil SVG primitives
// for notebook figures (reports/archive/gipfelbuch-swiss-cartography.md §5, S1–S32).
// Sizes are px in an 800 px wide viewBox. Everything is seeded by a string, so a render is stable
// between server and client and between screenshots. Inks are the --nb-* tokens (InkColor names)
// or any CSS colour. Data geometry is never moved: only furniture wobbles.
//
// Usage (all SVG, inside a figure <svg>):
//
// | Export              | Use                                                                    |
// | ------------------- | ---------------------------------------------------------------------- |
// | PenPath             | any path `d` or `points` as one tapered pen stroke (furniture)         |
// | HeightFigure        | an italic hand height figure ("2127.6"), ink by class                  |
// | TrigTriangle   S4   | trig point: open triangle in 3 strokes, centre dot, height up right    |
// | SpotX          S5   | spot height: × or dot, italic height                                   |
// | SummitCross    S6   | summit cross, optional Gipfelbuch tin at its foot                      |
// | RockHachure    S7   | fall-line rock strokes below a ridge, dense on the shaded side         |
// | ScreeStipple   S8   | scree pebbles growing downslope, a few boulders                        |
// | KrokiHatch     S11  | Kroki area hatch: forest diagonal, building vertical, water horizontal |
// | HandScaleBar   S12  | hand-ruled scale bar with a true length                                |
// | NorthArrow     S13  | Kroki north arrow, optional declination fan                            |
// | KrokiTitle     S15  | title underlined once + "ca. 1:25 000 · R. C. · 01.10.2026 · 14:20"    |
// | TrailLine      S17  | red route: solid / dashed / dotted by certainty                        |
// | Blaze          S18  | painted waymark (yellow rhombus, white-red-white, white-blue-white)    |
// | GradeBox       S19  | "T4", "WS+" in a rough hand box                                        |
// | HandName       S20  | LK class lettering (peak, place, hamlet, water, glacier, region, pass) |
// | PeakLeader     S21  | hairline leader + name + italic height (+ "14.2 km · 205°")            |
// | layoutPeakLeaders   | stagger leader rows so no leader runs through another label            |
// | StationRays    S23  | plane-table station: pencil rays, bearings, the solved ray red         |
// | ContourScribble S3  | nested open pen loops around a point, or open versions of given rings  |
// | ProfileSketch  S26  | profile: ground line, pencil fall-line hatch, "2× überhöht"            |
// | CircledKey          | a circled number inside a figure, keyed to the prose                   |

import { type CSSProperties, type ReactNode, useMemo } from "react";
import {
	HandDot,
	HandText,
	type InkColor,
	inkColor,
	PenLine,
	SketchPath,
	SketchPolyline,
} from "./Ink";
import {
	createRandom,
	flattenStroke,
	hashSeed,
	inkBlob,
	type Point,
	sketchCircle,
	taperedOutline,
} from "./sketch";
import { hachureFill, pathRings, screeFill, sketchRect } from "./sketchify";

// ---- Shared -------------------------------------------------------------------------------------

/** A named notebook ink or any CSS colour. */
export type CartoInk = InkColor | (string & {});
const INK_NAMES = new Set<string>([
	"ink",
	"pencil",
	"red",
	"blue",
	"brown",
	"faint",
	"forest",
	"navy",
]);
const paint = (color: CartoInk) =>
	INK_NAMES.has(color) ? inkColor(color as InkColor) : color;

const f = (value: number) => (Number.isFinite(value) ? value.toFixed(2) : "0");
const polyD = (points: Point[], closed = false) =>
	points.length < 2
		? ""
		: `${points.map(([x, y], i) => `${i ? "L" : "M"}${f(x)} ${f(y)}`).join("")}${closed ? "Z" : ""}`;
const clamp = (value: number, low: number, high: number) =>
	Math.min(high, Math.max(low, value));

/** Width tiers (px at 800): hairline, fine, medium, bold (route only). */
export const PEN_TIER = {
	hairline: 0.6,
	fine: 0.9,
	medium: 1.3,
	bold: 2,
} as const;

/** Resample a polyline by arc length every `step` px (first and last point kept). */
function resampleBy(points: Point[], step: number): Point[] {
	if (points.length < 2) return points.slice();
	const out: Point[] = [points[0]];
	let carry = 0;
	for (let i = 1; i < points.length; i++) {
		const [ax, ay] = points[i - 1];
		const [bx, by] = points[i];
		const length = Math.hypot(bx - ax, by - ay);
		if (!length) continue;
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
	const end = points[points.length - 1];
	const tail = out[out.length - 1];
	if (Math.hypot(tail[0] - end[0], tail[1] - end[1]) > step * 0.3)
		out.push(end);
	return out;
}

const haloProps = (halo: boolean, width = 3.5) =>
	halo
		? {
				stroke: "var(--nb-paper)",
				strokeWidth: width,
				strokeLinejoin: "round" as const,
				paintOrder: "stroke" as const,
			}
		: {};

/**
 * One tapered pen stroke (thin ends, an ink blob where the pen lands) along a path `d` (M/L/Q/C,
 * absolute) or a point list. For furniture; a measured line is SketchPolyline `data`.
 */
export function PenPath({
	d,
	points,
	seed,
	color = "ink",
	width = PEN_TIER.medium,
	opacity,
	closed = false,
	blob = true,
	className,
	style,
}: {
	d?: string;
	points?: Point[];
	seed: string;
	color?: CartoInk;
	width?: number;
	opacity?: number;
	closed?: boolean;
	/** Ink pool at the start of each subpath (off for hatch-like strokes). */
	blob?: boolean;
	className?: string;
	style?: CSSProperties;
}) {
	const ink = useMemo(() => {
		const base = hashSeed(seed);
		const lines = points ? [points] : d ? flattenStroke(d) : [];
		let outline = "";
		let blobs = "";
		lines.forEach((line, index) => {
			if (line.length < 2) return;
			outline += taperedFromPoints(line, base + index, width, closed);
			if (blob && !closed) blobs += inkBlob(line[0], width, base + index + 101);
		});
		return { outline, blobs };
	}, [d, points, seed, width, closed, blob]);
	if (!ink.outline) return null;
	return (
		<g
			className={className ?? "nb-fade"}
			style={{ fill: paint(color), ...style }}
			fillOpacity={opacity}
		>
			<path d={ink.outline} />
			{ink.blobs ? <path d={ink.blobs} fillOpacity={0.9} /> : null}
		</g>
	);
}

const taperedFromPoints = (
	points: Point[],
	seed: number,
	width: number,
	closed: boolean,
) => taperedOutline(points, seed, { width, closed });

/**
 * An italic hand height figure, the LK way (heights are sloped on the sheet): tabular, hand
 * figures, ink by class (ink for terrain, brown for contours, blue for water). `decimals` fixes the
 * digits (1 for a trig point).
 */
export function HeightFigure({
	x,
	y,
	value,
	decimals,
	color = "ink",
	size = 11,
	anchor = "start",
	bold = false,
	halo = true,
	unit,
}: {
	x: number;
	y: number;
	value: number | string;
	decimals?: number;
	color?: CartoInk;
	size?: number;
	anchor?: "start" | "middle" | "end";
	bold?: boolean;
	halo?: boolean;
	/** Appended after a thin space, e.g. "m". */
	unit?: string;
}) {
	const text =
		typeof value === "number"
			? decimals === undefined
				? String(Math.round(value))
				: value.toFixed(decimals)
			: value;
	return (
		<text
			x={x}
			y={y}
			className="nb-num nb-height"
			fontSize={size}
			fontWeight={bold ? 650 : 500}
			textAnchor={anchor}
			style={{ fill: paint(color) }}
			{...haloProps(halo, 3)}
		>
			{unit ? `${text} ${unit}` : text}
		</text>
	);
}

// ---- Point symbols (S4, S5, S6) -----------------------------------------------------------------

/**
 * S4 trig point: a 7 px open triangle drawn in three pen strokes (the apex overshoots), a centre
 * dot, and the height to one decimal up and right in bold italic. (x, y) is the triangle's centre.
 */
export function TrigTriangle({
	x,
	y,
	h,
	label,
	size = 7,
	seed,
	color = "ink",
}: {
	x: number;
	y: number;
	/** Height in m, written to one decimal. */
	h?: number;
	/** Overrides the height text. */
	label?: string;
	size?: number;
	seed: string;
	color?: CartoInk;
}) {
	const height = (size * Math.sqrt(3)) / 2;
	const apex: Point = [x, y - (height * 2) / 3];
	const left: Point = [x - size / 2, y + height / 3];
	const right: Point = [x + size / 2, y + height / 3];
	const over = 0.8;
	return (
		<g>
			<PenLine
				from={left}
				to={[apex[0] - 0.2, apex[1] - over]}
				seed={`${seed}-a`}
				color={color}
				width={1}
			/>
			<PenLine
				from={[apex[0] + 0.2, apex[1] - over]}
				to={right}
				seed={`${seed}-b`}
				color={color}
				width={1}
			/>
			<PenLine
				from={[right[0] + 0.6, right[1]]}
				to={[left[0] - 0.6, left[1]]}
				seed={`${seed}-c`}
				color={color}
				width={1}
			/>
			<HandDot x={x} y={y} r={0.6} seed={`${seed}-dot`} color={color} data />
			{h !== undefined || label ? (
				<HeightFigure
					x={x + size * 0.75}
					y={apex[1] + 1}
					value={label ?? (h as number)}
					decimals={label ? undefined : 1}
					color={color}
					bold
				/>
			) : null}
		</g>
	);
}

/**
 * S5 spot height: a × of two 3 px strokes (or a 1.6 px dot) and an integer height in italic hand
 * figures. Use blue for a lake level.
 */
export function SpotX({
	x,
	y,
	h,
	mark = "x",
	seed,
	color = "ink",
	labelSide = "right",
}: {
	x: number;
	y: number;
	h?: number | string;
	mark?: "x" | "dot";
	seed: string;
	color?: CartoInk;
	labelSide?: "right" | "left";
}) {
	return (
		<g>
			{mark === "x" ? (
				<>
					<PenLine
						from={[x - 1.6, y - 1.6]}
						to={[x + 1.6, y + 1.6]}
						seed={`${seed}-x1`}
						color={color}
						width={1}
					/>
					<PenLine
						from={[x + 1.6, y - 1.6]}
						to={[x - 1.6, y + 1.6]}
						seed={`${seed}-x2`}
						color={color}
						width={1}
					/>
				</>
			) : (
				<HandDot x={x} y={y} r={0.8} seed={`${seed}-dot`} color={color} data />
			)}
			{h !== undefined ? (
				<HeightFigure
					x={labelSide === "right" ? x + 4 : x - 4}
					y={y - 3}
					value={h}
					anchor={labelSide === "right" ? "start" : "end"}
					color={color}
				/>
			) : null}
		</g>
	);
}

/**
 * S6 summit cross: two strokes, 6 × 8 px, standing on (x, y). `register` adds the Gipfelbuch tin,
 * a 3 × 2 px box at its foot.
 */
export function SummitCross({
	x,
	y,
	register = false,
	seed,
	color = "ink",
	scale = 1,
}: {
	x: number;
	y: number;
	register?: boolean;
	seed: string;
	color?: CartoInk;
	scale?: number;
}) {
	const s = scale;
	return (
		<g>
			<PenLine
				from={[x, y]}
				to={[x, y - 8 * s]}
				seed={`${seed}-post`}
				color={color}
				width={1.1}
			/>
			<PenLine
				from={[x - 3 * s, y - 5.6 * s]}
				to={[x + 3 * s, y - 5.8 * s]}
				seed={`${seed}-bar`}
				color={color}
				width={1.1}
			/>
			{register ? (
				<path
					d={polyD(
						[
							[x + 1, y - 2 * s],
							[x + 1 + 3 * s, y - 2 * s],
							[x + 1 + 3 * s, y],
							[x + 1, y],
						],
						true,
					)}
					fill="none"
					style={{ stroke: paint(color) }}
					strokeWidth={0.6}
					strokeLinejoin="round"
				/>
			) : null}
		</g>
	);
}

// ---- Rock and scree (S7, S8) --------------------------------------------------------------------

export interface RockHachureOptions {
	/** Light azimuth in degrees, clockwise from screen up (315 = NW, the LK convention). */
	light?: number;
	/** "elevation" (a skyline: strokes hang below the ridge) or "plan" (a map ridge: both sides). */
	view?: "elevation" | "plan";
	/** Stroke pitch on the shaded side, px. */
	spacing?: number;
	/** Stroke pitch on the lit side, px. */
	litSpacing?: number;
	/** Shortest and longest stroke, px. */
	length?: [number, number];
}

/**
 * Fall-line strokes for a rock face along `ridge` (S7): the shaded side gets dense strokes that
 * touch the ridge and alternate long and short (dense near the ridge, fading down); the lit side
 * gets sparse broken strokes that stop 2 px short. Strokes leave along the smoothed ridge normal,
 * so neighbours do not cross. Returns two path strings.
 */
export function rockHachureStrokes(
	ridge: Point[],
	seed: string,
	{
		light = 315,
		view = "elevation",
		spacing = 2.5,
		litSpacing = 5,
		length = [6, 18],
	}: RockHachureOptions = {},
): { shaded: string; lit: string } {
	const samples = resampleBy(ridge, spacing);
	if (samples.length < 3) return { shaded: "", lit: "" };
	const random = createRandom(hashSeed(seed));
	const azimuth = (light * Math.PI) / 180;
	const lightDir: Point = [Math.sin(azimuth), -Math.cos(azimuth)];
	const litEvery = Math.max(1, Math.round(litSpacing / spacing));
	let shaded = "";
	let lit = "";
	const span = 3;
	for (let i = 0; i < samples.length; i++) {
		const a = samples[Math.max(0, i - span)];
		const b = samples[Math.min(samples.length - 1, i + span)];
		const tx = b[0] - a[0];
		const ty = b[1] - a[1];
		const tl = Math.hypot(tx, ty) || 1;
		// The two normals of the ridge; `outward` is the face's normal (the side the strokes fall on).
		const normals: Point[] = [
			[-ty / tl, tx / tl],
			[ty / tl, -tx / tl],
		];
		const sides =
			view === "elevation"
				? [normals[0][1] >= 0 ? normals[0] : normals[1]]
				: normals;
		for (const down of sides) {
			// The face's outward normal is opposite to the stroke direction. A face turned away from
			// the light is shaded; on a skyline only the horizontal part counts (faces turn left or
			// right), so a slope descending away from the light is shaded.
			const isShaded =
				view === "elevation"
					? -down[0] * lightDir[0] < -0.12
					: -(down[0] * lightDir[0] + down[1] * lightDir[1]) < -0.12;
			const [sx, sy] = samples[i];
			// Fall line: in elevation lean the stroke toward straight down.
			let dx = down[0];
			let dy = down[1];
			if (view === "elevation") {
				dx = dx * 0.45;
				dy = dy * 0.45 + 0.55;
				const dl = Math.hypot(dx, dy) || 1;
				dx /= dl;
				dy /= dl;
			}
			const r1 = random();
			const r2 = random();
			const r3 = random();
			if (isShaded) {
				const full = length[0] + (length[1] - length[0]) * r1;
				const len = i % 2 ? full * 0.55 : full;
				const start = 0.3;
				const ex = sx + dx * (start + len);
				const ey = sy + dy * (start + len);
				const bend = (r2 - 0.5) * 1.2;
				const cx = sx + dx * (start + len / 2) - dy * bend;
				const cy = sy + dy * (start + len / 2) + dx * bend;
				shaded += `M${f(sx + dx * start)} ${f(sy + dy * start)}Q${f(cx)} ${f(cy)} ${f(ex)} ${f(ey)}`;
			} else if (i % litEvery === 0) {
				const len = (length[0] + (length[1] - length[0]) * r1) * 0.6;
				const start = 2;
				const gapAt = start + len * (0.4 + r2 * 0.2);
				const gap = 1.5 + r3 * 1.5;
				const end = start + len + gap;
				lit += `M${f(sx + dx * start)} ${f(sy + dy * start)}L${f(sx + dx * gapAt)} ${f(sy + dy * gapAt)}`;
				lit += `M${f(sx + dx * (gapAt + gap))} ${f(sy + dy * (gapAt + gap))}L${f(sx + dx * end)} ${f(sy + dy * end)}`;
			}
		}
	}
	return { shaded, lit };
}

/**
 * S7 rock hachure: given a ridge polyline (exact data, drawn separately) and a light azimuth,
 * fall-line pen strokes on the shaded side (1.4 px, 2.5 px pitch) and sparse broken strokes on the
 * lit side (0.6 px). Use where a rock or silhouette concept is discussed, never as wallpaper.
 */
export function RockHachure({
	ridge,
	seed,
	color = "ink",
	opacity = 0.75,
	shadedWidth = 1.4,
	litWidth = 0.6,
	...options
}: RockHachureOptions & {
	ridge: Point[];
	seed: string;
	color?: CartoInk;
	opacity?: number;
	shadedWidth?: number;
	litWidth?: number;
}) {
	const { light, view, spacing, litSpacing, length } = options;
	const strokes = useMemo(
		() =>
			rockHachureStrokes(ridge, seed, {
				light,
				view,
				spacing,
				litSpacing,
				length,
			}),
		[ridge, seed, light, view, spacing, litSpacing, length],
	);
	return (
		<g
			fill="none"
			style={{ stroke: paint(color) }}
			strokeOpacity={opacity}
			strokeLinecap="round"
		>
			<path d={strokes.shaded} strokeWidth={shadedWidth} />
			<path d={strokes.lit} strokeWidth={litWidth} />
		</g>
	);
}

const pointInRings = (rings: Point[][], x: number, y: number) => {
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

/**
 * S8 scree: seeded 4–8-gon pebbles inside the path `d`, growing 1.5× downslope (toward +y), with a
 * few boulders whose lower-right edge is heavier (light from the NW).
 */
export function ScreeStipple({
	d,
	seed,
	color = "ink",
	opacity = 0.8,
	spacing = 6,
	size = 1,
	grow = 1.5,
	boulders = 3,
}: {
	d: string;
	seed: string;
	color?: CartoInk;
	opacity?: number;
	spacing?: number;
	/** Pebble scale (1 = r 0.6–1.1 px at the top). */
	size?: number;
	grow?: number;
	boulders?: number;
}) {
	const shapes = useMemo(() => {
		const rings = pathRings(d);
		const pebbles = screeFill(rings, seed, { spacing, grow, scale: size }).d;
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
		const random = createRandom(hashSeed(`${seed}-boulders`));
		let outline = "";
		let shadow = "";
		let placed = 0;
		for (let tries = 0; tries < 40 && placed < boulders; tries++) {
			const x = minX + random() * (maxX - minX);
			// Boulders roll to the foot: bias to the lower half.
			const y = minY + (0.45 + 0.55 * random()) * (maxY - minY);
			if (!pointInRings(rings, x, y)) continue;
			placed++;
			const radius = 2.6 + random() * 1;
			const sides = 6;
			const turn = random() * Math.PI;
			const ring: Point[] = Array.from({ length: sides }, (_, k) => {
				const angle = turn + (k / sides) * Math.PI * 2;
				const r = radius * (0.8 + random() * 0.35);
				return [x + Math.cos(angle) * r, y + Math.sin(angle) * r];
			});
			outline += polyD(ring, true);
			// Heavier lower-right edge: vertices facing +x+y.
			const lower = ring
				.map((p, k) => ({ p, k, score: p[0] - x + (p[1] - y) }))
				.sort((a, b) => b.score - a.score)
				.slice(0, 3)
				.sort((a, b) => a.k - b.k)
				.map((entry) => entry.p);
			shadow += polyD(lower);
		}
		return { pebbles, outline, shadow };
	}, [d, seed, spacing, grow, size, boulders]);
	return (
		<g>
			<path
				d={shapes.pebbles}
				style={{ fill: paint(color) }}
				fillOpacity={opacity}
			/>
			<path
				d={shapes.outline}
				fill="none"
				style={{ stroke: paint(color) }}
				strokeOpacity={opacity}
				strokeWidth={0.6}
				strokeLinejoin="round"
			/>
			<path
				d={shapes.shadow}
				fill="none"
				style={{ stroke: paint(color) }}
				strokeOpacity={opacity}
				strokeWidth={1.3}
				strokeLinecap="round"
			/>
		</g>
	);
}

// ---- Kroki areas (S11) --------------------------------------------------------------------------

const KROKI = {
	forest: { angle: -45, gap: 4, width: 0.7, color: "forest" },
	building: { angle: 90, gap: 2.5, width: 0.6, color: "ink" },
	water: { angle: 0, gap: 3, width: 0.6, color: "blue" },
} as const;

/**
 * S11 Kroki area hatch inside `d`: forest diagonal (green, 4 px), building vertical (ink, 2.5 px),
 * water horizontal (blue, 3 px), with a hand outline. Replaces flat tints. `edge: "open"` draws a
 * dotted outline (an undefined forest edge).
 */
export function KrokiHatch({
	d,
	kind,
	seed,
	color,
	opacity = 0.6,
	outline = true,
	edge = "defined",
}: {
	d: string;
	kind: "forest" | "building" | "water";
	seed: string;
	color?: CartoInk;
	opacity?: number;
	outline?: boolean;
	edge?: "defined" | "open";
}) {
	const spec = KROKI[kind];
	const lines = useMemo(
		() =>
			hachureFill(pathRings(d), `${seed}-${kind}`, {
				angle: spec.angle,
				gap: spec.gap,
			}),
		[d, seed, kind, spec],
	);
	const ink = color ?? spec.color;
	return (
		<g>
			<path
				d={lines}
				fill="none"
				style={{ stroke: paint(ink) }}
				strokeWidth={spec.width}
				strokeOpacity={opacity}
				strokeLinecap="round"
			/>
			{outline ? (
				<SketchPath
					d={d}
					seed={`${seed}-edge`}
					color={ink}
					width={PEN_TIER.fine}
					passes={edge === "open" ? 1 : 2}
					dash={edge === "open" ? "0.1 3" : undefined}
				/>
			) : null}
		</g>
	);
}

// ---- Furniture (S12, S13, S15) ------------------------------------------------------------------

const NICE_LENGTHS = [
	10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000,
	25000, 50000, 100000,
];
const formatDistance = (meters: number) =>
	meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;

/**
 * S12 hand scale bar: a double rail 4 px tall, alternate segments filled with pencil hatch, end ticks
 * overshooting, "0 · 500 · 1 km" in italic hand figures. The length is true: it is the largest nice
 * distance that fits `maxWidth` at `metersPerPixel` (or `meters` if given).
 */
export function HandScaleBar({
	x,
	y,
	metersPerPixel,
	meters,
	maxWidth = 140,
	segments = 4,
	seed,
	color = "ink",
}: {
	x: number;
	y: number;
	metersPerPixel: number;
	meters?: number;
	maxWidth?: number;
	segments?: number;
	seed: string;
	color?: CartoInk;
}) {
	const total =
		meters ??
		[...NICE_LENGTHS].reverse().find((m) => m / metersPerPixel <= maxWidth) ??
		NICE_LENGTHS[0];
	const width = total / metersPerPixel;
	const step = width / segments;
	const hatch = useMemo(() => {
		let lines = "";
		for (let k = 0; k < segments; k += 2)
			lines += hachureFill(
				[
					[
						[x + k * step, y],
						[x + (k + 1) * step, y],
						[x + (k + 1) * step, y + 4],
						[x + k * step, y + 4],
					],
				],
				`${seed}-seg${k}`,
				{ angle: -45, gap: 1.6, inset: 0.3 },
			);
		return lines;
	}, [x, y, step, segments, seed]);
	return (
		<g>
			<PenLine
				from={[x, y]}
				to={[x + width, y]}
				seed={`${seed}-top`}
				color={color}
				width={0.8}
			/>
			<PenLine
				from={[x, y + 4]}
				to={[x + width, y + 4]}
				seed={`${seed}-bottom`}
				color={color}
				width={0.8}
			/>
			<path
				d={hatch}
				fill="none"
				style={{ stroke: paint("pencil") }}
				strokeWidth={0.6}
				strokeOpacity={0.8}
			/>
			{Array.from({ length: segments + 1 }, (_, k) => (
				<PenLine
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed tick positions
					key={k}
					from={[x + k * step, y - (k === 0 || k === segments ? 1.5 : 0)]}
					to={[x + k * step, y + 4 + (k === 0 || k === segments ? 1.5 : 0)]}
					seed={`${seed}-tick${k}`}
					color={color}
					width={0.7}
				/>
			))}
			<HeightFigure x={x} y={y - 4} value="0" anchor="middle" size={10} />
			<HeightFigure
				x={x + width / 2}
				y={y - 4}
				value={formatDistance(total / 2).replace(/ (k?m)$/, "")}
				anchor="middle"
				size={10}
			/>
			<HeightFigure
				x={x + width}
				y={y - 4}
				value={formatDistance(total)}
				anchor="middle"
				size={10}
			/>
		</g>
	);
}

/**
 * S13 Kroki north arrow: a 28 px pen shaft, an open two-line head, a hand "N" above. With
 * `declination` (degrees, east positive) it becomes the declination fan: grid N (pencil), true N
 * (pen, rotated by `convergence`), magnetic N (red half arrow) and the angle written "3° E". Angles
 * are drawn `exaggerate` times larger, the way declination diagrams are; the written value is true.
 */
export function NorthArrow({
	x,
	y,
	length = 28,
	declination,
	convergence = 0,
	exaggerate = 3,
	seed,
	color = "ink",
}: {
	/** Foot of the shaft. */
	x: number;
	y: number;
	length?: number;
	declination?: number;
	convergence?: number;
	exaggerate?: number;
	seed: string;
	color?: CartoInk;
}) {
	const tip = (degrees: number, scale = 1): Point => {
		const a = (degrees * exaggerate * Math.PI) / 180;
		return [x + Math.sin(a) * length * scale, y - Math.cos(a) * length * scale];
	};
	const head = (to: Point, degrees: number, half = false) => {
		const a = (degrees * exaggerate * Math.PI) / 180;
		const back = 6;
		const left: Point = [
			to[0] - Math.sin(a - 0.45) * back,
			to[1] + Math.cos(a - 0.45) * back,
		];
		const right: Point = [
			to[0] - Math.sin(a + 0.45) * back,
			to[1] + Math.cos(a + 0.45) * back,
		];
		return half
			? `M${f(right[0])} ${f(right[1])}L${f(to[0])} ${f(to[1])}`
			: `M${f(left[0])} ${f(left[1])}L${f(to[0])} ${f(to[1])}L${f(right[0])} ${f(right[1])}`;
	};
	const trueTip = tip(convergence);
	const fan = declination !== undefined;
	const magnetic = fan ? convergence + (declination as number) : 0;
	const magneticTip = tip(magnetic, 0.92);
	const declinationText = fan
		? `${Math.abs(declination as number)
				.toFixed(1)
				.replace(/\.0$/, "")}° ${(declination as number) >= 0 ? "E" : "W"}`
		: "";
	return (
		<g>
			{fan && convergence !== 0 ? (
				<PenLine
					from={[x, y]}
					to={[x, y - length * 0.9]}
					seed={`${seed}-grid`}
					color="pencil"
					width={0.6}
					opacity={0.7}
				/>
			) : null}
			<PenLine
				from={[x, y]}
				to={trueTip}
				seed={`${seed}-shaft`}
				color={color}
				width={1.2}
			/>
			<PenPath
				d={head(trueTip, convergence)}
				seed={`${seed}-head`}
				color={color}
				width={1.1}
				blob={false}
			/>
			<HandText
				x={trueTip[0]}
				y={trueTip[1] - 5}
				anchor="middle"
				size={15}
				color={color}
			>
				N
			</HandText>
			{fan ? (
				<>
					<PenLine
						from={[x, y]}
						to={magneticTip}
						seed={`${seed}-mag`}
						color="red"
						width={0.9}
					/>
					<PenPath
						d={head(magneticTip, magnetic, true)}
						seed={`${seed}-maghead`}
						color="red"
						width={0.9}
						blob={false}
					/>
					<HandText
						x={x + (magneticTip[0] - x) * 0.6 + 4}
						y={y - length * 0.45}
						size={11}
						color="red"
						variant="label"
					>
						{declinationText}
					</HandText>
				</>
			) : null}
		</g>
	);
}

/** "1:25 000" from 25000, with a narrow no-break space as the thousands separator. */
export const formatScale = (scale: number | string) =>
	typeof scale === "number"
		? `1:${Math.round(scale)
				.toString()
				.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`
		: scale;

/**
 * S15 Kroki title block (mandatory on a field sketch): a hand title underlined once, then
 * "ca. 1:25 000 · R. C. · 01.10.2026 · 14:20" in a small hand. No box. Lower left by convention.
 */
export function KrokiTitle({
	x,
	y,
	title,
	scale,
	author = "R. C.",
	date,
	time,
	seed,
	size = 22,
	color = "ink",
}: {
	x: number;
	/** Baseline of the title. */
	y: number;
	title: string;
	/** 25000 or "1:25 000"; written "ca. 1:25 000". */
	scale?: number | string;
	author?: string;
	/** "01.10.2026" */
	date?: string;
	/** "14:20" */
	time?: string;
	seed: string;
	size?: number;
	color?: CartoInk;
}) {
	const underline = Math.max(24, title.length * size * 0.4);
	const meta = [
		scale !== undefined ? `ca. ${formatScale(scale)}` : null,
		author || null,
		date ?? null,
		time ?? null,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<g>
			<HandText x={x} y={y} size={size} color={color} variant="note">
				{title}
			</HandText>
			<PenLine
				from={[x - 2, y + 4]}
				to={[x + underline, y + 3]}
				seed={`${seed}-underline`}
				color={color}
				width={1.3}
			/>
			{meta ? (
				<HandText
					x={x}
					y={y + 4 + size * 0.75}
					size={12}
					color="pencil"
					variant="label"
				>
					{meta}
				</HandText>
			) : null}
		</g>
	);
}

// ---- Routes (S17, S18, S19) ---------------------------------------------------------------------

export type TrailKind = "hike" | "mountain" | "alpine";
/** Certainty grammar: certain = solid, probable = dashed, uncertain = dotted (L3: dashes mean doubt). */
const CERTAINTY: Record<"certain" | "probable" | "uncertain", TrailKind> = {
	certain: "hike",
	probable: "mountain",
	uncertain: "alpine",
};

/**
 * S17 route line in Wanderkarte red: hike solid 1.8 px pen, mountain dashed 6/3, alpine dotted. Pass
 * `certainty` to use the same line for how sure a result is.
 */
export function TrailLine({
	d,
	kind = "hike",
	certainty,
	seed,
	color = "red",
	width,
	opacity,
}: {
	d: string;
	kind?: TrailKind;
	certainty?: keyof typeof CERTAINTY;
	seed: string;
	color?: CartoInk;
	width?: number;
	opacity?: number;
}) {
	const cat = certainty ? CERTAINTY[certainty] : kind;
	if (cat === "hike")
		return (
			<PenPath
				d={d}
				seed={seed}
				color={color}
				width={width ?? 1.8}
				opacity={opacity}
			/>
		);
	return (
		<SketchPath
			d={d}
			seed={seed}
			color={color}
			width={width ?? (cat === "mountain" ? 1.6 : 1.4)}
			opacity={opacity}
			passes={1}
			dash={cat === "mountain" ? "6 3" : "0.01 4"}
		/>
	);
}

/** Wraps an SVG primitive in its own small inline <svg> for use in running text. */
function InlineSvg({
	width,
	height,
	children,
	label,
}: {
	width: number;
	height: number;
	children: ReactNode;
	label?: string;
}) {
	return (
		<svg
			width={width}
			height={height}
			viewBox={`0 0 ${width} ${height}`}
			className="inline-block overflow-visible align-[-0.15em]"
			role={label ? "img" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
		>
			{children}
		</svg>
	);
}

/** A painted shape with a slightly rough edge (wobble ≈ 0.6 px). */
const roughPolygon = (points: Point[], seed: string) => {
	const random = createRandom(hashSeed(seed));
	const out: Point[] = [];
	for (let i = 0; i < points.length; i++) {
		const a = points[i];
		const b = points[(i + 1) % points.length];
		for (let k = 0; k < 3; k++) {
			const t = k / 3;
			out.push([
				a[0] + (b[0] - a[0]) * t + (random() - 0.5) * 0.6,
				a[1] + (b[1] - a[1]) * t + (random() - 0.5) * 0.6,
			]);
		}
	}
	return polyD(out, true);
};

/**
 * S18 painted waymark, upright: hike = an 8 px yellow rhombus; mountain = 12 × 7 px white-red-white
 * bands; alpine = white-blue-white. A 1 px ink edge on the left and top only. Give x, y (centre)
 * inside a figure, or omit them for an inline glyph in prose.
 */
export function Blaze({
	kind,
	x,
	y,
	seed,
}: {
	kind: TrailKind;
	x?: number;
	y?: number;
	seed?: string;
}) {
	const inline = x === undefined || y === undefined;
	const cx = inline ? 8 : x;
	const cy = inline ? 6 : y;
	const key = seed ?? `blaze-${kind}`;
	const body =
		kind === "hike" ? (
			<g>
				<path
					d={roughPolygon(
						[
							[cx, cy - 5],
							[cx + 4, cy],
							[cx, cy + 5],
							[cx - 4, cy],
						],
						key,
					)}
					style={{ fill: "var(--gb-sign, #e59e1f)" }}
				/>
				<path
					d={`M${f(cx - 4)} ${f(cy)}L${f(cx)} ${f(cy - 5)}`}
					fill="none"
					style={{ stroke: paint("ink") }}
					strokeWidth={0.8}
					strokeLinecap="round"
				/>
			</g>
		) : (
			<g>
				{[0, 1, 2].map((band) => (
					<path
						key={band}
						d={roughPolygon(
							[
								[cx - 6, cy - 3.5 + (band * 7) / 3],
								[cx + 6, cy - 3.5 + (band * 7) / 3],
								[cx + 6, cy - 3.5 + ((band + 1) * 7) / 3],
								[cx - 6, cy - 3.5 + ((band + 1) * 7) / 3],
							],
							`${key}-${band}`,
						)}
						style={{
							fill:
								band === 1
									? kind === "mountain"
										? paint("red")
										: "var(--nb-alpine, #2874b2)"
									: "var(--gb-white, #f4f4f4)",
						}}
					/>
				))}
				<path
					d={`M${f(cx - 6)} ${f(cy + 3.5)}L${f(cx - 6)} ${f(cy - 3.5)}L${f(cx + 6)} ${f(cy - 3.5)}`}
					fill="none"
					style={{ stroke: paint("ink") }}
					strokeWidth={0.8}
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</g>
		);
	if (!inline) return body;
	const label =
		kind === "hike"
			? "Wanderweg"
			: kind === "mountain"
				? "Bergwanderweg"
				: "Alpinwanderweg";
	return (
		<InlineSvg width={16} height={12} label={label}>
			{body}
		</InlineSvg>
	);
}

/**
 * S19 grade in a rough hand box ("T4", "WS+"): four strokes with overshooting corners, bold hand
 * caps; red when it is the route's crux. Omit x, y for an inline glyph in prose. (x, y) is the
 * text baseline start.
 */
export function GradeBox({
	grade,
	x,
	y,
	crux = false,
	seed,
	size = 11,
}: {
	grade: string;
	x?: number;
	y?: number;
	crux?: boolean;
	seed?: string;
	size?: number;
}) {
	const inline = x === undefined || y === undefined;
	const width = grade.length * size * 0.62 + 6;
	const height = size + 4;
	const bx = inline ? 2 : x;
	const by = inline ? height : y;
	const color: CartoInk = crux ? "red" : "ink";
	const boxStrokes = useMemo(
		() =>
			sketchRect(
				bx - 3,
				by - size - 0.5,
				width,
				height,
				seed ?? `grade-${grade}`,
				{
					passes: 1,
					overshoot: 1.5,
					tolerance: 0.8,
				},
			),
		[bx, by, size, width, height, seed, grade],
	);
	const body = (
		<g>
			<path
				d={boxStrokes[0]}
				fill="none"
				style={{ stroke: paint(color) }}
				strokeWidth={0.9}
				strokeLinecap="round"
			/>
			<text
				x={bx}
				y={by - 1}
				className="nb-label"
				fontSize={size}
				fontWeight={700}
				style={{ fill: paint(color) }}
			>
				{grade}
			</text>
		</g>
	);
	if (!inline) return body;
	return (
		<InlineSvg width={width + 4} height={height + 3} label={`Grad ${grade}`}>
			{body}
		</InlineSvg>
	);
}

// ---- Lettering (S20, S21) -----------------------------------------------------------------------

export type NameClass =
	| "peak"
	| "place"
	| "hamlet"
	| "water"
	| "glacier"
	| "region"
	| "pass";

const NAME_STYLE: Record<
	NameClass,
	{
		className: string;
		size: number;
		color: CartoInk;
		skew: number;
		spacing: string;
		weight: number;
		opacity?: number;
	}
> = {
	peak: {
		className: "nb-label",
		size: 14,
		color: "navy",
		skew: 0,
		spacing: "0.04em",
		weight: 500,
	},
	place: {
		className: "nb-hand nb-hand-small",
		size: 13,
		color: "ink",
		skew: 0,
		spacing: "0.01em",
		weight: 500,
	},
	hamlet: {
		className: "nb-hand nb-hand-small",
		size: 12,
		color: "ink",
		skew: -12,
		spacing: "0.01em",
		weight: 450,
	},
	water: {
		className: "nb-hand nb-hand-small",
		size: 13,
		color: "blue",
		skew: -12,
		spacing: "0.02em",
		weight: 450,
	},
	glacier: {
		className: "nb-hand nb-hand-small",
		size: 13,
		color: "blue",
		skew: -12,
		spacing: "0.06em",
		weight: 450,
	},
	region: {
		className: "nb-hand nb-hand-small",
		size: 12,
		color: "ink",
		skew: -10,
		spacing: "0.3em",
		weight: 300,
		opacity: 0.8,
	},
	pass: {
		className: "nb-label",
		size: 11,
		color: "ink",
		skew: 0,
		spacing: "0.06em",
		weight: 400,
	},
};

/**
 * S20 hand lettering by LK name class: peak = navy hand caps; place = upright hand; hamlet, water and
 * glacier = sloped (skewX −12°, water and glacier blue); region = letter-spaced light sloped; pass =
 * small hand caps. Paper halo 2 px. `rotate` sets a name along a valley or river.
 */
export function HandName({
	x,
	y,
	text,
	cls,
	size,
	color,
	anchor = "start",
	rotate = 0,
	halo = true,
}: {
	x: number;
	y: number;
	text: string;
	cls: NameClass;
	size?: number;
	color?: CartoInk;
	anchor?: "start" | "middle" | "end";
	rotate?: number;
	halo?: boolean;
}) {
	const style = NAME_STYLE[cls];
	const transform = [
		`translate(${f(x)} ${f(y)})`,
		rotate ? `rotate(${rotate})` : "",
		style.skew ? `skewX(${style.skew})` : "",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<text
			transform={transform}
			className={style.className}
			fontSize={size ?? style.size}
			fontWeight={style.weight}
			letterSpacing={style.spacing}
			textAnchor={anchor}
			style={{ fill: paint(color ?? style.color) }}
			fillOpacity={style.opacity}
			{...haloProps(halo, 4)}
		>
			{text}
		</text>
	);
}

export interface PeakLeaderInput {
	/** Peak position on the skyline. */
	x: number;
	y: number;
	label: string;
	h?: number;
	/** Second line, e.g. "14.2 km · 205°". */
	detail?: string;
}

export interface PeakLeaderPlacement extends PeakLeaderInput {
	/** Baseline of the name line. */
	labelY: number;
	row: number;
	/** Where the label hangs from its leader: centred, or starting / ending at the leader. */
	anchor: "middle" | "start" | "end";
	/** Estimated label extent [left, right]. */
	extent: [number, number];
	/** True when no row and anchor were free and the least-bad one was used. */
	conflict: boolean;
}

/** A rough width for a peak label in hand caps + italic figures at `size`. */
export const estimatePeakLabelWidth = (peak: PeakLeaderInput, size = 13) =>
	peak.label.length * size * 0.66 +
	(peak.h !== undefined
		? (String(Math.round(peak.h)).length + 1) * size * 0.55
		: 0);

/** Gap between a start/end-anchored label and its leader, px. */
const LEADER_GAP = 3;

/**
 * Stagger peak labels into rows above a skyline so that no two labels in a row overlap and no
 * (vertical) leader runs through another label. Rows stack upward from `baseline` (row 0 is the
 * lowest; default just above the highest summit). Each label may be centred on its leader or hang
 * right or left of it. A bounded depth-first search (left to right, low rows and centred labels
 * first) looks for a placement with no clash; if it runs out of budget, each peak takes its
 * least-clashing slot and clashing ones are flagged `conflict`.
 */
export function layoutPeakLeaders(
	peaks: PeakLeaderInput[],
	{
		baseline,
		rowGap = 26,
		rows = 3,
		size = 13,
		pad = 6,
		minLength = 10,
		measure = estimatePeakLabelWidth,
	}: {
		baseline?: number;
		rowGap?: number;
		rows?: number;
		size?: number;
		pad?: number;
		minLength?: number;
		measure?: (peak: PeakLeaderInput, size: number) => number;
	} = {},
): PeakLeaderPlacement[] {
	if (!peaks.length) return [];
	const hasDetail = peaks.some((peak) => peak.detail);
	const lowest =
		baseline ??
		Math.min(...peaks.map((peak) => peak.y)) -
			minLength -
			(hasDetail ? size * 0.85 + 4 : 4);
	const order = peaks
		.map((peak, index) => ({ peak, index }))
		.sort((a, b) => a.peak.x - b.peak.x);
	const anchors = ["middle", "start", "end"] as const;
	type Anchor = (typeof anchors)[number];
	interface Slot {
		row: number;
		anchor: Anchor;
		extent: [number, number];
		x: number;
	}
	// Every candidate slot per peak, lowest row and centred first.
	const options: Slot[][] = order.map(({ peak }) => {
		const width = measure(peak, size);
		const list: Slot[] = [];
		for (let row = 0; row < rows; row++)
			for (const anchor of anchors)
				list.push({
					row,
					anchor,
					x: peak.x,
					extent:
						anchor === "middle"
							? [peak.x - width / 2, peak.x + width / 2]
							: anchor === "start"
								? [peak.x - LEADER_GAP, peak.x + width]
								: [peak.x - width, peak.x + LEADER_GAP],
				});
		return list;
	});
	/** Conflicts between two slots: same-row overlap, or a leader through the other's label. */
	const clash = (a: Slot, b: Slot) =>
		(a.row === b.row &&
			a.extent[0] < b.extent[1] + pad &&
			b.extent[0] < a.extent[1] + pad) ||
		(b.row < a.row &&
			a.x > b.extent[0] - pad / 2 &&
			a.x < b.extent[1] + pad / 2) ||
		(a.row < b.row &&
			b.x > a.extent[0] - pad / 2 &&
			b.x < a.extent[1] + pad / 2);
	// Depth-first search for a placement with no clash at all, with a node budget.
	const chosen: Slot[] = [];
	let budget = 20000;
	const search = (k: number): boolean => {
		if (k === order.length) return true;
		for (const slot of options[k]) {
			if (--budget < 0) return false;
			if (chosen.some((other) => clash(slot, other))) continue;
			chosen.push(slot);
			if (search(k + 1)) return true;
			chosen.pop();
		}
		return false;
	};
	const solved = search(0);
	const conflicted = new Set<number>();
	if (!solved) {
		// Greedy fallback: each peak takes its least-clashing slot.
		chosen.length = 0;
		options.forEach((list, k) => {
			let best = list[0];
			let bestCount = Number.POSITIVE_INFINITY;
			for (const slot of list) {
				const count = chosen.filter((other) => clash(slot, other)).length;
				if (count < bestCount) {
					best = slot;
					bestCount = count;
				}
				if (!count) break;
			}
			if (bestCount > 0) conflicted.add(k);
			chosen.push(best);
		});
	}
	const out: PeakLeaderPlacement[] = new Array(peaks.length);
	order.forEach(({ peak, index }, k) => {
		const slot = chosen[k];
		out[index] = {
			...peak,
			row: slot.row,
			anchor: slot.anchor,
			labelY: lowest - slot.row * rowGap,
			extent: slot.extent,
			conflict: conflicted.has(k),
		};
	});
	return out;
}

/**
 * S21 peak leader (Imfeld / Tafel style): a 0.6 px hairline from a 1.5 px dot at the peak up to the
 * label; the name in hand caps, the height in italic hand figures, and an optional small italic
 * second line ("14.2 km · 205°"). Position rows with layoutPeakLeaders.
 */
export function PeakLeader({
	x,
	y,
	labelY,
	label,
	h,
	detail,
	seed,
	size = 13,
	color = "navy",
	leaderColor = "ink",
	anchor = "middle",
}: {
	x: number;
	y: number;
	/** Baseline of the name line (from layoutPeakLeaders). */
	labelY: number;
	/** From layoutPeakLeaders: the label centred on its leader or hanging right / left of it. */
	anchor?: "middle" | "start" | "end";
	label: string;
	h?: number;
	detail?: string;
	seed: string;
	size?: number;
	color?: CartoInk;
	leaderColor?: CartoInk;
}) {
	// A centred label sits on top of its leader; a hanging label meets the leader at mid x-height.
	const leaderTop =
		anchor === "middle"
			? labelY + (detail ? size * 0.85 + 4 : 4)
			: labelY - size * 0.3;
	const textX =
		anchor === "start" ? x + LEADER_GAP : anchor === "end" ? x - LEADER_GAP : x;
	return (
		<g>
			{y - leaderTop > 3 ? (
				<PenLine
					from={[x, y - 3]}
					to={[x, leaderTop]}
					seed={`${seed}-leader`}
					color={leaderColor}
					width={PEN_TIER.hairline}
				/>
			) : null}
			<HandDot x={x} y={y} r={0.9} seed={`${seed}-dot`} color={leaderColor} />
			<text
				x={textX}
				y={labelY}
				textAnchor={anchor}
				fontSize={size}
				style={{ fill: paint(color) }}
				{...haloProps(true, 3.5)}
			>
				<tspan className="nb-label" letterSpacing="0.04em">
					{label}
				</tspan>
				{h !== undefined ? (
					<tspan
						className="nb-num nb-height"
						dx={size * 0.3}
						fontSize={size * 0.85}
					>
						{Math.round(h)}
					</tspan>
				) : null}
			</text>
			{detail ? (
				<text
					x={textX}
					y={labelY + size * 0.85 + 1}
					textAnchor={anchor}
					className="nb-num nb-height"
					fontSize={size * 0.72}
					style={{ fill: paint("pencil") }}
					{...haloProps(true, 3)}
				>
					{detail}
				</text>
			) : null}
		</g>
	);
}

// ---- Survey (S23) ------------------------------------------------------------------------------

export interface StationTarget {
	point: Point;
	/** Written along the ray: a number is shown as "205.3°". */
	bearing?: number | string;
	/** The solved ray: red pen instead of pencil. */
	solved?: boolean;
}

/**
 * S23 plane-table station: the station as a trig triangle, pencil rays (0.6 px) to each target
 * extended 6 px past it, the bearing written along the ray (kept readable left to right), and the
 * solved ray in red pen.
 */
export function StationRays({
	station,
	targets,
	seed,
	extend = 6,
	h,
}: {
	station: Point;
	targets: StationTarget[];
	seed: string;
	extend?: number;
	/** Station height for its trig label. */
	h?: number;
}) {
	return (
		<g>
			{targets.map((target, index) => {
				const [sx, sy] = station;
				const [tx, ty] = target.point;
				const length = Math.hypot(tx - sx, ty - sy) || 1;
				const ux = (tx - sx) / length;
				const uy = (ty - sy) / length;
				const end: Point = [tx + ux * extend, ty + uy * extend];
				let angle = (Math.atan2(uy, ux) * 180) / Math.PI;
				if (angle > 90) angle -= 180;
				if (angle < -90) angle += 180;
				const mid: Point = [sx + ux * length * 0.55, sy + uy * length * 0.55];
				const text =
					typeof target.bearing === "number"
						? `${target.bearing.toFixed(1)}°`
						: target.bearing;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: targets are a fixed list per figure
					<g key={index}>
						<PenLine
							from={station}
							to={end}
							seed={`${seed}-ray${index}`}
							color={target.solved ? "red" : "pencil"}
							width={target.solved ? PEN_TIER.fine : PEN_TIER.hairline}
							opacity={target.solved ? 1 : 0.75}
						/>
						{text ? (
							<text
								transform={`translate(${f(mid[0] - uy * 4)} ${f(mid[1] + ux * 4 - 2)}) rotate(${f(angle)})`}
								textAnchor="middle"
								className="nb-num nb-height"
								fontSize={10}
								style={{ fill: paint(target.solved ? "red" : "pencil") }}
								{...haloProps(true, 3)}
							>
								{text}
							</text>
						) : null}
					</g>
				);
			})}
			<TrigTriangle
				x={station[0]}
				y={station[1]}
				h={h}
				seed={`${seed}-station`}
			/>
		</g>
	);
}

// ---- Contours and profiles (S3, S26) -----------------------------------------------------------

export interface ContourScribbleOptions {
	count?: number;
	/** Radius of the outermost loop, px. */
	radius?: number;
	/** Screen azimuth of the steep side (degrees clockwise from up); loops crowd there. */
	steep?: number;
	/** How much the steep side crowds the loops (0..0.6). */
	steepness?: number;
	/** Vertical squash of the loops (1 = round). */
	squash?: number;
}

/**
 * Nested open pen loops around `center` (S3): the same lumpy outline shrunk ring by ring, each loop
 * stopping 8–15° short of closing and drifting 2 px outward at its end (so it overshoots its own
 * start), crowded on the `steep` side. Returns one point list per loop, innermost first.
 */
export function contourScribbleLoops(
	center: Point,
	seed: string,
	{
		count = 5,
		radius = 48,
		steep,
		steepness = 0.35,
		squash = 1,
	}: ContourScribbleOptions = {},
): Point[][] {
	const random = createRandom(hashSeed(seed));
	const phases = [random(), random(), random()].map((r) => r * Math.PI * 2);
	const amps = [
		0.1 + random() * 0.06,
		0.05 + random() * 0.05,
		0.03 + random() * 0.03,
	];
	const steepAngle =
		steep === undefined ? undefined : ((steep - 90) * Math.PI) / 180;
	const loops: Point[][] = [];
	for (let ring = 0; ring < count; ring++) {
		const base = (radius * (ring + 1)) / count;
		const start = random() * Math.PI * 2;
		const gap = ((8 + random() * 7) * Math.PI) / 180;
		const sweep = Math.PI * 2 - gap;
		const own = (random() - 0.5) * 0.04;
		const steps = Math.max(16, Math.ceil((base * sweep) / 4));
		const loop: Point[] = [];
		for (let k = 0; k <= steps; k++) {
			const t = k / steps;
			const theta = start + sweep * t;
			let r =
				base *
				(1 +
					own +
					amps[0] * Math.sin(theta + phases[0]) +
					amps[1] * Math.sin(2 * theta + phases[1]) +
					amps[2] * Math.sin(3 * theta + phases[2]));
			if (steepAngle !== undefined)
				r *= 1 - steepness * Math.max(0, Math.cos(theta - steepAngle)) ** 2;
			r += 2 * t * t;
			loop.push([
				center[0] + Math.cos(theta) * r,
				center[1] + Math.sin(theta) * r * squash,
			]);
		}
		loops.push(loop);
	}
	return loops;
}

/** Open a closed ring at a seeded place, leaving a gap of about `gap` of its length. */
const openRing = (ring: Point[], seed: number, gap = 0.035): Point[] => {
	if (ring.length < 4) return ring;
	const random = createRandom(seed);
	const n = ring.length;
	const start = Math.floor(random() * n);
	const keep = Math.max(2, Math.round(n * (1 - gap)));
	return Array.from({ length: keep }, (_, k) => ring[(start + k) % n]);
};

/**
 * S3 contour scribble: a quick 3–6-ring summit or ridge form as nested open pen loops (brown, 0.9 px;
 * every `indexEvery`-th ring 1.4 px). Give a `center` (generated loops) or `rings` (closed contour
 * rings, e.g. from a DEM; they are opened with a small gap, not moved).
 */
export function ContourScribble({
	center,
	rings,
	seed,
	color = "brown",
	width = PEN_TIER.fine,
	indexEvery = 5,
	opacity,
	...options
}: ContourScribbleOptions & {
	center?: Point;
	rings?: Point[][];
	seed: string;
	color?: CartoInk;
	width?: number;
	indexEvery?: number;
	opacity?: number;
}) {
	const { count, radius, steep, steepness, squash } = options;
	const loops = useMemo(
		() =>
			rings
				? rings.map((ring, index) =>
						openRing(ring, hashSeed(`${seed}-${index}`)),
					)
				: center
					? contourScribbleLoops(center, seed, {
							count,
							radius,
							steep,
							steepness,
							squash,
						})
					: [],
		[rings, center, seed, count, radius, steep, steepness, squash],
	);
	return (
		<g>
			{loops.map((loop, index) => (
				<PenPath
					// biome-ignore lint/suspicious/noArrayIndexKey: loops are a fixed nested series
					key={index}
					points={loop}
					seed={`${seed}-loop${index}`}
					color={color}
					opacity={opacity}
					width={(index + 1) % indexEvery === 0 ? 1.4 : width}
					blob={false}
				/>
			))}
		</g>
	);
}

/**
 * S26 profile sketch (Querprofil): the ground line as a measured pen pass (brown, within the data
 * tolerance), pencil fall-line strokes hanging under it (3 px pitch, longer where steeper), a pencil
 * base line, spot heights at the highest point (or `spots`), and the vertical exaggeration written
 * by hand ("2× überhöht"). `samples` are heights (evenly spaced) or [distance m, height m] pairs;
 * with pairs and no `exaggeration`, the true exaggeration is computed.
 */
export function ProfileSketch({
	samples,
	x,
	y,
	width,
	height,
	seed,
	exaggeration,
	spots,
	color = "brown",
	hatchGap = 3,
}: {
	samples: number[] | Point[];
	x: number;
	y: number;
	width: number;
	height: number;
	seed: string;
	exaggeration?: number;
	/** Sample indices that get a spot height; default the highest sample. */
	spots?: number[];
	color?: CartoInk;
	hatchGap?: number;
}) {
	const geometry = useMemo(() => {
		const pairs: Point[] =
			typeof samples[0] === "number"
				? (samples as number[]).map((value, index) => [index, value])
				: (samples as Point[]);
		if (pairs.length < 2) return null;
		const d0 = pairs[0][0];
		const d1 = pairs[pairs.length - 1][0];
		let low = Number.POSITIVE_INFINITY;
		let high = Number.NEGATIVE_INFINITY;
		for (const [, h] of pairs) {
			low = Math.min(low, h);
			high = Math.max(high, h);
		}
		const pad = (high - low || 1) * 0.12;
		const lo = low - pad;
		const hi = high + pad * 0.5;
		const sx = width / (d1 - d0 || 1);
		const sy = height / (hi - lo || 1);
		const toScreen = ([dist, h]: Point): Point => [
			x + (dist - d0) * sx,
			y + height - (h - lo) * sy,
		];
		const line = pairs.map(toScreen);
		const base = y + height;
		// Fall-line hatch: vertical pencil strokes under the line, longer where steeper.
		const random = createRandom(hashSeed(`${seed}-hatch`));
		let hatch = "";
		let j = 0;
		for (
			let px = line[0][0] + hatchGap / 2;
			px < line[line.length - 1][0];
			px += hatchGap
		) {
			while (j < line.length - 2 && line[j + 1][0] < px) j++;
			const [ax, ay] = line[j];
			const [bx, by] = line[j + 1];
			const t = (px - ax) / (bx - ax || 1);
			const gy = ay + (by - ay) * t;
			const slope = Math.abs((by - ay) / (bx - ax || 1));
			const len = Math.min(
				base - gy - 1,
				4 + 14 * clamp(slope, 0, 1) + random() * 3,
			);
			if (len < 1.5) continue;
			const top = gy + 1.2;
			hatch += `M${f(px + (random() - 0.5) * 0.5)} ${f(top)}L${f(px + (random() - 0.5) * 0.8)} ${f(top + len)}`;
		}
		let topIndex = 0;
		pairs.forEach(([, h], index) => {
			if (h > pairs[topIndex][1]) topIndex = index;
		});
		const computed = typeof samples[0] === "number" ? undefined : sy / sx;
		return { line, hatch, base, topIndex, pairs, computed };
	}, [samples, x, y, width, height, seed, hatchGap]);
	if (!geometry) return null;
	const ratio = exaggeration ?? geometry.computed;
	const ratioText =
		ratio === undefined
			? null
			: `${(Math.round(ratio * 10) / 10).toString().replace(/\.0$/, "")}× überhöht`;
	return (
		<g>
			<path
				d={geometry.hatch}
				fill="none"
				style={{ stroke: paint("pencil") }}
				strokeWidth={0.6}
				strokeOpacity={0.55}
				strokeLinecap="round"
			/>
			<PenLine
				from={[x - 3, geometry.base]}
				to={[x + width + 3, geometry.base]}
				seed={`${seed}-base`}
				color="pencil"
				width={0.6}
				opacity={0.7}
			/>
			<SketchPolyline
				points={geometry.line}
				seed={`${seed}-ground`}
				color={color}
				width={1.4}
				data
			/>
			{(spots ?? [geometry.topIndex]).map((index) => {
				const point = geometry.line[index];
				if (!point) return null;
				return (
					<SpotX
						key={index}
						x={point[0]}
						y={point[1] - 4}
						h={geometry.pairs[index][1]}
						seed={`${seed}-spot${index}`}
					/>
				);
			})}
			{ratioText ? (
				<HandText
					x={x + width}
					y={y + 2}
					anchor="end"
					size={13}
					color="pencil"
					variant="label"
				>
					{ratioText}
				</HandText>
			) : null}
		</g>
	);
}

// ---- Keys --------------------------------------------------------------------------------------

/**
 * A circled number inside a figure (a pen loop around a hand numeral), keyed to the same number in
 * the prose (CircledNumber in marks.tsx).
 */
export function CircledKey({
	x,
	y,
	value,
	seed,
	color = "red",
	r = 8,
}: {
	x: number;
	y: number;
	value: string | number;
	seed?: string;
	color?: CartoInk;
	r?: number;
}) {
	const loop = useMemo(
		() => sketchCircle([x, y], r, r * 0.92, hashSeed(seed ?? `key-${value}`)),
		[x, y, r, seed, value],
	);
	return (
		<g>
			<PenPath
				d={loop}
				seed={`${seed ?? value}-loop`}
				color={color}
				width={1.2}
				blob={false}
			/>
			<text
				x={x}
				y={y + r * 0.42}
				textAnchor="middle"
				className="nb-num"
				fontSize={r * 1.25}
				style={{ fill: paint(color) }}
			>
				{value}
			</text>
		</g>
	);
}
