// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
	Callout,
	CodeRef,
	Figure,
	Measured,
	RealPhoto,
	Section,
	Stat,
	Steps,
	useAtlasPhoto,
	useReducedMotion,
	useTime,
} from "#/components/atlas/viz";
import {
	Beat,
	Details,
	Mark,
	MarkList,
	Numbers,
	Stages,
	Trio,
} from "#/components/atlas/viz/explain";
import type { AtlasNode } from "#/lib/atlas/types";

// Photo Workspace: the cockpit decides WHICH pose to trust and when to let you export it.
// Mechanism numbers are literal from the code:
//   choosePreview: autoAlign accepted at confidence > 0.2, else near-compass window yaw 4 / pitch 1.5 deg, else prior
//   AGREE_DEG 1 deg, CASCADE_TIMEOUT_MS 20 000, matcher request timeout 150 000 (src/lib/integration/second-opinion.ts)
//   drag: yaw -= dx/w * hfov, pitch += dy/h * vfov, shift-drag roll += dx * 0.05, align-tool wheel vfov *= 1 + dy * 0.0006 (5..100)
//   solvePins (src/lib/align.ts): 1 pin -> yaw+pitch, 2 pins -> +roll, >= 3 pins -> +vfov
// Accuracy numbers: reports/leaderboard.md (12 hand-registered GT photos). Timelines in Fig. 1 are schematic in
// time; the IMG_7130 offsets (+2.98 deg, 4.017 deg prior, -0.02 deg cascade) are the real ones.

const DEG = Math.PI / 180;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (k: number) => {
	const x = clamp01(k);
	return x * x * (3 - 2 * x);
};

const C = {
	ok: "#6ee7b7",
	warn: "#fbbf24",
	bad: "#fb7185",
	mute: "rgba(236,230,218,0.5)",
	paper: "var(--rigi-paper)",
};

// ======================================================================================
// Fig. 1 — a pose's journey: source -> preview -> second opinion -> export unlocked
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
		label: "Saved alignment",
		sub: "loadSavedPose ?? bundledPose",
		loadEnd: 1.6,
		segs: [{ a: 1.6, b: LOOP, label: "saved", off: 0, tone: "ok" }],
		lockEnd: 1.6,
		workers: [],
		notes: [
			{
				at: 0,
				text: "The engine loads terrain and photo; the overlay is held for the reveal.",
			},
			{
				at: 1.6,
				text: "A saved (or bundled sample) pose goes in with setPose(p, false), state saved. Nothing is re-solved and no second opinion runs, so exports unlock the moment loading ends.",
			},
		],
	},
	{
		id: "verified",
		label: "Full metadata, agreed",
		sub: "autoAlign + cascade, |Δyaw| ≤ 1°",
		loadEnd: 2.4,
		segs: [
			{ a: 2.4, b: 6, label: "auto", off: 0.3, tone: "neutral" },
			{ a: 6, b: LOOP, label: "auto · verified", off: 0.3, tone: "ok" },
		],
		lockEnd: 6,
		workers: [{ a: 2.6, b: 6, label: "skyline cascade in a worker" }],
		badge: { at: 6, kind: "verified" },
		notes: [
			{
				at: 0,
				text: "Compass, gravity and lens are all present: engine.autoAlign solves the pose during load.",
			},
			{
				at: 2.4,
				text: "choosePreview shows it at confidence > 0.2 (state auto) and the page paints. A second, independent solver, the CPU cascade, starts in a worker. Exports stay locked while the verdict is pending.",
			},
			{
				at: 6,
				text: "Both accepted and |Δyaw| ≤ AGREE_DEG = 1°: keep the app pose, show the Verified badge, unlock exports.",
			},
		],
	},
	{
		id: "refined",
		label: "Cascade overrules",
		sub: "IMG_7130: +2.98° → −0.02°",
		loadEnd: 2.4,
		segs: [
			{ a: 2.4, b: 6, label: "auto", off: 2.98, tone: "neutral" },
			{ a: 6, b: LOOP, label: "accepted · refined", off: -0.02, tone: "ok" },
		],
		lockEnd: 6,
		workers: [{ a: 2.6, b: 6, label: "skyline cascade in a worker" }],
		badge: { at: 6, kind: "refined" },
		notes: [
			{
				at: 2.4,
				text: "The GPU aligner accepted IMG_7130 at confidence 0.397 and was 2.98° off. That passes the 0.2 preview bar, so it is what you first see (reports/leaderboard.md).",
			},
			{
				at: 6,
				text: "The cascade accepts at −0.02° and disagrees by 3.0° > 1°: its pose replaces the preview, state accepted, badge Refined. The cascade made no false accept on the 12-photo set.",
			},
		],
	},
	{
		id: "unverified",
		label: "Weak skyline, escalated",
		sub: "prior → unverified → render-and-match",
		loadEnd: 2.4,
		segs: [
			{ a: 2.4, b: 5, label: "prior", off: 4.0, tone: "neutral" },
			{ a: 5, b: 8, label: "unverified", off: 4.0, tone: "warn" },
			{ a: 8, b: LOOP, label: "accepted · matched", off: 0, tone: "ok" },
		],
		lockEnd: 8,
		workers: [
			{ a: 2.6, b: 5, label: "cascade" },
			{ a: 5, b: 8, label: "match service" },
		],
		badge: { at: 8, kind: "matched" },
		banner: { a: 5, b: 8 },
		axisBreak: true,
		notes: [
			{
				at: 2.4,
				text: "Skyline match was weak (confidence ≤ 0.2, no near-compass alternative): the compass + gravity prior is shown, flagged as a candidate.",
			},
			{
				at: 5,
				text: "The cascade rejects and shouldEscalate() is true. State becomes unverified, the amber banner appears, labels soften, and the render-and-match service is asked.",
			},
			{
				at: 8,
				text: "Taken only if matchAccepted() passes the product rule (the match request has a 150 s timeout; the code notes 45–77 s when idle, so this step is not to time). If the service is busy the page unlocks exports at once and upgrades later.",
			},
		],
	},
];

const TONE: Record<Seg["tone"], string> = {
	ok: C.ok,
	warn: C.warn,
	neutral: "rgba(236,230,218,0.55)",
	user: "#7dd3fc",
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

function offsetAt(sc: Scenario, T: number) {
	let cur = 0;
	for (let i = 0; i < sc.segs.length; i++) if (T >= sc.segs[i].a) cur = i;
	const s = sc.segs[cur];
	const prev = cur > 0 ? sc.segs[cur - 1].off : s.off;
	return prev + (s.off - prev) * ease((T - s.a) / 0.7);
}

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
	const photo = RIDGE_PTS.map((x) => `${x} ${ridge(x).toFixed(1)}`);
	const photoPath = `M0 150 L${photo.join(" L")} L${W} 150 Z`;
	const overlayPath = `M${RIDGE_PTS.map((x) => `${(x + off * PPD).toFixed(1)} ${ridge(x).toFixed(1)}`).join(" L")}`;
	const px = xT(Math.min(T, LOOP));
	const rows = { pose: 196, lock: 236, work: 276 };

	return (
		<Figure
			label="Schematic 1"
			bleed
			caption="Schematic: one photo's pose from page load to export. Pick a scenario; it replays, or scrub the timeline. Segment lengths are schematic; the IMG_7130 offsets are measured (reports/leaderboard.md). Every state and verdict is a real value in src/lib/integration/second-opinion.ts."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<div className="mb-3 flex flex-wrap gap-2">
					{SCENARIOS.map((s, i) => (
						<button
							key={s.id}
							type="button"
							onClick={() => pick(i)}
							aria-pressed={i === sel}
							className="rounded-lg px-3 py-1.5 text-left font-mono text-[11px] leading-tight ring-1 transition"
							style={{
								background:
									i === sel
										? "color-mix(in oklab, var(--accent) 16%, transparent)"
										: "rgba(255,255,255,0.03)",
								color:
									i === sel ? "var(--rigi-paper)" : "rgba(236,230,218,0.6)",
								boxShadow: `inset 0 0 0 1px ${i === sel ? "var(--accent)" : "rgba(255,255,255,0.1)"}`,
							}}
						>
							<span className="block text-[12px] font-semibold">{s.label}</span>
							<span className="block opacity-60">{s.sub}</span>
						</button>
					))}
				</div>
				<svg
					viewBox={`0 0 ${W} 308`}
					className="block h-auto w-full rounded-xl"
					role="img"
					aria-label="Timeline of a photo's pose source, second opinion and export lock"
				>
					<defs>
						<linearGradient id="pw-sky" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0" stopColor="#1b2a3a" />
							<stop offset="1" stopColor="#4a5a66" />
						</linearGradient>
						<pattern
							id="pw-hatch"
							width="6"
							height="6"
							patternUnits="userSpaceOnUse"
							patternTransform="rotate(45)"
						>
							<line
								x1="0"
								y1="0"
								x2="0"
								y2="6"
								stroke="rgba(236,230,218,0.25)"
								strokeWidth="2"
							/>
						</pattern>
						<clipPath id="pw-clip">
							<rect width={W} height="150" rx="10" />
						</clipPath>
					</defs>
					<g clipPath="url(#pw-clip)">
						<rect width={W} height="150" fill="url(#pw-sky)" />
						<path d={photoPath} fill="#2b343b" />
						<path
							d={`M${photo.join(" L")}`}
							fill="none"
							stroke="rgba(236,230,218,0.5)"
							strokeWidth="1.2"
						/>
						{/* the overlay: DEM horizon under the shown pose */}
						<path
							d={overlayPath}
							fill="none"
							stroke="var(--accent)"
							strokeWidth="5"
							strokeOpacity={0.3 * overlayOp}
						/>
						<path
							d={overlayPath}
							fill="none"
							stroke="var(--accent)"
							strokeWidth="1.8"
							strokeOpacity={overlayOp}
						/>
						{loading && (
							<g>
								<rect width={W} height="150" fill="rgba(8,10,12,0.55)" />
								<rect
									x="220"
									y="68"
									width="200"
									height="4"
									rx="2"
									fill="rgba(255,255,255,0.15)"
								/>
								<rect
									x="220"
									y="68"
									width={200 * clamp01(T / sc.loadEnd)}
									height="4"
									rx="2"
									fill="var(--accent)"
								/>
								<text
									x="320"
									y="92"
									textAnchor="middle"
									fontSize="11"
									className="font-mono"
									fill="rgba(236,230,218,0.7)"
								>
									{T < 1.6
										? "engine.init: terrain + photo"
										: "Aligning skyline to terrain"}
								</text>
							</g>
						)}
						{badge && (
							<g>
								<rect
									x="12"
									y="12"
									width={badge === "verified" ? 76 : 70}
									height="20"
									rx="10"
									fill={
										badge === "verified"
											? "rgba(16,185,129,0.25)"
											: "rgba(6,182,212,0.25)"
									}
									stroke={
										badge === "verified"
											? "rgba(110,231,183,0.4)"
											: "rgba(103,232,249,0.4)"
									}
								/>
								<text
									x="24"
									y="26"
									fontSize="11"
									fontWeight="600"
									fill={badge === "verified" ? "#a7f3d0" : "#cffafe"}
									className="font-mono"
								>
									{badge === "verified" ? "Verified" : "Refined"}
								</text>
							</g>
						)}
						{banner && (
							<g>
								<rect
									x="120"
									y="12"
									width="400"
									height="38"
									rx="8"
									fill="rgba(245,158,11,0.92)"
								/>
								<text
									x="132"
									y="28"
									fontSize="11"
									fontWeight="700"
									fill="#0f172a"
								>
									Unverified alignment.
								</text>
								<text x="132" y="42" fontSize="10" fill="#0f172a">
									The skyline solvers disagree: drag, use Heading, or pin a
									peak.
								</text>
							</g>
						)}
						<text
							x={W - 10}
							y="140"
							textAnchor="end"
							fontSize="10"
							className="font-mono"
							fill="rgba(236,230,218,0.6)"
						>
							{overlayOp > 0.05
								? `overlay yaw error ${off >= 0 ? "+" : "−"}${Math.abs(off).toFixed(2)}°`
								: "overlay held"}
						</text>
					</g>

					{/* timeline */}
					<g className="font-mono" fontSize="10">
						{[
							["pose", rows.pose, "pose state"],
							["lock", rows.lock, "exports"],
							["work", rows.work, "solvers"],
						].map(([k, y, l]) => (
							<text
								key={k as string}
								x="0"
								y={(y as number) + 14}
								fill="rgba(236,230,218,0.55)"
							>
								{l}
							</text>
						))}
						{/* pose row */}
						<rect
							x={xT(0)}
							y={rows.pose}
							width={xT(sc.loadEnd) - xT(0)}
							height="20"
							rx="4"
							fill="url(#pw-hatch)"
						/>
						<text x={xT(0) + 6} y={rows.pose + 14} fill="rgba(236,230,218,0.7)">
							loading
						</text>
						{sc.segs.map((s) => (
							<g key={s.a}>
								<rect
									x={xT(s.a)}
									y={rows.pose}
									width={Math.max(0, xT(s.b) - xT(s.a) - 2)}
									height="20"
									rx="4"
									fill={TONE[s.tone]}
									fillOpacity={s.tone === "neutral" ? 0.22 : 0.28}
									stroke={TONE[s.tone]}
									strokeOpacity="0.8"
								/>
								<text x={xT(s.a) + 6} y={rows.pose + 14} fill={C.paper}>
									{s.label}
								</text>
							</g>
						))}
						{/* export lock row */}
						<rect
							x={xT(0)}
							y={rows.lock}
							width={xT(sc.lockEnd) - xT(0)}
							height="20"
							rx="4"
							fill="rgba(251,113,133,0.16)"
							stroke="rgba(251,113,133,0.6)"
						/>
						<text x={xT(0) + 6} y={rows.lock + 14} fill="#fda4af">
							locked: !!status || verify === "pending"
						</text>
						<rect
							x={xT(sc.lockEnd)}
							y={rows.lock}
							width={xT(LOOP) - xT(sc.lockEnd)}
							height="20"
							rx="4"
							fill="color-mix(in oklab, var(--accent) 18%, transparent)"
							stroke="var(--accent)"
							strokeOpacity="0.8"
						/>
						<text x={xT(sc.lockEnd) + 6} y={rows.lock + 14} fill={C.paper}>
							export on
						</text>
						{/* workers */}
						{sc.workers.map((w) => {
							const run = clamp01((T - w.a) / (w.b - w.a));
							return (
								<g key={w.a}>
									<rect
										x={xT(w.a)}
										y={rows.work}
										width={xT(w.b) - xT(w.a) - 2}
										height="20"
										rx="4"
										fill="rgba(255,255,255,0.05)"
										stroke="rgba(236,230,218,0.3)"
									/>
									<rect
										x={xT(w.a)}
										y={rows.work}
										width={(xT(w.b) - xT(w.a) - 2) * run}
										height="20"
										rx="4"
										fill="url(#pw-hatch)"
									/>
									<text x={xT(w.a) + 6} y={rows.work + 14} fill={C.paper}>
										{w.label}
									</text>
								</g>
							);
						})}
						{sc.axisBreak && (
							<text
								x={xT(6.5)}
								y={rows.work + 38}
								fill="rgba(236,230,218,0.5)"
								textAnchor="middle"
							>
								~ not to scale: match ≈ 45–77 s when idle ~
							</text>
						)}
						{/* playhead */}
						<line
							x1={px}
							x2={px}
							y1={rows.pose - 8}
							y2={rows.work + 28}
							stroke="var(--accent)"
							strokeWidth="1.5"
						/>
						<circle cx={px} cy={rows.pose - 8} r="3.5" fill="var(--accent)" />
						{!sc.axisBreak && (
							<text x={xT(0)} y={rows.work + 38} fill="rgba(236,230,218,0.4)">
								schematic time →
							</text>
						)}
					</g>
				</svg>
				<div className="mt-3 flex items-center gap-3">
					<input
						type="range"
						min={0}
						max={LOOP}
						step={0.05}
						value={T}
						onChange={(e) => setManual(Number(e.target.value))}
						aria-label="Scrub the timeline"
						className="h-1 flex-1 accent-[var(--accent)]"
					/>
					<button
						type="button"
						onClick={() => {
							setClock0(t);
							setManual(null);
						}}
						className="rounded-md bg-white/[0.06] px-2.5 py-1 font-mono text-[11px] text-white/70 ring-1 ring-white/10"
					>
						{manual == null && !reduce ? "playing" : "play"}
					</button>
				</div>
				<p
					className="!mt-3 min-h-[3.6em] text-[13.5px] leading-relaxed text-white/75"
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
// Fig. 2 — pins: how many degrees of freedom do N clicked peaks pin down?
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
	const photoFill = `${truthSky} L${SW} ${SH} L0 ${SH} Z`;

	return (
		<Figure
			label="Schematic 2"
			bleed
			caption="Schematic: pin solver on a small-angle pinhole model (the app's solvePins in src/lib/align.ts uses the full projection). The photo's skyline is fixed; the overlay starts at the sensor prior (yaw +2.4°, pitch −0.9°, roll +1.6°, focal +8%). Click a ring to pin that peak: what it frees follows the real rule, 1 pin yaw and pitch, 2 add roll, 3 or more add focal."
		>
			<div className="-m-1 sm:-m-2">
				<div className="mb-3 flex flex-wrap items-center gap-2">
					{[0, 1, 2, 3, 4].map((n) => (
						<button
							key={n}
							type="button"
							onClick={() => setPinned([0, 1, 2, 3].slice(0, n))}
							aria-pressed={pinned.length === n}
							className="rounded-md px-2.5 py-1 font-mono text-[11px] ring-1"
							style={{
								background:
									pinned.length === n
										? "color-mix(in oklab, var(--accent) 18%, transparent)"
										: "rgba(255,255,255,0.03)",
								boxShadow: `inset 0 0 0 1px ${pinned.length === n ? "var(--accent)" : "rgba(255,255,255,0.1)"}`,
								color:
									pinned.length === n
										? "var(--rigi-paper)"
										: "rgba(236,230,218,0.6)",
							}}
						>
							{n} pin{n === 1 ? "" : "s"}
						</button>
					))}
					<span className="font-mono text-[11px] text-white/45">
						or click the rings
					</span>
				</div>
				<svg
					viewBox={`0 0 ${SW} ${SH}`}
					className="block h-auto w-full touch-pan-y rounded-xl"
					role="img"
					aria-label="Overlay horizon converging on the photo skyline as peaks are pinned"
				>
					<defs>
						<linearGradient id="pw2-sky" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0" stopColor="#1b2a3a" />
							<stop offset="1" stopColor="#566672" />
						</linearGradient>
					</defs>
					<rect width={SW} height={SH} fill="url(#pw2-sky)" />
					<path d={photoFill} fill="#2a333a" />
					<path
						d={truthSky}
						fill="none"
						stroke="rgba(236,230,218,0.55)"
						strokeWidth="1.3"
					/>
					<path
						d={skylinePath(shown)}
						fill="none"
						stroke="var(--accent)"
						strokeWidth="5"
						strokeOpacity="0.28"
					/>
					<path
						d={skylinePath(shown)}
						fill="none"
						stroke="var(--accent)"
						strokeWidth="1.8"
					/>
					{PEAKS.map((pk, i) => {
						const on = pinned.includes(i);
						const [tx, ty] = proj(pk.az, pk.el, TRUTH);
						const [ox, oy] = proj(pk.az, pk.el, shown);
						return (
							<g key={pk.az}>
								<line
									x1={tx}
									y1={ty}
									x2={ox}
									y2={oy}
									stroke={on ? C.ok : "var(--rigi-trap)"}
									strokeOpacity={on ? 0.9 : 0.55}
									strokeWidth="1.4"
									strokeDasharray={on ? "0" : "3 3"}
								/>
								<circle cx={ox} cy={oy} r="3.4" fill="var(--accent)" />
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
									<circle
										cx={tx}
										cy={ty}
										r="9"
										fill={on ? "rgba(110,231,183,0.25)" : "rgba(0,0,0,0.25)"}
										stroke={on ? C.ok : C.paper}
										strokeWidth="1.8"
									/>
									<text
										x={tx}
										y={ty - 16}
										textAnchor="middle"
										fontSize="11"
										fontWeight="600"
										fill={C.paper}
										className="font-mono"
									>
										{PEAK_NAMES[i]}
									</text>
								</g>
							</g>
						);
					})}
					<text
						x={SW - 10}
						y="20"
						textAnchor="end"
						fontSize="11"
						className="font-mono"
						fill="rgba(236,230,218,0.75)"
					>
						mean skyline error {err.toFixed(1)} px
					</text>
				</svg>
				<div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
					{KEYS.map((k) => {
						const isFree = target.free.includes(k);
						const d = shown[k] - TRUTH[k];
						const unit = k === "vfov" ? "°" : "°";
						return (
							<div
								key={k}
								className="rounded-lg px-3 py-2 font-mono text-[11px] ring-1"
								style={{
									background: isFree
										? "color-mix(in oklab, var(--accent) 12%, transparent)"
										: "rgba(255,255,255,0.03)",
									boxShadow: `inset 0 0 0 1px ${isFree ? "var(--accent)" : "rgba(255,255,255,0.1)"}`,
								}}
							>
								<div className="flex justify-between text-white/60">
									<span>{k === "vfov" ? "focal (vfov)" : k}</span>
									<span>{isFree ? "solved" : "from prior"}</span>
								</div>
								<div className="mt-0.5 text-[15px] text-[var(--rigi-paper)]">
									{d >= 0 ? "+" : "−"}
									{Math.abs(d).toFixed(2)}
									{unit}
								</div>
							</div>
						);
					})}
				</div>
				<p className="!mt-2 font-mono text-[10.5px] text-white/40">
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
		body: "Name, height and distance from the eye (Stockhorn: 2,190 m, 18.2 km).",
	},
	{
		n: 2,
		x: 1105,
		y: 640,
		title: "Pin on the summit",
		body: "The stem ends where the map summit lands in the photo.",
	},
	{
		n: 3,
		x: 1540,
		y: 655,
		title: "Far skyline",
		body: "The map skyline (warm line) hugs the real ridge. That is the proof.",
	},
	{
		n: 4,
		x: 870,
		y: 720,
		title: "Nearer ridge lines",
		body: "White lines trace nearer ridges, so you can tell which is which.",
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
			label="Fig. 2"
			bleed
			caption="The app's exported overlay on demo-01. One camera places every numbered part, so a wrong pose moves them all together."
		>
			<svg
				viewBox="0 0 2048 1536"
				className="block h-auto w-full rounded-xl"
				role="img"
				aria-label="The photo workspace output on demo-01 with numbered annotations"
			>
				<image
					href="/demo/shots/demo-01-overlay.jpg"
					width={2048}
					height={1536}
				/>
				{PARTS.map((p) => (
					<Mark key={p.n} x={p.x} y={p.y} n={p.n} k={2.56} />
				))}
			</svg>
			<MarkList
				items={PARTS.map((p) => (
					<>
						<strong className="text-white/90">{p.title}.</strong> {p.body}
					</>
				))}
			/>
		</Figure>
	);
}

function MeasuredWorkspace() {
	const d = useAtlasPhoto("demo-01");
	return (
		<Figure
			label="Toggle"
			bleed
			caption={
				<>
					What the cockpit has to decide between, on the same photo. Yellow is
					the skyline detected in the pixels, magenta (dashed) the DEM skyline
					at the phone's sensor pose, cyan the DEM skyline at the pose the
					pipeline solved. Toggle them to see the compass error being corrected.{" "}
					<Measured data={d} />
				</>
			}
		>
			<RealPhoto
				data={d}
				layers={["skyline", "prior", "solved"]}
				toggles={["skyline", "prior", "solved"]}
				crop={[0, 60, 800, 360]}
			/>
			{d && (
				<dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-3 font-mono text-[11px] text-white/55 sm:grid-cols-4">
					<div>
						<dt className="text-white/40">sensor compass error</dt>
						<dd className="text-lg text-white/90">
							{d.solved.delta.yaw.toFixed(1)}°
						</dd>
					</div>
					<div>
						<dt className="text-white/40">skyline miss, median</dt>
						<dd className="text-lg text-white/90">
							{d.residual.prior.median} → {d.residual.solved.median} px
						</dd>
					</div>
					<div>
						<dt className="text-white/40">solve confidence</dt>
						<dd className="text-lg text-white/90">
							{d.solved.confidence.toFixed(2)}
							<span className="text-white/40">
								{" "}
								({d.solved.accepted ? "accepted" : "rejected"})
							</span>
						</dd>
					</div>
					<div>
						<dt className="text-white/40">CPU time: horizon / solve</dt>
						<dd className="text-lg text-white/90">
							{(d.ms.horizon / 1000).toFixed(1)} s / {d.ms.solve} ms
						</dd>
					</div>
				</dl>
			)}
			{d?.app && (
				<p className="mt-3 text-[12.5px] text-white/50">
					The pose the live app saved for this photo ({d.app.source}, confidence{" "}
					{d.app.confidence.toFixed(2)}) is yaw {d.app.yaw.toFixed(2)}° against{" "}
					{d.solved.yaw.toFixed(2)}° here: the two solvers agree to{" "}
					{Math.abs(d.app.yaw - d.solved.yaw).toFixed(2)}°, well inside the 1°
					AGREE_DEG that makes a second opinion “verified”. Note that this
					script's labels are the baseline layoutPeakLabels; the workspace draws
					its own, richer label set (figure above).
				</p>
			)}
		</Figure>
	);
}

function HeroJourney() {
	const d = useAtlasPhoto("demo-01");
	const crop: [number, number, number, number] = [0, 60, 800, 360];
	const agree = d?.app ? Math.abs(d.app.yaw - d.solved.yaw).toFixed(2) : "…";
	return (
		<Figure
			label="Fig. 1"
			bleed
			caption={
				<>
					One photo, four moments: the pose you see changes, the export waits.{" "}
					<Measured data={d} />
				</>
			}
		>
			<Stages
				stages={[
					{
						label: "Opens on the phone's guess",
						caption: `The map skyline misses the photo by ${d?.residual.prior.median ?? "…"} px.`,
						render: () => (
							<RealPhoto data={d} layers={["skyline", "prior"]} crop={crop} />
						),
					},
					{
						label: "Preview: solved pose",
						caption: `A solve replaces it. The miss falls to ${d?.residual.solved.median ?? "…"} px.`,
						render: () => (
							<RealPhoto data={d} layers={["skyline", "solved"]} crop={crop} />
						),
					},
					{
						label: "Second opinion",
						caption: `A separate solve runs after first paint. The two yaws agree to ${agree}°.`,
						render: () => (
							<RealPhoto
								data={d}
								layers={["solved", "peaks"]}
								crop={crop}
								maxLabels={8}
							/>
						),
					},
					{
						label: "Export unlocked",
						caption:
							"Only now can you save the picture. Your own edits always win.",
						render: () => (
							<RealPhoto
								data={d}
								layers={["peaks"]}
								crop={crop}
								maxLabels={12}
							/>
						),
					},
				]}
			/>
		</Figure>
	);
}

function MiniLayers({
	layers,
}: {
	layers: ("skyline" | "prior" | "solved" | "peaks")[];
}) {
	const d = useAtlasPhoto("demo-01");
	return (
		<RealPhoto
			data={d}
			layers={layers}
			crop={[0, 100, 800, 330]}
			maxLabels={5}
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
			<HeroJourney />

			<Beat kicker="The idea" title="Show a pose fast. Certify it later.">
				<p>
					The workspace decides where the pose comes from. It paints a preview
					at once, then lets a second solver check it.
				</p>
				<p>Exports stay locked until the pose is final.</p>
			</Beat>

			<Beat kicker="How it works" title="Preview, double-check, then unlock.">
				<Trio
					steps={[
						{
							title: "Preview",
							body: "Show the first solve if its confidence tops 0.2.",
							visual: <MiniLayers layers={["skyline", "solved"]} />,
						},
						{
							title: "Double-check",
							body: "A second solver runs in the background. Agree within 1°, or it replaces the preview.",
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

			<AnnotatedWorkspace />

			<Beat
				kicker="Where it fails"
				title="The fast solve can be confidently wrong."
			>
				<p>
					One real photo fooled it: 2.98° off, at confidence 0.40. The second
					opinion put it within 0.02°.
				</p>
				<p>
					That disagreement is what the Refined badge shows. Your own drag or
					pin always overrides both.
				</p>
			</Beat>

			<Numbers
				items={[
					{ value: "2.98°", label: "fast solve error on IMG_7130" },
					{ value: "0.02°", label: "same photo after the second opinion" },
					{
						value: "11 / 12",
						label: "photos accepted correctly by the cascade",
					},
					{ value: "0", label: "false accepts from the cascade, of 12" },
				]}
				source={
					<>Hand-registered ground truth: reports/leaderboard.md (12 photos).</>
				}
			/>

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next: the solvers it hosts,{" "}
				{A("viewport-inference", "viewport inference")}, and the hand pins from{" "}
				{A("tap-a-peak", "tap a peak")}.
			</p>

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
								title: "Pick the source, in priority order",
								body: (
									<>
										An applied eye move, then a saved pose or a bundled sample
										pose, then (if compass, gravity or lens is missing, see{" "}
										<code>photoUnknowns</code>) the unknown-pose cascade,
										otherwise <code>engine.autoAlign</code>. A pose you chose is
										never silently replaced by a solver.
									</>
								),
							},
							{
								title: "Preview fast, with a deliberately low bar",
								body: (
									<>
										<code>choosePreview</code> shows autoAlign at confidence
										&gt; 0.2; else a near-compass alternative within 4° yaw and
										1.5° pitch of the sensors; else the phone prior. The page
										paints and <code>[data-ready]</code> fires without waiting
										for the slow check.
									</>
								),
							},
							{
								title: "A second opinion, after first paint",
								body: (
									<>
										<code>secondOpinion</code> re-solves from the prior with the
										CPU cascade in a worker (20 s deadline), then returns a
										verdict:
										<code> verified</code> (agree within 1°),{" "}
										<code>refined</code> (cascade replaces the preview),{" "}
										<code>kept</code>, <code>unverified</code> or{" "}
										<code>matched</code> (render-and-match, taken only under the
										product accept rule).
									</>
								),
							},
							{
								title: "Lock exports until the pose is final",
								body: (
									<>
										<code>exportLocked</code> holds while loading or while the
										verdict is pending, so a file never bakes in a pose that is
										about to move. The same flag gates the display-only concord
										pass and the eye suggestion.
									</>
								),
							},
						]}
					/>
					<p>
						The solvers themselves are explained in{" "}
						{A("viewport-inference", "Viewport Inference")} and{" "}
						{A("terrain-snapping", "Terrain Snapping")}; this page is about what
						the cockpit does with their answers.
					</p>
				</Section>

				<Section kicker="Your hand" title="You always have the last word">
					<p>
						Dragging in the align tool turns pixels into angles:{" "}
						<code>yaw −= dx / width × hfov</code>,{" "}
						<code>pitch += dy / height × vfov</code>, Shift-drag adds{" "}
						<code>0.05°</code> of roll per pixel, and the wheel scales vfov by{" "}
						<code>1 + dy × 0.0006</code> (clamped 5° to 100°). The first edit
						saves the pose, marks it <code>manual</code> and aborts any pending
						second opinion, so a late background result cannot move what you
						set.
					</p>
					<p>
						Pins are the precise version: pick a peak from the candidates in
						frame, click where it is in the photo, and <code>solvePins</code>{" "}
						fits only as many parameters as the evidence supports. See{" "}
						{A("tap-a-peak", "Tap a Peak")} for the picker.
					</p>
				</Section>

				<PinSolve />

				<Section
					kicker="Result"
					title="Why the second opinion is worth its wait"
				>
					<div className="!mt-5 grid grid-cols-2 gap-5 sm:grid-cols-4">
						<Stat
							value="> 0.2"
							label="preview confidence bar (choosePreview)"
						/>
						<Stat value="≤ 1°" label="agreement for “verified” (AGREE_DEG)" />
						<Stat
							value="20 s"
							label="cascade deadline bounding the export lock"
						/>
						<Stat value="0" label="cascade false accepts on 12 GT photos" />
					</div>
					<p className="!mt-4 text-[13px] text-white/45">
						The GPU aligner alone made one confident wrong accept (IMG_7130,
						+2.98° at 0.397); the cascade accepted 11 of 12 correctly and put
						IMG_7130 at −0.02°. That disagreement is exactly what the Refined
						badge catches (reports/leaderboard.md).
					</p>
					<Callout tone="lesson" title="Fast to show, slow to certify">
						Showing the preview immediately and certifying later gives a quick
						first paint without letting an unchecked pose reach an export.
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
					<p className="!mt-3 font-mono text-[12.5px] text-white/55">
						PhotoWorkspace, choosePreview, secondOpinion, AGREE_DEG,
						CASCADE_TIMEOUT_MS, resolveUnknownPose, photoUnknowns, solvePins,
						ALIGN_STATE, exportLocked
					</p>
				</Section>

				<Section kicker="Where it fits" title="Neighbours">
					<p>
						The cockpit hosts the pose that{" "}
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
