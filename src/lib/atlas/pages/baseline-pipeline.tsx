// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
	type AtlasIndex,
	type AtlasPhotoData,
	type AtlasPhotoId,
	Callout,
	CodeRef,
	Figure,
	Measured,
	PhotoPicker,
	RealPhoto,
	Section,
	Stat,
	Steps,
	useAtlasIndex,
	useAtlasPhoto,
	useTime,
} from "#/components/atlas/viz";
import {
	Beat,
	Details,
	Gallery,
	Numbers,
	Stages,
	skylineBand,
	Trio,
} from "#/components/atlas/viz/explain";
import { atlasHref } from "#/lib/atlas/graph-utils";
import type { AtlasNode } from "#/lib/atlas/types";

// Baseline pipeline: the CPU path end to end.
// Facts are from src/lib/geo/pipeline.ts (loadScene, sceneHorizon, cascade / escalate, EYE_ABOVE_GROUND 1.6),
// src/lib/geo/solve.ts (solvePose, fullOnly, wantsFull, pickFull, DEFAULT_SIGMA, FULL_SEARCH_CONFIDENCE 0.75)
// and src/lib/geo/README.md (12 hand-registered photos, 2026-09-24; stage timings; accuracy table).
// The artefacts drawn inside the Fig. 1 panels are schematic, not data; the measured figures (A to C) use the real
// pipeline on the 12 Niederhorn demo photos (public/demo/atlas, scripts/atlas/build-data.ts) and out/eval*/report.json.

const A = (id: string, label: string) => (
	<Link
		to={atlasHref(id)}
		className="underline decoration-white/30 underline-offset-2"
	>
		{label}
	</Link>
);

const PAPER = "var(--rigi-paper)";
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (k: number) => k * k * (3 - 2 * k);

// ---------- schematic ground shared by the stage panels ----------
const RIDGE = (n: number, w: number, h: number, ph = 0) =>
	Array.from({ length: n + 1 }, (_, i) => {
		const x = (i / n) * w;
		const u = i / n;
		const y =
			h *
			(0.5 -
				0.26 * Math.sin(u * 7 + ph) * Math.exp(-((u - 0.55) ** 2) * 6) -
				0.16 * Math.sin(u * 19 + 1 + ph) -
				0.08 * Math.sin(u * 41 + ph * 2));
		return [x, y] as [number, number];
	});
const path = (pts: [number, number][], dx = 0, dy = 0) =>
	pts
		.map(
			([x, y], i) =>
				`${i ? "L" : "M"}${(x + dx).toFixed(1)} ${(y + dy).toFixed(1)}`,
		)
		.join(" ");

// ======================================================================================
// Fig. 1: the conveyor
// ======================================================================================
const STAGES = [
	{
		fn: "readPhotoMeta",
		sub: "cameraFromMeta",
		out: "prior camera",
		cost: "EXIF + MakerNote",
	},
	{
		fn: "loadTerrain",
		sub: "sceneHorizon",
		out: "360° horizon",
		cost: "4.7 s classic",
	},
	{
		fn: "detectSkyline",
		sub: "per-column Viterbi",
		out: "photo skyline",
		cost: "150 ms",
	},
	{
		fn: "solvePose",
		sub: "grid → Cauchy LM",
		out: "yaw pitch roll f",
		cost: "95 ms",
	},
	{
		fn: "confidence gate",
		sub: "0.5 local / 0.75 360°",
		out: "accept or escalate",
		cost: "",
	},
] as const;
const PW = 132;
const GAP = 15;
const px = (i: number) => i * (PW + GAP);

function Conveyor() {
	const [ref, t] = useTime<HTMLDivElement>();
	// two runs per 20 s: run 0 is accepted by solvePose; run 1 is rejected and rescued by refinePose
	const CYC = 10;
	const run = Math.floor(t / CYC) % 2;
	const u = (t % CYC) / CYC; // 0..1 within a run
	// token position in stage units: dwell ~0.8 s on each of 5 stages, then (run 1) detour to refine
	const stagePos = clamp01(u / 0.62) * 4;
	const active = Math.min(4, Math.round(stagePos));
	const atGate = u > 0.62;
	const gateT = clamp01((u - 0.62) / 0.12);
	const reject = run === 1;
	const refineT = reject ? clamp01((u - 0.74) / 0.18) : 0;
	const done = u > 0.92;
	const conf = reject ? 0.31 + 0.5 * ease(refineT) : 0.5 + 0.28 * ease(gateT);
	const ok = reject ? refineT >= 1 : gateT > 0.7;
	const accent = "var(--accent)";
	const ridge = RIDGE(40, 100, 60);
	const ridge2 = RIDGE(40, 100, 60, 0.35);
	const tokenX = px(Math.min(stagePos, 4)) + PW / 2;
	const W = px(4) + PW;

	return (
		<Figure
			label="Fig. 1"
			bleed
			caption="Synthetic panels, exact order. One photo through the five CPU stages, as the code calls them (costs: median over the 12 demo photos, classic horizon, CPU; Fig. A has the real artefacts). The fork is exact: solvePose either accepts (run A) or the cascade hands the same prior, horizon and skyline to refinePose (run B). The loop alternates the two."
		>
			<div ref={ref} className="-m-1 overflow-x-auto sm:-m-2">
				<svg
					viewBox={`0 0 ${W} 372`}
					className="block h-auto w-full min-w-[620px]"
					role="img"
					aria-label="Five pipeline stages with a photo token moving through them and a final accept or escalate gate"
				>
					<text
						x="0"
						y="14"
						fontSize="11"
						fill="var(--accent)"
						fontFamily="monospace"
					>
						{reject
							? "run B · solvePose rejects, refinePose rescues"
							: "run A · solvePose accepts"}
					</text>
					{/* rail */}
					<line
						x1={PW / 2}
						y1="196"
						x2={W - PW / 2}
						y2="196"
						stroke="white"
						strokeOpacity=".12"
						strokeWidth="2"
					/>
					<line
						x1={PW / 2}
						y1="196"
						x2={tokenX}
						y2="196"
						stroke={accent}
						strokeOpacity=".7"
						strokeWidth="2"
					/>
					{STAGES.map((s, i) => {
						const lit = i <= active && !done ? true : done;
						return (
							<g key={s.fn} transform={`translate(${px(i)} 30)`}>
								<rect
									width={PW}
									height="140"
									rx="10"
									fill="#12161a"
									stroke={i === active && !done ? accent : "white"}
									strokeOpacity={i === active && !done ? 0.9 : 0.14}
								/>
								{/* artefact */}
								<g transform="translate(16 20)" opacity={lit ? 1 : 0.35}>
									{i === 0 && <MetaArtefact t={t} />}
									{i === 1 && <HorizonArtefact ridge={ridge} t={t} />}
									{i === 2 && <SkylineArtefact ridge={ridge2} />}
									{i === 3 && <GridArtefact t={t} u={u} />}
									{i === 4 && (
										<GateArtefact
											conf={conf}
											ok={ok && atGate}
											reject={reject}
											showing={atGate}
										/>
									)}
								</g>
								<text
									x="10"
									y="132"
									fontSize="9.5"
									fill="white"
									fillOpacity=".4"
									fontFamily="monospace"
								>
									{s.out}
								</text>
							</g>
						);
					})}
					{/* labels under rail */}
					{STAGES.map((s, i) => (
						<g key={s.fn} transform={`translate(${px(i)} 0)`}>
							<text
								x={PW / 2}
								y="226"
								textAnchor="middle"
								fontSize="12"
								fill={PAPER}
								fontFamily="monospace"
							>
								{s.fn}
							</text>
							<text
								x={PW / 2}
								y="241"
								textAnchor="middle"
								fontSize="10"
								fill="white"
								fillOpacity=".45"
							>
								{s.sub}
							</text>
							{s.cost && (
								<text
									x={PW / 2}
									y="255"
									textAnchor="middle"
									fontSize="10"
									fill={accent}
									fillOpacity=".85"
									fontFamily="monospace"
								>
									{s.cost}
								</text>
							)}
						</g>
					))}
					{/* token */}
					<g transform={`translate(${tokenX} 196)`}>
						<circle r="9" fill={accent} fillOpacity=".25" />
						<circle r="4.5" fill={accent} />
					</g>
					{/* escalation lane */}
					<g
						transform={`translate(${px(3)} 280)`}
						opacity={reject && atGate ? 1 : 0.28}
					>
						<path
							d={`M${PW + GAP + PW / 2} -26 V0 H${PW / 2 + 0} V12`}
							fill="none"
							stroke="#d96a5b"
							strokeDasharray="4 4"
							strokeOpacity=".8"
						/>
						<rect
							x="-10"
							y="12"
							width={PW + GAP + PW + 20 - 100}
							height="54"
							rx="9"
							fill="#12161a"
							stroke={reject && atGate ? accent : "white"}
							strokeOpacity={reject && atGate ? 0.8 : 0.14}
						/>
						<text
							x="2"
							y="31"
							fontSize="12"
							fill={PAPER}
							fontFamily="monospace"
						>
							refinePose
						</text>
						<text x="2" y="47" fontSize="10" fill="white" fillOpacity=".5">
							FFT yaw ring · robust IRLS · 0.4–1.3 s measured
						</text>
						<rect
							x="2"
							y="54"
							width={Math.max(0, 150 * refineT)}
							height="3"
							rx="1.5"
							fill={accent}
						/>
					</g>
					<text x="0" y="318" fontSize="10.5" fill="white" fillOpacity=".5">
						No stage ever returns a pose without a verdict. If both reject, the
						prior is shown as unverified and the user taps peaks.
					</text>
					{/* the two outcomes */}
					<g transform={`translate(0 336)`}>
						<circle cx="6" cy="6" r="4" fill="#78c28a" />
						<text x="16" y="10" fontSize="11" fill={PAPER}>
							first accepting stage wins
						</text>
						<circle cx="204" cy="6" r="4" fill="#d96a5b" />
						<text x="214" y="10" fontSize="11" fill={PAPER}>
							reject → next stage, then manual
						</text>
					</g>
				</svg>
			</div>
		</Figure>
	);
}

function MetaArtefact({ t }: { t: number }) {
	const chips = ["GPS lat lon alt", "heading", "gravity 0x0008", "35 mm focal"];
	return (
		<g>
			{chips.map((c, i) => (
				<g key={c} transform={`translate(0 ${i * 17})`}>
					<rect
						width="100"
						height="14"
						rx="7"
						fill="var(--accent)"
						fillOpacity={0.12 + 0.1 * Math.max(0, Math.sin(t * 2 - i))}
						stroke="var(--accent)"
						strokeOpacity=".4"
					/>
					<text x="8" y="10" fontSize="8.5" fill={PAPER} fontFamily="monospace">
						{c}
					</text>
				</g>
			))}
			<path
				d="M10 90 L90 90 M90 90 l-6 -4 M90 90 l-6 4"
				stroke="var(--accent)"
				fill="none"
			/>
			<text x="0" y="84" fontSize="8" fill="white" fillOpacity=".45">
				pinhole prior
			</text>
		</g>
	);
}

function HorizonArtefact({
	ridge,
	t,
}: {
	ridge: [number, number][];
	t: number;
}) {
	const sweep = (t * 22) % 100;
	return (
		<g>
			<path d={`${path(ridge, 0, 0)} L100 90 L0 90 Z`} fill="#222a30" />
			<path
				d={path(ridge)}
				fill="none"
				stroke="var(--accent)"
				strokeWidth="1.6"
			/>
			<line
				x1={sweep}
				y1="0"
				x2={sweep}
				y2="90"
				stroke="var(--accent)"
				strokeOpacity=".5"
				strokeDasharray="2 3"
			/>
			<text x="0" y="100" fontSize="8" fill="white" fillOpacity=".45">
				7,200 azimuths
			</text>
		</g>
	);
}

function SkylineArtefact({ ridge }: { ridge: [number, number][] }) {
	return (
		<g>
			<rect width="100" height="90" fill="#1d2a37" />
			<path d={`${path(ridge, 0, 4)} L100 90 L0 90 Z`} fill="#3a4147" />
			{ridge
				.filter((_, i) => i % 2 === 0)
				.map(([x, y]) => (
					<line
						key={x}
						x1={x}
						y1={y + 4}
						x2={x}
						y2={y + 12}
						stroke={PAPER}
						strokeOpacity=".5"
					/>
				))}
			<path
				d={path(ridge, 0, 4)}
				fill="none"
				stroke={PAPER}
				strokeWidth="1.2"
			/>
			<text x="0" y="100" fontSize="8" fill="white" fillOpacity=".45">
				one row per column
			</text>
		</g>
	);
}

function GridArtefact({ t, u }: { t: number; u: number }) {
	// a yaw x pitch cost grid; a bright basin appears and the LM marker walks to its floor
	const cols = 10;
	const rows = 6;
	const bx = 6.2;
	const by = 2.4;
	const k = ease(clamp01((u - 0.3) / 0.28));
	return (
		<g>
			{Array.from({ length: cols * rows }, (_, n) => {
				const c = n % cols;
				const r = Math.floor(n / cols);
				const d = Math.hypot((c - bx) / 2.2, (r - by) / 1.3);
				const v =
					Math.exp(-d * d) * 0.9 +
					0.1 * (0.5 + 0.5 * Math.sin(c * 1.7 + r * 2.3));
				return (
					<rect
						key={`cell-${c}-${r}`}
						x={c * 10}
						y={r * 12}
						width="9"
						height="11"
						fill="var(--accent)"
						fillOpacity={0.08 + 0.7 * v}
					/>
				);
			})}
			<circle
				cx={(2 + (bx - 2) * k) * 10 + 4.5}
				cy={(4 + (by - 4) * k) * 12 + 5}
				r="3.2"
				fill="none"
				stroke={PAPER}
			/>
			<text x="0" y="86" fontSize="8" fill="white" fillOpacity=".45">
				±25° yaw · ±3° pitch
			</text>
			<text
				x="0"
				y="97"
				fontSize="8"
				fill="white"
				fillOpacity={0.3 + 0.2 * Math.sin(t)}
			>
				≤ 3 seeds → LM
			</text>
		</g>
	);
}

function GateArtefact({
	conf,
	ok,
	reject,
	showing,
}: {
	conf: number;
	ok: boolean;
	reject: boolean;
	showing: boolean;
}) {
	const col = !showing ? "var(--accent)" : ok ? "#78c28a" : "#d96a5b";
	return (
		<g>
			<rect
				y="14"
				width="100"
				height="10"
				rx="5"
				fill="white"
				fillOpacity=".08"
			/>
			<rect
				y="14"
				width={100 * clamp01(showing ? conf : 0.05)}
				height="10"
				rx="5"
				fill={col}
			/>
			<line x1="50" x2="50" y1="8" y2="30" stroke={PAPER} strokeOpacity=".7" />
			<text
				x="50"
				y="5"
				textAnchor="middle"
				fontSize="8"
				fill={PAPER}
				fontFamily="monospace"
			>
				0.5
			</text>
			<text x="0" y="52" fontSize="10" fill={col} fontFamily="monospace">
				{!showing
					? "confidence?"
					: ok
						? "ACCEPT"
						: reject
							? "REJECT → refine"
							: "…"}
			</text>
			<text x="0" y="66" fontSize="8" fill="white" fillOpacity=".45">
				{showing ? `confidence ${conf.toFixed(2)}` : " "}
			</text>
			<text x="0" y="86" fontSize="8" fill="white" fillOpacity=".45">
				tilt &gt; 3° vs gravity
			</text>
			<text x="0" y="97" fontSize="8" fill="white" fillOpacity=".45">
				is also a reject
			</text>
		</g>
	);
}

// ======================================================================================
// Fig. 2: the cascade as a flow of the 12 benchmark photos
// ======================================================================================
// src/lib/geo/README.md, "classic + solve" 8/12; "classic + cascade" 11/12; refine rescues 7063, 7068, 7155.
const PHOTOS = [
	...Array.from({ length: 8 }, () => "solve" as const),
	"refine",
	"refine",
	"refine",
	"none",
] as const;
const PHOTO_ROWS = PHOTOS.map((dest, i) => ({ dest, id: `photo-${i}` }));
function CascadeFlow() {
	const [ref, t] = useTime<HTMLDivElement>();
	const W = 640;
	return (
		<Figure
			label="Fig. 2"
			caption="Schematic routing of the 12 hand-registered photos through the cascade (src/lib/geo/README.md, 2026-09-24; the per-photo rows of the latest eval are in Fig. C). Eight are accepted by solvePose alone in 0.02 to 0.15 s each on the demo photos. Refine runs only on the rejects and rescues three, all within 0.4°. One ultra-wide shot of a near ridge, with the eye itself off, is left to manual taps. Zero false accepts."
		>
			<div ref={ref}>
				<svg
					viewBox={`0 0 ${W} 250`}
					className="block h-auto w-full"
					role="img"
					aria-label="Twelve photos flowing through solvePose, then refinePose, then manual"
				>
					{/* stage boxes */}
					<Box
						x={10}
						y={95}
						w={120}
						label="12 photos"
						sub="prior + horizon + skyline"
					/>
					<Box x={200} y={95} w={130} label="solvePose" sub="8 accepted" hot />
					<Box x={390} y={95} w={110} label="refinePose" sub="+3 rescued" hot />
					<Box x={555} y={95} w={78} label="manual" sub="1 left" />
					{/* rails */}
					<Rail d="M130 120 H200" />
					<Rail d="M330 120 H390" />
					<Rail d="M500 120 H555" />
					<Rail d="M265 145 V200 H600 V0" ghost />
					<Rail d="M445 145 V200" ghost />
					{/* outcome tray */}
					<rect
						x="200"
						y="196"
						width="400"
						height="34"
						rx="8"
						fill="#78c28a"
						fillOpacity=".1"
						stroke="#78c28a"
						strokeOpacity=".5"
					/>
					<text
						x="214"
						y="217"
						fontSize="12"
						fill="#78c28a"
						fontFamily="monospace"
					>
						accepted 11 / 12 · false accepts 0 · worst yaw 0.47°
					</text>
					{PHOTO_ROWS.map(({ dest, id }, i) => {
						const T = 14; // seconds per loop
						const k = (t / T + i * 0.04) % 1;
						// all dots: 0..0.2 travel to solvePose, then branch
						let x = 70;
						let y = 120;
						if (k < 0.25) x = 70 + (k / 0.25) * 195;
						else {
							x = 265;
							if (dest === "solve") {
								const q = clamp01((k - 0.25) / 0.25);
								y = 120 + q * 90;
								x = 265 + q * (30 + i * 28);
							} else {
								const q = clamp01((k - 0.25) / 0.2);
								x = 265 + q * 180;
								if (dest === "refine") {
									const r = clamp01((k - 0.5) / 0.25);
									y = 120 + r * 90;
									x += (i - 8) * 24;
								} else {
									const r = clamp01((k - 0.5) / 0.25);
									x = 445 + r * 150;
								}
							}
						}
						const col =
							dest === "none"
								? "#d96a5b"
								: dest === "refine"
									? "var(--accent)"
									: "#78c28a";
						return (
							<circle
								key={id}
								cx={x}
								cy={y}
								r="5"
								fill={col}
								fillOpacity=".9"
							/>
						);
					})}
				</svg>
			</div>
		</Figure>
	);
}
function Box({
	x,
	y,
	w,
	label,
	sub,
	hot,
}: {
	x: number;
	y: number;
	w: number;
	label: string;
	sub: string;
	hot?: boolean;
}) {
	return (
		<g>
			<rect
				x={x}
				y={y}
				width={w}
				height="50"
				rx="9"
				fill="#12161a"
				stroke={hot ? "var(--accent)" : "white"}
				strokeOpacity={hot ? 0.7 : 0.16}
			/>
			<text
				x={x + w / 2}
				y={y + 22}
				textAnchor="middle"
				fontSize="12.5"
				fill={PAPER}
				fontFamily="monospace"
			>
				{label}
			</text>
			<text
				x={x + w / 2}
				y={y + 39}
				textAnchor="middle"
				fontSize="10"
				fill="white"
				fillOpacity=".5"
			>
				{sub}
			</text>
		</g>
	);
}
function Rail({ d, ghost }: { d: string; ghost?: boolean }) {
	return (
		<path
			d={d}
			fill="none"
			stroke="white"
			strokeOpacity={ghost ? 0.06 : 0.2}
			strokeWidth="2"
		/>
	);
}

// ======================================================================================
// Fig. 3: why this is the default, from the README variants table
// ======================================================================================
const VARIANTS = [
	{ name: "sensor prior only", acc: 0, ok10: 2, med: "4.0° / 45 px" },
	{ name: "solve alone", acc: 8, ok10: 9, med: "0.27° / 6.7 px" },
	{ name: "refine alone", acc: 9, ok10: 9, med: "0.22° / 7.0 px" },
	{
		name: "solve → refine (cascade)",
		acc: 11,
		ok10: 11,
		med: "0.22° / 5.0 px",
		hot: true,
	},
];
function Variants() {
	return (
		<Figure
			label="Fig. 3"
			caption="Same 12 photos, same classic skyline (src/lib/geo/README.md). The bar is photos accepted; the tick is photos whose skyline lands within 10 px. Every variant shown has zero false accepts. Differences below about 0.3° in median yaw are inside ground-truth noise."
		>
			<div className="space-y-3">
				{VARIANTS.map((v) => (
					<div key={v.name}>
						<div className="flex justify-between font-mono text-[11px] text-white/55">
							<span className={v.hot ? "text-[var(--rigi-paper)]" : ""}>
								{v.name}
							</span>
							<span>{v.med}</span>
						</div>
						<div className="relative mt-1 h-3 rounded-full bg-white/[.07]">
							<div
								className="absolute inset-y-0 left-0 rounded-full"
								style={{
									width: `${(v.acc / 12) * 100}%`,
									background: v.hot ? "var(--accent)" : "rgba(255,255,255,.28)",
								}}
							/>
							<div
								className="absolute -top-1 h-5 w-[2px] bg-[var(--rigi-paper)]"
								style={{ left: `${(v.ok10 / 12) * 100}%` }}
							/>
						</div>
						<div className="mt-0.5 flex justify-between font-mono text-[10px] text-white/35">
							<span>{v.acc}/12 accepted</span>
							<span>{v.ok10}/12 ≤ 10 px</span>
						</div>
					</div>
				))}
			</div>
		</Figure>
	);
}

// ======================================================================================
// Measured figures
// ======================================================================================
const CYAN = "#5ee0f4";
const YELLOW = "#f4d35e";
const MAGENTA = "#ff5fa2";
const fmtMs = (v: number) =>
	v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;

function band(d: AtlasPhotoData): [number, number, number, number] {
	const { width: W, height: H } = d.photo;
	const ys = d.skyline.rows
		.filter((v): v is number => v != null)
		.sort((a, b) => a - b);
	if (!ys.length) return [0, 0, W, H];
	const lo = ys[Math.floor(ys.length * 0.02)];
	const hi = ys[Math.floor(ys.length * 0.98)];
	const bh = Math.min(H, Math.max(300, hi - lo + 150));
	const y0 = Math.max(0, Math.min(H - bh, lo - 100));
	return [0, Math.round(y0), W, Math.round(y0 + bh)];
}

function Panel({
	n,
	title,
	fn,
	children,
	foot,
}: {
	n: number;
	title: string;
	fn: string;
	children: React.ReactNode;
	foot: React.ReactNode;
}) {
	return (
		<div className="min-w-0">
			<div className="mb-1.5 flex items-baseline gap-2">
				<span className="font-mono text-[11px] text-[var(--accent)]">{n}</span>
				<span className="text-[13px] text-white/85">{title}</span>
				<span className="ml-auto font-mono text-[10.5px] text-white/45">
					{fn}
				</span>
			</div>
			{children}
			<div className="mt-1.5 font-mono text-[10.5px] leading-snug text-white/55">
				{foot}
			</div>
		</div>
	);
}

function Num({ children }: { children: React.ReactNode }) {
	return <span className="text-white/90">{children}</span>;
}

const STAGE_COLOURS = ["#9aa0a6", "#7aa7ff", YELLOW, CYAN] as const;
function TimeBar({ d }: { d: AtlasPhotoData }) {
	const parts = [
		{ k: "terrain tiles", v: d.ms.terrain, c: STAGE_COLOURS[0] },
		{ k: "horizon", v: d.ms.horizon, c: STAGE_COLOURS[1] },
		{ k: "skyline", v: d.ms.skyline, c: STAGE_COLOURS[2] },
		{
			k: d.solved.stage === "refine" ? "solve + refine" : "solve",
			v: d.ms.solve,
			c: STAGE_COLOURS[3],
		},
	];
	const total = parts.reduce((a, p) => a + p.v, 0);
	return (
		<div className="mt-4">
			<div className="flex h-3 overflow-hidden rounded-full bg-white/[.06]">
				{parts.map((p) => (
					<div
						key={p.k}
						style={{
							width: `${(p.v / total) * 100}%`,
							background: p.c,
							minWidth: p.v > 0 ? 2 : 0,
						}}
						title={`${p.k} ${fmtMs(p.v)}`}
					/>
				))}
			</div>
			<div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10.5px] text-white/55">
				{parts.map((p) => (
					<span key={p.k}>
						<span style={{ color: p.c }}>●</span> {p.k} <Num>{fmtMs(p.v)}</Num>
					</span>
				))}
				<span className="ml-auto">
					total <Num>{fmtMs(total)}</Num>
				</span>
			</div>
		</div>
	);
}

function MeasuredOnePhoto({
	id,
	setId,
	d,
	idx,
}: {
	id: AtlasPhotoId;
	setId: (i: AtlasPhotoId) => void;
	d: AtlasPhotoData | null;
	idx: AtlasIndex | null;
}) {
	const crop = useMemo(() => (d ? band(d) : undefined), [d]);
	const valid = d ? d.skyline.rows.filter((v) => v != null).length : 0;
	return (
		<Figure
			label="Fig. A"
			bleed
			caption={
				<>
					The same four stages, with the real artefacts. 1: the camera the
					sensors alone imply, and the DEM skyline it predicts. 2: what
					detectSkyline finds. 3: the pose solvePose settles on and the skyline
					it predicts. 4: the peaks labelled at that pose. Pick another photo;
					rejected ones show what a failure looks like. <Measured data={d} />
				</>
			}
		>
			<PhotoPicker
				value={id}
				onChange={setId}
				mark={(i) => {
					const p = idx?.photos.find((q) => q.id === i);
					return p ? (
						<span
							className={`rounded bg-black/60 px-1 font-mono text-[8px] ${p.accepted ? "text-[#5ee0f4]" : "text-[#ff8f86]"}`}
						>
							{p.accepted ? p.stage : "reject"}
						</span>
					) : null;
				}}
			/>
			<div className="grid gap-5 sm:grid-cols-2">
				<Panel
					n={1}
					title="Sensors → prior"
					fn="cameraFromMeta"
					foot={
						d && (
							<>
								compass <Num>{d.sensor.heading.toFixed(0)}°</Num>, pitch{" "}
								<Num>{d.sensor.pitch.toFixed(1)}°</Num>, 35 mm{" "}
								<Num>{d.sensor.f35}</Num>. Median skyline error{" "}
								<Num>{d.residual.prior.median.toFixed(1)} px</Num>.
							</>
						)
					}
				>
					<RealPhoto data={d} layers={["skyline", "prior"]} crop={crop} />
				</Panel>
				<Panel
					n={2}
					title="Skyline in the pixels"
					fn="detectSkyline"
					foot={
						d && (
							<>
								<Num>{valid}</Num> of {d.skyline.rows.length} columns vote, in{" "}
								<Num>{fmtMs(d.ms.skyline)}</Num>.
							</>
						)
					}
				>
					<RealPhoto data={d} layers={["skyline", "weight"]} crop={crop} />
				</Panel>
				<Panel
					n={3}
					title="Slide one onto the other"
					fn="solvePose"
					foot={
						d && (
							<>
								{d.solved.accepted ? "accepted" : "rejected"} by{" "}
								<Num>
									{d.solved.accepted ? d.solved.stage : "solve and refine"}
								</Num>
								, confidence <Num>{d.solved.confidence.toFixed(2)}</Num>.
								Compass was off by <Num>{d.solved.delta.yaw.toFixed(1)}°</Num>,
								median error <Num>{d.residual.prior.median.toFixed(1)}</Num> →{" "}
								<Num>{d.residual.solved.median.toFixed(1)} px</Num>
								{d.solved.rejectReason ? <> ({d.solved.rejectReason})</> : null}
								.
							</>
						)
					}
				>
					<RealPhoto data={d} layers={["skyline", "solved"]} crop={crop} />
				</Panel>
				<Panel
					n={4}
					title="Label what is there"
					fn="viewPeaks · layoutPeakLabels"
					foot={
						d && (
							<>
								<Num>{d.peaks.filter((p) => p.visible).length}</Num> visible
								peaks, <Num>{d.peaks.filter((p) => p.labelled).length}</Num>{" "}
								labelled
								{d.solved.accepted
									? ""
									: " (at the unconfirmed pose, so do not trust them)"}
								.
							</>
						)
					}
				>
					<RealPhoto data={d} layers={["peaks"]} crop={crop} maxLabels={6} />
				</Panel>
			</div>
			{d && <TimeBar d={d} />}
		</Figure>
	);
}

function AllTwelve({
	idx,
	id,
	setId,
}: {
	idx: AtlasIndex | null;
	id: AtlasPhotoId;
	setId: (i: AtlasPhotoId) => void;
}) {
	if (!idx) return null;
	const maxRes = Math.max(...idx.photos.map((p) => p.residual.prior.median));
	const nAcc = idx.photos.filter((p) => p.accepted).length;
	const nRefine = idx.photos.filter(
		(p) => p.stage === "refine" && p.accepted,
	).length;
	return (
		<Figure
			label="Fig. B"
			bleed
			caption={
				<>
					All 12 demo photos through the same code. Bars: median skyline error
					in pixels before (magenta) and after (cyan) the solve. {nAcc} of 12
					are accepted, {nAcc - nRefine} by solvePose and {nRefine} only by
					refinePose; the rest are rejected rather than guessed. Click a row to
					load it in Fig. A. <Measured data={idx} />
				</>
			}
		>
			<div className="overflow-x-auto">
				<table className="w-full min-w-[480px] border-separate border-spacing-y-1 font-mono text-[11px]">
					<thead>
						<tr className="text-left text-[10px] text-white/40">
							<th className="font-normal" />
							<th className="font-normal">verdict</th>
							<th className="text-right font-normal">compass err</th>
							<th className="pl-3 font-normal">median error, px</th>
							<th className="text-right font-normal">total</th>
						</tr>
					</thead>
					<tbody>
						{idx.photos.map((p) => {
							const tot =
								p.ms.terrain + p.ms.horizon + p.ms.skyline + p.ms.solve;
							return (
								<tr
									key={p.id}
									onClick={() => setId(p.id)}
									className={`cursor-pointer text-white/65 ${p.id === id ? "bg-white/[.07]" : "hover:bg-white/[.04]"}`}
								>
									<td className="py-0.5 pr-2">
										<img
											src={p.thumb}
											alt={p.id}
											className="h-7 w-9 rounded object-cover"
										/>
									</td>
									<td
										className={p.accepted ? "text-[#5ee0f4]" : "text-[#ff8f86]"}
									>
										{p.accepted ? p.stage : "rejected"}{" "}
										<span className="text-white/45">
											{p.confidence.toFixed(2)}
										</span>
									</td>
									<td className="text-right text-white/80">
										{p.delta.yaw > 0 ? "+" : "−"}
										{Math.abs(p.delta.yaw).toFixed(1)}°
									</td>
									<td className="pl-3">
										<div className="flex items-center gap-1.5">
											<div className="w-28 shrink-0 space-y-[3px]">
												<div
													className="h-1.5 rounded-full"
													style={{
														width: `${(p.residual.prior.median / maxRes) * 100}%`,
														background: MAGENTA,
													}}
												/>
												<div
													className="h-1.5 rounded-full"
													style={{
														width: `${(p.residual.solved.median / maxRes) * 100}%`,
														background: CYAN,
													}}
												/>
											</div>
											<span className="text-[10px] text-white/50">
												{p.residual.prior.median.toFixed(0)} →{" "}
												{p.residual.solved.median.toFixed(1)}
											</span>
										</div>
									</td>
									<td className="text-right">{fmtMs(tot)}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</Figure>
	);
}

type EvalRow = {
	name: string;
	gtQuality: string;
	accepted: boolean;
	rejectReason?: string;
	confidence: number;
};
function GroundTruthEval({ idx }: { idx: AtlasIndex | null }) {
	const g = idx?.groundTruthEval;
	if (!idx || !g?.solve || !g.cascade) return null;
	const solve = g.solve as EvalRow[];
	const casc = g.cascade as EvalRow[];
	const a = solve.filter((r) => r.accepted).length;
	const b = casc.filter((r) => r.accepted).length;
	const rescued = casc
		.filter((r, i) => r.accepted && !solve[i].accepted)
		.map((r) => r.name.replace("IMG_", ""));
	return (
		<Figure
			label="Fig. C"
			caption={
				<>
					The hand-registered benchmark (data/ground-truth.json) as the latest
					eval runs left it (out/eval and out/eval-classic-cascade, copied by
					scripts/atlas/build-data.ts): {solve.length} photos, solvePose alone
					accepts {a}, the cascade {b}. Refine rescues {rescued.join(", ")}.
					Each cell is one photo; the left half is solvePose alone, the right
					half the cascade, filled when accepted. These per-photo rows carry the
					verdict and the correction from the prior but not the ground-truth
					error; that is in the table below.
				</>
			}
		>
			<div className="flex flex-wrap gap-2">
				{solve.map((r, i) => {
					const c = casc[i];
					return (
						<div
							key={r.name}
							className="rounded-md bg-white/[.05] px-2 py-1.5 font-mono text-[10px] text-white/60"
						>
							<div className="flex items-center gap-1.5">
								<span className="flex overflow-hidden rounded-sm ring-1 ring-white/25">
									<span
										className="h-3 w-2.5"
										style={{ background: r.accepted ? CYAN : "transparent" }}
									/>
									<span
										className="h-3 w-2.5 border-l border-white/25"
										style={{ background: c.accepted ? CYAN : "transparent" }}
									/>
								</span>
								{r.name.replace("IMG_", "")}
							</div>
							<div className="mt-0.5 text-white/35">gt {r.gtQuality}</div>
						</div>
					);
				})}
			</div>
		</Figure>
	);
}

function Deep() {
	const [id, setId] = useState<AtlasPhotoId>("demo-03");
	const d = useAtlasPhoto(id);
	const idx = useAtlasIndex();
	return (
		<>
			<Section kicker="Mechanism" title="One photo, five stages, one verdict">
				<p>
					Everything on this page runs in the browser with no network model:
					read the phone&rsquo;s sensors, draw the 360° skyline the DEM predicts
					from the GPS fix, find the skyline in the pixels, and slide one onto
					the other. Each stage hands the next a plain typed artefact, and the
					last one is a gate that is allowed to say <em>don&rsquo;t know</em>.
					How the match itself is scored is on{" "}
					{A("viewport-inference", "Viewport Inference")}; this page is the
					plumbing around it and the order things happen in.
				</p>
			</Section>
			<MeasuredOnePhoto id={id} setId={setId} d={d} idx={idx} />

			<Conveyor />

			<Section kicker="How it works" title="Stage by stage">
				<Steps
					steps={[
						{
							title: "readPhotoMeta → cameraFromMeta",
							body: (
								<>
									exifr gives GPS, heading, 35 mm focal and orientation, and a
									small parser reads Apple&rsquo;s MakerNote tag{" "}
									<code>0x0008</code>, the gravity vector (three SRATIONALs).
									Gravity gives pitch and roll, the compass gives yaw, the 35 mm
									focal gives pixels. A cropped photo keeps its sensor size, so
									focal is crop-aware. The result is a pinhole{" "}
									<code>Camera</code>, the {A("camera-prior", "prior")}. It
									throws if gravity, heading or focal are missing, and those
									photos take the unknown-pose route instead.
								</>
							),
						},
						{
							title: "loadScene",
							body: (
								<>
									<code>loadTerrain</code> builds a multi-zoom DEM sampler
									around the GPS fix ({A("dem-source", "DEM source")},{" "}
									{A("terrain-sampler", "terrain sampler")}). The eye is{" "}
									<code>max(GPS altitude, ground + 1.6 m)</code>, so a bad
									altitude can never bury the camera in the hill.
								</>
							),
						},
						{
							title: "sceneHorizon",
							body: (
								<>
									The {A("dem-horizon", "DEM horizon")}: for each of 7,200
									azimuths, the highest elevation angle the terrain reaches,
									with curvature and refraction. The fast marcher answers in
									about 0.3 s in a browser (src/lib/geo/README.md); the classic
									ray-march took 3.9 to 8.1 s per photo on CPU in the measured
									runs (Fig. B), and is the automatic fallback.
								</>
							),
						},
						{
							title: "detectSkyline",
							body: (
								<>
									The {A("skyline", "skyline")} in the photo: a sky colour
									model, then a Viterbi boundary per pixel column, each with a
									weight. 116 to 464 ms at 800 px in the measured runs (median
									150 ms). Columns with no sky (a roof, a hand) carry no vote.
								</>
							),
						},
						{
							title: "solvePose",
							body: (
								<>
									GPS stays fixed; yaw, pitch, roll and focal are solved. A
									coarse grid over the compass window, then Cauchy-loss
									Levenberg-Marquardt from up to three seeds, then the gate. If
									the local search is rejected, <code>wantsFull</code> triggers
									a full-circle retry with a stricter bar, and{" "}
									<code>pickFull</code> keeps whichever is better. Details on{" "}
									{A("viewport-inference", "Viewport Inference")}.
								</>
							),
						},
						{
							title: "escalate",
							body: (
								<>
									<code>cascade()</code> returns the first accepting stage. If
									solvePose rejects, the same prior, horizon and skyline go to{" "}
									<code>refinePose</code>, an independent solver on a different
									principle. Both results ride along as <code>candidates</code>,
									so the caller can see what each stage believed. If neither
									accepts, solvePose&rsquo;s result is returned, because with no
									heading, refine&rsquo;s rejected pose can be 130 to 175° off.
								</>
							),
						},
					]}
				/>
			</Section>

			<AllTwelve idx={idx} id={id} setId={setId} />

			<CascadeFlow />

			<GroundTruthEval idx={idx} />

			<Section kicker="Why a cascade" title="Cheap first, different second">
				<p>
					solvePose is fast and sound whenever the compass is roughly right. In
					the measured runs a photo that needs refine costs 0.4 to 1.3 s in
					total (solve and refine); it does not share its failure modes, so it
					only runs where solvePose gave up. The pair accepts more photos than
					either alone and the combined rule still never accepted a wrong pose
					on the benchmark.
				</p>
			</Section>
			<Variants />

			<div className="!mt-8 grid grid-cols-2 gap-5 sm:grid-cols-4">
				<Stat value="11 / 12" label="photos accepted by the cascade" />
				<Stat value="0.22°" label="median yaw error (4.0° prior)" />
				<Stat value="5.0 px" label="median skyline error (45 px prior)" />
				<Stat value="0" label="false accepts" />
			</div>
			<p className="!mt-3 text-[13px] text-white/45">
				src/lib/geo/README.md, 12 hand-registered photos, 2026-09-24. Wild set
				(100 Commons photos, Mapterhorn, blind-verified): at the 0.75 bar the
				cascade makes 22 accepts, all correct.
			</p>

			<Callout tone="lesson" title="Policy lives with the caller">
				<code>pipeline.ts</code> is shared by the <code>/baseline</code> and
				unknown-pose workers. It owns the order of operations. The DEM, tile
				loader, timeouts and solver options stay with whoever calls it, and the
				GPU coarse grid plugs in through <code>cascadeAsync</code> without
				changing a single decision.
			</Callout>

			<Section kicker="In the code" title="Where to look">
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/geo/pipeline.ts" />
					<CodeRef path="src/lib/geo/solve.ts" />
					<CodeRef path="src/lib/geo/photo-meta.ts" />
					<CodeRef path="src/lib/geo/camera.ts" />
					<CodeRef path="src/lib/geo/horizon.ts" />
					<CodeRef path="src/lib/geo/skyline.ts" />
					<CodeRef path="src/lib/geo/README.md" />
				</div>
				<p className="!mt-3 font-mono text-[12.5px] text-white/55">
					loadScene, sceneHorizon, cascade, cascadeAsync, escalate,
					readPhotoMeta, parseAppleGravity, cameraFromMeta, solvePose,
					wantsFull, pickFull
				</p>
			</Section>

			<Section kicker="Where it fits" title="Around the baseline">
				<p>
					The match score is explained on{" "}
					{A("viewport-inference", "Viewport Inference")}, and the ground the
					horizon is cast from is snapped on{" "}
					{A("terrain-snapping", "Terrain Snapping")}. A rejection ends at{" "}
					{A("tap-a-peak", "Tap-a-Peak")}, and the result is judged by the{" "}
					{A("accept-rule", "accept rule")}.
				</p>
			</Section>
		</>
	);
}

// ======================================================================================
// Explainer front: one photo walked through the stages with the real timings of this run.
// ======================================================================================
function HeroStages() {
	const d = useAtlasPhoto("demo-03");
	const crop = useMemo(() => (d ? band(d) : undefined), [d]);
	const t = (v?: number) => (v == null ? "" : fmtMs(v));
	return (
		<Figure
			label="Fig. 1"
			bleed
			caption={
				<>
					{d
						? `One photo, four steps, ${fmtMs(d.ms.terrain + d.ms.horizon + d.ms.skyline + d.ms.solve)} in total. The map step is most of it.`
						: "One photo, four steps."}{" "}
					<Measured data={d} />
				</>
			}
		>
			<Stages
				interval={3600}
				stages={[
					{
						label: "Photo",
						caption: "We start with the photo and what the phone recorded.",
						render: () => <RealPhoto data={d} layers={[]} crop={crop} />,
					},
					{
						label: "Skyline from the map",
						caption: `From the GPS fix we predict the skyline the terrain should make. This takes ${t(d?.ms.horizon)}.`,
						render: () => <RealPhoto data={d} layers={["prior"]} crop={crop} />,
					},
					{
						label: "Skyline in the pixels",
						caption: `We find the skyline in the photo itself. This takes ${t(d?.ms.skyline)}.`,
						render: () => (
							<RealPhoto data={d} layers={["prior", "skyline"]} crop={crop} />
						),
					},
					{
						label: "Slide to match",
						caption: `We turn the camera until the two lines overlap, then check how sure we are. ${t(d?.ms.solve)}.`,
						render: () => (
							<RealPhoto data={d} layers={["skyline", "solved"]} crop={crop} />
						),
					},
					{
						label: "Label",
						caption:
							"Once the pose is trusted, we name the peaks that line up.",
						render: () => (
							<RealPhoto
								data={d}
								layers={["peaks"]}
								crop={crop}
								maxLabels={6}
							/>
						),
					},
				]}
			/>
			{d && <TimeBar d={d} />}
		</Figure>
	);
}

/** Sky and ridge only, so foreground people stay out of the small tiles. */
function ridgeCrop(d: AtlasPhotoData): [number, number, number, number] {
	const ys = d.skyline.rows
		.filter((v): v is number => v != null)
		.sort((a, b) => a - b);
	const lo = ys[Math.floor(ys.length * 0.02)] ?? 0;
	const med = ys[ys.length >> 1] ?? d.photo.height / 2;
	const y0 = Math.max(0, Math.round(lo - 70));
	const y1 = Math.min(d.photo.height, Math.max(Math.round(med + 40), y0 + 200));
	return [0, y0, d.photo.width, y1];
}

function OutcomeMini({
	id,
	layers,
}: {
	id: AtlasPhotoId;
	layers: ("skyline" | "solved" | "prior")[];
}) {
	const d = useAtlasPhoto(id);
	return (
		<RealPhoto
			data={d}
			layers={layers}
			crop={
				d
					? ((c) =>
							[
								0,
								c[1],
								id === "demo-07" ? 480 : c[2],
								c[1] + (c[3] - c[1]) * (id === "demo-07" ? 480 / c[2] : 1),
							] as [number, number, number, number])(ridgeCrop(d))
					: undefined
			}
		/>
	);
}

function PipelineNumbers() {
	const idx = useAtlasIndex();
	if (!idx) return null;
	const med = (a: number[]) => {
		const s = [...a].sort((x, y) => x - y);
		return (s[5] + s[6]) / 2;
	};
	const acc = idx.photos.filter((p) => p.accepted);
	const first = acc.filter((p) => p.stage === "solve").length;
	return (
		<Numbers
			items={[
				{
					value: `${acc.length} / 12`,
					label: "demo photos accepted, the rest rejected not guessed",
				},
				{ value: `${first} / 12`, label: "accepted by the first solver alone" },
				{
					value: fmtMs(med(idx.photos.map((p) => p.ms.horizon))),
					label: "median map step per photo, on CPU",
				},
				{ value: "0", label: "false accepts on 12 hand-registered photos" },
			]}
			source="Measured on the 12 demo photos, scripts/atlas/build-data.ts, 2026-10-01. False accepts: src/lib/geo/README.md (2026-09-24)."
		/>
	);
}

export default function Page({ node }: { node: AtlasNode }) {
	void node;
	return (
		<>
			<HeroStages />

			<Beat
				kicker="The idea"
				title="Predict the skyline, find it, slide one onto the other."
			>
				<p>
					Everything runs in the browser, with no network model. The last step
					is a gate that is allowed to say <em>I don&rsquo;t know</em>.
				</p>
			</Beat>

			<Beat
				kicker="How it works"
				title="Every photo ends in one of three outcomes."
			>
				<Trio
					steps={[
						{
							title: "Accept",
							body: "Lines overlap and we are sure. Demo-03 reaches 0.87 confidence.",
							visual: (
								<OutcomeMini id="demo-03" layers={["skyline", "solved"]} />
							),
						},
						{
							title: "Try a second solver",
							body: "A different method rescues demo-12, which the first one rejected.",
							visual: (
								<OutcomeMini id="demo-12" layers={["skyline", "solved"]} />
							),
						},
						{
							title: "Reject and ask",
							body: "Demo-07 stays unsure, so we hand over to a manual tap.",
							visual: (
								<OutcomeMini id="demo-07" layers={["skyline", "solved"]} />
							),
						},
					]}
				/>
			</Beat>

			<Beat
				kicker="Where it fails"
				title="When the skyline is wrong, we reject instead of guess."
			>
				<p>
					A head or a hand on the ridge looks like a real edge. Confidence stays
					low, so the photo is rejected.
				</p>
			</Beat>

			<Figure
				label="Fig. 2"
				caption="Same head on the ridge, two verdicts. Demo-11 is rejected; demo-12 is rescued by the second solver."
			>
				<Gallery
					ids={["demo-11", "demo-12"]}
					cols={2}
					tile={(d) => (
						<RealPhoto
							data={d}
							layers={["skyline", "solved"]}
							crop={skylineBand(d, 280)}
						/>
					)}
					label={(d) =>
						d.solved.accepted ? (
							<>
								accepted by {d.solved.stage}, confidence{" "}
								{d.solved.confidence.toFixed(2)}
							</>
						) : (
							<>
								rejected, confidence {d.solved.confidence.toFixed(2)} (
								{d.solved.rejectReason})
							</>
						)
					}
				/>
			</Figure>

			<PipelineNumbers />

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next: the {A("accept-rule", "accept rule")} decides when a pose is
				trusted. After a rejection comes {A("tap-a-peak", "tap-a-peak")}.
			</p>

			<Details>
				<Deep />
			</Details>
		</>
	);
}
