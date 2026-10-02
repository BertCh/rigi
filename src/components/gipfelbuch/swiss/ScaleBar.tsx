// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type RefObject, useEffect, useState } from "react";
import { Hachure, PenLine } from "../notebook/Ink";
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

/**
 * Hand scale bar (S12): a hand-ruled double rail, alternate segments filled with pencil hatch, end
 * ticks overshooting the rails, labels in italic hand figures. Its length is true to its figure (F1).
 */
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
	const top = 13;
	const bottom = 18;
	return (
		<figure className={`m-0 inline-block ${className ?? ""}`}>
			<svg
				viewBox={`0 0 ${width + 28} 32`}
				width={width + 28}
				height="32"
				role="img"
				aria-label={`Scale bar, ${formatLength(metres)}`}
				className="overflow-visible"
				style={{ maxWidth: "100%" }}
			>
				{Array.from({ length: segments }, (_, i) =>
					i % 2 ? null : (
						<Hachure
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static segments
							key={i}
							d={`M${left + i * segment} ${top}h${segment}v${bottom - top}h-${segment}Z`}
							seed={`scale-seg-${i}`}
							color="pencil"
							gap={1.6}
							width={0.8}
							opacity={0.9}
							angle={-55}
						/>
					),
				)}
				{/* the two rails, each ruled a little past the end ticks */}
				<PenLine
					from={[left - 1.5, top]}
					to={[left + width + 1.5, top]}
					seed="scale-rail-top"
					width={0.9}
				/>
				<PenLine
					from={[left - 1, bottom]}
					to={[left + width + 2, bottom]}
					seed="scale-rail-bottom"
					width={0.9}
				/>
				{Array.from({ length: segments + 1 }, (_, i) => {
					const end = i === 0 || i === segments;
					return (
						<PenLine
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static ticks
							key={i}
							from={[left + i * segment, top - (end ? 3 : 1.5)]}
							to={[left + i * segment, bottom + (end ? 3 : 1.5)]}
							seed={`scale-tick-${i}`}
							width={end ? 1 : 0.7}
						/>
					);
				})}
				{["0", half, formatLength(metres)].map((tick, i) => (
					<text
						key={tick}
						x={left + (i * width) / 2}
						y="8"
						fontSize="10"
						textAnchor="middle"
						fill="var(--gb-ink)"
						className="nb-num"
						style={{ fontStyle: "italic" }}
					>
						{tick}
					</text>
				))}
				{label ? (
					<text
						x={left}
						y="30"
						fontSize="10"
						fill="var(--gb-secondary)"
						className="nb-hand-small"
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
