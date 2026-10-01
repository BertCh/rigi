// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { memo, useMemo, useState } from "react";
import {
	type AtlasPhotoData,
	type AtlasPhotoId,
	Callout,
	CodeRef,
	DemPatch,
	Figure,
	Flow,
	Measured,
	type PhotoLayer,
	PhotoPicker,
	Plot,
	RealPhoto,
	Section,
	Stat,
	Steps,
	useAtlasIndex,
	useAtlasPhoto,
	useReducedMotion,
	useTime,
} from "#/components/atlas/viz";
import {
	Beat,
	Compare,
	Details,
	Gallery,
	Key,
	Numbers,
	skylineBand,
	Trio,
} from "#/components/atlas/viz/explain";
import type { AtlasNode } from "#/lib/atlas/types";

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

	const fine = FINE;
	const ridgePath = `M0 300 ${fine.pts.map(([x, y]) => `L${x} ${y.toFixed(1)}`).join(" ")} L${W} 300 Z`;
	const nearPath = `M0 300 ${fine.near.map(([x, y]) => `L${x} ${y.toFixed(1)}`).join(" ")} L${W} 300 Z`;
	const pred: string[] = [];
	for (let x = 0; x <= W; x += 3) {
		const o = (x / W) * HFOV - HFOV / 2;
		pred.push(
			`${x ? "L" : "M"}${x} ${yOf(horizon(pose.dy + o) - pose.dp).toFixed(1)}`,
		);
	}
	const treeX0 = xOf(OFF[TREE[0]]) - 8;
	const treeX1 = xOf(OFF[TREE[1]]) + 8;
	const treeTop = Math.min(
		...OBS.slice(TREE[0], TREE[1] + 1).map((v) => yOf(v ?? 0)),
	);
	const roofX1 = xOf(OFF[NO_SKY[1]]) + 5;

	const phaseLabel = manual
		? "manual"
		: auto.phase === "prior"
			? "sensor prior"
			: auto.phase === "search"
				? "searching"
				: "solved";

	return (
		<Figure
			label="Fig. 3"
			bleed
			caption="Schematic (synthetic scene). The core move. The photo's skyline (cream trace, one sample per column) is fixed; the DEM horizon (accent) is projected through a hypothesised camera and slid in yaw and pitch. Stems are per-column pixel residuals: bright when inside the 4 px Cauchy scale, faded when the robust loss stops listening (the tree, an occluder the DEM does not know). Columns under the roof have no sky and no vote."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<svg
					viewBox={`0 0 ${W} 300`}
					className="block h-auto w-full rounded-xl"
					role="img"
					aria-label="Photo skyline and the projected DEM horizon with per-column residuals"
				>
					<defs>
						<linearGradient id="vi-sky" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0" stopColor="#1b2a3a" />
							<stop offset="0.75" stopColor="#3b4c5c" />
							<stop offset="1" stopColor="#6c6f6e" />
						</linearGradient>
						<linearGradient id="vi-ridge" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0" stopColor="#5d6a74" />
							<stop offset="1" stopColor="#2b3238" />
						</linearGradient>
						<linearGradient id="vi-near" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0" stopColor="#262c27" />
							<stop offset="1" stopColor="#121513" />
						</linearGradient>
						<filter id="vi-glow" x="-10%" y="-50%" width="120%" height="200%">
							<feGaussianBlur stdDeviation="2.4" />
						</filter>
					</defs>
					<rect width={W} height="300" fill="url(#vi-sky)" />
					<path d={ridgePath} fill="url(#vi-ridge)" />
					{/* snow hint on the high ridge */}
					<path
						d={ridgePath}
						fill="none"
						stroke="#e9e4da"
						strokeOpacity="0.18"
						strokeWidth="2.5"
					/>
					<path d={nearPath} fill="url(#vi-near)" />
					{/* conifer occluder */}
					{[0, 1, 2].map((k) => {
						const cx = treeX0 + ((treeX1 - treeX0) * (k + 1)) / 4;
						const top = treeTop + (k === 1 ? 0 : 14);
						return (
							<path
								key={k}
								d={`M${cx} ${top} L${cx + 24} 300 L${cx - 24} 300 Z`}
								fill="#0f1411"
							/>
						);
					})}
					{/* roof: no sky above */}
					<path
						d={`M0 0 L${roofX1} 0 L${roofX1} 300 L0 300 Z`}
						fill="#0d0f10"
					/>
					<path
						d={`M0 44 L${roofX1 + 6} 18`}
						stroke="#2a2522"
						strokeWidth="10"
						strokeLinecap="round"
					/>

					{/* residual stems */}
					{VALID.map((v, k) => {
						const r = res[k];
						const w = 1 / (1 + (r / CAUCHY) ** 2);
						const x = xOf(v.o);
						const inlier = Math.abs(r) < CAUCHY;
						return (
							<line
								key={v.i}
								x1={x}
								x2={x}
								y1={yOf(v.e)}
								y2={yOf(v.e) + r}
								stroke={inlier ? "var(--accent)" : "var(--rigi-trap)"}
								strokeOpacity={0.2 + 0.8 * w}
								strokeWidth={inlier ? 2 : 1.2}
							/>
						);
					})}

					{/* projected DEM horizon */}
					<path
						d={pred.join("")}
						fill="none"
						stroke="var(--accent)"
						strokeWidth="5"
						strokeOpacity="0.35"
						filter="url(#vi-glow)"
					/>
					<path
						d={pred.join("")}
						fill="none"
						stroke="var(--accent)"
						strokeWidth="1.6"
					/>

					{/* observed skyline samples (Viterbi trace) */}
					{VALID.map((v) => (
						<circle
							key={v.i}
							cx={xOf(v.o)}
							cy={yOf(v.e)}
							r="2.1"
							fill="var(--rigi-paper)"
						/>
					))}

					{/* frame furniture */}
					<g className="font-mono" fontSize="10">
						<text
							x={W - 10}
							y="18"
							textAnchor="end"
							fill="rgba(236,230,218,.55)"
						>
							{phaseLabel.toUpperCase()}
						</text>
						<text x={roofX1 + 10} y="292" fill="rgba(236,230,218,.4)">
							roof · no sky · no vote
						</text>
						<text
							x={treeX0 - 4}
							y="292"
							textAnchor="end"
							fill="var(--rigi-trap)"
							fillOpacity=".75"
						>
							tree · outliers
						</text>
					</g>
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
							className="rounded-full px-3 py-1 font-mono text-[11px] text-white/70 ring-1 ring-white/15 transition hover:text-white"
						>
							{manual ? "↻ replay the solve" : "auto-playing"}
						</button>
						<button
							type="button"
							onClick={() => setManual({ ...TRUTH })}
							className="rounded-full px-3 py-1 font-mono text-[11px] text-white/70 ring-1 ring-white/15 transition hover:text-white"
						>
							snap to optimum
						</button>
					</div>
				</div>
				<dl className="grid min-w-[220px] grid-cols-2 gap-x-5 gap-y-2 font-mono text-[11px]">
					<Read k="Δ yaw" v={`${fmt(pose.dy)}°`} />
					<Read k="Δ pitch" v={`${fmt(pose.dp, 2)}°`} />
					<Read k="inliers < 4 px" v={`${inl} / ${VALID.length}`} />
					<Read k="coverage" v={`${Math.round(COVERAGE * 100)} %`} />
					<div className="col-span-2">
						<dt className="text-white/40">robust cost</dt>
						<dd className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/8">
							<div
								className="h-full rounded-full bg-[var(--accent)]"
								style={{ width: `${(4 + 96 * costBar).toFixed(1)}%` }}
							/>
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
		<label className="block">
			<span className="flex justify-between font-mono text-[11px] text-white/45">
				<span>{label}</span>
				<span className="text-[var(--rigi-paper)]">
					{fmt(value, step < 0.1 ? 2 : 1)}
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

function Read({ k, v }: { k: string; v: string }) {
	return (
		<div>
			<dt className="text-white/40">{k}</dt>
			<dd className="text-[13px] text-[var(--rigi-paper)]">{v}</dd>
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

/** Ramp from a dim slate to the page accent; `v` is the cell's cost rank in 0..1 (0 = cheapest = bright). */
function heat(v: number) {
	const k = 0.06 + 0.94 * (1 - v) ** 3;
	return `color-mix(in oklab, var(--accent) ${(k * 100).toFixed(0)}%, #1a1d22)`;
}

const x0 = 46;
const x1 = 626;
const y0 = 14;
const y1 = 184;
const sx = (dy: number) => x0 + ((dy + 25) / 50) * (x1 - x0);
const sy = (dp: number) => y1 - ((dp + 3) / 6) * (y1 - y0);

/** The static heat map, rendered once (the figure around it re-renders per frame). */
const HeatCells = memo(function HeatCells() {
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
	const cw = (x1 - x0) / dys.length + 0.6;
	const ch = (y1 - y0) / dps.length + 0.6;
	return (
		<g>
			{dys.flatMap((dy, i) =>
				dps.map((dp, j) => (
					<rect
						key={`${dy}:${dp}`}
						x={sx(dy) - cw / 2}
						y={sy(dp) - ch / 2}
						width={cw}
						height={ch}
						fill={heat(rank(c[i][j]))}
					/>
				)),
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

	return (
		<Figure
			label="Fig. 4"
			bleed
			caption={`Schematic (synthetic scene). Coarse then fine. The heat map is solve.ts's coarse cost over the ±25° × ±3° window around the prior (truncated L1 at 12 px plus the prior term); brighter is cheaper. Below it, the best cost per yaw. Up to three local minima more than 1.5° apart become seeds (rings); Levenberg–Marquardt with a Cauchy loss descends from each, and the cheapest end wins. Ambiguity for this scene: ${ambiguity.toFixed(2)} (how close the runner-up minimum comes to the best, relative to the median).`}
		>
			<div ref={ref}>
				<svg
					viewBox="0 0 640 312"
					className="block h-auto w-full"
					role="img"
					aria-label="Coarse yaw-pitch cost landscape with seeds and LM paths"
				>
					{cells}
					<rect
						x={x0}
						y={y0}
						width={x1 - x0}
						height={y1 - y0}
						fill="none"
						stroke="rgba(236,230,218,.18)"
					/>
					{/* prior crosshair */}
					<line
						x1={sx(0)}
						x2={sx(0)}
						y1={y0}
						y2={p1}
						stroke="rgba(236,230,218,.35)"
						strokeDasharray="3 4"
					/>
					<text
						x={sx(0) + 5}
						y={y0 + 11}
						fontSize="10"
						className="font-mono"
						fill="rgba(236,230,218,.6)"
					>
						prior
					</text>
					{/* LM paths */}
					{paths.map((p, k) => {
						const n = Math.max(1, Math.round(prog * (p.pts.length - 1)));
						const d = p.pts
							.slice(0, n + 1)
							.map(
								([a, b], i) =>
									`${i ? "L" : "M"}${sx(a).toFixed(1)} ${sy(b).toFixed(1)}`,
							)
							.join("");
						const end = p.pts[n];
						const isWin = k === win;
						return (
							<g key={`lm${p.pts[0][0]}`}>
								<path
									d={d}
									fill="none"
									stroke={isWin ? "var(--rigi-paper)" : "rgba(236,230,218,.45)"}
									strokeWidth={isWin ? 1.8 : 1.1}
								/>
								<circle
									cx={sx(end[0])}
									cy={sy(end[1])}
									r={isWin ? 3.5 : 2.5}
									fill={isWin ? "var(--rigi-paper)" : "rgba(236,230,218,.5)"}
								/>
							</g>
						);
					})}
					{seeds.map((s, k) => (
						<g key={`s${s.dy}`}>
							<circle
								cx={sx(s.dy)}
								cy={sy(s.dp)}
								r="7"
								fill="none"
								stroke="var(--rigi-paper)"
								strokeWidth="1.2"
							/>
							<text
								x={sx(s.dy)}
								y={sy(s.dp) - 11}
								textAnchor="middle"
								fontSize="10"
								className="font-mono"
								fill="var(--rigi-paper)"
							>
								{`seed ${k + 1}`}
							</text>
						</g>
					))}
					{prog >= 1 && (
						<text
							x={sx(paths[win].pts[paths[win].pts.length - 1][0]) + 9}
							y={sy(paths[win].pts[paths[win].pts.length - 1][1]) + 16}
							fontSize="10.5"
							className="font-mono"
							fill="var(--rigi-paper)"
						>
							{`solved ${fmt(paths[win].pts[paths[win].pts.length - 1][0])}° yaw`}
						</text>
					)}
					{/* axes */}
					<g className="font-mono" fontSize="9.5" fill="rgba(236,230,218,.45)">
						{[-3, 0, 3].map((v) => (
							<text key={v} x={x0 - 6} y={sy(v) + 3} textAnchor="end">
								{`${v > 0 ? "+" : ""}${v}°`}
							</text>
						))}
						<text
							x="10"
							y={(y0 + y1) / 2}
							transform={`rotate(-90 10 ${(y0 + y1) / 2})`}
							textAnchor="middle"
						>
							Δ pitch
						</text>
						{[-25, -15, -5, 5, 15, 25].map((v) => (
							<text key={v} x={sx(v)} y={p1 + 14} textAnchor="middle">
								{`${v > 0 ? "+" : ""}${v}°`}
							</text>
						))}
						<text x={x1} y={p0 - 6} textAnchor="end">
							best cost per yaw ↓
						</text>
					</g>
					<path d={prof} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
					{seeds.map((s) => (
						<circle
							key={`p${s.dy}`}
							cx={sx(s.dy)}
							cy={py(s.c)}
							r="3"
							fill="var(--rigi-paper)"
						/>
					))}
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
			label="Fig. 5"
			caption="Schematic. The same scene scored all the way round (yaw prior switched off). Radius grows as the cost falls. The local search only ever sees the shaded ±25° wedge around the compass. When it rejects, solvePose retries over 360°, but repetitive ridges make aliases (the faded spike), so the retry must clear a stricter 0.75 confidence instead of 0.5."
		>
			<div
				ref={ref}
				className="grid items-center gap-5 md:grid-cols-[minmax(0,320px)_1fr]"
			>
				<svg
					viewBox="0 0 320 320"
					className="mx-auto block h-auto w-full max-w-[320px]"
					role="img"
					aria-label="Polar plot of the yaw cost over 360 degrees"
				>
					<circle
						cx={cx}
						cy={cy}
						r={r1}
						fill="none"
						stroke="rgba(236,230,218,.08)"
					/>
					<circle
						cx={cx}
						cy={cy}
						r={r0}
						fill="none"
						stroke="rgba(236,230,218,.08)"
					/>
					<path
						d={wedge(-25, 25, r1 + 8)}
						fill="var(--accent)"
						fillOpacity=".1"
					/>
					<path
						d={wedge(sweep - 6, sweep, r1 + 8)}
						fill="rgba(236,230,218,.07)"
					/>
					<path
						d={d}
						fill="var(--accent)"
						fillOpacity=".12"
						stroke="var(--accent)"
						strokeWidth="1.3"
					/>
					<line
						x1={cx}
						y1={cy}
						x2={bx}
						y2={by}
						stroke="var(--rigi-paper)"
						strokeWidth="1.2"
					/>
					<circle cx={bx} cy={by} r="4" fill="var(--rigi-paper)" />
					<line
						x1={cx}
						y1={cy}
						x2={ax}
						y2={ay}
						stroke="var(--rigi-trap)"
						strokeOpacity=".7"
						strokeDasharray="3 3"
					/>
					<circle
						cx={ax}
						cy={ay}
						r="3.5"
						fill="none"
						stroke="var(--rigi-trap)"
					/>
					<g className="font-mono" fontSize="9.5" fill="rgba(236,230,218,.5)">
						<text x={cx} y={12} textAnchor="middle">
							compass
						</text>
						<text x={cx} y={cy + 4} textAnchor="middle">
							360°
						</text>
					</g>
				</svg>
				<div className="space-y-3 text-[14px] leading-relaxed text-white/65">
					<p>
						<span className="font-mono text-[12px] text-[var(--rigi-paper)]">
							best
						</span>{" "}
						lies at{" "}
						<span className="font-mono text-[var(--rigi-paper)]">
							{fmt(best.dy, 0)}°
						</span>{" "}
						from the compass. The strongest alias (
						<span className="font-mono text-[var(--rigi-trap)]">
							{fmt(alias.dy, 0)}°
						</span>
						) is a different stretch of ridge whose silhouette happens to rhyme.
					</p>
					<p>
						The wild benchmark found this for real: a 360° first pass at the
						local 0.5 bar accepted IMG_7053 at −123.7°. Hence{" "}
						<code className="rounded border-0 bg-white/8 px-1 font-mono text-[12px] text-white/85">
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
		note: "Computed from Fig. 3–4: a jagged ridge, a tree and a roof.",
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
			label="Fig. 7"
			caption="Schematic. solve.ts's confidence is a product of five clamped factors, so it is only as strong as its weakest one. The cream bar is the running product; the tick is the accept bar (0.5 for the local search, 0.75 for the 360° retry). The first scene is computed from the figures above; the others are illustrative inputs to the same formula."
		>
			<div className="flex flex-wrap gap-1.5">
				{SCENES.map((x) => (
					<button
						key={x.id}
						type="button"
						aria-pressed={x.id === sel}
						onClick={() => setSel(x.id)}
						className="rounded-full px-3 py-1 font-mono text-[11px] ring-1 transition"
						style={{
							color:
								x.id === sel ? "var(--rigi-paper)" : "rgba(255,255,255,.5)",
							boxShadow: `inset 0 0 0 1px ${x.id === sel ? "var(--accent)" : "rgba(255,255,255,.1)"}`,
							background:
								x.id === sel
									? "color-mix(in oklab, var(--accent) 16%, transparent)"
									: undefined,
						}}
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
						<span className="font-mono text-[11px] text-white/55">{f.k}</span>
						<div className="relative h-3.5 overflow-hidden rounded-full bg-white/[0.06]">
							<div
								className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none"
								style={{
									width: `${f.v * 100}%`,
									background:
										"color-mix(in oklab, var(--accent) 55%, transparent)",
								}}
							/>
							<div
								className="absolute inset-y-[4px] left-0 rounded-full bg-[var(--rigi-paper)] transition-[width] duration-700 ease-out motion-reduce:transition-none"
								style={{ width: `${cum[i] * 100}%` }}
							/>
							<div
								className="absolute inset-y-0 w-px bg-white/60"
								style={{ left: `${bar * 100}%` }}
							/>
						</div>
						<span className="text-right font-mono text-[11px] text-white/45">
							{f.v.toFixed(2)} <span className="text-white/30">· {f.raw}</span>
						</span>
					</div>
				))}
			</div>
			<div className="mt-5 flex flex-wrap items-baseline gap-x-5 gap-y-2 border-t border-white/10 pt-4">
				<span
					className="display-title text-[2rem] leading-none font-bold"
					style={{ color: ok ? "var(--accent)" : "var(--rigi-trap)" }}
				>
					{conf.toFixed(2)}
				</span>
				<span
					className="font-mono text-[11px] tracking-[0.12em] uppercase"
					style={{ color: ok ? "var(--accent)" : "var(--rigi-trap)" }}
				>
					{ok
						? "accepted"
						: s.tiltDeg > 3
							? "rejected · tilt"
							: "rejected · low confidence"}
				</span>
				<span className="font-mono text-[11px] text-white/40">
					bar {bar.toFixed(2)} ({s.search === "full" ? "360° retry" : "local"})
				</span>
				<p className="basis-full text-[13.5px] text-white/58">{s.note}</p>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Real data: the actual CPU pipeline (detectSkyline -> computeHorizon -> solvePose, refinePose on reject) on the
// 12 bundled Niederhorn photos, scripts/atlas/build-data.ts -> public/demo/atlas/*.json.

const sgn = (v: number, n = 1) =>
	`${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(n)}`;
const median = (a: number[]) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length % 2
		? s[(s.length - 1) / 2]
		: (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Crop over the rows the skyline curves occupy, so people at the bottom of the frame stay out. */
function skyBand(d: AtlasPhotoData): [number, number, number, number] {
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
	id: AtlasPhotoId;
	setId: (i: AtlasPhotoId) => void;
}) {
	const d = useAtlasPhoto(id);
	const idx = useAtlasIndex();
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
			label="Fig. 1"
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
							<span className="rounded bg-black/70 px-1 font-mono text-[9px] text-white/90">
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
							className="rounded-full px-3 py-1 font-mono text-[11px] ring-1 transition"
							style={{
								background: i === k ? "var(--accent)" : "rgba(255,255,255,.04)",
								color: i === k ? "#0e1012" : "rgba(255,255,255,.7)",
								boxShadow: `inset 0 0 0 1px ${i === k ? "var(--accent)" : "rgba(255,255,255,.1)"}`,
							}}
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
				<p className="mt-3 min-h-[3.2em] text-[13.5px] leading-snug text-white/65">
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
	sel: AtlasPhotoId;
	onPick: (i: AtlasPhotoId) => void;
}) {
	const idx = useAtlasIndex();
	if (!idx)
		return <div className="h-48 animate-pulse rounded-xl bg-white/[0.04]" />;
	const P = idx.photos;
	const acc = P.filter((p) => p.accepted).length;
	return (
		<Figure
			label="Fig. 2"
			caption={
				<>
					Measured on the 12 demo photos by scripts/atlas/build-data.ts,
					2026-10-01. Each tile: compass error found (solved yaw − EXIF
					heading), median skyline error prior → solved. Every correction fits
					inside the ±25° yaw window (largest{" "}
					{Math.max(...P.map((p) => Math.abs(p.delta.yaw))).toFixed(1)}°).
					Magenta = not accepted by solvePose: demo-07 and demo-11 are rejected
					outright; demo-12 was rescued by refinePose.
				</>
			}
		>
			<div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
				{P.map((p) => {
					const bad = !p.accepted || p.stage !== "solve";
					return (
						<button
							key={p.id}
							type="button"
							onClick={() => onPick(p.id)}
							className="overflow-hidden rounded-lg bg-black/30 text-left ring-2 transition"
							style={{ boxShadow: "none" }}
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
									className="absolute top-1 left-1 rounded px-1 font-mono text-[9px] text-black"
									style={{ background: bad ? "#ff5fa2" : "#5ee0f4" }}
								>
									{p.id.slice(-2)} ·{" "}
									{p.accepted
										? p.stage === "solve"
											? "solve"
											: "refine"
										: "rejected"}
								</span>
							</div>
							<div className="px-1.5 py-1 font-mono text-[10px] leading-tight text-white/70">
								<div className="text-white/90">{sgn(p.delta.yaw)}° yaw</div>
								<div>
									{p.residual.prior.median.toFixed(0)} →{" "}
									{p.residual.solved.median.toFixed(1)} px
								</div>
							</div>
						</button>
					);
				})}
			</div>
			<p className="mt-3 font-mono text-[11px] text-white/45">
				{acc} / 12 accepted by the cascade; median skyline error{" "}
				{median(P.map((p) => p.residual.prior.median)).toFixed(1)} →{" "}
				{median(P.map((p) => p.residual.solved.median)).toFixed(1)} px.
			</p>
		</Figure>
	);
}

function RealGate() {
	const idx = useAtlasIndex();
	if (!idx)
		return <div className="h-56 animate-pulse rounded-xl bg-white/[0.04]" />;
	const P = idx.photos;
	return (
		<Figure
			label="Fig. 6"
			caption={
				<>
					Measured on the 12 demo photos (scripts/atlas/build-data.ts,
					2026-10-01): the confidence solvePose assigned to each, against the
					0.5 accept bar of the local search. The two rejects (demo-07, demo-11)
					fall just under it, 0.46 and 0.44; demo-08 clears it with 0.56. The
					hatched bar is demo-12, where the number is refinePose&apos;s own
					confidence after solvePose was rejected.
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
						<defs>
							<pattern
								id="vi-hatch"
								width="5"
								height="5"
								patternUnits="userSpaceOnUse"
								patternTransform="rotate(45)"
							>
								<rect width="5" height="5" fill="#5ee0f4" fillOpacity=".25" />
								<line
									x1="0"
									y1="0"
									x2="0"
									y2="5"
									stroke="#5ee0f4"
									strokeWidth="2"
								/>
							</pattern>
						</defs>
						{P.map((p, k) => {
							const x = s.x(k + 1);
							const w = (s.x(2) - s.x(1)) * 0.6;
							const refine = p.stage !== "solve";
							return (
								<rect
									key={p.id}
									x={x - w / 2}
									y={s.y(p.confidence)}
									width={w}
									height={s.y(0) - s.y(p.confidence)}
									fill={
										refine
											? "url(#vi-hatch)"
											: p.accepted
												? "#5ee0f4"
												: "#ff5fa2"
									}
									fillOpacity={refine ? 1 : 0.85}
								/>
							);
						})}
						<line
							x1={s.box.x0}
							x2={s.box.x1}
							y1={s.y(0.5)}
							y2={s.y(0.5)}
							stroke="#ece6da"
							strokeDasharray="5 4"
						/>
						<text
							x={s.box.x0 + 4}
							y={s.y(0.5) - 5}
							stroke="#0e1012"
							strokeWidth={3}
							paintOrder="stroke"
							textAnchor="start"
							fontSize="10"
							fill="#ece6da"
							fontFamily="ui-monospace, monospace"
						>
							accept bar 0.5 (local)
						</text>
					</g>
				)}
			</Plot>
		</Figure>
	);
}

function MeasuredStats() {
	const idx = useAtlasIndex();
	if (!idx) return null;
	const P = idx.photos;
	return (
		<>
			<div className="!mt-6 grid grid-cols-2 gap-5 sm:grid-cols-4">
				<Stat
					value={`${median(P.map((p) => Math.abs(p.delta.yaw))).toFixed(1)}°`}
					label="median compass error corrected, demo photos"
				/>
				<Stat
					value={`${median(P.map((p) => p.residual.prior.median)).toFixed(1)} → ${median(P.map((p) => p.residual.solved.median)).toFixed(1)} px`}
					label="median skyline error, prior → solved, demo photos"
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
			<p className="!mt-3 text-[13px] text-white/45">
				The 12 bundled Niederhorn photos on this page, CPU pipeline, Terrarium
				DEM (scripts/atlas/build-data.ts, {idx.generated}). The corrections are
				the pipeline&apos;s own solved pose, not hand-registered truth.
			</p>
		</>
	);
}

// ======================================================================================
function Legacy() {
	const [id, setId] = useState<AtlasPhotoId>("demo-09");
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
					gravity, in steps of about 1.5 px. The cost is a <em>truncated</em>{" "}
					L1, so a column more than 12 px off counts the same however far it is.
					The yaw-cost curve's local minima become up to three seeds, at least
					1.5° apart.
				</p>
				<p>
					From each seed, a Levenberg–Marquardt fit refines yaw, pitch, roll and
					log focal against a Cauchy loss at 4 px. Gaussian priors on each
					parameter (σ yaw 15°, pitch 1.5°, roll 1.5°, focal 6 %) are scaled so
					a one-sigma departure costs as much as every column being 1 px off.
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
					<Stat value="45 → 5 px" label="median skyline error" />
					<Stat value="11 / 12" label="photos accepted" />
					<Stat value="0" label="false accepts" />
				</div>
				<MeasuredStats />
				<p className="!mt-4 text-[13px] text-white/45">
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
				<p className="!mt-3 font-mono text-[12.5px] text-white/55">
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
const PRIOR_C = "#ff5fa2";
const SOLVED_C = "#5ee0f4";
const HERO_ID: AtlasPhotoId = "demo-02"; // people-free, full frame

/** Per-column |detected − DEM| at the prior and solved pose, over columns that vote. */
function ResidualStrip({ d }: { d: AtlasPhotoData }) {
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
			<line x1={0} x2={n} y1={58} y2={58} stroke="rgba(255,255,255,.22)" />
			<line
				x1={0}
				x2={n}
				y1={4}
				y2={4}
				stroke="rgba(255,255,255,.08)"
				strokeDasharray="3 5"
			/>
			<path
				d={path(d.priorRows)}
				fill="none"
				stroke={PRIOR_C}
				strokeWidth={1.6}
				strokeDasharray="5 3"
			/>
			<path
				d={path(d.solvedRows)}
				fill="none"
				stroke={SOLVED_C}
				strokeWidth={1.8}
			/>
			<text
				x={4}
				y={14}
				fontSize={11}
				fill="rgba(236,230,218,.55)"
				fontFamily="ui-monospace, monospace"
			>
				gap {CAP} px
			</text>
			<text
				x={4}
				y={55}
				fontSize={11}
				fill="rgba(236,230,218,.55)"
				fontFamily="ui-monospace, monospace"
			>
				0
			</text>
		</svg>
	);
}

function HeroCompare() {
	const d = useAtlasPhoto(HERO_ID);
	const crop = useMemo(() => (d ? skylineBand(d) : undefined), [d]);
	return (
		<Figure
			bleed
			caption={
				<>
					{d
						? `The phone's compass was ${Math.abs(d.solved.delta.yaw).toFixed(1)}° off here. Slide the wipe: the map's skyline snaps onto the ridge.`
						: "Slide the wipe between the guess and the solved pose."}{" "}
					<Key color={PRIOR_C} dashed>
						map at the phone's guess
					</Key>{" "}
					<Key color={SOLVED_C}>map at the solved pose</Key>{" "}
					<Key color="#f4d35e">skyline in the photo</Key>. <Measured data={d} />
				</>
			}
		>
			<Compare
				before={
					<RealPhoto data={d} layers={["skyline", "prior"]} crop={crop} />
				}
				after={
					<RealPhoto data={d} layers={["skyline", "solved"]} crop={crop} />
				}
				beforeLabel="phone's guess"
				afterLabel="solved"
				start={0.5}
			/>
			{d && (
				<>
					<ResidualStrip d={d} />
					<p className="mt-1 font-mono text-[11px] text-white/55">
						Gap per column. Median{" "}
						<span style={{ color: PRIOR_C }}>
							{d.residual.prior.median.toFixed(1)} px
						</span>{" "}
						at the guess,{" "}
						<span style={{ color: SOLVED_C }}>
							{d.residual.solved.median.toFixed(1)} px
						</span>{" "}
						solved ({d.residual.solved.n} columns).
					</p>
				</>
			)}
		</Figure>
	);
}

function MiniPhoto({ id, layers }: { id: AtlasPhotoId; layers: PhotoLayer[] }) {
	const d = useAtlasPhoto(id);
	const crop = useMemo(() => (d ? skylineBand(d) : undefined), [d]);
	return <RealPhoto data={d} layers={layers} crop={crop} />;
}

function MiniMap({ id }: { id: AtlasPhotoId }) {
	const d = useAtlasPhoto(id);
	return (
		<div className="relative aspect-[4/3] overflow-hidden">
			<div className="absolute inset-x-0 top-1/2 -translate-y-1/2">
				<DemPatch data={d} peaks={false} />
			</div>
		</div>
	);
}

function Verdicts() {
	return (
		<Figure
			caption={
				<>
					All 12 photos at the solved pose. Under each: compass error found,
					then skyline gap in px, guess → solved. Red tag: refused. Photo 12
					passed only through a second solver.
				</>
			}
		>
			<Gallery
				cols={4}
				tile={(d) => (
					<div className="relative">
						<RealPhoto
							data={d}
							layers={["skyline", "solved"]}
							crop={skylineBand(d, 260)}
						/>
						<span
							className="absolute top-1 left-1 rounded px-1 font-mono text-[9.5px] text-black"
							style={{
								background: d.solved.accepted ? SOLVED_C : "#ff7a66",
							}}
						>
							{d.id.slice(-2)}
							{d.solved.accepted
								? d.solved.stage === "refine"
									? " · 2nd solver"
									: ""
								: " · rejected"}
						</span>
					</div>
				)}
				label={(d) => (
					<>
						{sgn(d.solved.delta.yaw)}° · {d.residual.prior.median.toFixed(0)} →{" "}
						{d.residual.solved.median.toFixed(1)} px
					</>
				)}
			/>
		</Figure>
	);
}

function ViewportInference({ node: _node }: { node: AtlasNode }) {
	const idx = useAtlasIndex();
	const P = idx?.photos;
	const medYaw = P ? median(P.map((p) => Math.abs(p.delta.yaw))) : null;
	const medPrior = P ? median(P.map((p) => p.residual.prior.median)) : null;
	const medSolved = P ? median(P.map((p) => p.residual.solved.median)) : null;
	const acc = P ? P.filter((p) => p.accepted).length : null;
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
			<HeroCompare />

			<Beat kicker="The idea" title="The compass guesses. The ridge does not.">
				<p>
					A phone knows where it stands. Its compass is often several degrees
					off.
				</p>
				<p>
					The photo has a skyline. The map predicts the same skyline from that
					spot. We slide the map's line until it lands on the photo's.
				</p>
				<p>
					<strong>Yaw</strong> is which way the camera points. Pitch is up or
					down, roll is tilt.
				</p>
			</Beat>

			<Beat kicker="How it works" title="Guess, search, polish.">
				<Trio
					steps={[
						{
							title: "Start from the sensors",
							body: "Compass, gravity and lens give a first view. It is close, not right.",
							visual: <MiniPhoto id="demo-03" layers={["skyline", "prior"]} />,
						},
						{
							title: "Try small turns",
							body: "Score every yaw and pitch near the guess. Keep the best few.",
							visual: <MiniMap id="demo-03" />,
						},
						{
							title: "Polish the winner",
							body: "Fine-tune all four numbers. Wild columns count less.",
							visual: <MiniPhoto id="demo-03" layers={["skyline", "solved"]} />,
						},
					]}
				/>
			</Beat>

			<Beat kicker="Where it fails" title="When the fit is weak, we say so.">
				<p>
					A person or a tree can pull the detected line off the ridge. Then too
					few columns agree.
				</p>
				<p>
					We reject the photo and keep the phone's guess. We do not show it as
					certain.
				</p>
			</Beat>

			<Verdicts />

			<Numbers
				items={[
					{
						value: medYaw == null ? "…" : `${medYaw.toFixed(1)}°`,
						label: "median compass error found, 12 demo photos",
					},
					{
						value:
							medPrior == null || medSolved == null
								? "…"
								: `${medPrior.toFixed(1)} → ${medSolved.toFixed(1)}`,
						label: "median skyline gap in px, guess → solved",
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

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next: the {A("pose-estimate", "pose estimate")} this produces, and the{" "}
				{A("accept-rule", "accept rule")} that decides whether to trust it.
			</p>

			<Details>
				<p>
					Everything below is the full mechanism: the grid search, robust least
					squares, confidence gate and the escalation cascade, with measured and
					synthetic figures.
				</p>
				<Legacy />
			</Details>
		</>
	);
}

export default memo(ViewportInference);
