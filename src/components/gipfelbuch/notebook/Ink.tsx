// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type CSSProperties, type ReactNode, useMemo } from "react";
import {
	createRandom,
	flattenStroke,
	hashSeed,
	inkBlob,
	type Point,
	sketchArrow,
	sketchCircle,
	sketchLine,
	taperedOutline,
} from "./sketch";
import {
	hachureFill,
	pathRings,
	screeFill,
	seedOf,
	sketchify,
	sketchPolyline,
	sketchRect,
} from "./sketchify";

// SVG pen strokes for notebook figures. Every primitive is keyed by a string seed so the drawing is
// stable between renders. `delay` staggers the draw-on (see .nb-draw in notebook.css).

export type InkColor =
	| "ink"
	| "pencil"
	| "red"
	| "blue"
	| "brown"
	| "faint"
	| "forest"
	| "navy";
const COLOR: Record<InkColor, string> = {
	ink: "var(--nb-ink)",
	pencil: "var(--nb-pencil)",
	red: "var(--nb-red)",
	blue: "var(--nb-blue)",
	brown: "var(--nb-brown)",
	faint: "var(--nb-faint)",
	forest: "var(--nb-forest)",
	navy: "var(--nb-navy)",
};
export const inkColor = (color: InkColor) => COLOR[color];
type InkStroke = InkColor | (string & {});
/** A named ink or any CSS colour. */
const strokeColor = (color: InkStroke) =>
	color in COLOR ? COLOR[color as InkColor] : color;
/** Caveat (x-height 0.40 em) is the hand; sizes are given in hand units. */
const HAND_SCALE = 1.0;
/** Printed numerals sit a little smaller than the hand so digits read as type, not lettering. */
const PRINT_SCALE = 0.8;

interface StrokeProps {
	seed: string;
	/** A measured mark: one constant-width pen pass that stays within DATA_TOLERANCE px of the data. */
	data?: boolean;
	color?: InkColor | (string & {});
	opacity?: number;
	width?: number;
	delay?: number;
	dash?: string;
}

const drawStyle = (delay = 0) =>
	({ "--nb-delay": `${delay}ms` }) as CSSProperties;

function Stroke({
	d,
	color = "ink",
	opacity,
	width = 1.4,
	delay,
	dash,
}: { d: string } & Omit<StrokeProps, "seed">) {
	// Meaning-bearing lines (width >= 1.2) never average below 1.2 px: taperedOutline's
	// width profile and end tapers average about 0.82 of the requested width, so compensate.
	const mean = width >= 1.2 ? Math.max(width, 1.2) / 0.82 : width;
	const ink = useMemo(() => {
		if (dash) return null;
		const seed = hashSeed(d);
		let outline = "";
		let blobs = "";
		flattenStroke(d).forEach((points, index) => {
			outline += taperedOutline(points, seed + index, { width: mean });
			blobs += inkBlob(points[0], mean, seed + index + 101);
		});
		return { outline, blobs };
	}, [d, dash, mean]);
	if (!ink)
		return (
			<path
				d={d}
				style={drawStyle(delay)}
				fill="none"
				stroke={strokeColor(color)}
				strokeOpacity={opacity}
				strokeWidth={width}
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeDasharray={dash}
			/>
		);
	return (
		<g className="nb-fade" style={drawStyle(delay)}>
			<path d={ink.outline} fill={strokeColor(color)} fillOpacity={opacity} />
			<path
				d={ink.blobs}
				fill={strokeColor(color)}
				fillOpacity={(opacity ?? 1) * 0.9}
			/>
		</g>
	);
}

export function PenLine({
	from,
	to,
	data,
	...props
}: StrokeProps & { from: Point; to: Point }) {
	if (data)
		return (
			<ExactStroke d={`M${from[0]} ${from[1]}L${to[0]} ${to[1]}`} {...props} />
		);
	return <Stroke d={sketchLine(from, to, hashSeed(props.seed))} {...props} />;
}

/**
 * Hand pass (reports/gipfelbuch.md): a measured mark is drawn by hand too,
 * but with one pen pass whose sideways jitter is bounded by this many px, so it stays on its
 * measured pixels (notebook.check.ts tests the bound). Width stays constant (L2).
 */
export const DATA_TOLERANCE = 0.5;

/** A measured mark: one constant-width pen pass within DATA_TOLERANCE of the path. */
function ExactStroke({
	d,
	color = "ink",
	opacity,
	width = 1.4,
	dash,
}: { d: string } & Omit<StrokeProps, "seed" | "data">) {
	const pen = useMemo(
		() =>
			sketchify(d, hashSeed(d), { tolerance: DATA_TOLERANCE, passes: 1 })[0] ||
			d,
		[d],
	);
	return (
		<path
			d={pen}
			fill="none"
			style={{ stroke: strokeColor(color) }}
			strokeOpacity={opacity}
			strokeWidth={Math.max(width, 1.2)}
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeDasharray={dash}
		/>
	);
}

export function PenArrow({
	from,
	to,
	bend = 0.18,
	head = 7,
	...props
}: StrokeProps & { from: Point; to: Point; bend?: number; head?: number }) {
	const arrow = sketchArrow(from, to, hashSeed(props.seed), { bend, head });
	return (
		<g>
			<Stroke d={arrow.shaft} {...props} />
			<Stroke
				d={arrow.head}
				{...props}
				delay={(props.delay ?? 0) + 600}
				dash={undefined}
			/>
		</g>
	);
}

export function PenCircle({
	center,
	radiusX,
	radiusY = radiusX,
	data,
	...props
}: StrokeProps & { center: Point; radiusX: number; radiusY?: number }) {
	if (data) {
		const [cx, cy] = center;
		return (
			<ExactStroke
				d={`M${cx - radiusX} ${cy}a${radiusX} ${radiusY} 0 1 0 ${2 * radiusX} 0a${radiusX} ${radiusY} 0 1 0 ${-2 * radiusX} 0Z`}
				{...props}
			/>
		);
	}
	return (
		<Stroke
			d={sketchCircle(center, radiusX, radiusY, hashSeed(props.seed))}
			{...props}
		/>
	);
}

/** Two short strokes across a value that turned out wrong. */
export function PenCross({
	center,
	size = 7,
	...props
}: StrokeProps & { center: Point; size?: number }) {
	const [x, y] = center;
	const seed = hashSeed(props.seed);
	return (
		<g>
			<Stroke
				d={sketchLine([x - size, y - size], [x + size, y + size], seed)}
				{...props}
			/>
			<Stroke
				d={sketchLine([x + size, y - size], [x - size, y + size], seed + 7)}
				{...props}
				delay={(props.delay ?? 0) + 200}
			/>
		</g>
	);
}

/** A dimension line with end ticks, the way a surveyor marks a measured gap. */
export function PenDimension({
	from,
	to,
	tick = 4,
	...props
}: StrokeProps & { from: Point; to: Point; tick?: number }) {
	const [x1, y1] = from;
	const [x2, y2] = to;
	const length = Math.hypot(x2 - x1, y2 - y1) || 1;
	const nx = (-(y2 - y1) / length) * tick;
	const ny = ((x2 - x1) / length) * tick;
	const seed = hashSeed(props.seed);
	return (
		<g>
			<Stroke d={sketchLine(from, to, seed, { overshoot: 0 })} {...props} />
			<Stroke
				d={`M${x1 - nx} ${y1 - ny}L${x1 + nx} ${y1 + ny}M${x2 - nx} ${y2 - ny}L${x2 + nx} ${y2 + ny}`}
				{...props}
			/>
		</g>
	);
}

/**
 * Split text into numeric runs (printed) and the words around them (hand-lettered): hand-drawn
 * numerals lower perceived credibility (Song et al., VIS 2025), so digits are set in print.
 */
export function splitPrintRuns(
	text: string,
): { text: string; print: boolean }[] {
	const runs: { text: string; print: boolean }[] = [];
	const push = (value: string, print: boolean) => {
		if (!value) return;
		const last = runs[runs.length - 1];
		if (last && last.print === print) last.text += value;
		else runs.push({ text: value, print });
	};
	let cursor = 0;
	for (const match of text.matchAll(PRINT_RUN)) {
		// Trailing space and sentence punctuation belong to the words, not the number.
		const run = match[0].replace(/[\s.,:'’]+$/u, "");
		const start = match.index ?? 0;
		push(text.slice(cursor, start), false);
		push(run, true);
		cursor = start + run.length;
	}
	push(text.slice(cursor), false);
	return runs;
}

/** Hand notes lean at most 4 degrees (hand pass; labels stay upright). */
const MAX_HAND_TILT = 4;

const PRINT_RUN =
	/(?<![A-Za-z\d])(?:[-−+±≥≤<>~≈]\s?)?\d[\d.,:'’\u00a0\u202f ]*\d?\s?(?:°|%|px|km|mm|ms|m|s|×)?(?![A-Za-z])/gu;

type HandChild = string | number;
const isHandChild = (child: ReactNode): child is HandChild =>
	typeof child === "string" || typeof child === "number";

/** Handwritten SVG text with a paper halo so it stays legible over photos and hachures. */
export function HandText({
	x,
	y,
	children,
	color = "ink",
	size = 17,
	anchor = "start",
	halo = true,
	rotate = 0,
	variant,
}: {
	x: number;
	y: number;
	children: ReactNode;
	color?: InkStroke;
	size?: number;
	anchor?: "start" | "middle" | "end";
	halo?: boolean;
	rotate?: number;
	/** "note" is the Caveat hand; "label" the small Shantell Sans style (default below 15). */
	variant?: "note" | "label";
}) {
	const style = variant ?? (size < 15 ? "label" : "note");
	const parts: ReactNode[] | null = isHandChild(children)
		? [children]
		: Array.isArray(children) && children.every(isHandChild)
			? children
			: null;
	const content = parts
		? parts.flatMap((part, partIndex) =>
				splitPrintRuns(String(part)).map((run, runIndex) =>
					run.print ? (
						<tspan
							// biome-ignore lint/suspicious/noArrayIndexKey: runs are a fixed split of static text
							key={`${partIndex}-${runIndex}`}
							className="nb-num"
							fontSize={size * HAND_SCALE * PRINT_SCALE}
						>
							{run.text}
						</tspan>
					) : (
						run.text
					),
				),
			)
		: children;
	return (
		<text
			x={x}
			y={y}
			className={style === "label" ? "nb-hand nb-hand-small" : "nb-hand"}
			fontSize={size * HAND_SCALE}
			textAnchor={anchor}
			fill={strokeColor(color)}
			stroke={halo ? "var(--nb-paper)" : undefined}
			strokeWidth={halo ? 3.5 : undefined}
			strokeLinejoin="round"
			paintOrder="stroke"
			transform={
				rotate
					? `rotate(${Math.max(-MAX_HAND_TILT, Math.min(MAX_HAND_TILT, rotate))} ${x} ${y})`
					: undefined
			}
		>
			{content}
		</text>
	);
}

/** A circled step number, drawn as a pen loop around a numeral (HTML, inline with text). */
export function StepNumber({
	value,
	color = "red",
}: {
	value: string;
	color?: InkStroke;
}) {
	return (
		<span
			className="relative inline-flex size-9 shrink-0 items-center justify-center"
			aria-hidden
		>
			<svg
				viewBox="0 0 36 36"
				className="absolute inset-0 overflow-visible"
				aria-hidden="true"
			>
				<Stroke
					d={sketchCircle([18, 18], 13.5, 12.5, hashSeed(`step-${value}`))}
					color={color}
					width={1.5}
				/>
			</svg>
			<span
				className="nb-hand relative text-[18px] leading-none"
				style={{ color: strokeColor(color) }}
			>
				{value}
			</span>
		</span>
	);
}

// ---- Sketched geometry (see sketchify.ts) -----------------------------------------------------

interface SketchStrokeProps {
	/** Stable key for the jitter (an id, not an index that can shift). */
	seed: string | number;
	color?: InkStroke;
	width?: number;
	opacity?: number;
	dash?: string;
	tolerance?: number;
	passes?: 1 | 2;
	/** Draw-on animation when the entry arms it (notebook.css). */
	draw?: boolean;
	delay?: number;
	className?: string;
}

function Passes({
	strokes,
	color = "ink",
	width = 1.4,
	opacity = 1,
	dash,
	draw = false,
	delay,
	className,
}: { strokes: string[] } & Omit<SketchStrokeProps, "seed">) {
	return (
		<g
			className={className}
			fill="none"
			// KR7: through style, so a var() or color-mix() colour resolves in every engine
			style={{ stroke: strokeColor(color) }}
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeDasharray={dash}
		>
			{strokes.map((d, index) => (
				<path
					// biome-ignore lint/suspicious/noArrayIndexKey: pen passes are a fixed, ordered pair
					key={index}
					d={d}
					// L2: a meaningful line (>= 1.2) keeps >= 1.2 on its second pass.
					strokeWidth={
						index === 0 ? width : Math.max(width * 0.7, Math.min(width, 1.2))
					}
					strokeOpacity={index === 0 ? opacity : opacity * 0.55}
					pathLength={draw && !dash ? 1 : undefined}
					className={draw && !dash ? "nb-draw" : undefined}
					style={draw ? drawStyle(delay) : undefined}
				/>
			))}
		</g>
	);
}

/**
 * Any SVG path `d`, redrawn by hand (two pen passes, bounded jitter). The double stroke is for
 * furniture (L6); pass `data` for a measured line so it gets one constant-width pass.
 */
export function SketchPath({
	d,
	seed,
	tolerance,
	passes,
	data,
	...props
}: SketchStrokeProps & { d: string; data?: boolean }) {
	// A measured line is one pen pass within DATA_TOLERANCE (constant width); furniture gets two.
	const strokes = useMemo(
		() =>
			data
				? sketchify(d, seed, { tolerance: DATA_TOLERANCE, passes: 1 })
				: sketchify(d, seed, { tolerance, passes }),
		[d, seed, tolerance, passes, data],
	);
	return <Passes strokes={strokes} {...props} />;
}

/** The exact path through `points`, for a measured series (L1). */
export const exactPolyline = (points: Point[], closed?: boolean) =>
	`${points.map((point, i) => `${i ? "L" : "M"}${point[0].toFixed(2)} ${point[1].toFixed(2)}`).join("")}${closed ? "Z" : ""}`;

/** A measured series as points, redrawn by hand within `tolerance` px (default 0.9); `data` draws one pass within DATA_TOLERANCE. */
export function SketchPolyline({
	points,
	seed,
	tolerance,
	passes,
	closed,
	data,
	...props
}: SketchStrokeProps & { points: Point[]; closed?: boolean; data?: boolean }) {
	const used = passes ?? (points.length > 400 ? 1 : 2);
	const strokes = useMemo(
		() =>
			data
				? sketchPolyline(points, seed, {
						tolerance: DATA_TOLERANCE,
						passes: 1,
						closed,
					})
				: sketchPolyline(points, seed, { tolerance, passes: used, closed }),
		[points, seed, tolerance, used, closed, data],
	);
	return <Passes strokes={strokes} {...props} />;
}

/** Pen-ruled rectangle. Prefer no box at all; use this only where a frame carries meaning. */
export function SketchRect({
	x,
	y,
	width: rectWidth,
	height,
	seed,
	tolerance,
	passes,
	penWidth,
	...props
}: SketchStrokeProps & {
	x: number;
	y: number;
	/** Rectangle width (the pen width is `penWidth`). */
	width: number;
	height: number;
	penWidth?: number;
}) {
	const strokes = useMemo(
		() => sketchRect(x, y, rectWidth, height, seed, { tolerance, passes }),
		[x, y, rectWidth, height, seed, tolerance, passes],
	);
	return <Passes strokes={strokes} {...props} width={penWidth} />;
}

/** Hachure fill for a shape given as a path `d` (replaces flat fills). Draw an outline separately if needed. */
export function Hachure({
	d,
	seed,
	color = "brown",
	width = 0.8,
	opacity = 0.7,
	angle = -45,
	gap = 4,
	inset,
}: {
	d: string;
	seed: string | number;
	color?: InkStroke;
	width?: number;
	opacity?: number;
	angle?: number;
	gap?: number;
	/** Indication: keep only hachure within this many px of the edge (after Winkenbach and Salesin). */
	inset?: number;
}) {
	const lines = useMemo(
		() => hachureFill(pathRings(d), seed, { angle, gap, indication: inset }),
		[d, seed, angle, gap, inset],
	);
	return (
		<path
			d={lines}
			fill="none"
			stroke={strokeColor(color)}
			strokeWidth={width}
			strokeOpacity={opacity}
			strokeLinecap="round"
		/>
	);
}

/** Scree fill for uncertain or "assumed" areas: small angular stones, coarser toward the foot. */
export function Stipple({
	d,
	seed,
	color = "pencil",
	size = 1.6,
	opacity = 0.8,
	spacing = 6,
}: {
	d: string;
	seed: string | number;
	color?: InkStroke;
	/** Stone size relative to the default of 1.6. */
	size?: number;
	opacity?: number;
	spacing?: number;
}) {
	const stones = useMemo(
		() => screeFill(pathRings(d), seed, { spacing, scale: size / 1.6 }).d,
		[d, seed, spacing, size],
	);
	return <path d={stones} fill={strokeColor(color)} fillOpacity={opacity} />;
}

/** A hand dot for scatter points (slightly irregular, never a perfect circle). */
export function HandDot({
	x,
	y,
	r = 2.4,
	seed,
	color = "ink",
	opacity = 0.9,
	data,
}: {
	x: number;
	y: number;
	r?: number;
	seed: string | number;
	color?: InkStroke;
	opacity?: number;
	/** A measured point: a hand dot centred exactly on (x, y) whose edge wavers by under 6 %. */
	data?: boolean;
}) {
	const d = useMemo(() => {
		const random = createRandom(seedOf(seed));
		const sides = data ? 10 : 7;
		const points: Point[] = Array.from({ length: sides }, (_, i) => {
			const angle = (i / sides) * Math.PI * 2;
			const radius = data
				? r * (0.94 + random() * 0.12)
				: r * (0.82 + random() * 0.3);
			return [x + Math.cos(angle) * radius, y + Math.sin(angle) * radius];
		});
		return `${points.map((point, i) => `${i ? "L" : "M"}${point[0].toFixed(2)} ${point[1].toFixed(2)}`).join("")}Z`;
	}, [x, y, r, seed, data]);
	return (
		<path d={d} style={{ fill: strokeColor(color) }} fillOpacity={opacity} />
	);
}

/**
 * Filter definitions, rendered once per page. `filter: url(#nb-wobble)` gives a whole <g> a subtle
 * pencil wobble (≤1.2 px) without touching its geometry: use it on dense legacy line art, never on
 * text, photos or rasters. `#nb-grain` roughens stroke edges like graphite.
 */
export function SketchDefs() {
	return (
		<svg
			width="0"
			height="0"
			className="absolute"
			aria-hidden="true"
			focusable="false"
		>
			<defs>
				<filter id="nb-wobble" x="-2%" y="-2%" width="104%" height="104%">
					<feTurbulence
						type="fractalNoise"
						baseFrequency="0.035"
						numOctaves="2"
						seed="7"
						result="noise"
					/>
					<feDisplacementMap
						in="SourceGraphic"
						in2="noise"
						scale="2.4"
						xChannelSelector="R"
						yChannelSelector="G"
					/>
				</filter>
				<filter id="nb-grain" x="-2%" y="-2%" width="104%" height="104%">
					<feTurbulence
						type="fractalNoise"
						baseFrequency="0.9"
						numOctaves="1"
						seed="3"
						result="grain"
					/>
					<feColorMatrix
						in="grain"
						type="matrix"
						values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.4 1.25"
						result="mask"
					/>
					<feComposite
						in="SourceGraphic"
						in2="mask"
						operator="in"
						result="grained"
					/>
					<feTurbulence
						type="fractalNoise"
						baseFrequency="0.035"
						numOctaves="2"
						seed="11"
						result="noise"
					/>
					<feDisplacementMap
						in="grained"
						in2="noise"
						scale="2"
						xChannelSelector="R"
						yChannelSelector="G"
					/>
				</filter>
				{/* Pencil (graphite) layer for construction lines (PencilLayer in marks.tsx): high-frequency
				    displacement plus a grain mask breaks strokes into graphite fragments. Never on text. */}
				<filter id="nb-pencil" x="-2%" y="-2%" width="104%" height="104%">
					<feTurbulence
						type="fractalNoise"
						baseFrequency="0.6"
						numOctaves="1"
						seed="5"
						result="n"
					/>
					<feDisplacementMap
						in="SourceGraphic"
						in2="n"
						scale="2.2"
						xChannelSelector="R"
						yChannelSelector="G"
						result="d"
					/>
					<feTurbulence
						type="fractalNoise"
						baseFrequency="1.1"
						numOctaves="1"
						seed="9"
						result="g"
					/>
					<feColorMatrix
						in="g"
						type="matrix"
						values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.8 1.45"
						result="mask"
					/>
					<feComposite in="d" in2="mask" operator="in" />
				</filter>
				{/* Watercolour wash (Wash method="filter"): displaced fill, darker rim, paper tooth. Costly:
				    three turbulences; keep at most three on a page. The default Wash needs no filter. */}
				<filter
					id="nb-wash"
					x="-6%"
					y="-6%"
					width="112%"
					height="112%"
					colorInterpolationFilters="sRGB"
				>
					<feTurbulence
						type="fractalNoise"
						baseFrequency="0.018"
						numOctaves="3"
						seed="21"
						result="flow"
					/>
					<feDisplacementMap
						in="SourceGraphic"
						in2="flow"
						scale="10"
						xChannelSelector="R"
						yChannelSelector="G"
						result="shape"
					/>
					<feMorphology
						in="shape"
						operator="erode"
						radius="2.5"
						result="core"
					/>
					<feComposite in="shape" in2="core" operator="out" result="rim" />
					<feComponentTransfer in="rim" result="rimDark">
						<feFuncA type="linear" slope="0.55" />
					</feComponentTransfer>
					<feComponentTransfer in="shape" result="body">
						<feFuncA type="linear" slope="0.32" />
					</feComponentTransfer>
					<feTurbulence
						type="fractalNoise"
						baseFrequency="0.85"
						numOctaves="2"
						seed="4"
						result="paper"
					/>
					<feColorMatrix
						in="paper"
						type="matrix"
						values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -0.9 1.2"
						result="tooth"
					/>
					<feMerge result="pigment">
						<feMergeNode in="body" />
						<feMergeNode in="rimDark" />
					</feMerge>
					<feComposite in="pigment" in2="tooth" operator="in" />
				</filter>
			</defs>
		</svg>
	);
}

/** A pen rule that stretches across its container (a hand-drawn replacement for a border). */
export function PenRule({
	seed,
	color = "pencil",
	width = 1,
	opacity,
	className,
}: {
	seed: string;
	color?: InkStroke;
	width?: number;
	opacity?: number;
	className?: string;
}) {
	return (
		<svg
			viewBox="0 0 100 4"
			preserveAspectRatio="none"
			className={`block h-1 w-full overflow-visible [&_path]:[vector-effect:non-scaling-stroke] ${className ?? ""}`}
			aria-hidden="true"
		>
			<SketchPath
				d="M0 2L100 2"
				seed={seed}
				color={color}
				width={width}
				opacity={opacity}
				passes={1}
				tolerance={0.5}
			/>
		</svg>
	);
}
