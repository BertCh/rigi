// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";
import { HandDot, PenCircle, SketchPath } from "../notebook/Ink";
import { HandUnderline } from "./hand";

// Figure labels (hand pass, reports/gipfelbuch.md): every label in a figure
// is written by hand. Values and names use the small hand (Shantell Sans, tabular figures); peak and
// place names use hand block capitals (`caps`), after the LK lettering hierarchy. Only code and
// equations stay in print.

/**
 * A hand-lettered SVG label on paper with a paper halo. `size` is in viewBox units: pick it so the
 * label renders at 12–14 px (size × renderedWidth / viewBoxWidth). Colours go through `style`, so
 * tokens resolve in every engine.
 */
export function HandLabel({
	x,
	y,
	anchor = "start",
	size = 13,
	color = "var(--gb-pencil)",
	halo = 3,
	haloColor = "var(--gb-paper)",
	weight,
	mono = true,
	condensed = false,
	caps = condensed,
	italic = false,
	rotate,
	children,
}: {
	x: number;
	y: number;
	anchor?: "start" | "middle" | "end";
	size?: number;
	color?: string;
	/** Halo width in viewBox units; 0 for none. */
	halo?: number;
	haloColor?: string;
	weight?: number;
	/** Tabular hand figures (default) so columns of values line up. */
	mono?: boolean;
	/** Former condensed print face: now the hand block capitals (same as `caps`). */
	condensed?: boolean;
	/** Hand block capitals (names of peaks, places, regions). */
	caps?: boolean;
	/** Italic marks a height figure or a derived value (LK rule). */
	italic?: boolean;
	/** Degrees, about the label's own anchor point (x, y). */
	rotate?: number;
	children: ReactNode;
}) {
	return (
		<text
			transform={rotate ? `rotate(${rotate} ${x} ${y})` : undefined}
			x={x}
			y={y}
			textAnchor={anchor}
			fontSize={caps ? size * 1.08 : size}
			strokeWidth={halo}
			strokeLinejoin="round"
			paintOrder="stroke"
			className={caps ? "nb-label" : "nb-hand-small"}
			style={{
				fill: color,
				stroke: halo ? haloColor : "none",
				fontWeight: weight,
				fontStyle: italic ? "italic" : undefined,
				fontVariantNumeric: mono ? "tabular-nums" : undefined,
			}}
		>
			{children}
		</text>
	);
}

/** A longer hand note in a figure: HandLabel in secondary ink, proportional figures. */
export function HandNote(props: Parameters<typeof HandLabel>[0]) {
	return (
		<HandLabel color="var(--gb-secondary)" mono={false} {...props}>
			{props.children}
		</HandLabel>
	);
}

/**
 * A slider drawn by hand: a pencil track, a red pen run up to the value and a hand-drawn belay handle (a
 * paper blot, a red pen loop and a red dot). A native range input underneath keeps keyboard, touch and
 * ARIA; the drawing is aria-hidden.
 */
export function HandRange({
	value,
	min,
	max,
	step,
	label,
	onChange,
	readout,
	onResume,
	manual,
}: {
	value: number;
	min: number;
	max: number;
	step: number;
	label: string;
	onChange: (v: number) => void;
	/** The value in hand figures (tabular) after the track, e.g. "12.5°". */
	readout?: ReactNode;
	/** With `manual`, a pencil "↻ play" button after the track that hands the slider back to its animation. */
	onResume?: () => void;
	/** True while the reader holds the slider (useAutoScrub's `isManual`): shows the resume button. */
	manual?: boolean;
}) {
	const frac = Math.min(1, Math.max(0, (value - min) / (max - min || 1)));
	const track = (
		<span className="relative mt-1 block h-6 w-full">
			<svg
				viewBox="0 0 300 10"
				preserveAspectRatio="none"
				className="pointer-events-none absolute inset-x-0 top-1/2 h-2.5 w-full -translate-y-1/2 overflow-visible [&_path]:[vector-effect:non-scaling-stroke]"
				aria-hidden="true"
			>
				<SketchPath
					d="M2 5L298 5"
					seed={`range-track-${label}`}
					color="pencil"
					width={1.2}
					opacity={0.6}
					passes={2}
					tolerance={0.7}
				/>
			</svg>
			<span
				className="pointer-events-none absolute top-1/2 left-0 h-2.5 -translate-y-1/2"
				style={{ width: `calc(12px + (100% - 24px) * ${frac})` }}
				aria-hidden="true"
			>
				<svg
					viewBox="0 0 300 10"
					preserveAspectRatio="none"
					className="absolute inset-0 h-full w-full overflow-visible [&_path]:[vector-effect:non-scaling-stroke]"
					aria-hidden="true"
				>
					<SketchPath
						d="M2 5L300 5"
						seed={`range-run-${label}`}
						color="red"
						width={2.4}
						passes={1}
						tolerance={0.5}
					/>
				</svg>
			</span>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				aria-label={label}
				onChange={(e) => onChange(Number(e.target.value))}
				className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0"
			/>
			<svg
				viewBox="-14 -14 28 28"
				className="pointer-events-none absolute top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 overflow-visible transition-transform peer-focus-visible:scale-125 motion-reduce:transition-none"
				style={{ left: `calc(12px + (100% - 24px) * ${frac})` }}
				aria-hidden="true"
			>
				<HandDot
					x={0}
					y={0}
					r={11}
					seed={`range-blot-${label}`}
					color="var(--gb-paper)"
					opacity={1}
				/>
				<PenCircle
					center={[0, 0]}
					radiusX={8.5}
					radiusY={8}
					seed={`range-loop-${label}`}
					color="red"
					width={1.6}
				/>
				<HandDot
					x={0}
					y={0}
					r={4}
					seed={`range-dot-${label}`}
					color="var(--gb-red)"
					opacity={1}
				/>
			</svg>
		</span>
	);
	if (readout == null && !onResume) return track;
	return (
		<span className="flex items-center gap-3">
			<span className="min-w-0 flex-1">{track}</span>
			{readout != null && (
				<span className="nb-num min-w-[3.5em] shrink-0 text-right text-[14px] leading-[20px] text-[var(--gb-ink)] tabular-nums">
					{readout}
				</span>
			)}
			{onResume && manual && (
				<button
					type="button"
					onClick={onResume}
					className="nb-hand relative shrink-0 px-2 text-[17px] leading-[22px] text-[var(--gb-secondary,#4a545c)] hover:text-[var(--gb-ink)]"
				>
					↻ play
					<HandUnderline
						seed={`range-resume-${label}`}
						color="pencil"
						width={1.1}
						coverage={1}
						offset={-2}
					/>
				</button>
			)}
		</span>
	);
}
