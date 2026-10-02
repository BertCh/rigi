// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
	Hachure,
	HandDot,
	HandText,
	type InkColor,
	inkColor,
	PenArrow,
	PenCircle,
	PenLine,
	SketchPath,
	SketchRect,
} from "#/components/gipfelbuch/notebook/Ink";
import {
	CircledNumber,
	HandMark,
	Wash,
} from "#/components/gipfelbuch/notebook/marks";
import { hachureFill } from "#/components/gipfelbuch/notebook/sketchify";
import { SWISS } from "#/components/gipfelbuch/swiss/palette";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import {
	CodeRef,
	Eq,
	Figure,
	HandLabel,
	HandRange,
	LiveStepInside,
	MarginNote,
	Op,
	Plot,
	RealPhoto,
	Steps,
	Sym,
	useGipfelbuchPhoto,
	useReducedMotion,
	useTime,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Details,
	Numbers,
	Stages,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { byId, gipfelbuchHref } from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";
import { curveRange } from "#/lib/nearfield/anchor";

// DEM anchoring: how a monocular depth map is turned into metres by fitting a range curve to the terrain.
// Mechanism constants are the real ones in src/lib/nearfield/anchor.ts:
//   candidate DEM range 15..3000 m, band ln 1.25, curve knots <= 6 at weighted quantiles 2..98 %, min spacing 0.2,
//   slopes in [0.75, 6], y grid step 0.02, octave weights, slope-1 beyond the far knot, near blend to 1 at 15 m,
//   quality = inlierFrac * exp(-(err/0.2)^2), hide < 0.15, low-trust label < 0.35, nMin 200.
// Report numbers (reports/step-inside-results.md): DEM/model ratio ~1 at 20 m, 2.9 at 100-300 m, 6.6 at 300-1000 m;
// terrain residual 0.34 (one scale) -> 0.13 (curve). The scatter below is a deterministic SCHEMATIC generated from
// those ratios, then fitted here with a port of fitCurve (direct pairwise costs instead of histograms).

// Measured data: scripts/gipfelbuch/data-terrain.ts → /demo/gipfelbuch/terrain/terrain.json
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
		terrainCache ??= fetch("/demo/gipfelbuch/terrain/terrain.json").then(
			(r) => {
				if (!r.ok) throw new Error(`terrain.json ${r.status}`);
				return r.json();
			},
		);
		terrainCache.then(
			(v) => live && setD(v),
			(e) => {
				terrainCache = null;
				console.warn("[gipfelbuch]", e);
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
const AMBER = "var(--nb-brown)";
const ROSE = "var(--nb-red)";
const rectPath = (x: number, y: number, w: number, h: number) =>
	`M${x} ${y}H${x + w}V${y + h}H${x}Z`;

function link(id: string, label: string) {
	if (!byId.has(id)) return <>{label}</>;
	return (
		<Link
			to={gipfelbuchHref(id)}
			className="underline decoration-[var(--gb-pencil)]"
		>
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
// Label sizes for the 560-wide figures (CurveFigure, GaugeFigure, RealQuality): 12 and 13 px rendered on
// the wide figure track (~960 px, 1.7x).
const LABEL_SMALL = 7;
const LABEL = 7.5;

const FW = 560;
const FH = 410;
const PADL = 68;
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

type CurveMode = "auto" | "scale" | "curve";

function Chip({
	mode,
	setMode,
	m,
	label,
}: {
	mode: CurveMode;
	setMode: (m: CurveMode) => void;
	m: CurveMode;
	label: string;
}) {
	return (
		<button
			type="button"
			onClick={() => setMode(m)}
			aria-pressed={mode === m}
			className={`px-2.5 py-1 font-mono ${TYPE.micro} transition ${
				mode === m
					? "bg-[var(--gb-paper-deep)] text-[var(--gb-ink)] underline decoration-[var(--nb-red)] decoration-wavy decoration-1 underline-offset-4"
					: "gb-secondary hover:bg-[var(--gb-paper-deep)]"
			}`}
		>
			{label}
		</button>
	);
}

function CurveFigure() {
	const [ref, t] = useTime<HTMLDivElement>(10);
	const [mode, setMode] = useState<CurveMode>("auto");
	const fit = useMemo(() => fitCurve(), []);
	const s0 = useMemo(() => fitScale(), []);
	const scaleCurve: Curve = useMemo(
		() => ({ x: fit.x, y: fit.x.map((x) => x + s0) }),
		[fit, s0],
	);
	const scaleStats = useMemo(() => stats(scaleCurve), [scaleCurve]);
	const fitStats = useMemo(() => stats(fit), [fit]);

	const tt = Math.min(t, 12); // plays once, rests on the fitted curve
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
	const clipId = "da-clip";

	return (
		<Figure
			label="Fig. 3"
			source="Skizze"
			caption="Invented scene, real fit. Each dot is a ground pixel: model depth across, terrain distance up. One scale misses the bend; the curve follows it."
		>
			<div ref={ref}>
				<div className="mb-3 flex flex-wrap items-center gap-2">
					<Chip mode={mode} setMode={setMode} m="auto" label="play" />
					<Chip mode={mode} setMode={setMode} m="scale" label="one scale" />
					<Chip mode={mode} setMode={setMode} m="curve" label="depth curve" />
					<span className={`ml-auto font-mono ${TYPE.micro} gb-secondary`}>
						{mode === "auto"
							? p < 0.02
								? "1 · one scale"
								: p < 0.98
									? "2 · knots pull the line onto the terrain"
									: "3 · a smooth rising curve"
							: mode === "scale"
								? "terrain = s · model"
								: "terrain = f(model)"}
					</span>
				</div>
				<svg
					viewBox={`0 0 ${FW} ${FH}`}
					className="block h-auto w-full"
					role="img"
					aria-label="Log-log scatter of terrain distance against model depth with a fitted curve"
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
							<PenLine
								data
								seed={`da-gy-${v}`}
								from={[PADL, sy(Math.log(v))]}
								to={[FW - PADR, sy(Math.log(v))]}
								color="faint"
								width={0.5}
							/>
							<HandLabel
								x={PADL - 8}
								y={sy(Math.log(v)) + 4}
								anchor="end"
								size={LABEL}
								color="var(--nb-faint)"
							>
								{v >= 1000 ? `${v / 1000} km` : `${v} m`}
							</HandLabel>
						</g>
					))}
					{XT.map((v) => (
						<g key={`x${v}`}>
							<PenLine
								data
								seed={`da-gx-${v}`}
								from={[sx(Math.log(v)), PADT]}
								to={[sx(Math.log(v)), FH - PADB]}
								color="faint"
								width={0.5}
							/>
							<HandLabel
								x={sx(Math.log(v))}
								y={FH - PADB + 18}
								anchor="middle"
								size={LABEL}
								color="var(--nb-faint)"
							>
								{v} m
							</HandLabel>
						</g>
					))}
					<HandLabel
						x={(PADL + FW - PADR) / 2}
						y={FH - 20}
						anchor="middle"
						size={LABEL}
						color={SWISS.ink}
					>
						model depth (m)
					</HandLabel>
					<HandLabel
						x={9}
						y={(PADT + FH - PADB) / 2}
						anchor="middle"
						size={LABEL}
						color={SWISS.ink}
						rotate={-90}
					>
						terrain distance (m)
					</HandLabel>

					<g clipPath={`url(#${clipId})`}>
						{/* identity: what "metric depth taken at face value" would be */}
						<SketchPath
							d={path({ x: [Math.log(8)], y: [Math.log(8)] })}
							seed="da-identity"
							data
							color="pencil"
							width={1.1}
							dash="3 5"
							passes={1}
						/>
						{/* the +-25 % band: a light forest wash between two pencil edges */}
						<Wash
							d={`${path(cur, BAND)}L${path(cur, -BAND)
								.split(/(?=[ML])/)
								.map((c) => c.replace(/^[ML]/, ""))
								.reverse()
								.join("L")}Z`}
							color="forest"
							seed="da-band-wash"
							layers={5}
							opacity={0.06}
							spread={1.5}
							offset={[0, 0]}
						/>
						<SketchPath
							d={path(cur, BAND)}
							seed="da-band-up"
							data
							color="pencil"
							width={1}
							opacity={0.7}
							dash="1 5"
							passes={1}
						/>
						<SketchPath
							d={path(cur, -BAND)}
							seed="da-band-dn"
							data
							color="pencil"
							width={1}
							opacity={0.7}
							dash="1 5"
							passes={1}
						/>
						{PTS.map((pt, i) => {
							const e = Math.abs(pt.y - curveLog(cur, pt.x));
							const inl = e <= BAND;
							return (
								<HandDot
									data
									// biome-ignore lint/suspicious/noArrayIndexKey: static point set, never reordered
									key={i}
									x={sx(pt.x)}
									y={sy(pt.y)}
									r={2.6}
									seed={`da-pt-${i}`}
									color={inl ? "blue" : "pencil"}
									opacity={inl ? 1 : 0.5}
								/>
							);
						})}
						<SketchPath
							d={path(cur)}
							seed="da-curve"
							data
							color="red"
							width={2.2}
							passes={1}
						/>
					</g>
					{cur.x.map((x, i) => (
						<g key={`k${x}`} opacity={knotOn}>
							<PenLine
								data
								seed={`da-knot-drop-${i}`}
								from={[sx(x), sy(cur.y[i])]}
								to={[sx(x), FH - PADB]}
								color="pencil"
								width={1}
								dash="2 4"
							/>
							<HandDot
								data
								x={sx(x)}
								y={sy(cur.y[i])}
								r={4}
								seed={`da-knot-${i}`}
								color="ink"
								opacity={1}
							/>
							<PenCircle
								data
								seed={`da-knot-ring-${i}`}
								center={[sx(x), sy(cur.y[i])]}
								radiusX={7.5}
								color="ink"
								width={1.2}
							/>
						</g>
					))}
					<HandText x={PADL + 14} y={PADT + 24} size={13} color="red">
						{`median error: one scale ${scaleStats.err.toFixed(2)}, curve ${fitStats.err.toFixed(2)}`}
					</HandText>
					<PenArrow
						from={[PADL + 150, PADT + 30]}
						to={[sx(Math.log(300)) - 8, sy(curveLog(cur, Math.log(300))) - 8]}
						seed="da-note-curve"
						color="red"
						width={1.3}
					/>
					<HandText
						x={sx(Math.log(12))}
						y={FH - PADB - 16}
						size={13}
						color="pencil"
					>
						knots pin the bend (at most 6)
					</HandText>
					{(() => {
						// the label follows the identity diagonal, set just below it
						const a = Math.atan2(
							sy(Math.log(120)) - sy(Math.log(60)),
							sx(Math.log(120)) - sx(Math.log(60)),
						);
						const x = sx(Math.log(110)) - Math.sin(a) * 20;
						const y = sy(Math.log(110)) + Math.cos(a) * 20;
						return (
							<HandLabel
								x={x}
								y={y}
								anchor="middle"
								size={LABEL}
								color={SWISS.pencil}
								rotate={(a * 180) / Math.PI}
							>
								depth taken at face value
							</HandLabel>
						);
					})()}
				</svg>
				<div className="mt-3 grid grid-cols-3 gap-3 text-center">
					<div>
						<div className="font-light [font-variant-numeric:tabular-nums_lining-nums] text-2xl text-[var(--accent)]">
							{(st.inl * 100).toFixed(0)}%
						</div>
						<div className={`font-mono ${TYPE.micro} gb-secondary`}>
							within 25 % of the terrain
						</div>
					</div>
					<div>
						<div className="font-light [font-variant-numeric:tabular-nums_lining-nums] text-2xl text-[var(--accent)]">
							{st.err.toFixed(2)}
						</div>
						<div className={`font-mono ${TYPE.micro} gb-secondary`}>
							median error (log)
						</div>
					</div>
					<div>
						<div className="font-light [font-variant-numeric:tabular-nums_lining-nums] text-2xl text-[var(--accent)]">
							{cur.x.length}
						</div>
						<div className={`font-mono ${TYPE.micro} gb-secondary`}>knots</div>
					</div>
				</div>
				<p className={`mt-3 text-center font-mono ${TYPE.micro} gb-secondary`}>
					this scatter: one scale {scaleStats.err.toFixed(2)} → curve{" "}
					{fitStats.err.toFixed(2)} · 23 real photos: 0.34 → 0.13
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
// One hachure family per mask kind (a single angle); gap and ink tell them apart.
const CELL_INK: Record<Cell, { color: InkColor; gap: number; width: number }> =
	{
		sky: { color: "blue", gap: 6, width: 0.9 },
		person: { color: "brown", gap: 3.4, width: 1 },
		near: { color: "ink", gap: 4.4, width: 0.9 },
		far: { color: "pencil", gap: 5.2, width: 0.9 },
		kept: { color: "forest", gap: 3, width: 1.1 },
	};
/** Row-run rectangles of every cell kind, as one path per kind. */
const CELL_FILL: Record<Cell, string> = (() => {
	const out = {} as Record<Cell, string>;
	for (const kind of Object.keys(CELL_INK) as Cell[]) {
		let d = "";
		for (let j = 0; j < ROWS; j++) {
			let i = 0;
			while (i < COLS) {
				if (CELLS[i][j] !== kind) {
					i++;
					continue;
				}
				let i1 = i;
				while (i1 + 1 < COLS && CELLS[i1 + 1][j] === kind) i1++;
				d += `M${i * CW} ${j * CH}H${(i1 + 1) * CW}V${(j + 1) * CH}H${i * CW}Z`;
				i = i1 + 1;
			}
		}
		out[kind] = d;
	}
	return out;
})();
/** Hachure of every cell kind over the whole grid, built once; the sweep reveals it with a clip. */
const CELL_HATCH: Record<Cell, string> = (() => {
	const out = {} as Record<Cell, string>;
	for (const kind of Object.keys(CELL_INK) as Cell[]) {
		const rings: [number, number][][] = [];
		for (let j = 0; j < ROWS; j++) {
			let i = 0;
			while (i < COLS) {
				if (CELLS[i][j] !== kind) {
					i++;
					continue;
				}
				let i1 = i;
				while (i1 + 1 < COLS && CELLS[i1 + 1][j] === kind) i1++;
				const x0 = i * CW;
				const x1 = (i1 + 1) * CW;
				const y0 = j * CH;
				const y1 = (j + 1) * CH;
				rings.push([
					[x0, y0],
					[x1, y0],
					[x1, y1],
					[x0, y1],
				]);
				i = i1 + 1;
			}
		}
		out[kind] = hachureFill(rings, `da-cells-${kind}`, {
			angle: -45,
			gap: CELL_INK[kind].gap,
			inset: 0,
		});
	}
	return out;
})();
const CELL_LABEL: Record<Cell, string> = {
	sky: "sky",
	person: "people",
	near: "under 15 m",
	far: "over 3 km",
	kept: "used",
};

function CandidateFigure() {
	const [ref, t] = useTime<HTMLDivElement>(10);
	const reduce = useReducedMotion();
	const sweep = reduce ? 1 : Math.min(1, t / 5.5); // sweeps once
	const counts = { sky: 0, person: 0, near: 0, far: 0, kept: 0 } as Record<
		Cell,
		number
	>;
	for (let i = 0; i < COLS; i++)
		if ((i + 0.5) / COLS <= sweep)
			for (let j = 0; j < ROWS; j++) counts[CELLS[i][j]]++;

	// ray-length diagram
	const th = reduce
		? 0.5
		: 0.5 + 0.3 * Math.sin(t * 0.9) * Math.max(0, 1 - t / 10); // swings, then settles at 0.5
	const cx = 160;
	const cy = 205;
	const zl = 150;
	const px = cx + Math.tan(th) * zl;
	const py = cy - zl;
	const fac = 1 / Math.cos(th);

	return (
		<Figure
			label="D1"
			source="Skizze"
			caption="Left: which pixels become depth pairs. Sky, people, near ground at a grazing angle and far haze never reach the fit. Right: the model gives depth along the optical axis, the terrain gives distance along the ray, so each pixel's depth is first stretched to match."
		>
			<div ref={ref} className="grid gap-6 sm:grid-cols-2">
				<div>
					<svg
						viewBox="0 0 320 250"
						className="h-auto w-full"
						role="img"
						aria-label="A photo grid with sky, people, near and far pixels rejected"
					>
						<defs>
							<clipPath id="da-sweep-clip">
								<rect x={0} y={0} width={sweep * 320} height={190} />
							</clipPath>
						</defs>
						<g clipPath="url(#da-sweep-clip)">
							{(Object.keys(CELL_INK) as Cell[]).map((c) => (
								<Wash
									key={`fill-${c}`}
									d={CELL_FILL[c]}
									color={CELL_INK[c].color}
									seed={`da-cell-wash-${c}`}
									layers={5}
									opacity={c === "kept" ? 0.1 : 0.08}
									spread={1.2}
									offset={[0, 0]}
								/>
							))}
							{(Object.keys(CELL_INK) as Cell[]).map((c) => (
								<path
									key={c}
									d={CELL_HATCH[c]}
									fill="none"
									stroke={inkColor(CELL_INK[c].color)}
									strokeWidth={CELL_INK[c].width}
									strokeOpacity={c === "kept" ? 0.55 : 0.35}
									strokeLinecap="round"
								/>
							))}
						</g>
						<SketchRect
							x={0}
							y={0}
							width={320}
							height={190}
							seed="da-photo-frame"
							color="pencil"
						/>
						<HandText x={232} y={118} size={13} color="brown">
							a head is not ground
						</HandText>
						<PenArrow
							from={[250, 124]}
							to={[222, 146]}
							seed="da-note-person"
							color="brown"
							width={1.2}
						/>
						{sweep < 1 && (
							<PenLine
								data
								seed="da-sweep"
								from={[sweep * 320, 0]}
								to={[sweep * 320, 190]}
								color="ink"
								width={1.4}
							/>
						)}
						{(Object.keys(CELL_LABEL) as Cell[]).map((c, i) => (
							<g
								key={c}
								transform={`translate(${(i % 3) * 108 + 2} ${206 + Math.floor(i / 3) * 20})`}
							>
								<Wash
									d="M0 0H11V11H0Z"
									color={CELL_INK[c].color}
									seed={`da-key-wash-${c}`}
									layers={6}
									opacity={0.12}
									spread={1}
									offset={[0, 0]}
								/>
								<Hachure
									d="M0 0H11V11H0Z"
									seed={`da-key-hatch-${c}`}
									color={CELL_INK[c].color}
									gap={3.2}
									opacity={0.6}
								/>
								<HandLabel x={16} y={10} size={10} color={SWISS.ink}>
									{CELL_LABEL[c]} {counts[c]}
								</HandLabel>
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
						<PenLine
							data
							seed="da-axis"
							from={[cx, cy]}
							to={[cx, cy - zl - 25]}
							color="pencil"
							width={1}
							dash="2 4"
						/>
						<HandLabel
							x={cx + 6}
							y={cy - zl - 27}
							size={10}
							color={SWISS.secondary}
						>
							optical axis
						</HandLabel>
						{/* image plane */}
						<PenLine
							data
							seed="da-plane"
							from={[cx - 55, cy - 38]}
							to={[cx + 55, cy - 38]}
							color="ink"
							width={1.8}
						/>
						<HandLabel
							x={cx + 60}
							y={cy - 34}
							size={10}
							color={SWISS.secondary}
						>
							image
						</HandLabel>
						{/* depth leg + ray */}
						<PenLine
							data
							seed="da-zleg"
							from={[cx, cy]}
							to={[cx, py]}
							color="brown"
							width={2}
						/>
						<PenLine
							data
							seed="da-across"
							from={[cx, py]}
							to={[px, py]}
							color="pencil"
							width={1}
							dash="3 4"
						/>
						<PenLine
							data
							seed="da-ray"
							from={[cx, cy]}
							to={[px, py]}
							color="red"
							width={2.2}
						/>
						<HandDot
							data
							x={cx}
							y={cy}
							r={5}
							seed="da-eye"
							color="ink"
							opacity={1}
						/>
						<HandDot
							data
							x={px}
							y={py}
							r={5.5}
							seed="da-pixel"
							color="red"
							opacity={1}
						/>
						<HandLabel
							x={cx - 8}
							y={cy - zl / 2}
							anchor="end"
							size={10}
							color={SWISS.contour}
						>
							depth (model)
						</HandLabel>
						<HandLabel
							x={(cx + px) / 2 + (th > 0 ? 10 : -10)}
							y={cy - zl / 2 + 16}
							anchor={th > 0 ? "start" : "end"}
							size={10}
							color={SWISS.red}
						>
							ray (terrain)
						</HandLabel>
						<HandText x={cx + 74} y={cy - 18} size={13} color="red">
							{`${fac.toFixed(2)}× longer than z`}
						</HandText>
						<HandLabel
							x={160}
							y={236}
							anchor="middle"
							size={10}
							color={SWISS.ink}
						>
							|ray| = z · √(1 + x² + y²) = z × {fac.toFixed(2)}
						</HandLabel>
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
	const state = cur < 0.15 ? "hidden" : cur < 0.35 ? "low trust" : "shown";
	const stateColor =
		cur < 0.15 ? ROSE : cur < 0.35 ? AMBER : "var(--nb-forest)";
	const pts = Array.from({ length: 101 }, (_, i) => {
		const e = (i / 100) * 0.5;
		return `${i ? "L" : "M"}${qx(e).toFixed(1)} ${qy(q(e)).toFixed(1)}`;
	}).join("");
	return (
		<Figure
			label="D2"
			source="Skizze"
			caption="Quality = share of pixels that fit × exp(−(error/0.2)²). Drag the two inputs: the dot is the photo, the colour is what Step Inside does with it."
		>
			<svg
				viewBox={`0 0 ${QW} ${QH}`}
				className="block h-auto w-full"
				role="img"
				aria-label="Anchor quality as a function of median residual"
			>
				<Wash
					d={rectPath(46, qy(0.15), QW - 62, qy(0) - qy(0.15))}
					color="red"
					seed="da-wash-1"
					layers={9}
					opacity={0.08}
					spread={2}
				/>
				<Hachure
					d={rectPath(46, qy(0.15), QW - 62, qy(0) - qy(0.15))}
					seed="gauge-hidden"
					color="red"
					gap={5}
					opacity={0.6}
				/>
				<Wash
					d={rectPath(46, qy(0.35), QW - 62, qy(0.15) - qy(0.35))}
					color="brown"
					seed="da-wash-2"
					layers={9}
					opacity={0.08}
					spread={2}
				/>
				<Hachure
					d={rectPath(46, qy(0.35), QW - 62, qy(0.15) - qy(0.35))}
					seed="gauge-low"
					color="brown"
					gap={5}
					opacity={0.6}
				/>
				<Wash
					d={rectPath(46, qy(1), QW - 62, qy(0.35) - qy(1))}
					color="forest"
					seed="da-wash-3"
					layers={9}
					opacity={0.08}
					spread={2}
				/>
				<Hachure
					d={rectPath(46, qy(1), QW - 62, qy(0.35) - qy(1))}
					seed="gauge-shown"
					color="forest"
					gap={5}
					opacity={0.45}
				/>
				{[0.15, 0.35].map((v) => (
					<g key={v}>
						<PenLine
							data
							seed={`gauge-line-${v}`}
							from={[46, qy(v)]}
							to={[QW - 16, qy(v)]}
							color="ink"
							width={1}
							dash="3 4"
						/>
						<HandLabel
							x={40}
							y={qy(v) + 4}
							anchor="end"
							size={LABEL_SMALL}
							color="var(--nb-faint)"
						>
							{v}
						</HandLabel>
					</g>
				))}
				<HandLabel
					x={QW - 22}
					y={qy(0.07)}
					anchor="end"
					size={LABEL}
					color={SWISS.red}
				>
					hidden
				</HandLabel>
				<HandText x={60} y={qy(0.07) - 14} size={13} color="red">
					below 0.15: scene hidden
				</HandText>
				<HandText
					x={QW - 22}
					y={qy(0.25) + 4}
					anchor="end"
					size={10}
					color="brown"
				>
					labelled low trust, faded
				</HandText>
				<HandLabel
					x={QW - 22}
					y={qy(0.6)}
					anchor="end"
					size={LABEL}
					color={SWISS.forest}
				>
					shown
				</HandLabel>
				{[0, 0.1, 0.2, 0.3, 0.4, 0.5].map((e) => (
					<HandLabel
						key={e}
						x={qx(e)}
						y={244}
						anchor="middle"
						size={LABEL_SMALL}
						color="var(--nb-faint)"
					>
						{e.toFixed(1)}
					</HandLabel>
				))}
				<HandLabel
					x={(46 + QW - 16) / 2}
					y={264}
					anchor="middle"
					size={LABEL}
					color={SWISS.ink}
				>
					median error (log) over all pixels
				</HandLabel>
				{[
					[0.13, "curve 0.13"],
					[0.34, "one scale 0.34"],
				].map(([e, l]) => (
					<g key={String(l)}>
						<PenLine
							data
							seed={`gauge-mark-${l}`}
							from={[qx(e as number), qy(1)]}
							to={[qx(e as number), qy(0)]}
							color="pencil"
							width={1}
							dash="2 4"
						/>
						<HandLabel
							x={qx(e as number) + 4}
							y={qy(1) + 12}
							size={LABEL}
							color={SWISS.secondary}
						>
							{l as string}
						</HandLabel>
					</g>
				))}
				<SketchPath
					d={pts}
					seed="gauge-curve"
					data
					color="ink"
					width={1.8}
					passes={1}
				/>
				<HandDot
					data
					x={qx(err)}
					y={qy(cur)}
					r={7.5}
					seed="gauge-dot"
					color={stateColor}
					opacity={1}
				/>
				<PenCircle
					data
					seed="gauge-dot-ring"
					center={[qx(err), qy(cur)]}
					radiusX={10}
					color="ink"
					width={1.3}
				/>
			</svg>
			<div className="mt-3 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
				<div className={`block font-mono ${TYPE.micro} gb-secondary`}>
					error
					<HandRange
						value={err}
						min={0}
						max={0.5}
						step={0.005}
						label="Error"
						onChange={setErr}
						readout={err.toFixed(2)}
					/>
				</div>
				<div className={`block font-mono ${TYPE.micro} gb-secondary`}>
					share that fits
					<HandRange
						value={inl}
						min={0.1}
						max={1}
						step={0.01}
						label="Share that fits"
						onChange={setInl}
						readout={inl.toFixed(2)}
					/>
				</div>
				<div className="text-right">
					<div
						className="font-light [font-variant-numeric:tabular-nums_lining-nums] text-3xl"
						style={{ color: stateColor }}
					>
						{cur.toFixed(2)}
					</div>
					<div
						className={`font-mono ${TYPE.micro}`}
						style={{ color: stateColor }}
					>
						{state}
					</div>
				</div>
			</div>
		</Figure>
	);
}

// ---------- real: the DEM as a ruler on a demo photo ----------
const BANDS: { lo: number; hi: number; color: InkColor; label: string }[] = [
	{ lo: 0, hi: 15, color: "red", label: "under 15 m (excluded)" },
	{ lo: 15, hi: 150, color: "forest", label: "15 to 150 m" },
	{ lo: 150, hi: 600, color: "brown", label: "150 to 600 m" },
	{ lo: 600, hi: 3000, color: "navy", label: "600 m to 3 km" },
	{
		lo: 3000,
		hi: Number.POSITIVE_INFINITY,
		color: "pencil",
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
	// One path per class: cells of a class are merged into row runs.
	const layers = useMemo(() => {
		if (!r) return [];
		const keyOf = (v: number) =>
			mode === "bands"
				? BANDS.findIndex((q) => v >= q.lo && v < q.hi)
				: inWindow(v)
					? 1
					: 0;
		const rings = new Map<number, [number, number][][]>();
		r.grid.forEach((row, j) => {
			let i = 0;
			while (i < row.length) {
				const v = row[i];
				if (v == null) {
					i++;
					continue;
				}
				const key = keyOf(v);
				let i1 = i;
				while (i1 + 1 < row.length) {
					const w = row[i1 + 1];
					if (w == null || keyOf(w) !== key) break;
					i1++;
				}
				const x0 = i * r.cell;
				const x1 = (i1 + 1) * r.cell;
				const y0 = j * r.cell;
				const y1 = (j + 1) * r.cell;
				const list = rings.get(key) ?? [];
				list.push([
					[x0, y0],
					[x1, y0],
					[x1, y1],
					[x0, y1],
				]);
				rings.set(key, list);
				i = i1 + 1;
			}
		});
		const rectsD = (list: [number, number][][]) =>
			list
				.map(([a, b, c]) => `M${a[0]} ${a[1]}H${b[0]}V${c[1]}H${a[0]}Z`)
				.join("");
		return [...rings.entries()].map(([key, list]) => {
			const color: InkColor =
				mode === "bands"
					? BANDS[Math.max(0, key)].color
					: key
						? "forest"
						: "pencil";
			return {
				key,
				color,
				dim: mode === "window" && !key,
				fill: rectsD(list),
			};
		});
	}, [r, mode]);
	if (!r) return null;
	return (
		<g strokeLinecap="round" fill="none">
			{layers.map((l) => (
				<g key={l.key}>
					{/* a translucent solid tint per class (at most 28 %), no hatch over the photo */}
					<path
						d={l.fill}
						stroke="none"
						style={{
							fill: `color-mix(in srgb, ${inkColor(l.color)} ${l.dim ? 14 : 28}%, transparent)`,
						}}
					/>
				</g>
			))}
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
	const photo = useGipfelbuchPhoto("demo-01");
	const s = rangeShare(d);
	return (
		<Figure
			label="Fig. 1"
			bleed
			pinned="demo-01"
			caption={
				s
					? `${s.pct}% of ${s.total} ground cells lie 15 m to 3 km away, the range the fit uses.`
					: "The terrain gives a distance for every ground pixel."
			}
		>
			<Stages
				stages={[
					{
						label: "Photo",
						caption:
							"One photo. A depth model can guess its shape, but not its metres.",
						render: () => <RealPhoto data={photo} layers={[]} bleed />,
					},
					{
						label: "The ruler",
						caption:
							"Once the camera is solved, the map says how far the ground is at every pixel.",
						render: () => (
							<RealPhoto data={photo} layers={[]} bleed>
								{() => <RangeCells d={d} mode="bands" />}
							</RealPhoto>
						),
					},
					{
						label: "Pixels that vote",
						caption:
							"Only ground between 15 m and 3 km is used. Sky and far haze stay out.",
						render: () => (
							<RealPhoto data={photo} layers={[]} bleed>
								{() => <RangeCells d={d} mode="window" />}
							</RealPhoto>
						),
					},
				]}
			/>
			<div
				className={`mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono ${TYPE.micro} gb-secondary`}
			>
				{BANDS.map((b) => (
					<span key={b.label} className="inline-flex items-center gap-1.5">
						<span
							className="inline-block size-3"
							style={{
								background: `color-mix(in srgb, ${inkColor(b.color)} 70%, var(--gb-paper))`,
							}}
							aria-hidden="true"
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
			className="block h-auto w-full bg-[var(--gb-paper-deep)]"
			role="img"
			aria-label="Range curves fitted on real photos bend away from the diagonal"
		>
			<PenLine
				data
				seed="mini-diag"
				from={[X(A), Y(A)]}
				to={[X(B), Y(B)]}
				color="pencil"
				width={1.1}
				dash="3 3"
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
					<SketchPath
						key={f.id}
						d={pts
							.map(
								([x, y], i) =>
									`${i ? "L" : "M"}${X(x).toFixed(1)} ${Y(y).toFixed(1)}`,
							)
							.join("")}
						seed={`mini-fit-${f.id}`}
						data
						color="forest"
						opacity={0.6}
						width={1.2}
						passes={1}
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
			className="block h-auto w-full bg-[var(--gb-paper-deep)]"
			role="img"
			aria-label="Each real photo's anchor quality against the hide and low-trust lines"
		>
			<Wash
				d={rectPath(X(0), 20, X(0.15) - X(0), 80)}
				color="red"
				seed="da-wash-4"
				layers={9}
				opacity={0.08}
				spread={2}
			/>
			<Wash
				d={rectPath(X(0.15), 20, X(0.35) - X(0.15), 80)}
				color="brown"
				seed="da-wash-5"
				layers={9}
				opacity={0.08}
				spread={2}
			/>
			<Hachure
				d={rectPath(X(0), 20, X(0.15) - X(0), 80)}
				seed="miniq-hide"
				color="red"
				gap={4}
				opacity={0.6}
			/>
			<Hachure
				d={rectPath(X(0.15), 20, X(0.35) - X(0.15), 80)}
				seed="miniq-low"
				color="brown"
				gap={4}
				opacity={0.6}
			/>
			{sorted.map((f) => (
				<HandDot
					data
					key={f.id}
					x={X(f.quality)}
					y={92 - (sorted.indexOf(f) % 5) * 14}
					r={3.8}
					seed={`miniq-${f.id}`}
					color={
						f.quality < 0.15 ? "red" : f.quality < 0.35 ? "brown" : "forest"
					}
					opacity={1}
				/>
			))}
			<HandLabel
				x={X(0.075)}
				y={14}
				anchor="middle"
				size={13}
				color={SWISS.red}
			>
				hide
			</HandLabel>
			<HandLabel
				x={X(0.6)}
				y={14}
				anchor="middle"
				size={13}
				color={SWISS.forest}
			>
				show
			</HandLabel>
		</svg>
	);
}

function MiniWindow({ d }: { d: TerrainData | null }) {
	const photo = useGipfelbuchPhoto("demo-01");
	return (
		<RealPhoto data={photo} layers={[]}>
			{() => <RangeCells d={d} mode="window" />}
		</RealPhoto>
	);
}

/** The loss the dynamic programme minimises (anchor.ts fitCurve), tied to Fig. 2's axes. */
function AnchorEquation() {
	return (
		<Eq
			label="The fit picks the curve f that makes this smallest"
			where={[
				{
					sym: "m",
					text: "model depth of a ground pixel (x axis in Fig. 2)",
				},
				{ sym: "D", text: "terrain distance to that pixel (y axis in Fig. 2)" },
				{
					sym: "f",
					c: "var(--accent)",
					text: "the fitted curve (one line per photo in Fig. 2); one scale would force f(m) = s·m",
				},
				{ sym: "w", text: "weight: each octave of distance counts equally" },
			]}
		>
			<Sym>L</Sym> = <Op op="Σ" under={<Sym>i</Sym>} />
			<Sym>w</Sym>
			<sub>i</sub> min(|ln <Sym>D</Sym>
			<sub>i</sub> − ln <Sym c="var(--accent)">f</Sym>(<Sym>m</Sym>
			<sub>i</sub>)|, ln 1.25)
		</Eq>
	);
}

function RealCurves({ d }: { d: TerrainData | null }) {
	const sp = d?.spike;
	if (!sp)
		return (
			<Figure bleed caption="Loading the measured curves">
				<div className="aspect-[2/1] animate-pulse bg-[var(--gb-paper-deep)]" />
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
					each time. {sp.nFitted} other photos; dashed line: model equals
					terrain.
				</>
			}
		>
			<div className="grid items-start gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,540px)_minmax(0,1fr)]">
				<Plot
					x={[XL0, XL1]}
					y={[XL0, Math.log(4000)]}
					width={460}
					height={320}
					xLabel="model depth (m)"
					yLabel="terrain distance (m)"
					fmtX={(v) => `${Math.round(Math.exp(v))}`}
					fmtY={(v) => `${Math.round(Math.exp(v))}`}
				>
					{(s) => (
						<>
							<SketchPath
								d={s.line([
									[XL0, XL0],
									[XL1, XL1],
								])}
								seed="rc-identity"
								data
								color="pencil"
								width={1.2}
								dash="4 4"
								passes={1}
							/>
							{sp.fits.map((f) => (
								<SketchPath
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
									seed={`rc-${f.id}`}
									data
									color="forest"
									opacity={0.55}
									width={1.3}
									passes={1}
									tolerance={0.7}
								/>
							))}
							{/* the median curve of the fan, drawn on top */}
							<SketchPath
								d={s.line(
									Array.from({ length: 60 }, (_, i) => {
										const x = XL0 + ((XL1 - XL0) * i) / 59;
										const ys = sp.fits
											.map((f) =>
												Math.log(curveRange({ x: f.x, y: f.y }, Math.exp(x))),
											)
											.sort((a, b) => a - b);
										return [x, ys[ys.length >> 1]] as [number, number];
									}).filter(([, y]) => y >= XL0 && y <= Math.log(4000)),
								)}
								seed="rc-median"
								data
								color="red"
								width={2.2}
								passes={1}
							/>
						</>
					)}
				</Plot>
				<div className={`font-mono ${TYPE.micro} gb-secondary`}>
					<p className="mb-2">
						Median terrain / model ratio of the {sp.nFitted} curves (red line):
					</p>
					<div className="grid grid-cols-3 gap-2 text-center">
						{rows.map((q) => (
							<div key={q.m} className="bg-[var(--gb-paper-deep)] p-2">
								<div className="gb-num font-light text-[24px] leading-[30px] whitespace-nowrap text-[var(--gb-ink)]">
									{q.r.toFixed(1)}
								</div>
								at {q.m} m
							</div>
						))}
					</div>
					<p className={`mt-3 ${TYPE.micro} gb-secondary`}>
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
	const H = 176;
	const bx = (q: number) => 30 + q * (W - 50);
	return (
		<Figure
			label="Fig. 4"
			caption={
				<>
					{sp.fits.length - hidden} of {sp.nFitted} fitted photos clear the 0.15
					hide line. {sp.nPhotos - sp.nFitted} more had too little ground to
					fit.
				</>
			}
		>
			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="block h-auto w-full"
				role="img"
				aria-label="Quality of each real photo against the hide and low-trust thresholds"
			>
				{[
					[0, 0.15, "red"],
					[0.15, 0.35, "brown"],
					[0.35, 1, "forest"],
				].map(([a, b, c]) => (
					<Wash
						key={String(c)}
						d={rectPath(
							bx(a as number),
							20,
							bx(b as number) - bx(a as number),
							70,
						)}
						color={c as InkColor}
						seed={`da-rq-wash-${String(c)}`}
						layers={9}
						opacity={0.07}
						spread={2}
					/>
				))}
				<Hachure
					d={rectPath(bx(0), 20, bx(0.15) - bx(0), 70)}
					seed="rq-hidden"
					color="red"
					gap={5}
					opacity={0.3}
				/>
				<Hachure
					d={rectPath(bx(0.15), 20, bx(0.35) - bx(0.15), 70)}
					seed="rq-low"
					color="brown"
					gap={5}
					opacity={0.3}
				/>
				{sorted.map((f, i) => (
					<HandDot
						data
						key={f.id}
						x={bx(f.quality)}
						y={70 - (i % 4) * 12}
						r={4.8}
						seed={`rq-dot-${f.id}`}
						color={
							f.quality < 0.15 ? "red" : f.quality < 0.35 ? "brown" : "forest"
						}
						opacity={1}
					/>
				))}
				{[0, 0.15, 0.35, 0.5, 1].map((v) => (
					<g key={v}>
						<PenLine
							data
							seed={`rq-tick-${v}`}
							from={[bx(v), 20]}
							to={[bx(v), 92]}
							color="faint"
							width={0.5}
						/>
						<HandLabel
							x={bx(v)}
							y={108}
							anchor="middle"
							size={LABEL_SMALL}
							color="var(--nb-faint)"
						>
							{v}
						</HandLabel>
					</g>
				))}
				<HandLabel
					x={bx(0.075)}
					y={14}
					anchor="middle"
					size={LABEL}
					color={SWISS.red}
				>
					hidden
				</HandLabel>
				<HandLabel
					x={bx(0.25)}
					y={14}
					anchor="middle"
					size={LABEL}
					color={SWISS.contour}
				>
					low trust
				</HandLabel>
				<HandLabel
					x={bx(0.68)}
					y={14}
					anchor="middle"
					size={LABEL}
					color={SWISS.forest}
				>
					shown
				</HandLabel>
				<HandLabel
					x={W / 2}
					y={132}
					anchor="middle"
					size={LABEL}
					color={SWISS.ink}
				>
					anchor quality
				</HandLabel>
				<HandText x={W / 2} y={164} anchor="middle" size={13} color="pencil">
					{`${hidden} hidden, ${low} low trust: it scores the depth fit, not the camera`}
				</HandText>
			</svg>
			<p className={`mt-2 font-mono ${TYPE.micro} gb-secondary`}>
				{ok} shown, {low} low trust, {hidden} hidden of {sp.nFitted} fitted
				photos (plus {sp.nPhotos - sp.nFitted} with no fit).
			</p>
		</Figure>
	);
}

export default function Page({ node }: { node: GipfelbuchNode }) {
	void node;
	const d = useTerrainData();
	const sp = d?.spike;
	const shown = sp ? sp.fits.filter((f) => f.quality >= 0.15).length : null;
	return (
		<>
			<HeroStages d={d} />

			<Beat
				kicker="The idea"
				title="The terrain is a ruler the depth model never had."
			>
				<p>
					A depth model gets shape right and metres wrong. Near the camera it is
					roughly right.{" "}
					<HandMark type="underline">Far away it squeezes distance.</HandMark>
				</p>
				<p>
					<HandMark type="highlight">
						Once the camera is solved, the terrain model knows the true distance
						to the ground.
					</HandMark>{" "}
					We bend the model's depth onto that ruler.
					<MarginNote mark="a">
						The terrain/model ratio is about 1 at 15 to 30 m and about 2.9 at
						100 to 300 m.
					</MarginNote>
				</p>
			</Beat>

			<RealCurves d={d} />

			<AnchorEquation />

			<Beat
				kicker="How it works"
				title="Pair up, fit a bendy curve, score the match."
			>
				<Trio
					steps={[
						{
							title: "Pair up",
							body: "Each ground pixel gives a pair: model depth and terrain distance.",
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
					Play it: <CircledNumber value={1} /> one global scale,{" "}
					<CircledNumber value={2} /> knots pull the line onto the terrain,{" "}
					<CircledNumber value={3} /> a smooth rising curve.
				</p>
				<p>
					First guess: <HandMark type="strike">one scale per photo.</HandMark>{" "}
					<span className="nb-hand" style={{ color: "var(--nb-red)" }}>
						a curve: median error (log) 0.34 falls to 0.13
					</span>
					.
					<MarginNote mark="b">
						The model squeezes near range least, so the foreground breaks first.
					</MarginNote>
				</p>
			</Beat>

			<CurveFigure />

			<Beat
				kicker="Where it fails"
				title="A poor match hides the scene instead of guessing."
			>
				<p>
					When model and terrain disagree, the near-field scene is hidden or
					marked low trust. The score checks the depth fit.{" "}
					<HandMark type="wavy" color="red">
						It cannot tell a right camera from a wrong one.
					</HandMark>
					<MarginNote mark="c">
						As a test of the camera pose it is weak (AUC 0.73; 0.5 is chance, 1
						is perfect), so it only decides whether the scene is shown.
					</MarginNote>
				</p>
			</Beat>

			<RealQuality d={d} />

			<Beat
				kicker="What it buys"
				title="Where the fit holds, the photo can be stepped into."
			>
				<p>
					A good fit puts the lifted near-field on the terrain's own metres, so
					the camera can start at the photo's position and move.{" "}
					<HandMark type="underline">
						A poor fit keeps the scene hidden instead.
					</HandMark>
				</p>
			</Beat>

			<LiveStepInside number="5" />

			<Numbers
				items={[
					{
						value: sp ? `${sp.medianResidCurve}` : "…",
						label: `median depth error with the curve (log units, about 14%); one scale gives ${sp?.medianResidScale ?? 0.34} (${sp?.nResid ?? 23} photos)`,
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
						label: "AUC as a pose check (0.5 is chance)",
					},
				]}
				source="Measured on 27 photos outside the demo set."
			/>

			<Details>
				<h3>Why the model needs a curve</h3>
				<p>
					The model compresses range, and by a different amount per photo. On
					the test photos the terrain/model ratio was about 1 at 15 to 30 m,
					about 2.9 at 100 to 300 m and about 6.6 at 300 to 1000 m. Pick one
					scale to fix the mountains and a person next to the camera drifts
					behind the ground at their feet. Once the camera is solved (
					{link("viewport-inference", "viewport inference")}), the terrain model
					gives the distance to the ground at every terrain pixel.
				</p>
				<h3>The fit, step by step</h3>
				<Steps
					steps={[
						{
							title: "Collect depth pairs",
							body: "Up to about 40,000 pixels are sampled. Each needs a valid model depth, no sky, no person, and a terrain distance between 15 m and 3 km. Under 15 m the terrain distance is dominated by eye height and grazing angles; beyond 3 km the model carries no depth signal. Fewer than 200 pixels means no fit and quality 0.",
						},
						{
							title: "Put both on the same axis",
							body: "The depth model gives depth along the optical axis; the terrain gives distance along the pixel's ray. The model value is scaled by the photo's own camera geometry, so both sides measure along the same ray.",
						},
						{
							title: "Weigh every doubling of distance equally",
							body: "A landscape is mostly far pixels. Each doubling of distance gets the same total weight, so the few near pixels pull as hard as the thousands of distant ones.",
						},
						{
							title: "Drop knots at weighted quantiles",
							body: "Up to six knots, from the 2nd to the 98th percentile of model depth, at least 0.2 log units apart. Between knots the curve is a straight line on a log-log plot.",
						},
						{
							title: "Find the globally best knot heights",
							body: "The best knot heights are found exactly (dynamic programming) by minimising Σ w · min(|log D − log f(m)|, ln 1.25), with every segment slope between 0.75 and 6. The curve always rises: an object in front of far terrain only ever reads too near. A slope-1 preference breaks ties, and a final shift by the median error of the good points refines the result.",
						},
						{
							title: "Apply it to the scene",
							body: "Between knots the curve is interpolated in log metres; beyond the far knot the ratio stays constant; below the near knot it eases back to a ratio of 1 at 15 m, so a person 2 m from the lens is never pushed to 20 m.",
						},
					]}
				/>
				<CandidateFigure />
				<h3>From error to trust</h3>
				<p>
					Quality is the share of pixels that fit, times a falloff in the median
					error over all pixels, not just the good ones: with a ±25 % band the
					median of the good ones is small whatever the fit. Step Inside uses it
					to decide whether to show the near-field scene. Hide below 0.15, label
					below 0.35, set on the test photos. Deciding whether the pose is right
					is the job of the {link("accept-rule", "accept rule")}.
				</p>
				<GaugeFigure />
				<h3>In the code</h3>
				<div className="not-prose grid gap-3 sm:grid-cols-2">
					{[
						[
							"Fit and score",
							"src/lib/nearfield/anchor.ts",
							"Collects the pixel pairs, fits the curve and scores it.",
						],
						[
							"The curve",
							"src/lib/nearfield/anchor.ts",
							"Knots at weighted quantiles, then the best heights.",
						],
						[
							"Applying it",
							"src/lib/nearfield/anchor.ts",
							"Evaluates the curve, with a straight extension and a blend back to the near field.",
						],
						[
							"The score",
							"src/lib/nearfield/anchor.ts",
							"Share that fits times a falloff in the error; hide below 0.15, label below 0.35.",
						],
						[
							"Geometry",
							"src/lib/nearfield/geom.ts",
							"Depth along the axis to distance along the ray, and terrain lookups on the grid.",
						],
						[
							"Terrain side",
							"src/lib/nearfield/near-dem.ts",
							"The terrain side of every pair: distance in metres, one source for both renderers.",
						],
					].map(([name, path, text]) => (
						<div key={name} className="bg-[var(--gb-paper-deep)] p-4">
							<div
								className={`font-mono ${TYPE.caption} break-all text-[var(--accent)]`}
							>
								{name}
							</div>
							<p className={`mt-1 ${TYPE.caption} gb-secondary`}>{text}</p>
							<div className="mt-2">
								<CodeRef path={path} />
							</div>
						</div>
					))}
				</div>
				<p>
					The terrain side comes from the{" "}
					{link("terrain-sampler", "terrain sampler")}.
				</p>
			</Details>
		</>
	);
}
