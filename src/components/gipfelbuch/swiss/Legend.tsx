// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";
import { Hachure, HandDot, PenLine, SketchPath } from "../notebook/Ink";
import { MarkerUnderline } from "./hand";
import { TYPE } from "./type";

export interface LegendItem {
	symbol: ReactNode;
	label: string;
}

export interface LegendProps {
	items: LegendItem[];
	title?: string;
	className?: string;
}

/** Zeichenerklärung: a lettered heading and hand rows, no panel. Lists only what the page shows (F1). */
export function Legend({
	items,
	title = "Zeichenerklärung · Legend",
	className,
}: LegendProps) {
	if (items.length === 0) return null;
	return (
		<section className={`px-6 py-6 ${className ?? ""}`}>
			<div className="relative mb-3 inline-block">
				<h3 className={`${TYPE.h3} m-0 text-[20px] leading-[24px]`}>{title}</h3>
				<MarkerUnderline seed={`legend-${title}`} color="var(--gb-contour)" />
			</div>
			<ul className="m-0 grid list-none grid-cols-1 gap-x-6 gap-y-1.5 p-0 sm:grid-cols-2 lg:grid-cols-3">
				{items.map((item) => (
					<li
						key={item.label}
						className={`${TYPE.caption} flex items-center gap-3 text-[var(--gb-ink)]`}
					>
						<span className="flex h-5 w-9 shrink-0 items-center justify-center">
							{item.symbol}
						</span>
						<span>{item.label}</span>
					</li>
				))}
			</ul>
		</section>
	);
}

export function ContourSymbol() {
	return (
		<svg width="36" height="20" viewBox="0 0 36 20" aria-hidden="true">
			<SketchPath
				d="M0 14C8 4 14 16 22 8S32 6 36 4"
				seed="legend-contour-a"
				color="brown"
				width={1.1}
				tolerance={0.6}
			/>
			<SketchPath
				d="M0 18C9 9 15 19 23 12S32 10 36 8"
				seed="legend-contour-b"
				color="brown"
				width={0.7}
				opacity={0.8}
				tolerance={0.6}
			/>
		</svg>
	);
}

export function WaterSymbol() {
	return (
		<svg width="36" height="20" viewBox="0 0 36 20" aria-hidden="true">
			<SketchPath
				d="M0 10C6 4 10 16 18 10S30 4 36 10"
				seed="legend-water"
				color="blue"
				width={1.6}
				tolerance={0.6}
			/>
		</svg>
	);
}

export function RouteSymbol() {
	return (
		<svg width="36" height="20" viewBox="0 0 36 20" aria-hidden="true">
			<PenLine
				from={[1, 10]}
				to={[35, 10]}
				seed="legend-route"
				color="red"
				width={1.8}
				dash="5 3"
			/>
		</svg>
	);
}

/** LK spot height: a hand dot with its elevation in italic hand figures. */
export function PeakSymbol() {
	return (
		<svg width="36" height="20" viewBox="0 0 36 20" aria-hidden="true">
			<HandDot
				x={6}
				y={11}
				r={1.6}
				seed="legend-peak-dot"
				color="var(--gb-ink)"
			/>
			<text
				x="10"
				y="14"
				fontSize="10"
				fill="var(--gb-ink)"
				className="nb-num"
				style={{ fontStyle: "italic" }}
			>
				1963
			</text>
		</svg>
	);
}

/** LK trigonometric point (S4): a 7 px triangle in three pen strokes, apex overshooting, a centre dot. */
export function TrigPointSymbol() {
	const side = 7;
	const height = (side * Math.sqrt(3)) / 2;
	const cx = 18;
	const top = 10 - (height * 2) / 3;
	const bottom = top + height;
	return (
		<svg width="36" height="20" viewBox="0 0 36 20" aria-hidden="true">
			<PenLine
				from={[cx - side / 2 - 0.4, bottom]}
				to={[cx + 0.3, top - 0.8]}
				seed="legend-trig-l"
				width={1}
			/>
			<PenLine
				from={[cx - 0.3, top - 0.8]}
				to={[cx + side / 2 + 0.4, bottom]}
				seed="legend-trig-r"
				width={1}
			/>
			<PenLine
				from={[cx + side / 2 + 0.6, bottom]}
				to={[cx - side / 2 - 0.6, bottom]}
				seed="legend-trig-b"
				width={1}
			/>
			<HandDot x={cx} y={10} r={1.2} seed="legend-trig-dot" opacity={1} />
		</svg>
	);
}

export function ViewpointSymbol() {
	return (
		<svg width="36" height="20" viewBox="0 0 36 20" aria-hidden="true">
			<SketchPath
				d="M23.5 10A5.5 5.5 0 1 1 23.4 9.4"
				seed="legend-viewpoint"
				color="red"
				width={1.1}
				tolerance={0.4}
			/>
			<HandDot x={18} y={10} r={1.9} seed="legend-viewpoint-dot" color="red" />
		</svg>
	);
}

/**
 * LK rock drawing, light from the north-west: the lit (left) face carries a few thin broken
 * strokes that stop short of the ridge, the shaded (right) face carries heavier strokes that
 * touch it. Strokes run parallel to their face edge, so none cross.
 */
export function RockSymbol() {
	const base = 17;
	const rocks = [
		{ ax: 10, ay: 4, half: 7 },
		{ ax: 26, ay: 7, half: 6 },
	];
	return (
		<svg width="36" height="20" viewBox="0 0 36 20" aria-hidden="true">
			{rocks.map((rock) => {
				const slope = rock.half / (base - rock.ay);
				const ridgeTo = (t: number) => rock.ay + t;
				return (
					<g key={rock.ax}>
						{[3.5, 6.5, 9.5].map((t, i) => {
							const y = ridgeTo(t);
							if (y > base - 2) return null;
							return (
								<PenLine
									key={`lit-${t}`}
									from={[rock.ax - 1.2, y]}
									to={[rock.ax - 1.2 - (base - y) * slope * 0.8, base - 1]}
									seed={`legend-rock-lit-${rock.ax}-${i}`}
									width={0.5}
									dash="2.4 1.4"
								/>
							);
						})}
						{[1.5, 4.5, 7.5, 10.5].map((t, i) => {
							const y = ridgeTo(t);
							if (y > base - 1.5) return null;
							return (
								<PenLine
									key={`shade-${t}`}
									from={[rock.ax, y]}
									to={[rock.ax + (base - y) * slope * 0.92, base]}
									seed={`legend-rock-shade-${rock.ax}-${i}`}
									width={1.6 - i * 0.13}
								/>
							);
						})}
					</g>
				);
			})}
		</svg>
	);
}

/** LK glacier (S9): a pale blue pencil hatch along the flow, two inner contours and crevasses; no outline. */
export function GlacierSymbol() {
	const shape = "M3 4H33L30 17H6Z";
	return (
		<svg width="36" height="20" viewBox="0 0 36 20" aria-hidden="true">
			<Hachure
				d={shape}
				seed="legend-glacier-wash"
				color="blue"
				width={0.6}
				opacity={0.35}
				angle={-8}
				gap={2.2}
			/>
			<SketchPath
				d="M6 8C13 6 22 10 31 7.5"
				seed="legend-glacier-contour-a"
				color="blue"
				width={0.6}
				tolerance={0.5}
			/>
			<SketchPath
				d="M7.5 12.5C14 10.5 22 14 29.5 11.5"
				seed="legend-glacier-contour-b"
				color="blue"
				width={0.6}
				tolerance={0.5}
			/>
			<PenLine
				from={[12, 4.8]}
				to={[14.5, 7.4]}
				seed="legend-crevasse-a"
				color="blue"
				width={0.8}
			/>
			<PenLine
				from={[20, 9.2]}
				to={[23.6, 11.8]}
				seed="legend-crevasse-b"
				color="blue"
				width={0.8}
			/>
			<PenLine
				from={[15, 13.4]}
				to={[18.4, 15.8]}
				seed="legend-crevasse-c"
				color="blue"
				width={0.8}
			/>
		</svg>
	);
}
