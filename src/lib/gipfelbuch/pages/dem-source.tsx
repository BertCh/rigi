// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useEffect, useState } from "react";
import {
	CircledKey,
	CircledNumber,
	HandMark,
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
	PenDimension,
	PenLine,
	SketchPath,
	SketchPolyline,
	SketchRect,
	Stipple,
} from "#/components/gipfelbuch/notebook/Ink";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import {
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
	Compare,
	Details,
	Key,
	Numbers,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { PlotSeries } from "#/components/gipfelbuch/viz/Plot";
import { MAPTERHORN, TERRARIUM_AWS } from "#/lib/dem/sources";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";
import { publicUrl } from "#/lib/public-url";

// Terrain model: height tiles (MAPTERHORN / TERRARIUM_AWS in src/lib/dem/sources.ts) and the one lookup over them
//   (TerrainSampler in src/lib/geo/terrain.ts). Level tile counts, the seam patch, the transects and the per-camera
//   ground heights are MEASURED by scripts/gipfelbuch/data-terrain.ts and loaded from /demo/gipfelbuch/terrain/terrain.json.
const TERRA = "var(--gb-red)";
const MAP = "var(--gb-forest)";
const rectPath = (x: number, y: number, w: number, h: number) =>
	`M${x} ${y}H${x + w}V${y + h}H${x}Z`;
/** Real DEM facts from scripts/gipfelbuch/data-terrain.ts (Niederhorn, demo-01 camera). */
type Level = {
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
	levels: { terrarium: Level[]; mapterhorn: Level[] };
	rgb: {
		source: string;
		tile: string;
		px: number;
		py: number;
		rgb: [number, number, number];
		height: number;
	}[];
	box: {
		halfM: number;
		px: number;
		osmSummit: { name: string; ele: number | null };
		profile: { northM: number; terrarium: number[]; mapterhorn: number[] };
		terrarium: {
			z: number;
			nativeMPerPx: number;
			max: number;
			slopeP90: number;
		};
		mapterhorn: {
			z: number;
			nativeMPerPx: number;
			max: number;
			slopeP90: number;
		};
		meanAbsDiff: number;
		maxAbsDiff: number;
	};
	transect: {
		bearing: number;
		step: number;
		d: number[];
		terrarium: Record<string, number[]>;
		mapterhorn: Record<string, number[]>;
		mapterhornAt: number[];
	};
	seam: {
		seamAtCol: number;
		heights: number[][];
		fx: number;
		fy: number;
		sampled: number;
	};
	coverage: { name: string; finest: number }[];
	eyes: { id: string; groundTerrarium: number; groundMapterhorn: number }[];
};
let terrainCache: Promise<TerrainData> | null = null;
function useTerrainData() {
	const [d, setD] = useState<TerrainData | null>(null);
	useEffect(() => {
		let live = true;
		terrainCache ??= fetch(
			publicUrl("/demo/gipfelbuch/terrain/terrain.json"),
		).then((r) => {
			if (!r.ok) throw new Error(`terrain.json ${r.status}`);
			return r.json();
		});
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
const fmt = (v: number, n = 0) =>
	v.toLocaleString("en-US", {
		minimumFractionDigits: n,
		maximumFractionDigits: n,
	});

// Label sizes in viewBox units, for 11 to 13 px rendered: the hero figure draws at about 640 px
// (360-wide viewBox), the ladder at about 900 px (600-wide viewBox), the bar chart at about 900 px (720-wide).
const HERO_LABEL = 6.5;
const BAR_LABEL = 9.5;
const LEVELS = MAPTERHORN.levels;
const TILE = MAPTERHORN.tileSize;
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
/* ---------- Hero: the wipe, on real hillshades ---------- */
function Hero({ d }: { d: TerrainData | null }) {
	const box = d?.box;
	const pf = box?.profile;
	const all = pf ? [...pf.terrarium, ...pf.mapterhorn] : [0, 1];
	const lo = Math.min(...all);
	const hi = Math.max(...all);
	const X = (x: number, n: number) => (x / (n - 1)) * 360;
	const Y = (v: number) => 74 - ((v - lo) / (hi - lo || 1)) * 62;
	const line = (a: number[]): [number, number][] =>
		a.map((v, x) => [X(x, a.length), Y(v)]);
	const gap = box ? box.mapterhorn.max - box.terrarium.max : null;
	const topAt = (a: number[] | undefined) =>
		a ? a.indexOf(Math.max(...a)) : 0;
	return (
		<Figure
			plate
			label="Fig. 1"
			caption={
				<>
					{gap == null
						? "Terrarium rounds the summit low."
						: `Terrarium rounds the summit ${gap.toFixed(0)} m low.`}{" "}
					{box?.osmSummit.ele != null &&
						`OpenStreetMap lists it at ${fmt(box.osmSummit.ele)} m.`}
				</>
			}
		>
			<Compare
				beforeLabel="Terrarium"
				afterLabel="Mapterhorn"
				start={0.5}
				className="mx-auto max-w-[640px] overflow-hidden"
				before={
					<img
						src={publicUrl("/demo/gipfelbuch/terrain/hs-terrarium.jpg")}
						alt="Terrarium hillshade of the Niederhorn ridge"
						className="block aspect-square w-full object-cover"
						draggable={false}
					/>
				}
				after={
					<img
						src={publicUrl("/demo/gipfelbuch/terrain/hs-mapterhorn.jpg")}
						alt="Mapterhorn hillshade of the same ridge"
						className="block size-full object-cover"
						draggable={false}
					/>
				}
			/>
			{box && pf && (
				<>
					<svg
						viewBox="0 0 360 86"
						className="mx-auto mt-4 block h-auto w-full max-w-[640px]"
						role="img"
						aria-label="West-east height profile through the highest pixel, Terrarium versus Mapterhorn"
					>
						<PencilLayer>
							<PenLine
								seed="dem-hero-top-terr"
								from={[0, Y(box.terrarium.max)]}
								to={[360, Y(box.terrarium.max)]}
								color="ink"
								width={0.7}
							/>
							<PenLine
								seed="dem-hero-top-map"
								from={[0, Y(box.mapterhorn.max)]}
								to={[360, Y(box.mapterhorn.max)]}
								color="ink"
								width={0.7}
							/>
						</PencilLayer>
						<SketchPolyline
							points={line(pf.mapterhorn)}
							seed="dem-hero-mapterhorn"
							data
							color="var(--gb-forest)"
							width={1.5}
						/>
						<SketchPolyline
							points={line(pf.terrarium)}
							seed="dem-hero-terrarium"
							data
							color="var(--gb-red)"
							width={1.7}
						/>
						<HandLabel
							x={4}
							y={82}
							size={HERO_LABEL}
							color="var(--gb-secondary)"
						>
							west
						</HandLabel>
						<HandLabel
							x={356}
							y={82}
							anchor="end"
							size={HERO_LABEL}
							color="var(--gb-secondary)"
						>
							east
						</HandLabel>
						<PenDimension
							seed="dem-hero-gap"
							from={[
								Math.min(
									355,
									X(topAt(pf.mapterhorn), pf.mapterhorn.length) + 4,
								),
								Y(box.terrarium.max),
							]}
							to={[
								Math.min(
									355,
									X(topAt(pf.mapterhorn), pf.mapterhorn.length) + 4,
								),
								Y(box.mapterhorn.max),
							]}
							color="red"
							width={1}
						/>
						<HandText x={6} y={11} size={8} rotate={-1.5} halo={false}>
							a {gap?.toFixed(0)} m pit where the summit should be
						</HandText>
						<HandText x={6} y={24} size={7} color="forest" halo={false}>
							same box, same pixel, different map
						</HandText>
						{/* labels sit left of their own summits (the peaks are near the right edge): Mapterhorn above the line, Terrarium below */}
						<HandLabel
							x={X(topAt(pf.mapterhorn), pf.mapterhorn.length) - 7}
							y={Y(Math.max(...pf.mapterhorn)) - 4}
							anchor="end"
							size={7}
							color="var(--gb-forest)"
						>
							Mapterhorn peaks at {fmt(box.mapterhorn.max)} m
						</HandLabel>
						<HandLabel
							x={X(topAt(pf.terrarium), pf.terrarium.length) - 7}
							y={Y(Math.max(...pf.terrarium)) + 16}
							anchor="end"
							size={7}
							color="var(--gb-red)"
						>
							Terrarium peaks at {fmt(box.terrarium.max)} m
						</HandLabel>
					</svg>
					<p className="mx-auto mt-1 max-w-[640px] text-[13px] gb-secondary">
						<Key color={TERRA}>Terrarium</Key> and{" "}
						<Key color={MAP}>Mapterhorn</Key>, west to east through the highest
						pixel of the 1.2 km box.
					</p>
				</>
			)}
		</Figure>
	);
}

/* ---------- Where they disagree, along a real 12 km line ---------- */
function Disagree({ d }: { d: TerrainData | null }) {
	const tr = d?.transect;
	if (!tr)
		return (
			<Figure caption="Loading…">
				<div className="aspect-[2/1] animate-pulse bg-[var(--gb-paper-deep)]" />
			</Figure>
		);
	const T = tr.terrarium["15"];
	const Mh = tr.mapterhorn["15"];
	const km = tr.d.map((m) => m / 1000);
	const diff = T.map((v, i) => v - Mh[i]);
	let worst = 0;
	diff.forEach((v, i) => {
		if (Math.abs(v) > Math.abs(diff[worst])) worst = i;
	});
	return (
		<Figure
			label="Fig. 2"
			caption={
				<>
					Along 12 km the maps differ by up to{" "}
					{Math.abs(diff[worst]).toFixed(0)} m, at{" "}
					{(tr.d[worst] / 1000).toFixed(1)} km.
				</>
			}
		>
			<Plot
				x={[0, 12]}
				y={[400, 2400]}
				width={560}
				height={200}
				xLabel="distance from camera (km), bearing 150°, over Lake Thun"
				yLabel="height (m)"
				fmtX={(v) => v.toFixed(0)}
				fmtY={(v) => v.toFixed(0)}
			>
				{(s) => (
					<>
						<Hachure
							d={s.area(km.map((x, i) => [x, Mh[i]]))}
							seed="dem-disagree-area"
							color="forest"
							gap={6}
							opacity={0.25}
						/>
						<SketchPath
							d={s.line(km.map((x, i) => [x, Mh[i]]))}
							seed="dem-disagree-mapterhorn"
							data
							color="forest"
							width={1.8}
						/>
						<SketchPath
							d={s.line(km.map((x, i) => [x, T[i]]))}
							seed="dem-disagree-terrarium"
							data
							color="red"
							width={1.2}
							dash="4 3"
						/>
						<HandText
							x={s.x(0.4)}
							y={s.y(2250)}
							size={15}
							color="ink"
							rotate={-2}
						>
							the two maps agree on the shape, not the height
						</HandText>
					</>
				)}
			</Plot>
			<Plot
				x={[0, 12]}
				y={[-80, 80]}
				width={560}
				height={130}
				xLabel="distance from camera (km)"
				yLabel="Terrarium − Mapterhorn (m)"
				fmtX={(v) => v.toFixed(0)}
				fmtY={(v) => v.toFixed(0)}
				yTicks={4}
			>
				{(s) => (
					<>
						<PenLine
							seed="dem-diff-zero"
							data
							from={[s.box.x0, s.y(0)]}
							to={[s.box.x1, s.y(0)]}
							color="pencil"
							width={0.9}
						/>
						<SketchPath
							d={s.line(km.map((x, i) => [x, diff[i]]))}
							seed="dem-diff"
							data
							color="ink"
							width={1.5}
						/>
						<CircledKey
							x={s.x(km[worst]) - 20}
							y={s.y(diff[worst])}
							value={1}
							seed="dem-diff-key"
						/>
						<PenCircle
							seed="dem-diff-worst"
							center={[s.x(km[worst]), s.y(diff[worst])]}
							radiusX={9}
							radiusY={9}
							color="red"
							width={1.3}
						/>
						<HandText
							x={Math.min(s.x(km[worst]) + 28, s.box.x1 - 150)}
							y={s.y(diff[worst]) + (diff[worst] < 0 ? -14 : 24)}
							size={16}
							color="red"
							rotate={-2}
						>
							worst: {diff[worst].toFixed(0)} m at {km[worst].toFixed(1)} km
						</HandText>
						<PenArrow
							seed="dem-diff-worst-arrow"
							from={[
								Math.min(s.x(km[worst]) + 26, s.box.x1 - 152),
								s.y(diff[worst]) + (diff[worst] < 0 ? -18 : 20),
							]}
							to={[
								s.x(km[worst]) + 8,
								s.y(diff[worst]) + (diff[worst] < 0 ? -5 : 5),
							]}
							color="red"
							width={1.1}
						/>
					</>
				)}
			</Plot>
			<p className="mt-1 text-[13px] gb-secondary">
				<Key color={MAP}>Mapterhorn</Key>,{" "}
				<Key color={TERRA} dashed>
					Terrarium
				</Key>
				. At the camera they read {T[0].toFixed(0)} m and {Mh[0].toFixed(0)} m.
			</p>
		</Figure>
	);
}

/* ---------- Ground under each camera: Terrarium minus Mapterhorn ---------- */
function GroundGap({ d }: { d: TerrainData | null }) {
	if (!d) return null;
	const rows = d.eyes.map((e) => ({
		id: e.id,
		gap: e.groundMapterhorn - e.groundTerrarium,
	}));
	const max = Math.max(...rows.map((r) => r.gap));
	const maxAt = rows.findIndex((r) => r.gap === max);
	return (
		<Figure
			label="Fig. 7"
			caption={<>At all 12 cameras, Terrarium puts the ground lower.</>}
		>
			<svg
				viewBox="0 0 720 188"
				className="block h-auto w-full"
				role="img"
				aria-label="Ground height under each demo camera, Mapterhorn minus Terrarium"
			>
				<PenLine
					seed="dem-gap-axis"
					data
					from={[60, 2]}
					to={[60, 186]}
					color="pencil"
					width={1}
				/>
				{rows.map((r, i) => {
					const w = (r.gap / max) * 520;
					const bar = rectPath(60, i * 15 + 5, w, 10);
					return (
						<g key={r.id}>
							<HandLabel
								x={0}
								y={i * 15 + 13}
								size={BAR_LABEL}
								color="var(--gb-pencil)"
							>
								{r.id}
							</HandLabel>
							<Hachure
								d={bar}
								seed={`dem-gap-hatch-${r.id}`}
								color="red"
								gap={3}
								width={0.9}
								opacity={0.8}
							/>
							<SketchPath
								d={bar}
								seed={`dem-gap-bar-${r.id}`}
								data
								color="red"
								width={1.2}
							/>
							<HandLabel
								x={60 + w + 6}
								y={i * 15 + 13}
								size={BAR_LABEL}
								color="var(--gb-ink)"
							>
								{r.gap.toFixed(0)} m
							</HandLabel>
						</g>
					);
				})}
				<HandText x={470} y={150} size={16} color="ink" rotate={-2}>
					Terrarium is lower at every camera
				</HandText>
				<PenArrow
					seed="dem-gap-note-arrow"
					from={[600, 134]}
					to={[60 + (rows[maxAt].gap / max) * 520 - 6, maxAt * 15 + 22]}
					color="ink"
					width={1.1}
				/>
				<PenCircle
					seed="dem-gap-max"
					center={[60 + (rows[maxAt].gap / max) * 520 + 24, maxAt * 15 + 10]}
					radiusX={24}
					radiusY={9}
					color="red"
					width={1.2}
				/>
			</svg>
		</Figure>
	);
}
function BandsMini({ d }: { d: TerrainData | null }) {
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
			aria-label="Distance bands, each with its own tile zoom"
		>
			{lv.map((l, i) => {
				const x0 = i === 0 ? x(100) : x(lv[i - 1].to);
				const x1 = x(l.to);
				const box = rectPath(
					x0 + 1,
					30 + i * 3,
					Math.max(2, x1 - x0 - 2),
					50 - i * 3,
				);
				return (
					<g key={l.z}>
						<Hachure
							d={box}
							seed={`dem-band-${l.z}`}
							color="forest"
							gap={Math.max(2.5, 7 - i)}
							width={0.9}
							opacity={0.85}
						/>
						<SketchPath
							d={box}
							seed={`dem-band-edge-${l.z}`}
							color="forest"
							width={1}
							passes={1}
							tolerance={0.5}
						/>
						<HandLabel
							x={(x0 + x1) / 2}
							y={98}
							anchor="middle"
							size={13}
							color="var(--gb-ink)"
						>
							z{l.z}
						</HandLabel>
						<HandLabel
							x={(x0 + x1) / 2}
							y={113}
							anchor="middle"
							size={11}
							color="var(--gb-secondary)"
						>
							{l.mPerPx.toFixed(l.mPerPx < 10 ? 1 : 0)} m
						</HandLabel>
					</g>
				);
			})}
			<HandLabel x={10} y={19} size={14}>
				near
			</HandLabel>
			<HandLabel x={290} y={19} anchor="end" size={14}>
				far
			</HandLabel>
			<PenArrow
				seed="dem-bands-arrow"
				from={[52, 12]}
				to={[246, 12]}
				color="pencil"
				width={1}
			/>
			<HandText x={150} y={8} anchor="middle" size={11} halo={false}>
				{lv[0].mPerPx} m per pixel, then {lv[lv.length - 1].mPerPx.toFixed(0)} m
			</HandText>
		</svg>
	);
}

function FallbackMini() {
	return (
		<svg
			viewBox="0 0 300 130"
			className="block h-auto w-full"
			role="img"
			aria-label="A missing fine tile falls back to a coarser one"
		>
			<SketchPath
				d={rectPath(30, 30, 60, 60)}
				seed="dem-miss-tile"
				color="forest"
				width={1.2}
				dash="3 3"
			/>
			<Stipple
				d={rectPath(30, 30, 60, 60)}
				seed="dem-miss-fill"
				color="red"
				spacing={6}
				size={1.6}
			/>
			<HandLabel x={60} y={112} anchor="middle" size={14}>
				fine tile missing
			</HandLabel>
			<HandText x={60} y={66} anchor="middle" size={15} color="red" rotate={-3}>
				no data
			</HandText>
			<HandText x={117} y={46} anchor="middle" size={12} rotate={-2}>
				tries the next coarser tile
			</HandText>
			<PenArrow
				seed="dem-fallback-arrow"
				from={[96, 60]}
				to={[134, 60]}
				color="ink"
				width={1.6}
			/>
			<Hachure
				d={rectPath(140, 20, 120, 80)}
				seed="dem-coarse-fill"
				color="forest"
				gap={4}
				opacity={0.8}
			/>
			<SketchPath
				d={rectPath(140, 20, 120, 80)}
				seed="dem-coarse-edge"
				color="forest"
				width={1.4}
			/>
			<HandLabel x={200} y={66} anchor="middle" size={15} color="var(--gb-ink)">
				coarser tile
			</HandLabel>
		</svg>
	);
}
/* ---------- Fig 4: the encoding of a real pixel ---------- */
/** The decode equation with the real Mapterhorn pixel under the camera substituted. */
function DecodeEquation({ d }: { d: TerrainData | null }) {
	const p = d?.rgb.find((r) => r.source === "mapterhorn");
	const R = "var(--gb-red)";
	const G = "var(--gb-forest)";
	const B = "var(--gb-water)";
	return (
		<Eq
			label="Colour to metres, with the pixel under the camera"
			where={[
				{ sym: "R", c: R, text: "red: whole 256 m steps" },
				{ sym: "G", c: G, text: "green: whole metres" },
				{
					sym: "B",
					c: B,
					text: "blue: fractions of a metre, in steps of 4 mm",
				},
			]}
		>
			<Sym>h</Sym> = 256 <Sym c={R}>R</Sym> + <Sym c={G}>G</Sym> +{" "}
			<Sym c={B}>B</Sym>/256 − 32768
			{p && (
				<>
					<br />= 256·<Sym c={R}>{p.rgb[0]}</Sym> + <Sym c={G}>{p.rgb[1]}</Sym>{" "}
					+ <Sym c={B}>{p.rgb[2]}</Sym>/256 − 32768 ={" "}
					<Sym c="var(--accent)">{p.height.toFixed(2)}</Sym> m
				</>
			)}
		</Eq>
	);
}
// ======================================================================================
// Fig. 3 — which tile level answers, by distance
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
			label="Fig. 3"
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
						log scale: far rings are compressed
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
// Fig. 4 — one bilinear sample, with a tile seam
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
			label="Fig. 4"
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
									<Hachure
										d={cell}
										seed={`ts-cell-${id}`}
										color="brown"
										gap={14 - 9 * k}
										width={0.9}
										opacity={0.28 + 0.3 * k}
									/>
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
// Fig. 6 — what a coarser level costs, measured along a real line
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
			label="Fig. 6"
			bleed
			caption={
				<>
					Black: the sampler's answer along a real 12 km line, as height minus
					the finest map&rsquo;s. Orange: the coarsest map used everywhere.
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
export default function Page(_: { node: GipfelbuchNode }) {
	const d = useTerrainData();
	const cost = costNumbers(d);
	const lv = d?.levels.mapterhorn;
	const gaps = d?.eyes.map((e) => e.groundMapterhorn - e.groundTerrarium) ?? [];
	const gMin = gaps.length ? Math.min(...gaps) : null;
	const gMax = gaps.length ? Math.max(...gaps) : null;
	return (
		<>
			<Hero d={d} />

			<Beat
				kicker="The idea"
				title="A tile is an image whose pixel colours encode heights."
			>
				<p>
					Red, green and blue decode to metres.{" "}
					<HandMark type="highlight">Mapterhorn is the map Rigi uses</HandMark>:
					global 30 m data, plus national surveys such as Swiss lidar. Terrarium
					is the older map we compare against.
				</p>
			</Beat>

			<DecodeEquation d={d} />

			<Beat
				kicker="Two maps"
				title="Mapterhorn keeps the summit height; Terrarium rounds it low."
			>
				{d && (
					<p>
						At their finest, a pixel is {d.box.mapterhorn.nativeMPerPx} m in
						Mapterhorn and {d.box.terrarium.nativeMPerPx} m in Terrarium. But
						Terrarium is built from coarser surveys, so its{" "}
						<HandMark type="wavy">
							pixels are finer than its real detail
						</HandMark>
						<MarginNote mark="a">
							{`Same box, ${(d.box.mapterhorn.max - d.box.terrarium.max).toFixed(0)} m apart at the top. Why?`}
						</MarginNote>
						. The widest gap on the 12 km line is marked{" "}
						<CircledNumber value={1} /> in Fig. 2.
					</p>
				)}
			</Beat>

			<Disagree d={d} />

			<Beat
				kicker="How it works"
				title="One function answers: how high is the ground here?"
			>
				<p>
					Given a location and its distance from the camera, it returns the
					height in metres.{" "}
					<HandMark type="highlight">
						Near spots read a sharp height map, far spots a coarse one.
					</HandMark>{" "}
					In the rings below, the camera is{" "}
					<CircledNumber value={1} seed="ts-prose-1" />.
					{lv && (
						<MarginNote mark="b">
							{`The nearest map is ${lv[0].mPerPx.toFixed(1)} m a pixel, the farthest ${Math.round(lv[lv.length - 1].mPerPx)} m.`}
						</MarginNote>
					)}
				</p>
				<Trio
					steps={[
						{
							title: "Pick the map",
							body: "Distance chooses one of six maps, sharpest first.",
							visual: <BandsMini d={d} />,
						},
						{
							title: "Blend four pixels",
							body: "Weight each by how close the spot is to it.",
							visual: <BlendMini d={d} />,
						},
						{
							title: "Missing tile: use a coarser map",
							body: "A missing tile gives no value, so the next coarser map is used.",
							visual: <FallbackMini />,
						},
					]}
				/>
			</Beat>

			<LevelRings data={d} />

			<Beat kicker="Blend" title="Each answer blends the four nearest pixels.">
				<p>
					A spot rarely sits on a pixel centre. Each neighbour counts in
					proportion to{" "}
					<HandMark type="underline">the area opposite it</HandMark>.
					<MarginNote mark="c">
						Cross the seam with tile B unloaded and there is no answer.
					</MarginNote>
				</p>
			</Beat>

			<BilinearProbe data={d} />

			<Beat
				kicker="Same ground"
				title="The 3D view loads the same tiles with the same fallback."
			>
				<p>
					Both see the same ground, so a drawn line sits on the drawn terrain.
				</p>
			</Beat>

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

			<Beat
				kicker="Where it errs"
				title={
					cost
						? `The coarsest map alone differs from the finest by up to ${cost.coarse.toFixed(0)} m. The band rule keeps it to ${cost.picked.toFixed(0)} m.`
						: "Coarse maps are cheap but can be off by tens of metres."
				}
			>
				<p>
					Sharp tiles near the camera, coarse tiles far away.{" "}
					<HandMark type="double">
						This limits the error without loading every tile at full detail.
					</HandMark>
				</p>
				<p>
					At sea the map reads 0 m, so{" "}
					<HandMark type="wavy">a coast looks like sea level</HandMark>.
				</p>
			</Beat>

			<LevelCost data={d} />

			<Beat
				kicker="Where it fails"
				title={
					gMin == null || gMax == null
						? "Terrarium sits lower under every camera."
						: `Terrarium sits ${gMin.toFixed(0)} to ${gMax.toFixed(0)} m lower under the demo cameras.`
				}
			>
				<p>
					Heights feed the horizon we match to the photo. On 100 test photos,
					drawing on the wrong map moved the horizon by{" "}
					<HandMark type="double">1 to 27% of image height</HandMark>.
					<MarginNote mark="d">
						My first check used Terrarium. It was wrong.
					</MarginNote>
				</p>
				<p>
					Result: <HandMark type="strike">14</HandMark>{" "}
					<span className="nb-hand" style={{ color: "var(--gb-red)" }}>
						25
					</span>{" "}
					correct poses of 100 once the map was Mapterhorn.
				</p>
			</Beat>

			<GroundGap d={d} />

			<Numbers
				items={[
					{
						value: "25 vs 14",
						label: "correct poses of 100 photos, Mapterhorn vs Terrarium",
					},
					{
						value: d
							? `${(d.box.mapterhorn.max - d.box.terrarium.max).toFixed(0)} m`
							: "…",
						label: "Niederhorn summit lower in Terrarium",
					},
					{
						value:
							gMin == null || gMax == null
								? "…"
								: `${gMin.toFixed(0)}–${gMax.toFixed(0)} m`,
						label: "ground gap across the 12 demo cameras",
					},
					{
						value: cost ? `${cost.picked.toFixed(0)} m` : "…",
						label: "worst gap to the finest map with the band rule, 12 km line",
					},
				]}
				source="First figure: 100-photo benchmark. Others: measured at the Niederhorn camera."
			/>

			<Details>
				<h3>What a source is</h3>
				<p>
					A <code>DemSource</code> is a plain record: a name, a{" "}
					<code>url(TileKey)</code> function, a <code>tileSize</code>, the
					deepest <code>maxZoom</code> and a list of distance{" "}
					<code>levels</code>. <code>MAPTERHORN</code> ({MAPTERHORN.tileSize} px
					WebP, to z{MAPTERHORN.maxZoom}, swissALTI3D in Switzerland) is the
					default. <code>TERRAIN_LEVELS</code> belongs to{" "}
					<code>TERRARIUM_AWS</code> ({TERRARIUM_AWS.tileSize} px PNG, z
					{TERRARIUM_AWS.maxZoom}), kept as the comparison. Both are{" "}
					Terrarium-encoded, so the decoder is shared and a tile is a DEM tile
					either way.
				</p>
				<p>
					Each source carries its own distance-banded ladder. Mapterhorn&rsquo;s
					ladder is one zoom coarser per band than Terrarium&rsquo;s (its tiles
					are twice as wide) plus two finer near-field levels.{" "}
					<code>TerrainSampler</code> loads nothing itself, so it runs the same
					in the page and in scripts.
				</p>
				<Flow
					nodes={[
						{ label: "DemSource", sub: "url + levels", color: MAP },
						{ label: "tilesAround", sub: "per band" },
						{ label: "loadTile", sub: "16 at a time, size-checked" },
						{ label: "TerrainSampler", sub: "sampleAt" },
					]}
				/>
				<Steps
					steps={[
						{
							title: "Pick the base URL",
							body: "VITE_MAPTERHORN_URL (browser) or MAPTERHORN_URL (Node) overrides the public service, so a self-hosted pmtiles endpoint is a one-line change.",
						},
						{
							title: "Plan the tiles",
							body: "For every level, list the tiles inside that level's distance band, skipping any already loaded.",
						},
						{
							title: "Load in batches, check the size",
							body: "Tiles load 16 at a time. A tile of the wrong size is rejected with an error, because it would give wrong heights. A tile that fails to load leaves a hole.",
						},
						{
							title: "Where a tile does not exist",
							body: "A 404 or empty reply is remembered for the session, and the request walks up to the nearest tile that exists and enlarges its quadrant. Missing corners return NaN and sampleAt tries the next coarser level; ground() is just sampleAt(lon, lat, 0).",
						},
					]}
				/>
				{d && (
					<>
						<h3>Coverage depends on place</h3>
						<p>
							&quot;To z17&quot; is the maximum zoom, not a guarantee. Probing
							the service for the finest tile that exists at six places gave:
						</p>
						<div className="flex flex-wrap gap-2 font-mono text-[11px]">
							{d.coverage.map((c) => (
								<span
									key={c.name}
									className="border-b border-dotted border-[var(--gb-pencil)] bg-[var(--gb-paper-deep)] px-3 py-1"
								>
									{c.name} <span style={{ color: MAP }}>z{c.finest}</span>
								</span>
							))}
						</div>
					</>
				)}
				<h3>Bare earth or treetops?</h3>
				<p>
					swissALTI3D is a bare-earth terrain model (0.5 m grid; standard
					deviation 0.3 to 0.5 m from lidar, 1 to 3 m above 2000 m where it
					comes from stereo images). Mapterhorn&rsquo;s global layer is
					Copernicus GLO-30, a 30 m surface model that includes canopy and
					roofs, with an absolute vertical error under 4 m (90%). So
					&ldquo;ground&rdquo; means bare earth in Switzerland and treetops
					elsewhere. Figures are from the swisstopo and Copernicus product
					descriptions, not re-measured.
				</p>
				<h3>Gotchas and lessons</h3>
				<ul>
					<li>
						<strong>Check against the map the method used.</strong> The first{" "}
						benchmark check drew overlays on Terrarium while the methods solved
						on Mapterhorn; ground differed by up to 114 m.
					</li>
					<li>
						The 12-photo ground truth was fitted against Terrarium notches, so
						it carries a small Terrarium bias.
					</li>
					<li>
						Self-hosted tiles must be the same 512 px Terrarium WebP, and
						missing tiles must return 404 or 204 so the ancestor fallback works.
					</li>
					<li>
						Sea is set to 0 when tiles are decoded. Licences: see{" "}
						<code>reports/licences.md</code>.
					</li>
				</ul>
				<h3>Code</h3>
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/geo/terrain.ts">
						TerrainSampler.sampleAt
					</CodeRef>
					<CodeRef path="src/lib/dem/tiles.ts" />
					<CodeRef path="src/lib/dem/load.ts" />
					<CodeRef path="src/lib/dem/decode.ts" />
					<CodeRef path="src/lib/deck-webgpu/terrain.ts" />
				</div>
			</Details>
		</>
	);
}
