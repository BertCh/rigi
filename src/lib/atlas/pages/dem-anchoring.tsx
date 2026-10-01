// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
	CodeRef,
	Figure,
	Measured as PhotoMeasured,
	Plot,
	RealPhoto,
	Steps,
	useAtlasPhoto,
	useReducedMotion,
	useTime,
} from "#/components/atlas/viz";
import {
	Beat,
	Details,
	Numbers,
	Stages,
	Trio,
} from "#/components/atlas/viz/explain";
import { atlasHref, byId } from "#/lib/atlas/graph-utils";
import type { AtlasNode } from "#/lib/atlas/types";
import { curveRange } from "#/lib/nearfield/anchor";

// DEM anchoring: how a monocular depth map is turned into metres by fitting a range curve to the terrain.
// Mechanism constants are the real ones in src/lib/nearfield/anchor.ts:
//   candidate DEM range 15..3000 m, band ln 1.25, curve knots <= 6 at weighted quantiles 2..98 %, min spacing 0.2,
//   slopes in [0.75, 6], y grid step 0.02, octave weights, slope-1 beyond the far knot, near blend to 1 at 15 m,
//   quality = inlierFrac * exp(-(err/0.2)^2), hide < 0.15, low-trust label < 0.35, nMin 200.
// Report numbers (reports/step-inside-results.md): DEM/model ratio ~1 at 20 m, 2.9 at 100-300 m, 6.6 at 300-1000 m;
// terrain residual 0.34 (one scale) -> 0.13 (curve). The scatter below is a deterministic SCHEMATIC generated from
// those ratios, then fitted here with a port of fitCurve (direct pairwise costs instead of histograms).

// Measured data: scripts/atlas/data-terrain.ts → /demo/atlas/terrain/terrain.json
//   range: DEM ray length (Terrarium, TerrainSampler.sampleAt + a ray march) for every 20th pixel of demo-01 at its solved pose
//   spike: the 27 range curves the shipped fitCurve found on real photos in the P0 spike (tools/nearfield/spike/place.json)
type TerrainData = {
	generated: string;
	script: string;
	range: {
		id: string;
		dem: string;
		cell: number;
		cols: number;
		rows: number;
		grid: (number | null)[][];
	};
	spike: {
		source: string;
		nPhotos: number;
		nFitted: number;
		medianResidCurve: number;
		medianResidScale: number;
		nResid: number;
		passQ15: number;
		passQ35: number;
		fits: {
			id: string;
			x: number[];
			y: number[];
			quality: number;
			resid: number;
			inlier: number;
		}[];
	};
};
let terrainCache: Promise<TerrainData> | null = null;
function useTerrainData() {
	const [d, setD] = useState<TerrainData | null>(null);
	useEffect(() => {
		let live = true;
		terrainCache ??= fetch("/demo/atlas/terrain/terrain.json").then((r) => {
			if (!r.ok) throw new Error(`terrain.json ${r.status}`);
			return r.json();
		});
		terrainCache.then(
			(v) => live && setD(v),
			(e) => {
				terrainCache = null;
				console.warn("[atlas]", e);
			},
		);
		return () => {
			live = false;
		};
	}, []);
	return d;
}

const BAND = Math.log(1.25);
const STEP = 0.02;
const SLOPE = [0.75, 6] as const;
const NEAR = 15;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (v: number) => {
	const u = clamp01(v);
	return u * u * (3 - 2 * u);
};
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const AMBER = "#e0b252";
const ROSE = "#e07a7a";
const SKY = "#7fa6d6";
const VIOLET = "#a58be0";

function link(id: string, label: string) {
	if (!byId.has(id)) return <>{label}</>;
	return (
		<Link to={atlasHref(id)} className="underline decoration-white/25">
			{label}
		</Link>
	);
}

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---------- the schematic world: model ray m (m) vs DEM range D (m) ----------
// "truth" knots (m, D): ratio 1 at 15-20 m, ~2.9 at DEM 100-300 m, ~6.6 at DEM 300-1000 m (step-inside-results.md).
const TRUTH: [number, number][] = [
	[15, 15],
	[30, 42],
	[60, 175],
	[120, 790],
	[400, 2600],
].map(([m, d]) => [Math.log(m), Math.log(d)]);
function truthY(x: number) {
	const n = TRUTH.length;
	if (x <= TRUTH[0][0]) return x;
	if (x >= TRUTH[n - 1][0]) return TRUTH[n - 1][1] + (x - TRUTH[n - 1][0]);
	let k = 0;
	while (k < n - 2 && x > TRUTH[k + 1][0]) k++;
	const t = (x - TRUTH[k][0]) / (TRUTH[k + 1][0] - TRUTH[k][0]);
	return lerp(TRUTH[k][1], TRUTH[k + 1][1], t);
}

type Pt = { x: number; y: number; w: number; obj: boolean };
const PTS: Pt[] = (() => {
	const r = rng(11);
	const out: Pt[] = [];
	const x0 = Math.log(12);
	const x1 = Math.log(420);
	while (out.length < 300) {
		const x = x0 + (x1 - x0) * r() ** 0.6;
		const noise = (r() + r() + r() - 1.5) * 0.16;
		const obj = r() < 0.16;
		// objects standing in front of far terrain: the model sees the object, the DEM sees the ground behind it
		const y = truthY(x) + noise + (obj ? 0.45 + 1.1 * r() : 0);
		if (y < Math.log(15) || y > Math.log(3000)) continue;
		out.push({ x, y, w: 1, obj });
	}
	// equal total weight per octave of DEM range, normalised to mean 1 (as fitCurve)
	const cnt = new Map<number, number>();
	for (const p of out) {
		const o = Math.floor(p.y / Math.LN2);
		cnt.set(o, (cnt.get(o) ?? 0) + 1);
	}
	let sw = 0;
	for (const p of out) {
		p.w = 1 / (cnt.get(Math.floor(p.y / Math.LN2)) ?? 1);
		sw += p.w;
	}
	for (const p of out) p.w *= out.length / sw;
	return out;
})();

const median = (a: number[]) => {
	const s = [...a].sort((p, q) => p - q);
	return s.length ? s[s.length >> 1] : Number.NaN;
};
function weightedMedian(v: number[], w: number[]) {
	const o = v.map((_, i) => i).sort((a, b) => v[a] - v[b]);
	let tot = 0;
	for (const i of o) tot += w[i];
	let acc = 0;
	for (const i of o) {
		acc += w[i];
		if (acc >= tot / 2) return v[i];
	}
	return Number.NaN;
}

type Curve = { x: number[]; y: number[] };

/** anchor.ts curveRange in log space: log metres at log model ray lx. */
function curveLog(c: Curve, lx: number) {
	const { x, y } = c;
	const n = x.length;
	if (lx <= x[0]) {
		const ln = Math.log(NEAR);
		const lr0 = y[0] - x[0];
		if (x[0] <= ln || lr0 <= 0) return y[0] + lx - x[0];
		const w = Math.max(0, (lx - ln) / (x[0] - ln));
		return lx + w * lr0;
	}
	if (lx >= x[n - 1]) return y[n - 1] + lx - x[n - 1];
	let k = 0;
	while (k < n - 2 && lx > x[k + 1]) k++;
	const t = (lx - x[k]) / (x[k + 1] - x[k]);
	return lerp(y[k], y[k + 1], t);
}

/** Port of fitCurve: weighted-quantile knots, DP over knot values with truncated L1 + slope bounds. */
function fitCurve(): Curve {
	const n = PTS.length;
	const order = PTS.map((_, i) => i).sort((a, b) => PTS[a].x - PTS[b].x);
	let acc = 0;
	const cw = order.map((i) => {
		acc += PTS[i].w;
		return acc / n;
	});
	const cand: number[] = [];
	for (let q = 0; q < 6; q++) {
		const qq = 0.02 + (0.96 * q) / 5;
		let j = 0;
		while (j < n - 1 && cw[j] < qq) j++;
		cand.push(PTS[order[j]].x);
	}
	const kx = [cand[0]];
	for (const c of cand.slice(1)) if (c - kx[kx.length - 1] >= 0.2) kx.push(c);
	const last = cand[cand.length - 1];
	if (
		kx.length >= 2 &&
		last !== kx[kx.length - 1] &&
		last - kx[kx.length - 2] >= 0.2
	)
		kx[kx.length - 1] = last;
	const K = kx.length;
	const ys = PTS.map((p) => p.y).sort((a, b) => a - b);
	const g0 = ys[Math.floor(0.01 * (n - 1))] - 2;
	const g1 = ys[Math.floor(0.99 * (n - 1))] + 1;
	const G = Math.ceil((g1 - g0) / STEP) + 1;
	const grid = (a: number) => g0 + a * STEP;

	const left: Pt[] = [];
	const right: Pt[] = [];
	const seg: Pt[][] = Array.from({ length: K - 1 }, () => []);
	for (const p of PTS) {
		if (p.x < kx[0]) left.push(p);
		else if (p.x >= kx[K - 1]) right.push(p);
		else {
			let s = 0;
			while (s < K - 2 && p.x >= kx[s + 1]) s++;
			seg[s].push(p);
		}
	}
	const unary = (pts: Pt[], x0: number) => {
		const c = new Float64Array(G);
		for (let a = 0; a < G; a++) {
			let s = 0;
			for (const p of pts)
				s += p.w * Math.min(Math.abs(p.y - (grid(a) + p.x - x0)), BAND);
			c[a] = s;
		}
		return c;
	};
	let V = unary(left, kx[0]);
	const back: Int32Array[] = [];
	for (let s = 0; s < K - 1; s++) {
		const dx = kx[s + 1] - kx[s];
		const dmin = Math.ceil((SLOPE[0] * dx) / STEP);
		const dmax = Math.floor((SLOPE[1] * dx) / STEP);
		const Vn = new Float64Array(G).fill(Number.POSITIVE_INFINITY);
		const Bn = new Int32Array(G);
		const pts = seg[s];
		const tt = pts.map((p) => (p.x - kx[s]) / dx);
		for (let d = dmin; d <= dmax; d++)
			for (let a = 0; a + d < G; a++) {
				const va = V[a];
				if (!Number.isFinite(va)) continue;
				const ya = grid(a);
				const dy = d * STEP;
				let c = va;
				for (let i = 0; i < pts.length; i++)
					c +=
						pts[i].w * Math.min(Math.abs(pts[i].y - (ya + tt[i] * dy)), BAND);
				if (c < Vn[a + d]) {
					Vn[a + d] = c;
					Bn[a + d] = a;
				}
			}
		if (s === K - 2) {
			const U = unary(right, kx[K - 1]);
			for (let b = 0; b < G; b++) Vn[b] += U[b];
		}
		V = Vn;
		back.push(Bn);
	}
	let bi = 0;
	for (let b = 1; b < G; b++) if (V[b] < V[bi]) bi = b;
	const yi = [bi];
	for (let s = back.length - 1; s >= 0; s--)
		yi.push(back[s][yi[yi.length - 1]]);
	yi.reverse();
	const ky = yi.map(grid);
	// sub-grid refinement: weighted median of inlier residuals
	const res: number[] = [];
	const rw: number[] = [];
	for (const p of PTS) {
		const e = p.y - curveLog({ x: kx, y: ky }, p.x);
		if (Math.abs(e) <= BAND) {
			res.push(e);
			rw.push(p.w);
		}
	}
	const sh = weightedMedian(res, rw);
	return { x: kx, y: Number.isFinite(sh) ? ky.map((v) => v + sh) : ky };
}

/** The one-scale fit: mode of log(D/m) (densest 2*band window, refined), as the legacy "scale" mode. */
function fitScale() {
	const r = PTS.map((p) => p.y - p.x).sort((a, b) => a - b);
	let best = 0;
	let bi = 0;
	for (let a = 0, b = 0; a < r.length; a++) {
		while (b < r.length && r[b] - r[a] <= 2 * BAND) b++;
		if (b - a > best) {
			best = b - a;
			bi = a;
		}
	}
	let s = median(r.slice(bi, bi + best));
	for (let it = 0; it < 8; it++) {
		const m = median(r.filter((v) => Math.abs(v - s) <= BAND));
		if (!Number.isFinite(m) || Math.abs(m - s) < 1e-6) break;
		s = m;
	}
	return s;
}

function stats(c: Curve) {
	const e = PTS.map((p) => Math.abs(p.y - curveLog(c, p.x)));
	return {
		err: median(e),
		inl: e.filter((v) => v <= BAND).length / e.length,
	};
}

// ---------- Fig. 1: scatter + curve morph ----------
const FW = 560;
const FH = 410;
const PADL = 58;
const PADR = 16;
const PADT = 14;
const PADB = 56;
const XL = [Math.log(10), Math.log(500)] as const;
const YL = [Math.log(10), Math.log(4000)] as const;
const sx = (lx: number) =>
	PADL + ((lx - XL[0]) / (XL[1] - XL[0])) * (FW - PADL - PADR);
const sy = (ly: number) =>
	FH - PADB - ((ly - YL[0]) / (YL[1] - YL[0])) * (FH - PADT - PADB);
const XT = [10, 30, 100, 300];
const YT = [10, 30, 100, 300, 1000, 3000];

function CurveFigure() {
	const [ref, t] = useTime<HTMLDivElement>(10);
	const [mode, setMode] = useState<"auto" | "scale" | "curve">("auto");
	const fit = useMemo(() => fitCurve(), []);
	const s0 = useMemo(() => fitScale(), []);
	const scaleCurve: Curve = useMemo(
		() => ({ x: fit.x, y: fit.x.map((x) => x + s0) }),
		[fit, s0],
	);
	const scaleStats = useMemo(() => stats(scaleCurve), [scaleCurve]);
	const fitStats = useMemo(() => stats(fit), [fit]);

	const tt = t % 17;
	const auto =
		tt < 5
			? 0
			: tt < 9.5
				? ease((tt - 5) / 4.5)
				: tt < 15
					? 1
					: 1 - ease((tt - 15) / 2);
	const p = mode === "auto" ? auto : mode === "scale" ? 0 : 1;
	const knotOn = mode === "auto" ? clamp01((tt - 3) / 1.2) : 1;
	const cur: Curve = {
		x: fit.x,
		y: fit.y.map((y, i) => lerp(scaleCurve.y[i], y, p)),
	};
	const st = stats(cur);

	const path = (c: Curve, off = 0) => {
		const pts: string[] = [];
		for (let i = 0; i <= 90; i++) {
			const lx = lerp(Math.log(8), XL[1], i / 90);
			const ly = curveLog(c, lx) + off;
			pts.push(`${i ? "L" : "M"}${sx(lx).toFixed(1)} ${sy(ly).toFixed(1)}`);
		}
		return pts.join("");
	};
	const ribbon = () => {
		const up: string[] = [];
		const dn: string[] = [];
		for (let i = 0; i <= 60; i++) {
			const lx = lerp(XL[0], XL[1], i / 60);
			const ly = curveLog(cur, lx);
			up.push(`${sx(lx).toFixed(1)} ${sy(ly + BAND).toFixed(1)}`);
			dn.push(`${sx(lx).toFixed(1)} ${sy(ly - BAND).toFixed(1)}`);
		}
		return `M${up.join("L")}L${dn.reverse().join("L")}Z`;
	};
	const clipId = "da-clip";

	const Chip = ({ m, label }: { m: typeof mode; label: string }) => (
		<button
			type="button"
			onClick={() => setMode(m)}
			aria-pressed={mode === m}
			className={`rounded-full px-3 py-1 font-mono text-[11px] ring-1 transition ${
				mode === m
					? "bg-[var(--accent)] text-black ring-transparent"
					: "text-white/65 ring-white/15 hover:bg-white/5"
			}`}
		>
			{label}
		</button>
	);

	return (
		<Figure
			label="Fig. 3"
			caption="Synthetic scene, real algorithm. Each dot is one ground pixel: model depth across, map distance up. One scale misses the bend; the curve follows it."
		>
			<div ref={ref}>
				<div className="mb-3 flex flex-wrap items-center gap-2">
					<Chip m="auto" label="play" />
					<Chip m="scale" label="one scale" />
					<Chip m="curve" label="range curve" />
					<span className="ml-auto font-mono text-[11px] text-white/45">
						{mode === "auto"
							? p < 0.02
								? "1 · one global scale"
								: p < 0.98
									? "2 · knots pull the line onto the DEM"
									: "3 · monotone log-log curve"
							: mode === "scale"
								? "dem = s · model"
								: "dem = f(model)"}
					</span>
				</div>
				<svg
					viewBox={`0 0 ${FW} ${FH}`}
					className="h-auto w-full"
					role="img"
					aria-label="Log-log scatter of DEM range against model ray length with a fitted curve"
				>
					<defs>
						<clipPath id={clipId}>
							<rect
								x={PADL}
								y={PADT}
								width={FW - PADL - PADR}
								height={FH - PADT - PADB}
							/>
						</clipPath>
					</defs>
					{YT.map((v) => (
						<g key={`y${v}`}>
							<line
								x1={PADL}
								x2={FW - PADR}
								y1={sy(Math.log(v))}
								y2={sy(Math.log(v))}
								stroke="white"
								strokeOpacity={0.07}
							/>
							<text
								x={PADL - 8}
								y={sy(Math.log(v)) + 4}
								textAnchor="end"
								fontSize={13}
								fill="white"
								fillOpacity={0.5}
							>
								{v >= 1000 ? `${v / 1000} km` : `${v} m`}
							</text>
						</g>
					))}
					{XT.map((v) => (
						<g key={`x${v}`}>
							<line
								y1={PADT}
								y2={FH - PADB}
								x1={sx(Math.log(v))}
								x2={sx(Math.log(v))}
								stroke="white"
								strokeOpacity={0.07}
							/>
							<text
								x={sx(Math.log(v))}
								y={FH - PADB + 18}
								textAnchor="middle"
								fontSize={13}
								fill="white"
								fillOpacity={0.5}
							>
								{v} m
							</text>
						</g>
					))}
					<text
						x={(PADL + FW - PADR) / 2}
						y={FH - 20}
						textAnchor="middle"
						fontSize={13}
						fill="white"
						fillOpacity={0.6}
					>
						model ray length (m)
					</text>
					<text
						transform={`translate(14 ${(PADT + FH - PADB) / 2}) rotate(-90)`}
						textAnchor="middle"
						fontSize={13}
						fill="white"
						fillOpacity={0.6}
					>
						DEM range (m)
					</text>

					<g clipPath={`url(#${clipId})`}>
						{/* identity: what "metric depth taken at face value" would be */}
						<path
							d={path({ x: [Math.log(8)], y: [Math.log(8)] })}
							fill="none"
							stroke="white"
							strokeOpacity={0.25}
							strokeDasharray="3 5"
						/>
						<path d={ribbon()} fill="var(--accent)" fillOpacity={0.12} />
						{PTS.map((pt, i) => {
							const e = Math.abs(pt.y - curveLog(cur, pt.x));
							const inl = e <= BAND;
							return (
								<circle
									// biome-ignore lint/suspicious/noArrayIndexKey: static point set, never reordered
									key={i}
									cx={sx(pt.x)}
									cy={sy(pt.y)}
									r={2.7}
									fill={inl ? "var(--accent)" : "white"}
									fillOpacity={inl ? 0.8 : 0.3}
								/>
							);
						})}
						<path
							d={path(cur)}
							fill="none"
							stroke="var(--rigi-paper)"
							strokeWidth={2.4}
							strokeLinejoin="round"
						/>
					</g>
					{cur.x.map((x, i) => (
						<g key={`k${x}`} opacity={knotOn}>
							<line
								x1={sx(x)}
								x2={sx(x)}
								y1={sy(cur.y[i])}
								y2={FH - PADB}
								stroke="var(--rigi-paper)"
								strokeOpacity={0.3}
								strokeDasharray="2 4"
							/>
							<circle
								cx={sx(x)}
								cy={sy(cur.y[i])}
								r={6}
								fill="var(--rigi-ink)"
								stroke="var(--rigi-paper)"
								strokeWidth={2}
							/>
						</g>
					))}
					<text
						x={sx(Math.log(11))}
						y={sy(Math.log(11)) - 22}
						fontSize={12}
						fill="white"
						fillOpacity={0.4}
						transform={`rotate(-17 ${sx(Math.log(11))} ${sy(Math.log(11))})`}
					>
						depth taken at face value
					</text>
				</svg>
				<div className="mt-3 grid grid-cols-3 gap-3 text-center">
					<div>
						<div className="display-title text-2xl text-[var(--accent)]">
							{(st.inl * 100).toFixed(0)}%
						</div>
						<div className="font-mono text-[10.5px] text-white/50">
							inside the ±25 % band
						</div>
					</div>
					<div>
						<div className="display-title text-2xl text-[var(--accent)]">
							{st.err.toFixed(2)}
						</div>
						<div className="font-mono text-[10.5px] text-white/50">
							median |log residual|
						</div>
					</div>
					<div>
						<div className="display-title text-2xl text-[var(--accent)]">
							{cur.x.length}
						</div>
						<div className="font-mono text-[10.5px] text-white/50">
							knots (≤ 6)
						</div>
					</div>
				</div>
				<p className="mt-3 text-center font-mono text-[10.5px] text-white/35">
					this scatter: one scale {scaleStats.err.toFixed(2)} → curve{" "}
					{fitStats.err.toFixed(2)} · real photos (23 dev): 0.34 → 0.13
				</p>
			</div>
		</Figure>
	);
}

// ---------- Fig. 2: candidate selection + ray length ----------
const COLS = 32;
const ROWS = 18;
const CW = 320 / COLS;
const CH = 190 / ROWS;
const skylineAt = (u: number) =>
	0.36 + 0.09 * Math.sin(u * 7.3 + 0.4) + 0.05 * Math.sin(u * 17 + 1.7);
type Cell = "sky" | "person" | "near" | "far" | "kept";
function classify(i: number, j: number): Cell {
	const u = (i + 0.5) / COLS;
	const v = (j + 0.5) / ROWS;
	const sk = skylineAt(u);
	if (v < sk) return "sky";
	if (u > 0.6 && u < 0.7 && v > 0.52 && v < 0.96) return "person";
	if (v > 0.9) return "near";
	if (v < sk + 0.07) return "far";
	return "kept";
}
const CELLS: Cell[][] = Array.from({ length: COLS }, (_, i) =>
	Array.from({ length: ROWS }, (_, j) => classify(i, j)),
);
const CELL_COL: Record<Cell, string> = {
	sky: SKY,
	person: AMBER,
	near: ROSE,
	far: VIOLET,
	kept: "var(--accent)",
};
const CELL_LABEL: Record<Cell, string> = {
	sky: "sky mask",
	person: "people mask",
	near: "DEM < 15 m",
	far: "DEM > 3 km",
	kept: "candidate pair",
};

function CandidateFigure() {
	const [ref, t] = useTime<HTMLDivElement>(10);
	const reduce = useReducedMotion();
	const sweep = reduce ? 1 : Math.min(1, (t % 9) / 5.5);
	const counts = { sky: 0, person: 0, near: 0, far: 0, kept: 0 } as Record<
		Cell,
		number
	>;
	for (let i = 0; i < COLS; i++)
		if ((i + 0.5) / COLS <= sweep)
			for (let j = 0; j < ROWS; j++) counts[CELLS[i][j]]++;

	// ray-length diagram
	const th = reduce ? 0.5 : 0.62 * Math.sin(t * 0.7);
	const cx = 160;
	const cy = 205;
	const zl = 150;
	const px = cx + Math.tan(th) * zl;
	const py = cy - zl;
	const fac = 1 / Math.cos(th);

	return (
		<Figure
			label="Fig. 5"
			caption="Schematic. Left: which pixels become (model, DEM) pairs. Sky, people, grazing near ground and the far haze never reach the fit. Right: the model predicts z-depth, the DEM gives ray length, so each pixel's depth is first stretched by rayFactor."
		>
			<div ref={ref} className="grid gap-6 sm:grid-cols-2">
				<div>
					<svg
						viewBox="0 0 320 250"
						className="h-auto w-full"
						role="img"
						aria-label="A photo grid with sky, people, near and far pixels rejected"
					>
						{CELLS.map((col, i) =>
							col.map((c, j) => {
								const seen = (i + 0.5) / COLS <= sweep;
								const kept = c === "kept";
								return (
									<rect
										// biome-ignore lint/suspicious/noArrayIndexKey: static grid, never reordered
										key={`${i}-${j}`}
										x={i * CW + 0.6}
										y={j * CH + 0.6}
										width={CW - 1.2}
										height={CH - 1.2}
										rx={1.5}
										fill={seen ? CELL_COL[c] : "white"}
										fillOpacity={seen ? (kept ? 0.85 : 0.5) : 0.07}
									/>
								);
							}),
						)}
						<line
							x1={sweep * 320}
							x2={sweep * 320}
							y1={0}
							y2={190}
							stroke="var(--rigi-paper)"
							strokeOpacity={sweep < 1 ? 0.7 : 0}
							strokeWidth={1.5}
						/>
						{(Object.keys(CELL_LABEL) as Cell[]).map((c, i) => (
							<g
								key={c}
								transform={`translate(${(i % 3) * 108 + 2} ${206 + Math.floor(i / 3) * 20})`}
							>
								<rect
									width={10}
									height={10}
									rx={2}
									fill={CELL_COL[c]}
									fillOpacity={c === "kept" ? 0.85 : 0.5}
								/>
								<text
									x={15}
									y={9}
									fontSize={10.5}
									fill="white"
									fillOpacity={0.65}
								>
									{CELL_LABEL[c]} {counts[c]}
								</text>
							</g>
						))}
					</svg>
				</div>
				<div>
					<svg
						viewBox="0 0 320 250"
						className="h-auto w-full"
						role="img"
						aria-label="z-depth versus ray length for a pixel off the optical axis"
					>
						<line
							x1={cx}
							x2={cx}
							y1={cy}
							y2={cy - zl - 25}
							stroke="white"
							strokeOpacity={0.25}
							strokeDasharray="2 4"
						/>
						<text
							x={cx + 6}
							y={cy - zl - 27}
							fontSize={10.5}
							fill="white"
							fillOpacity={0.4}
						>
							optical axis
						</text>
						{/* image plane */}
						<line
							x1={cx - 55}
							x2={cx + 55}
							y1={cy - 38}
							y2={cy - 38}
							stroke="white"
							strokeOpacity={0.35}
							strokeWidth={2}
						/>
						<text
							x={cx + 60}
							y={cy - 34}
							fontSize={10.5}
							fill="white"
							fillOpacity={0.4}
						>
							image
						</text>
						{/* depth leg + ray */}
						<line
							x1={cx}
							x2={cx}
							y1={cy}
							y2={py}
							stroke={AMBER}
							strokeWidth={2.2}
						/>
						<line
							x1={cx}
							x2={px}
							y1={py}
							y2={py}
							stroke="white"
							strokeOpacity={0.4}
							strokeDasharray="3 4"
						/>
						<line
							x1={cx}
							x2={px}
							y1={cy}
							y2={py}
							stroke="var(--accent)"
							strokeWidth={2.6}
						/>
						<circle cx={cx} cy={cy} r={5} fill="var(--rigi-paper)" />
						<circle cx={px} cy={py} r={6} fill="var(--accent)" />
						<text
							x={cx - 8}
							y={cy - zl / 2}
							textAnchor="end"
							fontSize={11.5}
							fill={AMBER}
						>
							z (model)
						</text>
						<text
							x={(cx + px) / 2 + (th > 0 ? 10 : -10)}
							y={cy - zl / 2 + 16}
							textAnchor={th > 0 ? "start" : "end"}
							fontSize={11.5}
							fill="var(--accent)"
						>
							|ray| (DEM)
						</text>
						<text
							x={160}
							y={236}
							textAnchor="middle"
							fontSize={12}
							fill="var(--rigi-paper)"
						>
							|ray| = z · √(1 + x² + y²) = z × {fac.toFixed(2)}
						</text>
					</svg>
				</div>
			</div>
		</Figure>
	);
}

// ---------- Fig. 3: trust gauge ----------
const QS = 0.2;
const QW = 560;
const QH = 270;
function GaugeFigure() {
	const [err, setErr] = useState(0.13);
	const [inl, setInl] = useState(0.85);
	const q = (e: number) => inl * Math.exp(-((e / QS) ** 2));
	const qx = (e: number) => 46 + (e / 0.5) * (QW - 46 - 16);
	const qy = (v: number) => 226 - v * 200;
	const cur = q(err);
	const state = cur < 0.15 ? "hidden" : cur < 0.35 ? "low trust" : "trusted";
	const stateColor = cur < 0.15 ? ROSE : cur < 0.35 ? AMBER : "var(--accent)";
	const pts = Array.from({ length: 101 }, (_, i) => {
		const e = (i / 100) * 0.5;
		return `${i ? "L" : "M"}${qx(e).toFixed(1)} ${qy(q(e)).toFixed(1)}`;
	}).join("");
	return (
		<Figure
			label="Fig. 6"
			caption="Quality = inlier fraction × exp(−(err/0.2)²). Drag the two inputs: the dot is the photo, the colour is what Step Inside does with it."
		>
			<svg
				viewBox={`0 0 ${QW} ${QH}`}
				className="h-auto w-full"
				role="img"
				aria-label="Anchor quality as a function of median residual"
			>
				<rect
					x={46}
					y={qy(0.15)}
					width={QW - 62}
					height={qy(0) - qy(0.15)}
					fill={ROSE}
					fillOpacity={0.1}
				/>
				<rect
					x={46}
					y={qy(0.35)}
					width={QW - 62}
					height={qy(0.15) - qy(0.35)}
					fill={AMBER}
					fillOpacity={0.1}
				/>
				<rect
					x={46}
					y={qy(1)}
					width={QW - 62}
					height={qy(0.35) - qy(1)}
					fill="var(--accent)"
					fillOpacity={0.07}
				/>
				{[0.15, 0.35].map((v) => (
					<g key={v}>
						<line
							x1={46}
							x2={QW - 16}
							y1={qy(v)}
							y2={qy(v)}
							stroke="white"
							strokeOpacity={0.3}
							strokeDasharray="3 4"
						/>
						<text
							x={40}
							y={qy(v) + 4}
							textAnchor="end"
							fontSize={12}
							fill="white"
							fillOpacity={0.6}
						>
							{v}
						</text>
					</g>
				))}
				<text
					x={QW - 22}
					y={qy(0.07)}
					textAnchor="end"
					fontSize={12}
					fill={ROSE}
					fillOpacity={0.9}
				>
					hidden
				</text>
				<text
					x={QW - 22}
					y={qy(0.25) + 4}
					textAnchor="end"
					fontSize={12}
					fill={AMBER}
				>
					labelled low trust, faded
				</text>
				<text
					x={QW - 22}
					y={qy(0.6)}
					textAnchor="end"
					fontSize={12}
					fill="var(--accent)"
				>
					shown
				</text>
				{[0, 0.1, 0.2, 0.3, 0.4, 0.5].map((e) => (
					<text
						key={e}
						x={qx(e)}
						y={244}
						textAnchor="middle"
						fontSize={12}
						fill="white"
						fillOpacity={0.5}
					>
						{e.toFixed(1)}
					</text>
				))}
				<text
					x={(46 + QW - 16) / 2}
					y={264}
					textAnchor="middle"
					fontSize={12.5}
					fill="white"
					fillOpacity={0.6}
				>
					median |log residual| over all candidates
				</text>
				{[
					[0.13, "curve 0.13"],
					[0.34, "one scale 0.34"],
				].map(([e, l]) => (
					<g key={String(l)}>
						<line
							x1={qx(e as number)}
							x2={qx(e as number)}
							y1={qy(1)}
							y2={qy(0)}
							stroke="var(--rigi-paper)"
							strokeOpacity={0.2}
							strokeDasharray="2 4"
						/>
						<text
							x={qx(e as number) + 4}
							y={qy(1) + 12}
							fontSize={11}
							fill="var(--rigi-paper)"
							fillOpacity={0.55}
						>
							{l as string}
						</text>
					</g>
				))}
				<path
					d={pts}
					fill="none"
					stroke="var(--rigi-paper)"
					strokeWidth={2.2}
				/>
				<circle
					cx={qx(err)}
					cy={qy(cur)}
					r={8}
					fill={stateColor}
					stroke="var(--rigi-ink)"
					strokeWidth={2}
				/>
			</svg>
			<div className="mt-3 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
				<label className="block font-mono text-[11px] text-white/55">
					residual err {err.toFixed(2)}
					<input
						type="range"
						min={0}
						max={0.5}
						step={0.005}
						value={err}
						onChange={(e) => setErr(Number(e.target.value))}
						className="mt-1 block w-full"
						style={{ accentColor: "var(--accent)" }}
					/>
				</label>
				<label className="block font-mono text-[11px] text-white/55">
					inlier fraction {inl.toFixed(2)}
					<input
						type="range"
						min={0.1}
						max={1}
						step={0.01}
						value={inl}
						onChange={(e) => setInl(Number(e.target.value))}
						className="mt-1 block w-full"
						style={{ accentColor: "var(--accent)" }}
					/>
				</label>
				<div className="text-right">
					<div className="display-title text-3xl" style={{ color: stateColor }}>
						{cur.toFixed(2)}
					</div>
					<div className="font-mono text-[11px]" style={{ color: stateColor }}>
						{state}
					</div>
				</div>
			</div>
		</Figure>
	);
}

// ---------- real: the DEM as a ruler on a demo photo ----------
const BANDS = [
	{ lo: 0, hi: 15, color: "#e07a7a", label: "under 15 m (excluded)" },
	{ lo: 15, hi: 150, color: "#8fc08a", label: "15 to 150 m" },
	{ lo: 150, hi: 600, color: "#e0c565", label: "150 to 600 m" },
	{ lo: 600, hi: 3000, color: "#e09a65", label: "600 m to 3 km" },
	{
		lo: 3000,
		hi: Number.POSITIVE_INFINITY,
		color: "#8a93a3",
		label: "beyond 3 km (excluded)",
	},
];
const inWindow = (v: number) => v >= 15 && v <= 3000;

/** The real DEM ray length per cell of demo-01, drawn over the photo. */
function RangeCells({
	d,
	mode,
}: {
	d: TerrainData | null;
	mode: "bands" | "window";
}) {
	const r = d?.range;
	if (!r) return null;
	return (
		<g>
			{r.grid.flatMap((row, j) =>
				row.map((v, i) => {
					if (v == null) return null;
					const b = BANDS.find((q) => v >= q.lo && v < q.hi) ?? BANDS[4];
					const on = inWindow(v);
					return (
						<rect
							// biome-ignore lint/suspicious/noArrayIndexKey: grid cell
							key={`${i}-${j}`}
							x={i * r.cell}
							y={j * r.cell}
							width={r.cell}
							height={r.cell}
							fill={mode === "bands" ? b.color : on ? "var(--accent)" : "#000"}
							fillOpacity={mode === "bands" ? 0.5 : on ? 0.5 : 0.5}
						/>
					);
				}),
			)}
		</g>
	);
}

function rangeShare(d: TerrainData | null) {
	const r = d?.range;
	if (!r) return null;
	const flat = r.grid.flat().filter((v): v is number => v != null);
	const n = flat.filter(inWindow).length;
	return { n, total: flat.length, pct: Math.round((100 * n) / flat.length) };
}

/** Hero: the DEM as a ruler, on one real photo. */
function HeroStages({ d }: { d: TerrainData | null }) {
	const photo = useAtlasPhoto("demo-01");
	const s = rangeShare(d);
	return (
		<Figure
			label="Fig. 1"
			caption={
				<>
					{s
						? `On demo-01, ${s.pct}% of ${s.total} ground cells lie 15 m to 3 km away, the range the fit uses.`
						: "The map gives a distance for every ground pixel."}{" "}
					<PhotoMeasured data={photo}>
						Ranges: {d?.script ?? "scripts/atlas/data-terrain.ts"}.
					</PhotoMeasured>
				</>
			}
		>
			<Stages
				stages={[
					{
						label: "Photo",
						caption:
							"One photo. A depth model can guess its shape, but not its metres.",
						render: () => <RealPhoto data={photo} layers={[]} />,
					},
					{
						label: "The ruler",
						caption:
							"Once the camera is solved, the map says how far the ground is at every pixel.",
						render: () => (
							<RealPhoto data={photo} layers={[]}>
								{() => <RangeCells d={d} mode="bands" />}
							</RealPhoto>
						),
					},
					{
						label: "Pixels that vote",
						caption:
							"Only ground between 15 m and 3 km is used. Sky and far haze stay out.",
						render: () => (
							<RealPhoto data={photo} layers={[]}>
								{() => <RangeCells d={d} mode="window" />}
							</RealPhoto>
						),
					},
				]}
			/>
			<div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10.5px] text-white/55">
				{BANDS.map((b) => (
					<span key={b.label} className="inline-flex items-center gap-1.5">
						<span
							className="size-2.5 rounded-sm"
							style={{ background: b.color }}
						/>
						{b.label}
					</span>
				))}
			</div>
		</Figure>
	);
}

function MiniCurves({ d }: { d: TerrainData | null }) {
	const sp = d?.spike;
	const A = Math.log(12);
	const B = Math.log(450);
	const T = Math.log(4000);
	const X = (v: number) => 6 + ((v - A) / (B - A)) * 188;
	const Y = (v: number) => 124 - ((v - A) / (T - A)) * 116;
	return (
		<svg
			viewBox="0 0 200 130"
			className="block h-auto w-full rounded-lg bg-black/20"
			role="img"
			aria-label="Range curves fitted on real photos bend away from the diagonal"
		>
			<line
				x1={X(A)}
				y1={Y(A)}
				x2={X(B)}
				y2={Y(B)}
				stroke="white"
				strokeOpacity={0.35}
				strokeDasharray="3 3"
			/>
			{sp?.fits.map((f) => {
				const pts = Array.from({ length: 30 }, (_, i) => {
					const x = A + ((B - A) * i) / 29;
					return [
						x,
						Math.log(curveRange({ x: f.x, y: f.y }, Math.exp(x))),
					] as const;
				}).filter(([, y]) => y >= A && y <= T);
				return (
					<path
						key={f.id}
						d={pts
							.map(
								([x, y], i) =>
									`${i ? "L" : "M"}${X(x).toFixed(1)} ${Y(y).toFixed(1)}`,
							)
							.join("")}
						fill="none"
						stroke="var(--accent)"
						strokeOpacity={0.45}
						strokeWidth={1}
					/>
				);
			})}
		</svg>
	);
}

function MiniQuality({ d }: { d: TerrainData | null }) {
	const fits = d?.spike.fits ?? [];
	const sorted = [...fits].sort((a, b) => a.quality - b.quality);
	const X = (q: number) => 8 + q * 184;
	return (
		<svg
			viewBox="0 0 200 130"
			className="block h-auto w-full rounded-lg bg-black/20"
			role="img"
			aria-label="Each real photo's anchor quality against the hide and low-trust lines"
		>
			<rect
				x={X(0)}
				y={20}
				width={X(0.15) - X(0)}
				height={80}
				fill={ROSE}
				fillOpacity={0.15}
			/>
			<rect
				x={X(0.15)}
				y={20}
				width={X(0.35) - X(0.15)}
				height={80}
				fill={AMBER}
				fillOpacity={0.15}
			/>
			{sorted.map((f, i) => (
				<circle
					key={f.id}
					cx={X(f.quality)}
					cy={92 - (i % 5) * 14}
					r={3.6}
					fill={
						f.quality < 0.15 ? ROSE : f.quality < 0.35 ? AMBER : "var(--accent)"
					}
				/>
			))}
			<text
				x={X(0.075)}
				y={14}
				textAnchor="middle"
				fontSize="8"
				fill={ROSE}
				className="font-mono"
			>
				hide
			</text>
			<text
				x={X(0.6)}
				y={14}
				textAnchor="middle"
				fontSize="8"
				fill="var(--accent)"
				className="font-mono"
			>
				show
			</text>
		</svg>
	);
}

function MiniWindow({ d }: { d: TerrainData | null }) {
	const photo = useAtlasPhoto("demo-01");
	return (
		<RealPhoto data={photo} layers={[]}>
			{() => <RangeCells d={d} mode="window" />}
		</RealPhoto>
	);
}

function RealCurves({ d }: { d: TerrainData | null }) {
	const sp = d?.spike;
	if (!sp)
		return (
			<Figure label="Fig. 2" bleed caption="Loading the measured curves">
				<div className="aspect-[2/1] animate-pulse rounded-xl bg-white/[0.04]" />
			</Figure>
		);
	const at = (m: number) =>
		sp.fits
			.map((f) => curveRange({ x: f.x, y: f.y }, m) / m)
			.sort((a, b) => a - b);
	const med = (a: number[]) => a[a.length >> 1];
	const rows = [20, 100, 300].map((m) => ({ m, r: med(at(m)) }));
	const XL0 = Math.log(12);
	const XL1 = Math.log(450);
	return (
		<Figure
			label="Fig. 2"
			bleed
			caption={
				<>
					Real photos agree the model compresses distance, by a different amount
					each time.{" "}
					<PhotoMeasured data={d}>
						{sp.nFitted} wild spike photos (not the demo set); dashed line = DEM
						equals model.
					</PhotoMeasured>
				</>
			}
		>
			<div className="grid items-start gap-6 md:grid-cols-[1.2fr_1fr]">
				<Plot
					x={[XL0, XL1]}
					y={[XL0, Math.log(4000)]}
					width={460}
					height={320}
					xLabel="model ray length (m)"
					yLabel="DEM range (m)"
					fmtX={(v) => `${Math.round(Math.exp(v))}`}
					fmtY={(v) => `${Math.round(Math.exp(v))}`}
				>
					{(s) => (
						<>
							<path
								d={s.line([
									[XL0, XL0],
									[XL1, XL1],
								])}
								fill="none"
								stroke="white"
								strokeOpacity={0.35}
								strokeDasharray="4 4"
							/>
							{sp.fits.map((f) => (
								<path
									key={f.id}
									d={s.line(
										Array.from({ length: 60 }, (_, i) => {
											const x = XL0 + ((XL1 - XL0) * i) / 59;
											return [
												x,
												Math.log(curveRange({ x: f.x, y: f.y }, Math.exp(x))),
											] as [number, number];
										}).filter(([, y]) => y >= XL0 && y <= Math.log(4000)),
									)}
									fill="none"
									stroke="var(--accent)"
									strokeOpacity={0.4}
									strokeWidth={1.2}
								/>
							))}
						</>
					)}
				</Plot>
				<div className="font-mono text-[11.5px] text-white/60">
					<p className="mb-2">
						Median DEM / model ratio of the {sp.nFitted} curves:
					</p>
					<div className="grid grid-cols-3 gap-2 text-center">
						{rows.map((q) => (
							<div key={q.m} className="rounded-lg p-2 ring-1 ring-white/10">
								<div className="text-[16px] text-[var(--rigi-paper)]">
									{q.r.toFixed(1)}
								</div>
								at {q.m} m
							</div>
						))}
					</div>
					<p className="mt-3 text-[11px] leading-relaxed text-white/50">
						At 100 m, {at(100).filter((r) => r > 1).length} of {sp.fits.length}{" "}
						curves sit above the dashed line.
					</p>
				</div>
			</div>
		</Figure>
	);
}

// ---------- real: where the shipped quality formula put those photos ----------
function RealQuality({ d }: { d: TerrainData | null }) {
	const sp = d?.spike;
	if (!sp) return null;
	const sorted = [...sp.fits].sort((a, b) => a.quality - b.quality);
	const hidden = sorted.filter((f) => f.quality < 0.15).length;
	const low = sorted.filter(
		(f) => f.quality >= 0.15 && f.quality < 0.35,
	).length;
	const ok = sorted.length - hidden - low;
	const W = 560;
	const H = 150;
	const bx = (q: number) => 30 + q * (W - 50);
	return (
		<Figure
			label="Fig. 4"
			caption={
				<>
					{sp.fits.length - hidden} of {sp.nFitted} fitted photos clear the 0.15
					hide line.{" "}
					<PhotoMeasured data={d}>
						{sp.nFitted} spike photos; {sp.nPhotos - sp.nFitted} more had too
						few ground pixels to fit.
					</PhotoMeasured>
				</>
			}
		>
			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="h-auto w-full"
				role="img"
				aria-label="Quality of each real photo against the hide and low-trust thresholds"
			>
				<rect
					x={bx(0)}
					y={20}
					width={bx(0.15) - bx(0)}
					height={70}
					fill={ROSE}
					fillOpacity={0.12}
				/>
				<rect
					x={bx(0.15)}
					y={20}
					width={bx(0.35) - bx(0.15)}
					height={70}
					fill={AMBER}
					fillOpacity={0.12}
				/>
				{sorted.map((f, i) => (
					<circle
						key={f.id}
						cx={bx(f.quality)}
						cy={70 - (i % 4) * 12}
						r={4.5}
						fill={
							f.quality < 0.15
								? ROSE
								: f.quality < 0.35
									? AMBER
									: "var(--accent)"
						}
						fillOpacity={0.85}
					/>
				))}
				{[0, 0.15, 0.35, 0.5, 1].map((v) => (
					<g key={v}>
						<line
							x1={bx(v)}
							x2={bx(v)}
							y1={20}
							y2={92}
							stroke="white"
							strokeOpacity={0.12}
						/>
						<text
							x={bx(v)}
							y={108}
							textAnchor="middle"
							fontSize="10"
							fill="rgba(236,230,218,.55)"
							className="font-mono"
						>
							{v}
						</text>
					</g>
				))}
				<text
					x={bx(0.075)}
					y={14}
					textAnchor="middle"
					fontSize="9.5"
					fill={ROSE}
					className="font-mono"
				>
					hidden
				</text>
				<text
					x={bx(0.25)}
					y={14}
					textAnchor="middle"
					fontSize="9.5"
					fill={AMBER}
					className="font-mono"
				>
					low trust
				</text>
				<text
					x={bx(0.68)}
					y={14}
					textAnchor="middle"
					fontSize="9.5"
					fill="var(--accent)"
					className="font-mono"
				>
					shown
				</text>
				<text
					x={W / 2}
					y={130}
					textAnchor="middle"
					fontSize="10"
					fill="rgba(236,230,218,.55)"
					className="font-mono"
				>
					anchor quality
				</text>
			</svg>
			<p className="mt-2 font-mono text-[11px] text-white/55">
				{ok} shown, {low} low trust, {hidden} hidden of {sp.nFitted} fitted
				photos (plus {sp.nPhotos - sp.nFitted} with no fit).
			</p>
		</Figure>
	);
}

export default function Page({ node }: { node: AtlasNode }) {
	void node;
	const d = useTerrainData();
	const sp = d?.spike;
	const shown = sp ? sp.fits.filter((f) => f.quality >= 0.15).length : null;
	return (
		<>
			<HeroStages d={d} />

			<Beat
				kicker="The idea"
				title="The map is a ruler the depth model never had."
			>
				<p>
					A depth model sees shape, not metres. Near the camera it is roughly
					right. Far away it is not.
				</p>
				<p>
					Once the camera is solved, the map knows the true distance to the
					ground. We bend the model's depth onto that ruler.
				</p>
			</Beat>

			<RealCurves d={d} />

			<Beat
				kicker="How it works"
				title="Pair up, fit a bendy curve, score the match."
			>
				<Trio
					steps={[
						{
							title: "Pair up",
							body: "Each ground pixel gives a pair: model depth and map distance.",
							visual: <MiniWindow d={d} />,
						},
						{
							title: "Fit a curve",
							body: "A curve, not one scale, turns model depth into metres.",
							visual: <MiniCurves d={d} />,
						},
						{
							title: "Score the match",
							body: "How well the curve fits becomes a trust score.",
							visual: <MiniQuality d={d} />,
						},
					]}
				/>
			</Beat>

			<Beat
				kicker="Why a curve"
				title="One scale fixes the mountains and breaks the foreground."
			>
				<p>
					Switch between one scale and the fitted curve to see the difference.
				</p>
			</Beat>

			<CurveFigure />

			<Beat
				kicker="Where it fails"
				title="A poor match hides the scene instead of guessing."
			>
				<p>
					When model and map disagree, the near-field scene is hidden or
					labelled low trust. The score checks the depth fit. It cannot tell a
					right camera from a wrong one.
				</p>
			</Beat>

			<RealQuality d={d} />

			<Numbers
				items={[
					{
						value: sp ? `${sp.medianResidCurve}` : "…",
						label: `median depth error on terrain with the curve; one scale gives ${sp?.medianResidScale ?? 0.34} (${sp?.nResid ?? 23} photos)`,
					},
					{
						value: sp && shown != null ? `${shown} / ${sp.nFitted}` : "…",
						label: "fitted photos shown, not hidden",
					},
					{
						value: sp ? `${sp.nPhotos - sp.nFitted} / ${sp.nPhotos}` : "…",
						label: "photos with too little ground to fit",
					},
					{
						value: "0.73",
						label: "AUC as a pose check: too weak to use as one",
					},
				]}
				source={
					<>
						Spike photos (wild, not the demo set):
						tools/nearfield/spike/place.json via{" "}
						{d?.script ?? "scripts/atlas/data-terrain.ts"}. AUC:
						reports/step-inside-results.md.
					</>
				}
			/>

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next: {link("step-inside", "Step Inside")} uses these metres to place
				people and objects. {link("terrain-snapping", "Terrain snapping")}{" "}
				covers the other things pinned to the map.
			</p>

			<Details>
				<h3>Why the model needs a curve</h3>
				<p>
					The model compresses range, and by a different amount per photo. On
					the P0 spike the DEM/model ratio was about 1 at 15 to 30 m, about 2.9
					at 100 to 300 m and about 6.6 at 300 to 1000 m
					(reports/step-inside-results.md). Pick one scale to fix the mountains
					and a person next to the camera drifts behind the ground at their
					feet. Once the camera is solved (
					{link("viewport-inference", "viewport inference")}), the DEM gives the
					ray length to the ground at every terrain pixel.
				</p>
				<h3>The fit, step by step</h3>
				<Steps
					steps={[
						{
							title: "Collect (model, DEM) pairs",
							body: "On a stride giving at most about 40k candidates, each pixel needs a finite model depth, no sky and no person (masks), and a DEM range between 15 and 3000 m. Below 15 m the DEM range is dominated by eye height and resolution at grazing angles; beyond 3 km the model carries no depth signal. Fewer than 200 candidates means no fit and quality 0.",
						},
						{
							title: "Put both on the same axis",
							body: "MoGe-class models predict z-depth; the DEM sampler returns ray length. The model value is multiplied by rayFactor(K, u, v) using the photo's own pose intrinsics, so both sides measure along the pixel's ray.",
						},
						{
							title: "Weigh every octave of range equally",
							body: "A landscape is mostly far pixels. Each octave of DEM range gets the same total weight, so the few near-terrain pixels pull as hard as the thousands of distant ones.",
						},
						{
							title: "Drop knots at weighted quantiles",
							body: "Up to six knots from the 2nd to the 98th percentile of log model ray, at least 0.2 log units apart. The curve is linear in log-log between them.",
						},
						{
							title: "Find the globally best knot heights",
							body: "Dynamic programming over a 0.02 grid of log metres minimises the truncated L1 loss Σ w · min(|log D − log f(m)|, ln 1.25), with every segment slope between 0.75 and 6. Monotone and never flat: an object standing in front of far terrain is a one-sided outlier. A slope-1 prior breaks ties, and a final shift by the weighted inlier median gives sub-grid precision.",
						},
						{
							title: "Apply it to the scene",
							body: "curveRange interpolates log metres between knots, keeps a constant ratio beyond the far knot, and eases back to a ratio of 1 at 15 m below the near knot, so a person 2 m from the lens is never pushed to 20 m.",
						},
					]}
				/>
				<CandidateFigure />
				<h3>From residual to trust</h3>
				<p>
					Quality is the inlier fraction times a Gaussian falloff of the median
					absolute log residual over all candidates, not just the inliers: with
					a ±25 % band the inlier median is always near 0.07. Step Inside reads
					it to decide whether to show the near-field scene. The thresholds
					(hide below 0.15, label below 0.35) were calibrated on the P0 spike.
					Deciding whether the pose is right is the job of the{" "}
					{link("accept-rule", "accept rule")}.
				</p>
				<GaugeFigure />
				<h3>In the code</h3>
				<div className="not-prose grid gap-3 sm:grid-cols-2">
					{[
						[
							"fitAnchor(depth, demRangeAt, K, opts)",
							"src/lib/nearfield/anchor.ts",
							"Collects candidates, fits, scores. Returns an AnchorFit with the curve and quality.",
						],
						[
							"fitCurve(mr, dr, opts)",
							"src/lib/nearfield/anchor.ts",
							"Weighted-quantile knots and the dynamic programme under CURVE_DEFAULTS.",
						],
						[
							"curveRange(curve, m)",
							"src/lib/nearfield/anchor.ts",
							"Evaluates the curve, with slope-1 extension and the near-field blend (CURVE_METRIC_NEAR = 15).",
						],
						[
							"anchorQuality(fit)",
							"src/lib/nearfield/anchor.ts",
							"inlierFrac · exp(−(err/0.2)²). ANCHOR_LOW_TRUST 0.35, ANCHOR_MIN_QUALITY 0.15 in types.ts.",
						],
						[
							"rayFactor / modelDepth / sampleDemGrid",
							"src/lib/nearfield/geom.ts",
							"z-depth to ray length, depth-grid access, DEM range lookups on the grid.",
						],
						[
							"Renderer.sampleAt(u, v).range",
							"src/lib/nearfield/near-dem.ts",
							"The DEM side of every pair: terrain ray length in metres, one source for both renderers.",
						],
					].map(([name, path, text]) => (
						<div
							key={name}
							className="rounded-xl bg-white/[0.03] p-4 ring-1 ring-white/10"
						>
							<div className="font-mono text-[12.5px] text-[var(--accent)]">
								{name}
							</div>
							<p className="mt-1 text-[13.5px] leading-relaxed text-white/65">
								{text}
							</p>
							<div className="mt-2">
								<CodeRef path={path} />
							</div>
						</div>
					))}
				</div>
				<p>
					Its DEM side is the {link("terrain-sampler", "terrain sampler")}.
					Background: <CodeRef path="reports/step-inside-design.md" /> and{" "}
					<CodeRef path="reports/step-inside-results.md" />.
				</p>
			</Details>
		</>
	);
}
