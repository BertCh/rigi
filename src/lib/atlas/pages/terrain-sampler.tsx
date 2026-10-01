import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	Callout,
	CodeRef,
	Figure,
	Flow,
	Measured,
	Plot,
	Steps,
	useTime,
} from "#/components/atlas/viz";
import {
	Beat,
	Details,
	Key,
	Mark,
	MarkList,
	Numbers,
	Trio,
} from "#/components/atlas/viz/explain";
import type { AtlasNode } from "#/lib/atlas/types";

// TerrainSampler: heightAt(lat, lon) over a pile of tiles. Everything below is the real logic of
//   src/lib/geo/terrain.ts (sample / sampleAt / pixel / loadTerrain), src/lib/dem/sources.ts (MAPTERHORN.levels,
//   tileSize 512, maxZoom 17), src/lib/dem/tiles.ts (lonLatToTile, tilesAround), src/lib/dem/load.ts (fetchDemBytes).
// Per-level metres/pixel come from the tile-size formula at the demo camera's latitude; the tile counts, the
// seam patch and the level-vs-level height errors are MEASURED by scripts/atlas/data-terrain.ts (Mapterhorn
// tiles around the Niederhorn demo camera, run through the real TerrainSampler) and loaded from
// /demo/atlas/terrain/terrain.json.

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
	const [ref, t] = useTime<HTMLDivElement>(5);
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
				className="flex flex-wrap items-center justify-center gap-x-8 gap-y-5"
			>
				<svg
					viewBox="0 0 340 340"
					className="block h-auto w-full max-w-[340px] touch-pan-y rounded-xl"
					role="img"
					aria-label="Concentric tile-level rings around the camera with a probe showing which level answered"
					onPointerMove={onMove}
					onPointerLeave={() => setManual(null)}
				>
					<defs>
						<pattern
							id="ts-miss"
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
								stroke="var(--rigi-trap)"
								strokeWidth="1.4"
								strokeOpacity="0.75"
							/>
						</pattern>
					</defs>
					{[...LEVELS].reverse().map((l, ri) => {
						const i = LEVELS.length - 1 - ri;
						const on = i === hit;
						return (
							<g key={l.z}>
								<circle
									cx={CX}
									cy={CY}
									r={rOf(l.maxDistance)}
									fill="var(--accent)"
									fillOpacity={
										0.05 + 0.06 * (LEVELS.length - i) * 0.6 + (on ? 0.12 : 0)
									}
									stroke="var(--accent)"
									strokeOpacity={on ? 0.9 : 0.35}
									strokeWidth={on ? 1.6 : 0.8}
								/>
								{missing[i] && (
									<circle
										cx={CX}
										cy={CY}
										r={rOf(l.maxDistance)}
										fill="url(#ts-miss)"
									/>
								)}
							</g>
						);
					})}
					{/* the finer rings are painted over by coarser fills only where they overlap; re-stroke labels on top */}
					{LEVELS.map((l, i) => (
						<text
							key={l.z}
							x={CX}
							y={CY - rOf(l.maxDistance) + 10}
							textAnchor="middle"
							className="font-mono"
							fontSize="8.5"
							fill={i === hit ? "var(--accent)" : "rgba(236,230,218,.5)"}
						>
							z{l.z}
						</text>
					))}
					{/* probe ray */}
					<line
						x1={CX}
						y1={CY}
						x2={px}
						y2={py}
						stroke="var(--rigi-paper)"
						strokeOpacity="0.55"
						strokeDasharray="3 3"
					/>
					<circle cx={CX} cy={CY} r="3.5" fill="var(--rigi-paper)" />
					<circle
						cx={px}
						cy={py}
						r="9"
						fill="var(--accent)"
						fillOpacity="0.25"
					/>
					<circle
						cx={px}
						cy={py}
						r="3.6"
						fill={hit < 0 ? "var(--rigi-trap)" : "var(--accent)"}
						stroke="var(--rigi-paper)"
						strokeWidth="1.2"
					/>
					<text
						x={CX + 6}
						y={CY + 14}
						className="font-mono"
						fontSize="8.5"
						fill="rgba(236,230,218,.6)"
					>
						camera
					</text>
				</svg>

				<div className="min-w-[250px] flex-1 font-mono text-[11.5px]">
					<div className="mb-3 rounded-lg bg-white/[0.04] p-3 ring-1 ring-white/10">
						<div className="flex items-baseline justify-between text-white/55">
							<span>distance</span>
							<span className="text-[var(--rigi-paper)]">{fmtM(p.d)}</span>
						</div>
						<div className="mt-1 flex items-baseline justify-between text-white/55">
							<span>band picks</span>
							<span className="text-[var(--rigi-paper)]">
								z{LEVELS[start].z}
							</span>
						</div>
						<div className="mt-1 flex items-baseline justify-between text-white/55">
							<span>answered by</span>
							<span
								className={
									hit < 0 ? "text-[var(--rigi-trap)]" : "text-[var(--accent)]"
								}
							>
								{hit < 0
									? "NaN (nothing loaded)"
									: `z${LEVELS[hit].z} · ${fmtRes(mpp(LEVELS[hit].z))} m/px`}
							</span>
						</div>
						{fellBack && (
							<div className="mt-1 text-[10.5px] text-white/45">
								z{LEVELS[start].z} {missing[start] ? "missing" : "n/a"}
								{hit >= 0
									? ` → fell back ${hit - start} level${hit - start > 1 ? "s" : ""} coarser`
									: " → ran out of levels"}
							</div>
						)}
					</div>
					<div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-3 gap-y-1.5 text-white/55">
						<span className="text-white/35">level</span>
						<span className="text-white/35">band</span>
						<span className="text-white/35">m/px</span>
						<span className="text-white/35">tiles</span>
						{LEVELS.map((l, i) => (
							<button
								key={l.z}
								type="button"
								onClick={() => toggle(i)}
								aria-pressed={missing[i]}
								className="col-span-4 grid grid-cols-subgrid items-center rounded px-1.5 py-1 text-left transition hover:bg-white/[0.06]"
								style={{
									background:
										i === hit
											? "color-mix(in srgb, var(--accent) 16%, transparent)"
											: undefined,
									textDecoration: missing[i] ? "line-through" : undefined,
									color: i === hit ? "var(--rigi-paper)" : undefined,
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
					<p className="mt-2 text-[10.5px] text-white/35">
						{TOTAL_TILES} tiles for a full load here. Click a row to remove a
						level.
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

function BilinearProbe({ data }: { data: TerrainData | null }) {
	const GRID =
		data?.seam.heights ??
		Array.from({ length: GH }, () => Array.from({ length: GW }, () => 0));
	const HMIN = Math.min(...GRID.flat());
	const HMAX = Math.max(...GRID.flat());
	const [ref, t] = useTime<HTMLDivElement>(3);
	const [manual, setManual] = useState<{ u: number; v: number } | null>(null);
	const [bGone, setBGone] = useState(false);

	const auto = {
		u: 3 + 2.3 * Math.sin(0.5 * t + 1),
		v: 2.5 + 1.7 * Math.sin(0.37 * t),
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
			v: (((e.clientY - b.top) / b.height) * (GH * CELL + 2 * OY) - OY) / CELL,
		});
	}

	return (
		<Figure
			label="Blend"
			bleed
			caption={
				<>
					Blend the four nearest pixels, each weighted by the area opposite it.
					A corner in an unloaded tile makes the whole answer a hole.{" "}
					<Measured data={data} />
				</>
			}
		>
			<div
				ref={ref}
				className="flex flex-wrap items-center justify-center gap-x-8 gap-y-5"
			>
				<svg
					viewBox={`0 0 ${GW * CELL + 2 * OX} ${GH * CELL + 2 * OY}`}
					className="block h-auto w-full max-w-[360px] touch-pan-y rounded-xl"
					role="img"
					aria-label="A height grid with a probe and the four pixels a bilinear sample blends"
					onPointerMove={onMove}
					onPointerLeave={() => setManual(null)}
				>
					<defs>
						<pattern
							id="ts-hatch"
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
								stroke="var(--rigi-trap)"
								strokeWidth="1.2"
								strokeOpacity="0.6"
							/>
						</pattern>
					</defs>
					{GRID.flatMap((row, gy) =>
						row.map((h, gx) => ({ h, gx, gy, id: `cell${gx}x${gy}` })),
					).map(({ h, gx, gy, id }) => {
						const k = HMAX > HMIN ? (h - HMIN) / (HMAX - HMIN) : 0;
						const gone = bGone && gx >= SEAM;
						return (
							<g key={id}>
								<rect
									x={OX + gx * CELL}
									y={OY + gy * CELL}
									width={CELL}
									height={CELL}
									fill="var(--accent)"
									fillOpacity={gone ? 0.02 : 0.06 + 0.4 * k}
									stroke="rgba(236,230,218,.12)"
								/>
								{gone && (
									<rect
										x={OX + gx * CELL}
										y={OY + gy * CELL}
										width={CELL}
										height={CELL}
										fill="url(#ts-hatch)"
									/>
								)}
								<text
									x={cx(gx)}
									y={cy(gy) + 14}
									textAnchor="middle"
									className="font-mono"
									fontSize="9"
									fill="rgba(236,230,218,.55)"
								>
									{gone ? "NaN" : h}
								</text>
							</g>
						);
					})}
					{/* area weights: each corner owns the rectangle opposite the probe */}
					{corner.map((c) => {
						const ox = c.gx === x0 ? cx(x0 + 1) : cx(x0);
						const oy = c.gy === y0 ? cy(y0 + 1) : cy(y0);
						const xa = Math.min(sx, ox);
						const ya = Math.min(sy, oy);
						return (
							<rect
								key={`c${c.gx}-${c.gy}`}
								x={xa}
								y={ya}
								width={Math.abs(sx - ox)}
								height={Math.abs(sy - oy)}
								fill="var(--rigi-paper)"
								fillOpacity={0.05 + 0.2 * c.w}
								stroke="var(--rigi-paper)"
								strokeOpacity="0.35"
								strokeDasharray="2 3"
							/>
						);
					})}
					{/* tile seam */}
					<line
						x1={OX + SEAM * CELL}
						x2={OX + SEAM * CELL}
						y1={OY - 6}
						y2={OY + GH * CELL + 6}
						stroke="var(--rigi-paper)"
						strokeOpacity="0.5"
						strokeWidth="1.4"
						strokeDasharray="5 3"
					/>
					<text
						x={OX + SEAM * CELL - 4}
						y={OY + GH * CELL + 12}
						textAnchor="end"
						className="font-mono"
						fontSize="8"
						fill="rgba(236,230,218,.45)"
					>
						tile A
					</text>
					<text
						x={OX + SEAM * CELL + 4}
						y={OY + GH * CELL + 12}
						className="font-mono"
						fontSize="8"
						fill="rgba(236,230,218,.45)"
					>
						tile B
					</text>
					{/* the four pixel centres and the probe */}
					{corner.map((c) => (
						<circle
							key={`c${c.gx}-${c.gy}`}
							cx={cx(c.gx)}
							cy={cy(c.gy)}
							r="3.2"
							fill="var(--accent)"
							stroke="var(--rigi-paper)"
							strokeWidth="1"
						/>
					))}
					<circle
						cx={sx}
						cy={sy}
						r="8"
						fill={bad ? "var(--rigi-trap)" : "var(--accent)"}
						fillOpacity="0.28"
					/>
					<circle
						cx={sx}
						cy={sy}
						r="3.4"
						fill={bad ? "var(--rigi-trap)" : "var(--rigi-paper)"}
					/>
				</svg>

				<div className="min-w-[240px] flex-1 font-mono text-[11.5px] text-white/55">
					<div className="rounded-lg bg-white/[0.04] p-3 ring-1 ring-white/10">
						<div className="flex justify-between">
							<span>px, py</span>
							<span className="text-[var(--rigi-paper)]">
								{px.toFixed(2)}, {py.toFixed(2)}
							</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>fx, fy</span>
							<span className="text-[var(--rigi-paper)]">
								{fx.toFixed(2)}, {fy.toFixed(2)}
							</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>top / bottom blend</span>
							<span className="text-[var(--rigi-paper)]">
								{Number.isNaN(top) ? "NaN" : top.toFixed(1)} /{" "}
								{Number.isNaN(bot) ? "NaN" : bot.toFixed(1)}
							</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>bilinear</span>
							<span
								className={
									bad ? "text-[var(--rigi-trap)]" : "text-[var(--accent)]"
								}
							>
								{bad ? "NaN, ask the coarser level" : `${res.toFixed(1)} m`}
							</span>
						</div>
						<div className="mt-1 flex justify-between text-white/35">
							<span>nearest pixel would say</span>
							<span>{Number.isNaN(nearest) ? "NaN" : `${nearest} m`}</span>
						</div>
						{data && (
							<div className="mt-1 flex justify-between border-white/10 border-t pt-1 text-white/55">
								<span>
									TerrainSampler.sample at (
									{(data.seam.seamAtCol - 1 + data.seam.fx + 0.5).toFixed(1)},{" "}
									{(2 + data.seam.fy + 0.5).toFixed(1)})
								</span>
								<span className="text-[var(--rigi-paper)]">
									{data.seam.sampled.toFixed(2)} m
								</span>
							</div>
						)}
					</div>
					<div className="mt-3 flex items-center gap-2">
						<button
							type="button"
							aria-pressed={bGone}
							onClick={() => setBGone((v) => !v)}
							className="rounded-md px-2.5 py-1 text-[11px] ring-1 ring-white/15 transition hover:bg-white/[0.07]"
							style={{
								background: bGone
									? "color-mix(in srgb, var(--rigi-trap) 22%, transparent)"
									: undefined,
								color: "var(--rigi-paper)",
							}}
						>
							{bGone ? "tile B not loaded" : "tile B loaded"}
						</button>
						<span className="text-[10.5px] text-white/35">
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
								className="rounded-md px-2.5 py-1 text-[11px] ring-1 ring-white/15 transition hover:bg-white/[0.07]"
							>
								measured point
							</button>
						)}
					</div>
					<div className="mt-3 flex gap-1.5" aria-hidden>
						{corner.map((c) => (
							<div
								key={`c${c.gx}-${c.gy}`}
								className="h-1.5 rounded-full bg-[var(--accent)]"
								style={{
									width: `${Math.max(2, c.w * 100)}%`,
									opacity: 0.4 + 0.6 * c.w,
								}}
							/>
						))}
					</div>
					<p className="mt-1 text-[10.5px] text-white/35">
						the four weights, summing to 1
					</p>
				</div>
			</div>
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
			<Figure label="Fig. 3" bleed caption="Loading the measured transect.">
				<div className="aspect-[2/1] animate-pulse rounded-xl bg-white/[0.04]" />
			</Figure>
		);
	const zs = Object.keys(tr.mapterhorn).map(Number);
	const ref = tr.mapterhorn["15"];
	const idx = tr.d.map((_, i) => i).filter((i) => tr.d[i] <= 12000);
	const km = tr.d.map((m) => m / 1000);
	const colors: Record<number, string> = {
		15: "#8fc08a",
		14: "#b6d98a",
		12: "#e0c565",
		11: "#e09a65",
		10: "#e07a7a",
		9: "#c58be0",
	};
	const err = (z: number) =>
		idx.map((i) => tr.mapterhorn[String(z)][i] - ref[i]);
	const worst = (z: number) => Math.max(...err(z).map(Math.abs));
	const picked = idx.map((i) => tr.mapterhornAt[i] - ref[i]);
	return (
		<Figure
			label="Fig. 3"
			bleed
			caption={
				<>
					White: what we answer along a real 12 km line, as height minus the
					finest map&rsquo;s. Violet: the coarsest map used everywhere.{" "}
					<Measured data={data} />
				</>
			}
		>
			<Plot
				x={[0, 12]}
				y={[-60, 60]}
				width={620}
				height={260}
				xLabel="distance from camera (km)"
				yLabel="level minus z15 (m)"
				fmtX={(v) => v.toFixed(0)}
				fmtY={(v) => v.toFixed(0)}
			>
				{(s) => (
					<>
						{LEVELS.slice(0, 3).map((l) => (
							<line
								key={l.z}
								x1={s.x(l.maxDistance / 1000)}
								x2={s.x(l.maxDistance / 1000)}
								y1={s.box.y0}
								y2={s.box.y1}
								stroke="white"
								strokeOpacity={0.18}
								strokeDasharray="3 3"
							/>
						))}
						{zs
							.filter((z) => z === 9)
							.map((z) => (
								<path
									key={z}
									d={s.line(
										idx.map((i) => [
											km[i],
											tr.mapterhorn[String(z)][i] - ref[i],
										]),
									)}
									fill="none"
									stroke={colors[z]}
									strokeWidth={1.2}
									strokeOpacity={0.85}
								/>
							))}
						<path
							d={s.line(idx.map((i, k) => [km[i], picked[k]]))}
							fill="none"
							stroke="var(--rigi-paper)"
							strokeWidth={2}
						/>
					</>
				)}
			</Plot>
			<div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-white/60">
				{zs
					.filter((z) => z !== 15)
					.map((z) => (
						<span key={z}>
							<span style={{ color: colors[z] }}>z{z}</span> worst{" "}
							{worst(z).toFixed(0)} m
						</span>
					))}
			</div>
			<p className="mt-2 text-[12.5px] text-white/55">
				<Key color="var(--rigi-paper)">answer</Key>{" "}
				<Key color="#c58be0">coarsest everywhere</Key>. Dashed lines: band edges
				at 1, 2.5 and 6 km.
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
	const box = d?.box;
	const row = box?.profile.mapterhorn;
	if (!d || !box || !row)
		return (
			<Figure label="Fig. 1" caption="Loading measured data.">
				<div className="aspect-square animate-pulse rounded-xl bg-white/[0.04]" />
			</Figure>
		);
	const cell = box.cellM;
	const y = box.profile.row + 0.5;
	const cam = d.eyes[0].groundMapterhorn;
	const summitX = row.indexOf(Math.max(...row));
	const midX = 150;
	const westX = 20;
	const dist = (x: number, yy: number) =>
		Math.hypot((x + 0.5 - 150) * cell, (150 - yy) * cell);
	const pts = [
		{ n: 1, x: 150, y: 150, h: cam, t: "Under the camera" },
		{ n: 2, x: summitX + 0.5, y, h: row[summitX], t: "The summit" },
		{ n: 3, x: midX + 0.5, y, h: row[midX], t: "North of the camera" },
		{ n: 4, x: westX + 0.5, y, h: row[westX], t: "Down the slope" },
	];
	const drop = cam - row[midX];
	const lo = Math.min(...row) - 40;
	const hi = Math.max(...row) + 40;
	const PX = (v: number) => (v / (row.length - 1)) * 360;
	const PY = (v: number) => 88 - ((v - lo) / (hi - lo)) * 76;
	return (
		<Figure
			label="Fig. 1"
			caption={
				<>
					The ground falls {drop.toFixed(0)} m within {dist(midX, y).toFixed(0)}{" "}
					m north of the camera. <Measured data={d} />
				</>
			}
		>
			<div className="mx-auto max-w-[560px]">
				<svg
					viewBox="0 0 300 300"
					className="block h-auto w-full overflow-hidden rounded-xl"
					role="img"
					aria-label="Hillshade of the Niederhorn ridge with four height questions marked"
				>
					<image
						href="/demo/atlas/terrain/hs-mapterhorn.jpg"
						width={300}
						height={300}
						preserveAspectRatio="none"
					/>
					<line
						x1={0}
						x2={300}
						y1={y}
						y2={y}
						stroke="#ece6da"
						strokeOpacity={0.55}
						strokeDasharray="4 4"
					/>
					{pts.map((p) => (
						<Mark key={p.n} x={p.x} y={p.y} n={p.n} k={0.75} />
					))}
				</svg>
				<svg
					viewBox="0 0 360 100"
					className="mt-3 block h-auto w-full"
					role="img"
					aria-label="Ground height along the dashed line, west to east"
				>
					<path
						d={`M0 100L${row.map((v, x) => `${PX(x).toFixed(1)} ${PY(v).toFixed(1)}`).join("L")}L360 100Z`}
						fill="var(--accent)"
						fillOpacity={0.2}
					/>
					<path
						d={`M${row.map((v, x) => `${PX(x).toFixed(1)} ${PY(v).toFixed(1)}`).join("L")}`}
						fill="none"
						stroke="var(--accent)"
						strokeWidth={1.6}
					/>
					{pts.slice(1).map((p) => (
						<Mark key={p.n} x={PX(p.x - 0.5)} y={PY(p.h)} n={p.n} k={1.1} />
					))}
				</svg>
				<p className="mt-1 text-[12.5px] text-white/55">
					Height along the dashed line, west to east (170 m north of the
					camera).
				</p>
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
		return <div className="aspect-[4/3] animate-pulse bg-white/[0.04]" />;
	const x = (m: number) =>
		10 + ((Math.log10(Math.max(m, 100)) - 2) / (Math.log10(160_000) - 2)) * 280;
	return (
		<svg
			viewBox="0 0 300 130"
			className="block h-auto w-full"
			role="img"
			aria-label="Six distance bands, each with its own tile zoom"
		>
			{lv.map((l, i) => {
				const x0 = i === 0 ? x(100) : x(lv[i - 1].to);
				const x1 = x(l.to);
				return (
					<g key={l.z}>
						<rect
							x={x0 + 1}
							y={30 + i * 3}
							width={Math.max(2, x1 - x0 - 2)}
							height={50 - i * 3}
							rx="3"
							fill="var(--accent)"
							fillOpacity={0.15 + i * 0.12}
						/>
						<text
							x={(x0 + x1) / 2}
							y={96}
							textAnchor="middle"
							fontSize="8"
							fill="rgba(236,230,218,.7)"
							fontFamily="ui-monospace, monospace"
						>
							z{l.z}
						</text>
						<text
							x={(x0 + x1) / 2}
							y={108}
							textAnchor="middle"
							fontSize="6.5"
							fill="rgba(236,230,218,.45)"
							fontFamily="ui-monospace, monospace"
						>
							{l.mPerPx.toFixed(l.mPerPx < 10 ? 1 : 0)} m
						</text>
					</g>
				);
			})}
			<text
				x="10"
				y="18"
				fontSize="8"
				fill="rgba(236,230,218,.55)"
				fontFamily="ui-monospace, monospace"
			>
				near
			</text>
			<text
				x="290"
				y="18"
				textAnchor="end"
				fontSize="8"
				fill="rgba(236,230,218,.55)"
				fontFamily="ui-monospace, monospace"
			>
				far
			</text>
		</svg>
	);
}

/** Bilinear in small: the real 2 x 2 pixels around the measured seam probe. */
function BlendMini({ d }: { d: TerrainData | null }) {
	const s = d?.seam;
	if (!s) return <div className="aspect-[4/3] animate-pulse bg-white/[0.04]" />;
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
						<rect
							x={O + i * C}
							y={15 + j * C}
							width={C}
							height={C}
							fill="var(--accent)"
							fillOpacity={0.12 + 0.1 * (i + j)}
							stroke="rgba(236,230,218,.2)"
						/>
						<text
							x={O + i * C + 4}
							y={15 + j * C + 12}
							fontSize="8.5"
							fill="rgba(236,230,218,.7)"
							fontFamily="ui-monospace, monospace"
						>
							{v.toFixed(1)}
						</text>
					</g>
				)),
			)}
			<circle
				cx={px}
				cy={py}
				r="5"
				fill="#ece6da"
				stroke="#0e1012"
				strokeWidth="1.5"
			/>
			<text
				x={O + 2 * C + 16}
				y={75}
				fontSize="9"
				fill="rgba(236,230,218,.6)"
				fontFamily="ui-monospace, monospace"
			>
				answer
			</text>
			<text
				x={O + 2 * C + 16}
				y={90}
				fontSize="11"
				fill="var(--accent)"
				fontFamily="ui-monospace, monospace"
			>
				{s.sampled.toFixed(2)} m
			</text>
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
			<defs>
				<pattern
					id="ts-mini-miss"
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
						stroke="var(--rigi-trap)"
						strokeWidth="1.4"
						strokeOpacity="0.8"
					/>
				</pattern>
			</defs>
			<rect
				x="30"
				y="30"
				width="60"
				height="60"
				rx="4"
				fill="var(--accent)"
				fillOpacity={0.12}
				stroke="var(--accent)"
				strokeOpacity={0.5}
				strokeDasharray="3 3"
			/>
			<rect
				x="30"
				y="30"
				width="60"
				height="60"
				rx="4"
				fill="url(#ts-mini-miss)"
			/>
			<text
				x="60"
				y="108"
				textAnchor="middle"
				fontSize="8"
				fill="rgba(236,230,218,.6)"
				fontFamily="ui-monospace, monospace"
			>
				fine tile missing
			</text>
			<path d="M96 60h30" stroke="var(--accent)" strokeWidth="1.6" />
			<path d="M134 60l-8 -4.5v9z" fill="var(--accent)" />
			<rect
				x="140"
				y="20"
				width="120"
				height="80"
				rx="4"
				fill="var(--accent)"
				fillOpacity={0.5}
			/>
			<text
				x="200"
				y="64"
				textAnchor="middle"
				fontSize="9"
				fill="#0e1012"
				fontFamily="ui-monospace, monospace"
			>
				coarser tile
			</text>
		</svg>
	);
}

export default function Page({ node }: { node: AtlasNode }) {
	void node;
	const data = useTerrainData();
	const cost = costNumbers(data);
	const lv = data?.levels.mapterhorn;
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
			<AskTheMap d={data} />

			<Beat
				kicker="The idea"
				title="One question, asked millions of times: how high is the ground here?"
			>
				<p>
					Give it a spot and how far that spot is from the camera. It answers in
					metres.
				</p>
				<p>
					Near spots read a sharp map. Far spots read a coarse one. That keeps
					the answer fast and the nearby detail intact.
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

			<Beat
				kicker="Where it errs"
				title={
					cost
						? `The coarsest map alone is off by up to ${cost.coarse.toFixed(0)} m. The band rule keeps it to ${cost.picked.toFixed(0)} m.`
						: "Coarse maps are cheap but can be off by tens of metres."
				}
			>
				<p>
					Sharp tiles near us, coarse tiles far away. That caps the error
					without loading every tile sharp.
				</p>
				<p>At sea the map reads 0 m, so a coast looks like sea level.</p>
			</Beat>

			<LevelCost data={data} />

			<Numbers
				items={[
					{
						value: lv ? String(lv.length) : "…",
						label: "maps, sharpest to coarsest",
					},
					{
						value: lv
							? `${lv[0].mPerPx.toFixed(1)} → ${Math.round(lv[lv.length - 1].mPerPx)} m`
							: "…",
						label: "pixel width, near to far, at the Niederhorn camera",
					},
					{
						value: lv ? String(lv.reduce((a, l) => a + l.tiles, 0)) : "…",
						label: "tiles for one full load there",
					},
					{
						value: cost ? `${cost.picked.toFixed(0)} m` : "…",
						label: "worst error of the band rule within 12 km",
					},
				]}
				source={
					<>
						Measured by scripts/atlas/data-terrain.ts: Mapterhorn tiles run
						through the real sampler.
					</>
				}
			/>

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next: the {A("dem-horizon", "DEM horizon")} asks this question along
				every ray. The tiles come from the {A("dem-source", "DEM source")}.
			</p>

			<Details>
				<h3>The contract</h3>
				<p>
					Everything that needs ground truth on the CPU (the horizon ray march,
					peak visibility, the solvers) asks the same question: how high is the
					terrain at this longitude and latitude, seen from a camera this far
					away? <code>TerrainSampler</code> answers it from a stack of preloaded
					tiles at several zoom levels. It does no I/O of its own: tiles arrive
					as decoded <code>Float32Array</code> heights, so the same class runs
					in the page, in workers and in Node scripts.
				</p>
				<p>
					The Mapterhorn level table pairs a zoom with a{" "}
					<code>maxDistance</code>: z15 to 1 km, z14 to 2.5 km, z12 to 6 km, z11
					to 15 km, z10 to 40 km, z9 to 150 km. Because Mapterhorn tiles are 512
					px, each zoom matches a 256 px tile one level deeper, so the table
					sits one zoom below the Terrarium default (z13 / 11 / 10 at 4 / 40 /
					150 km) with two finer near-field levels on top. See{" "}
					{A("dem-source", "DEM Source")}.
				</p>
				<p>
					<code>sampleAt</code> finds the first level whose band contains the
					distance, and if that level has no data at the point it walks outward
					through the coarser ones. That is what lets the finest zoom exist only
					where a national lidar DEM does.
				</p>
				<BilinearProbe data={data} />
				<h3>From a GPS fix to a ready sampler</h3>
				<Steps
					steps={[
						{
							title: "Plan the tiles",
							body: (
								<>
									<code>loadTerrain(lat, lon, loadTile, levels)</code> asks{" "}
									<code>tilesAround</code> for every tile at every level that
									touches a circle of that level&rsquo;s{" "}
									<code>maxDistance</code>. Tiles already in the shared{" "}
									<code>Map</code> are filtered out, so a second call near the
									same spot only loads the difference.
								</>
							),
						},
						{
							title: "Load in batches, check the size",
							body: (
								<>
									Tiles load 16 at a time through the injected loader (browser
									or Node). A tile whose length is not <code>tileSize²</code>{" "}
									throws: a wrong size would silently scramble heights, so it
									fails loudly. A loader that returns <code>undefined</code>{" "}
									just leaves a hole.
								</>
							),
						},
						{
							title: "Where a tile does not exist",
							body: (
								<>
									The page-side loader, <code>fetchDemBytes</code>, goes the
									other way: a 404 or 204 is remembered for the session, and the
									request walks up the pyramid to the nearest ancestor that
									exists. <code>ancestorCrop</code> upsamples that
									ancestor&rsquo;s quadrant to full tile size, so the sampler
									still sees a normal tile.
								</>
							),
						},
						{
							title: "Sample",
							body: (
								<>
									<code>sample</code> converts to fractional tile pixels,
									offsets by half a pixel, and does the bilinear blend.{" "}
									<code>pixel</code> finds the right tile even when the four
									corners straddle a seam. Any missing corner gives NaN, and{" "}
									<code>sampleAt</code> moves on to the next level.
								</>
							),
						},
					]}
				/>
				<Flow
					nodes={[
						{ label: "tilesAround", sub: "per level, per radius" },
						{ label: "loadTile", sub: "×16, size-checked" },
						{ label: "Map<z/x/y>", sub: "Float32Array heights" },
						{ label: "sampleAt", sub: "band → bilinear → coarser" },
					]}
				/>
				<p>
					Sea is clamped to 0 at decode (src/lib/dem/decode.ts), so a coast
					reads as sea level, not bathymetry. Tile size 512 px, z17 deepest; 16
					tiles fetched in parallel (src/lib/geo/terrain.ts).
				</p>
				<Callout tone="note" title="Same tile policy, CPU read side">
					The 3D mesh (<code>src/lib/terrain.ts</code>) loads Mapterhorn through
					the same <code>fetchDemBytes</code> policy as the CPU sampler, so both
					see the same ancestor fallback. The sampler is the synchronous read
					side: plain arrays, no GPU round trip.
				</Callout>
				<h3>Where it fits</h3>
				<p>
					<code>ground()</code> gives the camera&rsquo;s own elevation, and the
					ray march in {A("dem-horizon", "the DEM horizon")} calls{" "}
					<code>sampleAt</code> along every azimuth, which the{" "}
					{A("viewport-inference", "viewport solver")} matches against the
					photo&rsquo;s skyline. {A("terrain-snapping", "Terrain snapping")} and{" "}
					{A("dem-anchoring", "DEM anchoring")} read it too.
				</p>
				<h3>Code</h3>
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/geo/terrain.ts" />
					<CodeRef path="src/lib/dem/sources.ts" />
					<CodeRef path="src/lib/dem/tiles.ts" />
					<CodeRef path="src/lib/dem/load.ts" />
					<CodeRef path="src/lib/dem/decode.ts" />
					<CodeRef path="src/lib/terrain.ts" />
				</div>
				<p className="font-mono text-[12.5px] text-white/55">
					TerrainSampler.sample, sampleAt, ground, pixel, loadTerrain,
					TERRAIN_LEVELS, MAPTERHORN.levels, tilesAround, lonLatToTile,
					fetchDemBytes, ancestorCrop, decodeTerrarium
				</p>
			</Details>
		</>
	);
}
