// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { memo, useEffect, useMemo, useState } from "react";
import {
	Hachure,
	HandDot,
	HandText,
	PenArrow,
	PenCircle,
	PenLine,
	SketchPath,
} from "#/components/gipfelbuch/notebook/Ink";
import {
	CircledNumber,
	HandMark,
	Wash,
} from "#/components/gipfelbuch/notebook/marks";
import { useNotebookPhoto } from "#/components/gipfelbuch/notebook/useNotebookPhoto";
import { SWISS } from "#/components/gipfelbuch/swiss/palette";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import {
	AlignmentStoryProvider,
	Callout,
	CodeRef,
	CrispLine,
	Figure,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	HandLabel,
	HandRange,
	LAYER_STYLE,
	MarginNote,
	Measured,
	PhotoPicker,
	RealPhoto,
	rowsPath,
	Section,
	Steps,
	StoryMap,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
	useTime,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Compare,
	Details,
	Gallery,
	Key,
	Numbers,
	Stages,
	skylineBand,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { Eq, Frac, Op, Sym } from "#/components/gipfelbuch/viz/math";
import { SketchSpill } from "#/components/gipfelbuch/viz/SketchSpill";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// Viewport inference: the solve end to end. Predict the horizon, trace the skyline, align the two, gate, fall back.
// Pipeline facts are from src/lib/geo/pipeline.ts (loadScene, sceneHorizon, cascade / escalate, EYE_ABOVE_GROUND 1.6).
// The yaw-search figure (Fig. 3) reads scripts/gipfelbuch/data-pose-solve.ts output (planCoarse + coarseCost).
// Mechanism numbers are the real defaults in src/lib/geo/solve.ts:
//   yawRange 25 deg, pitchRange 3 deg, grid step max(0.1, 1.5 px), truncated-L1 cutoff 12 px,
//   prior term 0.02 · trunc · ((dy/σyaw)² + (dp/σpitch)²), DEFAULT_SIGMA yaw 15 / pitch 1.5 / roll 1.5 / focal 0.06,
//   ≤ 3 seeds > 1.5 deg apart, Cauchy LM at 4 px, tilt gate 3 deg, accept 0.5 (local) / 0.75 (360° retry).
// Accuracy numbers are from src/lib/geo/README.md (12 hand-registered photos, 2026-09-24).
// The synthetic scene (Fig. D1, D2) is and deterministic; every cost and factor below is computed from it with
// the code's formulas. Fig. D3 and D4 are the hand-registered benchmark (out/eval*/report.json, README table).

const PPD = 12; // display px per degree (≈ a 640 px wide photo with a 53° hfov)
const HFOV = 48;
const N = 64; // skyline columns
const TRUTH = { dy: 9, dp: 0.6 }; // the true pose relative to the sensor prior (compass 9° off, gravity 0.6°)
const TRUNC = 12 / PPD; // 12 px truncated-L1 cutoff, in degrees
const CAUCHY = 4; // px
const SIG = { yaw: 15, pitch: 1.5 };
const DEG = Math.PI / 180;

/** Flat tint of an ink on paper: fill encodes, hatch only decorates. */
const tint = (ink: string, pct: number) => ({
	fill: `color-mix(in srgb, var(--gb-${ink}) ${pct}%, var(--gb-paper))`,
});

const W = 640;
const H0 = 214; // row of elevation 0 under the prior camera

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

// ---------- the synthetic world: a 360° DEM horizon ----------
function mulberry(seed: number) {
	let s = seed;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const PEAKS: { c: number; h: number; w: number }[] = (() => {
	const hand = [
		{ c: -34, h: 4.6, w: 4 },
		{ c: -24, h: 6.4, w: 2.4 },
		{ c: -14, h: 5.2, w: 3.6 },
		{ c: -4, h: 7.6, w: 1.9 },
		{ c: 3, h: 6.1, w: 2.6 },
		{ c: 10, h: 8.9, w: 1.7 },
		{ c: 17, h: 6.6, w: 2.2 },
		{ c: 24, h: 8.1, w: 1.9 },
		{ c: 32, h: 5.4, w: 3.2 },
		{ c: 41, h: 7.2, w: 2.1 },
		{ c: 50, h: 5.8, w: 3.4 },
		{ c: 58, h: 6.9, w: 2.2 },
	];
	const r = mulberry(7);
	const gen: typeof hand = [];
	for (let c = 66; c < 322; c += 5 + r() * 6)
		gen.push({ c: wrap(c), h: 2.5 + r() * 6, w: 1.4 + r() * 3.5 });
	return [...hand, ...gen];
})();
/** DEM skyline elevation (deg) at azimuth `az` (deg, relative to the prior's heading). */
function horizon(az: number) {
	let e = 1.6 + 0.7 * Math.sin(az * DEG * 3) + 0.4 * Math.sin(az * DEG * 7 + 1);
	for (const p of PEAKS) {
		const d = wrap(az - p.c) / p.w;
		if (Math.abs(d) < 4) e = Math.max(e, p.h * Math.exp(-d * d) + 1.2);
	}
	return (
		e +
		0.12 * Math.sin(az * 1.7) +
		0.07 * Math.sin(az * 4.3 + 0.5) +
		0.04 * Math.sin(az * 9.1)
	);
}

// ---------- the photo: per-column skyline observations under the TRUE camera ----------
const OFF = Array.from(
	{ length: N },
	(_, i) => -HFOV / 2 + (HFOV * (i + 0.5)) / N,
);
const TREE = [43, 50]; // a conifer in front of the ridge: confident edge, wrong surface
const NO_SKY = [4, 7]; // a roof at the frame edge: no sky in these columns (NaN)
const OBS: (number | null)[] = OFF.map((o, i) => {
	if (i >= NO_SKY[0] && i <= NO_SKY[1]) return null;
	const e = horizon(TRUTH.dy + o) - TRUTH.dp;
	const jitter = 0.05 * Math.sin(i * 12.9898) + 0.03 * Math.cos(i * 4.1);
	if (i >= TREE[0] && i <= TREE[1]) {
		const k = (i - TREE[0]) / (TREE[1] - TREE[0]);
		return e + 1.8 + 2.4 * (1 - Math.abs(k - 0.5) * 2) + jitter;
	}
	return e + jitter;
});
const VALID = OBS.flatMap((v, i) =>
	v == null ? [] : [{ i, o: OFF[i], e: v }],
);
const COVERAGE = VALID.length / N;

/** Pixel residuals of the DEM horizon under hypothesis (dy, dp) against the observed skyline. */
function residualsPx(dy: number, dp: number) {
	return VALID.map((v) => (horizon(dy + v.o) - dp - v.e) * PPD);
}
/** coarseCost from solve.ts: truncated L1 (deg) averaged, plus the quadratic yaw/pitch prior. */
function coarseCost(dy: number, dp: number, sigYaw = SIG.yaw) {
	let c = 0;
	for (const v of VALID)
		c += Math.min(Math.abs(horizon(dy + v.o) - dp - v.e), TRUNC);
	return (
		c / VALID.length +
		0.02 * TRUNC * ((dy / sigYaw) ** 2 + (dp / SIG.pitch) ** 2)
	);
}
/** Smooth Cauchy cost (what LM descends), deg units, with the Gaussian priors. */
function cauchyCost(dy: number, dp: number) {
	const c = CAUCHY / PPD;
	let s = 0;
	for (const v of VALID) {
		const r = horizon(dy + v.o) - dp - v.e;
		s += (c * c * Math.log(1 + (r / c) ** 2)) / 2;
	}
	return (
		s / VALID.length + 0.004 * ((dy / SIG.yaw) ** 2 + (dp / SIG.pitch) ** 2)
	);
}

const fmt = (v: number, d = 1) =>
	`${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;

const xOf = (o: number) => ((o + HFOV / 2) / HFOV) * W;
const yOf = (e: number) => H0 - e * PPD;
// the photo's silhouette (true camera), finely sampled, plus a nearer hill for depth
const FINE = (() => {
	const pts: [number, number][] = [];
	for (let x = 0; x <= W; x += 4) {
		const o = (x / W) * HFOV - HFOV / 2;
		pts.push([x, yOf(horizon(TRUTH.dy + o) - TRUTH.dp)]);
	}
	const near: [number, number][] = [];
	for (let x = 0; x <= W; x += 8)
		near.push([
			x,
			236 - 18 * Math.sin(x * 0.011 + 0.6) - 9 * Math.sin(x * 0.031),
		]);
	return { pts, near };
})();

// ---- static sketched scene for Fig. 3 (built once; only the stems and the horizon move) ----
const ridgeClosed = `M0 300 ${FINE.pts.map(([x, y]) => `L${x} ${y.toFixed(1)}`).join(" ")} L${W} 300 Z`;
const nearClosed = `M0 300 ${FINE.near.map(([x, y]) => `L${x} ${y.toFixed(1)}`).join(" ")} L${W} 300 Z`;
const TREE_X0 = xOf(OFF[TREE[0]]) - 8;
const TREE_X1 = xOf(OFF[TREE[1]]) + 8;
const TREE_TOP = Math.min(
	...OBS.slice(TREE[0], TREE[1] + 1).map((v) => yOf(v ?? 0)),
);
const ROOF_X1 = xOf(OFF[NO_SKY[1]]) + 5;
const TREE_SHAPES = [0, 1, 2].map((k) => {
	const cx = TREE_X0 + ((TREE_X1 - TREE_X0) * (k + 1)) / 4;
	const top = TREE_TOP + (k === 1 ? 0 : 14);
	return `M${cx} ${top} L${cx + 24} 300 L${cx - 24} 300 Z`;
});
/** The DEM horizon over a wide azimuth span, drawn once; the pose only translates it (x by yaw, y by pitch). */
const HORIZON_SKETCH_D = (() => {
	let d = "";
	for (let v = -52; v <= 52 + 1e-9; v += 0.3)
		d += `${d ? "L" : "M"}${(((v + HFOV / 2) / HFOV) * W).toFixed(1)} ${yOf(horizon(v)).toFixed(1)}`;
	return d;
})();
const LockScene = memo(function LockScene() {
	return (
		<g>
			<Hachure
				d={ridgeClosed}
				seed="vi-ridge"
				color="pencil"
				gap={8}
				opacity={0.32}
			/>
			<Hachure
				d={nearClosed}
				seed="vi-near"
				color="forest"
				gap={4.5}
				opacity={0.55}
			/>
			<SketchPath
				d={`M${FINE.near.map(([x, y]) => `${x} ${y.toFixed(1)}`).join("L")}`}
				seed="vi-near-line"
				data
				color="forest"
				width={1.3}
				passes={1}
			/>
			{TREE_SHAPES.map((d, k) => (
				<g key={d}>
					<Wash
						d={d}
						color="ink"
						seed={`vi-tree-wash-${k}`}
						layers={8}
						opacity={0.1}
						spread={2}
						offset={[0, 0]}
					/>
					<Hachure
						d={d}
						seed={`vi-tree-hatch-${k}`}
						color="forest"
						gap={2.6}
						opacity={0.6}
					/>
					<SketchPath
						d={d}
						seed={`vi-tree-edge-${k}`}
						color="forest"
						width={1.1}
					/>
				</g>
			))}
			<Wash
				d={`M0 0 L${ROOF_X1} 0 L${ROOF_X1} 300 L0 300 Z`}
				color="ink"
				seed="vi-roof-wash"
				layers={6}
				opacity={0.04}
				spread={2}
				offset={[0, 0]}
			/>
			<Hachure
				d={`M0 0 L${ROOF_X1} 0 L${ROOF_X1} 300 L0 300 Z`}
				seed="vi-roof"
				color="ink"
				gap={3.5}
				opacity={0.45}
			/>
			<PenLine
				seed="vi-roof-edge"
				from={[ROOF_X1, 0]}
				to={[ROOF_X1, 300]}
				width={2}
			/>
			{/* the photo's skyline, with one dot per measured column */}
			<SketchPath
				d={`M${FINE.pts.map(([x, y]) => `${x} ${y.toFixed(1)}`).join("L")}`}
				seed="vi-skyline-trace"
				data
				color="ink"
				width={1.8}
				passes={1}
			/>
			{VALID.map((v) => (
				<HandDot
					key={v.i}
					x={xOf(v.o)}
					y={yOf(v.e)}
					r={2.6}
					seed={`vi-col-${v.i}`}
					color="ink"
					opacity={1}
					data
				/>
			))}
			<HandLabel
				x={ROOF_X1 + 10}
				y={290}
				size={13 * (W / 720)}
				color="var(--gb-secondary)"
			>
				roof: no sky, ignored
			</HandLabel>
			<HandLabel
				x={TREE_X0 - 4}
				y={290}
				anchor="end"
				color="var(--gb-red)"
				size={13 * (W / 720)}
			>
				tree: outliers
			</HandLabel>
		</g>
	);
});

// ======================================================================================
// Fig. 3 — the hero: slide the DEM horizon through the camera until it locks onto the photo
// ======================================================================================
function HorizonLock() {
	const [ref, t] = useTime<HTMLDivElement>(9.2);
	const [manual, setManual] = useState<{ dy: number; dp: number } | null>(null);

	// auto: hold at the sensor prior, sweep, overshoot, settle on the solve, then rest
	const auto = (() => {
		const ph = Math.min(t, 9.2); // plays once, rests on the solve
		if (ph < 1.6) return { dy: 0, dp: 0, phase: "prior" as const };
		if (ph > 8.2)
			return { dy: TRUTH.dy, dp: TRUTH.dp, phase: "solved" as const };
		const k = (ph - 1.6) / 6.6;
		const s = 1 - Math.exp(-4.2 * k) * Math.cos(9.5 * k);
		return {
			dy: TRUTH.dy * s - 7 * Math.sin(Math.PI * k) * Math.exp(-3 * k),
			dp: TRUTH.dp * Math.min(1, s * 1.05),
			phase: "search" as const,
		};
	})();
	const pose = manual ?? auto;
	const res = residualsPx(pose.dy, pose.dp);
	const inl = res.filter((r) => Math.abs(r) < CAUCHY).length;
	const cost = cauchyCost(pose.dy, pose.dp);
	const costAtTruth = cauchyCost(TRUTH.dy, TRUTH.dp);
	const costAtPrior = cauchyCost(0, 0);
	const costBar = clamp01(
		(cost - costAtTruth) / (costAtPrior - costAtTruth + 1e-9),
	);

	const phaseLabel = manual
		? "manual"
		: auto.phase === "prior"
			? "phone's guess"
			: auto.phase === "search"
				? "searching"
				: "solved";

	return (
		<Figure
			label="Fig. D1"
			bleed
			caption="Synthetic scene. The photo's skyline (ink, one dot per column) stays fixed; the modelled horizon (brown) slides in yaw and pitch. Stems show the gap per column: blue when it fits, red and faded when the fit ignores it (the tree). Columns under the roof have no sky and are ignored."
		>
			<div ref={ref}>
				{/* the scene runs on past the frame: the photo's ridge stays, the modelled horizon slides */}
				<SketchSpill
					seed="vi-lock"
					bearing={(u) => u * HFOV - HFOV / 2}
					ridges={[
						{
							at: (u) =>
								yOf(horizon(TRUTH.dy + u * HFOV - HFOV / 2) - TRUTH.dp) / 300,
							color: SWISS.ink,
							width: 1.8,
							depth: true,
						},
						{
							at: (u) =>
								(yOf(horizon(u * HFOV - HFOV / 2 + pose.dy)) + pose.dp * PPD) /
								300,
							color: SWISS.contour,
							width: 1.8,
						},
					]}
				>
					<svg
						viewBox={`0 0 ${W} 300`}
						className="block h-auto w-full"
						role="img"
						aria-label="Photo skyline and modelled horizon, with the gap per column"
					>
						<LockScene />
						{/* residual stems: plain segments, length is the exact residual */}
						<g fill="none" strokeLinecap="round">
							{VALID.map((v, k) => {
								const r = res[k];
								const w = 1 / (1 + (r / CAUCHY) ** 2);
								const inlier = Math.abs(r) < CAUCHY;
								return (
									<PenLine
										key={v.i}
										data
										seed={`vi-stem-${v.i}`}
										from={[xOf(v.o), yOf(v.e)]}
										to={[xOf(v.o), yOf(v.e) + r]}
										color={inlier ? "blue" : "red"}
										opacity={0.3 + 0.7 * w}
										width={inlier ? 2.2 : 1.4}
									/>
								);
							})}
						</g>
						{/* projected DEM horizon: one sketched curve, slid by the pose */}
						<g
							transform={`translate(${(-pose.dy * (W / HFOV)).toFixed(2)} ${(pose.dp * PPD).toFixed(2)})`}
						>
							<path
								d={HORIZON_SKETCH_D}
								fill="none"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={5.5}
								style={{
									stroke:
										"color-mix(in srgb, var(--gb-paper) 70%, transparent)",
								}}
							/>
							<SketchPath
								d={HORIZON_SKETCH_D}
								seed="vi-dem-horizon"
								data
								color="brown"
								width={2.8}
								passes={1}
							/>
						</g>
						<HandText x={W - 10} y={20} anchor="end" color="pencil" size={16}>
							{phaseLabel}
						</HandText>
						<HandText x={14} y={24} color="pencil" size={15}>
							{`true offset: compass ${TRUTH.dy}°, gravity ${TRUTH.dp}°`}
						</HandText>
						<HandText
							x={Math.min(W - 150, TREE_X1 + 26)}
							y={TREE_TOP - 34}
							color="red"
							size={15}
						>
							the tree: ignored by the fit
						</HandText>
						<PenArrow
							from={[Math.min(W - 150, TREE_X1 + 26) + 10, TREE_TOP - 28]}
							to={[(TREE_X0 + TREE_X1) / 2 + 6, TREE_TOP - 4]}
							seed="vi-note-tree"
							color="red"
							width={1.3}
						/>
					</svg>
				</SketchSpill>
			</div>

			<div className="mt-4 grid gap-4 md:grid-cols-[1fr_auto]">
				<div className="space-y-3">
					<Slider
						label="yaw offset from compass"
						value={pose.dy}
						min={-25}
						max={25}
						step={0.1}
						unit="°"
						onChange={(v) => setManual({ dy: v, dp: pose.dp })}
					/>
					<Slider
						label="pitch offset from gravity"
						value={pose.dp}
						min={-3}
						max={3}
						step={0.05}
						unit="°"
						onChange={(v) => setManual({ dy: pose.dy, dp: v })}
					/>
					<div className="flex flex-wrap gap-2 pt-1">
						<button
							type="button"
							onClick={() => setManual(null)}
							disabled={!manual}
							className="bg-[var(--gb-paper-deep)] px-3 py-1 font-sans text-[13px] leading-[18px] text-[var(--gb-ink)] transition hover:brightness-95 disabled:opacity-60"
						>
							{manual ? "↻ replay" : "playing"}
						</button>
						<button
							type="button"
							onClick={() => setManual({ ...TRUTH })}
							className="bg-[var(--gb-paper-deep)] px-3 py-1 font-sans text-[13px] leading-[18px] text-[var(--gb-ink)] transition hover:brightness-95 disabled:opacity-60"
						>
							snap to solution
						</button>
					</div>
				</div>
				<dl
					className={`grid min-w-0 grid-cols-2 md:min-w-[220px] gap-x-5 gap-y-2 font-mono ${TYPE.micro}`}
				>
					<Read k="yaw offset" v={`${fmt(pose.dy)}°`} />
					<Read k="pitch offset" v={`${fmt(pose.dp, 2)}°`} />
					<Read k="columns within 4 px" v={`${inl} / ${VALID.length}`} />
					<Read k="sky coverage" v={`${Math.round(COVERAGE * 100)} %`} />
					<div className="col-span-2">
						<dt className="gb-secondary">fit cost</dt>
						<dd className="mt-1">
							<svg
								viewBox="0 0 220 12"
								className="block h-3 w-full"
								aria-hidden="true"
							>
								<PenLine
									seed="vi-cost-track"
									from={[0, 10]}
									to={[220, 10]}
									color="faint"
									width={0.9}
								/>
								<Wash
									d={`M0 2H${220 * (0.04 + 0.96 * costBar)}V10H0Z`}
									color="brown"
									seed="vi-cost-wash"
									layers={8}
									opacity={0.12}
									spread={1}
									offset={[0, 0]}
								/>
								<PenLine
									seed="vi-cost-fill"
									data
									from={[0, 6]}
									to={[220 * (0.04 + 0.96 * costBar), 6]}
									color="brown"
									width={4}
								/>
							</svg>
						</dd>
					</div>
				</dl>
			</div>
		</Figure>
	);
}

function Slider({
	label,
	value,
	min,
	max,
	step,
	unit,
	onChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	unit: string;
	onChange: (v: number) => void;
}) {
	return (
		<div className="block">
			<span
				className={`flex justify-between font-mono gb-secondary ${TYPE.micro}`}
			>
				<span>{label}</span>
				<span className="gb-ink">
					{fmt(value, step < 0.1 ? 2 : 1)}
					{unit}
				</span>
			</span>
			<HandRange
				min={min}
				max={max}
				step={step}
				value={value}
				label={label}
				onChange={onChange}
			/>
		</div>
	);
}

function Read({ k, v }: { k: string; v: string }) {
	return (
		<div>
			<dt className="gb-secondary">{k}</dt>
			<dd className={`gb-ink ${TYPE.caption}`}>{v}</dd>
		</div>
	);
}

// ======================================================================================
// Fig. 4 — the coarse grid, its seeds, and LM descending from each
// ======================================================================================
const GRID = (() => {
	const dys: number[] = [];
	for (let dy = -25; dy <= 25 + 1e-9; dy += 0.5) dys.push(dy);
	const dps: number[] = [];
	for (let dp = -3; dp <= 3 + 1e-9; dp += 0.25) dps.push(dp);
	const c = dys.map((dy) => dps.map((dp) => coarseCost(dy, dp)));
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const row of c)
		for (const v of row) {
			lo = Math.min(lo, v);
			hi = Math.max(hi, v);
		}
	// per-yaw best over pitch, exactly as coarseStage does
	const yawCosts = dys.map((dy, i) => {
		let best = { dy, dp: 0, c: Number.POSITIVE_INFINITY };
		dps.forEach((dp, j) => {
			if (c[i][j] < best.c) best = { dy, dp, c: c[i][j] };
		});
		return best;
	});
	const minima = yawCosts
		.filter(
			(v, i) =>
				(i === 0 || v.c <= yawCosts[i - 1].c) &&
				(i === yawCosts.length - 1 || v.c <= yawCosts[i + 1].c),
		)
		.sort((a, b) => a.c - b.c);
	const seeds: typeof minima = [];
	for (const m of minima) {
		if (seeds.every((s) => Math.abs(s.dy - m.dy) > 1.5)) seeds.push(m);
		if (seeds.length === 3) break;
	}
	const runnerUp = minima.find((m) => Math.abs(m.dy - minima[0].dy) > 2);
	const sorted = yawCosts.map((v) => v.c).sort((a, b) => a - b);
	const spread = sorted[Math.floor(sorted.length / 2)] - minima[0].c;
	const ambiguity =
		runnerUp && spread > 0
			? Math.max(0, Math.min(1, 1 - (runnerUp.c - minima[0].c) / spread))
			: 0;
	// LM-like descent on the smooth Cauchy cost from each seed (shown in yaw–pitch only)
	const paths = seeds.map((s) => {
		let p = [s.dy, s.dp];
		const out: [number, number][] = [[p[0], p[1]]];
		let lr = 6;
		let f = cauchyCost(p[0], p[1]);
		for (let k = 0; k < 60; k++) {
			const h = 0.02;
			const gx =
				(cauchyCost(p[0] + h, p[1]) - cauchyCost(p[0] - h, p[1])) / (2 * h);
			const gy =
				(cauchyCost(p[0], p[1] + h) - cauchyCost(p[0], p[1] - h)) / (2 * h);
			const q = [
				p[0] - lr * gx,
				Math.max(-3, Math.min(3, p[1] - lr * 0.15 * gy)),
			];
			const fq = cauchyCost(q[0], q[1]);
			if (fq < f) {
				p = q;
				f = fq;
				lr *= 1.3;
				out.push([p[0], p[1]]);
			} else lr *= 0.5;
		}
		return { pts: out, cost: f };
	});
	const win = paths.reduce((b, p, i) => (p.cost < paths[b].cost ? i : b), 0);
	return {
		dys,
		dps,
		c,
		lo,
		hi,
		yawCosts,
		seeds,
		ambiguity,
		paths,
		win,
		runnerUp,
	};
})();

const x0 = 46;
const x1 = 626;
const y0 = 14;
const y1 = 184;
const sx = (dy: number) => x0 + ((dy + 25) / 50) * (x1 - x0);
const sy = (dp: number) => y1 - ((dp + 3) / 6) * (y1 - y0);

/** Heat map ramp: cost rank in 12 steps, paper (cheapest valley) to deep brown. Fill encodes the cost. */
const HEAT_LEVELS = 12;
const heatPct = (level: number) => 6 + (level / (HEAT_LEVELS - 1)) * 80;
const heatPaths = (() => {
	const { dys, dps, c } = GRID;
	// Rank, not min–max: a few huge costs would otherwise crush every valley into the same dark.
	const sorted = c.flat().sort((a, b) => a - b);
	const rank = (v: number) => {
		let lo = 0;
		let hi = sorted.length;
		while (lo < hi) {
			const m = (lo + hi) >> 1;
			if (sorted[m] < v) lo = m + 1;
			else hi = m;
		}
		return lo / (sorted.length - 1);
	};
	const levelOf = (v: number) =>
		Math.min(HEAT_LEVELS - 1, Math.floor(rank(v) * HEAT_LEVELS));
	const cw = (x1 - x0) / dys.length;
	const ch = (y1 - y0) / dps.length;
	const out: string[] = Array.from({ length: HEAT_LEVELS }, () => "");
	for (let j = 0; j < dps.length; j++) {
		let i = 0;
		while (i < dys.length) {
			const level = levelOf(c[i][j]);
			let end = i;
			while (end + 1 < dys.length && levelOf(c[end + 1][j]) === level) end++;
			const left = sx(dys[i]) - cw / 2;
			const right = sx(dys[end]) + cw / 2;
			const top = sy(dps[j]) - ch / 2;
			// overlap by 0.4 px so rows do not show hairline seams
			out[level] +=
				`M${left.toFixed(1)} ${top.toFixed(1)}H${right.toFixed(1)}V${(top + ch + 0.4).toFixed(1)}H${left.toFixed(1)}Z`;
			i = end + 1;
		}
	}
	return out;
})();

/** The static cost map, rendered once: a graded brown tint per cost-rank step (paper = cheapest valley). */
const HeatCells = memo(function HeatCells() {
	return (
		<g>
			{heatPaths.map((d, level) =>
				d ? (
					<path
						key={`heat-${heatPct(level)}`}
						d={d}
						style={tint("contour", heatPct(level))}
					/>
				) : null,
			)}
		</g>
	);
});

function CostLandscape() {
	const [ref, t] = useTime<HTMLDivElement>(7);
	const { yawCosts, seeds, ambiguity, paths, win } = GRID;
	const cells = <HeatCells />;
	// 1-D yaw profile (best over pitch)
	const p0 = 214;
	const p1 = 290;
	const yc = yawCosts.map((v) => v.c);
	const ylo = Math.min(...yc);
	const yhi = Math.max(...yc);
	const py = (v: number) => p1 - ((yhi - v) / (yhi - ylo)) * (p1 - p0);
	const prof = yawCosts
		.map(
			(v, i) => `${i ? "L" : "M"}${sx(v.dy).toFixed(1)} ${py(v.c).toFixed(1)}`,
		)
		.join("");
	const prog = clamp01((t - 1) / 4.5); // draws once, rests with every path and "solved"
	const tickFill = "color-mix(in oklab, var(--gb-ink) 55%, transparent)";

	return (
		<Figure
			label="Fig. D2"
			bleed
			caption={`Synthetic scene. Coarse search, then fine. The map shows the cost of each yaw and pitch shift within ±25° and ±3° of the phone's guess; darker is worse. Below: the best cost per yaw. Up to three separate valleys become starting points (rings); a fine fit runs from each and the cheapest wins. Ambiguity here: ${ambiguity.toFixed(2)} (how close the runner-up valley comes to the best).`}
		>
			<div ref={ref}>
				<svg
					viewBox="0 0 640 332"
					className="block h-auto w-full"
					role="img"
					aria-label="Yaw-pitch cost map with starting points and fit paths"
				>
					{cells}
					{/* legend: three steps of the cost scale */}
					{heatPaths.map((_, level) => (
						<rect
							key={`legend-${heatPct(level)}`}
							x={x0 + level * 9}
							y={316}
							width={9.5}
							height={10}
							style={tint("contour", heatPct(level))}
						/>
					))}
					<HandLabel
						x={x0 + HEAT_LEVELS * 9 + 8}
						y={325}
						size={9.78}
						color="var(--gb-secondary)"
					>
						lower cost → higher cost
					</HandLabel>
					{/* open map corner instead of a box */}
					<PenLine
						seed="vi-cost-left"
						from={[x0, y0]}
						to={[x0, y1]}
						color="pencil"
						width={1}
					/>
					<PenLine
						seed="vi-cost-bottom"
						from={[x0, y1]}
						to={[x1, y1]}
						color="pencil"
						width={1}
					/>
					{/* prior crosshair */}
					<PenLine
						seed="vi-prior-line"
						from={[sx(0), y0]}
						to={[sx(0), p1]}
						color="pencil"
						width={1.2}
						dash="3 4"
					/>
					<HandLabel
						x={sx(0) + 6}
						y={y0 + 13}
						size={11.56}
						color="var(--gb-secondary)"
					>
						phone's guess
					</HandLabel>
					{/* LM paths */}
					{paths.map((p, k) => {
						const n = Math.max(1, Math.round(prog * (p.pts.length - 1)));
						const pts = p.pts
							.slice(0, n + 1)
							.map(([a, b]): [number, number] => [sx(a), sy(b)]);
						const end = p.pts[n];
						const isWin = k === win;
						return (
							<g key={`lm${p.pts[0][0]}`}>
								<SketchPath
									d={`M${pts.map(([a, b]) => `${a.toFixed(1)} ${b.toFixed(1)}`).join("L")}`}
									seed={`vi-lm-${k}`}
									data
									color={isWin ? "red" : "ink"}
									opacity={isWin ? 1 : 0.65}
									width={isWin ? 2.4 : 1.4}
									passes={1}
								/>
								<HandDot
									x={sx(end[0])}
									y={sy(end[1])}
									r={isWin ? 4 : 3}
									seed={`vi-lm-end-${k}`}
									color={isWin ? "red" : "ink"}
									opacity={1}
									data
								/>
							</g>
						);
					})}
					{seeds.map((s, k) => (
						<g key={`s${s.dy}`}>
							<PenCircle
								center={[sx(s.dy), sy(s.dp)]}
								radiusX={7}
								seed={`vi-seed-${s.dy}`}
								width={1.3}
							/>
							<HandLabel
								x={sx(s.dy)}
								y={sy(s.dp) - 12}
								anchor="middle"
								color="var(--gb-ink)"
								size={11.56}
							>
								{`start ${k + 1}`}
							</HandLabel>
						</g>
					))}
					{prog >= 1 && (
						<HandLabel
							x={sx(paths[win].pts[paths[win].pts.length - 1][0]) + 9}
							y={sy(paths[win].pts[paths[win].pts.length - 1][1]) + 18}
							size={(13 * 640) / 720}
							color={SWISS.red}
						>
							{`solved ${fmt(paths[win].pts[paths[win].pts.length - 1][0])}° yaw`}
						</HandLabel>
					)}
					{/* axes */}
					<g
						className="nb-num"
						fontSize={(11 * 640) / 720}
						style={{ fill: tickFill }}
					>
						{[-3, 0, 3].map((v) => (
							<HandLabel
								key={v}
								x={x0 - 6}
								y={sy(v) + 3}
								anchor="end"
								size={9.8}
							>
								{`${v > 0 ? "+" : ""}${v}°`}
							</HandLabel>
						))}
						{[-25, -15, -5, 5, 15, 25].map((v) => (
							<HandLabel
								key={v}
								x={sx(v)}
								y={p1 + 14}
								anchor="middle"
								size={9.8}
							>
								{`${v > 0 ? "+" : ""}${v}°`}
							</HandLabel>
						))}
					</g>
					<HandLabel
						x={12}
						y={(y0 + y1) / 2}
						rotate={-90}
						anchor="middle"
						size={11.56}
						color="var(--gb-secondary)"
					>
						Δ pitch
					</HandLabel>
					<HandLabel
						x={x1}
						y={p0 - 6}
						anchor="end"
						size={11.56}
						color="var(--gb-secondary)"
					>
						best cost per yaw ↓
					</HandLabel>
					<SketchPath
						d={prof}
						seed="vi-yaw-profile"
						data
						color="ink"
						width={1.8}
						passes={1}
					/>
					{seeds.map((s) => (
						<HandDot
							key={`p${s.dy}`}
							x={sx(s.dy)}
							y={py(s.c)}
							r={3.2}
							seed={`vi-prof-seed-${s.dy}`}
							color="ink"
							opacity={1}
							data
						/>
					))}
					<HandText x={x0 + 8} y={p0 + 8} size={15} color="red">
						{`runner-up valley: ambiguity ${ambiguity.toFixed(2)}`}
					</HandText>
				</svg>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Real data: the actual CPU pipeline (detectSkyline -> computeHorizon -> solvePose, refinePose on reject) on the
// 12 bundled Niederhorn photos, scripts/gipfelbuch/build-data.ts -> public/demo/gipfelbuch/*.json.

const sgn = (v: number, n = 1) =>
	`${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(n)}`;
const median = (a: number[]) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length % 2
		? s[(s.length - 1) / 2]
		: (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// ======================================================================================
// Fig. D6: why this is the default, from the README variants table
// ======================================================================================
const VARIANTS = [
	{ name: "sensors only", acc: 0, ok10: 2, med: "4.0° / 45 px" },
	{ name: "first solver alone", acc: 8, ok10: 9, med: "0.27° / 6.7 px" },
	{ name: "second solver alone", acc: 9, ok10: 9, med: "0.22° / 7.0 px" },
	{
		name: "both solvers",
		acc: 11,
		ok10: 11,
		med: "0.22° / 5.0 px",
		hot: true,
	},
];
function Variants() {
	return (
		<Figure
			label="Fig. D4"
			caption="Same 12 photos. The bar is photos accepted; the tick is photos whose skyline lands within 10 px. No variant has a false accept. Differences under about 0.3° median yaw are inside reference noise."
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
									<>
										<Hachure
											d={`M0 4H${barW}V14H0Z`}
											seed={`variant-bar-${v.name}`}
											color={v.hot ? "red" : "pencil"}
											gap={2}
											width={1}
											opacity={0.85}
										/>
										<PenLine
											seed={`variant-bar-edge-${v.name}`}
											from={[barW, 4]}
											to={[barW, 14]}
											color={v.hot ? "red" : "pencil"}
											width={1.2}
											data
										/>
									</>
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
		// a 0 means the tile cache was warm in the bake, not a measurement: leave it out
	].filter((p) => p.v > 0);
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
									<Hachure
										d={`M${acc.x} 2H${acc.x + Math.max(1, w - 1)}V20H${acc.x}Z`}
										seed={`stage-time-${p.k}`}
										color={p.c}
										gap={1.8}
										width={1.1}
										opacity={0.9}
									/>
									{w > 120 && (
										<HandLabel
											halo={0}
											x={acc.x + 6}
											y={15}
											size={11}
											color="var(--gb-paper)"
										>
											{p.k} {Math.round((p.v / total) * 100)} %
										</HandLabel>
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

type EvalRow = {
	name: string;
	gtQuality: string;
	accepted: boolean;
	rejectReason?: string;
	confidence: number;
};
function GroundTruthEval() {
	const idx = useGipfelbuchIndex();
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
			label="Fig. D3"
			caption={
				<>
					The hand-fitted benchmark, {solve.length} photos. The first solver
					alone accepts {a}; both solvers together accept {b}. The second
					rescues {rescued.join(", ")}. Each cell is one photo: left half first
					solver, right half both, filled when accepted.
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
										<Hachure
											d="M1 2H12V13H1Z"
											seed={`gt-box-1-${r.name}`}
											color="navy"
											gap={1.6}
											width={1.1}
											opacity={0.95}
										/>
									)}
									{c.accepted && (
										<Hachure
											d="M14 2H25V13H14Z"
											seed={`gt-box-14-${r.name}`}
											color="navy"
											gap={1.6}
											width={1.1}
											opacity={0.95}
										/>
									)}
								</svg>
								{r.name.replace("IMG_", "")}
							</div>
							<div className="mt-0.5 gb-secondary">reference {r.gtQuality}</div>
						</div>
					);
				})}
			</div>
		</Figure>
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
			label="Fig. 2"
			bleed
			caption={
				<>
					{d
						? `One photo, five steps, ${fmtMs(d.ms.terrain + d.ms.horizon + d.ms.skyline + d.ms.solve)} in total. The horizon step is most of it.`
						: "One photo, five steps."}{" "}
					<Measured data={d} />
				</>
			}
		>
			<AlignmentStoryProvider initial={0}>
				<Stages
					interval={3600}
					aside={<StoryMap data={d} />}
					stages={[
						{
							label: "Photo",
							caption:
								"We start with the photo and the sensor data the phone recorded.",
							render: () => (
								<RealPhoto bleed data={d} layers={[]} crop={crop} />
							),
						},
						{
							label: "Horizon from the map",
							pose: 0,
							caption: `From the GPS fix we predict the horizon the terrain should make. ${t(d?.ms.horizon)}.`,
							render: () => (
								<RealPhoto bleed data={d} layers={["prior"]} crop={crop} />
							),
						},
						{
							label: "Skyline in the photo",
							pose: 0,
							caption: `We find the skyline in the photo itself. ${t(d?.ms.skyline)}.`,
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
							label: "Align the lines",
							pose: 1,
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
							pose: 1,
							caption:
								"Once the pose is accepted, we label the peaks that line up.",
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
			</AlignmentStoryProvider>
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
				<HandLabel
					x={W - m.r}
					y={sy(cm) + 16}
					anchor="end"
					size={YAW_LABEL}
					color={SWISS.secondary}
				>
					typical gap {cm.toFixed(1)} px
				</HandLabel>
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
				<SketchPath
					d={pts.join("")}
					seed={`yaw-curve-${id}`}
					color="ink"
					width={1.7}
					data
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
				{curve.win && (
					<>
						<HandText
							x={Math.min(
								W - m.r - 4,
								Math.max(m.l + 90, sx(curve.win.dy) + 70),
							)}
							y={Math.max(m.t + 18, sy(px(curve.win.cost)) - 44)}
							size={15}
							color="blue"
							anchor="middle"
							rotate={-2}
						>
							deepest dip: the chosen yaw
						</HandText>
						<PenArrow
							seed={`yaw-note-${id}-${full}`}
							from={[
								Math.min(
									W - m.r - 30,
									Math.max(m.l + 60, sx(curve.win.dy) + 50),
								),
								Math.max(m.t + 24, sy(px(curve.win.cost)) - 36),
							]}
							to={[sx(curve.win.dy), sy(px(curve.win.cost)) - 8]}
							color="blue"
							width={1.1}
						/>
					</>
				)}
				{(full ? [-180, -90, 0, 90, 180] : [-25, -10, 0, 10, 25]).map((v) => (
					<HandLabel
						key={v}
						x={sx(v)}
						y={H - 16}
						anchor="middle"
						size={YAW_LABEL_SMALL}
						color={SWISS.secondary}
					>
						{v > 0 ? "+" : v < 0 ? "−" : ""}
						{Math.abs(v)}°
					</HandLabel>
				))}
				<HandLabel
					x={(m.l + W - m.r) / 2}
					y={H - 2}
					anchor="middle"
					size={YAW_LABEL}
					color={SWISS.secondary}
				>
					yaw offset from the compass
				</HandLabel>
				<HandLabel
					x={m.l - 6}
					y={sy(ymax * 0.5)}
					anchor="end"
					size={YAW_LABEL_SMALL}
					color={SWISS.secondary}
				>
					{(ymax * 0.5).toFixed(0)} px
				</HandLabel>
				<HandLabel
					x={m.l - 6}
					y={sy(0) + 3}
					anchor="end"
					size={YAW_LABEL_SMALL}
					color={SWISS.secondary}
				>
					0
				</HandLabel>
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
				{" · "}rival margin {a.toFixed(2)}
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
			label="Fig. 3"
			bleed
			caption={
				<>
					Cost of every yaw on a real photo. The{" "}
					<span style={{ color: "var(--gb-water)" }}>deepest dip</span> is the
					answer; the <span style={{ color: RUNNER_C }}>runner-up</span> is the
					nearest rival. Pick a marker to see the horizon at that yaw.{" "}
					<Measured data={d} />
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
				bleed
				data={d}
				layers={[
					"skyline",
					...(hyp === "compass" ? (["prior"] as const) : []),
					...(hyp === "best" ? (["solved"] as const) : []),
				]}
				crop={crop}
				// the drawn rival line is the horizon at the runner-up yaw: mark that bearing in the margins
				spillCursor={
					// the drawn rival (runnerRows) is the local search's runner-up, whatever the curve shown
					hyp === "runner" && d && ps?.local?.runner
						? {
								az: d.prior.yaw + ps.local.runner.dy,
								label: "runner-up",
								layer: "prior",
							}
						: undefined
				}
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
					With no compass reading, similar dips appear all around the circle.
					That is why the unknown-heading search needs a higher bar.
				</p>
			)}
			<Eq
				label="What the dip measures"
				where={[
					{
						sym: "ε",
						c: "skyline",
						text: "elevation of the skyline in column x",
					},
					{
						sym: "h",
						c: "solved",
						text: "elevation of the horizon in that column, after turning the camera by Δψ (yaw) and Δφ (pitch)",
					},
					{ sym: "w", text: "confidence in that column (0 to 1)" },
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

// ======================================================================================
// Details: the method in full (synthetic mechanism figures and the hand-registered benchmark)
// ======================================================================================
const A = (id: string, label: string) => (
	<Link
		to="/gipfelbuch/$concept"
		params={{ concept: id }}
		className="underline decoration-[var(--gb-red)] underline-offset-2 hover:decoration-current"
	>
		{label}
	</Link>
);

function Deep() {
	return (
		<>
			<Section kicker="Inputs" title="Stage by stage">
				<Steps
					steps={[
						{
							title: "Read the phone’s sensors",
							body: (
								<>
									From the photo&rsquo;s metadata: GPS, heading, 35 mm focal
									length and the gravity vector. Gravity gives pitch and roll,
									the compass gives yaw, the focal length gives pixels. The
									result is a first-guess camera, the {A("photo", "prior")}. If
									gravity, heading or focal length is missing, the photo takes
									the {A("unknown-pose", "unknown-pose")} route.
								</>
							),
						},
						{
							title: "Load the terrain",
							body: (
								<>
									Height tiles around the GPS fix (
									{A("dem-source", "terrain model")}). The camera sits at the
									higher of GPS altitude and ground + 1.6 m, so a bad altitude
									cannot place it underground.
								</>
							),
						},
						{
							title: "Predict the horizon",
							body: (
								<>
									The {A("dem-horizon", "terrain horizon")}: for each of 7,200
									directions, the highest angle the terrain reaches, with
									curvature and refraction. The fast method takes about 0.3 s;
									the classic ray-march took 3.9 to 8.1 s per photo and is the
									fallback.
								</>
							),
						},
						{
							title: "Find the skyline",
							body: (
								<>
									The {A("skyline", "skyline")} in the photo: a sky colour
									model, then the best boundary per pixel column, each with a
									weight. About 160 ms at 800 px. Columns with no sky (a roof, a
									hand) are ignored.
								</>
							),
						},
					]}
				/>
			</Section>

			<Section kicker="Search" title="Coarse grid, then fine fit">
				<p>
					A fine fit that starts in the wrong place stays there. So the solver
					first scores every small shift on a grid. Yaw is searched ±25° around
					the compass and pitch ±3° around gravity, in steps of about 1.5 px. A
					column more than 12 px off counts the same however far off it is. The
					best low-cost points, up to three and at least 1.5° apart, become
					starting points.
				</p>
				<p>
					From each start, a fine fit adjusts yaw, pitch, roll and focal,
					ignoring columns far off (beyond about 4 px). Soft limits keep the
					result near the sensors (yaw 15°, pitch 1.5°, roll 1.5°, focal 6 %).
					The result with the lowest cost is kept.
				</p>
			</Section>

			<HorizonLock />
			<CostLandscape />

			<Section kicker="Gate" title="Rejecting unreliable results">
				<p>
					The result is then given a confidence score. The tilt check rejects
					fits that moved more than 3° from gravity, which only happens on the
					wrong edge. The other factors ask: did enough columns agree, was there
					enough skyline, was the winner clearly better than the runner-up, and
					is there enough relief to fix yaw? The bar is 0.5, and 0.75 for the
					360° retry: a full-circle search at 0.5 accepted IMG_7053 at −123.7°,
					a look-alike stretch of ridge. The {A("accept-rule", "accept rule")}{" "}
					takes each factor apart.
				</p>
			</Section>

			<Section
				kicker="If it fails"
				title="If a result is rejected, try another method"
			>
				<p>
					A rejection passes the photo to a different method that fails in
					different cases. The first accepting step wins:
				</p>
				<Steps
					steps={[
						{
							title: "Normal search",
							body: "Grid, fine fit and check, as above. If accepted, done.",
						},
						{
							title: "Full-circle retry",
							body: "After a low-confidence reject, the compass limit is dropped, the search covers ±180°, and the bar rises to 0.75. With no heading in the file, this is the first pass.",
						},
						{
							title: "Second solver",
							body: (
								<>
									{A("fft-yaw-refine", "A second, independent solver")} gets the
									same first guess, horizon and skyline. It compares the skyline
									with the full-circle horizon and scores every yaw shift at
									once, with free pitch and roll. If neither accepts, the first
									solver&rsquo;s result is kept: with no heading, the
									second&rsquo;s rejected pose can be 130 to 175° off.
								</>
							),
						},
						{
							title: "Tap a peak",
							body: (
								<>
									If nothing is accepted, the phone&rsquo;s guess is shown as
									unverified and you can {A("tap-a-peak", "tap a peak")}. One
									tap fixes yaw and pitch, two add roll, three or more add focal
									({A("gcp-solver", "control-point solver")}).
								</>
							),
						},
					]}
				/>
				<p>
					The first solver is fast and reliable whenever the compass is roughly
					right. The second costs 0.4 to 1.3 s in total and fails differently,
					so it only runs where the first gave up. Together they accept more
					photos than either alone.
				</p>
			</Section>

			<GroundTruthEval />
			<Variants />
			<p className={`!mt-3 gb-secondary ${TYPE.caption}`}>
				Worst accepted yaw error on the 12 hand-registered photos: 0.47°. On 100
				photos checked by hand, at the 0.75 bar the solver makes 22 accepts, all
				correct.
			</p>
			<Callout tone="lesson" title="A wrong pose is worse than no pose">
				Every threshold makes the solver reject a photo rather than risk
				accepting a wrong pose. A neural sky model fitted more photos but was
				dropped because it produced one false accept (IMG_7053, 5.6° off).
			</Callout>

			<Section kicker="In the code" title="Where to look">
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/geo/camera.ts" />
					<CodeRef path="src/lib/geo/lm.ts" />
					<CodeRef path="src/lib/refine/init.ts" />
					<CodeRef path="src/lib/geo/control-points.ts" />
					<CodeRef path="src/lib/integration/unknown-pose.ts" />
				</div>
			</Section>
		</>
	);
}

// ======================================================================================
// Explainer front page (the figures above are folded into Details)
// ======================================================================================
const PRIOR_C = LAYER_STYLE.prior.color;
const SOLVED_C = LAYER_STYLE.solved.color;

/** Per-column |detected − DEM| at the prior and solved pose, over columns that vote. */
function ResidualStrip({ d }: { d: GipfelbuchPhotoData }) {
	const CAP = 40;
	const n = d.skyline.rows.length;
	const path = (dem: (number | null)[]) => {
		let out = "";
		let pen = false;
		for (let x = 0; x < n; x++) {
			const a = d.skyline.rows[x];
			const b = dem[x];
			if (a == null || b == null || d.skyline.weight[x] < 0.1) {
				pen = false;
				continue;
			}
			const e = Math.min(CAP, Math.abs(a - b));
			out += `${pen ? "L" : "M"}${x} ${(58 - (e / CAP) * 54).toFixed(1)}`;
			pen = true;
		}
		return out;
	};
	return (
		<svg
			viewBox={`0 0 ${n} 64`}
			className="mt-2 block h-auto w-full"
			role="img"
			aria-label="Gap between photo skyline and modelled horizon per column, at the phone's guess and solved"
		>
			<PenLine
				seed="vi-strip-base"
				from={[0, 58]}
				to={[n, 58]}
				color="pencil"
				width={1}
			/>
			<PenLine
				seed="vi-strip-cap"
				from={[0, 4]}
				to={[n, 4]}
				color="pencil"
				opacity={0.5}
				width={0.8}
				dash="3 5"
			/>
			<SketchPath
				d={path(d.priorRows)}
				seed="vi-strip-prior"
				data
				color={PRIOR_C}
				width={Math.max(1.4, n / 480)}
				dash="5 3"
				passes={1}
			/>
			<SketchPath
				d={path(d.solvedRows)}
				seed="vi-strip-solved"
				data
				color={SOLVED_C}
				width={Math.max(1.6, n / 440)}
				passes={1}
			/>
			<HandLabel x={4} y={16} size={11 * (n / 720)} color="var(--gb-secondary)">
				gap {CAP} px
			</HandLabel>
			<HandLabel x={4} y={55} size={11 * (n / 720)} color="var(--gb-secondary)">
				0
			</HandLabel>
		</svg>
	);
}

function HeroCompare() {
	const [photoId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photoId);
	const crop = useMemo(() => (d ? skylineBand(d) : undefined), [d]);
	return (
		<Figure
			ground={d?.id}
			label="Fig. 1"
			bleed
			caption={
				<>
					{d
						? d.solved.accepted
							? `The phone's compass was ${Math.abs(d.solved.delta.yaw).toFixed(1)}° off here. Slide to snap the map's horizon onto the ridge.`
							: `The solver moved the compass ${Math.abs(d.solved.delta.yaw).toFixed(1)}°, but the fit was rejected (confidence ${d.solved.confidence.toFixed(2)}), so the app keeps the phone's guess. Slide to see why.`
						: "Slide between the phone's guess and the solved view."}{" "}
					<Key color={PRIOR_C} dashed>
						horizon at the phone's guess
					</Key>{" "}
					<Key color={SOLVED_C}>horizon at the solved view</Key>{" "}
					<Key color={LAYER_STYLE.skyline.color}>skyline in the photo</Key>.{" "}
					<Measured data={d} />
				</>
			}
		>
			<AlignmentStoryProvider>
				<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_15rem] lg:items-start">
					{/* the spill keeps off the story map on the right */}
					<div className="min-w-0" data-gb-bleed-bounds="right">
						<Compare
							before={
								<RealPhoto
									data={d}
									layers={["skyline", "prior"]}
									crop={crop}
									bleed
								/>
							}
							after={
								<RealPhoto
									data={d}
									layers={["skyline", "solved"]}
									crop={crop}
									bleed
								/>
							}
							beforeLabel="phone's guess"
							afterLabel="solved"
							start={0.5}
						/>
					</div>
					<StoryMap data={d} crop={crop} />
				</div>
			</AlignmentStoryProvider>
			{d && (
				<>
					<ResidualStrip d={d} />
					<p className={`mt-1 font-mono gb-secondary ${TYPE.micro}`}>
						Gap per column, dashed at the guess, solid when solved. Median{" "}
						{d.residual.prior.median.toFixed(1)} px at the guess,{" "}
						{d.residual.solved.median.toFixed(1)} px solved (
						{d.residual.solved.n} columns).
					</p>
				</>
			)}
		</Figure>
	);
}

/** Phone-vs-now camera table for the hero photo, like the landing scene's readout. */
function CameraTable({ d }: { d: GipfelbuchPhotoData }) {
	const rows: [string, string, string][] = [
		["yaw", `${d.prior.yaw.toFixed(1)}°`, `${d.solved.yaw.toFixed(1)}°`],
		["pitch", `${sgn(d.prior.pitch)}°`, `${sgn(d.solved.pitch)}°`],
		["roll", `${sgn(d.prior.roll)}°`, `${sgn(d.solved.roll)}°`],
		["focal (px, 800 px frame)", d.prior.f.toFixed(0), d.solved.f.toFixed(0)],
	];
	return (
		<table className="mt-3 w-full max-w-md font-mono text-[13px] leading-[18px]">
			<thead>
				<tr className="text-left gb-secondary">
					<th className="font-normal" />
					<th className="font-normal" style={{ color: "var(--gb-red)" }}>
						phone
					</th>
					<th className="font-normal" style={{ color: "var(--gb-water)" }}>
						solved
					</th>
				</tr>
			</thead>
			<tbody className="gb-ink">
				{rows.map(([k, a, b]) => (
					<tr
						key={k}
						className="border-t border-[color-mix(in_srgb,var(--gb-ink)_18%,transparent)]"
					>
						<td className="py-1 gb-secondary">{k}</td>
						<td>{a}</td>
						<td>{b}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function SolveEquation() {
	const [photoId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photoId);
	return (
		<>
			<Eq
				label="What the solver minimises"
				where={[
					{
						sym: "r",
						c: "skyline",
						text: "skyline row the photo shows in column x",
					},
					{
						sym: "h",
						c: "solved",
						text: "row where the map's horizon lands, for camera θ",
					},
					{ sym: "w", text: "confidence in that column (0 for no sky)" },
					{ sym: "θ", text: "yaw, pitch, roll and focal length" },
					{
						sym: "ρ",
						text: "robust loss: a column far off, like a tree, has a capped effect on the fit",
					},
				]}
			>
				<Sym c="solved">θ</Sym>* = <Op op="argmin" under={<Sym>θ</Sym>} />{" "}
				<Op op="Σ" under={<Sym>x</Sym>} /> <Sym>w</Sym>
				<sub>x</sub> ρ(<Sym c="skyline">r</Sym>
				<sub>x</sub> − <Sym c="solved">h</Sym>
				<sub>x</sub>(<Sym>θ</Sym>))
			</Eq>
			{d && <CameraTable d={d} />}
		</>
	);
}

function Verdicts() {
	return (
		<Figure
			label="Fig. 5"
			caption={
				<>
					All 12 photos at the solved view. Under each: compass error found,
					then skyline gap in px, guess → solved. A tag over the label marks
					result and failure; photo 12 passed only through a second solver.
				</>
			}
		>
			<Gallery
				cols={4}
				tile={(d) => (
					<RealPhoto
						data={d}
						layers={["skyline", "solved"]}
						crop={skylineBand(d, 260)}
					/>
				)}
				tone={(d) =>
					!d.solved.accepted
						? "failure"
						: d.solved.stage === "refine"
							? "caution"
							: "result"
				}
				tag={(d) =>
					d.solved.accepted && d.solved.stage === "refine"
						? "2nd solver"
						: undefined
				}
				label={(d) => (
					<>
						{d.id.slice(-2)} · {sgn(d.solved.delta.yaw)}° ·{" "}
						{d.residual.prior.median.toFixed(0)} →{" "}
						{d.residual.solved.median.toFixed(1)} px
					</>
				)}
			/>
		</Figure>
	);
}

function ViewportInference({ node: _node }: { node: GipfelbuchNode }) {
	const idx = useGipfelbuchIndex();
	const P = idx?.photos;
	const OK = P ? P.filter((p) => p.accepted) : null;
	const medYaw = OK ? median(OK.map((p) => Math.abs(p.delta.yaw))) : null;
	const medPrior = OK ? median(OK.map((p) => p.residual.prior.median)) : null;
	const medSolved = OK ? median(OK.map((p) => p.residual.solved.median)) : null;
	const acc = OK ? OK.length : null;
	const first = OK ? OK.filter((p) => p.stage === "solve").length : null;
	return (
		<>
			<HeroCompare />

			<SolveEquation />

			<Beat kicker="The idea" title="The skyline corrects the compass.">
				<p>
					A phone records where it is. Its compass is often several degrees off.{" "}
					{medYaw != null && (
						<>
							<HandMark type="strike">Close enough.</HandMark>{" "}
							<span className="nb-hand" style={{ color: "var(--nb-red)" }}>
								{medYaw.toFixed(1)}° median error
							</span>
						</>
					)}
					<MarginNote mark="a">
						When the compass and the ridge disagree, the ridge is used.
					</MarginNote>
				</p>
				<p>
					The photo has a skyline. The terrain model predicts the same line (the
					horizon) from that spot.{" "}
					<HandMark type="highlight">
						We shift the horizon until it matches the skyline.
					</HandMark>
				</p>
				<p>
					<strong>Yaw</strong> is which way the camera points. Pitch is up or
					down, roll is tilt. GPS fixes the spot, so we solve only these angles
					and the lens.
				</p>
			</Beat>

			<Beat
				kicker="How it works"
				title="Predict the horizon, find the skyline, align the two."
			>
				<p>
					<CircledNumber value={1} /> the terrain predicts a horizon,{" "}
					<CircledNumber value={2} /> the photo gives a skyline,{" "}
					<CircledNumber value={3} /> the camera turns until they overlap.
					Everything runs in the browser, with no neural network.
					<MarginNote mark="b">
						Only four values are solved: yaw, pitch, roll and focal length. The
						GPS position is kept fixed.
					</MarginNote>
				</p>
			</Beat>

			<HeroStages />

			<Beat
				kicker="The search"
				title="Alignment searches for the yaw with the lowest score."
			>
				<p>
					We try every yaw within 25° of the compass and score how far the
					skyline and horizon sit apart.
				</p>
				<p>
					<HandMark type="double">The lowest score is chosen.</HandMark> The
					next-best score shows how far to trust it. A fine fit then adjusts all
					four values; columns far off the fit count less.
				</p>
			</Beat>

			<YawSearch />

			<Beat
				kicker="Two solvers"
				title="Every photo ends in one of three outcomes."
			>
				<p>
					A confidence score gates each result (the{" "}
					{A("accept-rule", "accept rule")}). A rejected photo goes to a second
					solver that fails in different cases.
				</p>
				<Trio
					steps={[
						{
							title: "Accept",
							body: "The lines overlap and confidence is high. Photo 03 reaches 0.87.",
							visual: (
								<OutcomeMini id="demo-03" layers={["skyline", "solved"]} />
							),
						},
						{
							title: "Try a second solver",
							body: "A different method rescues photo 12, which the first rejected.",
							visual: (
								<OutcomeMini id="demo-12" layers={["skyline", "solved"]} />
							),
						},
						{
							title: "Reject and ask",
							body: "Photo 07 stays low-confidence, so the user taps a peak.",
							visual: (
								<OutcomeMini id="demo-07" layers={["skyline", "solved"]} />
							),
						},
					]}
				/>
			</Beat>

			<Beat
				kicker="Where it fails"
				title="When the skyline is wrong, the photo is rejected."
			>
				<p>
					<HandMark type="wavy" color="red">
						A head, a hand or a tree on the ridge looks like a real edge.
					</HandMark>{" "}
					Then too few columns agree and confidence stays low.
					<MarginNote mark="c">
						Photo 11 is rejected and photo 12 is rescued, with the same head on
						the ridge. Why does the second solver cope?
					</MarginNote>
				</p>
				<p>
					We reject the photo and keep the phone's estimate.{" "}
					<HandMark type="double">It is not shown as certain.</HandMark>
					<MarginNote mark="d">
						No wrong answers accepted on 12 hand-registered photos; median yaw
						error 0.22°.
					</MarginNote>
				</p>
			</Beat>

			<Figure
				label="Fig. 4"
				pinned="demo-11"
				caption="Same head on the ridge, two results: the first solver rejects it and the second rescues it."
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
								accepted by the{" "}
								{d.solved.stage === "refine" ? "second" : "first"} solver,
								confidence {d.solved.confidence.toFixed(2)}
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

			<Verdicts />

			<Numbers
				items={[
					{
						value: medYaw == null ? "…" : `${medYaw.toFixed(1)}°`,
						label: "median compass error found, accepted demo photos",
					},
					{
						value:
							medPrior == null || medSolved == null
								? "…"
								: `${medPrior.toFixed(1)} → ${medSolved.toFixed(1)}`,
						label: "median skyline gap in px, guess → solved, accepted photos",
					},
					{
						value: acc == null ? "…" : `${acc} / 12`,
						label:
							first == null
								? "demo photos accepted"
								: `demo photos accepted, ${first} by the first solver alone`,
					},
					{
						value: "0.22°",
						label: "median yaw error vs hand registration, 12 photos",
					},
				]}
				source={
					<>
						First three: the 12 demo photos. Last: 12 hand-registered photos. On
						a finer terrain model the demo set has one borderline accept, 1.05°
						off.
					</>
				}
			/>

			<Details>
				<Deep />
			</Details>
		</>
	);
}

export default memo(ViewportInference);
