import type { ReactNode } from "react";

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

/**
 * Minimal responsive SVG plot with axes, ticks and light grid. `children` is a render function that gets
 * scales and returns SVG elements in data space:
 *   <Plot x={[0, 10]} y={[0, 1]} xLabel="px" yLabel="score">
 *     {(s) => <path d={s.line(pts)} stroke="var(--accent)" fill="none" strokeWidth={2} />}
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
	return (
		<svg
			viewBox={`0 0 ${width} ${height}`}
			className={`block h-auto w-full ${className ?? ""}`}
			role="img"
		>
			{ys.map((v) => (
				<g key={`y${v}`}>
					<line
						x1={box.x0}
						x2={box.x1}
						y1={sy(v)}
						y2={sy(v)}
						stroke="rgba(236,230,218,0.07)"
					/>
					<text
						x={box.x0 - 8}
						y={sy(v)}
						textAnchor="end"
						dominantBaseline="middle"
						className="fill-white/40 font-mono"
						fontSize="10"
					>
						{fmtY(v)}
					</text>
				</g>
			))}
			{xs.map((v) => (
				<g key={`x${v}`}>
					<line
						x1={sx(v)}
						x2={sx(v)}
						y1={box.y1}
						y2={box.y1 + 4}
						stroke="rgba(236,230,218,0.3)"
					/>
					<text
						x={sx(v)}
						y={box.y1 + 16}
						textAnchor="middle"
						className="fill-white/40 font-mono"
						fontSize="10"
					>
						{fmtX(v)}
					</text>
				</g>
			))}
			<line
				x1={box.x0}
				x2={box.x1}
				y1={box.y1}
				y2={box.y1}
				stroke="rgba(236,230,218,0.3)"
			/>
			<line
				x1={box.x0}
				x2={box.x0}
				y1={box.y0}
				y2={box.y1}
				stroke="rgba(236,230,218,0.3)"
			/>
			{xLabel && (
				<text
					x={(box.x0 + box.x1) / 2}
					y={height - 4}
					textAnchor="middle"
					className="fill-white/45"
					fontSize="11"
				>
					{xLabel}
				</text>
			)}
			{yLabel && (
				<text
					transform={`translate(11 ${(box.y0 + box.y1) / 2}) rotate(-90)`}
					textAnchor="middle"
					className="fill-white/45"
					fontSize="11"
				>
					{yLabel}
				</text>
			)}
			{children({ x: sx, y: sy, line, area, box })}
		</svg>
	);
}
