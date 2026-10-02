// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type ReactNode, useId, useMemo } from "react";
import {
	Hachure,
	type InkColor,
	inkColor,
	PenArrow,
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

/** A data series on a Plot: one hand pen pass within DATA_TOLERANCE of the data (hand pass), 1.6 px. */
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
 * Minimal responsive SVG plot drawn by hand: two pen axes that stop short of the origin, short pen ticks,
 * hand tick figures, hand axis titles with a small arrow, and a faint dashed pencil grid on y only. `children` is a render function that gets
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
		// Axes stop short of the corner (a hand never closes the origin) and overshoot a little at the far end.
		const gapAtOrigin = 5;
		const tickPath = [
			...xs.map(
				(v, i) =>
					`M${sxm(v).toFixed(1)} ${box.y1 + 1}L${(sxm(v) + (i % 2 ? 0.6 : -0.4)).toFixed(1)} ${box.y1 + 5 + (i % 3) * 0.6}`,
			),
			...ys.map(
				(v, i) =>
					`M${box.x0 - 1} ${sym(v).toFixed(1)}L${box.x0 - 5 - (i % 3) * 0.6} ${(sym(v) + (i % 2 ? 0.5 : -0.3)).toFixed(1)}`,
			),
		].join("");
		const xMid = (box.x0 + box.x1) / 2;
		const yMid = (box.y0 + box.y1) / 2;
		return (
			<>
				<g opacity={0.5}>
					{ys.map((v, i) =>
						i === 0 ? null : (
							<SketchPath
								key={`gy${v}`}
								seed={`${id}-gy${i}`}
								d={`M${box.x0 + 3} ${sym(v)}L${box.x1} ${sym(v)}`}
								color="pencil"
								width={0.6}
								passes={1}
								tolerance={0.7}
								dash="2 5"
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
						className="nb-num"
						style={{ fill: "var(--gb-secondary,#4a545c)" }}
						fontSize="12"
					>
						{yLabels[i]}
					</text>
				))}
				{xs.map((v, i) => (
					<text
						key={`x${v}`}
						x={sxm(v)}
						y={box.y1 + 17}
						textAnchor="middle"
						className="nb-num"
						style={{ fill: "var(--gb-secondary,#4a545c)" }}
						fontSize="12"
					>
						{xLabels[i]}
					</text>
				))}
				<SketchPath
					seed={`${id}-ticks`}
					d={tickPath}
					color="ink"
					width={1}
					passes={1}
					tolerance={0.4}
				/>
				<SketchPath
					seed={`${id}-axis-x`}
					d={`M${box.x0 + gapAtOrigin} ${box.y1}L${box.x1 + 3} ${box.y1}`}
					color="ink"
					width={1.3}
					passes={2}
					tolerance={1}
				/>
				<SketchPath
					seed={`${id}-axis-y`}
					d={`M${box.x0} ${box.y1 - gapAtOrigin}L${box.x0} ${box.y0 - 3}`}
					color="ink"
					width={1.3}
					passes={2}
					tolerance={1}
				/>
				{xLabel && (
					<g>
						<text
							x={xMid}
							y={height - 3}
							textAnchor="middle"
							className="nb-hand"
							style={{ fill: "var(--gb-pencil,#49423d)" }}
							fontSize="17"
						>
							{xLabel}
						</text>
						{xMid + xLabel.length * 3.6 + 30 < width && (
							<PenArrow
								seed={`${id}-xlabel-arrow`}
								from={[xMid + xLabel.length * 3.6 + 6, height - 8]}
								to={[xMid + xLabel.length * 3.6 + 28, height - 9]}
								bend={0.1}
								head={5}
								color="pencil"
								width={1}
							/>
						)}
					</g>
				)}
				{yLabel && (
					<g>
						<text
							transform={`translate(13 ${yMid}) rotate(-90)`}
							textAnchor="middle"
							className="nb-hand"
							style={{ fill: "var(--gb-pencil,#49423d)" }}
							fontSize="17"
						>
							{yLabel}
						</text>
						{yMid - yLabel.length * 3.6 - 28 > 0 && (
							<PenArrow
								seed={`${id}-ylabel-arrow`}
								from={[8, yMid - yLabel.length * 3.6 - 6]}
								to={[7, yMid - yLabel.length * 3.6 - 26]}
								bend={0.1}
								head={5}
								color="pencil"
								width={1}
							/>
						)}
					</g>
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
