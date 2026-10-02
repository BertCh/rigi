// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Hand marks for prose and two drawing layers for figures (sketch-style.md §3–4): what a pen does to
// a page of notes after the words are written. Everything is seeded, so server and client agree.
//
// Usage:
//
// | Export        | Where | Use                                                                     |
// | ------------- | ----- | ----------------------------------------------------------------------- |
// | HandMark      | HTML  | <HandMark type="underline">term</HandMark>: underline = term, double =  |
// |               |       | result, wavy = doubt, circle = keyword, box = conclusion, strike = a    |
// |               |       | wrong guess (correction beside it in red), highlight = the one sentence |
// |               |       | to read, bracket = a passage in the margin. A CSS fallback shows on the |
// |               |       | server and first paint; the sketched SVG replaces it once measured.     |
// | CircledNumber | HTML  | ① inline in a sentence, keyed to CircledKey in a figure                 |
// | Wash          | SVG   | a watercolour wash under a shape: stacked deformed polygons (no filter) |
// |               |       | at low opacity, multiply, a few px off register. method="filter" uses   |
// |               |       | #nb-wash instead (costly; ≤ 3 per page)                                 |
// | PencilLayer   | SVG   | <g> of construction lines: #nb-pencil filter, ink remapped to pencil,   |
// |               |       | opacity 0.5. Never put text or photos inside                            |
// | washPolygons  | –     | the Wash geometry (for bakers and checks)                               |

import {
	type CSSProperties,
	type ReactNode,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { PenPath } from "./carto";
import { type InkColor, inkColor } from "./Ink";
import {
	createRandom,
	hashSeed,
	type Point,
	sketchCircle,
	sketchLine,
} from "./sketch";
import { pathRings, sketchRect } from "./sketchify";

type MarkInk = InkColor | (string & {});
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
const paint = (color: MarkInk) =>
	INK_NAMES.has(color) ? inkColor(color as InkColor) : color;
const f = (value: number) => (Number.isFinite(value) ? value.toFixed(2) : "0");

export type HandMarkType =
	| "underline"
	| "double"
	| "wavy"
	| "circle"
	| "box"
	| "strike"
	| "highlight"
	| "bracket";

interface LineBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** Shapes drawn per line box (local coordinates, origin at the line box's top-left). */
function markShapes(
	type: HandMarkType,
	box: LineBox,
	seed: number,
	isFirst: boolean,
	isLast: boolean,
): { pen: string[]; plain: string; band: string } {
	const { width: w, height: h } = box;
	const pen: string[] = [];
	let plain = "";
	let band = "";
	const pad = 3;
	switch (type) {
		case "underline":
			pen.push(sketchLine([-1, h - 1], [w + 1, h - 0.2], seed, { bow: 1.4 }));
			break;
		case "double":
			pen.push(sketchLine([-1, h - 1.5], [w + 1, h - 0.8], seed));
			pen.push(sketchLine([w * 0.06, h + 1.6], [w * 0.92, h + 2.2], seed + 3));
			break;
		case "wavy": {
			const random = createRandom(seed);
			const wave = 6;
			let d = `M0 ${f(h)}`;
			for (let x = 0; x < w; x += wave / 2) {
				const up = (x / (wave / 2)) % 2 === 0 ? -1 : 1;
				d += `Q${f(x + wave / 4)} ${f(h + up * (1.6 + (random() - 0.5) * 0.5))} ${f(Math.min(w, x + wave / 2))} ${f(h)}`;
			}
			plain = d;
			break;
		}
		case "circle":
			pen.push(
				sketchCircle([w / 2, h / 2], w / 2 + pad + 2, h / 2 + pad, seed),
			);
			break;
		case "box": {
			const [first, second] = sketchRect(
				isFirst ? -pad : 0,
				-pad + 1,
				w + (isFirst ? pad : 0) + (isLast ? pad : 0),
				h + pad * 2 - 2,
				seed,
				{ overshoot: 2.4, tolerance: 1 },
			);
			pen.push(first, second);
			break;
		}
		case "strike":
			pen.push(
				sketchLine([-2, h * 0.58], [w + 2, h * 0.52], seed, { bow: 0.8 }),
			);
			break;
		case "highlight": {
			const random = createRandom(seed);
			const top = h * 0.32 + (random() - 0.5) * 1.5;
			const bottom = h * 0.92 + (random() - 0.5) * 1.5;
			band = `M${f(-2 + random() * 2)} ${f(top + 1)}L${f(w + 1 + random() * 2)} ${f(top - 0.5)}L${f(w + random() * 2)} ${f(bottom)}L${f(-1 + random() * 2)} ${f(bottom + 0.8)}Z`;
			break;
		}
		case "bracket":
			break;
	}
	return { pen, plain, band };
}

const DEFAULT_COLOR: Record<HandMarkType, MarkInk> = {
	underline: "red",
	double: "red",
	wavy: "red",
	circle: "red",
	box: "ink",
	strike: "red",
	highlight: "var(--nb-highlight)",
	bracket: "red",
};

/** True when draw-on animation is welcome: not under reduced motion and not under automation. */
const motionAllowed = () =>
	typeof window !== "undefined" &&
	!(typeof navigator !== "undefined" && navigator.webdriver) &&
	!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * A hand mark on running text. The span keeps a CSS fallback (classes .nb-hm-*) until it has
 * measured its line boxes with getClientRects(); then one sketched SVG is drawn per line (the
 * bracket spans all lines in the left margin). It re-measures when the parent block resizes and
 * when web fonts finish loading. A short wipe-in plays once, never under reduced motion or
 * webdriver.
 */
export function HandMark({
	type,
	color,
	seed,
	children,
	className,
}: {
	type: HandMarkType;
	color?: MarkInk;
	seed?: string;
	children: ReactNode;
	className?: string;
}) {
	const id = useId();
	const ref = useRef<HTMLSpanElement>(null);
	const [boxes, setBoxes] = useState<LineBox[] | null>(null);
	const [animate, setAnimate] = useState(false);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		setAnimate(motionAllowed());
		const measure = () => {
			const rects = Array.from(element.getClientRects()).filter(
				(rect) => rect.width > 0.5,
			);
			if (!rects.length) return;
			// An inline's absolutely positioned children are placed against its first line box.
			const origin = element.getClientRects()[0];
			const next = rects.map((rect) => ({
				left: rect.left - origin.left,
				top: rect.top - origin.top,
				width: rect.width,
				height: rect.height,
			}));
			setBoxes((previous) =>
				previous &&
				previous.length === next.length &&
				previous.every(
					(box, i) =>
						Math.abs(box.left - next[i].left) < 0.5 &&
						Math.abs(box.top - next[i].top) < 0.5 &&
						Math.abs(box.width - next[i].width) < 0.5 &&
						Math.abs(box.height - next[i].height) < 0.5,
				)
					? previous
					: next,
			);
		};
		measure();
		// Inline boxes do not report to ResizeObserver; watch the block that wraps them.
		const block = element.parentElement;
		const observer =
			typeof ResizeObserver !== "undefined" && block
				? new ResizeObserver(measure)
				: null;
		if (observer && block) observer.observe(block);
		let alive = true;
		document.fonts?.ready.then(() => {
			if (alive) measure();
		});
		return () => {
			alive = false;
			observer?.disconnect();
		};
	}, []);
	const baseSeed = hashSeed(seed ?? `${type}-${id}`);
	const ink = paint(color ?? DEFAULT_COLOR[type]);
	const shapes = useMemo(
		() =>
			boxes?.map((box, index) =>
				markShapes(
					type,
					box,
					baseSeed + index * 17,
					index === 0,
					index === boxes.length - 1,
				),
			) ?? null,
		[boxes, type, baseSeed],
	);
	const bracket = useMemo(() => {
		if (type !== "bracket" || !boxes?.length) return null;
		const left = Math.min(...boxes.map((box) => box.left)) - 8;
		const top = Math.min(...boxes.map((box) => box.top));
		const bottom = Math.max(...boxes.map((box) => box.top + box.height));
		return {
			left,
			top,
			height: bottom - top,
			d: [
				sketchLine([5, 1], [0.5, 1.6], baseSeed, { overshoot: 0.6 }),
				sketchLine([0.5, 1], [0.8, bottom - top - 1], baseSeed + 1, {
					overshoot: 0.6,
				}),
				sketchLine(
					[0.6, bottom - top - 1],
					[5, bottom - top - 1.4],
					baseSeed + 2,
					{
						overshoot: 0.6,
					},
				),
			].join(""),
		};
	}, [type, boxes, baseSeed]);
	const drawn = Boolean(boxes);
	const overlayClass = `nb-hm-svg${animate ? " nb-hm-anim" : ""}`;
	return (
		<span
			ref={ref}
			className={`nb-hm nb-hm-${type}${drawn ? " nb-hm-on" : ""} ${className ?? ""}`}
			style={{ "--nb-hm-ink": ink } as CSSProperties}
		>
			{children}
			{shapes?.map((shape, index) => {
				const box = (boxes as LineBox[])[index];
				return (
					<svg
						// biome-ignore lint/suspicious/noArrayIndexKey: one overlay per measured line box
						key={index}
						className={overlayClass}
						aria-hidden="true"
						focusable="false"
						width={box.width}
						height={box.height}
						viewBox={`0 0 ${f(box.width)} ${f(box.height)}`}
						style={{
							left: box.left,
							top: box.top,
							mixBlendMode: type === "highlight" ? "multiply" : undefined,
						}}
					>
						{shape.band ? <path d={shape.band} style={{ fill: ink }} /> : null}
						{shape.plain ? (
							<path
								d={shape.plain}
								fill="none"
								style={{ stroke: ink }}
								strokeWidth={1}
								strokeLinecap="round"
							/>
						) : null}
						{shape.pen.map((d, k) => (
							<PenPath
								// biome-ignore lint/suspicious/noArrayIndexKey: fixed pen passes
								key={k}
								d={d}
								seed={`${baseSeed}-${index}-${k}`}
								color={ink}
								width={
									type === "strike"
										? 1.5
										: type === "box"
											? k
												? 0.8
												: 1.1
											: k
												? 1.1
												: 1.6
								}
								opacity={type === "box" && k ? 0.6 : undefined}
								blob={type !== "box"}
								className=""
							/>
						))}
					</svg>
				);
			})}
			{bracket ? (
				<svg
					className={overlayClass}
					aria-hidden="true"
					focusable="false"
					width={6}
					height={bracket.height}
					viewBox={`0 0 6 ${f(bracket.height)}`}
					style={{ left: bracket.left, top: bracket.top }}
				>
					<PenPath
						d={bracket.d}
						seed={`${baseSeed}-bracket`}
						color={ink}
						width={1.4}
						className=""
					/>
				</svg>
			) : null}
		</span>
	);
}

/** ① inline in prose: a small pen loop around a hand numeral, sized to the text (1.35 em). */
export function CircledNumber({
	value,
	color = "red",
	seed,
}: {
	value: string | number;
	color?: MarkInk;
	seed?: string;
}) {
	const loop = useMemo(
		() => sketchCircle([12, 12], 9.5, 9, hashSeed(seed ?? `circled-${value}`)),
		[seed, value],
	);
	const ink = paint(color);
	return (
		<span
			className="nb-circled"
			style={{ color: ink }}
			aria-label={`(${value})`}
			role="img"
		>
			<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
				<PenPath
					d={loop}
					seed={`circled-${seed ?? value}`}
					color={ink}
					width={1.4}
					blob={false}
					className=""
				/>
			</svg>
			<span aria-hidden="true" className="nb-num">
				{value}
			</span>
		</span>
	);
}

// ---- Wash -------------------------------------------------------------------------------------

/** One round of midpoint displacement: each edge gets a new vertex pushed sideways (Hobbs). */
function deform(
	ring: Point[],
	random: () => number,
	variance: number,
): Point[] {
	const out: Point[] = [];
	for (let i = 0; i < ring.length; i++) {
		const a = ring[i];
		const b = ring[(i + 1) % ring.length];
		out.push(a);
		const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
		// Roughly Gaussian (sum of three uniforms) along the edge normal and a little along it.
		const g = (random() + random() + random() - 1.5) / 1.5;
		const along = 0.5 + (random() - 0.5) * 0.3;
		const nx = -(b[1] - a[1]) / (length || 1);
		const ny = (b[0] - a[0]) / (length || 1);
		const push = g * length * variance;
		out.push([
			a[0] + (b[0] - a[0]) * along + nx * push,
			a[1] + (b[1] - a[1]) * along + ny * push,
		]);
	}
	return out;
}

/** Thin a ring so long input shapes stay cheap (keeps every `step`-th vertex). */
const thinRing = (ring: Point[], limit: number) => {
	if (ring.length <= limit) return ring;
	const step = ring.length / limit;
	return Array.from(
		{ length: limit },
		(_, i) => ring[Math.floor(i * step)] as Point,
	);
};

/**
 * Watercolour wash geometry after Tyler Hobbs: the shape (spread `spread` px outward) is deformed
 * twice into a base, then each layer is deformed three more times from the base. Returns one path
 * per layer; draw them at low opacity, stacked.
 */
export function washPolygons(
	d: string,
	seed: string,
	{ layers = 10, spread = 3 }: { layers?: number; spread?: number } = {},
): string[] {
	const rings = pathRings(d).filter((ring) => ring.length >= 3);
	if (!rings.length) return [];
	const random = createRandom(hashSeed(seed));
	const bases = rings.map((source) => {
		const ring = thinRing(source, 32);
		const cx = ring.reduce((sum, [x]) => sum + x, 0) / ring.length;
		const cy = ring.reduce((sum, [, y]) => sum + y, 0) / ring.length;
		const grown = ring.map(([x, y]): Point => {
			const dx = x - cx;
			const dy = y - cy;
			const length = Math.hypot(dx, dy) || 1;
			return [x + (dx / length) * spread, y + (dy / length) * spread];
		});
		let base = deform(grown, random, 0.12);
		base = deform(base, random, 0.08);
		return base;
	});
	const out: string[] = [];
	for (let layer = 0; layer < layers; layer++) {
		let path = "";
		for (const base of bases) {
			let ring = deform(base, random, 0.1);
			ring = deform(ring, random, 0.07);
			ring = deform(ring, random, 0.05);
			path += `${ring.map(([x, y], i) => `${i ? "L" : "M"}${f(x)} ${f(y)}`).join("")}Z`;
		}
		out.push(path);
	}
	return out;
}

/**
 * A watercolour wash under a shape `d` (SVG): stacked deformed polygons at low opacity (no filter,
 * SSR-stable), multiply blend so ink shows through, drawn 2–4 px off register (`offset`). Washes
 * mean an area (water, glacier, a region of doubt); never over photos or DEM rasters.
 */
export function Wash({
	d,
	color = "blue",
	seed,
	offset,
	layers = 10,
	opacity = 0.07,
	spread = 3,
	method = "layers",
}: {
	d: string;
	color?: MarkInk;
	seed: string;
	/** Off-register shift in px; default a seeded 2–4 px. */
	offset?: Point;
	layers?: number;
	/** Opacity per layer. */
	opacity?: number;
	spread?: number;
	/** "filter" uses #nb-wash from SketchDefs (heavier; keep ≤ 3 per page). */
	method?: "layers" | "filter";
}) {
	const paths = useMemo(
		() =>
			method === "layers" ? washPolygons(d, seed, { layers, spread }) : [],
		[d, seed, layers, spread, method],
	);
	const shift = useMemo((): Point => {
		if (offset) return offset;
		const random = createRandom(hashSeed(`${seed}-register`));
		const distance = 2 + random() * 2;
		const angle = random() * Math.PI * 2;
		return [Math.cos(angle) * distance, Math.sin(angle) * distance];
	}, [offset, seed]);
	const ink = paint(color);
	return (
		<g
			transform={`translate(${f(shift[0])} ${f(shift[1])})`}
			style={{ mixBlendMode: "multiply", fill: ink }}
		>
			{method === "filter" ? (
				<path d={d} filter="url(#nb-wash)" />
			) : (
				paths.map((path, index) => (
					<path
						// biome-ignore lint/suspicious/noArrayIndexKey: layers are a fixed stack
						key={index}
						d={path}
						fillOpacity={opacity}
					/>
				))
			)}
		</g>
	);
}

/**
 * The pencil construction layer under the ink (SVG <g>): the #nb-pencil graphite filter, the ink
 * token remapped to pencil (so children drawn in "ink" come out graphite), opacity 0.5. Put guide
 * lines, rays, grid ticks and layout boxes here; never text, photos or rasters (the filter would
 * break them up), and not measured data.
 */
export function PencilLayer({
	children,
	opacity = 0.5,
	filter = true,
	className,
}: {
	children: ReactNode;
	opacity?: number;
	/** Off for very large layers (the filter rasterises its subtree). */
	filter?: boolean;
	className?: string;
}) {
	return (
		<g
			className={className}
			opacity={opacity}
			filter={filter ? "url(#nb-pencil)" : undefined}
			style={{ "--nb-ink": "var(--nb-pencil)" } as CSSProperties}
		>
			{children}
		</g>
	);
}
