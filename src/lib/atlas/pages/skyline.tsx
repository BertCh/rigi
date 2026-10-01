// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
	type AtlasPhotoData,
	type AtlasPhotoId,
	CodeRef,
	Figure,
	Measured,
	PhotoPicker,
	RealPhoto,
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
	Trio,
} from "#/components/atlas/viz/explain";
import type { AtlasNode } from "#/lib/atlas/types";

// Skyline detection: how a photo becomes "one boundary row + one confidence per column".
//
// Fig. 1 re-runs the real detector recipe from src/lib/geo/skyline.ts on a small synthetic photo (120 x 64):
// the same Cauchy-free pieces that matter visually (edge feature with the 0.4 brightening discount, band-sum
// unary with FAR_ABOVE 0.2 and edge cap 0.35, truncated-L1 Viterbi with a distance transform, per-column weight
// contrast*polarity*sky-above*(1-sky-below), run / spike / trend clean-up). Pixel-unit constants (bands, edge weight,
// jump cost) are scaled by 64/600 to the thumbnail. The sky colour model is not re-fitted here: the synthetic
// photo is given its sky probability directly, so Fig. 1 shows what the Viterbi pass does with it.
// Fig. 2 ports rejectSpikes and fuseSkylines from src/lib/refine/skyline-clean.ts verbatim (on a 120-column strip).
// Fig. 1 is REAL: detectSkyline output on the bundled Niederhorn photos (public/demo/atlas, scripts/atlas/build-data.ts).
// Fig. 2 and 3 are synthetic mechanism demos.
// Numbers quoted in prose: src/lib/geo/README.md (~120 ms at 800 px), reports/leaderboard.md (skyline auto row).

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smoothstep = (a: number, b: number, x: number) => {
	const t = clamp01((x - a) / (b - a));
	return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const median = (v: number[]) => {
	if (!v.length) return Number.NaN;
	const s = [...v].sort((a, b) => a - b);
	return s[s.length >> 1];
};
function hash(x: number, y: number) {
	let h = (x * 374761393 + y * 668265263) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5;
}

// ======================================================================================
// the synthetic photo
// ======================================================================================
const W = 120;
const H = 64;
const NS = H + 1;
const ROOF = 5; // columns 0..ROOF: a roof, no sky at the top of the column
const CHALET = [80, 86] as const; // a 7-column chalet on the crest
const skylineTruth = (x: number) =>
	26 + 7 * Math.sin(x * 0.055 + 0.4) + 3.5 * Math.sin(x * 0.19 + 1.3);
const nearHill = (x: number) => skylineTruth(x) + 8 + 2 * Math.sin(x * 0.3);
const topOf = (x: number) =>
	x <= ROOF
		? -2
		: x >= CHALET[0] && x <= CHALET[1]
			? skylineTruth(x) - 9
			: skylineTruth(x);

interface Scene {
	rgb: Uint8ClampedArray; // W*H*3
	lum: Float32Array;
	sky: Float32Array; // P(sky)
}
const mix3 = (a: number[], b: number[], t: number) => [
	lerp(a[0], b[0], t),
	lerp(a[1], b[1], t),
	lerp(a[2], b[2], t),
];
let sceneCache: Scene | null = null;
function scene(): Scene {
	if (sceneCache) return sceneCache;
	const rgb = new Uint8ClampedArray(W * H * 3);
	const lum = new Float32Array(W * H);
	const sky = new Float32Array(W * H);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			const top = topOf(x);
			const near = nearHill(x);
			let c = mix3([52, 88, 140], [176, 196, 210], Math.min(1, y / 34));
			let s = 0.97;
			const cx = (x - 36) / 12;
			const cy = (y - 10) / 3.2;
			const cl = 1 - smoothstep(0.7, 1.1, Math.hypot(cx, cy));
			if (cl > 0) {
				c = mix3(c, [226, 228, 232], cl);
				s = 1;
			}
			let ter: number[];
			let sT: number;
			if (x <= ROOF || (x >= CHALET[0] && x <= CHALET[1])) {
				ter = [22, 20, 20];
				sT = 0.02;
			} else if (y < near) {
				ter = [96, 108, 122]; // hazy far ridge: sky-coloured but darker than the sky behind it
				sT = 0.2;
			} else {
				ter = [32, 40, 36];
				sT = 0.03;
			}
			const a = smoothstep(top - 0.6, top + 0.6, y);
			const col = mix3(c, ter, a);
			const n = hash(x, y) * 10;
			for (let k = 0; k < 3; k++) rgb[i * 3 + k] = col[k] + n;
			lum[i] =
				(0.3 * rgb[i * 3] + 0.59 * rgb[i * 3 + 1] + 0.11 * rgb[i * 3 + 2]) /
				255;
			sky[i] = clamp01(lerp(s, sT, a) + hash(y, x) * 0.06);
		}
	}
	sceneCache = { rgb, lum, sky };
	return sceneCache;
}

// ======================================================================================
// the detector: edge feature, Viterbi over rows, per-column weight, clean-up
// ======================================================================================
const BAND_BELOW = 10; // max(8, round(0.15 h))
const BAND_ABOVE = 13; // max(8, round(0.20 h))
const FAR_ABOVE = 0.2;
const SC = 64 / 600; // pixel-unit constants scaled to the thumbnail
const EDGE_W = 60 * SC;
const WIN = 4;
const MIN_W = 0.1;

type Reason = "ok" | "nosky" | "spike" | "low";
interface Detection {
	bound: Int32Array;
	status: Reason[];
	weight: Float32Array;
	unary: Float32Array; // W*NS
	fwd: Float32Array; // W*NS cumulative cost after each column
	umin: number;
	umax: number;
	kept: number;
}

function detect(mult: number): Detection {
	const { lum, sky } = scene();
	// edge: 3 rows above vs 3 rows at/below; brightening-downward edges discounted to 0.4
	const edge = new Float32Array(W * H);
	const step = new Float32Array(W * H);
	for (let x = 0; x < W; x++)
		for (let y = 3; y < H - 3; y++) {
			let up = 0;
			let dn = 0;
			for (let j = 1; j <= 3; j++) {
				up += lum[(y - j) * W + x];
				dn += lum[(y + j - 1) * W + x];
			}
			const d = (up - dn) / 3;
			step[y * W + x] = d;
			edge[y * W + x] = Math.abs(d) * (d > 0 ? 1 : 0.4);
		}

	const jumpCost = 2 * SC * mult;
	const jumpCap = 80 * SC * mult;
	const unaryAll = new Float32Array(W * NS);
	const fwdAll = new Float32Array(W * NS);
	const back = new Int32Array(W * NS);
	const cum = new Float32Array(NS);
	const cumS = new Float32Array(NS);
	let prev = new Float32Array(NS);
	let cur = new Float32Array(NS);
	const fwd = new Float32Array(NS);
	const fwdArg = new Int32Array(NS);
	for (let x = 0; x < W; x++) {
		cum[0] = 0;
		cumS[0] = 0;
		for (let y = 0; y < H; y++) {
			const s = sky[y * W + x];
			cum[y + 1] = cum[y] + (1 - s);
			cumS[y + 1] = cumS[y] + s;
		}
		for (let y = 0; y <= H; y++) {
			const below = cumS[Math.min(H, y + BAND_BELOW)] - cumS[y];
			const e = y > 2 && y < H ? edge[y * W + x] : 0;
			const y0 = Math.max(0, y - BAND_ABOVE);
			const above = cum[y] - cum[y0] + FAR_ABOVE * cum[y0];
			unaryAll[x * NS + y] = above + below - EDGE_W * Math.min(e, 0.35);
		}
		if (x === 0) {
			for (let y = 0; y < NS; y++) prev[y] = unaryAll[y];
			fwdAll.set(prev, 0);
			continue;
		}
		for (let y = 0; y < NS; y++) {
			fwd[y] = prev[y];
			fwdArg[y] = y;
		}
		for (let y = 1; y < NS; y++) {
			const c = fwd[y - 1] + jumpCost;
			if (c < fwd[y]) {
				fwd[y] = c;
				fwdArg[y] = fwdArg[y - 1];
			}
		}
		for (let y = NS - 2; y >= 0; y--) {
			const c = fwd[y + 1] + jumpCost;
			if (c < fwd[y]) {
				fwd[y] = c;
				fwdArg[y] = fwdArg[y + 1];
			}
		}
		let gmin = Infinity;
		let garg = 0;
		for (let y = 0; y < NS; y++)
			if (prev[y] < gmin) {
				gmin = prev[y];
				garg = y;
			}
		for (let y = 0; y < NS; y++) {
			let best = fwd[y];
			let arg = fwdArg[y];
			if (gmin + jumpCap < best) {
				best = gmin + jumpCap;
				arg = garg;
			}
			cur[y] = best + unaryAll[x * NS + y];
			back[x * NS + y] = arg;
		}
		[prev, cur] = [cur, prev];
		fwdAll.set(prev, x * NS);
	}
	const bound = new Int32Array(W);
	let best = Infinity;
	for (let y = 0; y < NS; y++)
		if (prev[y] < best) {
			best = prev[y];
			bound[W - 1] = y;
		}
	for (let x = W - 1; x > 0; x--) bound[x - 1] = back[x * NS + bound[x]];

	// ---- per-column weight ----
	const rows = new Float32Array(W).fill(Number.NaN);
	const weight = new Float32Array(W);
	const status: Reason[] = new Array(W).fill("ok");
	for (let x = 0; x < W; x++) {
		const yb = bound[x];
		if (yb < WIN + 2 || yb > H - WIN) {
			status[x] = "nosky";
			continue;
		}
		rows[x] = yb;
		let sA = 0;
		let sB = 0;
		for (let j = 3; j < WIN + 3; j++) {
			sA += sky[(yb - j) * W + x];
			sB += sky[Math.min(H - 1, yb + j - 2) * W + x];
		}
		sA /= WIN;
		sB /= WIN;
		const contrast = smoothstep(0.03, 0.15, edge[yb * W + x]);
		const polarity = 0.2 + 0.8 * smoothstep(-0.02, 0.03, step[yb * W + x]);
		weight[x] = contrast * polarity * smoothstep(0.3, 0.8, sA) * (1 - sB);
	}
	// continuity runs: short runs, and short runs sticking up above both neighbours, are down-weighted
	const jumpTol = Math.max(3, 0.012 * H);
	let start = 0;
	for (let x = 1; x <= W; x++) {
		const breaks =
			x === W ||
			Number.isNaN(rows[x]) !== Number.isNaN(rows[x - 1]) ||
			Math.abs(rows[x] - rows[x - 1]) > jumpTol;
		if (!breaks) continue;
		if (!Number.isNaN(rows[start])) {
			const len = x - start;
			let factor = smoothstep(0.01 * W, 0.06 * W, len);
			const left = start > 0 ? rows[start - 1] : Number.NaN;
			const right = x < W ? rows[x] : Number.NaN;
			let top = Infinity;
			for (let j = start; j < x; j++) top = Math.min(top, rows[j]);
			const higher = (v: number) => Number.isNaN(v) || v - top > 0.03 * H;
			const spike = len < 0.12 * W && higher(left) && higher(right);
			if (spike) factor = 0;
			for (let j = start; j < x; j++) {
				weight[j] *= factor;
				if (spike) status[j] = "spike";
			}
		}
		start = x;
	}
	// trend: columns well above the median of their confident neighbourhood lose weight
	const conf: number[] = [];
	for (let x = 0; x < W; x++) if (weight[x] >= MIN_W) conf.push(rows[x]);
	const gTrend = median(conf);
	const rad = Math.round(0.1 * W);
	const trend = new Float32Array(W);
	for (let x = 0; x < W; x++) {
		const buf: number[] = [];
		for (let j = Math.max(0, x - rad); j <= Math.min(W - 1, x + rad); j++)
			if (weight[j] >= MIN_W) buf.push(rows[j]);
		trend[x] = buf.length > rad / 2 ? median(buf) : gTrend;
	}
	let kept = 0;
	for (let x = 0; x < W; x++) {
		const up = (trend[x] - rows[x]) / H;
		if (up > 0) weight[x] *= 1 - smoothstep(0.05, 0.12, up);
		if (status[x] === "ok" && weight[x] < MIN_W) status[x] = "low";
		if (status[x] === "ok") kept++;
	}
	let umin = Infinity;
	let umax = -Infinity;
	for (const v of unaryAll) {
		if (v < umin) umin = v;
		if (v > umax) umax = v;
	}
	return {
		bound,
		status,
		weight,
		unary: unaryAll,
		fwd: fwdAll,
		umin,
		umax,
		kept,
	};
}

// ======================================================================================
// Fig. 1 — the Viterbi boundary, column by column
// ======================================================================================
type Mode = "photo" | "sky" | "cost";
const MODES: { id: Mode; label: string }[] = [
	{ id: "photo", label: "Photo" },
	{ id: "sky", label: "Sky probability" },
	{ id: "cost", label: "Cost volume" },
];
const SWEEP = 4.2;
const BACK = 2.4;
const CYCLE = 10;

function ViterbiScan() {
	const [ref, t] = useTime<HTMLDivElement>(CYCLE - 0.5);
	const [mode, setMode] = useState<Mode>("cost");
	const [mult, setMult] = useState(1);
	const det = useMemo(() => detect(mult), [mult]);
	const cv = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const c = cv.current;
		if (!c) return;
		const ctx = c.getContext("2d");
		if (!ctx) return;
		const img = ctx.createImageData(W, H);
		const sc = scene();
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const i = y * W + x;
				let r: number;
				let g: number;
				let b: number;
				if (mode === "photo") {
					[r, g, b] = [sc.rgb[i * 3], sc.rgb[i * 3 + 1], sc.rgb[i * 3 + 2]];
				} else if (mode === "sky") {
					const v = sc.sky[i];
					[r, g, b] = [14 + 200 * v, 18 + 205 * v, 24 + 200 * v];
				} else {
					// unary cost at row y of column x; row y is the "boundary sits above row y" hypothesis
					const u = det.unary[x * NS + y];
					const n = 1 - clamp01((u - det.umin) / (det.umax - det.umin));
					const v = n ** 3;
					[r, g, b] = [14 + 222 * v, 16 + 214 * v, 22 + 196 * v];
				}
				img.data[i * 4] = r;
				img.data[i * 4 + 1] = g;
				img.data[i * 4 + 2] = b;
				img.data[i * 4 + 3] = 255;
			}
		ctx.putImageData(img, 0, 0);
	}, [mode, det]);

	const ph = t % CYCLE;
	const sweeping = ph < SWEEP;
	const cursor = sweeping ? Math.floor((ph / SWEEP) * (W - 1)) : W - 1;
	const backK = sweeping ? 0 : clamp01((ph - SWEEP) / BACK);
	const revealFrom = sweeping ? W : Math.round((W - 1) * (1 - backK));

	// the DP's belief at the cursor column: lobe pointing at the cheapest row
	let lobe = "";
	if (sweeping || backK < 1) {
		const o = cursor * NS;
		let mn = Infinity;
		let mx = -Infinity;
		for (let y = 0; y < NS; y++) {
			const v = det.fwd[o + y];
			if (v < mn) mn = v;
			if (v > mx) mx = v;
		}
		const pts: string[] = [];
		for (let y = 0; y < NS; y++) {
			const n = 1 - (det.fwd[o + y] - mn) / (mx - mn + 1e-6);
			pts.push(`${(cursor + 0.5 + 16 * n ** 2).toFixed(2)},${y}`);
		}
		lobe = pts.join(" ");
	}

	const path: string[] = [];
	for (let x = Math.min(revealFrom, W - 1); x < W; x++)
		path.push(`${x + 0.5},${det.bound[x]}`);

	const reason = (s: Reason) =>
		s === "ok"
			? "var(--accent)"
			: s === "low"
				? "rgba(236,230,218,.35)"
				: "var(--rigi-trap)";

	const stateLabel = sweeping
		? "forward pass: cost-to-reach each row"
		: backK < 1
			? "backtrack: argmin pointers snap the path"
			: "boundary + weights";

	return (
		<Figure
			label="Fig. 4"
			bleed
			caption="Synthetic scene, real algorithm. Brighter = cheaper row for the boundary. The lobe is the best cost so far; the walk back draws the winner. Red dots are columns zeroed as spikes."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<div
					className="relative overflow-hidden rounded-xl bg-black/40"
					style={{ aspectRatio: `${W} / ${H}` }}
				>
					<canvas
						ref={cv}
						width={W}
						height={H}
						className="absolute inset-0 block h-full w-full"
						role="img"
						aria-label="Synthetic mountain photo shown as colour, sky probability or boundary cost volume"
					/>
					<svg
						viewBox={`0 0 ${W} ${H}`}
						className="absolute inset-0 block h-full w-full"
						aria-hidden="true"
					>
						{(sweeping || backK < 1) && (
							<>
								<line
									x1={cursor + 0.5}
									x2={cursor + 0.5}
									y1="0"
									y2={H}
									stroke="var(--accent)"
									strokeOpacity=".7"
									strokeWidth="1"
									vectorEffect="non-scaling-stroke"
								/>
								<polyline
									points={lobe}
									fill="none"
									stroke="var(--accent)"
									strokeWidth="1.4"
									vectorEffect="non-scaling-stroke"
								/>
							</>
						)}
						{path.length > 1 && (
							<polyline
								points={path.join(" ")}
								fill="none"
								stroke="rgba(236,230,218,.55)"
								strokeWidth="1"
								vectorEffect="non-scaling-stroke"
							/>
						)}
						{Array.from({ length: W - Math.min(revealFrom, W) }, (_, k) => {
							const x = Math.min(revealFrom, W) + k;
							if (x >= W) return null;
							const st = det.status[x];
							const bad = st === "spike" || st === "nosky";
							return (
								<circle
									key={x}
									cx={x + 0.5}
									cy={det.bound[x]}
									r={bad ? 0.9 : 0.7}
									fill={reason(st)}
									fillOpacity={st === "ok" ? 0.4 + 0.6 * det.weight[x] : 1}
								/>
							);
						})}
					</svg>
				</div>

				{/* per-column weights */}
				<svg
					viewBox={`0 0 ${W} 14`}
					className="mt-2 block h-auto w-full"
					role="img"
					aria-label="Per-column confidence weights"
				>
					{Array.from(det.weight, (w, x) => {
						const st = det.status[x];
						const on = x >= Math.min(revealFrom, W);
						if (!on) return null;
						return st === "ok" || st === "low" ? (
							<rect
								// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length column series, position is identity
								key={x}
								x={x + 0.1}
								width="0.8"
								y={13 - 12 * w}
								height={Math.max(0.3, 12 * w)}
								fill={reason(st)}
							/>
						) : (
							<rect
								// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length column series, position is identity
								key={x}
								x={x + 0.1}
								width="0.8"
								y={11}
								height="2"
								fill="var(--rigi-trap)"
							/>
						);
					})}
					<line
						x1="0"
						x2={W}
						y1="13.5"
						y2="13.5"
						stroke="rgba(255,255,255,.18)"
						strokeWidth="0.3"
					/>
				</svg>
				<div className="mt-1 flex justify-between font-mono text-[10px] text-white/40">
					<span>per-column weight (0 to 1)</span>
					<span>{stateLabel}</span>
				</div>
			</div>

			<div className="mt-4 grid gap-4 md:grid-cols-[1fr_auto]">
				<div className="space-y-3">
					<div
						className="flex flex-wrap gap-2"
						role="tablist"
						aria-label="Layer"
					>
						{MODES.map((m) => (
							<button
								key={m.id}
								type="button"
								role="tab"
								aria-selected={mode === m.id}
								onClick={() => setMode(m.id)}
								className={`rounded-full px-3 py-1 font-mono text-[11px] ring-1 transition ${
									mode === m.id
										? "bg-[var(--accent)] text-[var(--rigi-ink)] ring-transparent"
										: "text-white/70 ring-white/15 hover:text-white"
								}`}
							>
								{m.label}
							</button>
						))}
					</div>
					<label className="block">
						<span className="flex justify-between font-mono text-[11px] text-white/55">
							<span>
								jump cost between columns (the path barely moves: sky evidence
								dominates)
							</span>
							<span className="text-white/85">
								{mult === 1 ? "× 1.0 shipped" : `× ${mult.toFixed(2)}`}
							</span>
						</span>
						<input
							type="range"
							min={0}
							max={8}
							step={0.25}
							value={mult}
							onChange={(e) => setMult(Number(e.target.value))}
							className="mt-1 w-full accent-[var(--accent)]"
							aria-label="Jump cost multiplier"
						/>
					</label>
				</div>
				<dl className="grid min-w-[200px] grid-cols-2 gap-x-5 gap-y-2 font-mono text-[11px]">
					<div>
						<dt className="text-white/40">columns kept</dt>
						<dd className="text-white/90">
							{det.kept} / {W}
						</dd>
					</div>
					<div>
						<dt className="text-white/40">zeroed</dt>
						<dd className="text-[var(--rigi-trap)]">
							{det.status.filter((s) => s === "spike" || s === "nosky").length}
						</dd>
					</div>
				</dl>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Fig. 2 — clean-up and cross-check (rejectSpikes + fuseSkylines, ported from refine/skyline-clean.ts)
// ======================================================================================
const W2 = 120;
const H2 = 60;
interface Sky2 {
	width: number;
	height: number;
	rows: Float32Array;
	weight: Float32Array;
}
const valid = (s: Sky2, x: number) =>
	Number.isFinite(s.rows[x]) && s.weight[x] > 0.05;

function rejectSpikes(s: Sky2): Sky2 {
	const w = s.width;
	const maxW = Math.max(2, Math.round(0.02 * w));
	const rise = Math.max(3, 0.01 * s.height);
	const win = Math.max(maxW * 2, Math.round(0.04 * w));
	const rows = Float32Array.from(s.rows);
	const weight = Float32Array.from(s.weight);
	const base = new Float32Array(w);
	for (let x = 0; x < w; x++) {
		const v: number[] = [];
		for (let j = Math.max(0, x - win); j <= Math.min(w - 1, x + win); j++)
			if (valid(s, j)) v.push(s.rows[j]);
		base[x] = median(v);
	}
	let x = 0;
	while (x < w) {
		if (!(valid(s, x) && base[x] - s.rows[x] > rise)) {
			x++;
			continue;
		}
		let e = x;
		while (e < w && valid(s, e) && base[e] - s.rows[e] > rise) e++;
		if (e - x <= maxW) for (let k = x; k < e; k++) weight[k] = 0;
		x = e;
	}
	return { width: w, height: s.height, rows, weight };
}
function fuseSkylines(p: Sky2, q: Sky2): Sky2 {
	const w = p.width;
	const tol = 0.004 * w;
	const rows = Float32Array.from(p.rows);
	const weight = Float32Array.from(p.weight);
	for (let x = 0; x < w; x++) {
		if (!valid(p, x)) continue;
		if (!valid(q, x)) {
			weight[x] = 0;
			continue;
		}
		const d = p.rows[x] - q.rows[x];
		if (d < -tol || d > tol) weight[x] = 0;
		else weight[x] *= Math.min(1, q.weight[x]);
	}
	return { width: w, height: p.height, rows, weight };
}

const T2 = (x: number) =>
	24 + 9 * Math.sin(x * 0.05 + 0.5) + 3 * Math.sin(x * 0.2);
const PRIMARY: Sky2 = (() => {
	const rows = new Float32Array(W2);
	const weight = new Float32Array(W2);
	for (let x = 0; x < W2; x++) {
		rows[x] = T2(x) + hash(x, 3) * 0.5;
		weight[x] = 0.82 + 0.16 * (hash(x, 9) + 0.5);
		if (x === 30 || x === 31) rows[x] = T2(x) - 9; // a lamp post
		if (x >= 78 && x <= 90) rows[x] = T2(x) - 11; // a chalet: confident edge, wrong surface
	}
	return { width: W2, height: H2, rows, weight };
})();
const SECONDARY: Sky2 = (() => {
	const rows = new Float32Array(W2);
	const weight = new Float32Array(W2);
	for (let x = 0; x < W2; x++) {
		rows[x] = T2(x) + hash(x, 5) * 0.5; // an independent estimate of the true crest
		weight[x] = 0.8 + 0.2 * (hash(x, 1) + 0.5);
		if (x >= 8 && x <= 14) rows[x] = T2(x) - 8; // this detector follows a cloud edge here
		if (x >= 100 && x <= 104) rows[x] = Number.NaN; // and finds no boundary here
	}
	return { width: W2, height: H2, rows, weight };
})();

type Stage = 0 | 1 | 2;
const STAGES = ["raw primary", "+ rejectSpikes", "+ fuseSkylines"];

function CleanAndFuse() {
	const [stage, setStage] = useState<Stage>(0);
	const out = useMemo(() => {
		const a = PRIMARY;
		const b = stage >= 1 ? rejectSpikes(a) : a;
		return stage >= 2 ? fuseSkylines(b, SECONDARY) : b;
	}, [stage]);
	const SX = 6;
	const SY = 5;
	const gt = `M0 ${H2 * SY} ${Array.from({ length: W2 }, (_, x) => `L${(x + 0.5) * SX} ${(T2(x) * SY).toFixed(1)}`).join(" ")} L${W2 * SX} ${H2 * SY} Z`;
	const secPts: string[] = [];
	let pen = "M";
	for (let x = 0; x < W2; x++) {
		if (!Number.isFinite(SECONDARY.rows[x])) {
			pen = "M";
			continue;
		}
		secPts.push(
			`${pen}${((x + 0.5) * SX).toFixed(1)} ${(SECONDARY.rows[x] * SY).toFixed(1)}`,
		);
		pen = "L";
	}
	let survivors = 0;
	let total = 0;
	for (let x = 0; x < W2; x++) {
		if (valid(PRIMARY, x)) total++;
		if (valid(out, x)) survivors++;
	}
	return (
		<Figure
			label="Fig. 5"
			caption="Synthetic strip. Spike rejection drops the post; fusion keeps only columns both detectors agree on, so the chalet, the cloud edge and the gap drop out."
		>
			<div
				className="flex flex-wrap gap-2"
				role="tablist"
				aria-label="Filter stage"
			>
				{STAGES.map((s, i) => (
					<button
						key={s}
						type="button"
						role="tab"
						aria-selected={stage === i}
						onClick={() => setStage(i as Stage)}
						className={`rounded-full px-3 py-1 font-mono text-[11px] ring-1 transition ${
							stage === i
								? "bg-[var(--accent)] text-[var(--rigi-ink)] ring-transparent"
								: "text-white/70 ring-white/15 hover:text-white"
						}`}
					>
						{s}
					</button>
				))}
			</div>
			<svg
				viewBox={`0 0 ${W2 * SX} ${H2 * SY + 34}`}
				className="mt-3 block h-auto w-full"
				role="img"
				aria-label="Primary and secondary skyline traces with the columns that survive each filter"
			>
				<path d={gt} fill="rgba(236,230,218,.07)" />
				<path
					d={secPts.join(" ")}
					fill="none"
					stroke="rgba(236,230,218,.55)"
					strokeWidth="1.4"
					strokeDasharray="4 3"
				/>
				{Array.from({ length: W2 }, (_, x) => {
					const alive = valid(out, x);
					const cx = (x + 0.5) * SX;
					const cy = PRIMARY.rows[x] * SY;
					return alive ? (
						<circle
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length column series
							key={x}
							cx={cx}
							cy={cy}
							r="2.6"
							fill="var(--accent)"
						/>
					) : (
						<g
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length column series, position is identity
							key={x}
							stroke="var(--rigi-trap)"
							strokeWidth="1.2"
							strokeLinecap="round"
						>
							<line x1={cx - 2.2} x2={cx + 2.2} y1={cy - 2.2} y2={cy + 2.2} />
							<line x1={cx - 2.2} x2={cx + 2.2} y1={cy + 2.2} y2={cy - 2.2} />
						</g>
					);
				})}
				{/* surviving weights */}
				{Array.from({ length: W2 }, (_, x) => {
					const wv = valid(out, x) ? out.weight[x] : 0;
					return (
						<rect
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length column series, position is identity
							key={x}
							x={x * SX + 1}
							width={SX - 2}
							y={H2 * SY + 30 - 26 * wv}
							height={Math.max(1, 26 * wv)}
							fill={wv > 0 ? "var(--accent)" : "rgba(238,144,134,.5)"}
						/>
					);
				})}
				<g className="font-mono" fontSize="10" fill="rgba(236,230,218,.55)">
					<text x={30 * SX} y={(T2(30) - 9) * SY - 8} textAnchor="middle">
						post
					</text>
					<text x={84 * SX} y={(T2(84) - 11) * SY - 8} textAnchor="middle">
						chalet
					</text>
					<text x={11 * SX} y={(T2(11) - 8) * SY - 8} textAnchor="middle">
						cloud edge
					</text>
					<text x={102 * SX} y={(T2(102) - 2) * SY - 8} textAnchor="middle">
						gap
					</text>
				</g>
			</svg>
			<div className="mt-1 flex justify-between font-mono text-[11px] text-white/55">
				<span>
					<span className="text-[var(--accent)]">●</span> vouched &nbsp;
					<span className="text-[var(--rigi-trap)]">✕</span> weight 0 &nbsp;
					<span className="text-white/40">╌ second detector</span>
				</span>
				<span className="text-white/85">
					{survivors} / {total} columns vote
				</span>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Fig. 1: the real detector on the real photos
// ======================================================================================
function bandCrop(d: AtlasPhotoData): [number, number, number, number] {
	const { width: W, height: H } = d.photo;
	const ys = d.skyline.rows
		.filter((v): v is number => v != null)
		.sort((a, b) => a - b);
	if (!ys.length) return [0, 0, W, H];
	const lo = ys[Math.floor(ys.length * 0.02)];
	const hi = ys[Math.floor(ys.length * 0.98)];
	const bh = Math.min(H, Math.max(300, hi - lo + 140));
	const y0 = Math.max(0, Math.min(H - bh, lo - 90));
	return [0, Math.round(y0), W, Math.round(y0 + bh)];
}

const HARD: Partial<Record<AtlasPhotoId, string>> = {
	"demo-02":
		"Sun glare and haze: the two ends of the frame have no reliable boundary, so those columns are silent (weight 0, no row).",
	"demo-06":
		"Portrait with a dark foreground and a thin sunlit ridge: only the central ridge is vouched for, the rest of the width abstains.",
	"demo-11":
		"A person's head and hair sit on the skyline here; confidence dips where the boundary jumps onto them.",
	"demo-12":
		"Same person, same dip in confidence: occluders are where weights fall, which is what the weighting is for.",
};

function WeightStrip({ d }: { d: AtlasPhotoData }) {
	const w = d.skyline.weight;
	const rows = d.skyline.rows;
	const n = w.length;
	let pts = "";
	for (let x = 0; x < n; x++) {
		pts += `${x === 0 ? "M" : "L"}${x} ${(44 - 40 * (rows[x] == null ? 0 : w[x])).toFixed(1)}`;
	}
	return (
		<svg
			viewBox={`0 0 ${n} 52`}
			className="mt-2 block h-auto w-full"
			role="img"
			aria-label="Per-column confidence, aligned with the photo above"
		>
			<line x1={0} x2={n} y1={44} y2={44} stroke="rgba(255,255,255,.2)" />
			<line
				x1={0}
				x2={n}
				y1={4}
				y2={4}
				stroke="rgba(255,255,255,.08)"
				strokeDasharray="3 5"
			/>
			<path d={`${pts}L${n} 44L0 44Z`} fill="#f4d35e" fillOpacity={0.22} />
			<path d={pts} fill="none" stroke="#f4d35e" strokeWidth={1.4} />
			<text
				x={4}
				y={14}
				fontSize={11}
				fill="rgba(236,230,218,.55)"
				fontFamily="ui-monospace, monospace"
			>
				weight 1.0
			</text>
		</svg>
	);
}

function RealSkyline() {
	const [id, setId] = useState<AtlasPhotoId>("demo-01");
	const d = useAtlasPhoto(id);
	const idx = useAtlasIndex();
	const valid = d ? d.skyline.rows.filter((v) => v != null).length : 0;
	const w = d?.skyline.weight ?? [];
	const meanW = w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0;
	const crop = useMemo(() => (d ? bandCrop(d) : undefined), [d]);
	return (
		<Figure
			label="Fig. 2"
			caption={
				<>
					Pick any of the 12 photos. Line: the boundary. Ticks and strip: how
					much each column is trusted. <Measured data={d} />
				</>
			}
		>
			<PhotoPicker
				value={id}
				onChange={setId}
				mark={(i) => {
					const p = idx?.photos.find((q) => q.id === i);
					return p ? (
						<span className="rounded bg-black/60 px-1 font-mono text-[8px] text-white/80">
							{Math.round(p.ms.skyline)}ms
						</span>
					) : null;
				}}
			/>
			<RealPhoto
				data={d}
				layers={["skyline", "weight"]}
				toggles={["sky", "skyline", "weight"]}
				crop={crop}
			/>
			{d && <WeightStrip d={d} />}
			{d && (
				<div className="mt-3 grid grid-cols-3 gap-3 font-mono text-[11px] text-white/60">
					<span>
						<span className="text-white/90">{valid}</span> /{" "}
						{d.skyline.rows.length} columns vote
					</span>
					<span>
						mean weight{" "}
						<span className="text-white/90">{meanW.toFixed(2)}</span>
					</span>
					<span>
						detectSkyline{" "}
						<span className="text-white/90">{d.ms.skyline} ms</span>
					</span>
				</div>
			)}
			{d && HARD[id] && (
				<p className="mt-2 text-[12.5px] leading-relaxed text-white/60">
					{HARD[id]}
				</p>
			)}
		</Figure>
	);
}
// ======================================================================================
// page
// ======================================================================================
const votes = (d: AtlasPhotoData) =>
	d.skyline.rows.filter((v) => v != null).length;

/** Hero: one real photo, the detector's stages in order. */
function HeroStages() {
	const d = useAtlasPhoto("demo-01");
	const crop = useMemo(() => (d ? bandCrop(d) : undefined), [d]);
	const n = d ? votes(d) : null;
	return (
		<Figure
			label="Fig. 1"
			caption={
				<>
					{n == null
						? "One real photo, four stages."
						: `On this photo ${n} of ${d?.skyline.rows.length} columns vote; the rest abstain.`}{" "}
					<Measured data={d} />
				</>
			}
		>
			<Stages
				stages={[
					{
						label: "Photo",
						caption:
							"The detector starts from the photo alone, before any map data.",
						render: () => <RealPhoto data={d} layers={[]} crop={crop} />,
					},
					{
						label: "Where is sky?",
						caption:
							"It models the sky's colour gradient and scores every pixel: bright = sky.",
						render: () => <RealPhoto data={d} layers={["sky"]} crop={crop} />,
					},
					{
						label: "One boundary",
						caption:
							"It finds the single cheapest left-to-right path between sky and land.",
						render: () => (
							<RealPhoto data={d} layers={["skyline"]} crop={crop} />
						),
					},
					{
						label: "How sure",
						caption:
							"Each column gets a confidence. Taller, brighter ticks are believed more.",
						render: () => (
							<RealPhoto data={d} layers={["skyline", "weight"]} crop={crop} />
						),
					},
				]}
			/>
		</Figure>
	);
}

const HARD_SHORT: { id: AtlasPhotoId; note: string }[] = [
	{ id: "demo-02", note: "Glare at both ends: those columns stay silent." },
	{ id: "demo-06", note: "Dark foreground: only the sunlit ridge votes." },
	{
		id: "demo-11",
		note: "A head on the skyline is traced, and the solve rejects.",
	},
	{ id: "demo-12", note: "Same head; this time the solve still accepts." },
];

function HardCases() {
	return (
		<Figure
			label="Fig. 3"
			caption="Four hard frames, same view and scale. Gaps are columns that abstain; the head (bottom row) is the failure no weighting fully fixes."
		>
			<Gallery
				ids={HARD_SHORT.map((h) => h.id)}
				cols={2}
				tile={(d) => (
					<RealPhoto
						data={d}
						layers={["skyline", "weight"]}
						crop={bandCrop(d)}
					/>
				)}
				label={(d) => (
					<>
						<span className="text-white/80">
							{votes(d)}/{d.skyline.rows.length} vote
						</span>
						{" · "}
						{HARD_SHORT.find((h) => h.id === d.id)?.note}
					</>
				)}
			/>
		</Figure>
	);
}

function Mini({
	id,
	layers,
}: {
	id: AtlasPhotoId;
	layers: ("sky" | "skyline" | "weight")[];
}) {
	const d = useAtlasPhoto(id);
	const crop = useMemo(() => (d ? bandCrop(d) : undefined), [d]);
	return <RealPhoto data={d} layers={layers} crop={crop} />;
}

function Skyline({ node }: { node: AtlasNode }) {
	void node;
	const idx = useAtlasIndex();
	const sk = idx?.photos.map((p) => p.ms.skyline).sort((a, b) => a - b);
	const skMed = sk ? (sk[5] + sk[6]) / 2 : null;
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

			<Beat
				kicker="The idea"
				title="Every column casts one vote, with a confidence."
			>
				<p>
					The solver never looks at pixels. It gets one number per column, the
					height of the sky line, plus how much to trust it.
				</p>
				<p>
					A good detector is <strong>honest per column</strong>: sure on a clean
					crest, silent behind a roof.
				</p>
			</Beat>

			<RealSkyline />

			<Beat
				kicker="How it works"
				title="Model the sky, trace one line, weigh it."
			>
				<Trio
					steps={[
						{
							title: "Model the sky",
							body: "Sky is a smooth gradient. Pixels that break it are land.",
							visual: <Mini id="demo-03" layers={["sky"]} />,
						},
						{
							title: "Trace one line",
							body: "The cheapest path across the whole image, not 800 guesses.",
							visual: <Mini id="demo-03" layers={["skyline"]} />,
						},
						{
							title: "Weigh each column",
							body: "Sharp, dark-below edges score high. Spikes score zero.",
							visual: <Mini id="demo-03" layers={["skyline", "weight"]} />,
						},
					]}
				/>
			</Beat>

			<Beat
				kicker="Step 2, slowed down"
				title="The path is chosen for the whole image at once."
			>
				<p>
					Sweeping left to right, the search keeps the cheapest way to reach
					every row. At the end it walks back from the best finish, so one cloud
					cannot drag a single column off on its own.
				</p>
			</Beat>

			<ViterbiScan />

			<Beat
				kicker="Where it fails"
				title="Unsure columns abstain. Occluders are the real enemy."
			>
				<p>
					Glare and dark foregrounds just remove votes. A person on the ridge is
					worse: it looks like a real edge.
				</p>
			</Beat>

			<HardCases />

			<Numbers
				items={[
					{
						value: skMed == null ? "…" : `${Math.round(skMed)} ms`,
						label: "median time per photo, CPU, 800 px wide",
					},
					{ value: "0.30°", label: "median compass error left after solving" },
					{ value: "11 / 11", label: "photos within 1° of true heading" },
					{
						value: "0",
						label: "model downloads: plain arithmetic, runs anywhere",
					},
				]}
				source={
					<>
						Timing: 12 demo photos, measured. Accuracy: skyline-auto row,
						reports/leaderboard.md (11 ground-truth photos).
					</>
				}
			/>

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next: the {A("dem-horizon", "DEM horizon")}, the line the terrain says
				should be there. {A("viewport-inference", "Viewport inference")} slides
				the two together.
			</p>

			<Details>
				<h3>The five steps, exactly</h3>
				<ol>
					<li>
						<strong>Sky colour field.</strong> <code>fitSkyModel</code> fits an
						8-term polynomial in image coordinates (
						<code>1, u, v, u², uv, v², v³, uv²</code>) per channel by
						iteratively reweighted least squares (4 passes, Cauchy weights,
						sampled every 4 px), seeded with sky-looking pixels weighted by{" "}
						<code>(1 − y/h)⁶</code>.
					</li>
					<li>
						<strong>Sky probability.</strong> <code>modelSky</code> scores each
						pixel against the field: close in colour is sky; brighter and greyer
						is cloud (also sky); darker or more saturated is terrain, which is
						what catches aerial haze. Smooth texture is required; green zeroes
						the score.
					</li>
					<li>
						<strong>Viterbi over rows.</strong> Per-column unary cost: non-sky
						just above the boundary (full within a band, 0.2 beyond), sky just
						below, minus a capped colour-step edge bonus discounted when the
						image brightens downward. Columns chain by a truncated-L1 jump
						penalty solved with a two-sweep distance transform. Row 0 = "no sky
						at the top of this column".
					</li>
					<li>
						<strong>Refit and repeat.</strong> The sky model is refitted to the
						sky just above the first boundary and Viterbi runs again (
						<code>refinePasses = 1</code>). Sub-pixel row from a parabola
						through the edge response.
					</li>
					<li>
						<strong>Weight, then clean up.</strong> Weight = edge contrast ×
						polarity × sky above × terrain below. Runs are cut at jumps; short
						runs are down-weighted, short runs poking above both neighbours go
						to 0, columns well above their local median lose weight. Weight &lt;
						0.1 becomes <code>NaN</code> (no vote).
					</li>
				</ol>
				<h3>Second detector and fusion</h3>
				<p>
					<code>skylineFromSky</code> (src/lib/sky/skyline.ts) reads the same{" "}
					<code>SkylineObservation</code> from a learned sky mask: first sky run
					per column, stepping over non-sky runs under 1.5% of the height
					(wires), the 0.5 crossing for a sub-pixel row, weighted by edge
					sharpness, sky above and terrain below (×0.7 when sky does not reach
					the top). A CPU ONNX mask once produced a false accept, so it stays
					secondary. <code>rejectSpikes</code> and <code>fuseSkylines</code>{" "}
					(src/lib/refine/skyline-clean.ts) let one detector vouch for the
					other:
				</p>
				<CleanAndFuse />
				<h3>Code</h3>
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/geo/skyline.ts" />
					<CodeRef path="src/lib/refine/skyline-clean.ts" />
					<CodeRef path="src/lib/sky/skyline.ts" />
					<CodeRef path="src/lib/geo/README.md" />
					<CodeRef path="reports/leaderboard.md" />
				</div>
			</Details>
		</>
	);
}

export default memo(Skyline);
