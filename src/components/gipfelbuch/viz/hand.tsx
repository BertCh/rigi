// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { CSSProperties } from "react";
import { cn } from "#/lib/utils";
import { type InkColor, inkColor, SketchPath } from "../notebook/Ink";
import { createRandom, hashSeed, sketchCircle } from "../notebook/sketch";

// Hand marks for the HTML chrome of the viz kit (hand pass, reports/gipfelbuch-hand-sketch-2026-10-01.md):
// underlines, side rules, an overshooting box and a pen loop. Each is an absolutely positioned SVG
// stretched over its (positioned) parent with non-scaling strokes, so it needs no measuring and renders
// the same on the server. Stretching only lengthens the wobble along the line; jitter across it stays in
// px. Seeds are stable strings, so a mark never changes between renders.

type Ink = InkColor | (string & {});
const STRETCH = "[&_path]:[vector-effect:non-scaling-stroke]";
const colorOf = (color: Ink) =>
	color in INK_NAMES ? inkColor(color as InkColor) : color;
const INK_NAMES: Record<InkColor, true> = {
	ink: true,
	pencil: true,
	red: true,
	blue: true,
	brown: true,
	faint: true,
	forest: true,
	navy: true,
};

/** A stable number in [0, 1) for a string seed (and an optional salt). */
export const seedUnit = (seed: string, salt = 0) =>
	createRandom(hashSeed(seed) + salt)();

/** A sine wave from x0 to x1 along y (for a "doubt" or "trap" mark). */
const wave = (x0: number, x1: number, y: number, amp: number, step: number) => {
	let d = `M${x0} ${y}`;
	for (let x = x0 + step / 2, up = true; x <= x1; x += step / 2, up = !up)
		d += `Q${(x - step / 4).toFixed(1)} ${(y + (up ? -amp : amp)).toFixed(1)} ${x.toFixed(1)} ${y}`;
	return d;
};

/**
 * A marker underline under part of its parent's width (60–80 %, seeded): the heading device of a sketched
 * page. `double` adds a shorter second stroke (a result), `wavy` a wave (doubt, a trap).
 */
export function HandUnderline({
	seed,
	color = "red",
	width = 2.4,
	coverage,
	double = false,
	wavy = false,
	offset = 0,
	opacity = 0.85,
	className,
}: {
	seed: string;
	color?: Ink;
	width?: number;
	/** Fraction of the parent's width the stroke covers; default 0.6–0.8 from the seed. */
	coverage?: number;
	double?: boolean;
	wavy?: boolean;
	/** px below the parent's bottom edge. */
	offset?: number;
	opacity?: number;
	className?: string;
}) {
	const W = 300;
	const cover = coverage ?? 0.6 + 0.2 * seedUnit(seed);
	const x0 = seedUnit(seed, 3) * 0.04 * W;
	const x1 = Math.min(W - 1, x0 + cover * W);
	const rise = 0.6 + seedUnit(seed, 5) * 1.6;
	const d = wavy
		? wave(x0, x1, 5, 1.6, 9)
		: `M${x0.toFixed(1)} ${(5.6).toFixed(1)}L${x1.toFixed(1)} ${(5.6 - rise).toFixed(1)}`;
	return (
		<svg
			viewBox={`0 0 ${W} 12`}
			preserveAspectRatio="none"
			className={cn(
				"pointer-events-none absolute left-0 h-3 w-full overflow-visible",
				STRETCH,
				className,
			)}
			style={{ bottom: -6 - offset }}
			aria-hidden="true"
		>
			<SketchPath
				d={d}
				seed={`${seed}-u`}
				color={colorOf(color)}
				width={width}
				opacity={opacity}
				passes={wavy ? 1 : 2}
				tolerance={wavy ? 0.4 : 0.9}
			/>
			{double && (
				<SketchPath
					d={`M${(x0 + 0.08 * W).toFixed(1)} 10L${(x1 - 0.05 * W).toFixed(1)} ${(10 - rise * 0.6).toFixed(1)}`}
					seed={`${seed}-u2`}
					color={colorOf(color)}
					width={width * 0.7}
					opacity={opacity}
					passes={1}
					tolerance={0.8}
				/>
			)}
		</svg>
	);
}

/** A pen rule down the left edge of its parent (a note's margin mark); `wavy` for a trap. */
export function HandSideRule({
	seed,
	color = "ink",
	width = 1.8,
	wavy = false,
	dash,
	opacity,
	className,
}: {
	seed: string;
	color?: Ink;
	width?: number;
	wavy?: boolean;
	dash?: string;
	opacity?: number;
	className?: string;
}) {
	const H = 300;
	const d = wavy
		? // the wave runs down x, so build it along x and swap the axes
			wave(2, H - 2, 5, 2.4, 22).replace(
				/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g,
				(_, a, b) => `${b} ${a}`,
			)
		: `M5 0L5 ${H}`;
	return (
		<svg
			viewBox={`0 0 10 ${H}`}
			preserveAspectRatio="none"
			className={cn(
				"pointer-events-none absolute top-0 bottom-0 left-0 h-full w-2.5 overflow-visible",
				STRETCH,
				className,
			)}
			aria-hidden="true"
		>
			<SketchPath
				d={d}
				seed={`${seed}-side`}
				color={colorOf(color)}
				width={width}
				dash={dash}
				opacity={opacity}
				passes={wavy ? 1 : 2}
				tolerance={wavy ? 0.5 : 1.1}
			/>
		</svg>
	);
}

/**
 * A hand-ruled box around its parent: four separate pen strokes whose ends overshoot the corners by a
 * seeded few px, the way a box is drawn round a conclusion. Use it once per section at most.
 */
export function HandFrame({
	seed,
	color = "ink",
	width = 1.6,
	overshoot = 7,
	className,
}: {
	seed: string;
	color?: Ink;
	width?: number;
	/** How far the strokes run past the corners, px. */
	overshoot?: number;
	className?: string;
}) {
	const L = 300;
	const edge = (side: 0 | 1 | 2 | 3) => {
		const a = overshoot * (0.3 + seedUnit(seed, side * 4 + 1));
		const b = overshoot * (0.3 + seedUnit(seed, side * 4 + 2));
		// corners never meet exactly: each stroke sits a px or two off the box
		const shift = (seedUnit(seed, side * 4 + 3) - 0.5) * 3;
		const horizontal = side === 0 || side === 2;
		const style: CSSProperties = horizontal
			? {
					left: -a,
					right: -b,
					[side === 0 ? "top" : "bottom"]: -5 + shift,
				}
			: {
					top: -a,
					bottom: -b,
					[side === 3 ? "left" : "right"]: -5 + shift,
				};
		const tilt = (seedUnit(seed, side * 4 + 4) - 0.5) * 2.4;
		return (
			<svg
				key={side}
				viewBox={horizontal ? `0 0 ${L} 10` : `0 0 10 ${L}`}
				preserveAspectRatio="none"
				className={cn(
					"pointer-events-none absolute overflow-visible",
					horizontal ? "h-2.5" : "w-2.5",
					STRETCH,
				)}
				style={style}
				aria-hidden="true"
			>
				<SketchPath
					d={
						horizontal
							? `M0 ${(5 - tilt).toFixed(1)}L${L} ${(5 + tilt).toFixed(1)}`
							: `M${(5 - tilt).toFixed(1)} 0L${(5 + tilt).toFixed(1)} ${L}`
					}
					seed={`${seed}-edge${side}`}
					color={colorOf(color)}
					width={width}
					passes={2}
					tolerance={1.3}
				/>
			</svg>
		);
	};
	return (
		<span
			className={cn("pointer-events-none absolute inset-0", className)}
			aria-hidden="true"
		>
			{edge(0)}
			{edge(1)}
			{edge(2)}
			{edge(3)}
		</span>
	);
}

/** A pen loop round its parent (an active tab, a keyword): just over one turn, not closed. */
export function HandLoop({
	seed,
	color = "red",
	width = 1.6,
	inset = -4,
	className,
}: {
	seed: string;
	color?: Ink;
	width?: number;
	/** px the loop's box sits inside (+) or outside (−) the parent's edge. */
	inset?: number;
	className?: string;
}) {
	return (
		<svg
			viewBox="0 0 100 40"
			preserveAspectRatio="none"
			className={cn(
				"pointer-events-none absolute overflow-visible",
				STRETCH,
				className,
			)}
			// an absolute svg keeps its viewBox ratio under `inset` alone, so both sides are sized
			style={{
				left: inset,
				top: inset,
				width: `calc(100% - ${2 * inset}px)`,
				height: `calc(100% - ${2 * inset}px)`,
			}}
			aria-hidden="true"
		>
			<path
				d={sketchCircle([50, 20], 49, 19, hashSeed(`${seed}-loop`))}
				fill="none"
				style={{ stroke: colorOf(color) }}
				strokeWidth={width}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** A short pen strike across its parent (a struck word, a switched-off layer). */
export function HandStrike({
	seed,
	color = "red",
	width = 1.5,
	className,
}: {
	seed: string;
	color?: Ink;
	width?: number;
	className?: string;
}) {
	const rise = (seedUnit(seed) - 0.5) * 3;
	return (
		<svg
			viewBox="0 0 100 10"
			preserveAspectRatio="none"
			className={cn(
				"pointer-events-none absolute inset-x-[-3px] top-1/2 h-2.5 -translate-y-1/2 overflow-visible",
				STRETCH,
				className,
			)}
			aria-hidden="true"
		>
			<SketchPath
				d={`M0 ${(5 + rise).toFixed(1)}L100 ${(5 - rise).toFixed(1)}`}
				seed={`${seed}-strike`}
				color={colorOf(color)}
				width={width}
				passes={1}
				tolerance={0.6}
			/>
		</svg>
	);
}
