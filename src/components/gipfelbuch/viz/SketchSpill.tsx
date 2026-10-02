// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { memo, type ReactNode, useMemo, useRef } from "react";
import { HandDot, SketchPath, SketchPolyline } from "../notebook/Ink";
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

/** A named summit of the figure's scene: u and row are 0..1 frame fractions, as for ridges. */
export type SpillSummit = {
	u: number;
	row: number;
	name: string;
	sub?: string;
	color?: string;
};

const SAMPLES_PER_SIDE = 90;
const MAX_SUMMITS_PER_SIDE = 4;
const SUMMIT_GAP = 6;
const SUMMIT_LEADER = 14;
const RIDGE_INK = `var(--fig-terrain-ink, ${SWISS.contour})`;
const RULER_INK = `var(--fig-horizon-ink, ${SWISS.ink})`;
const KEY_PROBES = [-0.5, 0, 0.25, 0.5, 0.75, 1, 1.5];

const round = (v: number, step: number) => Math.round(v / step) * step;

/** A cheap geometry key of the ruler: the room, the ruler settings and the bearing sampled at a few u. */
export function rulerKey(
	room: { W: number; H: number; L: number; R: number },
	tick: number,
	extent: number,
	bearing: (u: number) => number,
): string {
	const samples = KEY_PROBES.map((u) => round(bearing(u), 1e-3).toFixed(3));
	return [room.W, room.H, room.L, room.R, tick, extent, ...samples].join("|");
}

/** A string hash of a polyline rounded to 0.1 px plus its style, so equal ridges compare equal. */
export function runKey(points: Point[], style: string): string {
	let key = style;
	for (const [x, y] of points)
		key += `|${round(x, 0.1).toFixed(1)},${round(y, 0.1).toFixed(1)}`;
	return key;
}

/**
 * Greedy label declutter in the given order: a label is dropped when its box (name.length * 6.6 + 14 px
 * wide, centred on x) comes within `gap` px of one already placed on the same side, and each side keeps
 * at most `max`. Returns the indices kept.
 */
export function declutterSummits(
	items: { x: number; name: string; side: "left" | "right" }[],
	max = MAX_SUMMITS_PER_SIDE,
	gap = SUMMIT_GAP,
): number[] {
	const kept: number[] = [];
	const count = { left: 0, right: 0 };
	items.forEach((it, i) => {
		if (count[it.side] >= max) return;
		const w = it.name.length * 6.6 + 14;
		const clash = kept.some((k) => {
			const o = items[k];
			if (o.side !== it.side) return false;
			const ow = o.name.length * 6.6 + 14;
			return Math.abs(o.x - it.x) < (w + ow) / 2 + gap;
		});
		if (clash) return;
		count[it.side]++;
		kept.push(i);
	});
	return kept;
}

const RidgeRun = memo(
	function RidgeRun({
		points,
		seed,
		color,
		width,
		dash,
		opacity,
		data,
	}: {
		points: Point[];
		seed: string;
		color: string;
		width: number;
		dash?: string;
		opacity: number;
		data: boolean;
		hash: string;
	}) {
		return (
			<SketchPolyline
				points={points}
				seed={seed}
				color={color}
				width={width}
				dash={dash}
				opacity={opacity}
				data={data}
			/>
		);
	},
	(a, b) => a.hash === b.hash && a.seed === b.seed,
);

export function SketchSpill({
	seed,
	bearing,
	ridges,
	cursor,
	summits,
	reveal = 1,
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
	/** Named summits of the scene: only those in the margins are drawn, in the order given (most important first). */
	summits?: SpillSummit[];
	/** Opacity of the whole spill (0..1), faded with a CSS transition. */
	reveal?: number;
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
					summits={summits}
					reveal={reveal}
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
	summits,
	reveal,
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
	summits?: SpillSummit[];
	reveal: number;
	extent: number;
	tick: number;
	label: (deg: number) => string;
	room: { width: number; left: number; right: number };
	height: number;
}) {
	const W = room.width;
	const H = height;
	const L = Math.min(room.left, extent * W);
	const R = Math.min(room.right, extent * W);
	const boxW = L + W + R;
	const boxH = RULER_BAND + H * 1.08;
	const toU = (x: number) => (x - L) / W;
	const toX = (u: number) => L + u * W;
	const rulerY = RULER_BAND - 9;
	const key = rulerKey({ W, H, L, R }, tick, extent, bearing);
	// the ruler depends on the geometry key, never on the identity of `bearing`
	// biome-ignore lint/correctness/useExhaustiveDependencies: memoised by geometry key
	const ruler = useMemo(() => {
		const ticks: { x: number; deg: number }[] = [];
		let prev = bearing(toU(0));
		for (let x = 1; x <= boxW; x++) {
			const b = bearing(toU(x));
			for (let deg = Math.ceil(prev / tick) * tick; deg <= b; deg += tick)
				if (deg > prev || x === 1)
					ticks.push({ x: x - (b - deg) / (b - prev || 1), deg });
			prev = b;
		}
		const paths = (
			<>
				<SketchPath
					d={`M0 ${rulerY}L${boxW.toFixed(1)} ${rulerY}`}
					seed={`${seed}-ruler`}
					color={RULER_INK}
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
					color={RULER_INK}
					width={0.9}
					opacity={0.65}
					passes={1}
					tolerance={0.4}
				/>
			</>
		);
		return { ticks, paths };
	}, [key, seed]);
	if (!W || !H) return null;
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
	const cx = cursor ? toX(cursor.u) : null;
	const labelled = ruler.ticks.filter((t) => t.deg % (tick * 3) === 0);
	// named summits in the margins, kept clear of each other
	const margin = (summits ?? [])
		.map((s) => ({ ...s, x: toX(s.u), y: RULER_BAND + s.row * H }))
		.filter(
			(s) =>
				(s.u < 0 || s.u > 1) &&
				s.x > 0 &&
				s.x < boxW &&
				s.y - SUMMIT_LEADER > RULER_BAND &&
				s.y < RULER_BAND + H,
		)
		.map((s) => ({
			...s,
			side: s.u < 0 ? ("left" as const) : ("right" as const),
		}));
	const placed = declutterSummits(margin).map((i) => margin[i]);
	return (
		<div
			aria-hidden
			data-testid="gb-sketch-spill"
			className="pointer-events-none absolute -z-10 select-none transition-opacity duration-[420ms] ease-[cubic-bezier(0.33,1,0.68,1)] motion-reduce:transition-none"
			style={{
				left: -L,
				top: -RULER_BAND,
				width: boxW,
				height: boxH,
				maskImage: sides,
				WebkitMaskImage: sides,
				opacity: Math.min(1, Math.max(0, reveal)),
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
						sideRuns(r, layer * 0.07 * H).map((points, j) => {
							const style = {
								color: r.color ?? RIDGE_INK,
								width: (r.width ?? 1.6) * (1 - layer * 0.25),
								dash: layer ? undefined : r.dash,
								opacity: (r.opacity ?? 0.9) * (1 - layer * 0.35),
								data: !layer,
							};
							return (
								<RidgeRun
									// biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
									key={`${k}-${layer}-${j}`}
									points={points}
									seed={`${seed}-ridge-${k}-${layer}-${j}`}
									hash={runKey(points, JSON.stringify(style))}
									{...style}
								/>
							);
						}),
					),
				)}
				{ruler.paths}
				{placed.map((p) => (
					<g key={p.name}>
						<HandDot
							x={p.x}
							y={p.y}
							r={2.6}
							seed={`${seed}-summit-${p.name}`}
							color={p.color ?? RIDGE_INK}
						/>
						<SketchPath
							d={`M${p.x.toFixed(1)} ${(p.y - 3).toFixed(1)}L${p.x.toFixed(1)} ${(p.y - SUMMIT_LEADER).toFixed(1)}`}
							seed={`${seed}-summit-leader-${p.name}`}
							color={p.color ?? RIDGE_INK}
							width={1.1}
							passes={2}
							tolerance={0.5}
						/>
					</g>
				))}
				{cx != null && cx >= 0 && cx <= boxW && (
					<path
						d={`M${cx.toFixed(1)} ${rulerY + 1}l-4 7h8z`}
						fill={SWISS.red}
						data-testid="gb-sketch-spill-cursor"
					/>
				)}
			</svg>
			{labelled.map((t) => (
				<span
					key={t.deg}
					className="nb-num absolute -translate-x-1/2 leading-none whitespace-nowrap text-[10.5px] text-[var(--gb-secondary)]"
					style={{ left: t.x, top: rulerY - 15 }}
				>
					{label(t.deg)}
				</span>
			))}
			{placed.map((p) => (
				<span
					key={p.name}
					data-testid="gb-sketch-spill-summit"
					className="absolute -translate-x-1/2 -translate-y-full text-center leading-none whitespace-nowrap"
					style={{
						left: p.x,
						top: p.y - SUMMIT_LEADER - 2,
						textShadow:
							"0 0 3px var(--gb-paper), 0 0 2px var(--gb-paper), 0 0 1px var(--gb-paper)",
					}}
				>
					<span className="nb-label block text-[12.5px] text-[var(--gb-navy)]">
						{p.name}
					</span>
					{p.sub && (
						<span className="nb-num mt-0.5 block text-[10.5px] text-[var(--gb-secondary)] italic">
							{p.sub}
						</span>
					)}
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
