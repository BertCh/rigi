// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	CircledKey,
	CircledNumber,
	HandMark,
	HandScaleBar,
	KrokiTitle,
	NorthArrow,
	PencilLayer,
	Wash,
} from "#/components/gipfelbuch/notebook";
import {
	Hachure,
	HandDot,
	HandText,
	PenArrow,
	PenCircle,
	PenCross,
	PenLine,
	SketchPath,
	SketchRect,
} from "#/components/gipfelbuch/notebook/Ink";
import { useNotebookPhoto } from "#/components/gipfelbuch/notebook/useNotebookPhoto";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import {
	Callout,
	CodeRef,
	Eq,
	Figure,
	Flow,
	HandLabel,
	LiveDrape,
	MarginNote,
	Measured,
	Plot,
	Steps,
	Sym,
	useTime,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Details,
	Key,
	Mark,
	MarkList,
	Numbers,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { PlotSeries } from "#/components/gipfelbuch/viz/Plot";
import { CrispLine } from "#/components/gipfelbuch/viz/real";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// TerrainSampler: heightAt(lat, lon) over a pile of tiles. Everything below is the real logic of
//   src/lib/geo/terrain.ts (sample / sampleAt / pixel / loadTerrain), src/lib/dem/sources.ts (MAPTERHORN.levels,
//   tileSize 512, maxZoom 17), src/lib/dem/tiles.ts (lonLatToTile, tilesAround), src/lib/dem/load.ts (fetchDemBytes).
// Per-level metres/pixel come from the tile-size formula at the demo camera's latitude; the tile counts, the
// seam patch and the level-vs-level height errors are MEASURED by scripts/gipfelbuch/data-terrain.ts (Mapterhorn
// tiles around the Niederhorn demo camera, run through the real TerrainSampler) and loaded from
// /demo/gipfelbuch/terrain/terrain.json.

type Lvl = {
	z: number;
	from: number;
	to: number;
	tiles: number;
	tileKm: number;
	mPerPx: number;
};
type TerrainData = {
	generated: string;
	script: string;
	site: { lat: number; lon: number };
	levels: { mapterhorn: Lvl[] };
	box: {
		cellM: number;
		profile: { row: number; northM: number; mapterhorn: number[] };
		mapterhorn: { max: number };
	};
	eyes: { id: string; groundMapterhorn: number }[];
	seam: {
		z: number;
		tileA: string;
		tileB: string;
		seamAtCol: number;
		gridW: number;
		gridH: number;
		heights: number[][];
		fx: number;
		fy: number;
		sampled: number;
		mPerPx: number;
	};
	transect: {
		bearing: number;
		step: number;
		d: number[];
		mapterhorn: Record<string, number[]>;
		mapterhornAt: number[];
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

const LEVELS = [
	{ z: 15, maxDistance: 1_000 },
	{ z: 14, maxDistance: 2_500 },
	{ z: 12, maxDistance: 6_000 },
	{ z: 11, maxDistance: 15_000 },
	{ z: 10, maxDistance: 40_000 },
	{ z: 9, maxDistance: 150_000 },
];
const TILE = 512; // MAPTERHORN.tileSize
const SITE = { lat: 46.71, lon: 7.773 }; // the Niederhorn demo camera
const DEG = Math.PI / 180;
const ANSWER = "var(--gb-water)";
const rectD = (x0: number, y0: number, x1: number, y1: number) =>
	`M${x0} ${y0}H${x1}V${y1}H${x0}Z`;
const circleD = (cx: number, cy: number, r: number) =>
	`M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`;
const EARTH_R = 6_371_000;

const mpp = (z: number) =>
	(40_075_016.686 * Math.cos(SITE.lat * DEG)) / (2 ** z * TILE);
const tx = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const ty = (lat: number, z: number) => {
	const s = Math.sin(lat * DEG);
	return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
};
/** tilesAround from dem/tiles.ts, count only: used until the measured counts load. */
function tileCount(radius: number, z: number) {
	const dLat = radius / EARTH_R / DEG;
	const dLon = dLat / Math.cos(SITE.lat * DEG);
	const ax = Math.floor(tx(SITE.lon - dLon, z));
	const bx = Math.floor(tx(SITE.lon + dLon, z));
	const ay = Math.floor(ty(SITE.lat + dLat, z));
	const by = Math.floor(ty(SITE.lat - dLat, z));
	return (bx - ax + 1) * (by - ay + 1);
}
const TILES0 = LEVELS.map((l) => tileCount(l.maxDistance, l.z));

/** sampleAt: start at the level for `distance`, walk coarser until a level answers. */
function answer(distance: number, missing: boolean[]) {
	let i = LEVELS.findIndex((l) => distance <= l.maxDistance);
	if (i < 0) i = LEVELS.length - 1;
	const start = i;
	for (; i < LEVELS.length; i++) if (!missing[i]) return { start, hit: i };
	return { start, hit: -1 };
}

const fmtM = (m: number) =>
	m >= 1000
		? `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`
		: `${Math.round(m)} m`;
const fmtRes = (v: number) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));

// ======================================================================================
// Fig. 1 — which tile level answers, by distance
// ======================================================================================
const R = 150;
const CX = 170;
const CY = 170;
const D_MAX = 150_000;
const rOf = (d: number) =>
	(R * Math.log(1 + d / 200)) / Math.log(1 + D_MAX / 200);
const dOf = (r: number) =>
	200 * (Math.exp((r / R) * Math.log(1 + D_MAX / 200)) - 1);

function LevelRings({ data }: { data: TerrainData | null }) {
	const TILES = data ? data.levels.mapterhorn.map((l) => l.tiles) : TILES0;
	const TOTAL_TILES = TILES.reduce((a, b) => a + b, 0);
	// the still frame (reduced motion, harness) probes 14 km: the z11 case
	const [ref, tRaw] = useTime<HTMLDivElement>(4.4);
	const t = Math.min(tRaw, 4.4); // one pass out from the camera, then it rests on the 14 km case
	const [missing, setMissing] = useState<boolean[]>(LEVELS.map(() => false));
	const [manual, setManual] = useState<{ d: number; a: number } | null>(null);

	const auto = {
		d: Math.exp(
			Math.log(60) +
				((Math.log(D_MAX * 0.97) - Math.log(60)) * (1 - Math.cos(t * 0.45))) /
					2,
		),
		a: -0.9 + t * 0.35,
	};
	const p = manual ?? auto;
	const { start, hit } = answer(p.d, missing);
	const pr = rOf(p.d);
	const px = CX + pr * Math.cos(p.a);
	const py = CY + pr * Math.sin(p.a);
	const toggle = (i: number) =>
		setMissing((m) => m.map((v, k) => (k === i ? !v : v)));

	function onMove(e: React.PointerEvent<SVGSVGElement>) {
		const b = e.currentTarget.getBoundingClientRect();
		const x = ((e.clientX - b.left) / b.width) * 340 - CX;
		const y = ((e.clientY - b.top) / b.height) * 340 - CY;
		const r = Math.min(R, Math.hypot(x, y));
		setManual({ d: Math.max(20, dOf(r)), a: Math.atan2(y, x) });
	}

	const fellBack = hit !== start;
	return (
		<Figure
			label="Fig. 2"
			bleed
			caption={
				<>
					Near ground is read at {fmtRes(mpp(15))} m a pixel, a far ridge at{" "}
					{fmtRes(mpp(9))} m. <Measured data={data} />
				</>
			}
		>
			<div
				ref={ref}
				className="grid items-center gap-x-12 gap-y-6 lg:grid-cols-[340px_minmax(0,1fr)]"
			>
				<svg
					viewBox="0 0 340 340"
					className="mx-auto block h-auto w-full max-w-[340px] touch-pan-y"
					role="img"
					aria-label="Concentric tile-level rings around the camera with a probe showing which level answered"
					onPointerMove={onMove}
					onPointerLeave={() => setManual(null)}
				>
					{[...LEVELS].reverse().map((l, ri) => {
						const i = LEVELS.length - 1 - ri;
						const on = i === hit;
						const rOuter = rOf(l.maxDistance);
						const rInner = i === 0 ? 0 : rOf(LEVELS[i - 1].maxDistance);
						const band =
							rInner > 0
								? `${circleD(CX, CY, rOuter)}${circleD(CX, CY, rInner)}`
								: circleD(CX, CY, rOuter);
						return (
							<g key={l.z}>
								{/* R2: hatch density is graded by level (finest densest); the answering band is denser still */}
								<Hachure
									d={band}
									seed={`ts-ring-${l.z}`}
									color={on ? "forest" : "brown"}
									gap={on ? 3.2 : 5 + 1.6 * i}
									width={on ? 1.1 : 0.8}
									opacity={on ? 0.75 : 0.4}
								/>
								<SketchPath
									d={circleD(CX, CY, rOuter)}
									seed={`ts-ringline-${l.z}`}
									color={on ? "forest" : "pencil"}
									width={on ? 2.2 : 0.9}
									passes={on ? 2 : 1}
								/>
								{missing[i] && (
									<Hachure
										d={band}
										seed={`ts-miss-${l.z}`}
										color="red"
										angle={45}
										gap={5}
										opacity={0.8}
									/>
								)}
							</g>
						);
					})}
					{LEVELS.map((l, i) => (
						<HandLabel
							key={l.z}
							x={CX}
							y={CY - rOf(l.maxDistance) + 11}
							anchor="middle"
							size={11}
							weight={i === hit ? 700 : 400}
							color={i === hit ? "var(--gb-ink)" : "var(--gb-secondary)"}
						>
							{`z${l.z}`}
						</HandLabel>
					))}
					<KrokiTitle
						x={8}
						y={22}
						title="Which height map answers?"
						size={18}
						seed="ts-rings-title"
					/>
					<NorthArrow x={318} y={48} seed="ts-rings-north" />
					<HandText x={170} y={336} size={14} anchor="middle" color="brown">
						log scale: far rings squeeze
					</HandText>
					<PencilLayer>
						<PenLine
							from={[CX - R, CY]}
							to={[CX + R, CY]}
							seed="ts-guide-h"
							width={0.8}
						/>
						<PenLine
							from={[CX, CY - R]}
							to={[CX, CY + R]}
							seed="ts-guide-v"
							width={0.8}
						/>
					</PencilLayer>
					{/* probe ray */}
					<PenLine
						seed="ts-probe-ray"
						data
						from={[CX, CY]}
						to={[px, py]}
						color="pencil"
						width={1}
						dash="3 3"
					/>
					<HandDot
						x={CX}
						y={CY}
						r={3.8}
						seed="ts-camera"
						data
						color="ink"
						opacity={1}
					/>
					<PenCircle
						seed="ts-probe-ring"
						data
						center={[px, py]}
						radiusX={8}
						color="pencil"
						width={1.1}
					/>
					{hit < 0 ? (
						<PenCross
							seed="ts-probe-nan"
							center={[px, py]}
							size={5}
							color="red"
							width={1.8}
						/>
					) : (
						<HandDot
							x={px}
							y={py}
							r={4}
							seed="ts-probe"
							data
							color="red"
							opacity={1}
						/>
					)}
					<HandLabel x={CX + 8} y={CY + 17} size={11}>
						camera
					</HandLabel>
					<CircledKey x={CX - 22} y={CY + 22} value="1" seed="ts-rings-key" />
				</svg>

				<div className={`min-w-[250px] flex-1 font-mono ${TYPE.micro}`}>
					<div className="mb-3 bg-[var(--gb-paper-deep)] p-3">
						<div className="flex items-baseline justify-between gb-secondary">
							<span>distance</span>
							<span className="gb-ink">{fmtM(p.d)}</span>
						</div>
						<div className="mt-1 flex items-baseline justify-between gb-secondary">
							<span>chosen level</span>
							<span className="gb-ink">z{LEVELS[start].z}</span>
						</div>
						<div className="mt-1 flex items-baseline justify-between gb-secondary">
							<span>answered by</span>
							<span
								className={
									hit < 0 ? "text-[var(--rigi-trap)]" : "text-[var(--gb-water)]"
								}
							>
								{hit < 0
									? "no height (nothing loaded)"
									: `z${LEVELS[hit].z} · ${fmtRes(mpp(LEVELS[hit].z))} m/px`}
							</span>
						</div>
						{fellBack && (
							<div className={`mt-1 gb-secondary ${TYPE.micro}`}>
								z{LEVELS[start].z} {missing[start] ? "missing" : "n/a"}
								{hit >= 0
									? ` → fell back ${hit - start} level${hit - start > 1 ? "s" : ""}`
									: " → no level left"}
							</div>
						)}
					</div>
					<div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-3 gap-y-1.5 gb-secondary">
						<span className="gb-secondary">level</span>
						<span className="gb-secondary">band</span>
						<span className="gb-secondary">m/px</span>
						<span className="gb-secondary">tiles</span>
						{LEVELS.map((l, i) => (
							<button
								key={l.z}
								type="button"
								onClick={() => toggle(i)}
								aria-pressed={missing[i]}
								className="col-span-4 grid grid-cols-subgrid items-center px-2 py-1.5 text-left transition hover:bg-[var(--gb-paper-deep)]"
								style={{
									background: i === hit ? "var(--gb-paper-deep)" : undefined,
									boxShadow:
										i === hit ? "inset 3px 0 0 var(--gb-red)" : undefined,
									textDecoration: missing[i] ? "line-through" : undefined,
									color: i === hit ? "var(--gb-ink)" : undefined,
								}}
								title="Toggle: this level's tile is missing"
							>
								<span>z{l.z}</span>
								<span>
									{i === 0 ? "0" : fmtM(LEVELS[i - 1].maxDistance)}–
									{fmtM(l.maxDistance)}
								</span>
								<span>{fmtRes(mpp(l.z))}</span>
								<span>{TILES[i]}</span>
							</button>
						))}
					</div>
					<p className={`mt-2 gb-secondary ${TYPE.micro}`}>
						{TOTAL_TILES} tiles for a full load here. Click a row to remove that
						level's tile and watch the probe fall back.
					</p>
				</div>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Fig. 2 — one bilinear sample, with a tile seam
// ======================================================================================
const GW = 6;
const GH = 5;
const SEAM = 3; // pixels with gx >= SEAM live in tile B
const CELL = 52;
const OX = 12;
const OY = 12;
const GRID_RULES =
	Array.from(
		{ length: GW + 1 },
		(_, i) => `M${OX + i * CELL} ${OY}V${OY + GH * CELL}`,
	).join("") +
	Array.from(
		{ length: GH + 1 },
		(_, i) => `M${OX} ${OY + i * CELL}H${OX + GW * CELL}`,
	).join("");

function BilinearProbe({ data }: { data: TerrainData | null }) {
	const GRID =
		data?.seam.heights ??
		Array.from({ length: GH }, () => Array.from({ length: GW }, () => 0));
	const HMIN = Math.min(...GRID.flat());
	const HMAX = Math.max(...GRID.flat());
	const [ref, t] = useTime<HTMLDivElement>(14);
	const [manual, setManual] = useState<{ u: number; v: number } | null>(null);
	const [bGone, setBGone] = useState(false);

	// wanders across the seam for 10 s, then eases to rest fully inside tile A (u = 2 is left of the seam)
	const tw = Math.min(t, 10);
	const rest = Math.min(1, Math.max(0, (t - 10) / 3));
	const e = rest * rest * (3 - 2 * rest);
	const auto = {
		u: (1 - e) * (3 + 2.3 * Math.sin(0.5 * tw + 1)) + e * 2,
		v: (1 - e) * (2.5 + 1.7 * Math.sin(0.37 * tw)) + e * 2.5,
	};
	const pr = manual ?? auto;
	const u = Math.max(0.02, Math.min(GW - 0.02, pr.u));
	const v = Math.max(0.02, Math.min(GH - 0.02, pr.v));
	// px = tileCoord * size - 0.5: pixel centres sit at i + 0.5 in cell space
	const px = u - 0.5;
	const py = v - 0.5;
	const x0 = Math.floor(px);
	const y0 = Math.floor(py);
	const fx = px - x0;
	const fy = py - y0;
	const hAt = (gx: number, gy: number) => {
		if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) return Number.NaN; // outside the drawn window
		if (bGone && gx >= SEAM) return Number.NaN;
		return GRID[gy][gx];
	};
	const h00 = hAt(x0, y0);
	const h10 = hAt(x0 + 1, y0);
	const h01 = hAt(x0, y0 + 1);
	const h11 = hAt(x0 + 1, y0 + 1);
	const top = h00 * (1 - fx) + h10 * fx;
	const bot = h01 * (1 - fx) + h11 * fx;
	const res = top * (1 - fy) + bot * fy;
	const nearest = hAt(Math.floor(u), Math.floor(v));
	const bad = Number.isNaN(res);

	const cx = (gx: number) => OX + (gx + 0.5) * CELL; // pixel centre in svg
	const cy = (gy: number) => OY + (gy + 0.5) * CELL;
	const sx = OX + u * CELL;
	const sy = OY + v * CELL;
	const corner = [
		{ gx: x0, gy: y0, w: (1 - fx) * (1 - fy), h: h00 },
		{ gx: x0 + 1, gy: y0, w: fx * (1 - fy), h: h10 },
		{ gx: x0, gy: y0 + 1, w: (1 - fx) * fy, h: h01 },
		{ gx: x0 + 1, gy: y0 + 1, w: fx * fy, h: h11 },
	];

	function onMove(e: React.PointerEvent<SVGSVGElement>) {
		const b = e.currentTarget.getBoundingClientRect();
		setManual({
			u: (((e.clientX - b.left) / b.width) * (GW * CELL + 2 * OX) - OX) / CELL,
			v:
				(((e.clientY - b.top) / b.height) * (GH * CELL + 2 * OY + 14) - OY) /
				CELL,
		});
	}

	return (
		<Figure
			label="Fig. 3"
			bleed
			caption={
				<>
					Blend the four nearest pixels, each weighted by the area opposite it.
					One missing corner leaves no answer.
				</>
			}
		>
			<div
				ref={ref}
				className="grid items-center gap-x-12 gap-y-6 lg:grid-cols-[360px_minmax(0,1fr)]"
			>
				<svg
					viewBox={`0 0 ${GW * CELL + 2 * OX} ${GH * CELL + 2 * OY + 14}`}
					className="mx-auto block h-auto w-full max-w-[360px] touch-pan-y"
					role="img"
					aria-label="A height grid with a probe and the four pixels a bilinear sample blends"
					onPointerMove={onMove}
					onPointerLeave={() => setManual(null)}
				>
					{GRID.flatMap((row, gy) =>
						row.map((h, gx) => ({ h, gx, gy, id: `cell${gx}x${gy}` })),
					).map(({ h, gx, gy, id }) => {
						const k = HMAX > HMIN ? (h - HMIN) / (HMAX - HMIN) : 0;
						const gone = bGone && gx >= SEAM;
						const cell = rectD(
							OX + gx * CELL,
							OY + gy * CELL,
							OX + (gx + 1) * CELL,
							OY + (gy + 1) * CELL,
						);
						return (
							<g key={id}>
								{gone ? (
									<Hachure
										d={cell}
										seed={`ts-gone-${id}`}
										color="red"
										angle={45}
										gap={6}
										opacity={0.7}
									/>
								) : (
									<>
										<Hachure
											d={cell}
											seed={`ts-cell-${id}`}
											color="brown"
											gap={14 - 9 * k}
											width={0.9}
											opacity={0.28 + 0.3 * k}
										/>
									</>
								)}
								<HandLabel x={cx(gx)} y={cy(gy) + 14} anchor="middle" size={11}>
									{gone ? "no data" : h.toFixed(1)}
								</HandLabel>
							</g>
						);
					})}
					{/* the pencil-ruled grid over the shading */}
					<SketchPath
						d={GRID_RULES}
						seed="ts-grid"
						color="pencil"
						width={0.7}
						passes={1}
					/>
					{/* area weights: each corner owns the rectangle opposite the probe; one fixed stipple, clipped */}
					{corner.map((c) => {
						const ox = c.gx === x0 ? cx(x0 + 1) : cx(x0);
						const oy = c.gy === y0 ? cy(y0 + 1) : cy(y0);
						return (
							<g key={`w${c.gx}-${c.gy}`}>
								<Wash
									d={rectD(
										Math.min(sx, ox),
										Math.min(sy, oy),
										Math.max(sx, ox),
										Math.max(sy, oy),
									)}
									seed={`ts-w-${c.gx - x0}-${c.gy - y0}`}
									color="forest"
									layers={6}
									opacity={0.012 + 0.07 * c.w}
									offset={[0, 0]}
								/>
								<SketchRect
									x={Math.min(sx, ox)}
									y={Math.min(sy, oy)}
									width={Math.abs(sx - ox)}
									height={Math.abs(sy - oy)}
									seed={`ts-wr-${c.gx - x0}-${c.gy - y0}`}
									color="forest"
									opacity={0.6}
									penWidth={0.8}
									dash="3 3"
									passes={1}
								/>
							</g>
						);
					})}
					{/* tile seam */}
					<PenLine
						seed="ts-seam"
						data
						from={[OX + SEAM * CELL, OY - 6]}
						to={[OX + SEAM * CELL, OY + GH * CELL + 6]}
						color="ink"
						width={1.5}
						dash="5 3"
					/>
					<HandLabel
						x={OX + SEAM * CELL - 5}
						y={OY + GH * CELL + 14}
						anchor="end"
						size={12}
					>
						tile A
					</HandLabel>
					<HandLabel x={OX + SEAM * CELL + 5} y={OY + GH * CELL + 14} size={12}>
						tile B
					</HandLabel>
					{/* the four pixel centres and the probe */}
					{corner.map((c, n) => (
						<HandLabel
							key={`n${c.gx}-${c.gy}`}
							x={cx(c.gx) - 8}
							y={cy(c.gy) - 6}
							anchor="end"
							size={13}
							color="var(--gb-forest)"
						>
							{n + 1}
						</HandLabel>
					))}
					{corner.map((c) => (
						<HandDot
							key={`c${c.gx}-${c.gy}`}
							x={cx(c.gx)}
							y={cy(c.gy)}
							r={3.4}
							seed={`ts-corner-${c.gx}-${c.gy}`}
							data
							color="ink"
							opacity={1}
						/>
					))}
					<PenCircle
						seed="ts-probe-ring"
						data
						center={[sx, sy]}
						radiusX={8}
						color="pencil"
						width={1.2}
					/>
					{bad ? (
						<PenCross
							seed="ts-probe-bad"
							center={[sx, sy]}
							size={5}
							color="red"
							width={1.8}
						/>
					) : (
						<HandDot
							x={sx}
							y={sy}
							r={3.8}
							seed="ts-probe"
							data
							color="red"
							opacity={1}
						/>
					)}
				</svg>

				<div
					className={`min-w-[240px] flex-1 font-mono gb-secondary ${TYPE.micro}`}
				>
					<div className="bg-[var(--gb-paper-deep)] p-3">
						<div className="flex justify-between">
							<span>pixel position</span>
							<span className="gb-ink">
								{px.toFixed(2)}, {py.toFixed(2)}
							</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>offset within pixel</span>
							<span className="gb-ink">
								{fx.toFixed(2)}, {fy.toFixed(2)}
							</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>top / bottom blend</span>
							<span className="gb-ink">
								{Number.isNaN(top) ? "no data" : top.toFixed(1)} /{" "}
								{Number.isNaN(bot) ? "no data" : bot.toFixed(1)}
							</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>bilinear</span>
							<span
								className={
									bad ? "text-[var(--rigi-trap)]" : "text-[var(--gb-water)]"
								}
							>
								{bad
									? "no height, try the coarser level"
									: `${res.toFixed(1)} m`}
							</span>
						</div>
						<div className="mt-1 flex justify-between gb-secondary">
							<span>nearest pixel would say</span>
							<span>{Number.isNaN(nearest) ? "no data" : `${nearest} m`}</span>
						</div>
						{data && (
							<div className="mt-2 flex justify-between pt-1 gb-secondary">
								<span>
									TerrainSampler.sample at (
									{(data.seam.seamAtCol - 1 + data.seam.fx + 0.5).toFixed(1)},{" "}
									{(2 + data.seam.fy + 0.5).toFixed(1)})
								</span>
								<span className="gb-ink">{data.seam.sampled.toFixed(2)} m</span>
							</div>
						)}
					</div>
					<div className="mt-3 flex items-center gap-2">
						<button
							type="button"
							aria-pressed={bGone}
							onClick={() => setBGone((v) => !v)}
							className={`border-b-2 bg-[var(--gb-paper-deep)] px-2.5 py-1 transition ${TYPE.micro}`}
							style={{
								borderColor: bGone ? "var(--rigi-trap)" : "transparent",
								color: "var(--gb-ink)",
							}}
						>
							{bGone ? "tile B not loaded" : "tile B loaded"}
						</button>
						<span className={`gb-secondary ${TYPE.micro}`}>
							cross the seam to see it
						</span>
						{data && (
							<button
								type="button"
								onClick={() =>
									setManual({
										u: data.seam.seamAtCol - 1 + data.seam.fx + 0.5,
										v: 2 + data.seam.fy + 0.5,
									})
								}
								className={`bg-[var(--gb-paper-deep)] px-2.5 py-1 transition ${TYPE.micro}`}
							>
								measured point
							</button>
						)}
					</div>
					<div className="mt-3 grid grid-cols-4 gap-3">
						{corner.map((c, n) => (
							<div key={`wb${c.gx}-${c.gy}`}>
								<div className="flex justify-between">
									<span style={{ color: "var(--gb-forest)" }}>{n + 1}</span>
									<span className="gb-ink">{c.w.toFixed(2)}</span>
								</div>
								<div className="mt-1 h-3 bg-[var(--gb-paper-deep)]">
									<div
										className="h-full"
										style={{
											width: `${(c.w * 100).toFixed(1)}%`,
											background: "var(--gb-forest)",
										}}
									/>
								</div>
							</div>
						))}
					</div>
					<p className={`mt-1 gb-secondary ${TYPE.micro}`}>
						the four weights, numbered as the dots, summing to 1
					</p>
				</div>
			</div>
			<Eq
				className="mb-0"
				where={[
					{
						sym: "top, bottom",
						text: "blend of the two pixels in each row: (1 − fx)·left + fx·right",
					},
					{
						sym: "fx, fy",
						text: "how far right of and below the top-left pixel centre, 0 to 1",
					},
					{
						sym: "h",
						c: ANSWER,
						text: "the four numbered dots are the pixel heights; weights are the shaded rectangles and bars",
					},
				]}
			>
				<Sym c={ANSWER}>h</Sym> = (1 − <Sym>fy</Sym>)·<Sym>top</Sym> +{" "}
				<Sym>fy</Sym>·<Sym>bottom</Sym>
				{!bad && (
					<>
						<br />= (1 − {fy.toFixed(2)})·{top.toFixed(1)} + {fy.toFixed(2)}·
						{bot.toFixed(1)} = <Sym c={ANSWER}>{res.toFixed(1)}</Sym> m
					</>
				)}
			</Eq>
		</Figure>
	);
}

// ======================================================================================
// Fig. 3 — what a coarser level costs, measured along a real line
// ======================================================================================
function LevelCost({ data }: { data: TerrainData | null }) {
	const tr = data?.transect;
	if (!data || !tr)
		return (
			<Figure bleed caption="Loading the measured transect.">
				<div className="aspect-[2/1] animate-pulse bg-[var(--gb-paper-deep)]" />
			</Figure>
		);
	const zs = Object.keys(tr.mapterhorn).map(Number);
	const ref = tr.mapterhorn["15"];
	const idx = tr.d.map((_, i) => i).filter((i) => tr.d[i] <= 12000);
	const km = tr.d.map((m) => m / 1000);
	const colors: Record<number, string> = {
		15: "var(--gb-forest)",
		14: "var(--gb-relief)",
		12: "var(--gb-relief)",
		11: "var(--gb-relief)",
		10: "var(--gb-relief)",
		9: "var(--gb-contour)",
	};
	const err = (z: number) =>
		idx.map((i) => tr.mapterhorn[String(z)][i] - ref[i]);
	const worst = (z: number) => Math.max(...err(z).map(Math.abs));
	const picked = idx.map((i) => tr.mapterhornAt[i] - ref[i]);
	return (
		<Figure
			label="Fig. 4"
			bleed
			caption={
				<>
					Black: our answer along a real 12 km line, as height minus the finest
					map&rsquo;s. Orange: the coarsest map used everywhere.
				</>
			}
		>
			<Plot
				x={[0, 12]}
				y={[-60, 60]}
				width={620}
				height={260}
				xLabel="distance from camera (km)"
				yLabel="height minus finest map (m)"
				fmtX={(v) => v.toFixed(0)}
				fmtY={(v) => v.toFixed(0)}
			>
				{(s) => (
					<>
						{LEVELS.slice(0, 3).map((l) => (
							<PenLine
								key={l.z}
								seed={`ts-band-${l.z}`}
								data
								from={[s.x(l.maxDistance / 1000), s.box.y0]}
								to={[s.x(l.maxDistance / 1000), s.box.y1]}
								color="pencil"
								width={0.9}
								dash="3 3"
							/>
						))}
						{zs
							.filter((z) => z === 9)
							.map((z) => (
								<PlotSeries
									key={z}
									d={s.line(
										idx.map((i) => [
											km[i],
											tr.mapterhorn[String(z)][i] - ref[i],
										]),
									)}
									seed={`ts-coarse-z${z}`}
									color={colors[z]}
									width={1.4}
								/>
							))}
						<PlotSeries
							d={s.line(idx.map((i, k) => [km[i], picked[k]]))}
							seed="ts-answer"
							color="ink"
							width={2}
						/>
						<HandText
							x={s.x(3.2)}
							y={s.y(-44)}
							size={16}
							rotate={-2}
							color="red"
						>
							{`band rule stays within ${Math.max(...picked.map(Math.abs)).toFixed(0)} m`}
						</HandText>
						<PenArrow
							from={[s.x(3.1), s.y(-40)]}
							to={[
								s.x(2.2),
								s.y(picked[idx.findIndex((i) => km[i] >= 2.2)] ?? 0),
							]}
							seed="ts-answer-arrow"
							color="red"
							width={1.2}
						/>
					</>
				)}
			</Plot>
			<div
				className={`mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono gb-secondary ${TYPE.micro}`}
			>
				{zs
					.filter((z) => z !== 15)
					.sort((a, b) => b - a)
					.map((z, k, all) => (
						<span key={z} className="inline-flex items-center gap-1.5">
							<span
								className="inline-block size-2.5"
								style={{
									background: `color-mix(in srgb, var(--gb-contour) ${25 + (75 * k) / Math.max(1, all.length - 1)}%, var(--gb-paper))`,
								}}
							/>
							<span className="gb-ink">z{z}</span> worst {worst(z).toFixed(0)} m
						</span>
					))}
			</div>
			<p className={`mt-2 gb-secondary ${TYPE.caption}`}>
				<Key color="var(--gb-ink)">answer (black)</Key>{" "}
				<Key color="var(--gb-contour)">coarsest everywhere (orange)</Key>.
				Dashed lines: band edges at 1, 2.5 and 6 km.
			</p>
		</Figure>
	);
}

const fmtN = (v: number, n = 0) =>
	v.toLocaleString("en-US", {
		minimumFractionDigits: n,
		maximumFractionDigits: n,
	});

/** Worst error of the coarsest map vs the finest within 12 km, and of the band rule. */
function costNumbers(d: TerrainData | null) {
	const tr = d?.transect;
	if (!tr) return null;
	const ref = tr.mapterhorn["15"];
	const idx = tr.d.map((_, i) => i).filter((i) => tr.d[i] <= 12000);
	const coarse = Math.max(
		...idx.map((i) => Math.abs(tr.mapterhorn["9"][i] - ref[i])),
	);
	const picked = Math.max(
		...idx.map((i) => Math.abs(tr.mapterhornAt[i] - ref[i])),
	);
	return { coarse, picked };
}

/* ---------- Hero: one question, four answers ---------- */
function AskTheMap({ d }: { d: TerrainData | null }) {
	const [photoId] = useNotebookPhoto();
	const box = d?.box;
	const row = box?.profile.mapterhorn;
	if (!d || !box || !row)
		return (
			<Figure caption="Loading measured data.">
				<div className="aspect-square animate-pulse bg-[var(--gb-paper-deep)]" />
			</Figure>
		);
	const cell = box.cellM;
	const y = box.profile.row + 0.5;
	// R9: point 1 follows the photo picked in the sheet; the hillshade and points 2 to 4 are the demo-01 patch
	const eye = d.eyes.find((e) => e.id === photoId) ?? d.eyes[0];
	const cam = eye.groundMapterhorn;
	const summitX = row.indexOf(Math.max(...row));
	const midX = 150;
	const westX = 20;
	const dist = (x: number, yy: number) =>
		Math.hypot((x + 0.5 - 150) * cell, (150 - yy) * cell);
	const pts = [
		{ n: 1, x: 150, y: 150, h: cam, t: `Under the camera (${eye.id})` },
		{ n: 2, x: summitX + 0.5, y, h: row[summitX], t: "The summit" },
		{ n: 3, x: midX + 0.5, y, h: row[midX], t: "North of the camera" },
		{ n: 4, x: westX + 0.5, y, h: row[westX], t: "Down the slope" },
	];
	// the drop is within the demo-01 patch, so it starts from demo-01's own ground, not the picked photo's
	const eye01 = d.eyes.find((e) => e.id === "demo-01") ?? d.eyes[0];
	const drop = eye01.groundMapterhorn - row[midX];
	const lo = Math.min(...row) - 40;
	const hi = Math.max(...row) + 40;
	const PX = (v: number) => (v / (row.length - 1)) * 360;
	const PY = (v: number) => 88 - ((v - lo) / (hi - lo)) * 76;
	return (
		<Figure
			label="Fig. 1"
			bleed
			pinned="demo-01"
			caption={
				<>
					The ground falls {drop.toFixed(0)} m within {dist(midX, y).toFixed(0)}{" "}
					m north of the camera.{" "}
					<MarginNote mark="d">
						{
							"Point 1 follows the photo picked above. The shaded relief and points 2 to 4 are fixed (demo-01 area)."
						}
					</MarginNote>{" "}
					<Measured data={d} />
				</>
			}
		>
			<div className="grid items-start gap-x-10 gap-y-4 lg:grid-cols-[minmax(0,600px)_minmax(0,1fr)]">
				<svg
					viewBox="0 0 300 300"
					className="block h-auto w-full overflow-hidden"
					role="img"
					aria-label="Hillshade of the Niederhorn ridge with four height questions marked"
				>
					<image
						href="/demo/gipfelbuch/terrain/hs-mapterhorn.jpg"
						width={300}
						height={300}
						preserveAspectRatio="none"
					/>
					<CrispLine d={`M0 ${y}H300`} color="#fff" width={1.4} dash="4 4" />
					<HandScaleBar
						x={14}
						y={288}
						metersPerPixel={cell}
						maxWidth={110}
						seed="ts-hero-scale"
					/>
					<NorthArrow x={278} y={52} seed="ts-hero-north" />
					<HandText x={168} y={y - 6} size={15} color="#fff" halo={false}>
						the profile below is read along this line
					</HandText>
					{pts.map((p) => (
						<Mark key={p.n} x={p.x} y={p.y} n={p.n} k={0.75} />
					))}
				</svg>
				<div className="lg:pt-2">
					<svg
						viewBox="0 0 360 100"
						className="block h-auto w-full"
						role="img"
						aria-label="Ground height along the dashed line, west to east"
					>
						<Hachure
							d={`M0 100L${row.map((v, x) => `${PX(x).toFixed(1)} ${PY(v).toFixed(1)}`).join("L")}L360 100Z`}
							seed="ts-hero-profile-fill"
							color="brown"
							gap={4}
							opacity={0.5}
						/>
						<SketchPath
							d={`M${row.map((v, x) => `${PX(x).toFixed(1)} ${PY(v).toFixed(1)}`).join("L")}`}
							seed="ts-hero-profile"
							data
							color="brown"
							width={1.6}
						/>
						{pts.slice(1).map((p) => (
							<Mark key={p.n} x={PX(p.x - 0.5)} y={PY(p.h)} n={p.n} k={1.1} />
						))}
						{[
							{ v: Math.min(...row), k: "lo" },
							{ v: Math.max(...row), k: "hi" },
							{ v: cam, k: "cam" },
						].map((t) => (
							<g key={t.k}>
								<PenLine
									seed={`ts-hero-tick-${t.k}`}
									from={[0, PY(t.v)]}
									to={[6, PY(t.v)]}
									data
									color="pencil"
									width={1}
								/>
								<HandLabel x={8} y={PY(t.v) + 4} size={12} italic>
									{`${fmtN(t.v)} m${t.k === "cam" ? " camera" : ""}`}
								</HandLabel>
							</g>
						))}
						<HandText x={PX(midX) + 8} y={PY(row[midX]) - 18} size={15}>
							{`falls ${drop.toFixed(0)} m already`}
						</HandText>
					</svg>
					<p className={`mt-1 gb-secondary ${TYPE.caption}`}>
						Height along the dashed line, west to east (170 m north of the
						camera).
					</p>
				</div>
			</div>
			<MarkList
				items={pts.map((p) => (
					<>
						{p.t}: <strong>{fmtN(p.h)} m</strong>
						{p.n === 1 ? "." : `, ${fmtN(dist(p.x - 0.5, p.y))} m away.`}
					</>
				))}
			/>
		</Figure>
	);
}

/* ---------- Trio visuals ---------- */
function LevelsMini({ d }: { d: TerrainData | null }) {
	const lv = d?.levels.mapterhorn;
	if (!lv)
		return (
			<div className="aspect-[4/3] animate-pulse bg-[var(--gb-paper-deep)]" />
		);
	const x = (m: number) =>
		10 + ((Math.log10(Math.max(m, 100)) - 2) / (Math.log10(160_000) - 2)) * 280;
	return (
		<svg
			viewBox="0 0 300 130"
			className="block h-auto w-full"
			role="img"
			aria-label="Six distance bands, each with its own tile zoom"
		>
			<PenLine
				seed="mini-levels-base"
				from={[8, 82]}
				to={[292, 82]}
				color="pencil"
				width={1.1}
			/>
			{lv.map((l, i) => {
				const x0 = i === 0 ? x(100) : x(lv[i - 1].to);
				const x1 = x(l.to);
				return (
					<g key={l.z}>
						<Hachure
							d={rectD(
								x0 + 1,
								30 + i * 3,
								x0 + 1 + Math.max(2, x1 - x0 - 2),
								80,
							)}
							seed={`mini-levels-${l.z}`}
							color="brown"
							gap={9 - i}
							width={0.9}
							opacity={0.7}
						/>
						<HandLabel x={(x0 + x1) / 2} y={97} anchor="middle" size={14}>
							{`z${l.z}`}
						</HandLabel>
						<HandLabel
							x={(x0 + x1) / 2}
							y={109}
							anchor="middle"
							size={13}
							color="var(--gb-secondary)"
						>
							{`${l.mPerPx.toFixed(l.mPerPx < 10 ? 1 : 0)} m`}
						</HandLabel>
					</g>
				);
			})}
			<HandLabel x={10} y={18} size={14}>
				near
			</HandLabel>
			<HandText x={150} y={20} size={15} anchor="middle" rotate={-2}>
				log-spaced bands
			</HandText>
			<HandLabel x={290} y={18} anchor="end" size={14}>
				far
			</HandLabel>
		</svg>
	);
}

/** Bilinear in small: the real 2 x 2 pixels around the measured seam probe. */
function BlendMini({ d }: { d: TerrainData | null }) {
	const s = d?.seam;
	if (!s)
		return (
			<div className="aspect-[4/3] animate-pulse bg-[var(--gb-paper-deep)]" />
		);
	const c = s.seamAtCol - 1;
	const r = 2;
	const h = [
		[s.heights[r][c], s.heights[r][c + 1]],
		[s.heights[r + 1][c], s.heights[r + 1][c + 1]],
	];
	const C = 70;
	const O = 40;
	const px = O + C / 2 + s.fx * C;
	const py = 15 + C / 2 + s.fy * C;
	return (
		<svg
			viewBox="0 0 300 180"
			className="block h-auto w-full"
			role="img"
			aria-label="Four height pixels and the point between them"
		>
			{h.map((row, j) =>
				row.map((v, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: the grid position is the identity
					<g key={`${i}-${j}`}>
						<Hachure
							d={rectD(
								O + i * C,
								15 + j * C,
								O + (i + 1) * C,
								15 + (j + 1) * C,
							)}
							seed={`mini-blend-${i}-${j}`}
							color="brown"
							gap={10 - 2.5 * (i + j)}
							width={0.9}
							opacity={0.65}
						/>
						<HandLabel x={O + i * C + 5} y={15 + j * C + 13} size={13}>
							{v.toFixed(1)}
						</HandLabel>
					</g>
				)),
			)}
			<SketchPath
				d={`M${O} 15H${O + 2 * C}M${O} ${15 + C}H${O + 2 * C}M${O} ${15 + 2 * C}H${O + 2 * C}M${O} 15V${15 + 2 * C}M${O + C} 15V${15 + 2 * C}M${O + 2 * C} 15V${15 + 2 * C}`}
				seed="mini-blend-grid"
				color="pencil"
				width={0.8}
				passes={1}
			/>
			<PenCircle
				seed="mini-blend-ring"
				center={[px, py]}
				radiusX={8}
				color="pencil"
				width={1.2}
			/>
			<HandDot
				x={px}
				y={py}
				r={4.2}
				seed="mini-blend-probe"
				color="red"
				opacity={1}
			/>
			<HandLabel x={O + 2 * C + 16} y={75} size={14}>
				answer
			</HandLabel>
			<HandLabel x={O + 2 * C + 16} y={94} size={14} color={ANSWER}>
				{`${s.sampled.toFixed(2)} m`}
			</HandLabel>
		</svg>
	);
}

function HoleMini() {
	return (
		<svg
			viewBox="0 0 300 130"
			className="block h-auto w-full"
			role="img"
			aria-label="A missing fine tile falls back to a coarser one"
		>
			<Hachure
				d={rectD(30, 30, 90, 90)}
				seed="mini-hole-miss"
				color="red"
				angle={45}
				gap={5}
				opacity={0.75}
			/>
			<SketchPath
				d={rectD(30, 30, 90, 90)}
				seed="mini-hole-edge"
				color="pencil"
				width={1}
				dash="3 3"
				passes={1}
			/>
			<HandLabel x={60} y={112} anchor="middle" size={14}>
				fine tile missing
			</HandLabel>
			<PenArrow
				seed="mini-hole-arrow"
				from={[96, 60]}
				to={[132, 60]}
				bend={0.1}
				color="ink"
				width={1.6}
			/>
			<Hachure
				d={rectD(140, 20, 260, 100)}
				seed="mini-hole-coarse"
				color="brown"
				gap={4}
				width={1}
				opacity={0.7}
			/>
			<HandLabel x={200} y={65} anchor="middle" size={15} color="var(--gb-ink)">
				coarser tile
			</HandLabel>
		</svg>
	);
}

export default function Page({ node }: { node: GipfelbuchNode }) {
	void node;
	const data = useTerrainData();
	const cost = costNumbers(data);
	const lv = data?.levels.mapterhorn;
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
			<AskTheMap d={data} />

			<Beat
				kicker="The idea"
				title="Asked millions of times: how high is the ground here?"
			>
				<p>
					Give it a spot and its distance from the camera; it answers in metres.
				</p>
				<p>
					<HandMark type="highlight">
						Near spots read a sharp height map, far spots a coarse one.
					</HandMark>{" "}
					That keeps it fast and keeps nearby detail. In the rings below, the
					camera is <CircledNumber value={1} seed="ts-prose-1" />.
					{lv && (
						<MarginNote mark="a">
							{`The nearest map is ${lv[0].mPerPx.toFixed(1)} m a pixel, the farthest ${Math.round(lv[lv.length - 1].mPerPx)} m.`}
						</MarginNote>
					)}
				</p>
			</Beat>

			<LevelRings data={data} />

			<Beat
				kicker="How it works"
				title="Pick a map, blend four pixels, fall back on a hole."
			>
				<Trio
					steps={[
						{
							title: "Pick the map",
							body: "Distance chooses one of six maps, sharpest first.",
							visual: <LevelsMini d={data} />,
						},
						{
							title: "Blend four pixels",
							body: "Weight each by how close the spot is to it.",
							visual: <BlendMini d={data} />,
						},
						{
							title: "No tile? Go coarser",
							body: "A missing tile is a hole, so we ask the next map.",
							visual: <HoleMini />,
						},
					]}
				/>
			</Beat>

			<Beat kicker="Blend" title="Each answer blends the four nearest pixels.">
				<p>
					A spot rarely sits on a pixel centre. Each neighbour counts in
					proportion to{" "}
					<HandMark type="underline">the area opposite it</HandMark>.
					<MarginNote mark="b">
						Cross the seam with tile B unloaded and there is no answer.
					</MarginNote>
				</p>
			</Beat>

			<BilinearProbe data={data} />

			<Beat
				kicker="Where it errs"
				title={
					cost
						? `The coarsest map alone differs from the finest by up to ${cost.coarse.toFixed(0)} m. The band rule keeps it to ${cost.picked.toFixed(0)} m.`
						: "Coarse maps are cheap but can be off by tens of metres."
				}
			>
				<p>
					Sharp tiles near us, coarse tiles far away.{" "}
					<HandMark type="double">
						That caps the error without loading every tile sharp.
					</HandMark>
					{cost && (
						<MarginNote mark="c">
							{`Tempting: coarse everywhere is fine. Up to ${cost.coarse.toFixed(0)} m off. With bands: ${cost.picked.toFixed(0)} m.`}
						</MarginNote>
					)}
				</p>
				<p>
					At sea the map reads 0 m, so{" "}
					<HandMark type="wavy">a coast looks like sea level</HandMark>.
				</p>
			</Beat>

			<LevelCost data={data} />

			{/* The shell Tafel spills this sheet's one photo: the plate keeps its frame, no surround or line art. */}
			<LiveDrape
				number="Fig. 5"
				title="Heights across the photo"
				notes={[
					{
						text: "every height here is one sampler answer",
						at: [0.4, 0.5],
						side: "left",
					},
					{
						text: "near ground is sharp, far ridges come from coarser tiles",
						at: [0.75, 0.25],
						side: "right",
					},
				]}
			/>

			<Numbers
				items={[
					{
						value: lv ? String(lv.length) : "…",
						label: "height maps, finest to coarsest",
					},
					{
						value: lv
							? `${lv[0].mPerPx.toFixed(1)} → ${Math.round(lv[lv.length - 1].mPerPx)} m`
							: "…",
						label: "pixel size, near to far, at the Niederhorn camera",
					},
					{
						value: lv ? String(lv.reduce((a, l) => a + l.tiles, 0)) : "…",
						label: "tiles for one full load",
					},
					{
						value: cost ? `${cost.picked.toFixed(0)} m` : "…",
						label: "worst gap to the finest map, 12 km line",
					},
				]}
				source="Measured with the Mapterhorn terrain tiles."
			/>

			<Details>
				<h3>What it answers</h3>
				<p>
					The horizon, summit visibility and the solvers all ask the same
					question: how high is the terrain at this longitude and latitude, from
					a camera this far away? A stack of preloaded tiles at several zoom
					levels answers it. It loads nothing itself, so it runs the same in the
					page and in scripts.
				</p>
				<p>
					Each zoom level covers a distance band: z15 to 1 km, z14 to 2.5 km,
					z12 to 6 km, z11 to 15 km, z10 to 40 km, z9 to 150 km. Mapterhorn
					tiles are 512 px, so the table sits one zoom below the 256 px
					Terrarium table, plus two finer near levels. See{" "}
					{A("dem-source", "DEM Source")}.
				</p>
				<p>
					The sampler takes the first level whose band holds the distance. If
					that level has no data there, it tries coarser ones. So the finest
					zoom needs to exist only where a national lidar model does.
				</p>
				<h3>From a GPS fix to a ready sampler</h3>
				<Steps
					steps={[
						{
							title: "Plan the tiles",
							body: (
								<>
									For every level, list the tiles inside that level&rsquo;s
									distance band, skipping any already loaded.
								</>
							),
						},
						{
							title: "Load in batches, check the size",
							body: (
								<>
									Tiles load 16 at a time. A tile of the wrong size is rejected
									loudly, because it would silently scramble heights. A tile
									that fails to load leaves a hole.
								</>
							),
						},
						{
							title: "Where a tile does not exist",
							body: (
								<>
									A 404 or empty reply is remembered for the session, and the
									request walks up to the nearest tile that exists and enlarges
									its quadrant, so the sampler still sees a normal tile.
								</>
							),
						},
						{
							title: "Sample",
							body: (
								<>
									Convert to fractional tile pixels, shift by half a pixel,
									blend bilinearly. Any missing corner gives no value and the
									next level is tried.
								</>
							),
						},
					]}
				/>
				<Flow
					nodes={[
						{ label: "Plan", sub: "per level" },
						{ label: "Load", sub: "16 at a time, size-checked" },
						{ label: "Store", sub: "height grids by z/x/y" },
						{ label: "Sample", sub: "band, blend, fall back" },
					]}
				/>
				<p>
					Sea is set to 0 when tiles are decoded, so a coast reads as sea level.
					Tiles are 512 px, up to z17.
				</p>
				<Callout tone="note" title="Same tiles as the 3D view">
					The 3D terrain loads the same tiles with the same fallback, so both
					see the same ground.
				</Callout>
				<h3>Where it fits</h3>
				<p>
					It gives the camera&rsquo;s own ground height.{" "}
					{A("dem-horizon", "The DEM horizon")} calls it along every direction,
					and the {A("viewport-inference", "viewport solver")} matches that
					horizon to the photo&rsquo;s skyline.{" "}
					{A("terrain-snapping", "Terrain snapping")} and{" "}
					{A("dem-anchoring", "DEM anchoring")} use it too.
				</p>
				<h3>Code</h3>
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/geo/terrain.ts" />
					<CodeRef path="src/lib/dem/sources.ts" />
					<CodeRef path="src/lib/dem/tiles.ts" />
					<CodeRef path="src/lib/dem/load.ts" />
					<CodeRef path="src/lib/dem/decode.ts" />
					<CodeRef path="src/lib/deck-webgpu/terrain.ts" />
				</div>
			</Details>
		</>
	);
}
