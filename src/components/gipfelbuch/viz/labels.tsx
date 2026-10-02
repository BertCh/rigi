// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";

// KR6 (reports/gipfelbuch-best-of-both.md): the printed label every page drew for itself. Print, not
// hand: a figure label states a value or names a thing; the hand is kept for doubts and decisions.

/**
 * A printed SVG label on paper with a paper halo. `size` is in viewBox units: pick it so the label
 * renders at 11–13 px (size × renderedWidth / viewBoxWidth). Colours go through `style`, so tokens
 * resolve in every engine.
 */
export function PrintLabel({
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
	/** Tabular figures (default); false sets the sans. */
	mono?: boolean;
	/** The condensed face (peak names, tight axes); overrides `mono`. */
	condensed?: boolean;
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
			fontSize={size}
			strokeWidth={halo}
			strokeLinejoin="round"
			paintOrder="stroke"
			className={condensed ? undefined : mono ? "gb-num" : undefined}
			style={{
				fontFamily: condensed ? "var(--gb-font-condensed)" : undefined,
				fill: color,
				stroke: halo ? haloColor : "none",
				fontWeight: weight,
			}}
		>
			{children}
		</text>
	);
}

/** A longer printed note in a figure: PrintLabel in the sans, secondary ink by default. */
export function PrintNote(props: Parameters<typeof PrintLabel>[0]) {
	return (
		<PrintLabel color="var(--gb-secondary)" mono={false} {...props}>
			{props.children}
		</PrintLabel>
	);
}

/**
 * A slider in the sheet's inks: a pencil track, a red filled run up to the value and a red belay
 * handle. A native range input underneath keeps keyboard and touch.
 */
export function HandRange({
	value,
	min,
	max,
	step,
	label,
	onChange,
}: {
	value: number;
	min: number;
	max: number;
	step: number;
	label: string;
	onChange: (v: number) => void;
}) {
	const frac = Math.min(1, Math.max(0, (value - min) / (max - min || 1)));
	return (
		<span className="relative mt-1 block h-6 w-full">
			<span
				className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2"
				style={{
					background: "color-mix(in srgb, var(--gb-ink) 22%, var(--gb-paper))",
				}}
				aria-hidden="true"
			/>
			<span
				className="absolute top-1/2 left-0 h-[3px] -translate-y-1/2"
				style={{
					width: `calc(12px + (100% - 24px) * ${frac})`,
					background: "var(--gb-red)",
				}}
				aria-hidden="true"
			/>
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
				viewBox="-12 -12 24 24"
				className="pointer-events-none absolute top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 transition-transform peer-focus-visible:scale-125"
				style={{ left: `calc(12px + (100% - 24px) * ${frac})` }}
				aria-hidden="true"
			>
				<circle r={12} style={{ fill: "var(--gb-paper)" }} />
				<circle r={9} style={{ fill: "var(--gb-red)" }} />
			</svg>
		</span>
	);
}
