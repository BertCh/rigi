// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
	CircledNumber,
	HandMark,
	Wash,
} from "#/components/gipfelbuch/notebook";
import {
	Hachure,
	HandDot,
	HandText,
	type InkColor,
	inkColor,
	PenArrow,
	PenCircle,
	PenLine,
	SketchPolyline,
	Stipple,
} from "#/components/gipfelbuch/notebook/Ink";
import { useNotebookPhoto } from "#/components/gipfelbuch/notebook/useNotebookPhoto";
import {
	AlignmentStoryProvider,
	Callout,
	CodeRef,
	Eq,
	Figure,
	Frac,
	HandLabel,
	HandNote,
	HandRange,
	LAYER_STYLE,
	LiveReveal,
	MarginNote,
	RealPhoto,
	Section,
	Stat,
	Steps,
	StoryMap,
	Sym,
	useGipfelbuchPhoto,
	useReducedMotion,
	useTime,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Details,
	Key,
	Mark,
	MarkList,
	Numbers,
	Stages,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// Photo Workspace: the cockpit decides WHICH pose to trust and when to let you export it.
// Mechanism numbers are literal from the code:
//   choosePreview: autoAlign accepted at confidence > 0.2, else near-compass window yaw 4 / pitch 1.5 deg, else prior
//   AGREE_DEG 1 deg, CASCADE_TIMEOUT_MS 20 000, matcher request timeout 150 000 (src/lib/integration/second-opinion.ts)
//   drag: yaw -= dx/w * hfov, pitch += dy/h * vfov, shift-drag roll += dx * 0.05, align-tool wheel vfov *= 1 + dy * 0.0006 (5..100)
//   solvePins (src/lib/align.ts): 1 pin -> yaw+pitch, 2 pins -> +roll, >= 3 pins -> +vfov
// Accuracy numbers: reports/leaderboard.md (12 hand-registered GT photos). Timelines in the hero are schematic in
// time; the IMG_7130 offsets (+2.98 deg, 4.017 deg prior, -0.02 deg cascade) are the real ones.

const DEG = Math.PI / 180;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (k: number) => {
	const x = clamp01(k);
	return x * x * (3 - 2 * x);
};

const CHIP_ON =
	"bg-[var(--nb-highlight,var(--accent))] text-[var(--gb-ink)] underline decoration-[var(--nb-red)] decoration-2 underline-offset-4";
const INKVAR: Record<string, string> = {
	pencil: "var(--nb-pencil)",
	forest: "var(--nb-forest)",
	brown: "var(--nb-brown)",
	red: "var(--nb-red)",
	blue: "var(--nb-blue)",
	navy: "var(--nb-navy)",
	ink: "var(--gb-ink)",
	neutral: "var(--nb-pencil)",
};
const CHIP_OFF =
	"bg-[var(--nb-paper-deep)] text-[color-mix(in_oklab,var(--gb-ink)_80%,transparent)]";

// ======================================================================================
// Hero: a pose's journey: source -> preview -> second opinion -> export unlocked
// ======================================================================================
type Seg = {
	a: number;
	b: number;
	label: string;
	off: number; // overlay yaw offset from the truth, degrees
	tone: "ok" | "warn" | "neutral" | "user";
};
type Scenario = {
	id: string;
	label: string;
	sub: string;
	loadEnd: number;
	segs: Seg[];
	lockEnd: number; // exports locked until here
	workers: { a: number; b: number; label: string }[];
	badge?: { at: number; kind: "verified" | "refined" | "matched" };
	banner?: { a: number; b: number };
	notes: { at: number; text: string }[];
	axisBreak?: boolean;
};
const LOOP = 11;
const SCENARIOS: Scenario[] = [
	{
		id: "saved",
		label: "Saved pose",
		sub: "no solve needed",
		loadEnd: 1.6,
		segs: [{ a: 1.6, b: LOOP, label: "saved", off: 0, tone: "ok" }],
		lockEnd: 1.6,
		workers: [],
		notes: [
			{
				at: 0,
				text: "Terrain and photo load; the overlay waits.",
			},
			{
				at: 1.6,
				text: "A saved or sample pose is used as is. Nothing is re-solved and no second check runs, so export unlocks when loading ends.",
			},
		],
	},
	{
		id: "verified",
		label: "Full metadata, checked",
		sub: "auto-align + second check, within 1°",
		loadEnd: 2.4,
		segs: [
			{ a: 2.4, b: 6, label: "auto", off: 0.3, tone: "neutral" },
			{ a: 6, b: LOOP, label: "auto · verified", off: 0.3, tone: "ok" },
		],
		lockEnd: 6,
		workers: [{ a: 2.6, b: 6, label: "second solver" }],
		badge: { at: 6, kind: "verified" },
		notes: [
			{
				at: 0,
				text: "Compass, gravity and lens are all known, so the pose is solved while the photo loads.",
			},
			{
				at: 2.4,
				text: "Confidence is above 0.2, so the pose is shown at once. A second, independent solver starts in the background. Export stays locked until it answers.",
			},
			{
				at: 6,
				text: "Both accept and agree within 1°: keep the pose, show Verified, unlock export.",
			},
		],
	},
	{
		id: "refined",
		label: "Second check corrects",
		sub: "+2.98° → −0.02°",
		loadEnd: 2.4,
		segs: [
			{ a: 2.4, b: 6, label: "auto", off: 2.98, tone: "neutral" },
			{ a: 6, b: LOOP, label: "refined", off: -0.02, tone: "ok" },
		],
		lockEnd: 6,
		workers: [{ a: 2.6, b: 6, label: "second solver" }],
		badge: { at: 6, kind: "refined" },
		notes: [
			{
				at: 2.4,
				text: "The fast solver accepted this photo at confidence 0.397 and was 2.98° off. That clears the 0.2 bar, so it is shown first.",
			},
			{
				at: 6,
				text: "The second solver lands at −0.02°, 3.0° away from the first. Its pose replaces the preview and the badge reads Refined. It made no false accept on the 12 test photos.",
			},
		],
	},
	{
		id: "unverified",
		label: "Weak skyline",
		sub: "phone guess → unverified → map match",
		loadEnd: 2.4,
		segs: [
			{ a: 2.4, b: 5, label: "phone guess", off: 4.0, tone: "neutral" },
			{ a: 5, b: 8, label: "unverified", off: 4.0, tone: "warn" },
			{ a: 8, b: LOOP, label: "matched", off: 0, tone: "ok" },
		],
		lockEnd: 8,
		workers: [
			{ a: 2.6, b: 5, label: "second solver" },
			{ a: 5, b: 8, label: "map match" },
		],
		badge: { at: 8, kind: "matched" },
		banner: { a: 5, b: 8 },
		axisBreak: true,
		notes: [
			{
				at: 2.4,
				text: "The skyline match is weak (confidence 0.2 or less), so the phone's own compass and gravity pose is shown as a candidate.",
			},
			{
				at: 5,
				text: "The second solver rejects it. The pose is marked unverified, an amber banner appears, labels soften, and the map-match service is asked.",
			},
			{
				at: 8,
				text: "Used only if the match passes the accept rule. It takes about 45 to 77 s when idle (not to scale). If the service is busy, export unlocks at once and the pose upgrades later.",
			},
		],
	},
];

const TONE: Record<Seg["tone"], InkColor> = {
	ok: "forest",
	warn: "brown",
	neutral: "pencil",
	user: "navy",
};

// the photo's skyline (fixed) and the overlay (same curve shifted by the pose error)
const PPD = 16;
const ridge = (x: number) =>
	62 -
	16 * Math.exp(-(((x - 170) / 46) ** 2)) -
	30 * Math.exp(-(((x - 300) / 38) ** 2)) -
	21 * Math.exp(-(((x - 410) / 55) ** 2)) -
	11 * Math.exp(-(((x - 520) / 36) ** 2)) +
	3 * Math.sin(x * 0.11) +
	2 * Math.sin(x * 0.29 + 1);
const RIDGE_PTS = Array.from({ length: 129 }, (_, i) => i * 5);
const RIDGE_XY: [number, number][] = RIDGE_PTS.map((x) => [x, ridge(x)]);
const RIDGE_FILL = `M0 150 L${RIDGE_XY.map(([x, y]) => `${x} ${y.toFixed(1)}`).join(" L")} L640 150 Z`;
const BOX = (x: number, y: number, w: number, h: number) =>
	`M${x} ${y}H${x + w}V${y + h}H${x}Z`;

function offsetAt(sc: Scenario, T: number) {
	let cur = 0;
	for (let i = 0; i < sc.segs.length; i++) if (T >= sc.segs[i].a) cur = i;
	const s = sc.segs[cur];
	const prev = cur > 0 ? sc.segs[cur - 1].off : s.off;
	return prev + (s.off - prev) * ease((T - s.a) / 0.7);
}

// Label sizes in viewBox units. The 640-wide schematics render at 540 to 800 px (the sheet column up to
// the bleed width), so 11.5 and 13.5 units land at about 10 to 14 px rendered.
const FIG_LABEL = 11.5;
const FIG_NAME = 13.5;

function PoseJourney() {
	const reduce = useReducedMotion();
	const [ref, t] = useTime<HTMLDivElement>(LOOP - 0.5);
	const [sel, setSel] = useState(1);
	const [clock0, setClock0] = useState(0);
	const [manual, setManual] = useState<number | null>(null);
	const sc = SCENARIOS[sel];
	const T = manual ?? (reduce ? LOOP - 0.5 : (t - clock0) % LOOP);

	const pick = (i: number) => {
		setSel(i);
		setManual(null);
		setClock0(t);
	};

	const off = offsetAt(sc, T);
	const poseAt = sc.segs[0].a;
	const overlayOp = clamp01((T - poseAt + 0.3) / 0.6);
	const seg = [...sc.segs].reverse().find((s) => T >= s.a) ?? null;
	const loading = T < sc.loadEnd;
	const note = [...sc.notes].reverse().find((n) => T >= n.at) ?? sc.notes[0];
	const badge = sc.badge && T >= sc.badge.at ? sc.badge.kind : null;
	const banner = sc.banner && T >= sc.banner.a && T < sc.banner.b;

	// layout
	const W = 640;
	const X0 = 112;
	const X1 = 624;
	const xT = (s: number) => X0 + ((X1 - X0) * s) / LOOP;
	const px = xT(Math.min(T, LOOP));
	const rows = { pose: 196, lock: 236, work: 276 };

	return (
		<Figure
			label="D2"
			bleed
			source="Skizze"
			caption="One photo's pose from page load to export. Pick a scenario or scrub the timeline. Durations are schematic; the +2.98° and −0.02° offsets are measured."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<div className="mb-3 flex flex-wrap gap-2">
					{SCENARIOS.map((s, i) => (
						<button
							key={s.id}
							type="button"
							onClick={() => pick(i)}
							aria-pressed={i === sel}
							className={`px-3 py-1.5 text-left font-mono text-[11px] leading-tight transition ${i === sel ? CHIP_ON : CHIP_OFF}`}
						>
							<span className="block text-[13px] font-semibold">{s.label}</span>
							<span className="block opacity-60">{s.sub}</span>
						</button>
					))}
				</div>
				<svg
					viewBox={`0 0 ${W} 308`}
					className="block h-auto w-full"
					role="img"
					aria-label="Timeline of pose source, second check and export lock"
				>
					<defs>
						<clipPath id="pw-clip">
							<rect width={W} height="150" />
						</clipPath>
					</defs>
					<g clipPath="url(#pw-clip)">
						{/* the photo's skyline: hachured ground under a pencil crest */}
						<Wash
							d={RIDGE_FILL}
							color="var(--nb-pencil)"
							seed="pw-wash-1"
							layers={5}
						/>
						<Hachure
							d={RIDGE_FILL}
							seed="pj-ground"
							color="pencil"
							gap={6}
							angle={-45}
							opacity={0.45}
						/>
						<SketchPolyline
							points={RIDGE_XY}
							seed="pj-crest"
							data
							color="ink"
							width={1.4}
							passes={1}
						/>
						{/* the overlay: DEM horizon under the shown pose. Sketched once at zero error, then slid sideways. */}
						<g
							transform={`translate(${(off * PPD).toFixed(2)} 0)`}
							opacity={overlayOp}
						>
							<SketchPolyline
								points={RIDGE_XY}
								seed="pj-overlay"
								data
								color="red"
								width={2.2}
								passes={1}
							/>
						</g>
						{loading && (
							<g>
								<Stipple
									d={BOX(0, 0, W, 150)}
									seed="pj-loading"
									color="pencil"
									spacing={9}
									opacity={0.45}
								/>
								<PenLine
									from={[220, 70]}
									to={[420, 70]}
									seed="pj-bar"
									color="faint"
									width={3}
								/>
								<PenLine
									from={[220, 70]}
									to={[220 + 200 * Math.max(0.02, clamp01(T / sc.loadEnd)), 70]}
									seed="pj-bar-fill"
									color="ink"
									width={3.4}
								/>
								<HandText x={320} y={94} anchor="middle" size={15}>
									{T < 1.6
										? "Loading terrain and photo"
										: "Aligning skyline to terrain"}
								</HandText>
							</g>
						)}
						{badge && (
							<g>
								<PenCircle
									center={[52, 24]}
									radiusX={badge === "verified" ? 40 : 37}
									radiusY={13}
									seed={`pj-badge-${badge}`}
									color={badge === "verified" ? "forest" : "blue"}
									width={1.6}
								/>
								<HandText
									x={52}
									y={29}
									anchor="middle"
									size={15}
									color={badge === "verified" ? "forest" : "blue"}
								>
									{badge === "verified" ? "Verified" : "Refined"}
								</HandText>
							</g>
						)}
						{banner && (
							<g>
								<Wash
									d={BOX(120, 12, 400, 38)}
									color={INKVAR.brown}
									seed="pw-wash-2"
									layers={5}
								/>
								<Hachure
									d={BOX(120, 12, 400, 38)}
									seed="pj-banner"
									color="brown"
									gap={5}
									angle={-45}
									opacity={0.45}
								/>
								<HandText x={132} y={30} size={15} color="ink">
									Unverified pose.
								</HandText>
								<HandNote x={132} y={45} size={FIG_NAME} color="var(--gb-ink)">
									The two solvers disagree. Drag, set the heading, or pin a
									peak.
								</HandNote>
							</g>
						)}
						<HandNote x={W - 10} y={140} anchor="end" size={FIG_LABEL}>
							{overlayOp > 0.05
								? `overlay yaw error ${off >= 0 ? "+" : "−"}${Math.abs(off).toFixed(2)}°`
								: "overlay held"}
						</HandNote>
					</g>

					{/* hand note: what this scenario shows, keyed to its last state */}
					{(() => {
						const lastA = sc.segs[sc.segs.length - 1].a;
						const left = lastA >= 4;
						const hx = left ? xT(lastA) - 10 : xT(lastA) + 16;
						const text =
							(
								{
									saved: "nothing re-solved: export opens at once",
									verified: "two solvers within 1°: agreed ✓",
									refined: "first guess +2.98° off, second check −0.02°",
									unverified: "weak skyline: ask the map match",
								} as Record<string, string>
							)[sc.id] ?? "";
						return (
							<g>
								<HandText
									x={hx}
									y={178}
									anchor={left ? "end" : "start"}
									size={15}
									color={sc.id === "refined" ? "red" : "ink"}
									rotate={-1.5}
								>
									{text}
								</HandText>
								<PenArrow
									seed={`pj-note-arrow-${sc.id}`}
									from={[xT(lastA) + (left ? 4 : 12), 184]}
									to={[xT(lastA) + 12, rows.pose - 3]}
									color={sc.id === "refined" ? "red" : "ink"}
									width={1.1}
									head={5}
								/>
							</g>
						);
					})()}

					{/* timeline */}
					<g>
						{[
							["pose", rows.pose, "pose"],
							["lock", rows.lock, "export"],
							["work", rows.work, "solvers"],
						].map(([k, y, l]) => (
							<HandNote
								key={k as string}
								x={0}
								y={(y as number) + 15}
								size={FIG_LABEL}
							>
								{l}
							</HandNote>
						))}
						{/* pose row */}
						<Wash
							d={BOX(xT(0), rows.pose, xT(sc.loadEnd) - xT(0), 20)}
							color={INKVAR.pencil}
							seed="pw-wash-3"
							layers={5}
						/>
						<Hachure
							d={BOX(xT(0), rows.pose, xT(sc.loadEnd) - xT(0), 20)}
							seed={`pj-${sc.id}-load`}
							color="pencil"
							gap={5}
							angle={-45}
							opacity={0.5}
						/>
						<HandNote
							x={xT(0) + 6}
							y={rows.pose + 15}
							size={FIG_LABEL}
							color="var(--gb-ink)"
						>
							loading
						</HandNote>
						{sc.segs.map((s) => (
							<g key={s.a}>
								<Wash
									d={BOX(
										xT(s.a),
										rows.pose,
										Math.max(0, xT(s.b) - xT(s.a) - 2),
										20,
									)}
									color={INKVAR[TONE[s.tone]]}
									seed={`pw-wash-seg-${sc.id}-${s.a}`}
									layers={5}
								/>
								<Hachure
									d={BOX(
										xT(s.a),
										rows.pose,
										Math.max(0, xT(s.b) - xT(s.a) - 2),
										20,
									)}
									seed={`pj-${sc.id}-seg-${s.a}`}
									color={TONE[s.tone]}
									gap={5}
									angle={-45}
									opacity={s.tone === "neutral" ? 0.45 : 0.6}
								/>
								<HandNote
									x={xT(s.a) + 6}
									y={rows.pose + 15}
									size={FIG_LABEL}
									color="var(--gb-ink)"
								>
									{s.label}
								</HandNote>
							</g>
						))}
						{/* export lock row */}
						<Wash
							d={BOX(xT(0), rows.lock, xT(sc.lockEnd) - xT(0), 20)}
							color={INKVAR.pencil}
							seed="pw-wash-5"
							layers={5}
						/>
						<Hachure
							d={BOX(xT(0), rows.lock, xT(sc.lockEnd) - xT(0), 20)}
							seed={`pj-${sc.id}-lock`}
							color="pencil"
							gap={5}
							angle={-45}
							opacity={0.5}
						/>
						<HandNote
							x={xT(0) + 6}
							y={rows.lock + 14}
							size={FIG_LABEL}
							color="var(--nb-ink)"
						>
							locked
						</HandNote>
						<Wash
							d={BOX(xT(sc.lockEnd), rows.lock, xT(LOOP) - xT(sc.lockEnd), 20)}
							color={INKVAR.forest}
							seed="pw-wash-6"
							layers={5}
						/>
						<Hachure
							d={BOX(xT(sc.lockEnd), rows.lock, xT(LOOP) - xT(sc.lockEnd), 20)}
							seed={`pj-${sc.id}-on`}
							color="forest"
							gap={5}
							angle={-45}
							opacity={0.6}
						/>
						<HandNote
							x={xT(sc.lockEnd) + 6}
							y={rows.lock + 15}
							size={FIG_LABEL}
							color="var(--gb-ink)"
						>
							export on
						</HandNote>
						{/* workers */}
						{sc.workers.map((w) => {
							const run = clamp01((T - w.a) / (w.b - w.a));
							const width = xT(w.b) - xT(w.a) - 2;
							return (
								<g key={w.a}>
									<Wash
										d={BOX(xT(w.a), rows.work, width, 20)}
										color={INKVAR.pencil}
										seed="pw-wash-7"
										layers={5}
									/>
									<Hachure
										d={BOX(xT(w.a), rows.work, width, 20)}
										seed={`pj-${sc.id}-w${w.a}`}
										color="pencil"
										gap={7}
										angle={-45}
										opacity={0.35}
									/>
									<clipPath id={`pj-run-${w.a}`}>
										<rect
											x={xT(w.a)}
											y={rows.work}
											width={Math.max(0, width * run)}
											height="20"
										/>
									</clipPath>
									<g clipPath={`url(#pj-run-${w.a})`}>
										<Wash
											d={BOX(xT(w.a), rows.work, width, 20)}
											color={INKVAR.ink}
											seed="pw-wash-8"
											layers={5}
										/>
										<Hachure
											d={BOX(xT(w.a), rows.work, width, 20)}
											seed={`pj-${sc.id}-wd${w.a}`}
											color="ink"
											gap={4}
											angle={-45}
											opacity={0.6}
										/>
									</g>
									<HandNote
										x={xT(w.a) + 6}
										y={rows.work + 15}
										size={FIG_LABEL}
										color="var(--gb-ink)"
									>
										{w.label}
									</HandNote>
								</g>
							);
						})}
						{sc.axisBreak && (
							<HandNote
								x={xT(6.5)}
								y={rows.work + 42}
								anchor="middle"
								size={FIG_LABEL}
							>
								~ not to scale: match takes 45–77 s ~
							</HandNote>
						)}
						{/* playhead: sketched once at x = 0, slid along the timeline */}
						<g transform={`translate(${px.toFixed(2)} 0)`}>
							<PenLine
								from={[0, rows.pose - 8]}
								to={[0, rows.work + 28]}
								seed="pj-playhead"
								color="ink"
								width={1.5}
							/>
							<HandDot
								x={0}
								y={rows.pose - 8}
								r={3.6}
								seed="pj-head"
								color="ink"
							/>
						</g>
						{!sc.axisBreak && (
							<HandNote x={xT(0)} y={rows.work + 42} size={FIG_LABEL}>
								schematic time →
							</HandNote>
						)}
					</g>
				</svg>
				<div className="mt-3">
					<HandRange
						value={T}
						min={0}
						max={LOOP}
						step={0.05}
						label="Scrub the timeline"
						onChange={setManual}
						readout={`${T.toFixed(1)} s`}
						manual={manual != null}
						onResume={() => {
							setClock0(t);
							setManual(null);
						}}
					/>
				</div>
				<p
					className="!mt-3 min-h-[3.6em] text-[13px] leading-relaxed gb-secondary"
					aria-live="polite"
				>
					{note.text}
				</p>
				<span className="sr-only">{seg ? `State ${seg.label}` : ""}</span>
			</div>
		</Figure>
	);
}

// ======================================================================================
// D3 — pins: how many degrees of freedom do N clicked peaks pin down?
// ======================================================================================
type P4 = { yaw: number; pitch: number; roll: number; vfov: number };
const SW = 640;
const SH = 300;
const TRUTH: P4 = { yaw: 0, pitch: 0, roll: 0, vfov: 30 };
const PRIOR: P4 = { yaw: 2.4, pitch: -0.9, roll: 1.6, vfov: 32.5 };
const KEYS: (keyof P4)[] = ["yaw", "pitch", "roll", "vfov"];

const elAt = (az: number) =>
	2.2 +
	4.2 * Math.exp(-(((az + 17) / 4.2) ** 2)) +
	7.4 * Math.exp(-(((az + 6) / 3.2) ** 2)) +
	6.1 * Math.exp(-(((az - 6.5) / 3.6) ** 2)) +
	3.6 * Math.exp(-(((az - 17.5) / 4.4) ** 2)) +
	0.35 * Math.sin(az * 1.3);
const PEAKS = [-17, -6, 6.5, 17.5].map((az) => ({ az, el: elAt(az) }));
const PEAK_NAMES = ["A", "B", "C", "D"];

function proj(az: number, el: number, p: P4): [number, number] {
	const s = SH / p.vfov;
	const dx = az - p.yaw;
	const dy = el - p.pitch;
	const r = p.roll * DEG;
	return [
		SW / 2 + s * (dx * Math.cos(r) - dy * Math.sin(r)),
		SH * 0.62 - s * (dx * Math.sin(r) + dy * Math.cos(r)),
	];
}

function solveLin(A: number[][], b: number[]) {
	const n = b.length;
	const M = A.map((r, i) => [...r, b[i]]);
	for (let i = 0; i < n; i++) {
		let p = i;
		for (let k = i + 1; k < n; k++)
			if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
		[M[i], M[p]] = [M[p], M[i]];
		const d = M[i][i] || 1e-12;
		for (let k = i + 1; k < n; k++) {
			const f = M[k][i] / d;
			for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j];
		}
	}
	const x = new Array(n).fill(0);
	for (let i = n - 1; i >= 0; i--) {
		let s = M[i][n];
		for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
		x[i] = s / (M[i][i] || 1e-12);
	}
	return x;
}

/** The solvePins rule on a small-angle pinhole: 1 pin -> yaw+pitch, 2 -> +roll, >= 3 -> +vfov. */
function solvePinsDemo(pinned: number[]): { pose: P4; free: (keyof P4)[] } {
	const n = pinned.length;
	if (!n) return { pose: PRIOR, free: [] };
	const free = KEYS.slice(0, n === 1 ? 2 : n === 2 ? 3 : 4);
	const targets = pinned.map((i) => proj(PEAKS[i].az, PEAKS[i].el, TRUTH));
	const p: P4 = { ...PRIOR };
	const resid = (q: P4) => {
		const out: number[] = [];
		pinned.forEach((pi, k) => {
			const [x, y] = proj(PEAKS[pi].az, PEAKS[pi].el, q);
			out.push(x - targets[k][0], y - targets[k][1]);
		});
		return out;
	};
	for (let it = 0; it < 12; it++) {
		const r0 = resid(p);
		const J = free.map((k) => {
			const q = { ...p, [k]: p[k] + 1e-4 };
			return resid(q).map((v, i) => (v - r0[i]) / 1e-4);
		});
		const A = free.map((_, i) =>
			free.map(
				(__, j) =>
					J[i].reduce((s, v, m) => s + v * J[j][m], 0) + (i === j ? 1e-6 : 0),
			),
		);
		const g = free.map((_, i) => -J[i].reduce((s, v, m) => s + v * r0[m], 0));
		const d = solveLin(A, g);
		free.forEach((k, i) => {
			p[k] += d[i];
		});
	}
	return { pose: p, free };
}

const SKY_AZ = Array.from({ length: 83 }, (_, i) => -33 + i * 0.8);
const skylinePath = (p: P4) =>
	`M${SKY_AZ.map((az) =>
		proj(az, elAt(az), p)
			.map((v) => v.toFixed(1))
			.join(" "),
	).join(" L")}`;
const skyPts = (p: P4): [number, number][] =>
	SKY_AZ.map((az) => proj(az, elAt(az), p));
const skyErr = (p: P4) => {
	let s = 0;
	let n = 0;
	for (const az of SKY_AZ) {
		const a = proj(az, elAt(az), p);
		const b = proj(az, elAt(az), TRUTH);
		if (a[0] < 0 || a[0] > SW) continue;
		s += Math.hypot(a[0] - b[0], a[1] - b[1]);
		n++;
	}
	return n ? s / n : 0;
};

function PinSolve() {
	const reduce = useReducedMotion();
	const [pinned, setPinned] = useState<number[]>([]);
	const target = solvePinsDemo(pinned);
	const [shown, setShown] = useState<P4>(PRIOR);
	const cur = useRef<P4>(PRIOR);

	// biome-ignore lint/correctness/useExhaustiveDependencies: tween to the new target only
	useEffect(() => {
		const from = { ...cur.current };
		const to = target.pose;
		if (reduce) {
			cur.current = to;
			setShown(to);
			return;
		}
		let raf = 0;
		const t0 = performance.now();
		const step = (now: number) => {
			const k = ease((now - t0) / 520);
			const q = { ...from };
			for (const key of KEYS) q[key] = from[key] + (to[key] - from[key]) * k;
			cur.current = q;
			setShown(q);
			if (k < 1) raf = requestAnimationFrame(step);
		};
		raf = requestAnimationFrame(step);
		return () => cancelAnimationFrame(raf);
	}, [pinned.join(), reduce]);

	const toggle = (i: number) =>
		setPinned((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]));
	const err = skyErr(shown);
	const truthSky = skylinePath(TRUTH);
	const truthPts = skyPts(TRUTH);
	const photoFill = `${truthSky} L${SW} ${SH} L0 ${SH} Z`;

	return (
		<Figure
			label="D3"
			bleed
			source="Skizze"
			caption="A simplified camera model. The photo's skyline is fixed; the overlay starts at the phone's guess (yaw +2.4°, pitch −0.9°, roll +1.6°, focal +8%). Click a ring to pin that peak. One pin frees yaw and pitch, two add roll, three or more add focal length."
		>
			<div className="-m-1 sm:-m-2">
				<div className="mb-3 flex flex-wrap items-center gap-2">
					{[0, 1, 2, 3, 4].map((n) => (
						<button
							key={n}
							type="button"
							onClick={() => setPinned([0, 1, 2, 3].slice(0, n))}
							aria-pressed={pinned.length === n}
							className={`px-2.5 py-1 font-mono text-[11px] ${pinned.length === n ? CHIP_ON : CHIP_OFF}`}
						>
							{n} pin{n === 1 ? "" : "s"}
						</button>
					))}
					<span className="font-mono text-[11px] gb-secondary">
						or click the rings
					</span>
				</div>
				<svg
					viewBox={`0 0 ${SW} ${SH}`}
					className="block h-auto w-full touch-pan-y"
					role="img"
					aria-label="Overlay horizon converging on the photo skyline as peaks are pinned"
				>
					<Wash
						d={photoFill}
						color="var(--nb-pencil)"
						seed="pw-wash-9"
						layers={5}
					/>
					<Hachure
						d={photoFill}
						seed="ps-ground"
						color="pencil"
						gap={7}
						angle={-45}
						opacity={0.4}
					/>
					<SketchPolyline
						points={truthPts}
						seed="ps-crest"
						data
						color="ink"
						width={1.4}
						passes={1}
					/>
					<SketchPolyline
						points={skyPts(shown)}
						seed="ps-overlay"
						data
						color="red"
						width={2.2}
						passes={1}
					/>
					{PEAKS.map((pk, i) => {
						const on = pinned.includes(i);
						const [tx, ty] = proj(pk.az, pk.el, TRUTH);
						const [ox, oy] = proj(pk.az, pk.el, shown);
						return (
							<g key={pk.az}>
								<PenLine
									from={[tx, ty]}
									to={[ox, oy]}
									seed={`ps-res-${i}`}
									data
									color={on ? "forest" : "pencil"}
									width={1.4}
									dash={on ? undefined : "3 3"}
								/>
								<HandDot
									x={ox}
									y={oy}
									r={3.4}
									seed={`ps-dot-${i}`}
									data
									color="red"
								/>
								{/* biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a button element */}
								<g
									tabIndex={0}
									role="button"
									aria-pressed={on}
									aria-label={`Peak ${PEAK_NAMES[i]}`}
									onClick={() => toggle(i)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											toggle(i);
										}
									}}
									className="cursor-pointer outline-none"
								>
									<circle cx={tx} cy={ty} r="20" fill="transparent" />
									<PenCircle
										center={[tx, ty]}
										radiusX={9}
										seed={`ps-ring-${i}`}
										color={on ? "forest" : "ink"}
										width={on ? 2 : 1.6}
									/>
									<HandNote
										x={tx}
										y={ty - 19}
										anchor="middle"
										size={FIG_NAME}
										color={inkColor(on ? "forest" : "navy")}
									>
										{PEAK_NAMES[i]}
									</HandNote>
								</g>
							</g>
						);
					})}
					<HandNote x={SW - 10} y={20} anchor="end" size={FIG_LABEL}>
						mean skyline error {err.toFixed(1)} px
					</HandNote>
					<HandText x={10} y={26} size={15} rotate={-1.5}>
						{
							[
								"no pins: compass only",
								"1 pin: yaw and pitch move",
								"2 pins: roll joins",
								"3 pins: focal length joins",
								"4 pins: all four solved",
							][pinned.length]
						}
					</HandText>
					<PenArrow
						seed="ps-note-arrow"
						from={[250, 22]}
						to={[
							proj(PEAKS[0].az, PEAKS[0].el, TRUTH)[0] - 14,
							proj(PEAKS[0].az, PEAKS[0].el, TRUTH)[1] - 30,
						]}
						color="ink"
						width={1.1}
						head={5}
					/>
				</svg>
				<div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
					{KEYS.map((k) => {
						const isFree = target.free.includes(k);
						const d = shown[k] - TRUTH[k];
						const unit = k === "vfov" ? "°" : "°";
						return (
							<div
								key={k}
								className="px-3 py-2 font-mono text-[11px]"
								style={{
									background: isFree ? "var(--nb-paper-deep)" : "transparent",
								}}
							>
								<div className="flex justify-between gap-2 gb-secondary">
									<span>{k === "vfov" ? "focal length" : k}</span>
									<span>{isFree ? "solved" : "from phone"}</span>
								</div>
								<div className="mt-0.5 text-[16px] text-[var(--gb-ink)]">
									{d >= 0 ? "+" : "−"}
									{Math.abs(d).toFixed(2)}
									{unit}
								</div>
							</div>
						);
					})}
				</div>
				<p className="!mt-2 font-mono text-[11px] gb-secondary">
					error vs the true pose
				</p>
			</div>
		</Figure>
	);
}

// ======================================================================================
// ======================================================================================
// Real screenshots and the measured result the workspace shows for demo-01
// ======================================================================================
const PARTS: {
	n: number;
	x: number;
	y: number;
	title: string;
	body: string;
}[] = [
	{
		n: 1,
		x: 1126,
		y: 548,
		title: "Peak label",
		body: "Name, height and distance from the camera (Stockhorn: 2,190 m, 18.2 km).",
	},
	{
		n: 2,
		x: 1105,
		y: 640,
		title: "Pin on the summit",
		body: "The stem ends where the summit lands in the photo.",
	},
	{
		n: 3,
		x: 1540,
		y: 655,
		title: "Far skyline",
		body: "The terrain horizon (warm line) hugs the real ridge: the proof.",
	},
	{
		n: 4,
		x: 870,
		y: 720,
		title: "Nearer ridge lines",
		body: "White lines trace nearer ridges.",
	},
	{
		n: 5,
		x: 1540,
		y: 1130,
		title: "Terrain contours",
		body: "Contour lines, tinted by distance, give the overlay depth.",
	},
];

function AnnotatedWorkspace() {
	return (
		<Figure
			label="D4"
			bleed
			caption="The exported overlay for one photo. One camera places every numbered part, so a wrong pose moves them all."
		>
			<svg
				viewBox="0 0 2048 1536"
				className="block h-auto w-full"
				role="img"
				aria-label="The photo workspace output for one photo with numbered annotations"
			>
				<image
					href="/demo/shots/demo-01-overlay.jpg"
					width={2048}
					height={1536}
				/>
				{PARTS.map((p) => (
					<Mark key={p.n} x={p.x} y={p.y} n={p.n} k={3.2} />
				))}
				<HandText
					x={PARTS[2].x - 560}
					y={PARTS[2].y - 210}
					size={52}
					color="#fff"
					rotate={-2}
				>
					the far horizon hugs the ridge
				</HandText>
				<PenArrow
					seed="aw-arrow-far"
					from={[PARTS[2].x - 150, PARTS[2].y - 190]}
					to={[PARTS[2].x - 40, PARTS[2].y - 40]}
					color="#fff"
					width={4}
					head={22}
				/>
				<HandText
					x={PARTS[0].x - 700}
					y={PARTS[0].y - 70}
					size={48}
					color="#fff"
					rotate={2}
				>
					Stockhorn: 2,190 m, 18.2 km
				</HandText>
				<PenArrow
					seed="aw-arrow-label"
					from={[PARTS[0].x - 180, PARTS[0].y - 70]}
					to={[PARTS[0].x - 40, PARTS[0].y - 20]}
					color="#fff"
					width={4}
					head={22}
				/>
			</svg>
			<MarkList
				items={PARTS.map((p) => (
					<>
						<strong className="gb-ink">{p.title}.</strong> {p.body}
					</>
				))}
			/>
		</Figure>
	);
}

function MeasuredWorkspace() {
	const [photo] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photo);
	return (
		<Figure
			label="D1"
			bleed
			caption={
				<>
					The same photo, three lines. Yellow: skyline detected in the photo.
					Magenta (dashed): terrain horizon at the phone's pose. Cyan: terrain
					horizon at the solved pose. Toggle them to see the compass error
					corrected.
				</>
			}
		>
			<RealPhoto
				bleed
				data={d}
				layers={["skyline", "prior", "solved"]}
				toggles={["skyline", "prior", "solved"]}
				crop={[0, 60, 800, 360]}
			/>
			{d && (
				<dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-3 font-mono text-[11px] gb-secondary sm:grid-cols-4">
					<div>
						<dt className="gb-secondary">compass error</dt>
						<dd className="text-[18px] sm:text-[20px] gb-ink">
							{d.solved.delta.yaw.toFixed(1)}°
						</dd>
					</div>
					<div>
						<dt className="gb-secondary">median skyline miss</dt>
						<dd className="text-[18px] sm:text-[20px] gb-ink">
							{d.residual.prior.median} → {d.residual.solved.median} px
						</dd>
					</div>
					<div>
						<dt className="gb-secondary">solve confidence</dt>
						<dd className="text-[18px] sm:text-[20px] gb-ink">
							{d.solved.confidence.toFixed(2)}
							<span className="gb-secondary">
								{" "}
								({d.solved.accepted ? "accepted" : "rejected"})
							</span>
						</dd>
					</div>
					<div>
						<dt className="gb-secondary">compute time: horizon / solve</dt>
						<dd className="text-[18px] sm:text-[20px] gb-ink">
							{(d.ms.horizon / 1000).toFixed(1)} s / {d.ms.solve} ms
						</dd>
					</div>
				</dl>
			)}
			{d?.app && (
				<p className="mt-3 text-[13px] gb-secondary">
					The live app saved yaw {d.app.yaw.toFixed(2)}° for this photo; this
					run gives {d.solved.yaw.toFixed(2)}°. The two differ by{" "}
					{Math.abs(((d.app.yaw - d.solved.yaw + 540) % 360) - 180).toFixed(2)}
					°,{" "}
					{Math.abs(((d.app.yaw - d.solved.yaw + 540) % 360) - 180) <= 1
						? "inside"
						: "outside"}{" "}
					the 1° that counts as verified.
				</p>
			)}
		</Figure>
	);
}

/** One label, two poses: the same peak pushed through the camera at the phone's yaw and at the solved yaw. */
function PeakProjection() {
	const [photo] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photo);
	const [pick, setPick] = useState("Niesen");
	if (!d)
		return (
			<div className="my-12 aspect-[16/10] w-full animate-pulse bg-[var(--nb-paper-deep)]" />
		);
	const choices = d.peaks
		.filter(
			(p) =>
				p.labelled &&
				p.solved &&
				p.prior &&
				p.prior[0] >= 0 &&
				p.prior[0] <= d.photo.width,
		)
		.sort((a, b) => (a.solved?.[0] ?? 0) - (b.solved?.[0] ?? 0));
	const known = ["Niesen", "Seehorn", "Niderhorn", "Stockhorn"].filter((n) =>
		choices.some((p) => p.name === n),
	);
	const names = known.length ? known : choices.slice(0, 4).map((p) => p.name);
	const peak = choices.find((p) => p.name === pick) ?? choices[0];
	if (!peak?.solved || !peak.prior) return null;
	const fPx = d.photo.height / 2 / Math.tan((d.solved.vfov * DEG) / 2);
	const dx = peak.prior[0] - peak.solved[0];
	const mid = (peak.prior[0] + peak.solved[0]) / 2;
	const cw = Math.min(800, Math.max(380, Math.abs(dx) + 240));
	const ch = cw * 0.55;
	const cx0 = Math.max(0, Math.min(800 - cw, mid - cw / 2));
	const cy0 = Math.max(
		0,
		Math.min(d.photo.height - ch, peak.solved[1] - ch * 0.45),
	);
	const crop: [number, number, number, number] = [cx0, cy0, cx0 + cw, cy0 + ch];
	return (
		<Figure
			label="Fig. 2"
			bleed
			caption={
				<>
					The same peak, drawn twice. Phone's yaw:{" "}
					<Key layer="prior">{d.prior.yaw.toFixed(1)}°</Key>, the label lands on
					the wrong ground. Solved yaw:{" "}
					<Key layer="solved">{d.solved.yaw.toFixed(1)}°</Key>, it sits on the
					summit.
				</>
			}
		>
			<div className="mb-3 flex flex-wrap gap-2">
				{names.map((n) => (
					<button
						key={n}
						type="button"
						onClick={() => setPick(n)}
						aria-pressed={n === peak.name}
						className="bg-[var(--nb-paper-deep)] px-3 py-1 font-mono text-[13px] aria-pressed:underline aria-pressed:decoration-[var(--nb-red)] aria-pressed:decoration-2 aria-pressed:underline-offset-4"
					>
						{n}
					</button>
				))}
			</div>
			<RealPhoto
				bleed
				data={d}
				layers={["skyline"]}
				crop={crop}
				// the picked summit's bearing at the solved pose
				spillCursor={{ x: peak.solved[0], label: peak.name, layer: "solved" }}
			>
				{() => {
					const [px, py] = peak.prior as [number, number];
					const [sx, sy] = peak.solved as [number, number];
					return (
						<g>
							<PenLine
								seed="pp-link-casing"
								data
								from={[px, py]}
								to={[sx, sy]}
								color="rgba(12, 14, 18, 0.85)"
								width={3.4}
								dash="4 3"
							/>
							<PenLine
								seed="pp-link"
								data
								from={[px, py]}
								to={[sx, sy]}
								color="#fff"
								width={1.5}
								dash="4 3"
							/>
							<PenCircle
								seed="pp-prior-casing"
								data
								center={[px, py]}
								radiusX={6}
								color="rgba(12, 14, 18, 0.85)"
								width={4.4}
							/>
							<PenCircle
								seed="pp-prior-ring"
								data
								center={[px, py]}
								radiusX={6}
								color={LAYER_STYLE.prior.color}
								width={2.2}
							/>
							<HandDot
								x={sx}
								y={sy}
								r={6.4}
								seed="pp-solved-halo"
								data
								color="#fff"
								opacity={1}
							/>
							<HandDot
								x={sx}
								y={sy}
								r={4.6}
								seed="pp-solved"
								data
								color={LAYER_STYLE.solved.color}
								opacity={1}
							/>
							<HandText
								x={Math.min(px, sx) - 8}
								y={Math.max(py, sy) + 26}
								anchor="end"
								size={16}
								color="#fff"
								rotate={-2}
							>
								{Math.abs(dx).toFixed(0)} px apart
							</HandText>
							<HandLabel
								x={sx + 10}
								y={sy - 12}
								size={18}
								color="#fff"
								haloColor="rgba(12, 14, 18, 0.85)"
								weight={600}
								mono={false}
							>
								{peak.name}
							</HandLabel>
						</g>
					);
				}}
			</RealPhoto>
			<p className="mt-3 font-mono text-[11px] leading-relaxed gb-secondary">
				{peak.name}: {(peak.distance / 1000).toFixed(1)} km away, azimuth{" "}
				{peak.az.toFixed(1)}°, {Math.abs(peak.el).toFixed(1)}° above the camera.
				One degree of yaw is about {((fPx * Math.PI) / 180).toFixed(0)} px here
				(focal length {fPx.toFixed(0)} px). Turning the camera{" "}
				{(d.solved.yaw - d.prior.yaw).toFixed(1)}° moves the label{" "}
				{Math.abs(dx).toFixed(0)} px.
			</p>
		</Figure>
	);
}

function HeroJourney() {
	const [photo] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photo);
	const crop: [number, number, number, number] = [0, 60, 800, 360];
	const agree = d?.app ? Math.abs(d.app.yaw - d.solved.yaw).toFixed(2) : "…";
	return (
		<Figure
			label="Fig. 1"
			bleed
			caption={<>One photo, four moments. The pose changes; export waits.</>}
		>
			<AlignmentStoryProvider initial={0}>
				<Stages
					aside={<StoryMap data={d} />}
					stages={[
						{
							label: "Phone's guess",
							pose: 0,
							caption: `If the first solve is weak, the workspace starts here. The terrain horizon misses by ${d?.residual.prior.median ?? "…"} px.`,
							render: () => (
								<RealPhoto
									bleed={0.1}
									data={d}
									layers={["skyline", "prior"]}
									crop={crop}
								/>
							),
						},
						{
							label: "Preview: solved pose",
							pose: 1,
							caption: `A solve replaces it. The miss falls to ${d?.residual.solved.median ?? "…"} px.`,
							render: () => (
								<RealPhoto
									bleed={0.1}
									data={d}
									layers={["skyline", "solved"]}
									crop={crop}
								/>
							),
						},
						{
							label: "Second check",
							pose: 1,
							caption: `A separate solve runs after the first paint. The two yaws agree within ${agree}°.`,
							render: () => (
								<RealPhoto
									bleed={0.1}
									data={d}
									layers={["solved", "peaks"]}
									crop={crop}
									maxLabels={8}
								/>
							),
						},
						{
							label: "Export unlocked",
							pose: 1,
							caption:
								"Only now can you save the picture. Your own edits always win.",
							render: () => (
								<RealPhoto
									bleed={0.1}
									data={d}
									layers={["peaks"]}
									crop={crop}
									maxLabels={12}
								/>
							),
						},
					]}
				/>
			</AlignmentStoryProvider>
		</Figure>
	);
}

function MiniLayers({
	layers,
}: {
	layers: ("skyline" | "prior" | "solved" | "peaks")[];
}) {
	const [photo] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photo);
	return (
		<RealPhoto
			data={d}
			layers={layers}
			crop={[0, 100, 800, 330]}
			maxLabels={5}
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
			<HeroJourney />

			<Beat kicker="The idea" title="Show a pose fast. Check it later.">
				<p>
					<HandMark type="highlight">It shows a preview at once,</HandMark> then
					a second solver checks it.
				</p>
				<p>
					Export stays locked until the pose is{" "}
					<HandMark type="underline">final</HandMark>. Only the last stage in{" "}
					<CircledNumber value={1} />, “Export unlocked”, waits.
					<MarginNote mark="a">
						I would wait 20 s for a pose I can trust.
					</MarginNote>
				</p>
			</Beat>

			<Beat
				kicker="What you see"
				title="Every label is a peak pushed through the camera."
			>
				<p>
					The terrain knows where each summit is. The solved pose says where the
					camera points.{" "}
					<HandMark type="circle">Together they give a pixel.</HandMark>
					<MarginNote mark="c">
						Same peak, two yaws: the label moves with the compass error.
					</MarginNote>
				</p>
			</Beat>

			<PeakProjection />

			<Eq
				label="Where a peak lands in the photo"
				where={[
					{
						sym: "d",
						text: "direction from the camera to the peak, from its azimuth and elevation",
					},
					{
						sym: <>r̂, f̂</>,
						text: "the camera's right and forward axes, turned by the yaw ψ",
					},
					{
						sym: <>ψ</>,
						c: "prior",
						text: "the phone's compass yaw puts the label at the magenta ring",
					},
					{
						sym: <>ψ</>,
						c: "solved",
						text: "the solved yaw puts it at the cyan dot",
					},
					{
						sym: (
							<>
								c<sub>x</sub>, f
							</>
						),
						text: "the photo's centre column and the focal length, in pixels",
					},
				]}
			>
				<Sym>x</Sym> ={" "}
				<Sym>
					c<sub>x</sub>
				</Sym>{" "}
				+ <Sym>f</Sym> ·{" "}
				<Frac
					n={
						<>
							d · r̂(<Sym>ψ</Sym>)
						</>
					}
					d={
						<>
							d · f̂(<Sym>ψ</Sym>)
						</>
					}
				/>
			</Eq>

			<Beat kicker="How it works" title="Preview, check, unlock.">
				<Trio
					steps={[
						{
							title: "Preview",
							body: "Show the first solve if confidence is above 0.2.",
							visual: <MiniLayers layers={["skyline", "solved"]} />,
						},
						{
							title: "Check",
							body: "A second solver runs in the background. If they differ by more than 1°, it replaces the preview.",
							visual: <MiniLayers layers={["skyline", "prior", "solved"]} />,
						},
						{
							title: "Unlock",
							body: "Export opens when the check ends, or after 20 s.",
							visual: <MiniLayers layers={["peaks"]} />,
						},
					]}
				/>
			</Beat>

			<LiveReveal
				photoId="demo-01"
				number="Fig. 3"
				title="The overlay, once the pose is final"
			/>

			<Beat
				kicker="Where it fails"
				title="The fast solve can be confidently wrong."
			>
				<p>
					One real photo fooled it: <HandMark type="strike">2.98° off</HandMark>
					<span className="nb-hand" style={{ color: "var(--gb-red)" }}>
						{" "}
						−0.02°
					</span>
					, at confidence 0.40. The second check put it within{" "}
					<HandMark type="double">0.02°</HandMark>.
					<MarginNote mark="b">
						Confident and wrong: 0.397 passed the 0.2 bar.
					</MarginNote>
				</p>
				<p>
					That disagreement is what the Refined badge shows. Your own drag or
					pin always overrides both.
				</p>
			</Beat>

			<Numbers
				items={[
					{ value: "2.98°", label: "fast solve error on one photo" },
					{ value: "0.02°", label: "same photo after the second check" },
					{
						value: "11 / 12",
						label: "photos accepted correctly by the second solver",
					},
					{ value: "0", label: "false accepts, of 12" },
				]}
				source="Checked against 12 hand-registered photos."
			/>

			<Details>
				<MeasuredWorkspace />

				<PoseJourney />

				<Section
					kicker="How it works"
					title="From first paint to a trusted pose"
				>
					<Steps
						steps={[
							{
								title: "Pick the source",
								body: "In order: a pose you set, a saved or sample pose, then, if compass, gravity or lens is missing, a full search, otherwise a fast auto-align. A pose you chose is never replaced by a solver.",
							},
							{
								title: "Preview fast",
								body: "Show the auto-align result if confidence is above 0.2. Otherwise show a match within 4° yaw and 1.5° pitch of the compass, or the phone’s own pose. The page paints without waiting for the slow check.",
							},
							{
								title: "A second check, after first paint",
								body: "A second solver re-solves from the phone’s guess in the background (20 s limit). The result is one of: verified (agrees within 1°), refined (replaces the preview), kept, unverified, or matched (map match, used only if it passes the accept rule).",
							},
							{
								title: "Lock export until the pose is final",
								body: "Export is locked while loading or while the check is pending, so a file never contains a pose that is about to move.",
							},
						]}
					/>
					<p>
						The solvers are explained in{" "}
						{A("viewport-inference", "Viewport Inference")} and{" "}
						{A("terrain-snapping", "Terrain Snapping")}.
					</p>
				</Section>

				<Section kicker="Your hand" title="You always have the last word">
					<p>
						Drag to turn the camera: sideways changes yaw, up and down changes
						pitch, Shift-drag rolls, the wheel zooms. Your first edit saves the
						pose and cancels any pending check, so a late result cannot move
						what you set.
					</p>
					<p>
						Pins are the precise version: pick a peak, click where it is in the
						photo, and the solver fits only as many parameters as the pins
						support. See {A("tap-a-peak", "Tap a Peak")} for the picker.
					</p>
				</Section>

				<PinSolve />

				<AnnotatedWorkspace />

				<Section kicker="Result" title="Why the second check is worth the wait">
					<div className="!mt-5 grid grid-cols-2 gap-5 sm:grid-cols-4">
						<Stat value="> 0.2" label="confidence needed for a preview" />
						<Stat value="≤ 1°" label="agreement needed for “verified”" />
						<Stat value="20 s" label="longest export wait" />
						<Stat value="0" label="false accepts on 12 test photos" />
					</div>
					<Callout tone="lesson" title="Fast to show, slow to check">
						Show the preview at once, check it later: a quick first paint, and
						no unchecked pose reaches an export.
					</Callout>
				</Section>

				<Section kicker="In the code" title="Where to look">
					<div className="flex flex-wrap gap-2">
						<CodeRef path="src/components/PhotoWorkspace.tsx" />
						<CodeRef path="src/routes/photo.$id.tsx" />
						<CodeRef path="src/lib/integration/second-opinion.ts" />
						<CodeRef path="src/lib/integration/unknown-pose.ts" />
						<CodeRef path="src/lib/ontology/crosswalk/pose.ts" />
						<CodeRef path="src/lib/align.ts" />
						<CodeRef path="src/components/EyeSuggestion.tsx" />
						<CodeRef path="src/components/controls.tsx" />
						<CodeRef path="reports/leaderboard.md" />
					</div>
				</Section>

				<Section kicker="Where it fits" title="Related">
					<p>
						The workspace shows the pose that{" "}
						{A("viewport-inference", "viewport inference")} produces and the
						corrections of {A("terrain-snapping", "terrain snapping")}, gated by
						the {A("accept-rule", "accept rule")} and seeded from the{" "}
						{A("camera-prior", "camera prior")}. Pins come from{" "}
						{A("tap-a-peak", "Tap a Peak")}, and the same pose can be taken into{" "}
						{A("step-inside", "Step Inside")}.
					</p>
				</Section>
			</Details>
		</>
	);
}
