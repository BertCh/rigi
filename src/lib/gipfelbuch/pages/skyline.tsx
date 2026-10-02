// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
	CircledKey,
	CircledNumber,
	HandMark,
	PencilLayer,
} from "#/components/gipfelbuch/notebook";
import {
	exactPolyline,
	Hachure,
	HandDot,
	HandText,
	PenArrow,
	PenCross,
	PenLine,
	SketchPath,
} from "#/components/gipfelbuch/notebook/Ink";
import type { Point } from "#/components/gipfelbuch/notebook/sketch";
import { useNotebookPhoto } from "#/components/gipfelbuch/notebook/useNotebookPhoto";
import { SWISS } from "#/components/gipfelbuch/swiss/palette";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import {
	CodeRef,
	Eq,
	Figure,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	HandLabel,
	HandRange,
	MarginNote,
	Measured,
	Op,
	PhotoPicker,
	PhotoStory,
	RealPhoto,
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
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// Skyline detection: how a photo becomes "one boundary row + one confidence per column".
//
// Fig. 1 and 2 are REAL: detectSkyline output on the bundled Niederhorn photos (public/demo/gipfelbuch,
// scripts/gipfelbuch/build-data.ts). Fig. 3 re-runs the detector recipe from src/lib/geo/skyline.ts on a small
// synthetic photo (120 x 64): edge feature with the 0.4 brightening discount, band-sum unary with FAR_ABOVE 0.2
// and edge cap 0.35, truncated-L1 Viterbi with a distance transform, per-column weight
// contrast*polarity*sky-above*(1-sky-below), run / spike / trend clean-up. Pixel-unit constants (bands, edge weight,
// jump cost) are scaled by 64/600 to the thumbnail. The sky colour model is not re-fitted here: the synthetic
// photo is given its sky probability directly, so Fig. 3 shows what the Viterbi pass does with it.
// Fig. 4 is real (hard cases). Fig. 5 ports rejectSpikes and fuseSkylines from src/lib/refine/skyline-clean.ts
// verbatim (on a 120-column strip).
// Numbers quoted in prose: src/lib/geo/README.md (~120 ms at 800 px), reports/leaderboard.md (app matcher summary,
// "skyline auto" row), reports/bench-wild.md (100 blind-verified photos).

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
	{ id: "sky", label: "Sky" },
	{ id: "cost", label: "Cost" },
];
const SWEEP = 4.2;
const BACK = 2.4;

function ViterbiScan() {
	const [ref, t] = useTime<HTMLDivElement>(SWEEP + BACK + 0.5);
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

	const ph = Math.min(t, SWEEP + BACK + 0.5); // scans and backtracks once, rests on the settled boundary
	const sweeping = ph < SWEEP;
	const cursor = sweeping ? Math.floor((ph / SWEEP) * (W - 1)) : W - 1;
	const backK = sweeping ? 0 : clamp01((ph - SWEEP) / BACK);
	const revealFrom = sweeping ? W : Math.round((W - 1) * (1 - backK));

	// The overlay is drawn in a 6x scaled frame (one column = 6 units) so pen jitter stays sub-column.
	const OS = 6;
	// the DP's belief at the cursor column: lobe pointing at the cheapest row
	let lobe: Point[] = [];
	if (sweeping || backK < 1) {
		const o = cursor * NS;
		let mn = Infinity;
		let mx = -Infinity;
		for (let y = 0; y < NS; y++) {
			const v = det.fwd[o + y];
			if (v < mn) mn = v;
			if (v > mx) mx = v;
		}
		lobe = Array.from({ length: NS }, (_, y) => {
			const n = 1 - (det.fwd[o + y] - mn) / (mx - mn + 1e-6);
			return [(cursor + 0.5 + 16 * n ** 2) * OS, y * OS] as Point;
		});
	}
	const revealX = Math.min(revealFrom, W) * OS;
	// Everything below depends only on the detection, not on the animation clock: sketch once, reveal by clip.
	const overlay = useMemo(() => {
		const bound: Point[] = Array.from(
			{ length: W },
			(_, x) => [(x + 0.5) * OS, det.bound[x] * OS] as Point,
		);
		const stub = (x: number, h: number) => {
			const cx = (x + 0.5) * OS;
			return `M${cx} 80V${(80 - h).toFixed(1)}`;
		};
		let ok = "";
		let low = "";
		let bad = "";
		const marks: { x: number; y: number; bad: boolean }[] = [];
		for (let x = 0; x < W; x++) {
			const st = det.status[x];
			if (st === "ok") ok += stub(x, Math.max(1.5, 72 * det.weight[x]));
			else if (st === "low") low += stub(x, Math.max(1.5, 72 * det.weight[x]));
			else bad += stub(x, 12);
			if (st !== "ok")
				marks.push({
					x: (x + 0.5) * OS,
					y: det.bound[x] * OS,
					bad: st !== "low",
				});
		}
		return { boundD: exactPolyline(bound), ok, low, bad, marks };
	}, [det]);
	const casing = {
		color: SWISS.paper,
		opacity: 0.85,
		data: true,
	};
	const cursorX = (cursor + 0.5) * OS;
	const lobeD = lobe.map((q, i) => `${i ? "L" : "M"}${q[0]} ${q[1]}`).join("");

	const stateLabel = sweeping
		? "sweeping: cheapest way to each row"
		: backK < 1
			? "walking back: the best path snaps in"
			: "boundary and weights";

	return (
		<Figure
			label="Fig. 3"
			bleed
			caption="Synthetic scene, real algorithm. Brighter means a cheaper row for the boundary. The lobe is the best cost so far; the walk back draws the winner. Red marks are columns dropped as spikes."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<div
					className="relative overflow-hidden bg-[#0e1013]"
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
						viewBox={`0 0 ${W * OS} ${H * OS}`}
						className="absolute inset-0 block h-full w-full"
						aria-hidden="true"
					>
						<defs>
							<clipPath id="vit-reveal">
								<rect
									x={revealX}
									y={0}
									width={W * OS - revealX}
									height={H * OS}
								/>
							</clipPath>
						</defs>
						{(sweeping || backK < 1) && (
							<>
								<SketchPath
									d={`M${cursorX} 0V${H * OS}`}
									seed="sk-cursor-casing"
									{...casing}
									width={4}
								/>
								<PenLine
									seed="sk-cursor"
									from={[cursorX, 0]}
									to={[cursorX, H * OS]}
									color="blue"
									width={1.3}
								/>
								<SketchPath
									d={lobeD}
									seed="sk-lobe-casing"
									{...casing}
									width={5}
								/>
								<SketchPath
									d={lobeD}
									seed="sk-lobe"
									data
									color={SWISS.water}
									width={2}
								/>
							</>
						)}
						<g clipPath="url(#vit-reveal)">
							<SketchPath
								d={overlay.boundD}
								seed="sk-bound-casing"
								{...casing}
								width={5}
							/>
							<SketchPath
								d={overlay.boundD}
								seed="sk-bound"
								data
								color={SWISS.forest}
								width={2.4}
							/>
							{overlay.marks.map((m) => (
								<HandDot
									key={m.x}
									x={m.x}
									y={m.y}
									r={m.bad ? 4 : 3}
									seed={`sk-mark-${m.x}`}
									color={m.bad ? "red" : "pencil"}
								/>
							))}
						</g>
					</svg>
				</div>

				{/* per-column weights */}
				<svg
					viewBox={`0 0 ${W * OS} 84`}
					className="mt-2 block h-auto w-full"
					role="img"
					aria-label="Per-column confidence weights"
				>
					<g clipPath="url(#vit-reveal-strip)">
						<defs>
							<clipPath id="vit-reveal-strip">
								<rect x={revealX} y={0} width={W * OS - revealX} height={84} />
							</clipPath>
						</defs>
						<SketchPath
							d={overlay.ok}
							seed="sk-w-ok"
							data
							color={SWISS.forest}
							width={4.6}
						/>
						<SketchPath
							d={overlay.low}
							seed="sk-w-low"
							data
							color={SWISS.pencil}
							width={4.6}
						/>
						<SketchPath
							d={overlay.bad}
							seed="sk-w-bad"
							data
							color={SWISS.red}
							width={4.6}
						/>
					</g>
					<PenLine
						from={[0, 81]}
						to={[W * OS, 81]}
						seed="sk-w-base"
						color={SWISS.pencil}
						width={1.2}
					/>
					<HandText x={8} y={20} size={17} rotate={-2}>
						tall green stub = trusted; short red = zeroed spike
					</HandText>
				</svg>
				<div
					className={`mt-1 flex justify-between font-mono gb-secondary ${TYPE.micro}`}
				>
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
								className={`px-3 py-1 font-mono transition ${
									mode === m.id
										? "bg-[var(--gb-ink)] !text-[var(--gb-paper)]"
										: "bg-[var(--gb-paper-deep)] gb-secondary"
								} ${TYPE.micro}`}
							>
								{m.label}
							</button>
						))}
					</div>
					<div className="block">
						<span
							className={`flex justify-between font-mono gb-secondary ${TYPE.micro}`}
						>
							<span>jump cost between columns</span>
							<span className="gb-ink">
								{mult === 1 ? "× 1.0 (default)" : `× ${mult.toFixed(2)}`}
							</span>
						</span>
						<HandRange
							min={0}
							max={8}
							step={0.25}
							value={mult}
							label="Jump cost multiplier"
							onChange={setMult}
						/>
					</div>
				</div>
				<dl
					className={`grid min-w-[200px] grid-cols-2 gap-x-5 gap-y-2 font-mono ${TYPE.micro}`}
				>
					<div>
						<dt className="gb-secondary">columns kept</dt>
						<dd className="gb-ink">
							{det.kept} / {W}
						</dd>
					</div>
					<div>
						<dt className="gb-secondary">zeroed</dt>
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
const STAGES = ["raw", "no spikes", "cross-checked"];

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
	const weightBars = useMemo(() => {
		let ok = "";
		let bad = "";
		for (let x = 0; x < W2; x++) {
			const cx = x * SX + SX / 2;
			if (valid(out, x)) {
				const h = Math.max(1.5, 26 * out.weight[x]);
				ok += `M${cx} ${H2 * SY + 30}V${(H2 * SY + 30 - h).toFixed(1)}`;
			} else bad += `M${cx} ${H2 * SY + 30}V${H2 * SY + 27}`;
		}
		return { ok, bad };
	}, [out]);
	return (
		<Figure
			label="Fig. D1"
			caption="Synthetic strip. Dropping spikes removes the post; cross-checking keeps only columns both detectors agree on, so the chalet, cloud edge and gap drop out."
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
						className={`px-3 py-1 font-mono transition ${
							stage === i
								? "bg-[var(--gb-ink)] !text-[var(--gb-paper)]"
								: "bg-[var(--gb-paper-deep)] gb-secondary"
						} ${TYPE.micro}`}
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
				<Hachure
					d={gt}
					seed="sk-fuse-ground"
					color="pencil"
					gap={7}
					opacity={0.35}
					width={0.8}
				/>
				<SketchPath
					d={secPts.join(" ")}
					seed="sk-fuse-second"
					data
					color={SWISS.pencil}
					width={1.6}
					dash="4 3"
				/>
				{Array.from({ length: W2 }, (_, x) => {
					const alive = valid(out, x);
					const cx = (x + 0.5) * SX;
					const cy = PRIMARY.rows[x] * SY;
					return alive ? (
						<HandDot
							key={`ok-${cx}`}
							x={cx}
							y={cy}
							r={2.6}
							seed={`sk-ok-${x}`}
							data
							color={SWISS.forest}
							opacity={1}
						/>
					) : (
						<PenCross
							key={`bad-${cx}`}
							center={[cx, cy]}
							size={2.4}
							seed={`sk-bad-${x}`}
							color={SWISS.red}
							width={1.4}
						/>
					);
				})}
				{/* surviving weights */}
				<SketchPath
					d={weightBars.ok}
					seed="sk-fuse-ok"
					data
					color={SWISS.forest}
					width={3}
				/>
				<SketchPath
					d={weightBars.bad}
					seed="sk-fuse-bad"
					data
					color={SWISS.red}
					opacity={0.6}
					width={3}
				/>
				<PencilLayer>
					<PenLine
						from={[0, H2 * SY + 30]}
						to={[W2 * SX, H2 * SY + 30]}
						seed="sk-fuse-guide"
						width={0.8}
					/>
				</PencilLayer>
				<HandText x={W2 * SX - 8} y={H2 * SY + 14} size={15} anchor="end">
					second detector disagrees: those columns get no vote
				</HandText>
				<PenArrow
					from={[W2 * SX - 150, H2 * SY + 8]}
					to={[84 * SX, T2(84) * SY + 8]}
					seed="sk-fuse-note-arrow"
					width={1.2}
				/>
				{(
					[
						["post", 30, 9],
						["chalet", 84, 11],
						["cloud edge", 11, 8],
						["gap", 102, 2],
					] as const
				).map(([label, x, lift]) => (
					<g key={label}>
						<HandLabel
							x={x * SX}
							y={(T2(x) - lift) * SY - 8}
							anchor="middle"
							color="var(--gb-ink)"
							size={12}
						>
							{label}
						</HandLabel>
						{(label === "post" || label === "chalet") && (
							<CircledKey
								x={x * SX}
								y={Math.max(12, (T2(x) - lift) * SY - 30)}
								value={label === "post" ? 1 : 2}
								seed={`sk-key-${label}`}
							/>
						)}
					</g>
				))}
			</svg>
			<div
				className={`mt-1 flex justify-between font-mono gb-secondary ${TYPE.micro}`}
			>
				<span>
					<span className="text-[var(--nb-forest)]">●</span> kept &nbsp;
					<span className="text-[var(--nb-red)]">✕</span> dropped &nbsp;
					<span className="gb-secondary">╌ second detector</span>
				</span>
				<span className="gb-ink">
					{survivors} / {total} columns vote
				</span>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Fig. 1: the real detector on the real photos
// ======================================================================================
function bandCrop(d: GipfelbuchPhotoData): [number, number, number, number] {
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

const HARD: Partial<Record<GipfelbuchPhotoId, string>> = {
	"demo-02":
		"Sun glare and haze: the two ends have no reliable boundary, so those columns get no vote.",
	"demo-06":
		"Dark foreground, thin sunlit ridge: only the central ridge votes.",
	"demo-11":
		"A head on the skyline: confidence dips where the line jumps onto it.",
	"demo-12":
		"Same person, same dip: confidence falls where something blocks the skyline.",
};

function WeightStrip({ d }: { d: GipfelbuchPhotoData }) {
	const w = d.skyline.weight;
	const rows = d.skyline.rows;
	const n = w.length;
	// one solid bar per column (fill encodes the weight), a crisp line over the bar tops, and a short
	// red stub for the columns that abstain
	let pts = "";
	let bars = "";
	let silent = "";
	for (let x = 0; x < n; x++) {
		const vote = rows[x] != null;
		const h = 40 * (vote ? w[x] : 0);
		pts += `${x === 0 ? "M" : "L"}${x + 0.5} ${(44 - h).toFixed(1)}`;
		if (vote) bars += `M${x + 0.5} 44V${(44 - h).toFixed(1)}`;
		else silent += `M${x + 0.5} 44V40`;
	}
	return (
		<svg
			viewBox={`0 0 ${n} 52`}
			className="mt-2 block h-auto w-full"
			role="img"
			aria-label="Per-column confidence, aligned with the photo above"
		>
			<PencilLayer>
				<PenLine
					from={[0, 4]}
					to={[n, 4]}
					seed="sk-strip-guide"
					width={0.8}
					dash="3 5"
				/>
			</PencilLayer>
			<SketchPath
				d={bars}
				seed="sk-strip-bars"
				data
				color={SWISS.water}
				opacity={0.45}
				width={1.02}
			/>
			<SketchPath
				d={silent}
				seed="sk-strip-silent"
				data
				color={SWISS.red}
				width={1.02}
			/>
			<SketchPath
				d={pts}
				seed="sk-strip-top"
				data
				color={SWISS.water}
				width={1.8}
			/>
			<PenLine
				from={[0, 44.5]}
				to={[n, 44.5]}
				seed="sk-strip-base"
				color={SWISS.ink}
				width={1.2}
			/>
			<HandLabel x={4} y={16} size={(12 * n) / 860} color={SWISS.pencil}>
				weight 1.0
			</HandLabel>
			<HandLabel
				x={n - 4}
				y={51}
				anchor="end"
				size={(12 * n) / 860}
				color={SWISS.red}
			>
				red stub: column abstains
			</HandLabel>
		</svg>
	);
}

function RealSkyline() {
	const [id, setId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(id);
	const idx = useGipfelbuchIndex();
	const valid = d ? d.skyline.rows.filter((v) => v != null).length : 0;
	const w = d?.skyline.weight ?? [];
	const meanW = w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0;
	const crop = useMemo(() => (d ? bandCrop(d) : undefined), [d]);
	return (
		<Figure
			label="Fig. 2"
			bleed
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
						<span
							className={`bg-[var(--gb-paper)] px-1 font-mono gb-ink ${TYPE.micro}`}
						>
							{Math.round(p.ms.skyline)}ms
						</span>
					) : null;
				}}
			/>
			<RealPhoto
				bleed
				data={d}
				layers={["skyline", "weight"]}
				toggles={["sky", "skyline", "weight"]}
				crop={crop}
			/>
			{d && <WeightStrip d={d} />}
			{d && (
				<div
					className={`mt-3 grid grid-cols-3 gap-3 font-mono gb-secondary ${TYPE.micro}`}
				>
					<span>
						<span className="gb-ink">{valid}</span> / {d.skyline.rows.length}{" "}
						columns vote
					</span>
					<span>
						mean weight <span className="gb-ink">{meanW.toFixed(2)}</span>
					</span>
					<span>
						detected in <span className="gb-ink">{d.ms.skyline} ms</span>
					</span>
				</div>
			)}
			{d && HARD[id] && (
				<p className={`mt-2 gb-secondary ${TYPE.caption}`}>{HARD[id]}</p>
			)}
		</Figure>
	);
}
// ======================================================================================
// page
// ======================================================================================
const votes = (d: GipfelbuchPhotoData) =>
	d.skyline.rows.filter((v) => v != null).length;

/** Hero: one real photo, the detector's stages in order. */
function HeroStages() {
	const [heroId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(heroId);
	const crop = useMemo(() => (d ? bandCrop(d) : undefined), [d]);
	const n = d ? votes(d) : null;
	return (
		<Figure
			label="Fig. 1"
			bleed
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
						frame: "photo",
						caption:
							"The detector starts from the photo alone, before any map data.",
						render: () => <RealPhoto bleed data={d} layers={[]} crop={crop} />,
					},
					{
						label: "Where is sky?",
						frame: "photo",
						caption:
							"It models the sky's colour gradient and scores every pixel: bright = sky.",
						render: () => (
							<RealPhoto bleed data={d} layers={["sky"]} crop={crop} />
						),
					},
					{
						label: "One boundary",
						frame: "photo",
						caption:
							"It finds the single cheapest left-to-right path between sky and land.",
						render: () => (
							<RealPhoto bleed data={d} layers={["skyline"]} crop={crop} />
						),
					},
					{
						label: "How sure",
						frame: "photo",
						caption:
							"Each column gets a confidence. Taller, brighter ticks are believed more.",
						render: () => (
							<RealPhoto
								bleed
								data={d}
								layers={["skyline", "weight"]}
								crop={crop}
							/>
						),
					},
				]}
			/>
		</Figure>
	);
}

const HARD_SHORT: { id: GipfelbuchPhotoId; note: string }[] = [
	{ id: "demo-02", note: "Glare at both ends: those columns get no vote." },
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
			label="Fig. 5"
			caption="Four hard frames, same view and scale. Gaps are columns that abstain; the head (bottom row) is the case that weighting cannot fully fix."
		>
			<Gallery
				ids={HARD_SHORT.map((h) => h.id)}
				cols={2}
				// hard but solved is a caution; a frame the solve rejects says so
				tone={(d) => (d.solved.accepted ? "caution" : "failure")}
				tag={(d) => (d.solved.accepted ? "hard" : undefined)}
				tile={(d) => (
					<RealPhoto
						data={d}
						layers={["skyline", "weight"]}
						crop={bandCrop(d)}
					/>
				)}
				label={(d) => (
					<>
						<span className="gb-ink">
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

function Mini({ layers }: { layers: ("sky" | "skyline" | "weight")[] }) {
	const [id] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(id);
	const crop = useMemo(() => (d ? bandCrop(d) : undefined), [d]);
	return <RealPhoto data={d} layers={layers} crop={crop} />;
}

function Skyline({ node }: { node: GipfelbuchNode }) {
	void node;
	const idx = useGipfelbuchIndex();
	const sk = idx?.photos.map((p) => p.ms.skyline).sort((a, b) => a - b);
	const skMed = sk ? (sk[5] + sk[6]) / 2 : null;
	return (
		<>
			<HeroStages />

			<Beat
				kicker="The idea"
				title="Each pixel column gets a skyline height and a confidence."
			>
				<p>
					The pose search does not use the photo itself. It receives one number
					per column, the skyline height, and a confidence for that number.
				</p>
				<p>
					<HandMark type="highlight">
						A good detector gives <strong>a confidence for each column</strong>:
						high on a clean crest, none behind a roof.
					</HandMark>
					{skMed != null && (
						<MarginNote mark="a">
							{`Median ${Math.round(skMed)} ms per photo on the CPU, no model download.`}
						</MarginNote>
					)}
				</p>
			</Beat>

			<RealSkyline />

			<Beat
				kicker="How it works"
				title="Model the sky colour, trace the skyline, weight each column."
			>
				<Trio
					steps={[
						{
							title: "Model the sky",
							body: "Sky is a smooth gradient. Pixels that break it are land.",
							visual: <Mini layers={["sky"]} />,
						},
						{
							title: "Trace one line",
							body: "The lowest-cost path across the whole image, instead of a separate guess for each column.",
							visual: <Mini layers={["skyline"]} />,
						},
						{
							title: "Weigh each column",
							body: "Sharp, dark-below edges score high. Spikes score zero.",
							visual: <Mini layers={["skyline", "weight"]} />,
						},
					]}
				/>
			</Beat>

			<Beat
				kicker="Step 2, in slow motion"
				title="The path is chosen for the whole image at once."
			>
				<p>
					Sweeping left to right, the search keeps the cheapest way to reach
					every row. At the end it walks back from the best finish, so{" "}
					<HandMark type="underline">
						an isolated cloud edge cannot pull a single column off the path
					</HandMark>
					.
					<MarginNote mark="b">
						The jump cost is 2 px a row, capped at 80 px, so small wobbles are
						penalised but real cliffs are still allowed.
					</MarginNote>
				</p>
			</Beat>

			<ViterbiScan />

			<Eq
				label="The line we trace"
				where={[
					{
						sym: "y",
						c: "skyline",
						text: "the boundary row chosen in column x: the yellow line.",
					},
					{
						sym: (
							<>
								U<sub>x</sub>(y)
							</>
						),
						text: "row cost: land just above y, sky just below y, minus a bonus for a sharp edge at y. The bright cost volume.",
					},
					{
						sym: "λ, T",
						text: "jump penalty per row (2 px) and its cap (80 px), so a real cliff is allowed but a wobble is not.",
					},
				]}
			>
				<Op
					op="argmin"
					under={
						<>
							y<sub>1</sub>…y<sub>W</sub>
						</>
					}
				/>
				<Op op="Σ" under={<Sym>x</Sym>} />[ <Sym>U</Sym>
				<sub>x</sub>(<Sym c="skyline">y</Sym>
				<sub>x</sub>) + min(<Sym>λ</Sym> |<Sym c="skyline">y</Sym>
				<sub>x</sub> &minus; <Sym c="skyline">y</Sym>
				<sub>x&minus;1</sub>|, <Sym>T</Sym>) ]
			</Eq>

			<Beat
				kicker="What it is for"
				title="The pose search compares the terrain horizon with the traced line."
			>
				<p>
					The pose search starts from the phone's guess, draws the terrain
					horizon there, and{" "}
					<HandMark type="underline">
						turns the camera until that line sits on the traced one
					</HandMark>
					.
				</p>
			</Beat>

			<PhotoStory number="4" focus="trace" />

			<Beat
				kicker="Where it fails"
				title="Unsure columns are skipped. Objects on the skyline cause worse errors."
			>
				<p>
					Glare and dark foregrounds just remove votes. A person on the ridge is
					worse: it looks like a real edge.{" "}
					<HandMark type="wavy">
						On 100 unseen photos, no method found the right pose for 8 of 10
						dusk shots or 21 of 36 hazy ones.
					</HandMark>
				</p>
				<p>
					Median yaw error on 11 hand-picked photos:{" "}
					<HandMark type="strike">3.0°</HandMark>{" "}
					<span
						className="nb-hand"
						style={{ color: "var(--nb-red)", fontSize: "1.25em" }}
					>
						0.30°
					</span>
					. A small set, not a held-out one.
					<MarginNote mark="c">
						A head on the ridge looks exactly like an edge.
					</MarginNote>
				</p>
			</Beat>

			<HardCases />

			<Numbers
				items={[
					{
						value: skMed == null ? "…" : `${Math.round(skMed)} ms`,
						label: "median time per photo, CPU, 800 px wide",
					},
					{
						value: "0.30°",
						label: "median yaw error on 11 hand-picked photos (3.0° before)",
					},
					{
						value: "39 / 60",
						label: "accepted poses that were right, 100 unseen photos",
					},
					{
						value: "0",
						label: "model downloads needed: the detector is plain arithmetic",
					},
				]}
				source={
					<>
						Timing: 12 demo photos. Yaw error: 11 hand-picked photos, not a
						held-out set. Last row: the app&rsquo;s skyline aligner on 100
						unseen photos, precision 0.64 with 19 gross errors; we advise
						against auto-accepting it on uploads.
					</>
				}
			/>

			<Details>
				<h3>The five steps</h3>
				<ol>
					<li>
						<strong>Sky colour field.</strong> A smooth sky colour field is
						fitted: an 8-term polynomial in image coordinates (
						<code>1, u, v, u², uv, v², v³, uv²</code>) per channel by
						iteratively reweighted least squares (4 passes, Cauchy weights,
						sampled every 4 px), seeded with sky-looking pixels weighted by{" "}
						<code>(1 − y/h)⁶</code>.
					</li>
					<li>
						<strong>Sky probability.</strong> Each pixel is scored against the
						field: close in colour is sky; brighter and greyer is cloud (also
						sky); darker or more saturated is terrain, which catches haze.
						Smooth texture is required; green scores zero.
					</li>
					<li>
						<strong>Best path over rows.</strong> Per-column cost: non-sky just
						above the boundary (full within a band, 0.2 beyond), sky just below,
						minus a capped colour-step edge bonus discounted when the image
						brightens downward. Jumps between columns cost extra, capped. Row 0
						means no sky at the top of the column.
					</li>
					<li>
						<strong>Refit and repeat.</strong> The sky model is refitted to the
						sky just above the first boundary and the path runs again. Sub-pixel
						rows come from the edge response.
					</li>
					<li>
						<strong>Weight, then clean up.</strong> Weight = edge contrast ×
						polarity × sky above × terrain below. Runs are cut at jumps; short
						runs are down-weighted, short runs poking above both neighbours go
						to 0, columns well above their neighbours lose weight. Under 0.1
						means no vote.
					</li>
				</ol>
				<h3>Second detector and cross-check</h3>
				<p>
					A second detector reads a learned sky mask and gives its own skyline:
					first sky run per column, stepping over thin non-sky runs (wires),
					weighted by edge sharpness, sky above and terrain below. It once
					produced a false accept, so it only checks the first. Each detector
					can vouch for the other:
				</p>
				<CleanAndFuse />
				<p>
					In the figure: <CircledNumber value={1} seed="sk-p1" /> the post is a
					spike, so it is dropped; <CircledNumber value={2} seed="sk-p2" /> only
					one detector vouches for the chalet, so{" "}
					<HandMark type="double">cross-checking drops it too</HandMark>.
				</p>
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
