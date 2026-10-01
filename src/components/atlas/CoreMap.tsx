// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { byId, groupColor, STATUS_META } from "#/lib/atlas/graph-utils";
import type { AtlasGroup } from "#/lib/atlas/types";
import { useReducedMotion } from "./viz/hooks";

// The curated core of the Atlas as a hand-laid map: three lanes (how the viewport is inferred, how
// things are pinned to the terrain, what the app does with the pose), real data-flow edges only.
// Layout is deliberate, not simulated: left → right is the order the pipeline runs.

type Lane = "infer" | "terrain" | "app";
interface Spot {
	id: string;
	/** Short label for the map (the node title can be long). */
	label: string;
	col: number;
	row: number;
	lane: Lane;
}
type EdgeKind = "flow" | "snap" | "cross" | "fallback";
interface Edge {
	from: string;
	to: string;
	kind?: EdgeKind;
	label?: string;
}

const COL_W = 196;
const X0 = 100;
const NODE_W = 150;
const NODE_H = 38;
const LANES: {
	id: Lane;
	title: string;
	sub: string;
	hub?: string;
	y0: number;
	y1: number;
	group: AtlasGroup;
}[] = [
	{
		id: "infer",
		title: "Viewport inference",
		sub: "Where is the camera looking? yaw · pitch · roll · focal",
		hub: "viewport-inference",
		y0: 40,
		y1: 250,
		group: "solve",
	},
	{
		id: "terrain",
		title: "Terrain & snapping",
		sub: "The DEM, and everything pinned to it",
		hub: "terrain-snapping",
		y0: 266,
		y1: 476,
		group: "world",
	},
	{
		id: "app",
		title: "The app",
		sub: "What the solved pose is for",
		hub: "rigi",
		y0: 492,
		y1: 640,
		group: "render",
	},
];
const ROW_Y: Record<Lane, number[]> = {
	infer: [118, 200],
	terrain: [334, 440],
	app: [588],
};

const SPOTS: Spot[] = [
	// Viewport inference: prior + observation → horizon match → gate → pose
	{ id: "photo", label: "Photo", col: 0, row: 0, lane: "infer" },
	{ id: "skyline", label: "Photo skyline", col: 1, row: 0, lane: "infer" },
	{ id: "camera-prior", label: "Sensor prior", col: 1, row: 1, lane: "infer" },
	{
		id: "baseline-pipeline",
		label: "Horizon match",
		col: 3,
		row: 0,
		lane: "infer",
	},
	{ id: "accept-rule", label: "Accept gate", col: 4, row: 0, lane: "infer" },
	{ id: "pose-estimate", label: "Pose", col: 5, row: 0, lane: "infer" },
	{ id: "tap-a-peak", label: "Tap-a-peak", col: 4, row: 1, lane: "infer" },
	// Terrain: tiles → sampler → horizon; the three snaps fan out beneath the sampler
	{ id: "dem-source", label: "DEM", col: 0, row: 0, lane: "terrain" },
	{
		id: "terrain-sampler",
		label: "Height sampler",
		col: 2,
		row: 0,
		lane: "terrain",
	},
	{ id: "dem-horizon", label: "DEM horizon", col: 3, row: 0, lane: "terrain" },
	{
		id: "dem-anchoring",
		label: "Depth on DEM",
		col: 1,
		row: 1,
		lane: "terrain",
	},
	{ id: "peak", label: "Peak on summit", col: 2, row: 1, lane: "terrain" },
	{ id: "eye-rule", label: "Eye on ground", col: 3, row: 1, lane: "terrain" },
	// App (the lane title links to Rigi itself)
	{ id: "step-inside", label: "Step Inside", col: 1, row: 0, lane: "app" },
	{ id: "photo-workspace", label: "Overlay", col: 2, row: 0, lane: "app" },
	{ id: "camera-roll", label: "Camera roll", col: 3, row: 0, lane: "app" },
];

const EDGES: Edge[] = [
	{ from: "photo", to: "skyline" },
	{ from: "photo", to: "camera-prior", label: "gravity · compass · 35 mm" },
	{ from: "skyline", to: "baseline-pipeline", label: "observed" },
	{ from: "camera-prior", to: "baseline-pipeline", label: "seed" },
	{ from: "baseline-pipeline", to: "accept-rule" },
	{ from: "accept-rule", to: "pose-estimate" },
	{
		from: "accept-rule",
		to: "tap-a-peak",
		kind: "fallback",
		label: "rejected",
	},
	{ from: "tap-a-peak", to: "pose-estimate", kind: "fallback" },
	// terrain
	{ from: "dem-source", to: "terrain-sampler" },
	{ from: "terrain-sampler", to: "dem-horizon" },
	{
		from: "terrain-sampler",
		to: "dem-anchoring",
		kind: "snap",
		label: "depth ↔ DEM",
	},
	{ from: "terrain-sampler", to: "peak", kind: "snap", label: "local max" },
	{
		from: "terrain-sampler",
		to: "eye-rule",
		kind: "snap",
		label: "DEM + 1.6 m",
	},
	{ from: "eye-rule", to: "dem-horizon", label: "ray origin" },
	// the two worlds meet
	{
		from: "dem-horizon",
		to: "baseline-pipeline",
		kind: "cross",
		label: "predicted",
	},
	{
		from: "pose-estimate",
		to: "photo-workspace",
		kind: "cross",
		label: "pose",
	},
	{ from: "peak", to: "photo-workspace", kind: "cross", label: "labels" },
	{ from: "dem-anchoring", to: "step-inside", kind: "cross" },
	// app
	{ from: "photo-workspace", to: "step-inside" },
	{ from: "photo-workspace", to: "camera-roll" },
];

const SPOT_BY_ID = new Map(SPOTS.map((s) => [s.id, s]));
const pos = (s: Spot) => ({
	x: X0 + s.col * COL_W,
	y: ROW_Y[s.lane][s.row],
});

const EDGE_STYLE: Record<
	EdgeKind,
	{ color: string; dash?: string; width: number; opacity: number }
> = {
	flow: { color: "rgba(236,230,218,1)", width: 1.3, opacity: 0.28 },
	cross: { color: "var(--rigi-glow, #f2c46d)", width: 1.6, opacity: 0.55 },
	snap: { color: "#8fc08a", dash: "5 4", width: 1.8, opacity: 0.85 },
	fallback: {
		color: "rgba(236,230,218,1)",
		dash: "2 4",
		width: 1.2,
		opacity: 0.32,
	},
};

/** Box-edge to box-edge cubic: horizontal when the target is to the side, vertical otherwise. */
function edgePath(a: Spot, b: Spot, kind: EdgeKind = "flow") {
	const p = pos(a);
	const q = pos(b);
	const dx = q.x - p.x;
	const dy = q.y - p.y;
	const hw = NODE_W / 2;
	const hh = NODE_H / 2;
	// Within a lane edges run sideways; between lanes they drop vertically so they never cut across a row.
	if (a.lane === b.lane && kind !== "snap" && Math.abs(dx) >= NODE_W * 0.9) {
		const s = Math.sign(dx);
		const x1 = p.x + s * hw;
		const x2 = q.x - s * hw;
		const k = Math.max(24, Math.abs(x2 - x1) * 0.45);
		return `M${x1},${p.y} C${x1 + s * k},${p.y} ${x2 - s * k},${q.y} ${x2},${q.y}`;
	}
	const s = Math.sign(dy) || 1;
	const y1 = p.y + s * hh;
	const y2 = q.y - s * hh;
	const k = Math.max(16, Math.abs(y2 - y1) * 0.45);
	return `M${p.x},${y1} C${p.x},${y1 + s * k} ${q.x},${y2 - s * k} ${q.x},${y2}`;
}

function edgeMid(a: Spot, b: Spot) {
	const p = pos(a);
	const q = pos(b);
	return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
}

/** Everything upstream and downstream of `id` along the curated edges. */
function lineage(id: string) {
	const out = new Set<string>([id]);
	const walk = (dir: "from" | "to") => {
		const stack = [id];
		while (stack.length) {
			const cur = stack.pop() as string;
			for (const e of EDGES) {
				const [a, b] = dir === "from" ? [e.from, e.to] : [e.to, e.from];
				if (a === cur && !out.has(b)) {
					out.add(b);
					stack.push(b);
				}
			}
		}
	};
	walk("from");
	walk("to");
	return out;
}

/** The headline map on /atlas: the core concepts only, laid out as the pipeline runs. */
export function CoreMap({ className }: { className?: string }) {
	const navigate = useNavigate();
	const reduce = useReducedMotion();
	const [hover, setHover] = useState<string | null>(null);
	const lit = useMemo(() => (hover ? lineage(hover) : null), [hover]);
	const open = (id: string) =>
		byId.has(id) &&
		navigate({ to: "/atlas/$concept", params: { concept: id } });
	const info = hover ? byId.get(hover) : undefined;

	return (
		<div className={className} data-testid="atlas-core-map">
			<div className="overflow-x-auto overscroll-x-contain">
				<svg
					viewBox="0 0 1180 650"
					className="block h-auto w-full min-w-[860px]"
					role="img"
					aria-label="Core map of Rigi: viewport inference, terrain and snapping, and the app"
				>
					<defs>
						<marker
							id="cm-arrow"
							viewBox="0 0 8 8"
							refX="7"
							refY="4"
							markerWidth="6"
							markerHeight="6"
							orient="auto-start-reverse"
						>
							<path d="M0,0 L8,4 L0,8 z" fill="rgba(236,230,218,0.55)" />
						</marker>
					</defs>

					{LANES.map((l) => {
						const c = groupColor(l.group);
						const hub = l.hub && byId.has(l.hub) ? l.hub : undefined;
						return (
							<g key={l.id}>
								<rect
									x={8}
									y={l.y0}
									width={1164}
									height={l.y1 - l.y0}
									rx={14}
									fill={c}
									fillOpacity={0.045}
									stroke={c}
									strokeOpacity={0.18}
								/>
								<LinkOrG id={hub} onOpen={open}>
									<text
										x={26}
										y={l.y0 + 26}
										fill={c}
										className="display-title"
										fontSize={19}
										fontWeight={700}
									>
										{l.title}
										{hub ? " →" : ""}
									</text>
									<text
										x={26}
										y={l.y0 + 44}
										fill="rgba(236,230,218,0.45)"
										fontSize={11.5}
										fontStyle="italic"
									>
										{l.sub}
									</text>
								</LinkOrG>
							</g>
						);
					})}

					{EDGES.map((e) => {
						const a = SPOT_BY_ID.get(e.from);
						const b = SPOT_BY_ID.get(e.to);
						if (!a || !b) return null;
						const st = EDGE_STYLE[e.kind ?? "flow"];
						const on = !lit || (lit.has(e.from) && lit.has(e.to));
						const d = edgePath(a, b, e.kind);
						const m = edgeMid(a, b);
						return (
							<g
								key={`${e.from}>${e.to}`}
								opacity={on ? 1 : 0.12}
								className="transition-opacity duration-300"
							>
								<path
									d={d}
									fill="none"
									stroke={st.color}
									strokeOpacity={
										lit && on ? Math.min(1, st.opacity + 0.35) : st.opacity
									}
									strokeWidth={st.width}
									strokeDasharray={st.dash}
									markerEnd="url(#cm-arrow)"
								>
									{e.kind === "snap" && !reduce && (
										<animate
											attributeName="stroke-dashoffset"
											from="18"
											to="0"
											dur="1.2s"
											repeatCount="indefinite"
										/>
									)}
								</path>
								{(e.kind === "cross" || (e.kind ?? "flow") === "flow") &&
									!reduce && (
										<circle r={2.2} fill={st.color} opacity={0.75}>
											<animateMotion
												dur={`${2.6 + ((e.from.length + e.to.length) % 7) * 0.35}s`}
												repeatCount="indefinite"
												path={d}
											/>
										</circle>
									)}
								{e.label && (
									<text
										x={m.x}
										y={m.y - 5}
										textAnchor="middle"
										fontSize={9.5}
										fill={
											e.kind === "snap" ? "#a9d6a4" : "rgba(236,230,218,0.5)"
										}
										className="font-mono"
										paintOrder="stroke"
										stroke="var(--rigi-ink, #0e1012)"
										strokeWidth={3}
									>
										{e.label}
									</text>
								)}
							</g>
						);
					})}

					{SPOTS.map((s) => {
						const n = byId.get(s.id);
						const { x, y } = pos(s);
						const c = n ? groupColor(n.group) : "#999";
						const on = !lit || lit.has(s.id);
						const focus = hover === s.id;
						const killed = n?.status === "killed";
						const research =
							n?.status === "research" || n?.status === "flagged";
						return (
							<a
								key={s.id}
								href={`/atlas/${s.id}`}
								className="cursor-pointer outline-none"
								aria-label={n ? `${n.title}: ${n.tagline}` : s.label}
								onMouseEnter={() => setHover(s.id)}
								onMouseLeave={() => setHover(null)}
								onFocus={() => setHover(s.id)}
								onBlur={() => setHover(null)}
								onClick={(ev) => {
									ev.preventDefault();
									open(s.id);
								}}
							>
								<g
									transform={`translate(${x - NODE_W / 2},${y - NODE_H / 2})`}
									opacity={on ? 1 : 0.22}
									className="transition-opacity duration-300"
								>
									<rect
										width={NODE_W}
										height={NODE_H}
										rx={NODE_H / 2}
										fill="var(--rigi-ink, #0e1012)"
									/>
									<rect
										width={NODE_W}
										height={NODE_H}
										rx={NODE_H / 2}
										fill={c}
										fillOpacity={focus ? 0.32 : research ? 0.06 : 0.14}
										stroke={c}
										strokeOpacity={focus ? 1 : 0.7}
										strokeWidth={focus ? 1.8 : 1.1}
										strokeDasharray={
											killed ? "3 3" : research ? "4 2" : undefined
										}
									/>
									<circle cx={16} cy={NODE_H / 2} r={3.4} fill={c} />
									<text
										x={28}
										y={NODE_H / 2 + 4.5}
										fontSize={13.5}
										fontWeight={600}
										fill="var(--rigi-paper, #ece6da)"
									>
										{s.label}
									</text>
								</g>
							</a>
						);
					})}
				</svg>
			</div>

			<div className="flex min-h-[64px] flex-wrap items-start gap-x-8 gap-y-2 px-4 pt-3 pb-1 sm:px-6">
				{info ? (
					<div className="max-w-3xl">
						<p className="text-[15px] font-semibold text-[var(--rigi-paper)]">
							{info.title}
							<span
								className="ml-3 font-mono text-[10.5px] font-normal tracking-[0.1em] uppercase"
								style={{ color: STATUS_META[info.status].color }}
							>
								{STATUS_META[info.status].label}
							</span>
						</p>
						<p className="mt-0.5 text-[13px] text-white/55 italic">
							{info.tagline}
						</p>
					</div>
				) : (
					<Legend />
				)}
			</div>
		</div>
	);
}

/** Client-side link inside the SVG when the target concept exists, a plain group otherwise. */
function LinkOrG({
	id,
	onOpen,
	children,
}: {
	id?: string;
	onOpen: (id: string) => void;
	children: React.ReactNode;
}) {
	if (!id) return <g>{children}</g>;
	return (
		<a
			href={`/atlas/${id}`}
			className="cursor-pointer"
			onClick={(ev) => {
				ev.preventDefault();
				onOpen(id);
			}}
		>
			{children}
		</a>
	);
}

function Legend() {
	const items: { k: EdgeKind; label: string }[] = [
		{ k: "flow", label: "data flow" },
		{ k: "cross", label: "terrain meets photo" },
		{ k: "snap", label: "snapped to the DEM" },
		{ k: "fallback", label: "fallback path" },
	];
	return (
		<div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 font-mono text-[10.5px] text-white/45">
			{items.map((i) => {
				const st = EDGE_STYLE[i.k];
				return (
					<span key={i.k} className="flex items-center gap-2">
						<svg width="26" height="6" aria-hidden="true">
							<line
								x1="0"
								y1="3"
								x2="26"
								y2="3"
								stroke={st.color}
								strokeOpacity={Math.max(0.5, st.opacity)}
								strokeWidth={st.width + 0.4}
								strokeDasharray={st.dash}
							/>
						</svg>
						{i.label}
					</span>
				);
			})}
			<span className="text-white/30">
				Hover a concept to trace what feeds it and what it feeds; click to open
				it.
			</span>
		</div>
	);
}
