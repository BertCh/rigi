// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { memo, useEffect, useMemo, useState } from "react";
import {
	Hachure,
	HandDot,
	HandText,
	inkColor,
	PenArrow,
	PenCircle,
	PenLine,
	SketchPath,
} from "#/components/gipfelbuch/notebook/Ink";
import { useNotebookPhoto } from "#/components/gipfelbuch/notebook/useNotebookPhoto";
import { SWISS } from "#/components/gipfelbuch/swiss/palette";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import {
	Callout,
	CodeRef,
	CrispLine,
	Eq,
	Figure,
	Frac,
	type GipfelbuchIndex,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	Measured,
	Op,
	PhotoPicker,
	PrintNote,
	RealPhoto,
	rowsPath,
	Section,
	Stat,
	Steps,
	Sym,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
	useTime,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Details,
	Gallery,
	Numbers,
	Stages,
	skylineBand,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { gipfelbuchHref } from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// Baseline pipeline: the CPU path end to end.
// Facts are from src/lib/geo/pipeline.ts (loadScene, sceneHorizon, cascade / escalate, EYE_ABOVE_GROUND 1.6),
// src/lib/geo/solve.ts (solvePose, fullOnly, wantsFull, pickFull, DEFAULT_SIGMA, FULL_SEARCH_CONFIDENCE 0.75)
// and src/lib/geo/README.md (12 hand-registered photos, 2026-09-24; stage timings; accuracy table).
// The artefacts drawn inside the Fig. D2 panels are schematic, not data; the measured figures (D1, D3, D5) use the real
// pipeline on the 12 Niederhorn demo photos (public/demo/gipfelbuch, scripts/gipfelbuch/build-data.ts) and out/eval*/report.json.

const A = (id: string, label: string) => (
	<Link
		to={gipfelbuchHref(id)}
		className="underline decoration-[var(--gb-red)] underline-offset-2"
	>
		{label}
	</Link>
);

const PAPER = SWISS.ink;
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
// Fig. D2: the conveyor
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

const rectD = (x0: number, y0: number, x1: number, y1: number) =>
	`M${x0} ${y0}H${x1}V${y1}H${x0}Z`;

/** Pen-ruled station: a top rule, a left edge and a short foot rule instead of a box. */
const StationMarks = memo(function StationMarks({
	i,
	on,
}: {
	i: number;
	on: boolean;
}) {
	return (
		<g>
			<rect
				x={0}
				y={0}
				width={PW}
				height={140}
				style={{
					fill: on
						? "color-mix(in srgb, var(--gb-red) 14%, var(--gb-paper))"
						: "color-mix(in srgb, var(--gb-ink) 5%, var(--gb-paper))",
				}}
			/>
			<PenLine
				seed={`conv-top-${i}`}
				from={[0, 0]}
				to={[PW, 0]}
				width={on ? 2.2 : 1.2}
				color={on ? "ink" : "pencil"}
			/>
			<PenLine
				seed={`conv-left-${i}`}
				from={[0, 0]}
				to={[0, 140]}
				width={1.1}
				color="pencil"
			/>
			<PenLine
				seed={`conv-foot-${i}`}
				from={[0, 140]}
				to={[PW * 0.55, 140]}
				width={1.1}
				color="pencil"
			/>
		</g>
	);
});

const RAIL_Y = 196;
const RAIL_END = px(4) + PW - PW / 2;
const RAIL_GHOST = (
	<PenLine
		seed="conv-rail"
		from={[PW / 2, RAIL_Y]}
		to={[RAIL_END, RAIL_Y]}
		color="pencil"
		width={1.4}
	/>
);
const RAIL_ROUTE = (
	<PenLine
		seed="conv-route"
		from={[PW / 2, RAIL_Y]}
		to={[RAIL_END, RAIL_Y]}
		color="red"
		width={2.2}
	/>
);
const TOKEN = (
	<g>
		<PenCircle
			seed="conv-token-ring"
			center={[0, 0]}
			radiusX={10}
			color="pencil"
			width={1.2}
		/>
		<HandDot x={0} y={0} r={4.6} seed="conv-token" color="red" opacity={1} />
	</g>
);
const ESCALATION_LANE = (
	<SketchPath
		d={`M${PW + GAP + PW / 2} -26 V0 H${PW / 2 + 0} V12`}
		seed="conv-escalate"
		color="ink"
		dash="4 4"
		width={1.3}
		passes={1}
	/>
);

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
	const ridge = useMemo(() => RIDGE(40, 100, 60), []);
	const ridge2 = useMemo(() => RIDGE(40, 100, 60, 0.35), []);
	const tokenX = px(Math.min(stagePos, 4)) + PW / 2;
	const W = px(4) + PW;

	return (
		<Figure
			label="Fig. D2"
			bleed
			caption="Synthetic panels, exact order. One photo through the five CPU stages, as the code calls them (costs: median over the 12 demo photos, classic horizon, CPU; Fig. D1 has the real artefacts). The fork is exact: solvePose either accepts (run A) or the cascade hands the same prior, horizon and skyline to refinePose (run B). The loop alternates the two."
		>
			<div ref={ref} className="@container -m-1 sm:-m-2">
				{/* under 560 px of container width the five stages stack as a vertical list */}
				<ol className="m-0 list-none space-y-1 p-0 @[560px]:hidden">
					{STAGES.map((st, i) => (
						<li
							key={st.fn}
							className={`px-3 py-2 ${i === active && !done ? "bg-[color-mix(in_srgb,var(--gb-red)_14%,var(--gb-paper))]" : "bg-[var(--gb-paper-deep)]"}`}
						>
							<div className="flex flex-wrap items-baseline gap-x-3">
								<span
									className={`font-mono ${TYPE.caption} text-[var(--gb-red)]`}
								>
									{i + 1}
								</span>
								<span className={`font-mono ${TYPE.caption}`}>{st.fn}</span>
								<span className={`font-mono ${TYPE.micro} gb-secondary`}>
									{st.sub}
								</span>
								{st.cost && (
									<span
										className={`ml-auto font-mono ${TYPE.micro} text-[var(--gb-navy)]`}
									>
										{st.cost}
									</span>
								)}
							</div>
							<div className={`${TYPE.micro} gb-secondary`}>→ {st.out}</div>
						</li>
					))}
					<li
						className={`px-3 py-2 ${reject && atGate ? "bg-[color-mix(in_srgb,var(--gb-red)_14%,var(--gb-paper))]" : "bg-[var(--gb-paper-deep)]"}`}
					>
						<div className={`font-mono ${TYPE.caption}`}>
							refinePose
							<span className={`ml-3 ${TYPE.micro} gb-secondary`}>
								only if the gate rejects
							</span>
						</div>
						<div className={`${TYPE.micro} gb-secondary`}>
							FFT yaw ring · robust IRLS · 0.4–1.3 s measured
						</div>
					</li>
					<li className={`px-1 pt-2 ${TYPE.micro} gb-secondary`}>
						{reject
							? "run B · solvePose rejects, refinePose rescues. "
							: "run A · solvePose accepts. "}
						No stage ever returns a pose without a verdict. If both reject, the
						prior is shown as unverified and the user taps peaks.
					</li>
				</ol>
				<svg
					viewBox={`0 0 ${W} 412`}
					className="hidden h-auto w-full @[560px]:block"
					role="img"
					aria-label="Five pipeline stages with a photo token moving through them and a final accept or escalate gate"
				>
					<defs>
						<clipPath id="conv-progress">
							<rect x="0" y="170" width={tokenX} height="52" />
						</clipPath>
					</defs>
					<text x={0} y={16} fontSize={13} fill={SWISS.ink} className="gb-num">
						{reject
							? "run B · solvePose rejects, refinePose rescues"
							: "run A · solvePose accepts"}
					</text>
					{/* rail */}
					{RAIL_GHOST}
					<g clipPath="url(#conv-progress)">{RAIL_ROUTE}</g>
					{STAGES.map((s, i) => {
						const lit = i <= active && !done ? true : done;
						return (
							<g key={s.fn} transform={`translate(${px(i)} 30)`}>
								<StationMarks i={i} on={i === active && !done} />
								{/* artefact */}
								<g transform="translate(16 20)" opacity={lit ? 1 : 0.4}>
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
									x={10}
									y={138}
									fontSize={13}
									fill={SWISS.secondary}
									className="gb-num"
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
								fontSize="13"
								fill={PAPER}
								className="gb-num"
							>
								{s.fn}
							</text>
							<text
								x={PW / 2}
								y={242}
								textAnchor="middle"
								fontSize={13}
								fill={SWISS.secondary}
								className="gb-num"
							>
								{s.sub}
							</text>
							{s.cost && (
								<text
									x={PW / 2}
									y="257"
									textAnchor="middle"
									className="nb-num"
									fontSize="11"
									fill={inkColor("blue")}
								>
									{s.cost}
								</text>
							)}
						</g>
					))}
					{/* token */}
					<g transform={`translate(${tokenX} ${RAIL_Y})`}>{TOKEN}</g>
					{/* escalation lane */}
					<g
						transform={`translate(${px(3)} 280)`}
						opacity={reject && atGate ? 1 : 0.35}
					>
						{ESCALATION_LANE}
						<PenLine
							seed="conv-refine-top"
							from={[-10, 12]}
							to={[PW + GAP + PW - 90, 12]}
							width={reject && atGate ? 2 : 1.2}
							color={reject && atGate ? "ink" : "pencil"}
						/>
						<text x="2" y="31" fontSize="13" fill={PAPER} className="gb-num">
							refinePose
						</text>
						<text
							x={2}
							y={48}
							fontSize={13}
							fill={SWISS.secondary}
							className="gb-num"
						>
							FFT yaw ring · robust IRLS · 0.4–1.3 s measured
						</text>
						{refineT > 0.02 && (
							<PenLine
								seed="conv-refine-bar"
								from={[2, 58]}
								to={[2 + 150 * refineT, 58]}
								color="blue"
								width={3}
							/>
						)}
					</g>
					<text x="0" y="368" fontSize="11" fill={SWISS.secondary}>
						No stage ever returns a pose without a verdict. If both reject, the
						prior is shown as unverified and the user taps peaks.
					</text>
					{/* the two outcomes */}
					<g transform={`translate(0 386)`}>
						<HandDot x={6} y={6} r={4.5} seed="conv-key-win" color="forest" />
						<PrintNote x={18} y={11} size={13} color="var(--gb-ink)" halo={0}>
							first accepting stage wins
						</PrintNote>
						<HandDot x={290} y={6} r={4.5} seed="conv-key-rej" color="red" />
						<PrintNote x={302} y={11} size={13} color="var(--gb-ink)" halo={0}>
							reject → next stage, then manual
						</PrintNote>
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
					<HandDot
						x={3}
						y={7}
						r={2.4}
						seed={`meta-dot-${c}`}
						color="blue"
						opacity={0.35 + 0.55 * Math.max(0, Math.sin(t * 2 - i))}
					/>
					<text x={10} y={11} fontSize={11} fill={SWISS.ink} className="gb-num">
						{c}
					</text>
					<PenLine
						seed={`meta-rule-${c}`}
						from={[0, 15]}
						to={[100, 15]}
						color="faint"
						width={0.7}
					/>
				</g>
			))}
			<PenArrow
				seed="meta-arrow"
				from={[10, 90]}
				to={[90, 90]}
				bend={0.1}
				head={5}
				color="ink"
				width={1.2}
			/>
			<text
				x={0}
				y={84}
				fontSize={11}
				fill={SWISS.secondary}
				className="gb-num"
			>
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
	const ridgeD = path(ridge);
	return (
		<g>
			<Hachure
				d={`${ridgeD} L100 90 L0 90 Z`}
				seed="horizon-fill"
				color="brown"
				gap={5}
				opacity={0.5}
			/>
			<SketchPath
				d={ridgeD}
				seed="horizon-ridge"
				color="brown"
				width={1.6}
				data
			/>
			<PenLine
				seed="horizon-sweep"
				from={[sweep, 0]}
				to={[sweep, 90]}
				color="pencil"
				width={1}
				dash="2 3"
			/>
			<text
				x={0}
				y={98}
				fontSize={11}
				fill={SWISS.secondary}
				className="gb-num"
			>
				7,200 azimuths
			</text>
		</g>
	);
}

function SkylineArtefact({ ridge }: { ridge: [number, number][] }) {
	const ridgeD = path(ridge, 0, 4);
	const ticks = ridge
		.filter((_, i) => i % 2 === 0)
		.map(
			([x, y]) =>
				`M${x.toFixed(1)} ${(y + 4).toFixed(1)}V${(y + 12).toFixed(1)}`,
		)
		.join("");
	return (
		<g>
			<Hachure
				d={`${ridgeD} L100 90 L0 90 Z`}
				seed="skyline-fill"
				color="ink"
				gap={5}
				opacity={0.4}
			/>
			<SketchPath
				d={ticks}
				seed="skyline-ticks"
				color="pencil"
				width={0.8}
				passes={1}
			/>
			<SketchPath
				d={ridgeD}
				seed="skyline-ridge"
				color="ink"
				width={1.5}
				data
			/>
			<text
				x={0}
				y={98}
				fontSize={11}
				fill={SWISS.secondary}
				className="gb-num"
			>
				one row per column
			</text>
		</g>
	);
}

const GRID_COLS = 10;
const GRID_ROWS = 6;
const GRID_BX = 6.2;
const GRID_BY = 2.4;
const GRID_RULES =
	Array.from(
		{ length: GRID_COLS + 1 },
		(_, c) => `M${c * 10} 0V${GRID_ROWS * 12}`,
	).join("") +
	Array.from(
		{ length: GRID_ROWS + 1 },
		(_, r) => `M0 ${r * 12}H${GRID_COLS * 10}`,
	).join("");
const GRID_DOTS = (
	<g>
		{Array.from({ length: GRID_COLS * GRID_ROWS }, (_, n) => {
			const c = n % GRID_COLS;
			const r = Math.floor(n / GRID_COLS);
			const d = Math.hypot((c - GRID_BX) / 2.2, (r - GRID_BY) / 1.3);
			const v =
				Math.exp(-d * d) * 0.9 +
				0.1 * (0.5 + 0.5 * Math.sin(c * 1.7 + r * 2.3));
			return (
				<HandDot
					key={`cell-${c}-${r}`}
					x={c * 10 + 5}
					y={r * 12 + 6}
					r={0.9 + 3.6 * v}
					seed={`grid-${c}-${r}`}
					color="ink"
					opacity={0.3 + 0.6 * v}
				/>
			);
		})}
	</g>
);

function GridArtefact({ t, u }: { t: number; u: number }) {
	// a yaw x pitch cost grid; a bright basin appears and the LM marker walks to its floor
	const k = ease(clamp01((u - 0.3) / 0.28));
	return (
		<g>
			<SketchPath
				d={GRID_RULES}
				seed="grid-rules"
				color="faint"
				width={0.5}
				passes={1}
			/>
			{GRID_DOTS}
			<PenCircle
				seed="grid-marker"
				center={[
					(2 + (GRID_BX - 2) * k) * 10 + 5,
					(4 + (GRID_BY - 4) * k) * 12 + 6,
				]}
				radiusX={6}
				radiusY={5.5}
				color="ink"
				width={1.5}
			/>
			<text
				x={0}
				y={86}
				fontSize={11}
				fill={SWISS.secondary}
				className="gb-num"
			>
				±25° yaw · ±3° pitch
			</text>
			<g opacity={0.65 + 0.3 * Math.sin(t)}>
				<text
					x={0}
					y={98}
					fontSize={11}
					fill={SWISS.secondary}
					className="gb-num"
				>
					≤ 3 seeds → LM
				</text>
			</g>
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
	const tone = !showing ? "blue" : ok ? "forest" : "red";
	const barWidth = 100 * clamp01(showing ? conf : 0.05);
	return (
		<g>
			<PenLine
				seed="gate-track"
				from={[0, 19]}
				to={[100, 19]}
				color="pencil"
				width={1.1}
			/>
			<SketchPath
				d={`M0 19H${barWidth.toFixed(1)}`}
				seed="gate-bar"
				color={tone}
				width={7}
				opacity={0.75}
				passes={1}
				tolerance={0.4}
			/>
			<PenLine
				seed="gate-half"
				from={[50, 8]}
				to={[50, 30]}
				color="ink"
				width={1.2}
			/>
			<text
				x="50"
				y="5"
				textAnchor="middle"
				className="nb-num"
				fontSize="11"
				fill={PAPER}
			>
				0.5
			</text>
			<HandText x={0} y={52} size={14} color={tone} halo={false}>
				{!showing
					? "confidence?"
					: ok
						? "ACCEPT"
						: reject
							? "REJECT → refine"
							: "…"}
			</HandText>
			<text
				x="0"
				y="66"
				className="nb-num"
				fontSize="11"
				fill={PAPER}
				fillOpacity=".6"
			>
				{showing ? `confidence ${conf.toFixed(2)}` : " "}
			</text>
			<text
				x={0}
				y={86}
				fontSize={11}
				fill={SWISS.secondary}
				className="gb-num"
			>
				tilt &gt; 3° vs gravity
			</text>
			<text
				x={0}
				y={98}
				fontSize={11}
				fill={SWISS.secondary}
				className="gb-num"
			>
				is also a reject
			</text>
		</g>
	);
}

// ======================================================================================
// Fig. D4: the cascade as a flow of the 12 benchmark photos
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
const TokenDot = memo(function TokenDot({
	seed,
	color,
}: {
	seed: string;
	color: "forest" | "blue" | "red";
}) {
	return <HandDot x={0} y={0} r={5} seed={seed} color={color} opacity={0.9} />;
});

// Label size: 13 px rendered at the text column (~720 px) for this 640-wide viewBox.
const CASCADE_W = 640;
const CASCADE_LABEL = Math.round(((13 * CASCADE_W) / 720) * 2) / 2;

function CascadeFlow() {
	const [ref, t] = useTime<HTMLDivElement>();
	const W = CASCADE_W;
	return (
		<Figure
			label="Fig. D4"
			caption="Schematic routing of the 12 hand-registered photos through the cascade (src/lib/geo/README.md, 2026-09-24; the per-photo rows of the latest eval are in Fig. D5). Eight are accepted by solvePose alone in 0.02 to 0.15 s each on the demo photos. Refine runs only on the rejects and rescues three, all within 0.4°. One ultra-wide shot of a near ridge, with the eye itself off, is left to manual taps. Zero false accepts."
		>
			<div ref={ref}>
				<svg
					viewBox={`0 0 ${W} 250`}
					className="block h-auto w-full"
					role="img"
					aria-label="Twelve photos flowing through solvePose, then refinePose, then manual"
				>
					{/* stage slots */}
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
					<Hachure
						d={rectD(200, 196, 600, 230)}
						seed="cascade-tray"
						color="forest"
						gap={6}
						opacity={0.3}
					/>
					<text
						x="214"
						y="217"
						fontSize={CASCADE_LABEL}
						fill="var(--gb-forest)"
						className="gb-num"
						stroke="var(--nb-paper)"
						strokeWidth={4}
						paintOrder="stroke"
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
						const tone =
							dest === "none" ? "red" : dest === "refine" ? "blue" : "forest";
						return (
							<g
								key={id}
								transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}
							>
								<TokenDot seed={id} color={tone} />
							</g>
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
			<PenLine
				seed={`box-top-${label}`}
				from={[x, y]}
				to={[x + w, y]}
				color={hot ? "ink" : "pencil"}
				width={hot ? 2 : 1.2}
			/>
			<PenLine
				seed={`box-foot-${label}`}
				from={[x, y + 50]}
				to={[x + w, y + 50]}
				color="pencil"
				width={1}
			/>
			<text
				x={x + w / 2}
				y={y + 22}
				textAnchor="middle"
				fontSize={CASCADE_LABEL}
				fill={PAPER}
				className="gb-num"
			>
				{label}
			</text>
			<text
				x={x + w / 2}
				y={y + 40}
				textAnchor="middle"
				fontSize={CASCADE_LABEL}
				fill={SWISS.secondary}
				className="gb-num"
			>
				{sub}
			</text>
		</g>
	);
}
function Rail({ d, ghost }: { d: string; ghost?: boolean }) {
	return (
		<SketchPath
			d={d}
			seed={`rail-${d}`}
			color={ghost ? "faint" : "pencil"}
			width={1.5}
			dash={ghost ? "3 5" : undefined}
			passes={1}
		/>
	);
}

// ======================================================================================
// Fig. D6: why this is the default, from the README variants table
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
			label="Fig. D6"
			caption="Same 12 photos, same classic skyline (src/lib/geo/README.md). The bar is photos accepted; the tick is photos whose skyline lands within 10 px. Every variant shown has zero false accepts. Differences below about 0.3° in median yaw are inside ground-truth noise."
		>
			<div className="space-y-3">
				{VARIANTS.map((v) => {
					const barW = (v.acc / 12) * 600;
					return (
						<div key={v.name}>
							<div
								className={`flex justify-between font-mono ${TYPE.micro} gb-secondary`}
							>
								<span className={v.hot ? "text-[var(--gb-ink)]" : ""}>
									{v.name}
								</span>
								<span>{v.med}</span>
							</div>
							<svg
								viewBox="0 0 600 18"
								className="mt-1 block h-auto w-full"
								aria-hidden="true"
							>
								<PenLine
									seed={`variant-track-${v.name}`}
									from={[0, 16]}
									to={[600, 16]}
									color="faint"
									width={0.9}
								/>
								{barW > 3 && (
									<rect
										x={0}
										y={4}
										width={barW}
										height={10}
										style={{
											fill: v.hot
												? "var(--gb-red)"
												: "color-mix(in srgb, var(--gb-ink) 45%, var(--gb-paper))",
										}}
									/>
								)}
								<PenLine
									seed={`variant-tick-${v.name}`}
									from={[(v.ok10 / 12) * 600, 0]}
									to={[(v.ok10 / 12) * 600, 18]}
									color="ink"
									width={2}
								/>
							</svg>
							<div
								className={`mt-0.5 flex justify-between font-mono ${TYPE.micro} gb-secondary`}
							>
								<span>{v.acc}/12 accepted</span>
								<span>{v.ok10}/12 ≤ 10 px</span>
							</div>
						</div>
					);
				})}
			</div>
		</Figure>
	);
}

// ======================================================================================
// Measured figures
// ======================================================================================
const CYAN = "var(--gb-water)";
const YELLOW = "var(--gb-contour)";
const fmtMs = (v: number) =>
	v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;

function band(d: GipfelbuchPhotoData): [number, number, number, number] {
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
				<span className={`font-mono ${TYPE.micro} text-[var(--accent)]`}>
					{n}
				</span>
				<span className={`${TYPE.caption} gb-ink`}>{title}</span>
				<span className={`ml-auto font-mono ${TYPE.micro} gb-secondary`}>
					{fn}
				</span>
			</div>
			{children}
			<div className={`mt-1.5 font-mono ${TYPE.micro} gb-secondary`}>
				{foot}
			</div>
		</div>
	);
}

function Num({ children }: { children: React.ReactNode }) {
	return <span className="gb-ink">{children}</span>;
}

const STAGE_COLOURS = [
	"var(--gb-relief)",
	"var(--gb-navy)",
	YELLOW,
	CYAN,
] as const;
function TimeBar({ d }: { d: GipfelbuchPhotoData }) {
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
			<svg
				viewBox="0 0 600 22"
				className="block h-auto w-full"
				role="img"
				aria-label={`Stage times: ${parts.map((p) => `${p.k} ${fmtMs(p.v)}`).join(", ")}`}
			>
				{
					parts.reduce(
						(acc, p) => {
							const w = Math.max(3, (p.v / total) * 600);
							acc.items.push(
								<g key={p.k}>
									<rect
										x={acc.x}
										y={2}
										width={Math.max(1, w - 1)}
										height={18}
										style={{ fill: p.c }}
									/>
									{w > 120 && (
										<text
											x={acc.x + 6}
											y={15}
											fontSize={11}
											className="gb-num"
											style={{ fill: "var(--gb-paper)" }}
										>
											{p.k} {Math.round((p.v / total) * 100)} %
										</text>
									)}
								</g>,
							);
							acc.x += w;
							return acc;
						},
						{ x: 0, items: [] as React.ReactNode[] },
					).items
				}
			</svg>
			<div
				className={`mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono ${TYPE.micro} gb-secondary`}
			>
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
	id: GipfelbuchPhotoId;
	setId: (i: GipfelbuchPhotoId) => void;
	d: GipfelbuchPhotoData | null;
	idx: GipfelbuchIndex | null;
}) {
	const crop = useMemo(() => (d ? band(d) : undefined), [d]);
	const valid = d ? d.skyline.rows.filter((v) => v != null).length : 0;
	return (
		<Figure
			label="Fig. D1"
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
							className={`bg-[var(--gb-paper)] px-1 font-mono ${TYPE.micro} ${p.accepted ? "text-[var(--gb-water)]" : "text-[var(--gb-red)]"}`}
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
	idx: GipfelbuchIndex | null;
	id: GipfelbuchPhotoId;
	setId: (i: GipfelbuchPhotoId) => void;
}) {
	if (!idx) return null;
	const maxRes = Math.max(...idx.photos.map((p) => p.residual.prior.median));
	const nAcc = idx.photos.filter((p) => p.accepted).length;
	const nRefine = idx.photos.filter(
		(p) => p.stage === "refine" && p.accepted,
	).length;
	return (
		<Figure
			label="Fig. D3"
			bleed
			caption={
				<>
					All 12 demo photos through the same code. Bars: median skyline error
					in pixels before (red) and after (navy) the solve. {nAcc} of 12 are
					accepted, {nAcc - nRefine} by solvePose and {nRefine} only by
					refinePose; the rest are rejected rather than guessed. Click a row to
					load it in Fig. D1. <Measured data={idx} />
				</>
			}
		>
			<div className="overflow-x-auto">
				<table
					className={`w-full border-separate border-spacing-y-1 font-mono ${TYPE.micro}`}
				>
					<thead>
						<tr className={`text-left ${TYPE.micro} gb-secondary`}>
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
									className={`cursor-pointer gb-secondary ${p.id === id ? "bg-[var(--gb-paper-deep)]" : "hover:bg-[var(--gb-paper-deep)]"}`}
								>
									<td className="py-0.5 pr-2">
										<img
											src={p.thumb}
											alt={p.id}
											className="h-7 w-9 object-cover"
										/>
									</td>
									<td
										className={
											p.accepted
												? "text-[var(--gb-water)]"
												: "text-[var(--gb-red)]"
										}
									>
										{p.accepted ? p.stage : "rejected"}{" "}
										<span className="gb-secondary">
											{p.confidence.toFixed(2)}
										</span>
									</td>
									<td className="text-right gb-ink">
										{p.delta.yaw > 0 ? "+" : "−"}
										{Math.abs(p.delta.yaw).toFixed(1)}°
									</td>
									<td className="pl-3">
										<div className="flex items-center gap-1.5">
											<svg
												width={112}
												height={13}
												viewBox="0 0 112 13"
												className="shrink-0"
												aria-hidden="true"
											>
												<rect
													x={0}
													y={1}
													height={4.5}
													width={Math.max(
														3,
														(p.residual.prior.median / maxRes) * 112,
													)}
													style={{ fill: "var(--gb-red)" }}
												/>
												<rect
													x={0}
													y={7.5}
													height={4.5}
													width={Math.max(
														3,
														(p.residual.solved.median / maxRes) * 112,
													)}
													style={{ fill: "var(--gb-navy)" }}
												/>
											</svg>
											<span className={`${TYPE.micro} gb-secondary`}>
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
function GroundTruthEval({ idx }: { idx: GipfelbuchIndex | null }) {
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
			label="Fig. D5"
			caption={
				<>
					The hand-registered benchmark (data/ground-truth.json) as the latest
					eval runs left it (out/eval and out/eval-classic-cascade, copied by
					scripts/gipfelbuch/build-data.ts): {solve.length} photos, solvePose
					alone accepts {a}, the cascade {b}. Refine rescues{" "}
					{rescued.join(", ")}. Each cell is one photo; the left half is
					solvePose alone, the right half the cascade, filled when accepted.
					These per-photo rows carry the verdict and the correction from the
					prior but not the ground-truth error; that is in the table below.
				</>
			}
		>
			<div className="flex flex-wrap gap-2">
				{solve.map((r, i) => {
					const c = casc[i];
					return (
						<div
							key={r.name}
							className={`bg-[var(--gb-paper-deep)] px-2 py-1.5 font-mono ${TYPE.micro} gb-secondary`}
						>
							<div className="flex items-center gap-1.5">
								<svg
									width={26}
									height={15}
									viewBox="0 0 26 15"
									aria-hidden="true"
								>
									<PenLine
										seed={`gt-base-${r.name}`}
										from={[1, 14]}
										to={[25, 14]}
										color="pencil"
										width={1}
									/>
									<PenLine
										seed={`gt-mid-${r.name}`}
										from={[13, 2]}
										to={[13, 14]}
										color="faint"
										width={0.8}
									/>
									{r.accepted && (
										<rect
											x={1}
											y={2}
											width={11}
											height={11}
											style={{ fill: "var(--gb-navy)" }}
										/>
									)}
									{c.accepted && (
										<rect
											x={14}
											y={2}
											width={11}
											height={11}
											style={{ fill: "var(--gb-navy)" }}
										/>
									)}
								</svg>
								{r.name.replace("IMG_", "")}
							</div>
							<div className="mt-0.5 gb-secondary">gt {r.gtQuality}</div>
						</div>
					);
				})}
			</div>
		</Figure>
	);
}

function Deep() {
	const [id, setId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(id);
	const idx = useGipfelbuchIndex();
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
									runs (Fig. D3), and is the automatic fallback.
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
			<p className={`!mt-3 ${TYPE.caption} gb-secondary`}>
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
				<p className={`!mt-3 font-mono ${TYPE.caption} gb-secondary`}>
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
	const [heroId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(heroId);
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
						render: () => <RealPhoto bleed data={d} layers={[]} crop={crop} />,
					},
					{
						label: "Skyline from the map",
						caption: `From the GPS fix we predict the skyline the terrain should make. This takes ${t(d?.ms.horizon)}.`,
						render: () => (
							<RealPhoto bleed data={d} layers={["prior"]} crop={crop} />
						),
					},
					{
						label: "Skyline in the pixels",
						caption: `We find the skyline in the photo itself. This takes ${t(d?.ms.skyline)}.`,
						render: () => (
							<RealPhoto
								bleed
								data={d}
								layers={["prior", "skyline"]}
								crop={crop}
							/>
						),
					},
					{
						label: "Slide to match",
						caption: `We turn the camera until the two lines overlap, then check how sure we are. ${t(d?.ms.solve)}.`,
						render: () => (
							<RealPhoto
								bleed
								data={d}
								layers={["skyline", "solved"]}
								crop={crop}
							/>
						),
					},
					{
						label: "Label",
						caption:
							"Once the pose is trusted, we name the peaks that line up.",
						render: () => (
							<RealPhoto
								bleed
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
function ridgeCrop(d: GipfelbuchPhotoData): [number, number, number, number] {
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
	id: GipfelbuchPhotoId;
	layers: ("skyline" | "solved" | "prior")[];
}) {
	const d = useGipfelbuchPhoto(id);
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
	const idx = useGipfelbuchIndex();
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
				{
					value: "0",
					label: "false accepts on 12 hand-registered photos (Terrarium DEM)",
				},
			]}
			source="Measured on the 12 demo photos, scripts/gipfelbuch/build-data.ts, 2026-10-01. False accepts: src/lib/geo/README.md (2026-09-24); on the Mapterhorn DEM the same set has one borderline accept, 1.05° off."
		/>
	);
}

// ======================================================================================
// The yaw search: the real coarse cost of solvePose against the yaw offset, with its winner and runner-up.
// Data: scripts/gipfelbuch/data-pose-solve.ts (planCoarse + coarseCost of src/lib/geo/solve.ts).
// ======================================================================================
type YawCurve = {
	truncDeg: number;
	dy: number[];
	cost: number[];
	win: { dy: number; dp: number; cost: number };
	runner: { dy: number; dp: number; cost: number } | null;
	median: number;
	ambiguity: number;
};
type PoseSolveData = {
	photos: Record<
		string,
		{
			local: YawCurve;
			full: YawCurve;
			runnerRows: (number | null)[] | null;
		}
	>;
};
const RUNNER_C = "var(--gb-contour)";
const MARK_INK = {
	compass: "red",
	runner: "brown",
	best: "blue",
} as const;
let poseSolveCache: Promise<PoseSolveData> | null = null;
function usePoseSolve() {
	const [d, setD] = useState<PoseSolveData | null>(null);
	useEffect(() => {
		let live = true;
		poseSolveCache ??= fetch(
			"/demo/gipfelbuch/pose-solve/pose-solve.json",
		).then((r) => r.json());
		poseSolveCache.then(
			(v) => live && setD(v),
			() => {
				poseSolveCache = null;
			},
		);
		return () => {
			live = false;
		};
	}, []);
	return d;
}

type Hyp = "compass" | "runner" | "best";

// Label sizes: 11 and 13 px rendered at the text column (~720 px) for this 480-wide viewBox.
const YAW_W = 480;
const YAW_LABEL_SMALL = Math.round(((11 * YAW_W) / 720) * 2) / 2;
const YAW_LABEL = Math.round(((13 * YAW_W) / 720) * 2) / 2;

function YawSearch() {
	const [id, setId] = useNotebookPhoto();
	const [hyp, setHyp] = useState<Hyp>("best");
	const [full, setFull] = useState(false);
	const d = useGipfelbuchPhoto(id);
	const idx = useGipfelbuchIndex();
	const all = usePoseSolve();
	const ps = all?.photos[id];
	const crop = useMemo(() => (d ? skylineBand(d, 280) : undefined), [d]);
	const curve = ps ? (full ? ps.full : ps.local) : null;
	// degrees of elevation to pixels at the working width: 1° is f·π/180 px
	const pxPerDeg = d ? (d.prior.f * Math.PI) / 180 : 1;
	const px = (deg: number) => deg * pxPerDeg;
	const costAt = (c: YawCurve, dy: number) => {
		let k = 0;
		for (let i = 1; i < c.dy.length; i++)
			if (Math.abs(c.dy[i] - dy) < Math.abs(c.dy[k] - dy)) k = i;
		return c.cost[k];
	};
	const W = YAW_W;
	const H = 250;
	const m = { l: 46, r: 14, t: 14, b: 34 };
	let plot: React.ReactNode = null;
	let readout: React.ReactNode = null;
	if (curve && d) {
		const xr = full ? 180 : 25;
		const sx = (v: number) => m.l + ((v + xr) / (2 * xr)) * (W - m.l - m.r);
		const ymax = Math.max(...curve.cost.map(px)) * 1.08;
		const sy = (v: number) => H - m.b - (v / ymax) * (H - m.t - m.b);
		const pts = curve.dy.map(
			(x, i) =>
				`${i ? "L" : "M"}${sx(x).toFixed(1)} ${sy(px(curve.cost[i])).toFixed(1)}`,
		);
		const marks: { k: Hyp; dy: number; c: string; on: boolean }[] = [
			{ k: "compass", dy: 0, c: SWISS.red, on: !full },
			{
				k: "runner",
				dy: curve.runner?.dy ?? 0,
				c: RUNNER_C,
				on: !!curve.runner,
			},
			{ k: "best", dy: curve.win.dy, c: "var(--gb-water)", on: true },
		];
		const c1 = px(curve.win.cost);
		const c2 = curve.runner ? px(curve.runner.cost) : null;
		const cm = px(curve.median);
		plot = (
			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="mt-3 block h-auto w-full"
				role="img"
				aria-label={`${id}: mean skyline gap in pixels against the yaw offset from the compass`}
			>
				{[0, 0.5, 1].map((k) => (
					<PenLine
						key={k}
						seed={`yaw-grid-${id}-${full}-${k}`}
						from={[m.l, sy(k * ymax)]}
						to={[W - m.r, sy(k * ymax)]}
						color="faint"
						width={0.5}
					/>
				))}
				<PenLine
					seed={`yaw-median-${id}-${full}`}
					from={[m.l, sy(cm)]}
					to={[W - m.r, sy(cm)]}
					color="pencil"
					width={0.9}
					dash="2 4"
				/>
				<text
					x={W - m.r}
					y={sy(cm) + 16}
					textAnchor="end"
					fontSize={YAW_LABEL}
					fill={SWISS.secondary}
					paintOrder="stroke"
					stroke={SWISS.paper}
					strokeWidth={3}
					strokeLinejoin="round"
					className="gb-num"
				>
					typical yaw {cm.toFixed(1)} px
				</text>
				{marks.map(
					(mk) =>
						mk.on && (
							<g key={mk.k} opacity={mk.k === hyp || full ? 1 : 0.6}>
								<PenLine
									seed={`yaw-mark-${id}-${full}-${mk.k}`}
									from={[sx(mk.dy), m.t]}
									to={[sx(mk.dy), H - m.b]}
									color={MARK_INK[mk.k]}
									width={mk.k === hyp ? 2.2 : 1.2}
									dash={mk.k === "compass" ? "4 3" : undefined}
								/>
							</g>
						),
				)}
				<path
					d={pts.join("")}
					fill="none"
					stroke={SWISS.ink}
					strokeWidth={1.7}
					strokeLinejoin="round"
				/>
				{[
					[curve.win, "blue", "best"],
					[curve.runner, "brown", "runner"],
				].map(([p, c, key]) => {
					const q = p as YawCurve["win"] | null;
					return (
						q && (
							<HandDot
								key={key as string}
								x={sx(q.dy)}
								y={sy(px(q.cost))}
								r={5}
								seed={`yaw-dot-${id}-${full}-${key}`}
								color={c as "blue" | "brown"}
								opacity={1}
							/>
						)
					);
				})}
				{(full ? [-180, -90, 0, 90, 180] : [-25, -10, 0, 10, 25]).map((v) => (
					<text
						key={v}
						x={sx(v)}
						y={H - 16}
						textAnchor="middle"
						className="nb-num"
						fontSize={YAW_LABEL_SMALL}
						fill={SWISS.secondary}
					>
						{v > 0 ? "+" : v < 0 ? "−" : ""}
						{Math.abs(v)}°
					</text>
				))}
				<text
					x={(m.l + W - m.r) / 2}
					y={H - 2}
					textAnchor="middle"
					fontSize={YAW_LABEL}
					fill={SWISS.secondary}
					className="gb-num"
				>
					yaw offset from the compass
				</text>
				<text
					x={m.l - 6}
					y={sy(ymax * 0.5)}
					textAnchor="end"
					className="nb-num"
					fontSize={YAW_LABEL_SMALL}
					fill={SWISS.secondary}
				>
					{(ymax * 0.5).toFixed(0)} px
				</text>
				<text
					x={m.l - 6}
					y={sy(0) + 3}
					textAnchor="end"
					className="nb-num"
					fontSize={YAW_LABEL_SMALL}
					fill={SWISS.secondary}
				>
					0
				</text>
			</svg>
		);
		const a = curve.ambiguity;
		readout = (
			<p className={`mt-2 font-mono ${TYPE.micro} gb-secondary`}>
				best{" "}
				<span style={{ color: "var(--gb-water)" }}>{sg(curve.win.dy)}°</span> at{" "}
				{c1.toFixed(1)} px
				{c2 != null && curve.runner ? (
					<>
						{" · "}runner-up{" "}
						<span style={{ color: RUNNER_C }}>{sg(curve.runner.dy)}°</span> at{" "}
						{c2.toFixed(1)} px
					</>
				) : null}
				{" · "}ambiguity {a.toFixed(2)}
				{!full && (
					<>
						{" · "}compass{" "}
						{costAt(curve, 0) != null ? px(costAt(curve, 0)).toFixed(1) : ""} px
					</>
				)}
			</p>
		);
	}
	const idxPhoto = idx?.photos.find((p) => p.id === id);
	return (
		<Figure
			label="Fig. 2"
			bleed
			caption={
				<>
					Cost of every yaw, on a real photo. The{" "}
					<span style={{ color: "var(--gb-water)" }}>deepest dip</span> is the
					answer; the <span style={{ color: RUNNER_C }}>runner-up</span> is the
					nearest rival. Pick a marker to see the map&rsquo;s skyline at that
					yaw. <Measured data={d} />
				</>
			}
		>
			<PhotoPicker
				value={id}
				onChange={(i) => {
					setId(i);
					setHyp("best");
				}}
				mark={(i) => {
					const x = idx?.photos.find((p) => p.id === i);
					return x ? (
						<span
							className={`bg-[var(--gb-paper)] px-1 font-mono ${TYPE.micro}`}
							style={{
								color: x.accepted ? "var(--gb-water)" : "var(--gb-red)",
							}}
						>
							{x.accepted ? "ok" : "rej"}
						</span>
					) : null;
				}}
			/>
			<RealPhoto
				key={id}
				data={d}
				layers={[
					"skyline",
					...(hyp === "compass" ? (["prior"] as const) : []),
					...(hyp === "best" ? (["solved"] as const) : []),
				]}
				crop={crop}
			>
				{(dd) =>
					hyp === "runner" && ps?.runnerRows ? (
						<CrispLine
							d={rowsPath(ps.runnerRows, 12)}
							color={SWISS.contour}
							width={dd.photo.width / 260}
							dash={`${(dd.photo.width / 260) * 4} ${(dd.photo.width / 260) * 2}`}
						/>
					) : null
				}
			</RealPhoto>
			<div className={`mt-3 flex flex-wrap items-center gap-2 ${TYPE.caption}`}>
				{(
					[
						["compass", "compass guess", SWISS.red],
						["runner", "runner-up", RUNNER_C],
						["best", "best fit", "var(--gb-water)"],
					] as const
				).map(([k, label, c]) => (
					<button
						key={k}
						type="button"
						disabled={full || (k === "runner" && !ps?.runnerRows)}
						onClick={() => setHyp(k)}
						aria-pressed={hyp === k && !full}
						className="border-b-2 bg-[var(--gb-paper-deep)] px-3 py-1 disabled:opacity-30"
						style={{
							borderColor: hyp === k && !full ? c : "transparent",
							color: hyp === k && !full ? c : "var(--gb-secondary, #4a545c)",
						}}
					>
						{label}
					</button>
				))}
				<label className="ml-auto flex items-center gap-2 gb-secondary">
					<input
						type="checkbox"
						checked={full}
						onChange={(e) => setFull(e.target.checked)}
						style={{ accentColor: "var(--accent)" }}
					/>
					search the full circle
				</label>
			</div>
			{plot}
			{readout}
			{full && curve && (
				<p className={`mt-1 ${TYPE.caption} gb-secondary`}>
					{idxPhoto && !idxPhoto.accepted ? "This photo was rejected. " : ""}
					With no compass to lean on, rival dips appear all around the circle.
					That is why the unknown-heading search needs a higher bar.
				</p>
			)}
			<Eq
				label="What the dip measures"
				where={[
					{
						sym: "ε",
						c: "skyline",
						text: "elevation of the photo's skyline in column x",
					},
					{
						sym: "h",
						c: "solved",
						text: "elevation of the map's skyline in that column, after turning the camera by Δψ (yaw) and Δφ (pitch)",
					},
					{ sym: "w", text: "how sure we are of that column (0 to 1)" },
					{
						sym: "τ",
						text: "cap on one column's error, 12 px, so a hand on the ridge cannot dominate",
					},
				]}
			>
				<Sym>E</Sym>(<Sym>Δψ</Sym>) = <Op op="min" under={<Sym>Δφ</Sym>} />{" "}
				<Frac
					n={
						<>
							<Op op="Σ" under={<Sym>x</Sym>} /> <Sym>w</Sym>
							<sub>x</sub> min(|<Sym c="skyline">ε</Sym>
							<sub>x</sub> − <Sym c="solved">h</Sym>
							<sub>x</sub>(<Sym>Δψ</Sym>, <Sym>Δφ</Sym>)|, <Sym>τ</Sym>)
						</>
					}
					d={
						<>
							<Op op="Σ" under={<Sym>x</Sym>} /> <Sym>w</Sym>
							<sub>x</sub>
						</>
					}
				/>
			</Eq>
		</Figure>
	);
}

const sg = (v: number) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(1)}`;

export default function Page({ node }: { node: GipfelbuchNode }) {
	void node;
	return (
		<>
			<HeroStages />

			<Beat
				kicker="The idea"
				title="Predict the skyline, find it, slide one onto the other."
			>
				<p>
					Everything runs in the browser, with no neural network. The last step
					is a gate that is allowed to say <em>I don&rsquo;t know</em>.
				</p>
			</Beat>

			<Beat kicker="The solve" title="Sliding is a search for the deepest dip.">
				<p>
					We try every yaw, the way the camera points, within 25° of the
					compass. Each one scores how far the two skylines sit apart.
				</p>
				<p>
					The lowest score wins. The nearest rival tells us how far to trust it.
				</p>
			</Beat>

			<YawSearch />

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
				label="Fig. 3"
				caption="Fixed: demo-11 and demo-12. Same head on the ridge, two verdicts. Demo-11 is rejected; demo-12 is rescued by the second solver."
			>
				<Gallery
					ids={["demo-11", "demo-12"]}
					cols={2}
					tone={(d) => (d.solved.accepted ? "result" : "failure")}
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

			<Details>
				<Deep />
			</Details>
		</>
	);
}
