// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type ReactNode, useId, useMemo } from "react";
import {
	Hachure,
	type InkColor,
	inkColor,
	PenLine,
	SketchPath,
} from "../notebook/Ink";

export interface PlotScale {
	/** Data x -> SVG x. */
	x(v: number): number;
	/** Data y -> SVG y (flipped: bigger is higher). */
	y(v: number): number;
	/** SVG path "M..L.." through data points. */
	line(pts: [number, number][]): string;
	/** Closed area under a data line down to y = `base` (default the domain minimum). */
	area(pts: [number, number][], base?: number): string;
	/** Inner plot rectangle in SVG units. */
	box: { x0: number; y0: number; x1: number; y1: number };
}

/** A data series on a Plot: exact (L1, data is never wobbled), series tier 1.6 px. */
export function PlotSeries({
	d,
	seed,
	color = "ink",
	width = 1.6,
	dash,
}: {
	/** Path from `s.line(points)`. */
	d: string;
	seed: string;
	color?: InkColor | (string & {});
	width?: number;
	dash?: string;
}) {
	return (
		<SketchPath
			d={d}
			seed={seed}
			color={color}
			width={width}
			dash={dash}
			data
		/>
	);
}

/** A filled region on a Plot: a light solid tint carries the value, hachure decorates it. Path from `s.area(points)`. */
export function PlotArea({
	d,
	seed,
	color = "brown",
	gap = 5,
}: {
	d: string;
	seed: string;
	color?: InkColor | (string & {});
	gap?: number;
}) {
	return (
		<g>
			<path
				d={d}
				style={{ fill: inkColor(color as InkColor) ?? color }}
				fillOpacity={0.16}
			/>
			<Hachure d={d} seed={seed} color={color} gap={gap} opacity={0.45} />
		</g>
	);
}

/**
 * Minimal responsive SVG plot drawn by hand: one baseline and one left rule (pen lines), a faint pencil
 * grid on the y axis only, mono tick numbers. `children` is a render function that gets
 * scales and returns SVG elements in data space:
 *   <Plot x={[0, 10]} y={[0, 1]} xLabel="px" yLabel="score">
 *     {(s) => <PlotSeries d={s.line(pts)} seed="score" color="red" />}
 *   </Plot>
 */
export function Plot({
	x,
	y,
	width = 520,
	height = 260,
	xLabel,
	yLabel,
	xTicks = 5,
	yTicks = 4,
	fmtX = (v) => `${+v.toFixed(2)}`,
	fmtY = (v) => `${+v.toFixed(2)}`,
	children,
	className,
}: {
	x: [number, number];
	y: [number, number];
	width?: number;
	height?: number;
	xLabel?: string;
	yLabel?: string;
	xTicks?: number;
	yTicks?: number;
	fmtX?: (v: number) => string;
	fmtY?: (v: number) => string;
	children: (s: PlotScale) => ReactNode;
	className?: string;
}) {
	const m = { l: 44, r: 14, t: 12, b: 36 };
	const box = { x0: m.l, y0: m.t, x1: width - m.r, y1: height - m.b };
	const sx = (v: number) =>
		box.x0 + ((v - x[0]) / (x[1] - x[0] || 1)) * (box.x1 - box.x0);
	const sy = (v: number) =>
		box.y1 - ((v - y[0]) / (y[1] - y[0] || 1)) * (box.y1 - box.y0);
	const line = (pts: [number, number][]) =>
		pts
			.map(
				([a, b], i) =>
					`${i ? "L" : "M"}${sx(a).toFixed(1)} ${sy(b).toFixed(1)}`,
			)
			.join("");
	const area = (pts: [number, number][], base = y[0]) =>
		pts.length
			? `${line(pts)}L${sx(pts[pts.length - 1][0]).toFixed(1)} ${sy(base).toFixed(1)}L${sx(pts[0][0]).toFixed(1)} ${sy(base).toFixed(1)}Z`
			: "";
	const xs = Array.from(
		{ length: xTicks + 1 },
		(_, i) => x[0] + ((x[1] - x[0]) * i) / xTicks,
	);
	const ys = Array.from(
		{ length: yTicks + 1 },
		(_, i) => y[0] + ((y[1] - y[0]) * i) / yTicks,
	);
	const id = useId();
	const xLabels = xs.map((v) => fmtX(v));
	const yLabels = ys.map((v) => fmtY(v));
	const labelKey = `${xLabels.join("|")}#${yLabels.join("|")}`;
	// The pen furniture only depends on the geometry, so animated children do not redraw it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the inputs are summarised by primitives and labelKey
	const furniture = useMemo(() => {
		const sxm = (v: number) =>
			box.x0 + ((v - x[0]) / (x[1] - x[0] || 1)) * (box.x1 - box.x0);
		const sym = (v: number) =>
			box.y1 - ((v - y[0]) / (y[1] - y[0] || 1)) * (box.y1 - box.y0);
		return (
			<>
				<g opacity={0.4}>
					{ys.map((v, i) =>
						i === 0 ? null : (
							<PenLine
								key={`gy${v}`}
								seed={`${id}-gy${i}`}
								color="pencil"
								width={0.5}
								from={[box.x0, sym(v)]}
								to={[box.x1, sym(v)]}
							/>
						),
					)}
				</g>
				{ys.map((v, i) => (
					<text
						key={`ty${v}`}
						x={box.x0 - 8}
						y={sym(v)}
						textAnchor="end"
						dominantBaseline="middle"
						className="gb-coord"
						style={{ fill: "var(--gb-secondary,#4a545c)" }}
						fontSize="11"
					>
						{yLabels[i]}
					</text>
				))}
				{xs.map((v, i) => (
					<g key={`x${v}`}>
						<PenLine
							seed={`${id}-tx${i}`}
							color="ink"
							width={1}
							from={[sxm(v), box.y1]}
							to={[sxm(v), box.y1 + 4 + (i % 2) * 0.8]}
						/>
						<text
							x={sxm(v)}
							y={box.y1 + 16}
							textAnchor="middle"
							className="gb-coord"
							style={{ fill: "var(--gb-secondary,#4a545c)" }}
							fontSize="11"
						>
							{xLabels[i]}
						</text>
					</g>
				))}
				<PenLine
					seed={`${id}-axis-x`}
					color="ink"
					width={1.2}
					from={[box.x0 - 4, box.y1]}
					to={[box.x1, box.y1]}
				/>
				<PenLine
					seed={`${id}-axis-y`}
					color="ink"
					width={1.2}
					from={[box.x0, box.y1 + 4]}
					to={[box.x0, box.y0]}
				/>
				{xLabel && (
					<text
						x={(box.x0 + box.x1) / 2}
						y={height - 4}
						textAnchor="middle"
						className="gb-caps"
						style={{ fill: "var(--gb-secondary,#4a545c)" }}
						fontSize="11"
					>
						{xLabel}
					</text>
				)}
				{yLabel && (
					<text
						transform={`translate(11 ${(box.y0 + box.y1) / 2}) rotate(-90)`}
						textAnchor="middle"
						className="gb-caps"
						style={{ fill: "var(--gb-secondary,#4a545c)" }}
						fontSize="11"
					>
						{yLabel}
					</text>
				)}
			</>
		);
	}, [
		id,
		width,
		height,
		x[0],
		x[1],
		y[0],
		y[1],
		xTicks,
		yTicks,
		xLabel,
		yLabel,
		labelKey,
	]);
	return (
		<svg
			viewBox={`0 0 ${width} ${height}`}
			className={`block h-auto w-full ${className ?? ""}`}
			role="img"
			aria-label={
				yLabel && xLabel
					? `${yLabel} vs ${xLabel}`
					: (yLabel ?? xLabel ?? "plot")
			}
		>
			{furniture}
			{children({ x: sx, y: sy, line, area, box })}
		</svg>
	);
}
