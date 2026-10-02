// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type ReactNode, useId } from "react";
import type { GipfelbuchStatus } from "#/lib/gipfelbuch/types";
import { HandDot, PenLine, SketchPath, SketchPolyline } from "../notebook/Ink";

// LK point symbols drawn by hand (reports/gipfelbuch-hand-sketch-research/swiss-cartography.md §1,
// S4-S6, S19): pen strokes with overshoot, heights in italic hand figures (LK rule E1).

/** LK spot height: a hand dot or a pen × (S5) and the elevation in italic hand figures. */
export function SpotHeight({
	value,
	prefix = "",
	unit,
	mark = "dot",
	water = false,
	className,
}: {
	value: string | number;
	prefix?: "P." | "";
	unit?: string;
	/** "dot" (LK ·) or "x" (LK ×, a spot height on open ground or a lake bottom). */
	mark?: "dot" | "x";
	/** Lake level: the figure in water ink. */
	water?: boolean;
	className?: string;
}) {
	const seed = `spot-${value}`;
	return (
		<span className={`inline-flex items-center gap-[3px] ${className ?? ""}`}>
			<svg
				width="8"
				height="8"
				viewBox="0 0 8 8"
				aria-hidden="true"
				className="overflow-visible"
			>
				{mark === "x" ? (
					<>
						<PenLine from={[1, 1]} to={[7, 7]} seed={`${seed}-a`} width={1} />
						<PenLine from={[7, 1]} to={[1, 7]} seed={`${seed}-b`} width={1} />
					</>
				) : (
					<HandDot x={4} y={4} r={1.7} seed={seed} color="ink" opacity={1} />
				)}
			</svg>
			<span
				className="nb-num text-[12px] italic"
				style={{
					fontVariantNumeric: "tabular-nums",
					color: water ? "var(--gb-water)" : undefined,
				}}
			>
				{prefix ? `${prefix} ` : ""}
				{value}
				{unit ? ` ${unit}` : ""}
			</span>
		</span>
	);
}

/**
 * LK trigonometric point inline (S4): a triangle drawn in three pen strokes whose apex overshoots,
 * a centre dot, and optionally its height up and to the right in bold italic hand figures.
 */
export function TrigPoint({
	size = 9,
	filled = false,
	height: elevation,
}: {
	size?: number;
	filled?: boolean;
	/** Height to one decimal, e.g. "2127.6", written top right. */
	height?: string | number;
}) {
	const triangle = (size * Math.sqrt(3)) / 2;
	const pad = 1.5;
	const apex: [number, number] = [pad + size / 2, pad];
	const right: [number, number] = [pad + size, pad + triangle];
	const left: [number, number] = [pad, pad + triangle];
	const cy = pad + (triangle * 2) / 3;
	const seed = `trig-${size}-${elevation ?? ""}`;
	const symbol = (
		<svg
			width={size + pad * 2}
			height={triangle + pad * 2}
			viewBox={`0 0 ${size + pad * 2} ${triangle + pad * 2}`}
			aria-hidden="true"
			className="inline-block overflow-visible align-[-1px]"
		>
			{filled ? (
				<path
					d={`M${apex[0]} ${apex[1]}L${right[0]} ${right[1]}H${left[0]}Z`}
					fill="var(--gb-ink)"
				/>
			) : null}
			{/* three strokes, each running a little past the next corner (apex overshoot ~0.8 px) */}
			<PenLine
				from={[left[0] - 0.4, left[1]]}
				to={[apex[0] + 0.3, apex[1] - 0.8]}
				seed={`${seed}-l`}
				width={1}
			/>
			<PenLine
				from={[apex[0] - 0.3, apex[1] - 0.8]}
				to={[right[0] + 0.4, right[1]]}
				seed={`${seed}-r`}
				width={1}
			/>
			<PenLine
				from={[right[0] + 0.6, right[1]]}
				to={[left[0] - 0.6, left[1]]}
				seed={`${seed}-b`}
				width={1}
			/>
			<HandDot
				x={apex[0]}
				y={cy}
				r={Math.min(1.2, size / 8)}
				seed={`${seed}-dot`}
				color={filled ? "var(--gb-paper)" : "ink"}
				opacity={1}
			/>
		</svg>
	);
	if (elevation === undefined) return symbol;
	return (
		<span className="inline-flex items-start gap-[2px]">
			{symbol}
			<span className="nb-num -mt-1 text-[12px] font-semibold italic">
				{elevation}
			</span>
		</span>
	);
}

/** Hut bullet: a pen-drawn house (roof chevron over a hatched square). Ink; red only for the current hut. */
export function HutBullet({ current = false }: { current?: boolean }) {
	const color = current ? "red" : "ink";
	return (
		<svg
			width="9"
			height="10"
			viewBox="0 0 9 10"
			aria-hidden="true"
			className="inline-block overflow-visible align-[-1px]"
		>
			<SketchPolyline
				points={[
					[0.5, 3.4],
					[4.5, 0.6],
					[8.5, 3.4],
				]}
				seed={`hut-roof-${current}`}
				color={color}
				width={1}
				tolerance={0.4}
				passes={1}
			/>
			<path
				d="M1.6 4.2h5.8v5H1.6Z"
				fill={current ? "var(--gb-red)" : "var(--gb-ink)"}
			/>
		</svg>
	);
}

/** SAC grade (T1-T6, L/WS/ZS/S/SS/AS/EX) hand-boxed (S19): a rough four-stroke rectangle with overshoot. */
export function Grade({
	children,
	crux = false,
}: {
	children: ReactNode;
	/** The route's crux: red instead of ink. */
	crux?: boolean;
}) {
	const seed = `grade-${String(children)}`;
	const color = crux ? "red" : "ink";
	return (
		<span
			className="nb-label relative inline-flex items-center px-[5px] py-[1px] text-[12px] leading-[14px]"
			style={{ fontWeight: 600, color: crux ? "var(--gb-red)" : undefined }}
		>
			<svg
				className="pointer-events-none absolute inset-0 size-full overflow-visible [&_path]:[vector-effect:non-scaling-stroke]"
				viewBox="0 0 40 18"
				preserveAspectRatio="none"
				aria-hidden="true"
			>
				<PenLine
					from={[-1.5, 0.5]}
					to={[41, 0]}
					seed={`${seed}-t`}
					color={color}
					width={0.9}
				/>
				<PenLine
					from={[39.5, -1.5]}
					to={[40, 19]}
					seed={`${seed}-r`}
					color={color}
					width={0.9}
				/>
				<PenLine
					from={[41.5, 17.6]}
					to={[-1, 18]}
					seed={`${seed}-b`}
					color={color}
					width={0.9}
				/>
				<PenLine
					from={[0.2, 19.5]}
					to={[0.6, -1]}
					seed={`${seed}-l`}
					color={color}
					width={0.9}
				/>
			</svg>
			<span className="relative">{children}</span>
		</span>
	);
}

function rotationOf(seed: string | number, max = 4): number {
	let hash = 2166136261;
	for (const char of String(seed)) {
		hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	}
	return ((((hash >>> 0) % 1000) / 1000) * 2 - 1) * max;
}

/** Inked ring: a pen circle, never a geometric one (a rubber stamp prints unevenly). */
function StampRing({
	r,
	seed,
	width,
}: {
	r: number;
	seed: string;
	width: number;
}) {
	return (
		<SketchPath
			d={`M${50 - r} 50a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`}
			seed={seed}
			color="currentColor"
			width={width}
			tolerance={0.6}
			passes={1}
		/>
	);
}

/**
 * Station stamp: a round rubber stamp for frozen or verified results only, double ring in navy
 * with the place around the rim and the date in the centre. At most one per page.
 */
export function StationStamp({
	place,
	date,
	seed,
}: {
	place: string;
	date: string;
	seed: string | number;
}) {
	const id = useId().replace(/:/g, "");
	return (
		<svg
			width="44"
			height="44"
			viewBox="0 0 100 100"
			role="img"
			aria-label={`${place}, ${date}`}
			style={{
				mixBlendMode: "multiply",
				opacity: 0.85,
				transform: `rotate(${rotationOf(seed).toFixed(2)}deg)`,
				color: "var(--gb-navy)",
			}}
		>
			<defs>
				<path id={id} d="M50 50m-35 0a35 35 0 1 1 70 0a35 35 0 1 1 -70 0" />
			</defs>
			<StampRing r={47} seed={`station-${seed}-o`} width={2.2} />
			<StampRing r={41} seed={`station-${seed}-i`} width={1.6} />
			<text className="nb-label" fontSize="13" fill="currentColor">
				<textPath href={`#${id}`} startOffset="50%" textAnchor="middle">
					{place}
				</textPath>
			</text>
			<text
				x="50"
				y="55"
				textAnchor="middle"
				fontSize="15"
				fill="currentColor"
				className="nb-num"
			>
				{date}
			</text>
		</svg>
	);
}

/** Stamp word per node status: a sheet is checked (geprüft), still open (offen) or rejected (verworfen). */
export function stampWordForStatus(status: GipfelbuchStatus): string {
	switch (status) {
		case "live":
			return "geprüft";
		case "flagged":
		case "research":
			return "offen";
		case "killed":
			return "verworfen";
	}
}

/**
 * The sheet stamp (sketch-style §7 move 22): the one stamp per sheet, and it carries facts (the
 * sheet number, the sheet's status and the date its data was measured). A vector ring with rim
 * lettering, rotated by at most 8 degrees, navy, or red when the sheet records a rejected idea.
 */
export function SheetStamp({
	sheet,
	status,
	date,
	rim = "Rigi Gipfelbuch",
	seed,
	size = 96,
	className,
}: {
	/** Sheet number, e.g. "07". */
	sheet: string;
	status: GipfelbuchStatus;
	/** The data stand, e.g. "1.10.2026". */
	date: string;
	rim?: string;
	seed: string;
	size?: number;
	className?: string;
}) {
	const id = useId().replace(/:/g, "");
	const word = stampWordForStatus(status);
	const red = status === "killed";
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 100 100"
			role="img"
			aria-label={`Stamp: sheet ${sheet}, ${word}, ${date}`}
			className={`overflow-visible ${className ?? ""}`}
			style={{
				mixBlendMode: "multiply",
				opacity: 0.86,
				transform: `rotate(${rotationOf(seed, 8).toFixed(2)}deg)`,
				color: red ? "var(--gb-red)" : "var(--gb-navy)",
			}}
		>
			<defs>
				<path id={`${id}-top`} d="M13 50a37 37 0 0 1 74 0" />
				<path id={`${id}-bottom`} d="M10 50a40 40 0 0 0 80 0" />
			</defs>
			<StampRing r={48} seed={`stamp-${seed}-o`} width={2.4} />
			<StampRing r={44.5} seed={`stamp-${seed}-i`} width={1.2} />
			<text className="nb-label" fontSize="10.5" fill="currentColor">
				<textPath
					href={`#${id}-top`}
					startOffset="50%"
					textAnchor="middle"
					letterSpacing="1.2"
				>
					{rim}
				</textPath>
			</text>
			<text className="nb-num" fontSize="10.5" fill="currentColor">
				<textPath
					href={`#${id}-bottom`}
					startOffset="50%"
					textAnchor="middle"
					dominantBaseline="hanging"
				>
					{date}
				</textPath>
			</text>
			<PenLine
				from={[9, 40]}
				to={[91, 40]}
				seed={`stamp-${seed}-band-a`}
				color="currentColor"
				width={1.4}
			/>
			<PenLine
				from={[9, 63]}
				to={[91, 63]}
				seed={`stamp-${seed}-band-b`}
				color="currentColor"
				width={1.4}
			/>
			<text
				x="50"
				y="34"
				textAnchor="middle"
				fontSize="11"
				fill="currentColor"
				className="nb-label"
			>
				Blatt {sheet}
			</text>
			<text
				x="50"
				y="57"
				textAnchor="middle"
				fontSize={word.length > 7 ? 14 : 17}
				fill="currentColor"
				className="nb-label"
				style={{ fontWeight: 700, letterSpacing: "0.06em" }}
			>
				{word.toUpperCase()}
			</text>
		</svg>
	);
}
