// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import {
	type AtlasPhotoData,
	Callout,
	CodeRef,
	DemPatch,
	Figure,
	Measured,
	RealPhoto,
	Steps,
	useAtlasPhoto,
	useTime,
} from "#/components/atlas/viz";
import {
	Beat,
	Details,
	Gallery,
	Numbers,
	Stages,
	Trio,
} from "#/components/atlas/viz/explain";
import type { AtlasNode } from "#/lib/atlas/types";

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

const PAL = [
	"var(--accent)",
	"var(--rigi-paper)",
	"var(--rigi-trap)",
	"#8fb4d9",
];

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
		<label className="block">
			<span className="flex justify-between font-mono text-[11px] text-white/45">
				<span>{label}</span>
				<span className="text-[var(--rigi-paper)]">
					{signed
						? fmt(value, step < 1 ? 1 : 0)
						: value.toFixed(step < 1 ? 1 : 0)}
					{unit}
				</span>
			</span>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				className="mt-1 w-full accent-[var(--accent)]"
			/>
		</label>
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
			className="rounded-full px-3 py-1 font-mono text-[11px] transition"
			style={{
				color: on ? "var(--rigi-paper)" : "rgba(255,255,255,.5)",
				boxShadow: `inset 0 0 0 1px ${on ? "var(--accent)" : "rgba(255,255,255,.12)"}`,
				background: on
					? "color-mix(in oklab, var(--accent) 16%, transparent)"
					: undefined,
			}}
		>
			{children}
		</button>
	);
}

// ======================================================================================
// Fig. 1 (hero) — single-linkage: a day's photos become areas
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
	const track = HIKE.map(
		(p, i) => `${i ? "L" : "M"}${p.x * KS} ${p.y * KS}`,
	).join("");
	return (
		<Figure
			label="Fig. 1"
			bleed
			caption="Schematic (invented points). Single-linkage clustering, exactly as clusterPhotos does it: every pair of photos closer than the link distance is joined, and a roll is a connected component. The real threshold is ROLL_LINK_M = 15 km, so a day's hike stays one roll, while a valley 17 km further on opens another. A photo at the pass shows the chain effect: no photo has to be near every other, only near a neighbour."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<svg
					viewBox="0 0 640 240"
					className="block h-auto w-full rounded-xl bg-[#11161a]"
					role="img"
					aria-label="Photo locations on a map, linked into rolls by single-linkage distance"
				>
					<title>Photo locations linked into rolls</title>
					{/* quiet contour backdrop */}
					{[0, 1, 2, 3, 4, 5, 6].map((k) => (
						<path
							key={k}
							d={`M0 ${30 + k * 34} ${Array.from({ length: 33 }, (_, i) => `L${i * 20} ${(30 + k * 34 + 14 * Math.sin(i * 0.5 + k * 1.3) + 8 * Math.sin(i * 0.19 + k)).toFixed(1)}`).join("")}`}
							fill="none"
							stroke="rgba(236,230,218,.05)"
						/>
					))}
					{/* 15 km scale bar and the GPS track */}
					<path
						d={track}
						fill="none"
						stroke="rgba(236,230,218,.18)"
						strokeDasharray="2 5"
					/>
					<g className="font-mono" fontSize="9.5" fill="rgba(236,230,218,.5)">
						<line
							x1="20"
							x2={20 + linkKm * KS}
							y1="226"
							y2="226"
							stroke="var(--accent)"
							strokeWidth="1.5"
						/>
						<line x1="20" x2="20" y1="221" y2="231" stroke="var(--accent)" />
						<line
							x1={20 + linkKm * KS}
							x2={20 + linkKm * KS}
							y1="221"
							y2="231"
							stroke="var(--accent)"
						/>
						<text x={28 + linkKm * KS} y="229">
							{`link < ${linkKm.toFixed(0)} km`}
						</text>
					</g>
					{/* links */}
					{links.map(([i, j]) => (
						<line
							key={`${i}-${j}`}
							x1={pts[i].x * KS}
							y1={pts[i].y * KS}
							x2={pts[j].x * KS}
							y2={pts[j].y * KS}
							stroke={PAL[label[i] % PAL.length]}
							strokeOpacity=".35"
							strokeDasharray="4 4"
							strokeDashoffset={-t * 8}
						/>
					))}
					{/* roll hulls */}
					{info.map((r, k) => (
						<g key={`roll-${PAL[k % PAL.length]}-${r.n}-${r.c.x.toFixed(1)}`}>
							<circle
								cx={r.c.x * KS}
								cy={r.c.y * KS}
								r={Math.max(10, r.r * KS + 12)}
								fill={PAL[k % PAL.length]}
								fillOpacity=".06"
								stroke={PAL[k % PAL.length]}
								strokeOpacity=".5"
							/>
							<text
								x={r.c.x * KS}
								y={r.c.y * KS - Math.max(10, r.r * KS + 12) - 5}
								textAnchor="middle"
								fontSize="10"
								className="font-mono"
								fill={PAL[k % PAL.length]}
							>
								{`roll ${k + 1} · ${r.n} photo${r.n > 1 ? "s" : ""} · r ${r.r.toFixed(1)} km`}
							</text>
						</g>
					))}
					{pts.map((p, i) => (
						<circle
							key={`${p.x}-${p.y}`}
							cx={p.x * KS}
							cy={p.y * KS}
							r={i >= HIKE.length + VALLEY.length ? 5 : 3.4}
							fill={PAL[label[i] % PAL.length]}
							stroke="#0e1012"
							strokeWidth="1.2"
						/>
					))}
					{pass && (
						<text
							x={PASS.x * KS}
							y={PASS.y * KS + 18}
							textAnchor="middle"
							fontSize="9.5"
							className="font-mono"
							fill="rgba(236,230,218,.55)"
						>
							photo at the pass
						</text>
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
			<p className="mt-3 font-mono text-[11px] text-white/45">
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

function ViewpointWalk() {
	const [ref, t] = useTime<HTMLDivElement>(99);
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
			label="Fig. 2"
			caption="Schematic (invented walk). Inside one area, groupViewpoints walks the photos in capture time. A photo joins the first viewpoint whose opening photo is within 250 m (VIEWPOINT_RADIUS_M); otherwise it opens a new one. Photo f is within 250 m of both opening photos and is closer to the second, yet it joins the first: the rule is first match, not nearest. When the walk ends each viewpoint is re-centred on its members (diamonds)."
		>
			<div ref={ref}>
				<svg
					viewBox="0 0 640 300"
					className="block h-auto w-full rounded-xl bg-[#11161a]"
					role="img"
					aria-label="Photos along a walk grouped into viewpoints within 250 metres"
				>
					<title>Viewpoint grouping along a walk</title>
					<path
						d={WALK.map(
							(p, i) => `${i ? "L" : "M"}${p.x * VS} ${p.y * VS + 40}`,
						).join("")}
						fill="none"
						stroke="rgba(236,230,218,.14)"
						strokeDasharray="2 5"
					/>
					{vps.map((q, k) => {
						const c = WALK[q.first];
						return (
							<g key={`vp-${q.first}`}>
								<circle
									cx={c.x * VS}
									cy={c.y * VS + 40}
									r={VP_M * VS}
									fill={PAL[k % PAL.length]}
									fillOpacity=".06"
									stroke={PAL[k % PAL.length]}
									strokeOpacity=".55"
									strokeDasharray="5 4"
								/>
								<text
									x={c.x * VS}
									y={c.y * VS + 40 - VP_M * VS + 12}
									textAnchor="middle"
									fontSize="10"
									className="font-mono"
									fill={PAL[k % PAL.length]}
								>
									{`viewpoint ${k + 1} · ${q.members.length}`}
								</text>
							</g>
						);
					})}
					{WALK.slice(0, n).map((p, i) => (
						<g key={p.name}>
							<circle
								cx={p.x * VS}
								cy={p.y * VS + 40}
								r="4.5"
								fill={PAL[owner[i] % PAL.length]}
								stroke="#0e1012"
								strokeWidth="1.2"
							/>
							<text
								x={p.x * VS + 7}
								y={p.y * VS + 40 + 3}
								fontSize="9"
								className="font-mono"
								fill="rgba(236,230,218,.7)"
							>
								{p.name}
							</text>
						</g>
					))}
					{done &&
						cent.map((c, k) => (
							<path
								key={`c-${PAL[k % PAL.length]}-${c.x.toFixed(0)}`}
								d={`M${c.x * VS} ${c.y * VS + 40 - 7} l7 7 l-7 7 l-7 -7 Z`}
								fill="none"
								stroke={PAL[k % PAL.length]}
								strokeWidth="1.6"
							/>
						))}
					{n >= 6 && owner[5] !== nearest(5) && (
						<text
							x="14"
							y="288"
							fontSize="10"
							className="font-mono"
							fill="rgba(236,230,218,.6)"
						>
							f joined viewpoint {owner[5] + 1} (first within 250 m), not the
							nearer viewpoint {nearest(5) + 1}
						</text>
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
			from: "loadSavedPose(meta.id): you placed it in the workspace",
			conf: "no confidence",
		},
		{
			k: "gt",
			on: gt,
			set: setGt,
			title: "Ground truth",
			from: "data/ground-truth.json: hand-fitted, quality not none, yaw/pitch/roll/f all present",
			conf: "no confidence",
		},
		{
			k: "solved",
			on: solved,
			set: setSolved,
			title: "Solved pose",
			from: "loadSolvedPose(meta.id): the roll aligner's cascade accepted it",
			conf: "confidence from the cascade",
		},
		{
			k: "prior",
			on: true,
			set: () => {},
			title: "EXIF prior",
			from: "priorPose(meta): compass heading (0 if none), gravity pitch and roll, lens vfov",
			conf: "unverified",
		},
	];
	const win = rungs.findIndex((r) => r.on);
	return (
		<Figure
			label="Fig. 3"
			caption="Schematic. resolvePose is a ladder, not a solver. Switch what a photo has on file and the first rung that exists wins; the roll never runs a solve just to be drawn. Nothing here is stored on the roll itself: it is rebuilt on every load from the photos and whatever the browser remembers."
		>
			<ol className="space-y-2">
				{rungs.map((r, i) => {
					const live = i === win;
					return (
						<li
							key={r.k}
							className="grid grid-cols-[auto_1fr] items-center gap-3 rounded-lg px-3 py-2 transition-colors"
							style={{
								background: live
									? "color-mix(in oklab, var(--accent) 14%, transparent)"
									: "rgba(255,255,255,.03)",
								boxShadow: `inset 0 0 0 1px ${live ? "var(--accent)" : "rgba(255,255,255,.06)"}`,
								opacity: i < win || live ? 1 : 0.45,
							}}
						>
							{r.k === "prior" ? (
								<span className="w-[72px] text-center font-mono text-[10px] text-white/40">
									always
								</span>
							) : (
								<Chip on={r.on} onClick={() => r.set(!r.on)}>
									{r.on ? "has it" : "missing"}
								</Chip>
							)}
							<div>
								<div className="flex flex-wrap items-baseline gap-x-3">
									<span className="text-[14px] font-semibold text-[var(--rigi-paper)]">
										{i + 1}. {r.title}
									</span>
									{live && (
										<span className="font-mono text-[10px] tracking-[0.12em] text-[var(--accent)] uppercase">
											used · {r.conf}
										</span>
									)}
								</div>
								<div className="font-mono text-[11px] leading-snug text-white/45">
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
	const arrow = (deg: number, r: number, stroke: string, dash?: string) => {
		const [x, y] = at(deg, r);
		return (
			<g>
				<line
					x1={cx}
					y1={cy}
					x2={x}
					y2={y}
					stroke={stroke}
					strokeWidth="2"
					strokeDasharray={dash}
				/>
				<circle cx={x} cy={y} r="4" fill={stroke} />
			</g>
		);
	};
	return (
		<Figure
			label="Fig. 4"
			caption="Schematic, the best case (invented numbers; the real roll above is messier). If a phone carries one compass bias for a whole stop, then once any photo at a viewpoint is anchored, the median of its yaw offsets (within 45 minutes) shifts the starting prior for its neighbours. The solver's ±25° yaw window then lands on the heading instead of missing it. The prior is only a starting point; the cascade still decides acceptance."
		>
			<div className="grid items-center gap-5 md:grid-cols-[minmax(0,300px)_1fr]">
				<svg
					viewBox="0 0 300 300"
					className="mx-auto block h-auto w-full max-w-[300px]"
					role="img"
					aria-label="Compass dial: EXIF heading, biased prior, solver window and true yaw"
				>
					<title>Compass bias and the solver window</title>
					<circle
						cx={cx}
						cy={cy}
						r={R}
						fill="none"
						stroke="rgba(236,230,218,.12)"
					/>
					<path
						d={wedge(centre, SEARCH_YAW, R)}
						fill={inside ? "var(--accent)" : "var(--rigi-trap)"}
						fillOpacity=".14"
						stroke={inside ? "var(--accent)" : "var(--rigi-trap)"}
						strokeOpacity=".5"
					/>
					{arrow(heading, R - 24, "rgba(236,230,218,.45)", "3 4")}
					{applicable && arrow(centre, R - 8, "var(--accent)")}
					{arrow(trueYaw, R + 4, "var(--rigi-paper)")}
					<g className="font-mono" fontSize="9.5" fill="rgba(236,230,218,.55)">
						<text x={cx} y="14" textAnchor="middle">
							N
						</text>
						<text
							x={cx}
							y={cy + 4}
							textAnchor="middle"
							fill="var(--rigi-paper)"
						>
							{inside ? "in window" : "outside"}
						</text>
					</g>
				</svg>
				<div className="space-y-3">
					<div className="grid grid-cols-1 gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-2">
						{anchors.map((a) => {
							const out = Math.abs(a.min) > BIAS_WINDOW_MIN;
							return (
								<div
									key={a.label}
									className="flex justify-between gap-3"
									style={{ opacity: out ? 0.35 : 1 }}
								>
									<span className="text-white/55">
										{a.label} · {a.min > 0 ? "+" : "−"}
										{Math.abs(a.min)} min
									</span>
									<span className="text-[var(--rigi-paper)]">
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
							viewpoint bias {use ? "on" : "off"}
						</Chip>
						<Chip on={wrong} onClick={() => setWrong(!wrong)}>
							add a wrong anchor
						</Chip>
					</div>
					<p className="font-mono text-[11px] leading-relaxed text-white/50">
						median {fmt(med, 1)}° ·{" "}
						{applicable
							? `prior shifted to ${(((centre % 360) + 360) % 360).toFixed(0)}°`
							: use
								? "below 1° or above 90°: prior left alone"
								: "prior = raw compass"}{" "}
						· true yaw is {Math.abs(miss).toFixed(1)}° from the window centre.
						Dashed = EXIF, accent = shifted prior, cream = truth.
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
			label="Fig. 5"
			bleed
			caption="Schematic (synthetic scene, real mapping maths). Photos from one viewpoint stitch without feature matching. buildMesh turns each photo into a grid of rays (u, v), and its pose sends every ray to a true azimuth and elevation on a shared canvas, so roll rotates the image and wide lenses bend. The DEM ridgelines traced from the viewpoint eye (accent) sit behind here; the app overlays them as the match cue. Each photo's own skyline (cream) lies on the terrain only when its pose is right: the middle photo starts with a compass and roll error and settles as the pose is found."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<svg
					viewBox={`0 0 ${PW} ${PH}`}
					className="block h-auto w-full rounded-xl bg-[#0f1417]"
					role="img"
					aria-label="Three photos warped onto an azimuth by elevation canvas over DEM ridgelines"
				>
					<title>Panorama canvas with warped photo meshes</title>
					<path
						d={ridge(farRidge)}
						fill="none"
						stroke="rgba(236,230,218,.22)"
						strokeWidth="1"
					/>
					<path
						d={ridge(skyline)}
						fill="none"
						stroke="var(--accent)"
						strokeWidth={aligned ? 3 : 1.6}
						strokeOpacity={aligned ? 0.9 : 0.8}
					/>
					{photos.map((ph, i) => (
						<g key={`ph-${TRUE_POSES[i].yaw}`}>
							<path
								d={ph.outline}
								fill="rgba(236,230,218,.055)"
								stroke={i === 1 ? "var(--accent)" : "rgba(236,230,218,.5)"}
								strokeWidth={i === 1 ? 1.4 : 1}
							/>
							{ph.grid.map((g) => (
								<path
									key={g}
									d={g}
									fill="none"
									stroke="rgba(236,230,218,.12)"
									strokeWidth=".7"
								/>
							))}
							<path
								d={ph.sky}
								fill="none"
								stroke="var(--rigi-paper)"
								strokeWidth="1.6"
							/>
						</g>
					))}
					<g className="font-mono" fontSize="10" fill="rgba(236,230,218,.5)">
						{[0, 30, 60, 90].map((a) => (
							<text key={a} x={px(a)} y={PH - 8} textAnchor="middle">
								{`${a}°`}
							</text>
						))}
						<text x="10" y="16">
							azimuth → · elevation ↑
						</text>
						<text
							x={PW - 10}
							y="16"
							textAnchor="end"
							fill={aligned ? "var(--accent)" : "rgba(236,230,218,.5)"}
						>
							{aligned
								? "ridge continuous · match cue on"
								: "seam: pose is off"}
						</text>
					</g>
				</svg>
			</div>
			<div className="mt-4 grid items-end gap-4 md:grid-cols-[1fr_1fr_auto]">
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
// Real data: the 12-photo Niederhorn demo roll (scripts/atlas/data-camera-roll.ts → public/demo/atlas/camera-roll/roll.json)
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
		fetch("/demo/atlas/camera-roll/roll.json")
			.then((r) => r.json())
			.then((v) => live && setD(v))
			.catch((e) => console.warn("[atlas] camera-roll data", e));
		return () => {
			live = false;
		};
	}, []);
	return d;
}

const PRIOR_C = "#ff5fa2";
const SOLVED_C = "#5ee0f4";
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
			<div className="my-9 aspect-[16/10] w-full animate-pulse rounded-2xl bg-white/[0.04]" />
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
	const hs = rows.map((r) => r.hAccuracy);
	const ray = (r: RollRow, yaw: number, len: number): [number, number] => [
		mx(r.east) + len * Math.sin(yaw * D),
		my(r.north) - len * Math.cos(yaw * D),
	];
	return (
		<Figure
			label="Real 1"
			bleed
			caption={
				<>
					Click a photo or a dot. Dashed magenta is the phone's compass, cyan
					the solved direction. Orange dots are the two photos the solve
					rejected. Grouping uses the code's real rules. <Measured data={d} />
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
					return (
						<g key={r.id}>
							<path
								d={`M${cx} ${th + 6} L${tx(r.t)} 118`}
								stroke={on ? "var(--rigi-paper)" : "rgba(236,230,218,.25)"}
								strokeWidth={on ? 1.4 : 0.8}
								fill="none"
							/>
							<circle
								cx={tx(r.t)}
								cy={118}
								r={on ? 4 : 2.6}
								fill={r.accepted ? "var(--accent)" : "var(--rigi-trap)"}
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
								<rect
									x={i * slot + 2}
									y={4}
									width={slot - 4}
									height={th}
									fill="none"
									stroke={
										on
											? "var(--rigi-paper)"
											: r.accepted
												? "var(--accent)"
												: "var(--rigi-trap)"
									}
									strokeWidth={on ? 2.4 : 1}
								/>
							</g>
						</g>
					);
				})}
				<line
					x1={18}
					x2={TW - 18}
					y1={118}
					y2={118}
					stroke="rgba(236,230,218,.3)"
				/>
				{[0, 5, 10, 15, 20].map((m) => (
					<g key={m}>
						<line
							x1={tx(m * 60)}
							x2={tx(m * 60)}
							y1={118}
							y2={124}
							stroke="rgba(236,230,218,.4)"
						/>
						<text
							x={tx(m * 60)}
							y={138}
							textAnchor="middle"
							fontSize="10"
							fill="rgba(236,230,218,.5)"
							fontFamily="ui-monospace, monospace"
						>
							+{m} min
						</text>
					</g>
				))}
			</svg>
			<div className="mt-5 grid items-center gap-5 md:grid-cols-[minmax(0,380px)_1fr]">
				<svg
					viewBox={`0 0 ${S} ${S}`}
					className="mx-auto block h-auto w-full max-w-[400px] rounded-xl bg-[#11161a]"
					role="img"
					aria-label="Plan view of the 12 camera positions with GPS accuracy circles, compass headings and solved yaws"
				>
					<title>Plan view of the camera positions</title>
					{[-200, -100, 0, 100, 200].map((m) => (
						<g key={m} stroke="rgba(236,230,218,.07)">
							<line x1={mx(m)} x2={mx(m)} y1={0} y2={S} />
							<line y1={my(m)} y2={my(m)} x1={0} x2={S} />
						</g>
					))}
					<circle
						cx={mx(first.east)}
						cy={my(first.north)}
						r={d.viewpointRadiusM * MS}
						fill="var(--accent)"
						fillOpacity={0.05}
						stroke="var(--accent)"
						strokeDasharray="4 4"
						strokeOpacity={0.6}
					/>
					{rows.map((r) => (
						<circle
							key={r.id}
							cx={mx(r.east)}
							cy={my(r.north)}
							r={r.hAccuracy * MS}
							fill="rgba(236,230,218,.04)"
							stroke={
								r.id === sel ? "var(--rigi-paper)" : "rgba(236,230,218,.22)"
							}
							strokeWidth={r.id === sel ? 1.4 : 0.8}
						/>
					))}
					{rows.map((r) => {
						const [px1, py1] = ray(r, r.heading, 52);
						const [sx1, sy1] = ray(r, r.solvedYaw, 52);
						return (
							<g key={r.id} opacity={r.id === sel ? 1 : 0.45}>
								<line
									x1={mx(r.east)}
									y1={my(r.north)}
									x2={px1}
									y2={py1}
									stroke={PRIOR_C}
									strokeDasharray="3 3"
									strokeWidth={1.4}
								/>
								<line
									x1={mx(r.east)}
									y1={my(r.north)}
									x2={sx1}
									y2={sy1}
									stroke={SOLVED_C}
									strokeWidth={1.8}
								/>
							</g>
						);
					})}
					{rows.map((r) => (
						<g key={r.id}>
							{/* biome-ignore lint/a11y/useSemanticElements: an SVG circle cannot be a <button> */}
							<circle
								cx={mx(r.east)}
								cy={my(r.north)}
								r={r.id === sel ? 6 : 4}
								fill={r.accepted ? "var(--accent)" : "var(--rigi-trap)"}
								stroke={r.id === sel ? "var(--rigi-paper)" : "#0e1012"}
								strokeWidth={1.6}
								style={{ cursor: "pointer" }}
								onClick={() => setSel(r.id)}
								role="button"
								tabIndex={0}
								aria-label={r.id}
								onKeyDown={(e) => e.key === "Enter" && setSel(r.id)}
							/>
						</g>
					))}
					<line
						x1={16}
						x2={16 + 100 * MS}
						y1={S - 16}
						y2={S - 16}
						stroke="rgba(236,230,218,.7)"
						strokeWidth={2}
					/>
					<text
						x={16}
						y={S - 22}
						fontSize="10"
						fill="rgba(236,230,218,.7)"
						fontFamily="ui-monospace, monospace"
					>
						100 m
					</text>
					<text
						x={S - 8}
						y={16}
						textAnchor="end"
						fontSize="10"
						fill="rgba(236,230,218,.7)"
						fontFamily="ui-monospace, monospace"
					>
						N↑ · dashed ring = 250 m
					</text>
				</svg>
				<div className="space-y-3 font-mono text-[11.5px] leading-relaxed text-white/55">
					<div className="rounded-lg bg-white/[0.04] p-3 text-[var(--rigi-paper)]">
						<div className="mb-1 text-white/80">
							{cur.id} · +{mmss(cur.t)} ·{" "}
							{cur.accepted ? "accepted" : "rejected by the cascade"}
						</div>
						GPS ±{cur.hAccuracy.toFixed(0)} m
						<br />
						compass {cur.heading.toFixed(1)}° → solved{" "}
						{cur.solvedYaw.toFixed(1)}° ({fmt(cur.yawOffset, 1)}°)
					</div>
					<p>
						<span className="text-[var(--rigi-paper)]">
							{d.clusters.length} roll
						</span>{" "}
						({d.clusters[0]} photos within 15 km of a neighbour),{" "}
						<span className="text-[var(--rigi-paper)]">
							{d.viewpoints.length} viewpoint
						</span>
						: every photo is within {maxFromFirst.toFixed(0)} m of the first,
						well inside the 250 m rule.
					</p>
					<p>
						Captured over{" "}
						<span className="text-[var(--rigi-paper)]">
							{mmss(d.spanS)} min
						</span>
						, in four bursts. {acc} of {rows.length} are accepted by the
						cascade.
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
			label="Real 2"
			bleed
			caption={
				<>
					Dots: solved yaw minus compass, per photo in shooting order (hollow =
					rejected). Cyan ticks: what the earlier photos would have predicted.
					This replays the real bias estimate over the CPU run's accepted poses.{" "}
					<Measured data={d} />
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
						<line
							x1={L}
							x2={W - 8}
							y1={Y(v)}
							y2={Y(v)}
							stroke={
								v === 0 ? "rgba(236,230,218,.35)" : "rgba(236,230,218,.08)"
							}
						/>
						<text
							x={L - 6}
							y={Y(v) + 3.5}
							textAnchor="end"
							fontSize="10"
							fill="rgba(236,230,218,.5)"
							fontFamily="ui-monospace, monospace"
						>
							{v > 0 ? "+" : v < 0 ? "−" : ""}
							{Math.abs(v)}°
						</text>
					</g>
				))}
				{rows.map((r, i) => (
					<g key={r.id}>
						{r.seqBias != null && (
							<>
								<line
									x1={X(i)}
									x2={X(i)}
									y1={Y(r.seqBias)}
									y2={Y(r.yawOffset)}
									stroke={SOLVED_C}
									strokeOpacity={0.55}
									strokeWidth={2}
								/>
								<line
									x1={X(i) - 11}
									x2={X(i) + 11}
									y1={Y(r.seqBias)}
									y2={Y(r.seqBias)}
									stroke={SOLVED_C}
									strokeWidth={2.4}
								/>
							</>
						)}
						<circle
							cx={X(i)}
							cy={Y(r.yawOffset)}
							r={5}
							fill={r.accepted ? "var(--accent)" : "#0e1012"}
							stroke={r.accepted ? "#0e1012" : "var(--rigi-trap)"}
							strokeWidth={1.8}
						/>
						<text
							x={X(i)}
							y={H - 24}
							textAnchor="middle"
							fontSize="10"
							fill="rgba(236,230,218,.7)"
							fontFamily="ui-monospace, monospace"
						>
							{num(r.id)}
						</text>
						<text
							x={X(i)}
							y={H - 10}
							textAnchor="middle"
							fontSize="9"
							fill="rgba(236,230,218,.4)"
							fontFamily="ui-monospace, monospace"
						>
							{mmss(r.t)}
						</text>
					</g>
				))}
			</svg>
			<p className="mt-3 font-mono text-[11.5px] leading-relaxed text-white/55">
				Across the {accOff.length} accepted photos the compass error runs from{" "}
				<span className="text-[var(--rigi-paper)]">
					{fmt(Math.min(...accOff), 1)}° to {fmt(Math.max(...accOff), 1)}°
				</span>{" "}
				within {mmss(d.spanS)} min at one spot. The estimate from earlier
				anchors tracks the first five photos, then misses once the heading
				changes: on the {used.length} accepted photos that had an estimate it
				lowers the error for {better}, leaves it for{" "}
				{used.length - better - worse}, raises it for {worse}. The code's own
				consistency check (
				<span className="text-[var(--rigi-paper)]">OUTLIER_DEG</span> = 8°,
				against all the other anchors) flags {outliers} of {looRows.length}{" "}
				accepted photos here.
			</p>
		</Figure>
	);
}

// ======================================================================================
// Explainer layer: hero, trio, numbers (real data from roll.json and the atlas photo files)
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
function ridgeBand(d: AtlasPhotoData): [number, number, number, number] {
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
	const d = useAtlasPhoto("demo-03");
	const spread = roll
		? Math.max(
				...roll.rows.map((r) =>
					Math.hypot(r.east - roll.rows[0].east, r.north - roll.rows[0].north),
				),
			)
		: null;
	const frame = (child: ReactNode) => (
		<div className="relative aspect-[16/10] w-full overflow-hidden rounded-xl bg-black/30">
			<div className="absolute inset-0 flex items-center justify-center">
				{child}
			</div>
		</div>
	);
	return (
		<Figure
			label="Fig. 1"
			caption={
				<>
					{spread == null
						? "Twelve photos become one place."
						: `All 12 photos were taken within ${Math.round(spread)} m of the first, so their views fan out from one spot.`}{" "}
					<Measured data={roll} />
				</>
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
							"Each photo is aimed by its solved direction. Orange cones are photos the solve rejected.",
						render: () =>
							frame(
								<div className="h-full max-w-full" style={{ aspectRatio: "1" }}>
									<DemPatch data={d} cone={[]} peaks={false}>
										{(_, toPx) => (
											<g>
												{roll?.rows.map((r) => (
													<path
														key={r.id}
														d={cone(toPx, r.solvedYaw, r.solvedHfov, 14000)}
														fill={r.accepted ? "#5ee0f4" : "#ee9086"}
														fillOpacity={0.12}
														stroke={r.accepted ? "#5ee0f4" : "#ee9086"}
														strokeOpacity={0.7}
														strokeWidth={1}
													/>
												))}
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
		return <div className="aspect-[4/3] animate-pulse bg-white/[0.04]" />;
	const S = 200;
	const MS = 0.34;
	const mx = (e: number) => S / 2 + e * MS;
	const my = (n: number) => S / 2 - n * MS;
	const f = roll.rows[0];
	return (
		<svg
			viewBox={`0 0 ${S} ${S}`}
			className="block h-auto w-full bg-[#11161a]"
			role="img"
			aria-label="The 12 camera positions inside one viewpoint ring"
		>
			<title>Camera positions inside one 250 m ring</title>
			<circle
				cx={mx(f.east)}
				cy={my(f.north)}
				r={roll.viewpointRadiusM * MS}
				fill="var(--accent)"
				fillOpacity={0.08}
				stroke="var(--accent)"
				strokeDasharray="4 4"
			/>
			{roll.rows.map((r) => (
				<circle
					key={r.id}
					cx={mx(r.east)}
					cy={my(r.north)}
					r={3.2}
					fill={r.accepted ? "var(--accent)" : "var(--rigi-trap)"}
				/>
			))}
		</svg>
	);
}

function MiniAim() {
	const d = useAtlasPhoto("demo-09");
	return <DemPatch data={d} cone={["prior", "solved"]} peaks={false} />;
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
				{ value: mmss(d.spanS), label: "minutes of shooting, all at one spot" },
				{
					value: `${fmt(lo)}° to ${fmt(hi)}°`,
					label: "compass error across the accepted photos",
				},
				{
					value: "15 km",
					label: "link distance that joins photos into a roll",
				},
			]}
			source={
				<>
					Measured on the 12 demo photos ({d.script}, {d.generated}). Link
					distance: src/lib/roll/roll.ts.
				</>
			}
		/>
	);
}

export default function Page({ node: _node }: { node: AtlasNode }) {
	const A = (id: string, label: string) => (
		<Link
			to="/atlas/$concept"
			params={{ concept: id }}
			className="underline decoration-white/30 underline-offset-2 hover:decoration-current"
		>
			{label}
		</Link>
	);
	return (
		<>
			<HeroStages />

			<Beat kicker="The idea" title="A day of photos is a place, not a pile.">
				<p>
					Each photo already has a time, a rough position and a compass reading.
					Rigi uses them to group the photos and aim each one.
				</p>
				<p>Nothing is stored. The roll is worked out again each time.</p>
			</Beat>

			<RealRoll />

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
							body: "Magenta is the compass, cyan the solved direction.",
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

			<Beat
				kicker="Where it fails"
				title="Compass errors change within minutes, so a neighbour's fix is only a hint."
			>
				<p>
					Photos from one spot often share a compass error. Here it does for a
					while, then the heading changes.
				</p>
			</Beat>

			<RealBias />

			<RollNumbers />

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next: {A("step-inside", "Step Inside")} puts you at the camera's eye.
				Each pose comes from {A("viewport-inference", "viewport inference")}.
			</p>

			<Details>
				<p>
					A <code>Roll</code> is derived on the fly from photo metadata plus
					whatever poses the browser already remembers. Two small distance rules
					structure it, and a pose ladder aims each photo. Solving a pose from
					scratch is the job of {A("viewport-inference", "viewport inference")},
					so the roll never repeats it just to draw a screen.
				</p>

				<RollLinker />

				<h3>Areas, then viewpoints</h3>
				<div className="space-y-3">
					<p>
						<code>clusterPhotos</code> is single-linkage with{" "}
						<code>ROLL_LINK_M = 15&nbsp;000&nbsp;m</code>: photos closer than 15
						km to a neighbour share a roll, transitively. A day's hike stays one
						roll even when its ends are far apart, and uploads from two trips
						split naturally. Within a roll, <code>groupViewpoints</code> walks
						the photos in capture time and files each under the first viewpoint
						whose opening photo is within{" "}
						<code>VIEWPOINT_RADIUS_M = 250&nbsp;m</code>. Each viewpoint is then
						re-centred on its members. A viewpoint matters because the photos
						taken there are close enough to share one eye, which is what makes a
						panorama and a shared compass bias possible.
					</p>
				</div>

				<ViewpointWalk />

				<h3>The best pose we already have</h3>
				<div className="space-y-3">
					<p>
						Each photo gets a pose from <code>resolvePose</code> with no solver
						run. The first of four sources wins. The ladder keeps the roll fast
						and honest: a photo shows as <code>prior</code> until something
						better, a person's pin or an accepted solve, replaces it. The{" "}
						{A("camera-prior", "EXIF prior")} is the floor: compass heading (0
						if there is none), gravity pitch and roll, and the lens field of
						view.
					</p>
				</div>

				<PoseLadder />

				<h3>Anchors teach their neighbours</h3>
				<div className="space-y-3">
					<p>
						<code>alignRoll</code> runs the frozen single-photo cascade, one
						photo at a time in capture order, on every photo that still has only
						its prior. It stores a pose only when the cascade accepts, so a
						rejected photo stays visibly "needs review". The roll adds one idea:
						photos at the same viewpoint, within minutes, often share the
						phone's compass bias, so every anchored photo gives its neighbours a
						better <em>starting prior</em> (the real roll below shows where that
						holds and where it does not). The estimate is the median of the
						anchors' yaw offsets, so a single wrong anchor cannot drag it. It is
						used only between 1° and 90°, and only for anchors within 45 minutes
						(<code>BIAS_WINDOW_S</code>). A photo rejected before its spot had
						an anchor gets one retry when the new bias differs by at least 2°.
					</p>
				</div>

				<CompassBias />

				<h3>A viewpoint becomes a panorama</h3>
				<div className="space-y-3">
					<p>
						With poses in hand the strip needs no matching. Every photo is a
						subdivided mesh whose vertices are the rays of a (u, v) grid;
						unprojecting each through the photo's pose puts it on an azimuth ×
						elevation canvas, so roll turns the picture and a wide lens bends
						correctly. Meshes repeat every 360° so a full circle wraps. The{" "}
						<code>traceViewpoint</code> worker traces the viewpoint's 360° DEM
						ridgelines in depth slabs (log-spaced from 40 m to 120 km), from the
						same eye as the {A("dem-horizon", "DEM horizon")}, and the strip
						draws them over each photo as a match cue. Only aligned photos get
						it, never prior-only ones, because a prior pose is only a guess.
					</p>
				</div>

				<PanoramaStrip />

				<h3>Many photos, one drape</h3>
				<div className="space-y-3">
					<p>
						The roll map refines the DEM quadtree around every viewpoint rather
						than one centre (<code>roll-terrain.ts</code>), then drapes all
						photos in a single fragment pass (<code>multi-drape-layer.ts</code>
						). Each tile lists the photos whose frustum reaches it and that are
						not hidden from it; a fragment weighs candidates by incidence,
						distance and a feather at the frame edge, and keeps the best{" "}
						<code>TOP_K = 4</code>. Visibility comes from each photo's range
						map, with a 2×2 filtered test so silhouettes fade instead of
						stair-stepping. Because every photo competes in one blend, the
						result does not depend on draw order or roll size. Photos live in up
						to four mip-mapped atlases (the first 16 at 1024 px cells) so a
						large roll stays inside a GPU memory budget.
					</p>
				</div>

				<Figure
					label="Real 3"
					bleed
					pad={false}
					caption="The same 12-photo roll in the live roll map (screenshot of the app, public/demo/shots/drape.jpg): every photo draped at once on the DEM. All 12 camera positions lie within a hundred metres of each other, so the orange pins pile up at one spot and the photos fan out from it over the Niederhorn ridge and the valley."
				>
					<img
						src="/demo/shots/drape.jpg"
						alt="The Niederhorn roll draped on the 3D terrain: twelve photos fan out from a single viewpoint over the ridge and valley"
						className="block h-auto w-full"
					/>
				</Figure>

				<Callout tone="result" title="Derived, never stored">
					Rolls, viewpoints and pose sources are recomputed from metadata every
					time, with stable upload ids (<code>local-roll-&lt;hash&gt;</code>{" "}
					from the earliest photo). Delete a photo and the roll simply re-forms.
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
					<p className="!mt-3 font-mono text-[12.5px] text-white/55">
						clusterPhotos, groupViewpoints, makeRoll, resolvePose, priorPose,
						alignRoll, viewpointBias, biasedPrior, buildMesh, traceViewpoint
					</p>
				</div>

				<h3>From file to draped roll</h3>
				<div className="space-y-3">
					<Steps
						steps={[
							{
								title: "Import",
								body: "Photos are read for EXIF; a photo with no GPS gets a position interpolated between two neighbours within 20 minutes (interpolate.ts), with a growing accuracy estimate.",
							},
							{
								title: "Cluster and group",
								body: "Single-linkage at 15 km gives the rolls; the 250 m first-match rule gives the viewpoints, re-centred on their members.",
							},
							{
								title: "Resolve poses",
								body: "Saved, then ground truth, then the roll aligner's accepted pose, then the EXIF prior. Each photo carries its source and confidence.",
							},
							{
								title: "Align (optional)",
								body: "The cascade runs on prior-only photos in capture order, with viewpoint-bias priors. Only accepted poses are stored.",
							},
							{
								title: "Show",
								body: "Mosaic and panorama strip from poses; terrain drape on the map from the same poses.",
							},
						]}
					/>
				</div>

				<h3>Rolls reuse, they do not re-solve</h3>
				<div className="space-y-3">
					<p>
						The aligner calls straight into the cascade described under{" "}
						{A("viewport-inference", "viewport inference")}, and its accepted
						poses obey the {A("accept-rule", "accept rule")}. The terrain under
						the drape comes from the {A("dem-source", "DEM")}; the same photos
						can then {A("step-inside", "step inside")} for a near-field view,
						and each opens in the {A("photo-workspace", "photo workspace")}.
						Snapping to terrain is covered in{" "}
						{A("terrain-snapping", "terrain snapping")}.
					</p>
				</div>
			</Details>
		</>
	);
}
