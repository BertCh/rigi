// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
	CircledKey,
	CircledNumber,
	HandMark,
	PencilLayer,
	Wash,
} from "#/components/gipfelbuch/notebook";
import {
	Hachure,
	HandDot,
	HandText,
	PenArrow,
	PenCircle,
	PenLine,
	SketchPath,
	SketchPolyline,
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
	Flow,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	HandLabel,
	HandNote,
	LAYER_STYLE,
	MarginNote,
	Measured,
	PhotoPicker,
	RealPhoto,
	Section,
	Steps,
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
import { PhotoStory } from "#/components/gipfelbuch/viz/PhotoStory";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// Tap-a-peak: how a few user taps turn into a pose.
// Mechanism is the real one:
//   src/lib/geo/control-points.ts  solveFromControlPoints: 1 point -> yaw+pitch, 2 -> +roll, >=3 -> +focal
//     (weak Gaussian prior sigma = 10 % on f), a level point counts as half a point, LM up to 100 iterations.
//   src/lib/align.ts solvePins (what the picker calls via Renderer.solvePins): same unlock ladder, 50 LM
//     iterations, weak priors on roll / vfov.
//   src/lib/picker/candidates.ts nearbyPeaks: window 15 deg, up to 8, prominence tie-break
//     0.5 deg per 1000 m capped at 1 deg; rerankWithTaps: tap-consistent (TAP_MAX_PX = 12 on a 1000 px
//     image) first, then skyline score, then tap residual.
// The scene below is synthetic and deterministic; the solver in this file re-implements the same
// unlock ladder with a small LM so the residuals shown are computed, not drawn.

const DEG = Math.PI / 180;
/** Dark under-stroke for anything drawn on a photograph. */
const PHOTO_DARK = "rgba(12, 14, 18, 0.85)";

/** The PinLock plate is a dark live scene: its inks are fixed hex, not paper tokens. */
const PLATE_RED = "#ff8a76";
const PLATE_TEXT = "#e8e2d4";
const PLATE_HALO = "#10151b";

const W = 640;
const H = 300;
const CX = W / 2;
const CY = 168;

type Cam = { yaw: number; pitch: number; roll: number; f: number };

// ---------- the world: six named summits as (azimuth, apparent elevation) from the eye ----------
const PEAKS = [
	{ name: "A", az: 196, el: 6.1 },
	{ name: "B", az: 203, el: 4.3 },
	{ name: "C", az: 209.5, el: 7.4 },
	{ name: "D", az: 217, el: 5.2 },
	{ name: "E", az: 224, el: 8.4 },
	{ name: "F", az: 231, el: 5.6 },
];
const TRUTH: Cam = { yaw: 214, pitch: 1.0, roll: 2.2, f: 600 };
// what the sensors say: compass 6.5 deg off, gravity 1.4 deg off, no roll, lens 7 % short
const START: Cam = { yaw: 220.5, pitch: -0.4, roll: 0, f: 558 };
// tap order: far left, far right, then the middle one (roll needs a baseline; focal needs a third)
const TAP_ORDER = [0, 5, 3];
// the user's finger is not exact: fixed jitter in px
const JIT: [number, number][] = [
	[1.1, -0.8],
	[-0.9, 1.3],
	[0.6, 0.7],
];

function dirENU(az: number, el: number): [number, number, number] {
	const a = az * DEG;
	const e = el * DEG;
	return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}
const dot = (a: number[], b: number[]) =>
	a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function project(c: Cam, az: number, el: number): [number, number] | null {
	const y = c.yaw * DEG;
	const p = c.pitch * DEG;
	const r = c.roll * DEG;
	const F = [Math.sin(y) * Math.cos(p), Math.cos(y) * Math.cos(p), Math.sin(p)];
	const R0 = [Math.cos(y), -Math.sin(y), 0];
	const U0 = [
		-Math.sin(y) * Math.sin(p),
		-Math.cos(y) * Math.sin(p),
		Math.cos(p),
	];
	const R = R0.map((v, i) => v * Math.cos(r) + U0[i] * Math.sin(r));
	const U = R0.map((v, i) => -v * Math.sin(r) + U0[i] * Math.cos(r));
	const d = dirENU(az, el);
	const z = dot(d, F);
	if (z < 0.05) return null;
	return [CX + (c.f * dot(d, R)) / z, CY - (c.f * dot(d, U)) / z];
}

// ---------- the tiny LM, same unlock ladder as solveFromControlPoints ----------
type Tap = { x: number; y: number; peak: number };
const TAPS: Tap[] = TAP_ORDER.map((pi, i) => {
	const q = project(TRUTH, PEAKS[pi].az, PEAKS[pi].el) as [number, number];
	return { x: q[0] + JIT[i][0], y: q[1] + JIT[i][1], peak: pi };
});

function solveGauss(A: number[][], b: number[]) {
	const n = b.length;
	const M = A.map((r, i) => [...r, b[i]]);
	for (let i = 0; i < n; i++) {
		let m = i;
		for (let k = i + 1; k < n; k++)
			if (Math.abs(M[k][i]) > Math.abs(M[m][i])) m = k;
		[M[i], M[m]] = [M[m], M[i]];
		const d = M[i][i] || 1e-12;
		for (let k = i; k <= n; k++) M[i][k] /= d;
		for (let j = 0; j < n; j++) {
			if (j === i) continue;
			const f = M[j][i];
			for (let k = i; k <= n; k++) M[j][k] -= f * M[i][k];
		}
	}
	return M.map((r) => r[n]);
}

function solveTaps(n: number): Cam {
	if (n === 0) return START;
	const taps = TAPS.slice(0, n);
	const keys: (keyof Cam)[] = ["yaw", "pitch"];
	if (n >= 2) keys.push("roll");
	if (n >= 3) keys.push("f");
	const resid = (c: Cam) => {
		const out: number[] = [];
		for (const t of taps) {
			const q = project(c, PEAKS[t.peak].az, PEAKS[t.peak].el);
			out.push(q ? q[0] - t.x : 1e5, q ? q[1] - t.y : 1e5);
		}
		if (n >= 3) out.push((c.f - START.f) / (START.f * 0.1)); // sigma = 10 % on f
		return out;
	};
	let p = { ...START };
	let r = resid(p);
	let cost = r.reduce((a, b) => a + b * b, 0);
	let lambda = 1e-2;
	for (let it = 0; it < 60; it++) {
		const J = keys.map((k) => {
			const h = k === "f" ? 1e-3 : 1e-5;
			const r2 = resid({ ...p, [k]: p[k] + h });
			return r2.map((v, i) => (v - r[i]) / h);
		});
		const A = keys.map((_, i) =>
			keys.map((_, j) => J[i].reduce((a, _x, m) => a + J[i][m] * J[j][m], 0)),
		);
		const g = keys.map((_, i) => -J[i].reduce((a, x, m) => a + x * r[m], 0));
		for (let i = 0; i < keys.length; i++) A[i][i] *= 1 + lambda;
		const d = solveGauss(A, g);
		const q = { ...p };
		keys.forEach((k, i) => {
			q[k] += d[i];
		});
		const r2 = resid(q);
		const c2 = r2.reduce((a, b) => a + b * b, 0);
		if (c2 < cost) {
			const done = cost - c2 < 1e-9;
			p = q;
			r = r2;
			cost = c2;
			lambda *= 0.3;
			if (done) break;
		} else lambda *= 10;
	}
	return p;
}

// ---------- the ridge between the summits ----------
function ridgeEl(az: number) {
	let e = 1.4 + 0.5 * Math.sin(az * 0.31) + 0.25 * Math.sin(az * 0.83 + 1);
	for (const p of PEAKS) {
		const d = (az - p.az) / 2.3;
		if (Math.abs(d) < 4) e = Math.max(e, p.el * Math.exp(-d * d));
	}
	return e;
}
function ridgePts(c: Cam) {
	const pts: [number, number][] = [];
	for (let az = 168; az <= 262; az += 0.5) {
		const q = project(c, az, ridgeEl(az));
		if (q && q[0] > -30 && q[0] < W + 30) pts.push(q);
	}
	return pts.sort((a, b) => a[0] - b[0]);
}
const line = (pts: [number, number][]) =>
	pts
		.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`)
		.join("");

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const ease = (k: number) => k * k * (3 - 2 * k);
const fmtS = (v: number, d = 1) =>
	`${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;

const STAGE_S = 3.6;
const DOF = [
	{ key: "yaw" as const, label: "yaw", unlock: 1, unit: "°" },
	{ key: "pitch" as const, label: "pitch", unlock: 1, unit: "°" },
	{ key: "roll" as const, label: "roll", unlock: 2, unit: "°" },
	{ key: "f" as const, label: "focal", unlock: 3, unit: " px" },
];

// ======================================================================================
// Fig. 1: the hero. Each tap locks degrees of freedom; the skyline overlay tightens.
// ======================================================================================
function PinLock() {
	const [ref, t] = useTime<HTMLDivElement>(STAGE_S * 3 + 2.4);
	const [manual, setManual] = useState<number | null>(null);
	const poses = useMemo(() => [0, 1, 2, 3].map(solveTaps), []);
	const truthRidge = useMemo(() => ridgePts(TRUTH), []);

	const cyc = t % (STAGE_S * 4);
	const si = Math.min(3, Math.floor(cyc / STAGE_S));
	const local = cyc - si * STAGE_S;
	const k = ease(Math.min(1, local / 1.1));
	let cam: Cam;
	let stage: number;
	if (manual != null) {
		cam = poses[manual];
		stage = manual;
	} else {
		const prev = poses[Math.max(0, si - 1)];
		cam = {
			yaw: lerp(prev.yaw, poses[si].yaw, k),
			pitch: lerp(prev.pitch, poses[si].pitch, k),
			roll: lerp(prev.roll, poses[si].roll, k),
			f: lerp(prev.f, poses[si].f, k),
		};
		stage = si;
	}
	const { yaw, pitch, roll, f } = cam;
	const pred = useMemo(
		() => ridgePts({ yaw, pitch, roll, f }),
		[yaw, pitch, roll, f],
	);
	const shown = TAPS.slice(0, stage);
	const pinned = new Set(shown.map((s) => s.peak));
	const truthXY = PEAKS.map(
		(p) => project(TRUTH, p.az, p.el) as [number, number],
	);
	const predXY = PEAKS.map((p) => project(cam, p.az, p.el));
	// residual of the pins under the displayed pose, and the miss of every OTHER summit label vs the truth
	const pinRms = shown.length
		? Math.sqrt(
				shown.reduce((s, tp) => {
					const q = predXY[tp.peak];
					return s + (q ? (q[0] - tp.x) ** 2 + (q[1] - tp.y) ** 2 : 0);
				}, 0) / shown.length,
			)
		: null;
	const others = PEAKS.map((_, i) => i).filter((i) => !pinned.has(i));
	const labelMiss =
		others.reduce((s, i) => {
			const q = predXY[i];
			const g = truthXY[i];
			return s + (q ? Math.hypot(q[0] - g[0], q[1] - g[1]) : 0);
		}, 0) / Math.max(1, others.length);

	return (
		<Figure
			label="Fig. D1"
			bleed
			caption="Schematic: one synthetic photo, six named summits, so every number is under control. The sensors start the overlay 6.5° off in yaw, 1.4° off in pitch, with no roll and a lens 7 % short. Each tap adds a pin the solver must honour: the ring is your finger, the filled marker is where that summit lands under the current pose, the line between them is the residual. The solid cyan line is the predicted skyline; the dashed pale line is where the real one is."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<svg
					viewBox={`0 0 ${W} ${H}`}
					className="block h-auto w-full"
					role="img"
					aria-label="A photo with predicted skyline and tapped summit pins"
				>
					{/* dark plate: a live scene, sky gradient, real ridge dashed, predicted skyline in cyan */}
					<defs>
						<linearGradient id="tp-sky" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0" stopColor="#141c27" />
							<stop offset="0.7" stopColor="#3b4d66" />
							<stop offset="1" stopColor="#7d8da3" />
						</linearGradient>
					</defs>
					<rect width={W} height={H} fill="url(#tp-sky)" />
					<path d={`${line(truthRidge)} L${W} ${H} L0 ${H} Z`} fill="#1f2a38" />
					<SketchPolyline
						points={truthRidge}
						seed="tp-truth"
						data
						color={PLATE_TEXT}
						width={1.6}
						dash="4 4"
					/>
					<path
						d={`M0 ${H} L0 262 C 120 246 260 270 400 256 S 560 250 ${W} 262 L${W} ${H} Z`}
						fill="#0d1218"
					/>

					{/* predicted skyline */}
					<SketchPolyline
						points={pred}
						seed="tp-pred"
						data
						color={LAYER_STYLE.solved.color}
						width={2.4}
					/>

					{/* summit labels under the current pose */}
					{PEAKS.map((p, i) => {
						const q = predXY[i];
						if (!q) return null;
						const on = pinned.has(i);
						return (
							<g key={p.name}>
								<SketchPath
									d={`M${q[0]} ${q[1] - 1} l5 -9 l-10 0 Z`}
									seed={`tp-tri-${p.name}`}
									color={on ? PLATE_RED : PLATE_TEXT}
									width={1.4}
								/>
								<HandLabel
									x={q[0]}
									y={q[1] - 16}
									anchor="middle"
									size={11.5}
									color={on ? PLATE_RED : PLATE_TEXT}
									haloColor={PLATE_HALO}
								>
									{p.name}
								</HandLabel>
							</g>
						);
					})}

					{/* taps and residual segments */}
					{shown.map((tp, n) => {
						const q = predXY[tp.peak];
						return (
							<g key={tp.peak}>
								{q && (
									<PenLine
										from={[q[0], q[1]]}
										to={[tp.x, tp.y]}
										seed={`tp-res-${tp.peak}`}
										data
										color={PLATE_TEXT}
										width={1.5}
									/>
								)}
								<PenCircle
									center={[tp.x, tp.y]}
									radiusX={9}
									seed={`tp-ring-${tp.peak}`}
									data
									color={PLATE_RED}
									width={1.8}
								/>
								<HandDot
									x={tp.x}
									y={tp.y}
									r={2.2}
									seed={`tp-dot-${tp.peak}`}
									data
									color={PLATE_RED}
									opacity={1}
								/>
								<HandLabel
									x={tp.x + 13}
									y={tp.y + 4}
									size={11.5}
									color={PLATE_RED}
									haloColor={PLATE_HALO}
								>
									tap {n + 1}
								</HandLabel>
							</g>
						);
					})}
					<HandLabel
						x={W - 10}
						y={20}
						anchor="end"
						size={12.5}
						color={PLATE_TEXT}
						haloColor={PLATE_HALO}
					>
						{stage === 0
							? "sensor prior"
							: `${stage} pin${stage > 1 ? "s" : ""}`}
					</HandLabel>
					<HandText
						x={14}
						y={44}
						size={17}
						color={PLATE_TEXT}
						rotate={-2}
						halo={false}
					>
						{stage === 0
							? "cyan misses the dashed ridge: 6.5° off in yaw"
							: "pinned summits now sit on my fingertip"}
					</HandText>
					<PenArrow
						from={[150, 52]}
						to={[190, 110]}
						seed="tp-note-arrow"
						color={PLATE_TEXT}
						width={1.3}
					/>
					{stage >= 2 && (
						<HandText
							x={W - 14}
							y={H - 22}
							size={16}
							anchor="end"
							color={PLATE_RED}
							rotate={2}
							halo={false}
						>
							two far pins pin the horizon slope: roll ✓
						</HandText>
					)}
				</svg>
			</div>

			<div className="mt-4 grid gap-5 md:grid-cols-[1fr_auto]">
				<div>
					<div
						className="mb-3 flex flex-wrap gap-2"
						role="toolbar"
						aria-label="Number of taps"
					>
						{[0, 1, 2, 3].map((n) => (
							<button
								key={n}
								type="button"
								aria-pressed={stage === n && manual != null}
								onClick={() => setManual(n)}
								className={`px-3 py-1 font-mono transition ${
									stage === n
										? "bg-[var(--nb-highlight,var(--accent))] gb-ink underline decoration-[var(--nb-red)] decoration-2 underline-offset-4"
										: "bg-[var(--nb-paper-deep)] gb-secondary"
								} ${TYPE.micro}`}
							>
								{n === 0 ? "no taps" : `${n} tap${n > 1 ? "s" : ""}`}
							</button>
						))}
						<button
							type="button"
							onClick={() => setManual(null)}
							className={`bg-[var(--nb-paper-deep)] px-3 py-1 font-mono gb-secondary transition ${TYPE.micro}`}
						>
							{manual != null ? "↻ autoplay" : "auto-playing"}
						</button>
					</div>
					<ul className="grid list-none grid-cols-2 gap-2 sm:grid-cols-4">
						{DOF.map((d) => {
							const locked = stage >= d.unlock;
							const v = cam[d.key];
							const err = v - TRUTH[d.key];
							return (
								<li
									key={d.key}
									className="border-l-2 bg-[var(--gb-paper-deep)] px-3 py-2 transition"
									style={{
										borderColor: locked ? "var(--gb-red)" : "transparent",
									}}
								>
									<div
										className={`flex flex-wrap items-baseline justify-between gap-x-2 font-mono gb-secondary ${TYPE.kicker}`}
									>
										<span>{d.label}</span>
										<span
											style={{ color: locked ? "var(--gb-red)" : undefined }}
										>
											{locked ? "solved" : stage === 0 ? "prior" : "kept"}
										</span>
									</div>
									<div className={`mt-0.5 font-mono gb-ink ${TYPE.caption}`}>
										{d.key === "f" ? v.toFixed(0) : v.toFixed(1)}
										{d.unit}
									</div>
									<div className={`font-mono gb-secondary ${TYPE.micro}`}>
										{fmtS(err, d.key === "f" ? 0 : 1)}
										{d.unit} off
									</div>
								</li>
							);
						})}
					</ul>
				</div>
				<dl
					className={`grid min-w-[190px] grid-cols-2 gap-x-5 gap-y-2 self-start font-mono md:grid-cols-1 ${TYPE.micro}`}
				>
					<div>
						<dt className="gb-secondary">pin residual (rms)</dt>
						<dd className="gb-ink">
							{pinRms == null ? "n/a" : `${pinRms.toFixed(1)} px`}
						</dd>
					</div>
					<div>
						<dt className="gb-secondary">other labels, mean miss</dt>
						<dd className="gb-ink">{`${labelMiss.toFixed(1)} px`}</dd>
					</div>
				</dl>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Fig. 2: which summit did you mean? A tap is a ray under every candidate pose.
// ======================================================================================
const POOL = [
	{ name: "Summit A", az: 205.2, prom: 300, km: 6.2 },
	{ name: "Summit B", az: 209.0, prom: 400, km: 9.8 },
	{ name: "Summit C", az: 209.6, prom: 1800, km: 14.1 },
	{ name: "Summit D", az: 214.8, prom: 250, km: 4.4 },
	{ name: "Summit E", az: 218.5, prom: 1100, km: 11.7 },
	{ name: "Summit F", az: 224.0, prom: 700, km: 8.3 },
	{ name: "Summit G", az: 232.5, prom: 1500, km: 17.9 },
	{ name: "Summit H", az: 197.0, prom: 900, km: 12.6 },
	{ name: "Summit I", az: 241.0, prom: 2100, km: 22.4 },
];
// three hypotheses from the picker: the pose on screen, and two alternatives the solver ranked
const CANDS = [
	{ name: "shown", yaw: 220.5, tone: "red" as const },
	{ name: "alt 2", yaw: 213.8, tone: "brown" as const },
	{ name: "alt 3", yaw: 199.0, tone: "navy" as const },
];
const HFOV = 57.6;
const WINDOW = 15;
const AX0 = 180;
const AX1 = 250;

function PeakChooser() {
	const [u, setU] = useState(0.58);
	const rays = CANDS.map(
		(c) => c.yaw + Math.atan((u - 0.5) * 2 * Math.tan((HFOV / 2) * DEG)) / DEG,
	);
	const offered = POOL.map((p) => {
		const sep = Math.min(...rays.map((r) => Math.abs(p.az - r)));
		const bonus = Math.min(1, (p.prom / 1000) * 0.5);
		return { ...p, sep, bonus, key: sep - bonus };
	})
		.filter((p) => p.sep <= WINDOW)
		.sort((a, b) => a.key - b.key)
		.slice(0, 8);
	const rank = new Map(offered.map((p, i) => [p.name, i + 1]));
	const X = (az: number) => 24 + ((az - AX0) / (AX1 - AX0)) * 592;

	return (
		<Figure
			label="Fig. D2"
			bleed
			caption="Drag the tap across the photo. Under each of the three candidate poses the tap is a ray in a different direction (coloured lines, with their ±15° windows). A summit is offered if it is inside any window, ranked by its angle to the nearest ray minus a prominence bonus of 0.5° per 1000 m, capped at 1°: B and C sit 0.6° apart, so the more prominent C ranks ahead of B. Azimuth-only here; the code uses the full 3D angle."
		>
			<div>
				<svg
					viewBox="0 0 640 190"
					className="block h-auto w-full"
					role="img"
					aria-label="Candidate rays and the summits offered for a tap"
				>
					{CANDS.map((c, i) => {
						const x0 = X(rays[i] - WINDOW);
						const x1 = X(rays[i] + WINDOW);
						const top = 20 + i * 6;
						return (
							<g key={c.name}>
								<Wash
									d={`M${x0} ${top} H${x1} V138 H${x0} Z`}
									seed={`pc-wash-${c.name}`}
									color={c.tone}
									layers={6}
									opacity={0.05}
								/>
								<Hachure
									d={`M${x0} ${top} H${x1} V138 H${x0} Z`}
									seed={`pc-win-${c.name}`}
									color={c.tone}
									gap={7}
									angle={-45}
									opacity={0.5}
									width={0.9}
								/>
							</g>
						);
					})}
					<PenLine
						from={[24, 138]}
						to={[616, 138]}
						seed="pc-axis"
						width={1.2}
					/>
					{[180, 190, 200, 210, 220, 230, 240, 250].map((a) => (
						<g key={a}>
							<PenLine
								from={[X(a), 138]}
								to={[X(a), 144]}
								seed={`pc-tick-${a}`}
								width={1}
							/>
							<HandLabel
								x={X(a)}
								y={157}
								anchor="middle"
								size={11.5}
								color="var(--gb-secondary)"
							>
								{`${a}°`}
							</HandLabel>
						</g>
					))}
					{CANDS.map((c, i) => (
						<g key={c.name}>
							<PenLine
								from={[X(rays[i]), 20 + i * 6]}
								to={[X(rays[i]), 138]}
								seed={`pc-ray-${c.name}`}
								data
								color={c.tone}
								width={2}
							/>
							<HandLabel
								x={X(rays[i])}
								y={14 + i * 6}
								anchor="middle"
								size={11.5}
								color={
									c.tone === "red"
										? "var(--gb-red)"
										: c.tone === "navy"
											? "var(--gb-navy)"
											: "var(--gb-ink)"
								}
							>
								{c.name}
							</HandLabel>
						</g>
					))}
					{POOL.map((p) => {
						const r = rank.get(p.name);
						const inWin = r != null;
						const rad = 3 + p.prom / 500;
						const cy = 138 - rad - 2;
						return (
							<g key={p.name} opacity={inWin ? 1 : 0.35}>
								<HandDot
									x={X(p.az)}
									y={cy}
									r={rad}
									seed={`pc-peak-${p.name}`}
									color={inWin ? "navy" : "pencil"}
									opacity={inWin ? 0.85 : 0.6}
									data
								/>
								{inWin && (
									<HandLabel
										x={X(p.az)}
										y={cy - rad - 4}
										anchor="middle"
										size={11.5}
										color={r === 1 ? "var(--gb-red)" : "var(--gb-ink)"}
									>
										{r}
									</HandLabel>
								)}
							</g>
						);
					})}
					<HandNote x={24} y={180} size={11.5}>
						azimuth · dot size = prominence
					</HandNote>
					<PencilLayer>
						<PenLine
							from={[24, 20]}
							to={[616, 20]}
							seed="pc-guide-top"
							width={0.8}
						/>
						<PenLine
							from={[24, 20]}
							to={[24, 138]}
							seed="pc-guide-left"
							width={0.8}
						/>
					</PencilLayer>
					<HandText x={X(197) - 6} y={92} size={16} anchor="end" rotate={-3}>
						B and C are 0.6° apart: the taller one wins
					</HandText>
					<PenArrow
						from={[X(197) - 2, 98]}
						to={[X(208.6), 118]}
						seed="pc-note-arrow"
						width={1.2}
					/>
					<CircledKey x={X(rays[0]) + 14} y={34} value="1" seed="pc-key-1" />
				</svg>
				<label
					className={`mt-1 flex items-center gap-3 font-mono gb-secondary ${TYPE.micro}`}
				>
					<span className="shrink-0">tap x</span>
					<input
						type="range"
						min={0.1}
						max={0.9}
						step={0.005}
						value={u}
						onChange={(e) => setU(Number(e.target.value))}
						className="h-1 min-w-0 flex-1"
						style={{ accentColor: "var(--accent)" }}
						aria-label="Tap position across the photo"
					/>
					<span className="w-10 text-right gb-ink">
						{(u * 100).toFixed(0)}%
					</span>
				</label>
				<ol
					className={`mt-3 grid gap-x-6 gap-y-1 font-mono sm:grid-cols-2 ${TYPE.caption}`}
				>
					{offered.slice(0, 4).map((p, i) => (
						<li
							key={p.name}
							className="flex items-baseline justify-between gap-2 py-1"
						>
							<span className="gb-ink">
								<span className="text-[var(--accent)]">{i + 1}</span> {p.name}
							</span>
							<span className="whitespace-nowrap gb-secondary">
								{p.sep.toFixed(1)}° − {p.bonus.toFixed(2)}° · {p.km.toFixed(1)}{" "}
								km
							</span>
						</li>
					))}
				</ol>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Measured: the real solver on a real photo (public/demo/gipfelbuch/tap, scripts/gipfelbuch/data-tap.ts)
// ======================================================================================
type TapStep = {
	n: number;
	cam: { yaw: number; pitch: number; roll: number; f: number; vfov: number };
	rmsPx: number | null;
	solvedFocal: boolean;
	err: { yaw: number; pitch: number; roll: number; fRatio: number };
	peakShift: { median: number; max: number };
	skyline: { median: number; within5: number; n: number };
	rows: (number | null)[];
	peaks: ([number, number] | null)[];
};
type TapData = {
	id: string;
	script: string;
	generated: string;
	taps: {
		name: string;
		dem: number;
		distance: number;
		az: number;
		el: number;
		x: number;
		y: number;
	}[];
	labelledNames: string[];
	truth: TapStep["cam"];
	steps: TapStep[];
};
const tapCache = new Map<string, Promise<TapData>>();
function useTapData(id: string) {
	const [d, setD] = useState<TapData | null>(null);
	useEffect(() => {
		let live = true;
		setD(null);
		let p = tapCache.get(id);
		if (!p) {
			p = fetch(`/demo/gipfelbuch/tap/${id}.json`).then((r) => r.json());
			tapCache.set(id, p);
		}
		p.then((v) => live && setD(v)).catch((e) =>
			console.warn("[gipfelbuch]", e),
		);
		return () => {
			live = false;
		};
	}, [id]);
	return d;
}
const TAP_IDS = ["demo-10", "demo-09", "demo-01"] as const;
const TAP_CROP: Record<string, [number, number, number, number]> = {
	"demo-10": [100, 90, 800, 300],
	"demo-09": [100, 50, 800, 200],
	"demo-01": [0, 60, 800, 360],
};

function TapFrame({
	photo,
	tap,
	n,
	id,
	maxLabels,
	bleed,
}: {
	photo: GipfelbuchPhotoData | null;
	tap: TapData | null;
	n: number;
	id: string;
	maxLabels?: number;
	/** Geo bleed: only on the page's one hero render. */
	bleed?: boolean;
}) {
	const step = tap?.steps[n];
	const crop = TAP_CROP[id];
	const k = (crop[2] - crop[0]) / 800;
	const rowsD = step
		? step.rows
				.map((y, i) =>
					y == null
						? ""
						: `${i && step.rows[i - 1] != null ? "L" : "M"}${i * 4 + 0.5} ${y}`,
				)
				.join("")
		: "";
	const tapped = tap?.taps.slice(0, n) ?? [];
	const solvedColor = LAYER_STYLE.solved.color;
	return (
		<RealPhoto
			data={photo}
			layers={["skyline"]}
			crop={crop}
			maxLabels={maxLabels}
			bleed={bleed}
		>
			{() =>
				step && (
					<g>
						<CrispLine d={rowsD} color={solvedColor} width={2.4 * k} />
						{step.peaks.map((q, i) => {
							// pair by name: the bake and the photo json can list peaks in different orders
							// (homonyms: the k-th peak of a name in the bake is the k-th in the photo)
							const name = tap?.labelledNames[i];
							const nth = tap?.labelledNames
								.slice(0, i)
								.filter((m) => m === name).length;
							const g = photo?.peaks.filter(
								(p) => p.labelled && p.solved && p.name === name,
							)[nth ?? 0]?.solved;
							if (!q || !g) return null;
							const inC = (a: number[]) => a[1] >= crop[1] && a[1] <= crop[3];
							if (!inC(q) && !inC(g)) return null;
							return (
								// biome-ignore lint/suspicious/noArrayIndexKey: peaks are positional
								<g key={i}>
									<CrispLine
										d={`M${q[0]} ${q[1]}L${g[0]} ${g[1]}`}
										color={SWISS.paper}
										width={1.4 * k}
									/>
									<PenCircle
										center={[g[0], g[1]]}
										radiusX={4.5 * k}
										seed={`tf-g-dark-${id}-${i}`}
										data
										color={PHOTO_DARK}
										width={3.2 * k}
									/>
									<PenCircle
										center={[g[0], g[1]]}
										radiusX={4.5 * k}
										seed={`tf-g-${id}-${i}`}
										data
										color={solvedColor}
										width={1.6 * k}
									/>
									<HandDot
										x={q[0]}
										y={q[1]}
										r={2.8 * k}
										seed={`tf-q-${id}-${i}`}
										data
										color={SWISS.paper}
										opacity={1}
									/>
								</g>
							);
						})}
						{tapped.map((t) => (
							<g key={t.name}>
								<PenCircle
									center={[t.x, t.y]}
									radiusX={10 * k}
									seed={`tf-dark-${id}-${t.name}`}
									data
									color={PHOTO_DARK}
									width={5 * k}
								/>
								<PenCircle
									center={[t.x, t.y]}
									radiusX={10 * k}
									seed={`tf-${id}-${t.name}`}
									color="red"
									width={2.8 * k}
								/>
								<HandDot
									x={t.x}
									y={t.y}
									r={2.8 * k}
									seed={`tf-dot-${id}-${t.name}`}
									data
									color={SWISS.red}
									opacity={1}
								/>
								<HandLabel
									x={t.x}
									y={t.y - 15 * k}
									anchor="middle"
									size={14.4 * k}
									color="var(--gb-red)"
								>
									{t.name.split(" /")[0]}
								</HandLabel>
							</g>
						))}
					</g>
				)
			}
		</RealPhoto>
	);
}

function RealTaps() {
	// Follows the shell picker; tap data exists for three photos only, so any other pick shows demo-10.
	const [followed, setFollowed] = useNotebookPhoto();
	const id: GipfelbuchPhotoId = (TAP_IDS as readonly string[]).includes(
		followed,
	)
		? followed
		: "demo-10";
	const [n, setN] = useState(0);
	const photo = useGipfelbuchPhoto(id);
	const tap = useTapData(id);
	const step = tap?.steps[n];
	const unlocked = ["", "yaw + pitch", "+ roll", "+ focal", "+ focal"][n];
	return (
		<Figure
			label="Fig. 4"
			bleed
			caption={
				<>
					Add taps one by one. Cyan is the map skyline under the current pose;
					cyan rings mark where each peak should land, white dots where its
					label is now. Taps are exact. Tap data exists for demo-01, 09 and 10;
					the picker follows your photo when it is one of them.{" "}
					<Measured data={tap}>Data: public/demo/gipfelbuch/tap.</Measured>
				</>
			}
		>
			<PhotoPicker value={id} onChange={setFollowed} ids={TAP_IDS} />
			<div
				className={`mb-3 flex flex-wrap items-center gap-1.5 font-mono ${TYPE.micro}`}
			>
				{[0, 1, 2, 3, 4].map((i) => (
					<button
						key={i}
						type="button"
						onClick={() => setN(i)}
						className={`px-3 py-1 transition ${n === i ? "bg-[var(--nb-highlight,var(--accent))] gb-ink underline decoration-[var(--nb-red)] decoration-2 underline-offset-4" : "bg-[var(--nb-paper-deep)] gb-secondary"}`}
					>
						{i === 0 ? "sensor prior" : `${i} tap${i > 1 ? "s" : ""}`}
					</button>
				))}
				<span className="gb-secondary">
					{unlocked && `unlocked: ${unlocked}`}
				</span>
			</div>
			<TapFrame photo={photo} tap={tap} n={n} id={id} />
			{tap && step && (
				<dl
					className={`mt-4 grid grid-cols-2 gap-x-4 gap-y-2 font-mono gb-secondary sm:grid-cols-5 ${TYPE.micro}`}
				>
					<Cell k="yaw error" v={`${step.err.yaw.toFixed(2)}°`} />
					<Cell k="pitch error" v={`${step.err.pitch.toFixed(2)}°`} />
					<Cell k="roll error" v={`${step.err.roll.toFixed(2)}°`} />
					<Cell k="focal vs solved" v={`×${step.err.fRatio.toFixed(3)}`} />
					<Cell
						k="labels off (median / max)"
						v={`${step.peakShift.median} / ${step.peakShift.max} px`}
					/>
					<Cell
						k="solver rms"
						v={step.rmsPx == null ? "n/a" : `${step.rmsPx} px`}
					/>
					<Cell k="skyline miss (median)" v={`${step.skyline.median} px`} />
					<Cell
						k="f unlocked"
						v={n === 0 ? "n/a" : step.solvedFocal ? "yes" : "no"}
					/>
				</dl>
			)}
		</Figure>
	);
}
function Cell({ k, v }: { k: string; v: string }) {
	return (
		<div>
			<dt className="gb-secondary">{k}</dt>
			<dd className={`gb-ink ${TYPE.caption}`}>{v}</dd>
		</div>
	);
}

function TapTile({ d }: { d: GipfelbuchPhotoData }) {
	const tap = useTapData(d.id);
	const st = tap?.steps[1];
	return (
		<div>
			<TapFrame photo={d} tap={tap} n={1} id={d.id} maxLabels={6} />
			{st && (
				<div className={`mt-1 font-mono gb-secondary ${TYPE.micro}`}>
					<span className="gb-ink">{st.peakShift.median} px</span> median miss,{" "}
					<span className="gb-ink">{st.peakShift.max} px</span> worst, pitch{" "}
					{st.err.pitch.toFixed(2)}° off
				</div>
			)}
		</div>
	);
}

function TrioFrame({ n }: { n: number }) {
	const photo = useGipfelbuchPhoto("demo-10");
	const tap = useTapData("demo-10");
	return <TapFrame photo={photo} tap={tap} n={n} id="demo-10" maxLabels={6} />;
}

function HeroTaps() {
	const photo = useGipfelbuchPhoto("demo-10");
	const tap = useTapData("demo-10");
	const S = tap?.steps;
	const f = (v: number | undefined, dp = 1) =>
		v == null ? "…" : v.toFixed(dp);
	return (
		<Figure
			label="Fig. 1"
			bleed
			caption={
				<>
					Three taps on known summits pull the labels onto their peaks. The
					compass started {f(S && Math.abs(S[0].err.yaw))}° off. Taps here are
					exact, simulated at the pipeline&apos;s solved positions. Fixed:
					demo-10, the tap bakes cover only three photos.{" "}
					<Measured data={tap}>Data: public/demo/gipfelbuch/tap.</Measured>
				</>
			}
		>
			<Stages
				stages={[
					{
						label: "Phone sensors",
						caption: `The compass is ${f(S && Math.abs(S[0].err.yaw))}° off. Labels miss their peaks by ${f(S?.[0].peakShift.median, 0)} px.`,
						render: () => (
							<TapFrame photo={photo} tap={tap} n={0} id="demo-10" bleed />
						),
					},
					{
						label: "1 tap",
						caption: `Yaw snaps to ${f(S && Math.abs(S[1].err.yaw), 2)}° off. Labels now miss by ${f(S?.[1].peakShift.median)} px.`,
						render: () => (
							<TapFrame photo={photo} tap={tap} n={1} id="demo-10" bleed />
						),
					},
					{
						label: "2 taps",
						caption: `Roll is fixed too. The median miss drops to ${f(S?.[2].peakShift.median)} px.`,
						render: () => (
							<TapFrame photo={photo} tap={tap} n={2} id="demo-10" bleed />
						),
					},
					{
						label: "3 taps",
						caption: `The lens is solved. The median miss is ${f(S?.[3].peakShift.median)} px.`,
						render: () => (
							<TapFrame photo={photo} tap={tap} n={3} id="demo-10" bleed />
						),
					},
				]}
			/>
		</Figure>
	);
}

// ======================================================================================
// Fig. 2: one tap, solved by hand. The tapped pixel's offset from the image centre is an angle.
// ======================================================================================
const ONE_CROP: [number, number, number, number] = [260, 150, 560, 320];
// text-safe on both paper and ink grounds
const CYAN_TEXT = `color-mix(in oklab, ${LAYER_STYLE.solved.color} 55%, var(--gb-ink))`;

function OneTap() {
	const photo = useGipfelbuchPhoto("demo-10");
	const tap = useTapData("demo-10");
	const t = tap?.taps[0];
	const s1 = tap?.steps[1];
	if (!photo || !t || !s1)
		return (
			<div className="aspect-[16/9] animate-pulse bg-[var(--gb-paper-deep)]" />
		);
	const cx = photo.photo.width / 2;
	const cy = photo.photo.height / 2;
	const f = s1.cam.f;
	const k = (ONE_CROP[2] - ONE_CROP[0]) / photo.photo.width;
	const dx = t.x - cx;
	const dy = cy - t.y;
	const yawHand = t.az - Math.atan(dx / f) / DEG;
	const pitchHand = t.el - Math.atan(dy / f) / DEG;
	return (
		<Figure
			label="Fig. 2"
			bleed
			caption={
				<>
					How far the tap sits from the image centre, in pixels, is an angle.
					Subtract it from the summit&apos;s known direction and you have where
					the camera points.{" "}
					<Measured data={tap}>Data: public/demo/gipfelbuch/tap.</Measured>
				</>
			}
		>
			<RealPhoto data={photo} layers={[]} crop={ONE_CROP}>
				{() => (
					<g>
						<CrispLine
							d={`M${cx - 10 * k} ${cy}H${cx + 10 * k}M${cx} ${cy - 10 * k}V${cy + 10 * k}`}
							color={SWISS.paper}
							width={1.6 * k}
						/>
						<HandLabel
							x={cx + 12 * k}
							y={cy - 4 * k}
							size={(13 * (ONE_CROP[2] - ONE_CROP[0])) / 720}
							color="var(--gb-ink)"
						>
							image centre
						</HandLabel>
						<CrispLine
							d={`M${cx} ${t.y}H${t.x}`}
							color={SWISS.red}
							width={2 * k}
						/>
						<CrispLine
							d={`M${t.x} ${t.y}V${cy}H${cx}`}
							color={SWISS.red}
							width={1.4 * k}
							dash={`${4 * k} ${3 * k}`}
						/>
						<PenCircle
							center={[t.x, t.y]}
							radiusX={8 * k}
							seed="ot-tap"
							color="red"
							width={2.2 * k}
						/>
						<HandText
							x={cx + 20 * k}
							y={cy + 26 * k}
							size={17 * k}
							color={SWISS.paper}
							rotate={-2}
							halo={false}
						>
							these two offsets are the whole measurement
						</HandText>
						<PenArrow
							from={[cx + 60 * k, cy + 14 * k]}
							to={[cx + 40 * k, cy + 2 * k]}
							seed="ot-note-arrow"
							color={SWISS.paper}
							width={1.4 * k}
						/>
						<HandLabel
							x={t.x + 14 * k}
							y={t.y - 10 * k}
							size={(13 * (ONE_CROP[2] - ONE_CROP[0])) / 720}
							color="var(--gb-red)"
						>
							tap: {t.name}
						</HandLabel>
						<HandLabel
							x={t.x + 6 * k}
							y={(t.y + cy) / 2}
							size={(13 * (ONE_CROP[2] - ONE_CROP[0])) / 720}
							color={SWISS.red}
						>
							{Math.round(dy)} px up
						</HandLabel>
						<HandLabel
							x={cx - 4 * k}
							y={t.y - 6 * k}
							anchor="end"
							size={(13 * (ONE_CROP[2] - ONE_CROP[0])) / 720}
							color={SWISS.red}
						>
							{Math.round(dx)} px right
						</HandLabel>
					</g>
				)}
			</RealPhoto>
			<Eq
				className="!mb-0"
				where={[
					{
						sym: "az, el",
						c: CYAN_TEXT,
						text: `known direction of ${t.name}: ${t.az.toFixed(2)}°, ${t.el.toFixed(2)}° (from the map)`,
					},
					{
						sym: "x, y",
						c: "var(--accent)",
						text: "tapped pixel; (cx, cy) is the image centre",
					},
					{
						sym: "f",
						text: `lens, in pixels: ${f.toFixed(0)} px (the sensor's guess)`,
					},
				]}
			>
				<Sym>yaw</Sym> ≈ <Sym c={CYAN_TEXT}>az</Sym> − atan((
				<Sym c="var(--accent)">x</Sym> − cx) / <Sym>f</Sym>) ={" "}
				{yawHand.toFixed(1)}°
				<br />
				<Sym>pitch</Sym> ≈ <Sym c={CYAN_TEXT}>el</Sym> − atan((cy −{" "}
				<Sym c="var(--accent)">y</Sym>) / <Sym>f</Sym>) = {pitchHand.toFixed(1)}
				°
			</Eq>
			<p className={`mt-3 font-mono gb-secondary ${TYPE.micro}`}>
				The real solver, same tap: yaw {s1.cam.yaw.toFixed(1)}°, pitch{" "}
				{s1.cam.pitch.toFixed(1)}°. The hand formula ignores roll and the pitch
				tilt of the image axes.
			</p>
		</Figure>
	);
}

/** One solid bar, drawn up from a baseline; a light hatch rides on top as decoration only. */
function MissBar({
	seed,
	fraction,
	faint,
}: {
	seed: string;
	fraction: number;
	faint: boolean;
}) {
	const h = Math.round(fraction * 84);
	const x0 = 8;
	const x1 = 52;
	return (
		<svg
			viewBox="0 0 60 90"
			className="mx-auto block h-28 w-full"
			role="img"
			aria-hidden="true"
		>
			<Wash
				d={`M${x0} ${87 - h} H${x1} V87 H${x0} Z`}
				seed={`${seed}-wash`}
				color={faint ? "pencil" : "blue"}
				layers={6}
				opacity={0.07}
			/>
			<Hachure
				d={`M${x0} ${87 - h} H${x1} V87 H${x0} Z`}
				seed={seed}
				color={faint ? "pencil" : "blue"}
				gap={3.5}
				angle={-45}
				opacity={0.75}
				width={1}
			/>
			<SketchPath
				d={`M${x0} 87 V${87 - h} H${x1} V87`}
				seed={`${seed}-top`}
				data
				color={faint ? "pencil" : "blue"}
				width={1.4}
			/>
			<PenLine
				from={[x0 - 4, 87]}
				to={[x1 + 4, 87]}
				seed={`${seed}-base`}
				width={1.4}
			/>
		</svg>
	);
}

function MissBars() {
	const a = useTapData("demo-10");
	const b = useTapData("demo-09");
	const c = useTapData("demo-01");
	const rows = [
		{ id: "demo-10", t: a },
		{ id: "demo-09", t: b },
		{ id: "demo-01", t: c },
	];
	const max = Math.max(
		...rows.flatMap((r) => r.t?.steps.map((s) => s.peakShift.median) ?? [1]),
	);
	const lg = (v: number) =>
		Math.log10(Math.max(0.05, v) / 0.05) / Math.log10(max / 0.05);
	const worst = rows.every((r) => r.t)
		? Math.max(...rows.map((r) => r.t?.steps[3].peakShift.median ?? 0))
		: null;
	return (
		<Figure
			label="Fig. 5"
			caption={
				<>
					After three taps the median label miss is{" "}
					{worst == null ? "…" : `${worst} px`} or less on all three photos (by
					construction: the taps are exact and the reference is the pipeline
					pose). Bars are log scale.{" "}
					<Measured data={a}>Data: public/demo/gipfelbuch/tap.</Measured>
				</>
			}
		>
			<div className="space-y-4">
				{rows.map((r) => (
					<div key={r.id}>
						<div className={`mb-1 font-mono gb-secondary ${TYPE.micro}`}>
							{r.id}: median label miss, px
						</div>
						<div className="grid grid-cols-5 gap-3">
							{(r.t?.steps ?? []).map((st) => (
								<div key={st.n} className="text-center">
									<MissBar
										seed={`mb-${r.id}-${st.n}`}
										fraction={Math.max(0.04, lg(st.peakShift.median))}
										faint={st.n === 0}
									/>
									<div className={`mt-1 font-mono gb-ink ${TYPE.micro}`}>
										{st.peakShift.median}
									</div>
									<div className={`font-mono gb-secondary ${TYPE.micro}`}>
										{st.n === 0
											? "sensors"
											: `${st.n} tap${st.n > 1 ? "s" : ""}`}
									</div>
								</div>
							))}
						</div>
					</div>
				))}
			</div>
		</Figure>
	);
}

export default function Page({ node: _node }: { node: GipfelbuchNode }) {
	const A = (id: string, label: string) => (
		<Link
			to="/gipfelbuch/$concept"
			params={{ concept: id }}
			className="underline decoration-[var(--gb-red)] underline-offset-2 hover:decoration-current"
		>
			{label}
		</Link>
	);
	const t = useTapData("demo-10");
	const S = t?.steps;
	return (
		<>
			<HeroTaps />

			<Beat kicker="The idea" title="A tap is a measurement with a name on it.">
				<p>You point at a summit you know and say which one it is.</p>
				<p>
					<HandMark type="highlight">
						That pairs one pixel with one known direction.
					</HandMark>{" "}
					The pixel&apos;s distance from the centre is an angle.
				</p>
			</Beat>

			<OneTap />

			<Beat
				kicker="How it works"
				title="Each tap unlocks one more thing to solve."
			>
				<Trio
					steps={[
						{
							title: "One tap: yaw and pitch",
							body: "Which way the camera points, left-right and up-down.",
							visual: <TrioFrame n={1} />,
						},
						{
							title: "Two taps: roll",
							body: "Two far-apart points fix the tilt of the horizon.",
							visual: <TrioFrame n={2} />,
						},
						{
							title: "Three taps: the lens",
							body: "A third point shows how wide the view is.",
							visual: <TrioFrame n={3} />,
						},
					]}
				/>
			</Beat>

			<PhotoStory
				photoId="demo-10"
				bleed={false}
				number="3"
				title="A tap is the snap"
				caption={
					S
						? `The guess is the phone's pose: labels miss their peaks by ${S[0].peakShift.median} px (median). Naming one summit on the photo pulls the labels onto the skyline: ${S[1].peakShift.median} px after one tap on demo-10.`
						: "The phone's guess, then the names snapped onto their summits."
				}
			/>

			<RealTaps />

			<MissBars />

			<Beat
				kicker="Where it fails"
				title="One tap fixes direction, not roll or lens."
			>
				<p>
					Labels far from the tap drift:{" "}
					<HandMark type="underline">
						{S ? `${S[1].peakShift.median} px` : "…"} median
					</HandMark>{" "}
					after one tap on demo-10.
					{S && (
						<MarginNote mark="a">
							{`First guess: one tap fixes everything. Wrong: median miss ${S[0].peakShift.median} px, then ${S[1].peakShift.median} px.`}
						</MarginNote>
					)}
				</p>
				<p>
					A loose finger counts too. 5 px off is about{" "}
					{S ? (Math.atan(5 / S[1].cam.f) / DEG).toFixed(1) : "…"}° of yaw. And{" "}
					<HandMark type="wavy">naming the wrong summit is worse</HandMark>: the
					picker offers only nearby named peaks and re-checks each against the
					skyline.
				</p>
			</Beat>

			<Figure
				label="Fig. 6"
				caption="One tap, three photos: the tapped peak is exact, the far labels are not."
			>
				<Gallery ids={TAP_IDS} cols={3} tile={(d) => <TapTile d={d} />} />
			</Figure>

			<Numbers
				items={[
					{
						value: S ? `${Math.abs(S[0].err.yaw).toFixed(1)}°` : "…",
						label: "compass error before any tap (demo-10)",
					},
					{
						value: S ? `${Math.abs(S[1].err.yaw).toFixed(2)}°` : "…",
						label: "yaw error after one tap",
					},
					{
						value: S ? `${S[0].peakShift.median} px` : "…",
						label: "median label miss before any tap (demo-10)",
					},
					{
						value: S ? `${S[3].peakShift.median} px` : "…",
						label: "median label miss after three taps",
					},
				]}
				source={
					<>
						Measured on demo-10 by scripts/gipfelbuch/data-tap.ts. Taps are
						exact and the reference pose is the pipeline&apos;s own solution, so
						three taps recover it by construction. Not an accuracy test.
					</>
				}
			/>

			<Details>
				<PinLock />

				<Section
					kicker="The ladder"
					title="One tap, two angles. Three taps, the lens"
				>
					<ul>
						<li>
							<strong>1 pin: yaw and pitch.</strong> A single pixel fixes where
							the optical axis points. Roll and focal keep their sensor values,
							so the overlay is exact at the pin and tilts or stretches away
							from it.
							<MarginNote mark="b">
								Why does the lens only come with the third pin? Two points give
								a baseline, not a width.
							</MarginNote>
						</li>
						<li>
							<strong>
								<HandMark type="double">2 pins: and roll.</HandMark>
							</strong>{" "}
							Two points far apart give a baseline: the line between them must
							have the right slope. Only the focal error remains.
						</li>
						<li>
							<strong>3 pins: and focal.</strong> A third point makes field of
							view observable. In <code>solveFromControlPoints</code> it enters
							with a weak Gaussian prior (σ = 10 % of the starting focal, as
							Fig. D1 models); the picker's <code>solvePins</code> keeps weak
							priors on roll and field of view instead. Either way a sloppy tap
							cannot send the lens somewhere absurd.
						</li>
					</ul>
					<p>
						The geo-level solver, <code>solveFromControlPoints</code>, also
						takes <em>level points</em>: a pixel whose elevation is known but
						not its azimuth, such as a far lake shore or the sea horizon. Each
						counts as half a pin towards unlocking roll and focal and
						contributes a vertical-only residual.
					</p>
				</Section>

				<Section kicker="Disambiguation" title="Which summit did you mean?">
					<p>
						The hard part is not the maths, it is the name. The photo may be
						tens of degrees off, so the summit under your finger on the screen
						is not the one in the world. The picker therefore treats the tap as
						a ray under <em>every</em> candidate pose and lets each one vote.
						Only named OSM summits inside the window are offered, so a tap never
						turns into a pin on something unnameable. In Fig. D2 the pose on
						screen is ray <CircledNumber value={1} seed="tp-prose-1" />.
						<MarginNote mark="c">
							I notice the hard part is the name, not the maths.
						</MarginNote>
					</p>
				</Section>

				<PeakChooser />

				<Section
					kicker="Re-ranking"
					title="Every candidate is re-solved, then the skyline decides"
				>
					<p>
						A pin is solved from <em>each</em> starting candidate. One tap fixes
						yaw and pitch, but roll and focal come from whichever start the
						solve began at, which is why every candidate is kept: they now all
						agree about the pin and differ about the rest of the picture. The
						ranking separates them with evidence the user did not have to
						supply.
					</p>
					<Flow
						nodes={[
							{ label: "Re-solve", sub: "pin solver from every start" },
							{ label: "Tap-consistent", sub: "≤ 12 px at 1000 px wide" },
							{ label: "Skyline score", sub: "scorePose, fine" },
							{ label: "Preview", sub: "user confirms" },
						]}
					/>
				</Section>

				<Section kicker="How it works" title="From finger to saved pose">
					<Steps
						steps={[
							{
								title: "Tap the photo",
								body: "The tap is stored as a normalised (u, v). A crosshair layer over the stage captures it, so both renderers behave the same.",
							},
							{
								title: "Name the summit",
								body: "nearbyPeaks ranks pool peaks by angle to the nearest candidate ray minus a prominence bonus, within 15° and up to 8 shown. Choosing one adds a pin (world point, u, v); re-choosing replaces it.",
							},
							{
								title: "Solve rotation",
								body: "Levenberg-Marquardt over the unlocked parameters. The eye is fixed at the GPS point, so a pin is a pure rotation constraint; weak priors keep the under-determined directions sane.",
							},
							{
								title: "Rank and preview",
								body: "rerankWithTaps puts tap-consistent poses first, then by skyline score, and the best is previewed over the photo. Nothing is saved yet.",
							},
							{
								title: "Confirm",
								body: "“Use this” calls setPose with a note that the pose is user-confirmed. Every tap and solve is also written to the correction log, a labelled sample for later work.",
							},
						]}
					/>
				</Section>

				<Callout tone="result" title="Provenance is part of the result">
					A pin-solved pose is recorded as user-confirmed, never as an automatic
					HIGH. It sharpens the overlay immediately, but it does not claim a
					verification that nobody performed. See the{" "}
					{A("accept-rule", "accept rule")}.
				</Callout>

				<Section
					kicker="Where it fits"
					title="The human-in-the-loop end of the solve"
				>
					<p>
						When the {A("baseline-pipeline", "baseline pipeline")} rejects a
						pose, tap-a-peak is the escalation that does not need another
						algorithm: the same projection and robust least squares as{" "}
						{A("viewport-inference", "viewport inference")}, fed by one human
						correspondence instead of a skyline. The summits it offers are the{" "}
						{A("peak", "peak")} layer, which{" "}
						{A("terrain-snapping", "terrain snapping")} has already moved onto
						the DEM summit.
					</p>
				</Section>

				<Section kicker="In the code" title="Where to look">
					<div className="flex flex-wrap gap-2">
						<CodeRef path="src/lib/geo/control-points.ts" />
						<CodeRef path="src/lib/align.ts" />
						<CodeRef path="src/lib/picker/candidates.ts" />
						<CodeRef path="src/lib/picker/PickerPanel.tsx" />
						<CodeRef path="src/lib/picker/README.md" />
					</div>
					<p>
						<HandMark type="circle">TAP_MAX_PX = 12</HandMark> on a 1000 px
						image is the gate for &ldquo;tap-consistent&rdquo;.
						<MarginNote mark="d">
							12 px of 1000 is about 0.7° of a 57.6° view: a finger, not a
							solver, sets the tolerance.
						</MarginNote>
					</p>
					<ul>
						<li>
							<code>solveFromControlPoints(initial, points, opts)</code> returns
							camera, rms and per-point residuals; <code>solvedFocal</code> says
							whether f was unlocked.
						</li>
						<li>
							<code>solvePins(prior, aspect, eye, pins, w, h, solveFov)</code>{" "}
							is the variant the picker reaches through{" "}
							<code>Renderer.solvePins</code>.
						</li>
						<li>
							<code>nearbyPeaks</code>, <code>rerankWithTaps</code>,{" "}
							<code>TAP_MAX_PX</code> and <code>isAutoHigh</code> live in{" "}
							<code>candidates.ts</code>.
						</li>
					</ul>
				</Section>
			</Details>
		</>
	);
}
