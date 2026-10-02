// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { memo, useMemo, useState } from "react";
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
	Figure,
	Flow,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	HandLabel,
	HandRange,
	LAYER_STYLE,
	MarginNote,
	Measured,
	type PhotoLayer,
	PhotoPicker,
	Plot,
	RealPhoto,
	Section,
	Stat,
	Steps,
	StoryMap,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
	useReducedMotion,
	useTime,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Compare,
	Details,
	Gallery,
	Key,
	Numbers,
	skylineBand,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { Eq, Op, Sym } from "#/components/gipfelbuch/viz/math";
import { PhotoStory } from "#/components/gipfelbuch/viz/PhotoStory";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// Viewport inference: how a photo's yaw / pitch / roll / focal are solved against the DEM horizon.
// Mechanism numbers are the real defaults in src/lib/geo/solve.ts:
//   yawRange 25 deg, pitchRange 3 deg, grid step max(0.1, 1.5 px), truncated-L1 cutoff 12 px,
//   prior term 0.02 · trunc · ((dy/σyaw)² + (dp/σpitch)²), DEFAULT_SIGMA yaw 15 / pitch 1.5 / roll 1.5 / focal 0.06,
//   ≤ 3 seeds > 1.5 deg apart, Cauchy LM at 4 px, tilt gate 3 deg, accept 0.5 (local) / 0.75 (360° retry).
// Accuracy numbers are from src/lib/geo/README.md (12 hand-registered photos, 2026-09-24).
// The scene itself is synthetic and deterministic; every cost and factor below is computed from it with
// the code's formulas.

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
				roof · no sky · no vote
			</HandLabel>
			<HandLabel
				x={TREE_X0 - 4}
				y={290}
				anchor="end"
				color="var(--gb-red)"
				size={13 * (W / 720)}
			>
				tree · outliers
			</HandLabel>
		</g>
	);
});

// ======================================================================================
// Fig. 3 — the hero: slide the DEM horizon through the camera until it locks onto the photo
// ======================================================================================
function HorizonLock() {
	const [ref, t] = useTime<HTMLDivElement>(7);
	const [manual, setManual] = useState<{ dy: number; dp: number } | null>(null);

	// auto: hold at the sensor prior, sweep, overshoot, settle on the solve, hold, repeat
	const auto = (() => {
		const ph = t % 11;
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
			? "sensor prior"
			: auto.phase === "search"
				? "searching"
				: "solved";

	return (
		<Figure
			label="Fig. D3"
			bleed
			caption="Schematic (synthetic scene). The core move. The photo's skyline (ink trace, one dot per column) is fixed; the DEM horizon (brown) is projected through a hypothesised camera and slid in yaw and pitch. Stems are per-column pixel residuals: blue and bold when inside the 4 px Cauchy scale, red and faded when the robust loss stops listening (the tree, an occluder the DEM does not know). Columns under the roof have no sky and no vote."
		>
			<div ref={ref}>
				<svg
					viewBox={`0 0 ${W} 300`}
					className="block h-auto w-full"
					role="img"
					aria-label="Photo skyline and the projected DEM horizon with per-column residuals"
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
								stroke: "color-mix(in srgb, var(--gb-paper) 70%, transparent)",
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
						{`truth here: compass ${TRUTH.dy}° off, gravity ${TRUTH.dp}°`}
					</HandText>
					<HandText
						x={Math.min(W - 150, TREE_X1 + 26)}
						y={TREE_TOP - 34}
						color="red"
						size={15}
					>
						the tree: the loss stops listening
					</HandText>
					<PenArrow
						from={[Math.min(W - 150, TREE_X1 + 26) + 10, TREE_TOP - 28]}
						to={[(TREE_X0 + TREE_X1) / 2 + 6, TREE_TOP - 4]}
						seed="vi-note-tree"
						color="red"
						width={1.3}
					/>
				</svg>
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
							{manual ? "↻ replay the solve" : "auto-playing"}
						</button>
						<button
							type="button"
							onClick={() => setManual({ ...TRUTH })}
							className="bg-[var(--gb-paper-deep)] px-3 py-1 font-sans text-[13px] leading-[18px] text-[var(--gb-ink)] transition hover:brightness-95 disabled:opacity-60"
						>
							snap to optimum
						</button>
					</div>
				</div>
				<dl
					className={`grid min-w-0 grid-cols-2 md:min-w-[220px] gap-x-5 gap-y-2 font-mono ${TYPE.micro}`}
				>
					<Read k="Δ yaw" v={`${fmt(pose.dy)}°`} />
					<Read k="Δ pitch" v={`${fmt(pose.dp, 2)}°`} />
					<Read k="inliers < 4 px" v={`${inl} / ${VALID.length}`} />
					<Read k="coverage" v={`${Math.round(COVERAGE * 100)} %`} />
					<div className="col-span-2">
						<dt className="gb-secondary">robust cost</dt>
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

// a full-circle yaw profile: the 360° retry (σyaw → 1e6, so no prior pull)
const RING = (() => {
	const pts: { dy: number; c: number }[] = [];
	for (let dy = -180; dy < 180; dy += 1) {
		let best = Number.POSITIVE_INFINITY;
		for (let dp = -3; dp <= 3; dp += 0.5)
			best = Math.min(best, coarseCost(dy, dp, 1e6));
		pts.push({ dy, c: best });
	}
	const lo = Math.min(...pts.map((p) => p.c));
	const hi = Math.max(...pts.map((p) => p.c));
	return { pts, lo, hi };
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
	const [ref, t] = useTime<HTMLDivElement>(9);
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
	const prog = clamp01(((t % 9) - 1) / 4.5);
	const tickFill = "color-mix(in oklab, var(--gb-ink) 55%, transparent)";

	return (
		<Figure
			label="Fig. D4"
			bleed
			caption={`Schematic (synthetic scene). Coarse then fine. The heat map is solve.ts's coarse cost over the ±25° × ±3° window around the prior (truncated L1 at 12 px plus the prior term); paper is cheapest and the brown tint deepens with cost. Below it, the best cost per yaw. Up to three local minima more than 1.5° apart become seeds (rings); Levenberg–Marquardt with a Cauchy loss descends from each, and the cheapest end wins. Ambiguity for this scene: ${ambiguity.toFixed(2)} (how close the runner-up minimum comes to the best, relative to the median).`}
		>
			<div ref={ref}>
				<svg
					viewBox="0 0 640 332"
					className="block h-auto w-full"
					role="img"
					aria-label="Coarse yaw-pitch cost landscape with seeds and LM paths"
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
						cheaper → dearer
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
						prior
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
								{`seed ${k + 1}`}
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
						{`runner-up minimum: ambiguity ${ambiguity.toFixed(2)}`}
					</HandText>
				</svg>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Fig. 5 — the 360° retry: what happens when the compass cannot be trusted
// ======================================================================================
function FullCircle() {
	const [ref, t] = useTime<HTMLDivElement>(3);
	const { pts, lo, hi } = RING;
	const cx = 160;
	const cy = 160;
	const r0 = 70;
	const r1 = 140;
	const rad = (c: number) => r0 + ((hi - c) / (hi - lo)) ** 1.6 * (r1 - r0);
	const at = (dy: number, r: number): [number, number] => [
		cx + r * Math.sin(dy * DEG),
		cy - r * Math.cos(dy * DEG),
	];
	const d = `${pts
		.map(
			(p, i) =>
				`${i ? "L" : "M"}${at(p.dy, rad(p.c))
					.map((v) => v.toFixed(1))
					.join(" ")}`,
		)
		.join("")}Z`;
	const best = pts.reduce((b, p) => (p.c < b.c ? p : b), pts[0]);
	// strongest alias outside ±10° of the best
	const alias = pts
		.filter((p) => Math.abs(wrap(p.dy - best.dy)) > 10)
		.reduce((b, p) => (p.c < b.c ? p : b), {
			dy: 0,
			c: Number.POSITIVE_INFINITY,
		});
	const sweep = (t * 50) % 360;
	const wedge = (a0: number, a1: number, r: number) => {
		const [ax, ay] = at(a0, r);
		const [bx, by] = at(a1, r);
		return `M${cx} ${cy} L${ax.toFixed(1)} ${ay.toFixed(1)} A${r} ${r} 0 0 1 ${bx.toFixed(1)} ${by.toFixed(1)} Z`;
	};
	const [bx, by] = at(best.dy, rad(best.c));
	const [ax, ay] = at(alias.dy, rad(alias.c));
	return (
		<Figure
			label="Fig. D5"
			caption="Schematic. The same scene scored all the way round (yaw prior switched off). Radius grows as the cost falls. The local search only ever sees the shaded ±25° wedge around the compass. When it rejects, solvePose retries over 360°, but repetitive ridges make aliases (the faded spike), so the retry must clear a stricter 0.75 confidence instead of 0.5."
		>
			<div
				ref={ref}
				className="grid items-center gap-5 sm:grid-cols-[minmax(0,320px)_1fr]"
			>
				<svg
					viewBox="0 0 320 320"
					className="mx-auto block h-auto w-full max-w-[320px]"
					role="img"
					aria-label="Polar plot of the yaw cost over 360 degrees"
				>
					<PenCircle
						center={[cx, cy]}
						radiusX={r1}
						seed="vi-ring-outer"
						color="faint"
						width={0.9}
					/>
					<PenCircle
						center={[cx, cy]}
						radiusX={r0}
						seed="vi-ring-inner"
						color="faint"
						width={0.9}
					/>
					{/* the ±25° wedge the local search sees */}
					<Wash
						d={wedge(-25, 25, r1 + 8)}
						color="brown"
						seed="vi-window-wash"
						layers={7}
						opacity={0.05}
						spread={2}
						offset={[0, 0]}
					/>
					<Hachure
						d={wedge(-25, 25, r1 + 8)}
						seed="vi-window"
						color="brown"
						gap={6}
						opacity={0.3}
					/>
					{/* the sweep: one hand-hatched wedge, rotated rather than re-drawn */}
					<g transform={`rotate(${sweep.toFixed(1)} ${cx} ${cy})`}>
						<Hachure
							d={wedge(-6, 0, r1 + 8)}
							seed="vi-sweep"
							color="pencil"
							gap={5}
							opacity={0.55}
						/>
					</g>
					<Wash
						d={d}
						color="brown"
						seed="vi-ring-wash"
						layers={8}
						opacity={0.08}
						spread={1.5}
						offset={[0, 0]}
					/>
					<SketchPath
						d={d}
						seed="vi-ring-cost"
						data
						color="brown"
						width={1.6}
						passes={1}
					/>
					<PenLine
						data
						seed="vi-ring-best"
						from={[cx, cy]}
						to={[bx, by]}
						color="ink"
						width={1.4}
					/>
					<HandDot
						x={bx}
						y={by}
						r={4}
						seed="vi-ring-best-dot"
						color="ink"
						opacity={1}
						data
					/>
					<PenLine
						data
						seed="vi-ring-alias"
						from={[cx, cy]}
						to={[ax, ay]}
						color="red"
						width={1.4}
						dash="3 3"
					/>
					<HandText x={8} y={300} size={14} color="red">
						IMG_7053: this alias won at the 0.5 bar
					</HandText>
					<PenCircle
						center={[ax, ay]}
						radiusX={4.5}
						seed="vi-alias-ring"
						color="red"
						width={1.3}
					/>
					<HandLabel x={cx} y={14} anchor="middle" color="var(--gb-secondary)">
						compass
					</HandLabel>
					<HandLabel
						x={cx}
						y={cy + 5}
						anchor="middle"
						color="var(--gb-secondary)"
					>
						360°
					</HandLabel>
				</svg>
				<div className={`space-y-3 gb-secondary ${TYPE.caption}`}>
					<p>
						<span className={`font-mono gb-ink ${TYPE.caption}`}>best</span>{" "}
						lies at <span className="font-mono gb-ink">{fmt(best.dy, 0)}°</span>{" "}
						from the compass. The strongest alias (
						<span className="font-mono text-[var(--rigi-trap)]">
							{fmt(alias.dy, 0)}°
						</span>
						) is a different stretch of ridge whose silhouette happens to rhyme.
					</p>
					<p>
						The wild benchmark found this for real: a 360° first pass at the
						local 0.5 bar accepted IMG_7053 at −123.7°. Hence{" "}
						<code
							className={`whitespace-nowrap bg-[var(--gb-paper-deep)] px-1 font-mono gb-ink ${TYPE.caption}`}
						>
							FULL_SEARCH_CONFIDENCE = 0.75
						</code>
						.
					</p>
				</div>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Fig. 7 — the accept gate: confidence is a product, so any one weak factor vetoes
// ======================================================================================
type Scene = {
	id: string;
	label: string;
	inlierFraction: number;
	coverage: number;
	ambiguity: number;
	relief: number;
	tiltDeg: number;
	search: "local" | "full";
	note: string;
};

const SCENE_RELIEF = (() => {
	const els: number[] = [];
	for (let a = -HFOV / 2; a <= HFOV / 2; a += 0.25)
		els.push(horizon(TRUTH.dy + a));
	const m = els.reduce((s, v) => s + v, 0) / els.length;
	return Math.sqrt(els.reduce((s, v) => s + (v - m) ** 2, 0) / els.length);
})();
const SCENE_INLIERS =
	residualsPx(TRUTH.dy, TRUTH.dp).filter((r) => Math.abs(r) < CAUCHY).length /
	VALID.length;

const SCENES: Scene[] = [
	{
		id: "this",
		label: "This page's scene",
		inlierFraction: SCENE_INLIERS,
		coverage: COVERAGE,
		ambiguity: GRID.ambiguity,
		relief: SCENE_RELIEF,
		tiltDeg: Math.abs(TRUTH.dp),
		search: "local",
		note: "Computed from Fig. D3–D4: a jagged ridge, a tree and a roof.",
	},
	{
		id: "flat",
		label: "Flat horizon",
		inlierFraction: 0.92,
		coverage: 0.95,
		ambiguity: 0.1,
		relief: 0.18,
		tiltDeg: 0.4,
		search: "local",
		note: "Sea or plain: every column fits, but a flat line cannot pin yaw. Relief vetoes it.",
	},
	{
		id: "forest",
		label: "Trees in front",
		inlierFraction: 0.46,
		coverage: 0.22,
		ambiguity: 0.35,
		relief: 1.6,
		tiltDeg: 0.8,
		search: "local",
		note: "Little sky meets terrain; most edges are branches. Coverage and inliers both drag.",
	},
	{
		id: "rhyme",
		label: "Rhyming ridges, 360°",
		inlierFraction: 0.74,
		coverage: 0.8,
		ambiguity: 0.78,
		relief: 1.4,
		tiltDeg: 0.6,
		search: "full",
		note: "Would pass at 0.5. The full-circle retry demands 0.75, so it falls back to a suggestion.",
	},
	{
		id: "tilt",
		label: "Wrong edge, tilted",
		inlierFraction: 0.88,
		coverage: 0.9,
		ambiguity: 0.15,
		relief: 1.9,
		tiltDeg: 4.2,
		search: "local",
		note: "The fit moved pitch/roll > 3° from gravity: it locked onto the wrong edge. Hard zero.",
	},
];

function factors(s: Scene) {
	return [
		{
			k: "tilt ≤ 3°",
			v: s.tiltDeg > 3 ? 0 : 1,
			raw: `${s.tiltDeg.toFixed(1)}°`,
		},
		{
			k: "inliers",
			v: clamp01((s.inlierFraction - 0.3) / 0.5),
			raw: `${Math.round(s.inlierFraction * 100)} %`,
		},
		{
			k: "coverage",
			v: clamp01(s.coverage / 0.4),
			raw: `${Math.round(s.coverage * 100)} %`,
		},
		{
			k: "distinctness",
			v: clamp01((1 - s.ambiguity) / 0.4 + 0.1),
			raw: `amb ${s.ambiguity.toFixed(2)}`,
		},
		{ k: "relief", v: clamp01(s.relief / 0.5), raw: `${s.relief.toFixed(2)}°` },
	];
}

/** One hand-drawn bar layer; the width change is a clip-path transition so the pen strokes never re-roll. */
function GateBar({
	kind,
	fraction,
}: {
	kind: "track" | "factor" | "running";
	fraction: number;
}) {
	const clip =
		kind === "track"
			? undefined
			: `inset(0 ${(100 - fraction * 100).toFixed(1)}% 0 0)`;
	return (
		<div
			className="absolute inset-0 transition-[clip-path] duration-700 ease-out motion-reduce:transition-none"
			style={{ clipPath: clip }}
		>
			<svg
				className="block h-full w-full"
				viewBox="0 0 400 16"
				preserveAspectRatio="none"
				aria-hidden="true"
			>
				{kind === "track" ? (
					<PenLine
						seed="vi-gatebar-track"
						from={[0, 14]}
						to={[400, 14]}
						color="faint"
						width={0.9}
					/>
				) : kind === "factor" ? (
					<>
						<Wash
							d="M0 1H400V15H0Z"
							color="brown"
							seed="vi-gatebar-wash"
							layers={8}
							opacity={0.1}
							spread={1.2}
							offset={[0, 0]}
						/>
						<Hachure
							d="M0 1H400V15H0Z"
							seed="vi-gatebar-hatch"
							color="brown"
							gap={9}
							opacity={0.5}
						/>
					</>
				) : (
					<PenLine
						seed="vi-gatebar-run"
						from={[0, 8]}
						to={[400, 8]}
						color="ink"
						width={3}
					/>
				)}
			</svg>
		</div>
	);
}

function ConfidenceGate() {
	const [sel, setSel] = useState(SCENES[0].id);
	const s = SCENES.find((x) => x.id === sel) ?? SCENES[0];
	const fs = factors(s);
	let run = 1;
	const cum = fs.map((f) => {
		run *= f.v;
		return run;
	});
	const conf = run;
	const bar = s.search === "full" ? 0.75 : 0.5;
	const ok = conf >= bar;
	return (
		<Figure
			label="Fig. D7"
			caption="Schematic. solve.ts's confidence is a product of five clamped factors, so it is only as strong as its weakest one. The thin ink bar is the running product; the brown bar is each factor; the tick is the accept bar (0.5 for the local search, 0.75 for the 360° retry). The first scene is computed from the figures above; the others are illustrative inputs to the same formula."
		>
			<div className="flex flex-wrap gap-1.5">
				{SCENES.map((x) => (
					<button
						key={x.id}
						type="button"
						aria-pressed={x.id === sel}
						onClick={() => setSel(x.id)}
						className={`px-3 py-1 font-sans text-[13px] leading-[18px] transition ${x.id === sel ? "bg-[var(--gb-ink)] text-[var(--gb-paper)]" : "bg-[var(--gb-paper-deep)] text-[var(--gb-ink)] hover:brightness-95"}`}
					>
						{x.label}
					</button>
				))}
			</div>
			<div className="mt-5 space-y-2.5">
				{fs.map((f, i) => (
					<div
						key={f.k}
						className="grid grid-cols-[92px_1fr_64px] items-center gap-3 sm:grid-cols-[120px_1fr_80px]"
					>
						<span className={`font-mono gb-secondary ${TYPE.micro}`}>
							{f.k}
						</span>
						<div className="relative h-4">
							<GateBar kind="track" fraction={1} />
							<GateBar kind="factor" fraction={f.v} />
							<GateBar kind="running" fraction={cum[i]} />
							<svg
								className="absolute inset-y-[-2px] w-2 -translate-x-1/2"
								style={{ left: `${bar * 100}%`, height: 20 }}
								viewBox="0 0 8 20"
								aria-hidden="true"
							>
								<PenLine
									seed={`vi-gate-bar-${f.k}`}
									from={[4, 1]}
									to={[4, 19]}
									width={1.6}
								/>
							</svg>
						</div>
						<span className={`text-right font-mono gb-secondary ${TYPE.micro}`}>
							{f.v.toFixed(2)} <span className="gb-secondary">· {f.raw}</span>
						</span>
					</div>
				))}
			</div>
			<div className="mt-6 flex flex-wrap items-baseline gap-x-5 gap-y-2 pt-2">
				<span
					className={`font-light [font-variant-numeric:tabular-nums_lining-nums] ${TYPE.h2}`}
					style={{ color: ok ? "var(--nb-forest)" : "var(--nb-red)" }}
				>
					{conf.toFixed(2)}
				</span>
				<span
					className={`font-mono ${TYPE.kicker}`}
					style={{ color: ok ? "var(--nb-forest)" : "var(--nb-red)" }}
				>
					{ok
						? "accepted"
						: s.tiltDeg > 3
							? "rejected · tilt"
							: "rejected · low confidence"}
				</span>
				<span className={`font-mono gb-secondary ${TYPE.micro}`}>
					bar {bar.toFixed(2)} ({s.search === "full" ? "360° retry" : "local"})
				</span>
				<p className={`basis-full gb-secondary ${TYPE.caption}`}>{s.note}</p>
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

/** Crop over the rows the skyline curves occupy, so people at the bottom of the frame stay out. */
function skyBand(d: GipfelbuchPhotoData): [number, number, number, number] {
	const all = [d.skyline.rows, d.priorRows, d.solvedRows]
		.flat()
		.filter((v): v is number => v != null)
		.sort((a, b) => a - b);
	const lo = all[Math.floor(all.length * 0.02)];
	const hi = all[Math.floor(all.length * 0.98)];
	const y0 = Math.max(0, Math.floor(lo - 90));
	const y1 = Math.min(d.photo.height, Math.max(Math.ceil(hi + 60), y0 + 280));
	return [0, y0, d.photo.width, y1];
}

const STAGES: { name: string; layers: PhotoLayer[] }[] = [
	{ name: "1 · sensor prior", layers: ["prior", "priorPeaks"] },
	{ name: "2 · observed skyline", layers: ["prior", "skyline", "weight"] },
	{ name: "3 · solved", layers: ["skyline", "prior", "solved"] },
	{ name: "4 · labelled", layers: ["solved", "peaks"] },
];

function RealStory({
	id,
	setId,
}: {
	id: GipfelbuchPhotoId;
	setId: (i: GipfelbuchPhotoId) => void;
}) {
	const d = useGipfelbuchPhoto(id);
	const idx = useGipfelbuchIndex();
	const reduced = useReducedMotion();
	const [ref, t] = useTime<HTMLDivElement>();
	const [picked, setPicked] = useState<number | null>(null);
	const i = picked ?? (reduced ? 3 : Math.floor(t / 3.5) % 4);
	const st = STAGES[i];
	let line = "";
	if (d) {
		const s = d.solved;
		const lab = d.peaks.filter((p) => p.labelled).length;
		line = [
			`The phone says yaw ${d.prior.yaw.toFixed(1)}°, pitch ${d.prior.pitch.toFixed(1)}°, roll ${d.prior.roll.toFixed(1)}°, vfov ${d.prior.vfov.toFixed(1)}°. The DEM skyline drawn from that guess is ${d.residual.prior.median.toFixed(1)} px off the real one (median over ${d.residual.prior.n} confident columns).`,
			`detectSkyline returns one boundary row per column (yellow) with an evidence weight (ticks above it, longer = surer). The prior curve (dashed) is visibly not on it.`,
			`solvePose (${s.stage}, ${s.search} search) moves yaw ${sgn(s.delta.yaw)}°, pitch ${sgn(s.delta.pitch)}°, roll ${sgn(s.delta.roll)}° and focal ×${s.delta.focal.toFixed(3)}. Median error ${d.residual.prior.median.toFixed(1)} → ${d.residual.solved.median.toFixed(1)} px, confidence ${s.confidence.toFixed(2)}, ${s.accepted ? "accepted" : `rejected (${s.rejectReason})`}.`,
			`With the solved pose the ${lab} labelled peaks (of ${d.peaks.filter((p) => p.visible).length} visible in the DEM) land on their summits.`,
		][i];
	}
	return (
		<Figure
			label="Fig. D1"
			bleed
			caption={
				<>
					<Measured data={d} /> Auto-steps; click a stage to hold it, a
					thumbnail (badge = compass error found) to switch photo. Cropped to
					the skyline band.
				</>
			}
		>
			<div ref={ref}>
				<PhotoPicker
					value={id}
					onChange={setId}
					mark={(k) => {
						const x = idx?.photos.find((p) => p.id === k);
						return x ? (
							<span
								className={`bg-[var(--gb-paper)] px-1 font-mono gb-ink ${TYPE.micro}`}
							>
								{sgn(x.delta.yaw, 0)}°
							</span>
						) : null;
					}}
				/>
				<div className="mb-3 flex flex-wrap gap-1.5" role="tablist">
					{STAGES.map((x, k) => (
						<button
							key={x.name}
							type="button"
							role="tab"
							aria-selected={i === k}
							onClick={() => setPicked(k)}
							className={`px-3 py-1 font-sans text-[13px] leading-[18px] transition ${i === k ? "bg-[var(--gb-ink)] text-[var(--gb-paper)]" : "bg-[var(--gb-paper-deep)] text-[var(--gb-ink)] hover:brightness-95"}`}
						>
							{x.name}
						</button>
					))}
				</div>
				<RealPhoto
					key={`${id}-${i}`}
					data={d}
					layers={st.layers}
					crop={d ? skyBand(d) : undefined}
					maxLabels={6}
				/>
				<p className={`mt-3 min-h-[3.2em] gb-secondary ${TYPE.caption}`}>
					{line}
				</p>
			</div>
		</Figure>
	);
}

function RealGrid({
	sel,
	onPick,
}: {
	sel: GipfelbuchPhotoId;
	onPick: (i: GipfelbuchPhotoId) => void;
}) {
	const idx = useGipfelbuchIndex();
	if (!idx)
		return <div className="h-48 animate-pulse bg-[var(--gb-paper-deep)]" />;
	const P = idx.photos;
	const acc = P.filter((p) => p.accepted).length;
	return (
		<Figure
			label="Fig. D2"
			caption={
				<>
					Measured on the 12 demo photos by scripts/gipfelbuch/build-data.ts,
					2026-10-01. Each tile: compass error found (solved yaw − EXIF
					heading), median skyline error prior → solved. Every correction fits
					inside the ±25° yaw window (largest{" "}
					{Math.max(...P.map((p) => Math.abs(p.delta.yaw))).toFixed(1)}°). A red
					badge = not accepted by solvePose: demo-07 and demo-11 are rejected
					outright; demo-12 was rescued by refinePose.
				</>
			}
		>
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
				{P.map((p) => {
					const bad = !p.accepted || p.stage !== "solve";
					return (
						<button
							key={p.id}
							type="button"
							onClick={() => onPick(p.id)}
							className="overflow-hidden bg-[var(--gb-paper-deep)] text-left transition"
							aria-label={p.id}
						>
							<div
								className="relative aspect-[4/3] overflow-hidden"
								style={{
									outline: p.id === sel ? "2px solid var(--accent)" : "none",
									outlineOffset: -2,
								}}
							>
								<img src={p.thumb} alt="" className="size-full object-cover" />
								<span
									className={`absolute top-1 left-1 px-1 font-mono text-[var(--gb-paper)] ${TYPE.micro}`}
									style={{
										background: bad ? "var(--gb-red)" : "var(--gb-ink)",
									}}
								>
									{p.id.slice(-2)}
								</span>
							</div>
							<div
								className={`px-1.5 py-1 font-mono gb-secondary ${TYPE.micro}`}
							>
								<div className="gb-ink">
									{sgn(p.delta.yaw)}° yaw ·{" "}
									{p.accepted
										? p.stage === "solve"
											? "solve"
											: "refine"
										: "rejected"}
								</div>
								<div>
									{p.residual.prior.median.toFixed(0)} →{" "}
									{p.residual.solved.median.toFixed(1)} px
								</div>
							</div>
						</button>
					);
				})}
			</div>
			<p className={`mt-3 font-mono gb-secondary ${TYPE.micro}`}>
				{acc} / 12 accepted by the cascade; median skyline error{" "}
				{median(P.map((p) => p.residual.prior.median)).toFixed(1)} →{" "}
				{median(P.map((p) => p.residual.solved.median)).toFixed(1)} px.
			</p>
		</Figure>
	);
}

function RealGate() {
	const idx = useGipfelbuchIndex();
	if (!idx)
		return <div className="h-56 animate-pulse bg-[var(--gb-paper-deep)]" />;
	const P = idx.photos;
	return (
		<Figure
			label="Fig. D6"
			caption={
				<>
					Measured on the 12 demo photos (scripts/gipfelbuch/build-data.ts,
					2026-10-01): the confidence solvePose assigned to each, against the
					0.5 accept bar of the local search. The two rejects (demo-07, demo-11)
					fall just under it, 0.46 and 0.44; demo-08 clears it with 0.56. The
					cross-hatched bar is demo-12, where the number is refinePose&apos;s
					own confidence after solvePose was rejected.
				</>
			}
		>
			<Plot
				x={[0.4, 12.6]}
				y={[0, 1]}
				xTicks={12}
				yTicks={4}
				xLabel="demo photo"
				yLabel="confidence"
				fmtX={(v) => (Number.isInteger(v) && v >= 1 && v <= 12 ? `${v}` : "")}
				fmtY={(v) => v.toFixed(2)}
			>
				{(s) => (
					<g>
						{P.map((p, k) => {
							const x = s.x(k + 1);
							const w = (s.x(2) - s.x(1)) * 0.6;
							const top = s.y(p.confidence);
							const base = s.y(0);
							const refine = p.stage !== "solve";
							const color = p.accepted ? "blue" : "red";
							const d = `M${x - w / 2} ${top}H${x + w / 2}V${base}H${x - w / 2}Z`;
							return (
								<g key={p.id}>
									<Wash
										d={d}
										color={color}
										seed={`vi-gate-wash-${p.id}`}
										layers={8}
										opacity={0.12}
										spread={1.2}
										offset={[0, 0]}
									/>
									{!refine && (
										<Hachure
											d={d}
											seed={`vi-gate-solid-${p.id}`}
											color={color}
											gap={5}
											opacity={0.5}
										/>
									)}
									{refine && (
										<Hachure
											d={d}
											seed={`vi-gate-x-${p.id}`}
											color="var(--gb-paper)"
											gap={4}
											opacity={0.6}
											angle={45}
										/>
									)}
									<HandLabel
										x={x}
										y={top - 5}
										anchor="middle"
										size={10}
										color={SWISS.ink}
									>
										{p.confidence.toFixed(2)}
									</HandLabel>
									<PenLine
										seed={`vi-gate-top-${p.id}`}
										from={[x - w / 2, top]}
										to={[x + w / 2, top]}
										color={color}
										width={1.8}
									/>
								</g>
							);
						})}
						<PenLine
							data
							seed="vi-gate-bar-line"
							from={[s.box.x0, s.y(0.5)]}
							to={[s.box.x1, s.y(0.5)]}
							color="ink"
							width={1.4}
							dash="5 4"
						/>
						<HandLabel
							x={s.box.x1 - 2}
							y={s.y(0.5) - 9}
							anchor="end"
							size={11}
							color={SWISS.ink}
						>
							accept bar 0.5 (local)
						</HandLabel>
					</g>
				)}
			</Plot>
		</Figure>
	);
}

function MeasuredStats() {
	const idx = useGipfelbuchIndex();
	if (!idx) return null;
	const P = idx.photos;
	// accepted photos only: a refused solve's yaw is not trusted (same definition as the front Numbers)
	const A = P.filter((p) => p.accepted);
	return (
		<>
			<div className="!mt-6 grid grid-cols-2 gap-5 sm:grid-cols-4">
				<Stat
					value={`${median(A.map((p) => Math.abs(p.delta.yaw))).toFixed(1)}°`}
					label="median compass error corrected, accepted demo photos"
				/>
				<Stat
					value={`${median(A.map((p) => p.residual.prior.median)).toFixed(1)} → ${median(A.map((p) => p.residual.solved.median)).toFixed(1)} px`}
					label="median skyline error, prior → solved, accepted demo photos"
				/>
				<Stat
					value={`${P.filter((p) => p.accepted).length} / 12`}
					label={`accepted (${P.filter((p) => p.accepted && p.stage === "solve").length} by solvePose, ${P.filter((p) => p.accepted && p.stage !== "solve").length} by refinePose)`}
				/>
				<Stat
					value={`${(median(P.map((p) => p.ms.horizon)) / 1000).toFixed(1)} s`}
					label={`median computeHorizon; solvePose ${median(P.map((p) => p.ms.solve)).toFixed(0)} ms`}
				/>
			</div>
			<p className={`!mt-3 gb-secondary ${TYPE.caption}`}>
				The 12 bundled Niederhorn photos on this page, CPU pipeline, Terrarium
				DEM (scripts/gipfelbuch/build-data.ts, {idx.generated}). The corrections
				are the pipeline&apos;s own solved pose, not hand-registered truth.
			</p>
		</>
	);
}

// ======================================================================================
function Legacy() {
	const [id, setId] = useNotebookPhoto();
	const A = (id: string, label: string) => (
		<Link
			to="/gipfelbuch/$concept"
			params={{ concept: id }}
			className="underline decoration-[var(--gb-red)] underline-offset-2 hover:decoration-current"
		>
			{label}
		</Link>
	);
	return (
		<>
			<Section kicker="The question" title="Where was the camera looking?">
				<p>
					A photo arrives with a GPS fix and, usually, a compass heading, a
					gravity vector and a 35 mm focal length. Those give a{" "}
					<em>viewport guess</em>: yaw, pitch, roll and field of view. It is
					close but not right. Phone compasses are often several degrees off,
					and an overlay drawn from it puts every peak label on the wrong
					summit. Viewport inference turns that guess into a pose good to a
					fraction of a degree, or says honestly that it cannot.
				</p>
				<p>
					With the eye held at the GPS fix, the problem collapses to{" "}
					<strong>rotation plus focal</strong>, and the evidence is one curve:
					where sky meets terrain. The photo gives that curve per column. The{" "}
					{A("dem-horizon", "DEM horizon")} predicts it for every azimuth.
					Solving means sliding one onto the other.
				</p>
			</Section>

			<RealStory id={id} setId={setId} />
			<RealGrid sel={id} onPick={setId} />

			<HorizonLock />

			<Section kicker="The two curves" title="Observed and predicted">
				<ul>
					<li>
						<strong>Observed:</strong> {A("skyline", "the photo skyline")}. A
						smooth sky colour field is fitted, then a Viterbi pass finds one
						boundary row per column, with a truncated-L1 penalty on jumps. Each
						column gets a weight for edge contrast, polarity (darker below) and
						sky above / terrain below. Columns with no sky at the top are NaN
						and cast no vote.
					</li>
					<li>
						<strong>Predicted:</strong> {A("dem-horizon", "computeHorizon")}{" "}
						ray-marches 7,200 azimuths from the eye across the DEM, with earth
						curvature and refraction. It returns the skyline elevation angle
						(plus ridge crests) at every 0.05°. A pinhole camera maps each photo
						column back to an azimuth and elevation through{" "}
						<code>unproject</code>.
					</li>
				</ul>
			</Section>

			<Section kicker="Search" title="Coarse grid, then robust least squares">
				<p>
					A good optimiser started in the wrong valley still lands in the wrong
					valley. So <code>solvePose</code> first scores every small shift on a
					grid. Yaw is searched ±25° around the compass and pitch ±3° around
					gravity, in steps of about 1.5 px. The cost is a <em>truncated</em>{" "}
					L1, so a column more than 12 px off counts the same however far it is.
					The yaw-cost curve's local minima become up to three seeds, at least
					1.5° apart.
				</p>
				<p>
					From each seed, a Levenberg–Marquardt fit refines yaw, pitch, roll and
					log focal against a Cauchy loss at 4 px. Gaussian priors on each
					parameter (σ yaw 15°, pitch 1.5°, roll 1.5°, focal 6 %) are scaled so
					a one-sigma departure costs as much as every column being 1 px off.
					The cheapest result wins.
				</p>
			</Section>

			<CostLandscape />
			<FullCircle />

			<Section kicker="Gate" title="Knowing when not to answer">
				<p>
					The fitted pose then has to earn a confidence. The tilt gate catches
					fits that moved pitch or roll more than 3° from gravity. That only
					happens when the fit has locked onto the wrong edge. The other factors
					ask: did enough columns agree, was there enough skyline, was the
					winning yaw distinct from the runner-up, and does the horizon have
					enough relief in view to pin yaw at all?
				</p>
			</Section>

			<RealGate />
			<ConfidenceGate />

			<Section kicker="Cascade" title="Escalation, never guessing">
				<p>
					A rejection is not a dead end. It is a hand-off to a different method
					with independent failure modes. The app runs the{" "}
					{A("cascade", "cascade")}:
				</p>
				<Flow
					nodes={[
						{ label: "Sensor prior", sub: "EXIF compass · gravity · 35 mm" },
						{ label: "solvePose", sub: "grid → LM → gate" },
						{ label: "360° retry", sub: "bar 0.75" },
						{ label: "refinePose", sub: "FFT yaw → IRLS" },
						{ label: "Tap a peak", sub: "user control points" },
					]}
				/>
				<Steps
					steps={[
						{
							title: "solvePose (local)",
							body: "The grid, seeds, Cauchy LM and gate described above. Accepted means done.",
						},
						{
							title: "Full-circle retry",
							body: "On a low-confidence reject, the yaw prior is dropped (σ → 10⁶), the window becomes ±180° and the bar rises to 0.75. With no heading in the file, this is the first pass.",
						},
						{
							title: "refinePose",
							body: (
								<>
									{A("fft-yaw-refine", "A second, independent solver")}. The
									photo profile is binned on a 2¹³-sample azimuth ring. Four
									circular correlations by FFT score every yaw shift at once,
									with a free pitch offset and roll tilt. The top modes go
									through robust coarse-to-fine IRLS, with its own confidence.
								</>
							),
						},
						{
							title: "Manual control points",
							body: (
								<>
									If nothing accepts, the prior pose is shown as unverified and
									the user can {A("tap-a-peak", "tap a peak")}. One tap fixes
									yaw and pitch, two add roll, three or more add focal (
									{A("gcp-solver", "control-point solver")}).
								</>
							),
						},
					]}
				/>
				<p>
					Uploads with no compass, gravity or lens take the{" "}
					{A("unknown-pose", "unknown-pose")} path instead. It runs the same
					cascade with the unknowns declared, then the matcher service, and it
					never auto-accepts a guess.
				</p>
			</Section>

			<Section kicker="Result" title="What it buys">
				<div className="!mt-5 grid grid-cols-2 gap-5 sm:grid-cols-4">
					<Stat
						value="4.0° → 0.22°"
						label="median yaw error, sensor prior → cascade"
					/>
					<Stat value="45 → 5 px" label="median skyline error" />
					<Stat value="11 / 12" label="photos accepted" />
					<Stat value="0" label="false accepts" />
				</div>
				<MeasuredStats />
				<p className={`!mt-4 gb-secondary ${TYPE.caption}`}>
					12 hand-registered photos, classic skyline + cascade
					(src/lib/geo/README.md, 2026-09-24). The worst accepted yaw error was
					0.47°.
				</p>
				<Callout tone="lesson" title="Precision beats recall">
					A wrong pose shown as certain is worse than no pose. Every threshold
					here is set so the solver says &ldquo;don&rsquo;t know&rdquo; before
					it says something false. The ONNX sky model fitted more photos in
					isolation, but it was dropped from the default because it produced the
					one false accept (IMG_7053, 5.6°). See the{" "}
					{A("accept-rule", "accept rule")}.
				</Callout>
			</Section>

			<Section kicker="In the code" title="Where to look">
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/geo/solve.ts" />
					<CodeRef path="src/lib/geo/horizon.ts" />
					<CodeRef path="src/lib/geo/skyline.ts" />
					<CodeRef path="src/lib/geo/camera.ts" />
					<CodeRef path="src/lib/geo/lm.ts" />
					<CodeRef path="src/lib/geo/pipeline.ts" />
					<CodeRef path="src/lib/refine/init.ts" />
					<CodeRef path="src/lib/geo/control-points.ts" />
					<CodeRef path="src/lib/integration/unknown-pose.ts" />
					<CodeRef path="src/lib/geo/README.md" />
				</div>
				<p className={`!mt-3 font-mono gb-secondary ${TYPE.caption}`}>
					solvePose, coarseStage, coarseCost, fineStage, DEFAULT_SIGMA,
					FULL_SEARCH_CONFIDENCE, computeHorizon, detectSkyline, refinePose,
					solveFromControlPoints
				</p>
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
			aria-label="Gap between detected and predicted skyline, column by column, at the prior and the solved pose"
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
			label="Fig. 1"
			bleed
			caption={
				<>
					{d
						? d.solved.accepted
							? `The phone's compass was ${Math.abs(d.solved.delta.yaw).toFixed(1)}° off here. Slide the wipe: the map's skyline snaps onto the ridge.`
							: `The solver's best guess moved the compass ${Math.abs(d.solved.delta.yaw).toFixed(1)}°, but the fit was rejected (confidence ${d.solved.confidence.toFixed(2)}), so the app keeps the phone's pose. Slide the wipe to see why.`
						: "Slide the wipe between the guess and the solved pose."}{" "}
					<Key color={PRIOR_C} dashed>
						map at the phone's guess
					</Key>{" "}
					<Key color={SOLVED_C}>map at the solved pose</Key>{" "}
					<Key color={LAYER_STYLE.skyline.color}>skyline in the photo</Key>.{" "}
					<Measured data={d} />
				</>
			}
		>
			<AlignmentStoryProvider>
				<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_15rem] lg:items-start">
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
					<StoryMap data={d} />
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
					{ sym: "w", text: "how sure we are of that column (0 for no sky)" },
					{ sym: "θ", text: "yaw, pitch, roll and focal length" },
					{
						sym: "ρ",
						text: "robust loss: a column far off, like a tree, stops pulling",
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

function MiniPhoto({
	id,
	layers,
}: {
	id: GipfelbuchPhotoId;
	layers: PhotoLayer[];
}) {
	const d = useGipfelbuchPhoto(id);
	const crop = useMemo(() => (d ? skylineBand(d) : undefined), [d]);
	return <RealPhoto data={d} layers={layers} crop={crop} />;
}

function MiniMap({ id }: { id: GipfelbuchPhotoId }) {
	const d = useGipfelbuchPhoto(id);
	return (
		<div className="relative aspect-[4/3] overflow-hidden">
			<div className="absolute inset-x-0 top-1/2 -translate-y-1/2">
				<StoryMap data={d} search readout={false} />
			</div>
		</div>
	);
}

function Verdicts() {
	return (
		<Figure
			label="Fig. 3"
			bleed
			caption={
				<>
					All 12 photos at the solved pose. Under each: compass error found,
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
							? "neutral"
							: "result"
				}
				label={(d) => (
					<>
						{d.id.slice(-2)}
						{d.solved.accepted && d.solved.stage === "refine"
							? " · 2nd solver"
							: ""}{" "}
						· {sgn(d.solved.delta.yaw)}° · {d.residual.prior.median.toFixed(0)}{" "}
						→ {d.residual.solved.median.toFixed(1)} px
					</>
				)}
			/>
		</Figure>
	);
}

/** Caption of the guess, search, snap story, from the picked photo's measured residual. */
function ViewportStoryCaption() {
	const [photoId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photoId);
	if (!d)
		return <>The phone's guess, the traced skyline, then the solved pose.</>;
	const yaw = Math.abs(d.solved.delta.yaw).toFixed(1);
	return (
		<>
			{d.solved.accepted
				? `The search turned the view ${yaw}° and snapped the names onto their summits: skyline gap ${d.residual.prior.median.toFixed(0)} → ${d.residual.solved.median.toFixed(1)} px.`
				: `The search moved the view ${yaw}°, but the fit was rejected (confidence ${d.solved.confidence.toFixed(2)}), so the app keeps the phone's pose.`}{" "}
			<Measured data={d} />
		</>
	);
}

function ViewportInference({ node: _node }: { node: GipfelbuchNode }) {
	const [photoId] = useNotebookPhoto();
	const idx = useGipfelbuchIndex();
	const P = idx?.photos;
	const OK = P ? P.filter((p) => p.accepted) : null;
	const medYaw = OK ? median(OK.map((p) => Math.abs(p.delta.yaw))) : null;
	const medPrior = OK ? median(OK.map((p) => p.residual.prior.median)) : null;
	const medSolved = OK ? median(OK.map((p) => p.residual.solved.median)) : null;
	const acc = OK ? OK.length : null;
	return (
		<>
			<HeroCompare />

			<SolveEquation />

			<Beat kicker="The idea" title="The compass guesses. The ridge does not.">
				<p>
					A phone knows where it stands. Its compass is often several degrees
					off.{" "}
					{medYaw != null && (
						<>
							<HandMark type="strike">Close enough.</HandMark>{" "}
							<span className="nb-hand" style={{ color: "var(--nb-red)" }}>
								{medYaw.toFixed(1)}° median error
							</span>
						</>
					)}
					<MarginNote mark="a">
						Compass first guess, then the ridge. Which one do I trust when they
						disagree?
					</MarginNote>
				</p>
				<p>
					The photo has a skyline. The map predicts the same skyline from that
					spot.{" "}
					<HandMark type="highlight">
						We slide the map's line until it lands on the photo's.
					</HandMark>
				</p>
				<p>
					<strong>Yaw</strong> is which way the camera points. Pitch is up or
					down, roll is tilt. GPS fixes the spot, so we solve only these angles
					and the lens.
				</p>
			</Beat>

			<Beat kicker="How it works" title="Guess, search, polish.">
				<p>
					<CircledNumber value={1} /> sensors give a first view,{" "}
					<CircledNumber value={2} /> a small grid of turns scores it,{" "}
					<CircledNumber value={3} /> the winner is polished.
					<MarginNote mark="b">
						Only four numbers move: yaw, pitch, roll and focal. GPS fixes the
						spot.
					</MarginNote>
				</p>
				<Trio
					steps={[
						{
							title: "Start from the sensors",
							body: "Compass, gravity and lens give a first view. It is close, not right.",
							visual: <MiniPhoto id={photoId} layers={["skyline", "prior"]} />,
						},
						{
							title: "Try small turns",
							body: "Score every yaw and pitch near the guess. Keep the best few.",
							visual: <MiniMap id={photoId} />,
						},
						{
							title: "Polish the winner",
							body: "Fine-tune all four numbers. Wild columns count less.",
							visual: <MiniPhoto id={photoId} layers={["skyline", "solved"]} />,
						},
					]}
				/>
			</Beat>

			<PhotoStory
				bleed={false}
				number="2"
				title="Guess, search, snap"
				caption={<ViewportStoryCaption />}
			/>

			<Beat kicker="Where it fails" title="When the fit is weak, we say so.">
				<p>
					<HandMark type="wavy" color="red">
						A person or a tree can pull the detected line off the ridge.
					</HandMark>{" "}
					Then too few columns agree.
				</p>
				<p>
					We reject the photo and keep the phone's guess.{" "}
					<HandMark type="double">We do not show it as certain.</HandMark>
					<MarginNote mark="c">
						0 false accepts on 12 hand-registered photos, 0.22° median yaw
						error. Accepted ✓, but only when it earns it.
					</MarginNote>
				</p>
			</Beat>

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
						label: "demo photos accepted",
					},
					{
						value: "0.22°",
						label: "median yaw error vs hand registration, 12 photos",
					},
				]}
				source={
					<>
						First two: measured on the 12 demo photos. Last:
						src/lib/geo/README.md (12 hand-registered photos, cascade, 0 false
						accepts).
					</>
				}
			/>

			<Details>
				<p>
					The loss <code>ρ</code> is a truncated L1 (12 px) on the grid and a
					Cauchy loss (4 px) in the polish; <code>w</code> is the skyline
					weight. Everything below is the full mechanism: the grid search,
					robust least squares, confidence gate and the escalation cascade, with
					measured and synthetic figures.
				</p>
				<Legacy />
			</Details>
		</>
	);
}

export default memo(ViewportInference);
