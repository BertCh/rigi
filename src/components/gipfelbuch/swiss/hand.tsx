// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { PenArrow, SketchPath } from "../notebook/Ink";

// Hand marks for the sheet shell (reports/gipfelbuch-hand-sketch-2026-10-01.md, K-C): a partial
// marker underline under lettered titles, a hand rule, and small pen arrows for hand lists.

/** Stable 0..1 from a string seed. */
function unit(seed: string): number {
	let hash = 2166136261;
	for (const char of seed)
		hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	return ((hash >>> 0) % 1000) / 1000;
}

/**
 * A marker underline under part of a lettered title (sketch-style §3: headline lettering with a
 * partial marker stroke): a broad translucent marker pass and a thin pen pass over it, covering
 * `coverage` of the width from the left. Place in a relative parent, after the text.
 */
export function MarkerUnderline({
	seed,
	color = "var(--gb-red)",
	coverage,
	className,
}: {
	seed: string;
	color?: string;
	/** Fraction of the width covered; default 0.45-0.7 from the seed. */
	coverage?: number;
	className?: string;
}) {
	const span = coverage ?? 0.45 + unit(seed) * 0.25;
	const end = (span * 400).toFixed(1);
	const lift = (unit(`${seed}-lift`) - 0.5) * 2;
	return (
		<svg
			className={`pointer-events-none block h-[12px] w-full overflow-visible [&_path]:[vector-effect:non-scaling-stroke] ${className ?? ""}`}
			viewBox="0 0 400 12"
			preserveAspectRatio="none"
			aria-hidden="true"
		>
			<SketchPath
				d={`M2 ${7 + lift}C${Number(end) * 0.3} ${5.5 + lift} ${Number(end) * 0.7} ${7.5} ${end} ${5.5 - lift}`}
				seed={`${seed}-marker`}
				color={color}
				width={6}
				opacity={0.28}
				passes={1}
				tolerance={0.8}
			/>
			<SketchPath
				d={`M0 ${8 + lift}C${Number(end) * 0.35} ${6.5 + lift} ${Number(end) * 0.75} ${8.5} ${(Number(end) + 6).toFixed(1)} ${6.5 - lift}`}
				seed={`${seed}-pen`}
				color={color}
				width={1.6}
				opacity={0.9}
				tolerance={0.6}
			/>
		</svg>
	);
}

/** A pen rule across its (relative) parent's bottom edge, in place of a crisp border. */
export function HandRule({
	seed,
	color = "ink",
	opacity = 0.7,
}: {
	seed: string;
	color?: "ink" | "brown" | "pencil";
	opacity?: number;
}) {
	return (
		<svg
			className="pointer-events-none absolute inset-x-0 bottom-0 h-[4px] w-full overflow-visible [&_path]:[vector-effect:non-scaling-stroke]"
			viewBox="0 0 400 4"
			preserveAspectRatio="none"
			aria-hidden="true"
		>
			<SketchPath
				d="M0 2L400 2"
				seed={seed}
				color={color}
				width={1.1}
				opacity={opacity}
				passes={1}
			/>
		</svg>
	);
}

/** A small curved pen arrow for a hand list item: out (→) or in (←). Decorative; the text says it. */
export function ListArrow({
	seed,
	dir = "out",
	color = "red",
}: {
	seed: string;
	dir?: "out" | "in";
	color?: "red" | "ink" | "pencil" | "blue";
}) {
	return (
		<svg
			width="28"
			height="16"
			viewBox="0 0 28 16"
			aria-hidden="true"
			className="inline-block shrink-0 overflow-visible align-middle"
		>
			<PenArrow
				from={dir === "out" ? [2, 11] : [26, 5]}
				to={dir === "out" ? [25, 7] : [3, 10]}
				seed={seed}
				color={color}
				width={1.3}
				head={5}
				bend={0.22}
			/>
		</svg>
	);
}
