// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type ReactNode, useRef } from "react";
import { SketchPath, SketchPolyline } from "../notebook/Ink";
import type { Point } from "../notebook/sketch";
import { SWISS } from "../swiss/inks";
import { RULER_BAND, useRoom } from "./GeoSpill";

// The geo spill for a synthetic scene. A figure that draws an invented skyline as a function of bearing
// (a sweep, a horizon lock, a pose explorer) has no DEM bake to spill, and the real terrain would
// contradict it. So it hands its own model here, and the invented ridge runs on past the frame onto the
// margins in the spill's contour ink, under the same hand compass ruler as `RealPhoto bleed`. The ruler
// reads the figure's own bearings. Because the figure passes the model it is animating (an
// offset, a cursor), the margins move with the frame. Phones get the ruler only, as with GeoSpill.

/**
 * A line of the invented scene: its row (0 = frame top, 1 = frame bottom) at a column u (0 = the frame's
 * left edge, 1 = its right edge; outside 0..1 is the margin), as the figure projects it.
 */
export type SpillRidge = {
	at: (u: number) => number | null;
	/** Paper ink of the line (default the contour brown of terrain). */
	color?: string;
	dash?: string;
	width?: number;
	opacity?: number;
	/** Shade it with two fainter copies below, as the bake's depth-faded ridges. */
	depth?: boolean;
};

const SAMPLES_PER_SIDE = 90;

export function SketchSpill({
	seed,
	bearing,
	ridges,
	cursor,
	extent = 0.5,
	tick = 5,
	label = (deg) => `${deg > 0 ? "+" : ""}${deg}°`,
	children,
}: {
	seed: string;
	/** The figure's bearing (deg) at column u (0..1 across the frame), increasing with u. */
	bearing: (u: number) => number;
	ridges: SpillRidge[];
	/** A column the figure points at (a sweep, a tap): a caret and its bearing on the ruler. */
	cursor?: { u: number; label?: string } | null;
	/** The furthest spill per side, as a fraction of the frame's width. */
	extent?: number;
	/** Ruler tick step (deg); every third tick is lettered. */
	tick?: number;
	label?: (deg: number) => string;
	children: ReactNode;
}) {
	const hostRef = useRef<HTMLDivElement>(null);
	const room = useRoom(hostRef, true);
	return (
		<div
			ref={hostRef}
			className="relative isolate"
			style={{ marginTop: RULER_BAND }}
		>
			{room && (
				<Spill
					seed={seed}
					bearing={bearing}
					ridges={ridges}
					cursor={cursor}
					extent={extent}
					tick={tick}
					label={label}
					room={room}
					height={hostRef.current?.getBoundingClientRect().height ?? 0}
				/>
			)}
			{children}
		</div>
	);
}

function Spill({
	seed,
	bearing,
	ridges,
	cursor,
	extent,
	tick,
	label,
	room,
	height,
}: {
	seed: string;
	bearing: (u: number) => number;
	ridges: SpillRidge[];
	cursor?: { u: number; label?: string } | null;
	extent: number;
	tick: number;
	label: (deg: number) => string;
	room: { width: number; left: number; right: number };
	height: number;
}) {
	const W = room.width;
	const H = height;
	if (!W || !H) return null;
	const L = Math.min(room.left, extent * W);
	const R = Math.min(room.right, extent * W);
	const boxW = L + W + R;
	const boxH = RULER_BAND + H * 1.08;
	const toU = (x: number) => (x - L) / W;
	const toX = (u: number) => L + u * W;
	const rulerY = RULER_BAND - 9;
	const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
	const fadeL = L > 0 ? pct((L * 0.6) / boxW) : "0%";
	const fadeR = R > 0 ? pct(1 - (R * 0.6) / boxW) : "100%";
	const sides = `linear-gradient(to right, transparent, #000 ${fadeL}, #000 ${fadeR}, transparent)`;
	// one side's run of a ridge, cut where the model has no terrain
	const run = (r: SpillRidge, from: number, to: number, dy = 0) => {
		const runs: Point[][] = [];
		let cur: Point[] = [];
		for (let i = 0; i <= SAMPLES_PER_SIDE; i++) {
			const x = from + ((to - from) * i) / SAMPLES_PER_SIDE;
			const v = r.at(toU(x));
			if (v == null || !Number.isFinite(v)) {
				if (cur.length > 1) runs.push(cur);
				cur = [];
				continue;
			}
			cur.push([x, RULER_BAND + v * H + dy]);
		}
		if (cur.length > 1) runs.push(cur);
		return runs;
	};
	// past the frame only: the figure draws its own inside
	const sideRuns = (r: SpillRidge, dy = 0) => [
		...(L > 0 ? run(r, 0, L + 1, dy) : []),
		...(R > 0 ? run(r, L + W - 1, boxW, dy) : []),
	];
	// ticks where the bearing crosses a multiple of `tick`, found per CSS px
	const ticks: { x: number; deg: number }[] = [];
	let prev = bearing(toU(0));
	for (let x = 1; x <= boxW; x++) {
		const b = bearing(toU(x));
		for (let deg = Math.ceil(prev / tick) * tick; deg <= b; deg += tick)
			if (deg > prev || x === 1)
				ticks.push({ x: x - (b - deg) / (b - prev || 1), deg });
		prev = b;
	}
	const cx = cursor ? toX(cursor.u) : null;
	return (
		<div
			aria-hidden
			data-testid="gb-sketch-spill"
			className="pointer-events-none absolute -z-10 select-none"
			style={{
				left: -L,
				top: -RULER_BAND,
				width: boxW,
				height: boxH,
				maskImage: sides,
				WebkitMaskImage: sides,
			}}
		>
			<svg
				className="absolute inset-0 overflow-visible"
				width={boxW}
				height={boxH}
				viewBox={`0 0 ${boxW} ${boxH}`}
				aria-hidden="true"
			>
				{ridges.flatMap((r, k) =>
					(r.depth ? [0, 1, 2] : [0]).flatMap((layer) =>
						sideRuns(r, layer * 0.07 * H).map((points, j) => (
							<SketchPolyline
								// biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
								key={`${k}-${layer}-${j}`}
								points={points}
								seed={`${seed}-ridge-${k}-${layer}-${j}`}
								color={r.color ?? SWISS.contour}
								width={(r.width ?? 1.6) * (1 - layer * 0.25)}
								dash={layer ? undefined : r.dash}
								opacity={(r.opacity ?? 0.9) * (1 - layer * 0.35)}
								data={!layer}
							/>
						)),
					),
				)}
				<SketchPath
					d={`M0 ${rulerY}L${boxW.toFixed(1)} ${rulerY}`}
					seed={`${seed}-ruler`}
					color={SWISS.ink}
					width={0.9}
					opacity={0.55}
					passes={2}
					tolerance={0.9}
				/>
				<SketchPath
					d={ticks
						.map(
							(t) =>
								`M${t.x.toFixed(1)} ${rulerY}L${t.x.toFixed(1)} ${rulerY + (t.deg % (tick * 3) === 0 ? 6 : 3.5)}`,
						)
						.join("")}
					seed={`${seed}-ticks`}
					color={SWISS.ink}
					width={0.9}
					opacity={0.65}
					passes={1}
					tolerance={0.4}
				/>
				{cx != null && cx >= 0 && cx <= boxW && (
					<path
						d={`M${cx.toFixed(1)} ${rulerY + 1}l-4 7h8z`}
						fill={SWISS.red}
						data-testid="gb-sketch-spill-cursor"
					/>
				)}
			</svg>
			{ticks
				.filter((t) => t.deg % (tick * 3) === 0)
				.map((t) => (
					<span
						key={t.deg}
						className="nb-num absolute -translate-x-1/2 leading-none whitespace-nowrap text-[10.5px] text-[var(--gb-secondary)]"
						style={{ left: t.x, top: rulerY - 15 }}
					>
						{label(t.deg)}
					</span>
				))}
			{cursor && cx != null && cx >= 0 && cx <= boxW && (
				<span
					className="nb-num absolute -translate-x-1/2 leading-none whitespace-nowrap text-[11px] font-semibold text-[var(--gb-red)]"
					style={{
						left: cx,
						top: rulerY - 15,
						textShadow:
							"0 0 3px var(--gb-paper), 0 0 2px var(--gb-paper), 0 0 1px var(--gb-paper)",
					}}
				>
					{cursor.label ?? label(Math.round(bearing(cursor.u)))}
				</span>
			)}
		</div>
	);
}
