// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type RefObject, useEffect, useState } from "react";
import { Hachure, PenLine, SketchPolyline } from "../notebook/Ink";
import type { SheetData } from "./useSheet";

export interface ScaleBarProps {
	/** True ground scale of the figure it sits under: metres per CSS pixel. */
	metresPerPixel: number;
	/** Longest the bar may be drawn, in CSS px. */
	maxWidth?: number;
	/** Number of alternating segments. */
	segments?: number;
	/** Optional caption, e.g. a ratio that is true for the figure. */
	label?: string;
	className?: string;
}

const NICE_LENGTHS_M = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

/** F1: the largest round length (50 m ... 20 km) whose drawn width fits `maxWidth`. */
export function niceScaleLength(
	metresPerPixel: number,
	maxWidth: number,
): number {
	let best = NICE_LENGTHS_M[0];
	for (const length of NICE_LENGTHS_M)
		if (length / metresPerPixel <= maxWidth) best = length;
	return best;
}

const formatLength = (metres: number) =>
	metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;

/** Sketched scale bar whose length is true to its figure; alternate segments hachured. Pure SVG. */
export function ScaleBar({
	metresPerPixel,
	maxWidth = 160,
	segments = 4,
	label,
	className,
}: ScaleBarProps) {
	const metres = niceScaleLength(metresPerPixel, maxWidth);
	const width = metres / metresPerPixel;
	const half = formatLength(metres / 2).replace(/ (km|m)$/, "");
	const segment = width / segments;
	const left = 8;
	return (
		<figure className={`m-0 inline-block ${className ?? ""}`}>
			<svg
				viewBox={`0 0 ${width + 28} 30`}
				width={width + 28}
				height="30"
				role="img"
				aria-label={`Scale bar, ${formatLength(metres)}`}
				style={{ maxWidth: "100%" }}
			>
				{Array.from({ length: segments }, (_, i) =>
					i % 2 ? null : (
						<Hachure
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static segments
							key={i}
							d={`M${left + i * segment} 12h${segment}v6h-${segment}Z`}
							seed={`scale-seg-${i}`}
							color="ink"
							gap={1.7}
							width={0.8}
							opacity={0.85}
							angle={-50}
						/>
					),
				)}
				<SketchPolyline
					points={[
						[left, 12],
						[left + width, 12],
						[left + width, 18],
						[left, 18],
					]}
					closed
					seed="scale-bar"
					width={0.9}
					tolerance={0.5}
				/>
				{Array.from({ length: segments - 1 }, (_, i) => (
					<PenLine
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static ticks
						key={i}
						from={[left + (i + 1) * segment, 11]}
						to={[left + (i + 1) * segment, 19]}
						seed={`scale-tick-${i}`}
						width={0.7}
					/>
				))}
				{["0", half, formatLength(metres)].map((tick, i) => (
					<text
						key={tick}
						x={left + (i * width) / 2}
						y="9"
						fontSize="8"
						textAnchor="middle"
						fill="var(--gb-ink)"
						className="gb-num"
					>
						{tick}
					</text>
				))}
				{label ? (
					<text
						x={left}
						y="28"
						fontSize="7"
						fill="var(--gb-secondary)"
						style={{ letterSpacing: "0.12em" }}
					>
						{label}
					</text>
				) : null}
			</svg>
		</figure>
	);
}

/**
 * Scale bar for a map drawn from the baked sheet: the sheet spans its LV95 width (12.2 km) across
 * the rendered width of `targetRef`, so the bar is true at any viewport. Renders nothing until both
 * are known.
 */
export function SheetScaleBar({
	sheet,
	targetRef,
	className,
}: {
	sheet?: SheetData;
	targetRef: RefObject<HTMLElement | null>;
	className?: string;
}) {
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const element = targetRef.current;
		if (!element) return;
		const update = () => setWidth(element.getBoundingClientRect().width);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, [targetRef]);
	if (!sheet || width < 120) return null;
	const groundMetres = sheet.lv95.ne[0] - sheet.lv95.sw[0];
	return (
		<ScaleBar
			metresPerPixel={groundMetres / width}
			maxWidth={Math.min(200, width / 2)}
			className={className}
		/>
	);
}
