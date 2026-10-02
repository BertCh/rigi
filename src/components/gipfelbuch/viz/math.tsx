// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";
import { PenRule } from "#/components/gipfelbuch/notebook/Ink";
import { cn } from "#/lib/utils";
import { LAYER_STYLE, type PhotoLayer } from "./real";

// Math kit: small, dependency-free equation typesetting for explainer pages. The point is to tie each
// symbol to the thing it measures in the figure next to it, so a symbol takes the same colour as its
// overlay (`c="solved"` is the cyan DEM line, `c="skyline"` the yellow detected one). Keep equations
// short (one line, a handful of symbols) and always pair them with a real figure and a `where` legend.

// The layer colours are tuned for photos (yellow, cyan); on paper each symbol takes a darker
// Brezine chart kin of its layer (Ascher codes in comments).
const PAPER_INK: Partial<Record<PhotoLayer, string>> = {
	skyline: "var(--gb-contour, #95500c)", // NB
	weight: "var(--gb-contour, #95500c)", // NB
	prior: "#ab343a", // RM
	solved: "var(--gb-water, #30626b)", // GL
	priorPeaks: "#ab343a", // RM
	sky: "var(--gb-navy, #002f55)",
};
/** Math is set in the page serif (lane A's --gb-font-serif), not the browser default. */
const SERIF = "font-[family-name:var(--gb-font-serif,serif)]";

const colorOf = (c?: PhotoLayer | string) =>
	c == null
		? undefined
		: c in LAYER_STYLE
			? (PAPER_INK[c as PhotoLayer] ?? LAYER_STYLE[c as PhotoLayer].color)
			: c;

/** A math symbol: serif italic, optionally coloured like a figure layer (a `PhotoLayer` key or a CSS colour). */
export function Sym({
	c,
	upright,
	children,
}: {
	c?: PhotoLayer | string;
	upright?: boolean;
	children: ReactNode;
}) {
	// A layer key also draws an underline in the overlay's own photo colour, so the readable paper ink
	// still points at the yellow/cyan/magenta line in the figure.
	const layer = c != null && c in LAYER_STYLE ? (c as PhotoLayer) : undefined;
	return (
		<span
			className={cn(
				SERIF,
				upright ? "not-italic" : "italic",
				layer &&
					"underline decoration-[0.14em] underline-offset-[0.18em] [text-decoration-skip-ink:none]",
			)}
			style={{
				color: colorOf(c),
				textDecorationColor: layer ? LAYER_STYLE[layer].color : undefined,
			}}
		>
			{children}
		</span>
	);
}

/** A stacked fraction, usable inline or inside `Eq`. */
export function Frac({ n, d }: { n: ReactNode; d: ReactNode }) {
	return (
		<span className="mx-[0.15em] inline-flex flex-col items-center align-middle text-[0.86em] leading-[1.15]">
			<span className="px-[0.2em]">{n}</span>
			<span className="w-full border-t border-current px-[0.2em]">{d}</span>
		</span>
	);
}

/** An operator with limits underneath: Σ over columns, argmin over yaw. */
export function Op({ op, under }: { op: ReactNode; under?: ReactNode }) {
	return (
		<span className="mx-[0.12em] inline-flex flex-col items-center align-middle leading-none">
			<span className="text-[1.15em] not-italic">{op}</span>
			{under && <span className="mt-[0.2em] text-[0.58em]">{under}</span>}
		</span>
	);
}

/**
 * A display equation with an optional legend. `where` explains each symbol in plain words, coloured to
 * match the figure. Overflows sideways on phones instead of wrapping mid-equation.
 */
export function Eq({
	children,
	where,
	label,
	className,
}: {
	children: ReactNode;
	where?: { sym: ReactNode; c?: PhotoLayer | string; text: ReactNode }[];
	label?: string;
	className?: string;
}) {
	return (
		<figure
			className={cn(
				"my-6 bg-[var(--gb-paper-deep,transparent)] px-4 py-4 sm:px-6",
				className,
			)}
		>
			{label && (
				<p className="gb-caps mb-2 text-[11px] text-[var(--gb-contour,currentColor)]">
					{label}
				</p>
			)}
			<div className="overflow-x-auto">
				<div
					className={`${SERIF} w-max min-w-full text-left text-[16px] leading-[1.9] whitespace-nowrap text-[var(--gb-ink,var(--rigi-paper))] sm:text-[24px]`}
				>
					{children}
				</div>
			</div>
			{where && where.length > 0 && (
				<PenRule
					seed={`eq-${label ?? "where"}`}
					className="mt-3"
					opacity={0.6}
				/>
			)}
			{where && where.length > 0 && (
				<dl className="mt-1 grid gap-x-3 gap-y-1 pt-3 text-[13px] leading-snug text-[var(--gb-secondary,#4a545c)] sm:grid-cols-[auto_1fr]">
					{where.map((w, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static legend
						<div key={i} className="contents">
							<dt
								className={`${SERIF} text-[16px] text-[var(--gb-navy,inherit)] italic`}
							>
								<Sym c={w.c}>{w.sym}</Sym>
							</dt>
							<dd className="mb-1 sm:mb-0">{w.text}</dd>
						</div>
					))}
				</dl>
			)}
		</figure>
	);
}
