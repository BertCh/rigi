// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import {
	Hachure,
	HandDot,
	HandText,
	type InkColor,
	inkColor,
	PenArrow,
	PenCircle,
	PenLine,
	SketchPath,
	SketchRect,
} from "#/components/gipfelbuch/notebook/Ink";
import { HandMark, Wash } from "#/components/gipfelbuch/notebook/marks";
import { useNotebookPhoto } from "#/components/gipfelbuch/notebook/useNotebookPhoto";
import { SWISS } from "#/components/gipfelbuch/swiss/palette";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import {
	Callout,
	CodeRef,
	DemPatch,
	Eq,
	Figure,
	type GipfelbuchPhotoData,
	HandLabel,
	HandRange,
	LAYER_STYLE,
	LiveDrape,
	MarginNote,
	RealPhoto,
	Steps,
	StoryMap,
	Sym,
	useGipfelbuchPhoto,
	useTime,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Details,
	Gallery,
	Numbers,
	Stages,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { SketchSpill } from "#/components/gipfelbuch/viz/SketchSpill";
import { RollCompasses } from "#/components/site/meta/RollCompasses";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// Camera Roll: how a day's photos become a place. Everything below follows the real code:
//   src/lib/roll/roll.ts        ROLL_LINK_M = 15 000 m (single-linkage), VIEWPOINT_RADIUS_M = 250 m (first match wins,
//                               then re-centre on the members), resolvePose order saved > ground-truth > solved > prior
//   src/lib/roll/align/viewpoint.ts  BIAS_WINDOW_S 45 min, MIN_BIAS_DEG 1, MAX_BIAS_DEG 90, median of anchor yaw offsets
//   src/lib/roll/mosaic/panorama.ts  photo = subdivided mesh of (u,v) rays on an azimuth x elevation canvas
// The scenes are synthetic and deterministic; every grouping, median and warp is computed with the code's rules.

const D = Math.PI / 180;
const LINK_M = 15_000;
const VP_M = 250;
const BIAS_WINDOW_MIN = 45;
const MIN_BIAS = 1;
const MAX_BIAS = 90;
const SEARCH_YAW = 25; // the cascade's local yaw window (src/lib/geo/solve.ts yawRange)

/** Roll colours as notebook inks: the first roll is the one red emphasis. */
const PAL = ["red", "navy", "forest", "brown"] as const;
const lineD = (x1: number, y1: number, x2: number, y2: number) =>
	`M${x1} ${y1}L${x2} ${y2}`;
/** A station triangle (surveyor's mark) centred on x, y. */
const stationD = (x: number, y: number, r: number) =>
	`M${x} ${y - r}L${x + r * 0.9} ${y + r * 0.7}L${x - r * 0.9} ${y + r * 0.7}Z`;
/** A label written along a ray from (x, y) at compass yaw `deg`, set `side` px off the ray. */
function RayLabel({
	x,
	y,
	deg,
	at,
	side = -5,
	color = "ink",
	size = 13,
	children,
}: {
	x: number;
	y: number;
	deg: number;
	at: number;
	side?: number;
	color?: InkColor;
	size?: number;
	children: ReactNode;
}) {
	const a = deg * D;
	const nx = Math.cos(a);
	const ny = Math.sin(a);
	let rot = deg - 90;
	// keep the text upright; `side` stays on the same geometric side of the ray
	if (Math.cos(rot * D) < 0) rot += 180;
	const off = side;
	const lx = x + at * Math.sin(a) + off * nx;
	const ly = y - at * Math.cos(a) + off * ny;
	return (
		<HandLabel
			x={lx}
			y={ly}
			anchor="middle"
			size={size <= 12 ? 11 : 13}
			color={inkColor(color)}
			rotate={rot}
		>
			{children}
		</HandLabel>
	);
}
const CHIP_ON =
	"bg-[var(--nb-highlight,var(--accent))] text-[var(--gb-ink)] underline decoration-[var(--nb-red)] decoration-2 underline-offset-4";
const CHIP_OFF = "bg-[var(--nb-paper-deep)] gb-secondary";

const angDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;
const fmt = (v: number, d = 0) =>
	`${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;

function Slider({
	label,
	value,
	min,
	max,
	step,
	unit,
	onChange,
	signed,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	unit: string;
	onChange: (v: number) => void;
	signed?: boolean;
}) {
	return (
		<div className="block">
			<span
				className={`flex justify-between gap-3 font-mono ${TYPE.micro} gb-secondary`}
			>
				<span>{label}</span>
				<span className="text-[var(--gb-ink)]">
					{signed
						? fmt(value, step < 1 ? 1 : 0)
						: value.toFixed(step < 1 ? 1 : 0)}
					{unit}
				</span>
			</span>
			<HandRange
				value={value}
				min={min}
				max={max}
				step={step}
				label={label}
				onChange={onChange}
			/>
		</div>
	);
}

function Chip({
	on,
	onClick,
	children,
}: {
	on: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={on}
			onClick={onClick}
			className={`px-3 py-1 font-mono ${TYPE.micro} transition ${on ? CHIP_ON : CHIP_OFF}`}
		>
			{children}
		</button>
	);
}

// ======================================================================================
// D1 — single-linkage: a day's photos become areas
// ======================================================================================
type Km = { x: number; y: number };
const HIKE: Km[] = [
	{ x: 1.0, y: 8.8 },
	{ x: 1.3, y: 8.5 },
	{ x: 2.6, y: 7.6 },
	{ x: 3.9, y: 8.3 },
	{ x: 4.2, y: 8.1 },
	{ x: 5.4, y: 6.7 },
	{ x: 6.1, y: 7.1 },
	{ x: 6.4, y: 9.4 },
];
const VALLEY: Km[] = [
	{ x: 23.5, y: 7.8 },
	{ x: 24.2, y: 7.3 },
	{ x: 25.9, y: 8.7 },
	{ x: 26.3, y: 8.4 },
];
const PASS: Km = { x: 14.8, y: 8.0 };
const KS = 20; // px per km
const dist = (a: Km, b: Km) => Math.hypot(a.x - b.x, a.y - b.y);

/** roll.ts clusterPhotos: union-find over every pair closer than the link distance. */
function cluster(pts: Km[], linkKm: number) {
	const parent = pts.map((_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) i = parent[i];
		return i;
	};
	const links: [number, number][] = [];
	for (let i = 0; i < pts.length; i++)
		for (let j = i + 1; j < pts.length; j++)
			if (dist(pts[i], pts[j]) < linkKm) {
				parent[find(i)] = find(j);
				links.push([i, j]);
			}
	const groups = new Map<number, number[]>();
	pts.forEach((_, i) => {
		const r = find(i);
		const g = groups.get(r);
		if (g) g.push(i);
		else groups.set(r, [i]);
	});
	const list = [...groups.values()].sort((a, b) => b.length - a.length);
	const label = new Array<number>(pts.length).fill(0);
	list.forEach((g, k) => {
		for (const i of g) label[i] = k;
	});
	return { list, label, links };
}

const LINKER_CONTOURS = [0, 1, 2, 3, 4, 5, 6].map(
	(k) =>
		`M0 ${30 + k * 34} ${Array.from({ length: 33 }, (_, i) => `L${i * 20} ${(30 + k * 34 + 14 * Math.sin(i * 0.5 + k * 1.3) + 8 * Math.sin(i * 0.19 + k)).toFixed(1)}`).join("")}`,
);

const HIKE_TRACK = HIKE.map(
	(p, i) => `${i ? "L" : "M"}${p.x * KS} ${p.y * KS}`,
).join("");

// Label sizes for the three 640-wide schematic figures: 11 and 13 px rendered at the text column (~720 px).
const FIG_W = 640;
const FIG_LABEL_SMALL = Math.round(((11 * FIG_W) / 720) * 2) / 2;
const FIG_LABEL = Math.round(((13 * FIG_W) / 720) * 2) / 2;

function RollLinker() {
	const [ref, t] = useTime<HTMLDivElement>(3);
	const [linkKm, setLinkKm] = useState(LINK_M / 1000);
	const [pass, setPass] = useState(false);
	const pts = pass ? [...HIKE, ...VALLEY, PASS] : [...HIKE, ...VALLEY];
	const { list, label, links } = cluster(pts, linkKm);
	const info = list.map((g) => {
		const c = {
			x: g.reduce((s, i) => s + pts[i].x, 0) / g.length,
			y: g.reduce((s, i) => s + pts[i].y, 0) / g.length,
		};
		return { n: g.length, c, r: Math.max(...g.map((i) => dist(c, pts[i]))) };
	});
	return (
		<Figure
			label="D1"
			bleed
			source="Skizze"
			caption="Invented points. Photos closer than the link distance are joined, and a roll is a connected group. At the real 15 km, a day's hike stays one roll and a valley 17 km further on opens another. A photo at the pass shows the chain effect: each photo only needs one near neighbour."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<svg
					viewBox="0 0 640 240"
					className="block h-auto w-full"
					role="img"
					aria-label="Photo locations on a map, linked into rolls by single-linkage distance"
				>
					<title>Photo locations linked into rolls</title>
					{/* quiet contour backdrop, in pencil */}
					{LINKER_CONTOURS.map((d, k) => (
						<SketchPath
							key={d}
							d={d}
							seed={`rl-contour-${k}`}
							color="brown"
							width={0.8}
							opacity={0.28}
							passes={1}
						/>
					))}
					{/* the GPS track, dotted */}
					<SketchPath
						d={HIKE_TRACK}
						seed="rl-track"
						color="pencil"
						width={1.1}
						dash="2 5"
						passes={1}
					/>
					{/* the link distance, as a surveyor's dimension line */}
					<PenLine
						from={[20, 226]}
						to={[20 + linkKm * KS, 226]}
						seed="rl-scale"
						width={1.5}
					/>
					<PenLine
						from={[20, 220]}
						to={[20, 232]}
						seed="rl-scale-a"
						width={1.3}
					/>
					<PenLine
						from={[20 + linkKm * KS, 220]}
						to={[20 + linkKm * KS, 232]}
						seed="rl-scale-b"
						width={1.3}
					/>
					<HandLabel
						x={28 + linkKm * KS}
						y={230}
						size={FIG_LABEL}
						color={SWISS.secondary}
					>
						{`link < ${linkKm.toFixed(0)} km`}
					</HandLabel>
					{/* links: the dashes crawl along the pen line */}
					<g strokeDashoffset={-t * 8}>
						{links.map(([i, j]) => (
							<SketchPath
								key={`${i}-${j}`}
								d={lineD(
									pts[i].x * KS,
									pts[i].y * KS,
									pts[j].x * KS,
									pts[j].y * KS,
								)}
								seed={`rl-link-${pts[i].x}-${pts[i].y}-${pts[j].x}`}
								color={PAL[label[i] % PAL.length]}
								width={1.2}
								opacity={0.7}
								dash="4 4"
								passes={1}
							/>
						))}
					</g>
					{/* roll hulls: an open pen loop and a hand label */}
					{info.map((r, k) => (
						<g key={`roll-${PAL[k % PAL.length]}-${r.n}-${r.c.x.toFixed(1)}`}>
							<PenCircle
								center={[r.c.x * KS, r.c.y * KS]}
								radiusX={Math.max(10, r.r * KS + 12)}
								seed={`rl-hull-${k}`}
								color={PAL[k % PAL.length]}
								width={1.4}
							/>
							<HandLabel
								x={r.c.x * KS}
								y={r.c.y * KS - Math.max(10, r.r * KS + 12) - 6}
								anchor="middle"
								size={FIG_LABEL}
								color={inkColor(PAL[k % PAL.length])}
							>
								{`roll ${k + 1} · ${r.n} photo${r.n > 1 ? "s" : ""}`}
							</HandLabel>
						</g>
					))}
					{pts.map((p, i) => (
						<HandDot
							key={`${p.x}-${p.y}`}
							x={p.x * KS}
							y={p.y * KS}
							r={i >= HIKE.length + VALLEY.length ? 5 : 3.6}
							seed={`rl-pt-${p.x}-${p.y}`}
							color={PAL[label[i] % PAL.length]}
							opacity={1}
						/>
					))}
					<HandText x={150} y={44} size={15} color="pencil">
						at 15 km a whole hike is one roll
					</HandText>
					<PenArrow
						from={[205, 54]}
						to={[130, 120]}
						seed="rl-note-hike"
						color="pencil"
						width={1.1}
					/>
					<HandText x={400} y={44} size={15} color="pencil">
						the valley, 17 km on: its own roll
					</HandText>
					<PenArrow
						from={[470, 54]}
						to={[490, 132]}
						seed="rl-note-valley"
						color="pencil"
						width={1.1}
					/>
					{pass && (
						<HandText
							x={PASS.x * KS}
							y={PASS.y * KS + 20}
							anchor="middle"
							size={13}
							color="pencil"
						>
							photo at the pass
						</HandText>
					)}
				</svg>
			</div>
			<div className="mt-4 grid items-end gap-4 md:grid-cols-[1fr_auto]">
				<Slider
					label="link distance"
					value={linkKm}
					min={1}
					max={30}
					step={1}
					unit=" km"
					onChange={setLinkKm}
				/>
				<div className="flex flex-wrap gap-2">
					<Chip on={pass} onClick={() => setPass(!pass)}>
						{pass ? "pass photo: on" : "add a photo at the pass"}
					</Chip>
					<Chip on={false} onClick={() => setLinkKm(LINK_M / 1000)}>
						reset to 15 km
					</Chip>
				</div>
			</div>
			<p className={`mt-3 font-mono ${TYPE.micro} gb-secondary`}>
				{info.length} roll{info.length > 1 ? "s" : ""} ·{" "}
				{info.map((r) => r.n).join(" + ")} photos
			</p>
		</Figure>
	);
}

// ======================================================================================
// Fig. 2 — viewpoints: a walk, grouped by "first viewpoint within 250 m"
// ======================================================================================
const VS = 0.78; // px per metre
const WALK: { x: number; y: number; name: string }[] = [
	{ x: 170, y: 140, name: "a" },
	{ x: 250, y: 175, name: "b" },
	{ x: 335, y: 130, name: "c" },
	{ x: 400, y: 200, name: "d" },
	{ x: 520, y: 190, name: "e" },
	{ x: 390, y: 95, name: "f" },
	{ x: 630, y: 150, name: "g" },
	{ x: 690, y: 235, name: "h" },
];
const mdist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
	Math.hypot(a.x - b.x, a.y - b.y);

/** roll.ts groupViewpoints on the first `n` photos: first viewpoint whose FIRST photo is within 250 m. */
function groupWalk(n: number) {
	const vps: { first: number; members: number[] }[] = [];
	const owner: number[] = [];
	for (let i = 0; i < n; i++) {
		let v = vps.findIndex((q) => mdist(WALK[q.first], WALK[i]) < VP_M);
		if (v < 0) {
			v = vps.length;
			vps.push({ first: i, members: [] });
		}
		vps[v].members.push(i);
		owner[i] = v;
	}
	const nearest = (i: number) => {
		let best = -1;
		let bd = Number.POSITIVE_INFINITY;
		vps.forEach((q, k) => {
			const d = mdist(WALK[q.first], WALK[i]);
			if (d < bd) {
				bd = d;
				best = k;
			}
		});
		return best;
	};
	return { vps, owner, nearest };
}

const WALK_TRACK = WALK.map(
	(p, i) => `${i ? "L" : "M"}${p.x * VS} ${p.y * VS + 40}`,
).join("");

function ViewpointWalk() {
	// reduced motion freezes t at this value: past the last photo, so the still shows the finished walk
	const [ref, t] = useTime<HTMLDivElement>((WALK.length + 0.5) / 1.1);
	const [manual, setManual] = useState<number | null>(null);
	const N = WALK.length;
	const auto = Math.floor((t * 1.1) % (N + 4)) + 1;
	const n = Math.min(N, manual ?? auto);
	const done = (manual ?? auto) > N;
	const { vps, owner, nearest } = groupWalk(n);
	const cent = vps.map((q) => ({
		x: q.members.reduce((s, i) => s + WALK[i].x, 0) / q.members.length,
		y: q.members.reduce((s, i) => s + WALK[i].y, 0) / q.members.length,
	}));
	return (
		<Figure
			label="D2"
			source="Skizze"
			caption="Invented walk. Photos are taken in time order. A photo joins the first viewpoint whose opening photo is within 250 m; otherwise it opens a new one. Photo f is within 250 m of both opening photos and nearer the second, yet it joins the first: first match, not nearest. At the end each viewpoint is re-centred on its photos (diamonds)."
		>
			<div ref={ref}>
				<svg
					viewBox="0 -24 640 324"
					className="block h-auto w-full"
					role="img"
					aria-label="Photos along a walk grouped into viewpoints within 250 metres"
				>
					<title>Viewpoint grouping along a walk</title>
					<SketchPath
						d={WALK_TRACK}
						seed="vw-track"
						color="pencil"
						width={1.1}
						dash="2 5"
						passes={1}
					/>
					{vps.map((q, k) => {
						const c = WALK[q.first];
						return (
							<g key={`vp-${q.first}`}>
								<Wash
									d={`M${c.x * VS - VP_M * VS} ${c.y * VS + 40}a${VP_M * VS} ${VP_M * VS} 0 1 0 ${2 * VP_M * VS} 0a${VP_M * VS} ${VP_M * VS} 0 1 0 ${-2 * VP_M * VS} 0Z`}
									color={PAL[k % PAL.length]}
									seed={`vw-wash-${q.first}`}
								/>
								<PenCircle
									center={[c.x * VS, c.y * VS + 40]}
									radiusX={VP_M * VS}
									seed={`vw-vp-${q.first}`}
									color={PAL[k % PAL.length]}
									width={1.4}
									dash="5 4"
								/>
								<HandLabel
									x={c.x * VS}
									y={c.y * VS + 40 - VP_M * VS + 14}
									anchor="middle"
									size={FIG_LABEL}
									color={inkColor(PAL[k % PAL.length])}
								>
									{`viewpoint ${k + 1} · ${q.members.length}`}
								</HandLabel>
							</g>
						);
					})}
					{WALK.slice(0, n).map((p, i) => (
						<g key={p.name}>
							<HandDot
								x={p.x * VS}
								y={p.y * VS + 40}
								r={4.6}
								seed={`vw-pt-${p.name}`}
								color={PAL[owner[i] % PAL.length]}
								opacity={1}
							/>
							<HandLabel
								x={p.x * VS + 8}
								y={p.y * VS + 40 + 4}
								size={FIG_LABEL}
								color={SWISS.ink}
							>
								{p.name}
							</HandLabel>
						</g>
					))}
					{done &&
						cent.map((c, k) => (
							<SketchPath
								key={`c-${PAL[k % PAL.length]}-${c.x.toFixed(0)}`}
								d={`M${c.x * VS} ${c.y * VS + 40 - 7} l7 7 l-7 7 l-7 -7 Z`}
								seed={`vw-centre-${k}`}
								color={PAL[k % PAL.length]}
								width={1.6}
								passes={1}
							/>
						))}
					<HandText x={330} y={-8} size={14} color="pencil">
						the first photo within 250 m opens a viewpoint, not the nearest
					</HandText>
					{n >= 6 && owner[5] !== nearest(5) && (
						<HandText x={14} y={290} size={14} color="pencil">
							f joined viewpoint {owner[5] + 1} (first within 250 m), not the
							nearer viewpoint {nearest(5) + 1}
						</HandText>
					)}
				</svg>
			</div>
			<div className="mt-4 grid items-end gap-3 md:grid-cols-[1fr_auto]">
				<Slider
					label="photos placed (capture order)"
					value={n}
					min={1}
					max={N}
					step={1}
					unit={` / ${N}`}
					onChange={(v) => setManual(v)}
				/>
				<Chip on={manual === null} onClick={() => setManual(null)}>
					{manual === null ? "auto-playing" : "replay"}
				</Chip>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Fig. 3 — the pose ladder + compass bias
// ======================================================================================
function PoseLadder() {
	const [saved, setSaved] = useState(false);
	const [gt, setGt] = useState(false);
	const [solved, setSolved] = useState(true);
	const rungs = [
		{
			k: "saved",
			on: saved,
			set: setSaved,
			title: "Saved pose",
			from: "you placed it in the workspace",
			conf: "not scored",
		},
		{
			k: "gt",
			on: gt,
			set: setGt,
			title: "Hand-fitted pose",
			from: "fitted by hand",
			conf: "not scored",
		},
		{
			k: "solved",
			on: solved,
			set: setSolved,
			title: "Solved pose",
			from: "an automatic solve was accepted",
			conf: "scored by the solve",
		},
		{
			k: "prior",
			on: true,
			set: () => {},
			title: "Phone guess",
			from: "phone compass (0 if none), tilt from gravity, lens field of view",
			conf: "unverified",
		},
	];
	const win = rungs.findIndex((r) => r.on);
	return (
		<Figure
			label="D3"
			source="Skizze"
			caption="This is a ladder, not a solver: switch what a photo has on file and the first rung that exists wins. The roll never solves just to draw itself, and stores nothing: it is rebuilt on every load."
		>
			<ol className="list-none space-y-2">
				{rungs.map((r, i) => {
					const live = i === win;
					return (
						<li
							key={r.k}
							className="grid grid-cols-[auto_1fr] items-center gap-3 px-3 py-2 transition-colors"
							style={{
								background: live ? "var(--nb-paper-deep)" : "transparent",
								opacity: i < win || live ? 1 : 0.45,
							}}
						>
							{r.k === "prior" ? (
								<span
									className={`w-[72px] bg-[color-mix(in_srgb,var(--gb-ink)_10%,var(--gb-paper))] py-1 text-center font-mono ${TYPE.micro} gb-secondary`}
								>
									always
								</span>
							) : (
								<Chip on={r.on} onClick={() => r.set(!r.on)}>
									{r.on ? "has it" : "missing"}
								</Chip>
							)}
							<div>
								<div className="flex flex-wrap items-baseline gap-x-3">
									<span
										className={`${TYPE.caption} font-semibold text-[var(--gb-ink)]`}
									>
										{i + 1}. {r.title}
									</span>
									{live && (
										<span
											className={`bg-[color-mix(in_srgb,var(--gb-ink)_12%,var(--gb-paper))] px-2 py-0.5 font-mono ${TYPE.micro} tracking-[0.12em] text-[var(--gb-ink)] uppercase`}
										>
											used · {r.conf}
										</span>
									)}
								</div>
								<div className={`font-mono ${TYPE.micro} gb-ink opacity-75`}>
									{r.from}
								</div>
							</div>
						</li>
					);
				})}
			</ol>
		</Figure>
	);
}

type Anchor = { label: string; min: number; off: number; stale?: boolean };

function CompassBias() {
	const [bias, setBias] = useState(38);
	const [wrong, setWrong] = useState(false);
	const [use, setUse] = useState(true);
	const heading = 20; // EXIF compass of the photo we are about to align
	const trueYaw = heading + bias;
	const anchors: Anchor[] = [
		{ label: "photo a", min: -9, off: bias - 1.4 },
		{ label: "photo b", min: -4, off: bias + 1.1 },
		{ label: "photo c", min: 11, off: bias + 0.5 },
		{ label: "photo d", min: -70, off: bias + 22, stale: true },
	];
	if (wrong) anchors.push({ label: "bad pin", min: -2, off: bias + 35 });
	const inWin = anchors.filter((a) => Math.abs(a.min) <= BIAS_WINDOW_MIN);
	const sorted = inWin.map((a) => a.off).sort((a, b) => a - b);
	const m = sorted.length >> 1;
	const med = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
	const applicable =
		use && Math.abs(med) <= MAX_BIAS && Math.abs(med) >= MIN_BIAS;
	const centre = heading + (applicable ? med : 0);
	const miss = angDiff(trueYaw, centre);
	const inside = Math.abs(miss) <= SEARCH_YAW;

	const cx = 150;
	const cy = 150;
	const R = 118;
	const at = (deg: number, r: number): [number, number] => [
		cx + r * Math.sin(deg * D),
		cy - r * Math.cos(deg * D),
	];
	const wedge = (c: number, w: number, r: number) => {
		const [ax, ay] = at(c - w, r);
		const [bx, by] = at(c + w, r);
		return `M${cx} ${cy} L${ax.toFixed(1)} ${ay.toFixed(1)} A${r} ${r} 0 0 1 ${bx.toFixed(1)} ${by.toFixed(1)} Z`;
	};
	/** A ray from the station with its bearing written along it. */
	const ray = (
		deg: number,
		r: number,
		seed: string,
		color: InkColor,
		label: string,
		side: number,
		dash?: string,
		frac = 0.56,
	) => {
		const [x, y] = at(deg, r);
		return (
			<g>
				<PenLine
					from={[cx, cy]}
					to={[x, y]}
					seed={seed}
					color={color}
					width={color === "red" ? 2.2 : 1.6}
					dash={dash}
				/>
				<HandDot
					x={x}
					y={y}
					r={3.4}
					seed={`${seed}-tip`}
					color={color}
					opacity={1}
				/>
				<RayLabel
					x={cx}
					y={cy}
					deg={deg}
					at={r * frac}
					side={side}
					color={color}
					size={13}
				>
					{label}
				</RayLabel>
			</g>
		);
	};
	return (
		<Figure
			label="D4"
			source="Skizze"
			caption="Best case, invented numbers (the real roll is messier). If a phone's compass is off by the same amount all stop, one solved photo shifts the starting guess for its neighbours by the median offset of photos within 45 minutes. The solver's ±25° yaw window then lands on the heading. The guess is only a start; the solve still decides acceptance."
		>
			<div className="grid items-center gap-5 md:grid-cols-[minmax(0,300px)_1fr]">
				<svg
					viewBox="0 0 300 300"
					className="mx-auto block h-auto w-full max-w-[300px]"
					role="img"
					aria-label="Compass dial: phone heading, shifted guess, solver window and true yaw"
				>
					<title>Compass bias and the solver window</title>
					<PenCircle
						center={[cx, cy]}
						radiusX={R}
						seed="cb-dial"
						color="pencil"
						width={1}
					/>
					{[0, 90, 180, 270].map((deg) => (
						<PenLine
							key={deg}
							from={at(deg, R - 6)}
							to={at(deg, R + 5)}
							seed={`cb-tick-${deg}`}
							color="pencil"
							width={1.2}
						/>
					))}
					<Hachure
						d={wedge(centre, SEARCH_YAW, R)}
						seed="cb-window"
						color={inside ? "forest" : "brown"}
						gap={6}
						angle={-45}
						opacity={0.55}
						width={0.8}
					/>
					{ray(
						heading,
						R - 24,
						"cb-exif",
						"pencil",
						`compass ${heading}°`,
						-6,
						"3 4",
					)}
					{applicable &&
						ray(
							centre,
							R - 8,
							"cb-prior",
							"ink",
							`guess ${(((centre % 360) + 360) % 360).toFixed(0)}°`,
							-6,
							undefined,
							0.36,
						)}
					{ray(
						trueYaw,
						R + 4,
						"cb-true",
						"red",
						`true ${(((trueYaw % 360) + 360) % 360).toFixed(0)}°`,
						8,
						undefined,
						0.78,
					)}
					<SketchPath
						d={stationD(cx, cy, 7)}
						seed="cb-station"
						color="ink"
						width={1.6}
						passes={1}
					/>
					<HandLabel
						x={cx}
						y={16}
						anchor="middle"
						size={13}
						color={SWISS.secondary}
					>
						N
					</HandLabel>
					<HandLabel
						x={cx}
						y={cy + 26}
						anchor="middle"
						size={13}
						color={SWISS.ink}
					>
						{inside ? "in window" : "outside"}
					</HandLabel>
					<HandText x={150} y={290} size={14} color="pencil" anchor="middle">
						photo d is 70 min old, outside the 45 min window
					</HandText>
				</svg>
				<div className="space-y-3">
					<div
						className={`grid grid-cols-1 gap-y-1 font-mono ${TYPE.micro} tabular-nums`}
					>
						{anchors.map((a) => {
							const out = Math.abs(a.min) > BIAS_WINDOW_MIN;
							return (
								<div
									key={a.label}
									className="flex justify-between gap-3"
									style={{ opacity: out ? 0.35 : 1 }}
								>
									<span className="gb-secondary whitespace-nowrap">
										{a.label} · {a.min > 0 ? "+" : "−"}
										{Math.abs(a.min)} min
									</span>
									<span className="whitespace-nowrap text-[var(--gb-ink)]">
										{fmt(a.off, 1)}°{out ? " ×" : ""}
									</span>
								</div>
							);
						})}
					</div>
					<Slider
						label="this phone's real compass bias"
						value={bias}
						min={-60}
						max={60}
						step={1}
						unit="°"
						signed
						onChange={setBias}
					/>
					<div className="flex flex-wrap gap-2">
						<Chip on={use} onClick={() => setUse(!use)}>
							neighbour correction {use ? "on" : "off"}
						</Chip>
						<Chip on={wrong} onClick={() => setWrong(!wrong)}>
							add a wrong anchor
						</Chip>
					</div>
					<p className={`font-mono ${TYPE.micro} gb-secondary`}>
						median {fmt(med, 1)}° ·{" "}
						{applicable
							? `guess shifted to ${(((centre % 360) + 360) % 360).toFixed(0)}°`
							: use
								? "below 1° or above 90°: guess left alone"
								: "guess = raw compass"}{" "}
						· true yaw is {Math.abs(miss).toFixed(1)}° from the window centre.
						Dashed = phone compass, black = shifted guess, red = truth.
					</p>
				</div>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Fig. 5 — the panorama: each photo is a mesh of rays on an azimuth x elevation canvas
// ======================================================================================
type CamPose = { yaw: number; pitch: number; roll: number; vfov: number };
const ASPECT = 4 / 3;
const TRUE_POSES: CamPose[] = [
	{ yaw: 8, pitch: 2, roll: 0, vfov: 42 },
	{ yaw: 36, pitch: 1.5, roll: 0, vfov: 42 },
	{ yaw: 64, pitch: 2, roll: 0, vfov: 42 },
];
type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function basis(p: CamPose) {
	const ya = p.yaw * D;
	const pi = p.pitch * D;
	const ro = p.roll * D;
	const f: V3 = [
		Math.sin(ya) * Math.cos(pi),
		Math.cos(ya) * Math.cos(pi),
		Math.sin(pi),
	];
	const r0: V3 = [Math.cos(ya), -Math.sin(ya), 0];
	const u0: V3 = [
		-Math.sin(ya) * Math.sin(pi),
		-Math.cos(ya) * Math.sin(pi),
		Math.cos(pi),
	];
	const r: V3 = [
		r0[0] * Math.cos(ro) + u0[0] * Math.sin(ro),
		r0[1] * Math.cos(ro) + u0[1] * Math.sin(ro),
		r0[2] * Math.cos(ro) + u0[2] * Math.sin(ro),
	];
	const u: V3 = [
		u0[0] * Math.cos(ro) - r0[0] * Math.sin(ro),
		u0[1] * Math.cos(ro) - r0[1] * Math.sin(ro),
		u0[2] * Math.cos(ro) - r0[2] * Math.sin(ro),
	];
	return { f, r, u };
}
const dirOf = (az: number, el: number): V3 => [
	Math.sin(az * D) * Math.cos(el * D),
	Math.cos(az * D) * Math.cos(el * D),
	Math.sin(el * D),
];
function projectUV(p: CamPose, d: V3): [number, number] | null {
	const b = basis(p);
	const z = dot(d, b.f);
	if (z <= 0.05) return null;
	const th = Math.tan((p.vfov * D) / 2);
	return [
		0.5 + dot(d, b.r) / z / (2 * th * ASPECT),
		0.5 - dot(d, b.u) / z / (2 * th),
	];
}
/** panorama.ts: a (u, v) ray to azimuth/elevation. */
function unprojectAzEl(p: CamPose, u: number, v: number): [number, number] {
	const b = basis(p);
	const th = Math.tan((p.vfov * D) / 2);
	const x = (u - 0.5) * 2 * th * ASPECT;
	const y = -(v - 0.5) * 2 * th;
	const d: V3 = [
		b.f[0] + x * b.r[0] + y * b.u[0],
		b.f[1] + x * b.r[1] + y * b.u[1],
		b.f[2] + x * b.r[2] + y * b.u[2],
	];
	const n = Math.hypot(...d);
	return [
		Math.atan2(d[0], d[1]) / D,
		Math.asin(Math.max(-1, Math.min(1, d[2] / n))) / D,
	];
}
const skyline = (az: number) =>
	5 +
	3.2 * Math.sin(az * 0.1) +
	2.1 * Math.sin(az * 0.27 + 1) +
	1.1 * Math.sin(az * 0.61 + 2);
const farRidge = (az: number) =>
	8.5 + 2.4 * Math.sin(az * 0.07 + 2) + 1.4 * Math.sin(az * 0.21);

const PW = 640;
const AZ0 = -22;
const AZ1 = 100;
const EL0 = -22;
const EL1 = 28;
const PS = PW / (AZ1 - AZ0);
const PH = (EL1 - EL0) * PS;
const px = (az: number) => (az - AZ0) * PS;
const py = (el: number) => (EL1 - el) * PS;

function PanoramaStrip() {
	const [ref, t] = useTime<HTMLDivElement>(8);
	const [manual, setManual] = useState<{ yaw: number; roll: number } | null>(
		null,
	);
	const auto = (() => {
		const ph = t % 11;
		if (ph < 1.8) return { yaw: 7, roll: 3.2 };
		if (ph > 7.6) return { yaw: 0, roll: 0 };
		const k = (ph - 1.8) / 5.8;
		const e = Math.exp(-3.6 * k) * Math.cos(7 * k);
		return { yaw: 7 * e, roll: 3.2 * e };
	})();
	const err = manual ?? auto;
	const aligned = Math.abs(err.yaw) < 0.4 && Math.abs(err.roll) < 0.3;
	const assumed = TRUE_POSES.map((p, i) =>
		i === 1 ? { ...p, yaw: p.yaw + err.yaw, roll: p.roll + err.roll } : p,
	);
	const ridge = (fn: (a: number) => number) =>
		Array.from({ length: 123 }, (_, k) => {
			const a = AZ0 + k;
			return `${k ? "L" : "M"}${px(a).toFixed(1)} ${py(fn(a)).toFixed(1)}`;
		}).join("");
	const photos = TRUE_POSES.map((tp, i) => {
		const ap = assumed[i];
		const edge = (pts: [number, number][]) =>
			pts.map(([u, v]) => unprojectAzEl(ap, u, v));
		const n = 14;
		const border: [number, number][] = [];
		for (let s = 0; s < n; s++) border.push([s / n, 0]);
		for (let s = 0; s < n; s++) border.push([1, s / n]);
		for (let s = 0; s < n; s++) border.push([1 - s / n, 1]);
		for (let s = 0; s < n; s++) border.push([0, 1 - s / n]);
		const outline = edge(border);
		// the photo's own skyline: ground-truth rays through the TRUE pose, drawn through the ASSUMED one
		const sky: [number, number][] = [];
		for (let a = tp.yaw - 30; a <= tp.yaw + 30; a += 0.75) {
			const uv = projectUV(tp, dirOf(a, skyline(a)));
			if (uv && uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1)
				sky.push(uv);
		}
		const skyAz = edge(sky);
		const grid: string[] = [];
		for (const gu of [0.25, 0.5, 0.75]) {
			const l = Array.from({ length: 9 }, (_, s) =>
				unprojectAzEl(ap, gu, s / 8),
			);
			grid.push(
				l
					.map(
						([a, e], s) =>
							`${s ? "L" : "M"}${px(a).toFixed(1)} ${py(e).toFixed(1)}`,
					)
					.join(""),
			);
		}
		for (const gv of [0.33, 0.66]) {
			const l = Array.from({ length: 9 }, (_, s) =>
				unprojectAzEl(ap, s / 8, gv),
			);
			grid.push(
				l
					.map(
						([a, e], s) =>
							`${s ? "L" : "M"}${px(a).toFixed(1)} ${py(e).toFixed(1)}`,
					)
					.join(""),
			);
		}
		return {
			outline: `${outline.map(([a, e], k) => `${k ? "L" : "M"}${px(a).toFixed(1)} ${py(e).toFixed(1)}`).join("")}Z`,
			sky: skyAz
				.map(
					([a, e], k) =>
						`${k ? "L" : "M"}${px(a).toFixed(1)} ${py(e).toFixed(1)}`,
				)
				.join(""),
			grid,
		};
	});
	return (
		<Figure
			label="D5"
			bleed
			source="Skizze"
			caption="Invented scene, real mapping. Photos from one viewpoint stitch without feature matching: each photo is a grid of rays, and its pose sends every ray to an azimuth and elevation on a shared canvas, so roll turns the image and wide lenses bend. Terrain ridges from the viewpoint (red) lie behind; the app overlays them as the match cue. Each photo's own skyline (black) lies on them only when its pose is right: the middle photo starts with a compass and roll error and settles as the pose is found."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				{/* the viewpoint's ridges run on round the horizon past the canvas */}
				<SketchSpill
					seed="pano-strip"
					bearing={(u) => AZ0 + u * (AZ1 - AZ0)}
					label={(deg) => `${deg}°`}
					ridges={[
						{
							at: (u) => (EL1 - farRidge(AZ0 + u * (AZ1 - AZ0))) / (EL1 - EL0),
							color: SWISS.contour,
							width: 1.4,
							opacity: 0.7,
						},
						{
							at: (u) => (EL1 - skyline(AZ0 + u * (AZ1 - AZ0))) / (EL1 - EL0),
							color: SWISS.red,
							width: 1.8,
							depth: true,
						},
					]}
				>
					<svg
						viewBox={`0 0 ${PW} ${PH}`}
						className="block h-auto w-full"
						role="img"
						aria-label="Three photos warped onto an azimuth by elevation canvas over DEM ridgelines"
					>
						<title>Panorama canvas with warped photo meshes</title>
						<SketchPath
							d={ridge(farRidge)}
							seed="pano-far"
							data
							color="pencil"
							width={1}
							opacity={0.7}
							passes={1}
						/>
						<SketchPath
							d={ridge(skyline)}
							seed="pano-ridge"
							data
							color="red"
							width={aligned ? 3 : 1.8}
							opacity={aligned ? 0.9 : 0.8}
							passes={1}
						/>
						{photos.map((ph, i) => (
							<g key={`ph-${TRUE_POSES[i].yaw}`}>
								{ph.grid.map((g) => (
									<SketchPath
										key={g}
										d={g}
										seed={`pano-grid-${i}-${g.length}-${g.slice(1, 8)}`}
										color="pencil"
										width={0.6}
										opacity={0.3}
										passes={1}
									/>
								))}
								<SketchPath
									d={ph.outline}
									seed={`pano-frame-${i}`}
									color={i === 1 ? "ink" : "pencil"}
									width={i === 1 ? 1.2 : 1}
									opacity={i === 1 ? 0.9 : 0.75}
									passes={1}
								/>
								<SketchPath
									d={ph.sky}
									seed={`pano-sky-${i}`}
									data
									color="ink"
									width={1.4}
									passes={1}
									tolerance={0.6}
								/>
							</g>
						))}
						{[0, 30, 60, 90].map((a) => (
							<HandLabel
								key={a}
								x={px(a)}
								y={PH - 8}
								anchor="middle"
								size={FIG_LABEL_SMALL}
								color="var(--nb-faint)"
							>
								{`${a}°`}
							</HandLabel>
						))}
						<HandLabel x={10} y={18} size={FIG_LABEL} color={SWISS.secondary}>
							azimuth → · elevation ↑
						</HandLabel>
						<HandText x={10} y={40} size={14} color="pencil">
							the DEM ridge drawn over each photo is the match cue
						</HandText>
						<HandText
							x={PW - 10}
							y={18}
							anchor="end"
							size={14}
							color={aligned ? "forest" : "pencil"}
							halo={false}
						>
							{aligned
								? "ridge continuous · match cue on"
								: "seam: pose is off"}
						</HandText>
					</svg>
				</SketchSpill>
			</div>
			<div className="mt-4 grid grid-cols-1 items-end gap-4">
				<Slider
					label="middle photo: compass error"
					value={err.yaw}
					min={-12}
					max={12}
					step={0.1}
					unit="°"
					signed
					onChange={(v) => setManual({ yaw: v, roll: err.roll })}
				/>
				<Slider
					label="middle photo: roll error"
					value={err.roll}
					min={-6}
					max={6}
					step={0.1}
					unit="°"
					signed
					onChange={(v) => setManual({ yaw: err.yaw, roll: v })}
				/>
				<Chip on={manual === null} onClick={() => setManual(null)}>
					{manual === null ? "auto-playing" : "replay the solve"}
				</Chip>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Real data: the 12-photo Niederhorn demo roll (scripts/gipfelbuch/data-camera-roll.ts → public/demo/gipfelbuch/camera-roll/roll.json)
// ======================================================================================
type RollRow = {
	id: string;
	t: number;
	viewpoint: number;
	east: number;
	north: number;
	hAccuracy: number;
	heading: number;
	yawOffset: number;
	looBias: number | null;
	seqBias: number | null;
	seqN: number;
	accepted: boolean;
	solvedYaw: number;
	solvedHfov: number;
};
type RollData = {
	generated: string;
	script: string;
	clusters: number[];
	viewpointRadiusM: number;
	viewpoints: { n: number; ids: string[] }[];
	spanS: number;
	rows: RollRow[];
};

function useRollData() {
	const [d, setD] = useState<RollData | null>(null);
	useEffect(() => {
		let live = true;
		fetch("/demo/gipfelbuch/camera-roll/roll.json")
			.then((r) => r.json())
			.then((v) => live && setD(v))
			.catch((e) => console.warn("[gipfelbuch] camera-roll data", e));
		return () => {
			live = false;
		};
	}, []);
	return d;
}

const PRIOR_C = LAYER_STYLE.prior.color;
const SOLVED_C = LAYER_STYLE.solved.color;
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mmss = (s: number) =>
	`${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const num = (id: string) => id.slice(-2);

function RealRoll() {
	const d = useRollData();
	const [sel, setSel] = useState("demo-03");
	if (!d)
		return (
			<div className="my-9 aspect-[16/10] w-full animate-pulse bg-[var(--nb-paper-deep)]" />
		);
	const rows = d.rows;
	const cur = rows.find((r) => r.id === sel) ?? rows[0];
	// timeline: thumbnails in capture order, ticks at their true time
	const TW = 720;
	const slot = TW / rows.length;
	const tx = (t: number) => 18 + (t / d.spanS) * (TW - 36);
	// plan map, metres east/north of the roll centre
	const S = 400;
	const MS = 0.7;
	const mx = (e: number) => S / 2 + e * MS;
	const my = (n: number) => S / 2 - n * MS;
	const first = rows[0];
	const maxFromFirst = Math.max(
		...rows.map((r) => Math.hypot(r.east - first.east, r.north - first.north)),
	);
	const acc = rows.filter((r) => r.accepted).length;
	// a burst is a run of photos with gaps under 60 s
	const bursts = [...rows]
		.sort((a, b) => a.t - b.t)
		.reduce((n, r, i, all) => (i && r.t - all[i - 1].t <= 60 ? n : n + 1), 0);
	const hs = rows.map((r) => r.hAccuracy);
	const ray = (r: RollRow, yaw: number, len: number): [number, number] => [
		mx(r.east) + len * Math.sin(yaw * D),
		my(r.north) - len * Math.cos(yaw * D),
	];
	return (
		<Figure
			label="Fig. 2"
			bleed
			caption={
				<>
					Click a photo or a dot. Dashed: the phone's compass. Teal: the solved
					direction. Brown: the two photos the solve rejected.
				</>
			}
		>
			<svg
				viewBox={`0 0 ${TW} 150`}
				className="block h-auto w-full"
				role="img"
				aria-label="The 12 demo photos in capture order, each linked to its time on a 20 minute axis"
			>
				<title>Capture timeline of the 12 demo photos</title>
				{rows.map((r, i) => {
					const on = r.id === sel;
					const cx = i * slot + slot / 2;
					const th = (slot - 4) * 0.75;
					const tone = r.accepted ? "ink" : "brown";
					return (
						<g key={r.id}>
							<SketchPath
								d={lineD(cx, th + 6, tx(r.t), 118)}
								data
								seed={`rr-link-${r.id}`}
								color={on ? "red" : "pencil"}
								width={on ? 1.5 : 0.8}
								opacity={on ? 1 : 0.6}
								passes={1}
							/>
							<HandDot
								x={tx(r.t)}
								y={118}
								r={on ? 4.2 : 2.8}
								data
								seed={`rr-t-${r.id}`}
								color={on ? "red" : tone}
								opacity={1}
							/>
							{/* biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button> */}
							<g
								onClick={() => setSel(r.id)}
								style={{ cursor: "pointer" }}
								role="button"
								tabIndex={0}
								aria-label={r.id}
								onKeyDown={(e) => e.key === "Enter" && setSel(r.id)}
							>
								<image
									href={`/demo/thumbs/${r.id}.jpg`}
									x={i * slot + 2}
									y={4}
									width={slot - 4}
									height={th}
									preserveAspectRatio="xMidYMid slice"
									opacity={on ? 1 : 0.6}
								/>
								<SketchRect
									x={i * slot + 2}
									y={4}
									width={slot - 4}
									height={th}
									seed={`rr-frame-${r.id}`}
									color={r.accepted ? LAYER_STYLE.solved.color : SWISS.contour}
									penWidth={on ? 2.4 : 1.2}
									passes={1}
								/>
								{on && (
									<SketchRect
										x={i * slot + 1}
										y={3}
										width={slot - 2}
										height={th + 2}
										seed={`rr-sel-${r.id}`}
										color="red"
									/>
								)}
							</g>
						</g>
					);
				})}
				<PenLine
					from={[18, 118]}
					to={[TW - 18, 118]}
					data
					seed="rr-axis"
					width={1.2}
				/>
				{[0, 5, 10, 15, 20].map((m) => (
					<g key={m}>
						<PenLine
							from={[tx(m * 60), 118]}
							to={[tx(m * 60), 125]}
							data
							seed={`rr-tick-${m}`}
							width={1}
						/>
						<HandLabel
							x={tx(m * 60)}
							y={139}
							anchor="middle"
							size={11}
							color="var(--nb-faint)"
						>
							+{m} min
						</HandLabel>
					</g>
				))}
			</svg>
			<div className="mt-5 grid items-center gap-5 lg:grid-cols-[minmax(0,380px)_1fr]">
				<svg
					viewBox={`0 0 ${S} ${S}`}
					className="mx-auto block h-auto w-full max-w-[400px]"
					role="img"
					aria-label="Plan view of the 12 camera positions with GPS accuracy circles, compass headings and solved yaws"
				>
					<title>Plan view of the camera positions</title>
					{[-200, -100, 0, 100, 200].map((m) => (
						<g key={m}>
							<PenLine
								from={[mx(m), 0]}
								to={[mx(m), S]}
								seed={`rr-gx-${m}`}
								color="faint"
								width={0.5}
							/>
							<PenLine
								from={[0, my(m)]}
								to={[S, my(m)]}
								seed={`rr-gy-${m}`}
								color="faint"
								width={0.5}
							/>
						</g>
					))}
					<PenCircle
						center={[mx(first.east), my(first.north)]}
						radiusX={d.viewpointRadiusM * MS}
						data
						seed="rr-vp"
						color="pencil"
						width={1.2}
						dash="4 4"
					/>
					{rows.map((r) => (
						<PenCircle
							key={r.id}
							center={[mx(r.east), my(r.north)]}
							radiusX={r.hAccuracy * MS}
							data
							seed={`rr-acc-${r.id}`}
							color={r.id === sel ? "ink" : "faint"}
							width={r.id === sel ? 1.3 : 0.8}
						/>
					))}
					{rows.map((r) => {
						const len = r.id === sel ? 92 : 52;
						const [px1, py1] = ray(r, r.heading, len);
						const [sx1, sy1] = ray(r, r.solvedYaw, len);
						return (
							<g key={r.id} opacity={r.id === sel ? 1 : 0.5}>
								<PenLine
									from={[mx(r.east), my(r.north)]}
									to={[px1, py1]}
									data
									seed={`rr-prior-${r.id}`}
									color={PRIOR_C}
									width={1.4}
									dash="3 3"
								/>
								<PenLine
									from={[mx(r.east), my(r.north)]}
									to={[sx1, sy1]}
									data
									seed={`rr-solved-${r.id}`}
									color={SOLVED_C}
									width={1.8}
								/>
							</g>
						);
					})}
					{/* the selected station writes its bearings along its rays */}
					<RayLabel
						x={mx(cur.east)}
						y={my(cur.north)}
						deg={cur.heading}
						at={58}
						side={angDiff(cur.solvedYaw, cur.heading) >= 0 ? -7 : 11}
						color="pencil"
					>
						{`compass ${cur.heading.toFixed(0)}°`}
					</RayLabel>
					<RayLabel
						x={mx(cur.east)}
						y={my(cur.north)}
						deg={cur.solvedYaw}
						at={58}
						side={angDiff(cur.solvedYaw, cur.heading) >= 0 ? 11 : -7}
						color="blue"
					>
						{`solved ${cur.solvedYaw.toFixed(0)}°`}
					</RayLabel>
					{rows.map((r) => {
						const x = mx(r.east);
						const y = my(r.north);
						const on = r.id === sel;
						return (
							<g key={r.id}>
								{/* biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button> */}
								<g
									style={{ cursor: "pointer" }}
									onClick={() => setSel(r.id)}
									role="button"
									tabIndex={0}
									aria-label={r.id}
									onKeyDown={(e) => e.key === "Enter" && setSel(r.id)}
								>
									<circle cx={x} cy={y} r={11} fill="transparent" />
									<SketchPath
										d={stationD(x, y, on ? 7 : 5)}
										data
										seed={`rr-st-${r.id}`}
										color={on ? "red" : r.accepted ? "ink" : "brown"}
										width={on ? 1.9 : 1.4}
										passes={1}
									/>
								</g>
							</g>
						);
					})}
					<PenLine
						from={[16, S - 16]}
						to={[16 + 100 * MS, S - 16]}
						data
						seed="rr-scale"
						width={1.6}
					/>
					<HandLabel x={16} y={S - 22} color={SWISS.secondary}>
						100 m
					</HandLabel>
					<HandLabel x={S - 8} y={18} anchor="end" color={SWISS.secondary}>
						N↑ · dashed ring = 250 m
					</HandLabel>
				</svg>
				<div
					className={`min-w-0 space-y-3 font-mono ${TYPE.micro} gb-secondary`}
				>
					<div className="bg-[var(--nb-paper-deep)] p-3 text-[var(--gb-ink)]">
						<div className="mb-1 gb-ink">
							{cur.id} · +{mmss(cur.t)} ·{" "}
							{cur.accepted ? "accepted" : "rejected"}
						</div>
						GPS ±{cur.hAccuracy.toFixed(0)} m
						<br />
						compass {cur.heading.toFixed(1)}° → solved{" "}
						{cur.solvedYaw.toFixed(1)}° ({fmt(cur.yawOffset, 1)}°)
					</div>
					<p>
						<span className="text-[var(--gb-ink)]">
							{d.clusters.length} roll
						</span>{" "}
						({d.clusters[0]} photos, each within 15 km of a neighbour),{" "}
						<span className="text-[var(--gb-ink)]">
							{d.viewpoints.length} viewpoint
						</span>
						: every photo is within {maxFromFirst.toFixed(0)} m of the first,
						inside the 250 m radius.
					</p>
					<p>
						Captured over{" "}
						<span className="text-[var(--gb-ink)]">{mmss(d.spanS)} min</span>,
						in {bursts} bursts. {acc} of {rows.length} were solved.
					</p>
					<p>
						The GPS accuracy circles ({Math.min(...hs).toFixed(0)}–
						{Math.max(...hs).toFixed(0)} m, median {median(hs).toFixed(0)} m)
						are as large as the whole spread of positions. That is why a
						viewpoint is a 250 m disc and not a point.
					</p>
				</div>
			</div>
		</Figure>
	);
}

function RealBias() {
	const d = useRollData();
	if (!d) return null;
	const rows = d.rows;
	const W = 720;
	const H = 270;
	const L = 44;
	const slot = (W - L - 12) / rows.length;
	const X = (i: number) => L + slot * (i + 0.5);
	const Y0 = -30;
	const Y1 = 16;
	const Y = (v: number) => 12 + ((Y1 - v) / (Y1 - Y0)) * (H - 56);
	const used = rows.filter((r) => r.accepted && r.seqBias != null);
	const raw = used.map((r) => Math.abs(r.yawOffset));
	const aft = used.map((r) => Math.abs(r.yawOffset - (r.seqBias as number)));
	const better = used.filter((_, i) => aft[i] < raw[i] - 0.5).length;
	const worse = used.filter((_, i) => aft[i] > raw[i] + 0.5).length;
	const looRows = rows.filter((r) => r.accepted && r.looBias != null);
	const outliers = looRows.filter(
		(r) => Math.abs(r.yawOffset - (r.looBias as number)) > 8,
	).length;
	const accOff = rows.filter((r) => r.accepted).map((r) => r.yawOffset);
	return (
		<Figure
			label="Fig. 4"
			bleed
			caption={
				<>
					Dots: solved yaw minus compass, per photo in shooting order (hollow =
					rejected). Teal ticks: what the earlier photos predicted.
				</>
			}
		>
			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="block h-auto w-full"
				role="img"
				aria-label="Compass error per photo in capture order against the viewpoint bias estimate"
			>
				<title>Compass error and viewpoint bias per photo</title>
				{[-30, -20, -10, 0, 10].map((v) => (
					<g key={v}>
						<PenLine
							from={[L, Y(v)]}
							to={[W - 8, Y(v)]}
							data
							seed={`rb-grid-${v}`}
							color={v === 0 ? "ink" : "faint"}
							width={v === 0 ? 1.2 : 0.5}
						/>
						<HandLabel
							x={L - 6}
							y={Y(v) + 3.5}
							anchor="end"
							size={11}
							color="var(--nb-faint)"
						>
							{v > 0 ? "+" : v < 0 ? "−" : ""}
							{Math.abs(v)}°
						</HandLabel>
					</g>
				))}
				{rows.map((r, i) => (
					<g key={r.id}>
						{r.seqBias != null && (
							<>
								<PenLine
									from={[X(i), Y(r.seqBias)]}
									to={[X(i), Y(r.yawOffset)]}
									data
									seed={`rb-gap-${r.id}`}
									color={SOLVED_C}
									width={1.6}
								/>
								<PenLine
									from={[X(i) - 11, Y(r.seqBias)]}
									to={[X(i) + 11, Y(r.seqBias)]}
									data
									seed={`rb-tick-${r.id}`}
									color={SOLVED_C}
									width={2.4}
								/>
							</>
						)}
						{r.accepted ? (
							<HandDot
								x={X(i)}
								y={Y(r.yawOffset)}
								r={5}
								data
								seed={`rb-dot-${r.id}`}
								color="ink"
								opacity={1}
							/>
						) : (
							<PenCircle
								center={[X(i), Y(r.yawOffset)]}
								radiusX={5}
								data
								seed={`rb-rej-${r.id}`}
								color="brown"
								width={1.8}
							/>
						)}
						<HandLabel
							x={X(i)}
							y={H - 24}
							anchor="middle"
							size={11}
							color="var(--nb-ink)"
						>
							{num(r.id)}
						</HandLabel>
						<HandLabel
							x={X(i)}
							y={H - 10}
							anchor="middle"
							size={11}
							color="var(--nb-faint)"
						>
							{mmss(r.t)}
						</HandLabel>
					</g>
				))}
			</svg>
			<p className={`mt-3 font-mono ${TYPE.micro} gb-secondary`}>
				Across the {accOff.length} solved photos the compass error runs from{" "}
				<span className="text-[var(--gb-ink)]">
					{fmt(Math.min(...accOff), 1)}° to {fmt(Math.max(...accOff), 1)}°
				</span>{" "}
				within {mmss(d.spanS)} min at one spot. The estimate from earlier photos
				tracks the first five, then misses once the heading changes: of{" "}
				{used.length} photos with an estimate it lowers the error for {better},
				leaves it for {used.length - better - worse}, raises it for {worse}. A
				check against all other photos (8° limit) flags {outliers} of{" "}
				{looRows.length}.
			</p>
		</Figure>
	);
}

// ======================================================================================
// Explainer layer: hero, trio, numbers (real data from roll.json and the gipfelbuch photo files)
// ======================================================================================
const ROLL_IDS = [
	"demo-01",
	"demo-02",
	"demo-03",
	"demo-04",
	"demo-05",
	"demo-06",
	"demo-07",
	"demo-08",
	"demo-09",
	"demo-10",
	"demo-11",
	"demo-12",
] as const;

/** Wedge in DemPatch pixels for a view cone from the patch centre. */
function cone(
	toPx: (az: number, d: number) => [number, number],
	yaw: number,
	hfov: number,
	reach: number,
) {
	const a = toPx(yaw - hfov / 2, reach);
	const b = toPx(yaw + hfov / 2, reach);
	const c = toPx(0, 0);
	const rr = Math.hypot(a[0] - c[0], a[1] - c[1]);
	return `M${c[0]} ${c[1]}L${a[0]} ${a[1]}A${rr} ${rr} 0 0 1 ${b[0]} ${b[1]}Z`;
}

/** Crop to the ridge itself so foreground people stay out of frame. */
function ridgeBand(d: GipfelbuchPhotoData): [number, number, number, number] {
	const ys = d.skyline.rows
		.filter((v): v is number => v != null)
		.sort((a, b) => a - b);
	if (!ys.length) return [0, 0, d.photo.width, Math.round(d.photo.height / 3)];
	const lo = ys[Math.floor(ys.length * 0.02)];
	const hi = ys[Math.floor(ys.length * 0.98)];
	const y0 = Math.max(0, lo - 70);
	const y1 = Math.min(d.photo.height, Math.max(hi + 40, y0 + 200));
	return [0, Math.round(y0), d.photo.width, Math.round(y1)];
}

function HeroStages() {
	const roll = useRollData();
	const d = useGipfelbuchPhoto("demo-03");
	const spread = roll
		? Math.max(
				...roll.rows.map((r) =>
					Math.hypot(r.east - roll.rows[0].east, r.north - roll.rows[0].north),
				),
			)
		: null;
	const frame = (child: ReactNode) => (
		<div className="relative aspect-[16/10] w-full overflow-hidden bg-[var(--nb-paper-deep)]">
			<div className="absolute inset-0 flex items-center justify-center">
				{child}
			</div>
		</div>
	);
	return (
		<Figure
			label="Fig. 1"
			plate
			pinned="demo-03"
			caption={
				spread == null
					? "Twelve photos become one place."
					: `All 12 photos were taken within ${Math.round(spread)} m of the first, so their views fan out from one spot.`
			}
		>
			<Stages
				interval={3800}
				stages={[
					{
						label: "A pile",
						caption:
							"A camera roll starts as frames in time order, each with a rough GPS fix.",
						render: () => (
							<Gallery
								ids={ROLL_IDS}
								cols={4}
								className="!gap-1.5"
								tile={(d) => (
									<RealPhoto data={d} layers={[]} crop={ridgeBand(d)} />
								)}
							/>
						),
					},
					{
						label: "A place",
						caption:
							"Each photo is aimed by its solved direction. Brown cones are photos the solve rejected.",
						render: () =>
							frame(
								<div className="h-full max-w-full" style={{ aspectRatio: "1" }}>
									<DemPatch data={d} cone={[]} peaks={false}>
										{(_, toPx) => (
											<g>
												{roll?.rows.map((r) => {
													const d = cone(
														toPx,
														r.solvedYaw,
														r.solvedHfov,
														14000,
													);
													const tone = r.accepted
														? LAYER_STYLE.solved.color
														: SWISS.contour;
													return (
														<g key={r.id}>
															<Wash
																d={d}
																color={tone}
																seed={`hs-cone-${r.id}`}
															/>
															<SketchPath
																d={d}
																data
																seed={`hs-cone-edge-${r.id}`}
																color={tone}
																width={1.3}
															/>
														</g>
													);
												})}
											</g>
										)}
									</DemPatch>
								</div>,
							),
					},
					{
						label: "A drape",
						caption: "Then every photo is laid onto the terrain it saw.",
						render: () =>
							frame(
								<img
									src="/demo/shots/drape.jpg"
									alt="Twelve photos draped on the Niederhorn terrain"
									className="size-full object-cover"
								/>,
							),
					},
				]}
			/>
		</Figure>
	);
}

/** Mini plan map: the 12 camera positions inside the 250 m viewpoint ring. */
function MiniPlan() {
	const roll = useRollData();
	if (!roll)
		return (
			<div className="aspect-[4/3] animate-pulse bg-[var(--nb-paper-deep)]" />
		);
	const S = 200;
	const MS = 0.34;
	const mx = (e: number) => S / 2 + e * MS;
	const my = (n: number) => S / 2 - n * MS;
	const f = roll.rows[0];
	return (
		<svg
			viewBox={`0 0 ${S} ${S}`}
			className="block h-auto w-full"
			role="img"
			aria-label="The 12 camera positions inside one viewpoint ring"
		>
			<title>Camera positions inside one 250 m ring</title>
			<PenCircle
				center={[mx(f.east), my(f.north)]}
				radiusX={roll.viewpointRadiusM * MS}
				seed="mp-ring"
				color="pencil"
				width={1.2}
				dash="4 4"
			/>
			{roll.rows.map((r) => (
				<SketchPath
					key={r.id}
					d={stationD(mx(r.east), my(r.north), 4)}
					seed={`mp-${r.id}`}
					color={r.accepted ? "ink" : "brown"}
					width={1.3}
					passes={1}
				/>
			))}
		</svg>
	);
}

function MiniAim() {
	const [photo] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photo);
	return <StoryMap data={d} search readout={false} fit="cone" aspect={4 / 3} />;
}

function RollNumbers() {
	const d = useRollData();
	if (!d) return null;
	const acc = d.rows.filter((r) => r.accepted);
	const offs = acc.map((r) => r.yawOffset);
	const lo = Math.min(...offs);
	const hi = Math.max(...offs);
	return (
		<Numbers
			items={[
				{
					value: `${acc.length} / ${d.rows.length}`,
					label: "photos aimed automatically",
				},
				{ value: mmss(d.spanS), label: "of shooting, all at one spot" },
				{
					value: `${fmt(lo)}° to ${fmt(hi)}°`,
					label: "compass error across the accepted photos",
				},
				{
					value: "15 km",
					label: "link distance that joins photos into a roll",
				},
			]}
			source="Measured on the 12 demo photos."
		/>
	);
}

export default function Page({ node: _node }: { node: GipfelbuchNode }) {
	const A = (id: string, label: string) => (
		<Link
			to="/gipfelbuch/$concept"
			params={{ concept: id }}
			className="underline decoration-[var(--gb-pencil)] underline-offset-2 hover:decoration-current"
		>
			{label}
		</Link>
	);
	return (
		<>
			<HeroStages />

			<Beat
				kicker="The idea"
				title="Photos are grouped by where they were taken."
			>
				<p>
					Each photo already has a{" "}
					<HandMark type="underline">
						time, position and compass reading
					</HandMark>
					. Rigi uses them to group the photos and aim each one. Nothing is
					stored: the roll is worked out again each time.
				</p>
				<p>
					Photos from one spot share one camera position. Each only needs a
					heading to land in the right place.
				</p>
				<p>
					<HandMark type="highlight">
						The phone's compass is the weak part.
					</HandMark>{" "}
					Slide it below and watch every photo settle onto the terrain.
				</p>
			</Beat>

			<RollCompasses sketch />

			<Beat kicker="Where they stood" title="Twelve photos, one viewpoint.">
				<p>
					Each photo sits on the plan at its true GPS time and place. The big
					circles are how far the phone's GPS could be off.
					<MarginNote mark="a">all 12 lie within about 110 m</MarginNote>
				</p>
			</Beat>

			<RealRoll />

			<Eq
				label="Where a photo lands on the panorama"
				where={[
					{
						sym: "ψ",
						text: "yaw, where the camera points (phone compass at first, solved value after the slider moves)",
					},
					{
						sym: "u",
						text: "a column of the photo, from 0 (left edge) to 1 (right edge)",
					},
					{
						sym: "hfov",
						text: "horizontal field of view of the lens (formula for a level camera)",
					},
				]}
			>
				az(<Sym>u</Sym>) = <Sym>ψ</Sym> + atan( (<Sym>u</Sym> − ½) · 2 tan(
				<Sym>hfov</Sym> / 2) )
			</Eq>

			<Beat
				kicker="How it works"
				title="Group nearby photos, aim each one, lay them down."
			>
				<Trio
					steps={[
						{
							title: "Group",
							body: "Photos within 250 m share one viewpoint.",
							visual: <MiniPlan />,
						},
						{
							title: "Aim",
							body: "Phone compass, then the solved direction.",
							visual: <MiniAim />,
						},
						{
							title: "Lay down",
							body: "All photos blend onto the terrain at once.",
							visual: (
								<img
									src="/demo/shots/drape.jpg"
									alt="Photos draped on the terrain"
									className="block h-full w-full object-cover"
									style={{ aspectRatio: "1" }}
								/>
							),
						},
					]}
				/>
			</Beat>

			<LiveDrape number="3" />

			<Beat
				kicker="Where it fails"
				title="Compass errors change within minutes, so a neighbour's fix is only a hint."
			>
				<p>
					Photos from one spot often share a compass error. Here it does for a
					while, <HandMark type="wavy">then the heading changes</HandMark>.
					<MarginNote mark="b">
						so a bias from 45 minutes ago is already doubtful
					</MarginNote>
				</p>
			</Beat>

			<RealBias />

			<RollNumbers />

			<Details>
				<p>
					A roll is rebuilt on every load from photo metadata plus any poses the
					browser remembers. Two distance rules group the photos, and a{" "}
					<HandMark type="underline">pose ladder</HandMark> picks each
					photo&rsquo;s direction. Solving from scratch is the job of{" "}
					{A("viewport-inference", "viewport inference")}; the roll never
					repeats it.
				</p>

				<RollLinker />

				<h3>Areas, then viewpoints</h3>
				<div className="space-y-3">
					<p>
						Photos closer than 15 km to a neighbour share a roll, transitively.
						A day's hike stays one roll even when its ends are far apart; two
						trips split apart. Within a roll, photos are taken in time order and
						filed under the first viewpoint whose opening photo is within 250 m,
						then each viewpoint is re-centred on its photos. Photos at one
						viewpoint share a camera position, which is what makes a panorama
						and a shared compass bias possible.
					</p>
				</div>

				<ViewpointWalk />

				<h3>The best pose we already have</h3>
				<div className="space-y-3">
					<p>
						Each photo gets a pose with no solver run: the first of four sources
						wins. A photo stays a phone guess until something better, a person's
						pin or an accepted solve, replaces it. The{" "}
						{A("camera-prior", "phone guess")} is the floor: compass heading (0
						if none), tilt from gravity, and the lens field of view.
					</p>
				</div>

				<PoseLadder />

				<h3>Anchors teach their neighbours</h3>
				<div className="space-y-3">
					<p>
						The solver runs on each photo that still has only its phone guess,
						one at a time in capture order, and stores a pose only when it
						accepts; a rejected photo stays marked &ldquo;needs review&rdquo;.
						The roll adds one idea: photos at one viewpoint, within minutes,
						often share the phone&rsquo;s compass error, so each solved photo
						gives its neighbours a better starting guess (the real roll below
						shows where that holds). The estimate is the median of the solved
						photos&rsquo; yaw offsets,{" "}
						<HandMark type="double">so one wrong pin cannot drag it</HandMark>.
						It is used only between 1° and 90°, and only for photos within 45
						minutes. A photo rejected before its spot had a solved neighbour
						gets one retry when the new estimate differs by at least 2°.
					</p>
				</div>

				<CompassBias />

				<h3>A viewpoint becomes a panorama</h3>
				<div className="space-y-3">
					<p>
						With poses in hand the strip needs no matching. Every photo is a
						mesh of rays; each ray goes through the photo&rsquo;s pose to a spot
						on an azimuth by elevation canvas, so roll turns the picture and a
						wide lens bends correctly. The canvas repeats every 360° so a full
						circle wraps. A worker traces the terrain ridges all round the
						viewpoint, in distance bands from 40 m to 120 km, from the same
						camera position as the {A("dem-horizon", "DEM horizon")}, and the
						strip draws them over each photo as a match cue. Only solved photos
						get it, because a phone guess is only a guess.
					</p>
				</div>

				<PanoramaStrip />

				<h3>Many photos, one drape</h3>
				<div className="space-y-3">
					<p>
						The roll map refines the terrain tiles around every viewpoint, then
						drapes all photos in one pass. Each tile lists the photos that reach
						it and can see it; each pixel weighs those photos by viewing angle,
						distance and distance from the frame edge, and keeps the best four.
						Visibility comes from each photo&rsquo;s depth map, with a filtered
						test so silhouettes fade instead of stair-stepping. Because all
						photos compete in one blend, the result does not depend on draw
						order or roll size. Photos are packed into up to four texture
						atlases so a large roll fits in GPU memory.
					</p>
				</div>

				<Figure
					label="D6"
					bleed
					pad={false}
					caption="The same 12-photo roll in the roll map: every photo draped at once on the terrain. All 12 camera positions lie within about 110 m, so the orange pins pile up and the photos fan out from one spot over the Niederhorn ridge and the valley."
				>
					<img
						src="/demo/shots/drape.jpg"
						alt="The Niederhorn roll draped on the 3D terrain: twelve photos fan out from a single viewpoint over the ridge and valley"
						className="block h-auto w-full"
					/>
				</Figure>

				<Callout tone="result" title="Derived, never stored">
					Rolls, viewpoints and pose sources are recomputed from metadata every
					time. Delete a photo and the roll simply re-forms.
				</Callout>

				<h3>Where to look</h3>
				<div className="space-y-3">
					<div className="flex flex-wrap gap-2">
						<CodeRef path="src/lib/roll/roll.ts" />
						<CodeRef path="src/lib/roll/types.ts" />
						<CodeRef path="src/lib/roll/align/align.ts" />
						<CodeRef path="src/lib/roll/align/viewpoint.ts" />
						<CodeRef path="src/lib/roll/mosaic/panorama.ts" />
						<CodeRef path="src/lib/roll/mosaic/ridgelines.ts" />
						<CodeRef path="src/lib/roll/map/multi-drape-layer.ts" />
						<CodeRef path="src/lib/roll/map/roll-terrain.ts" />
						<CodeRef path="src/lib/roll/import/interpolate.ts" />
						<CodeRef path="src/lib/roll/mosaic/loadRoll.ts" />
					</div>
				</div>

				<h3>From file to draped roll</h3>
				<div className="space-y-3">
					<Steps
						steps={[
							{
								title: "Import",
								body: "Photos are read for EXIF. A photo with no GPS gets a position interpolated between neighbours within 20 minutes, with a growing error estimate.",
							},
							{
								title: "Cluster and group",
								body: "Photos within 15 km of a neighbour form a roll; the first match within 250 m gives the viewpoints, re-centred on their photos.",
							},
							{
								title: "Pick poses",
								body: "Saved, then hand-fitted, then an accepted solve, then the phone guess. Each photo carries its source and confidence.",
							},
							{
								title: "Solve (optional)",
								body: "The solver runs on phone-guess photos in capture order, starting from the neighbour-corrected guess. Only accepted poses are stored.",
							},
							{
								title: "Show",
								body: "Mosaic, panorama strip and terrain drape all come from the same poses.",
							},
						]}
					/>
				</div>

				<h3>Rolls reuse, they do not re-solve</h3>
				<div className="space-y-3">
					<p>
						Alignment reuses the solver from{" "}
						{A("viewport-inference", "viewport inference")}, and its accepted
						poses follow the {A("accept-rule", "accept rule")}. The terrain
						under the drape comes from the {A("dem-source", "DEM")}; the same
						photos can then {A("step-inside", "step inside")} for a near-field
						view, and each opens in the{" "}
						{A("photo-workspace", "photo workspace")}. Snapping to terrain is
						covered in {A("terrain-snapping", "terrain snapping")}.
					</p>
				</div>
			</Details>
		</>
	);
}
