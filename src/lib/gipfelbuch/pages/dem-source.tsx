// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useEffect, useState } from "react";
import {
	CircledKey,
	CircledNumber,
	HandMark,
	PencilLayer,
	Wash,
} from "#/components/gipfelbuch/notebook";
import {
	Hachure,
	HandText,
	PenArrow,
	PenCircle,
	PenDimension,
	PenLine,
	SketchPath,
	SketchPolyline,
	Stipple,
} from "#/components/gipfelbuch/notebook/Ink";

import {
	Callout,
	CodeRef,
	Eq,
	Figure,
	Flow,
	HandLabel,
	MarginNote,
	Measured,
	Plot,
	Steps,
	Sym,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Compare,
	Details,
	Key,
	Numbers,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { MAPTERHORN, TERRAIN_LEVELS, TERRARIUM_AWS } from "#/lib/dem/sources";
import { gipfelbuchHref } from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

const TERRA = "var(--gb-red)";
const MAP = "var(--gb-forest)";
const rectPath = (x: number, y: number, w: number, h: number) =>
	`M${x} ${y}H${x + w}V${y + h}H${x}Z`;
const LAT = 46.8; // Swiss Alps, where the benchmark lives

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
	};
	coverage: { name: string; finest: number }[];
	eyes: { id: string; groundTerrarium: number; groundMapterhorn: number }[];
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
const A = ({ id, children }: { id: string; children: React.ReactNode }) => (
	<a
		href={gipfelbuchHref(id)}
		className="text-[var(--accent)] underline-offset-2 hover:underline"
	>
		{children}
	</a>
);

/** Metres per pixel of a Terrarium/Mapterhorn tile at latitude LAT. */
const mPerPx = (z: number, tile: number) =>
	(156543.03 * Math.cos((LAT * Math.PI) / 180)) / 2 ** z / (tile / 256);

const fmt = (v: number, n = 0) =>
	v.toLocaleString("en-US", {
		minimumFractionDigits: n,
		maximumFractionDigits: n,
	});

// Label sizes in viewBox units, for 11 to 13 px rendered: the hero figure draws at about 640 px
// (360-wide viewBox), the ladder at about 900 px (600-wide viewBox), the bar chart at about 900 px (720-wide).
const HERO_LABEL = 6.5;
const BAR_LABEL = 9.5;
const LADDER_LABEL = 7.5;

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
						`The map's own tag says ${fmt(box.osmSummit.ele)} m. `}
					<Measured data={d} />
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
						src="/demo/gipfelbuch/terrain/hs-terrarium.jpg"
						alt="Terrarium hillshade of the Niederhorn ridge"
						className="block aspect-square w-full object-cover"
						draggable={false}
					/>
				}
				after={
					<img
						src="/demo/gipfelbuch/terrain/hs-mapterhorn.jpg"
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
						<HandLabel x={4} y={82} size={HERO_LABEL} color="var(--gb-faint)">
							west
						</HandLabel>
						<HandLabel
							x={356}
							y={82}
							anchor="end"
							size={HERO_LABEL}
							color="var(--gb-faint)"
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
							I notice: a {gap?.toFixed(0)} m pit where the summit should be
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
						pixel of the 1.2 km box. Peaks:{" "}
						<span className="gb-num">{fmt(box.terrarium.max)} m</span> in
						Terrarium,{" "}
						<span className="gb-num">{fmt(box.mapterhorn.max)} m</span> in
						Mapterhorn.
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
			<Figure caption="Loading measured transect.">
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
					Along 12 km the maps part by up to {Math.abs(diff[worst]).toFixed(0)}{" "}
					m, at {(tr.d[worst] / 1000).toFixed(1)} km. <Measured data={d} />
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
				yLabel="Terr. − Map. (m)"
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
			label="Fig. 4"
			caption={
				<>
					At all 12 camera spots Terrarium puts the ground lower.{" "}
					<Measured data={d} />
				</>
			}
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
					every bar leans the same way: Terrarium is low
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

/* ---------- Trio visuals ---------- */
function PixelCard({ d }: { d: TerrainData | null }) {
	const p = d?.rgb.find((r) => r.source === "mapterhorn");
	if (!p)
		return (
			<div className="aspect-[4/3] animate-pulse bg-[var(--gb-paper-deep)]" />
		);
	const [r, g, b] = p.rgb;
	return (
		<div className="flex aspect-[4/3] flex-col items-center justify-center gap-2 p-3 font-mono text-[11px] gb-secondary">
			<span className="size-14" style={{ background: `rgb(${r} ${g} ${b})` }} />
			<span>
				R {r} · G {g} · B {b}
			</span>
			<span className="text-[var(--accent)]">= {p.height.toFixed(0)} m</span>
		</div>
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
				NaN
			</HandText>
			<HandText x={117} y={46} anchor="middle" size={12} rotate={-2}>
				sampleAt tries the next level up
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

/* ---------- Fig 2: the distance ladder ---------- */
function Ladder({ d: data }: { d: TerrainData | null }) {
	const [d, setD] = useState(3000);
	const max = 160_000;
	const lx = (m: number) =>
		40 + ((Math.log10(Math.max(m, 100)) - 2) / (Math.log10(max) - 2)) * 540;
	const pick = (levels: { z: number; maxDistance: number }[]) => {
		let i = levels.findIndex((l) => d <= l.maxDistance);
		if (i < 0) i = levels.length - 1;
		return i;
	};
	const row = (
		name: string,
		levels: { z: number; maxDistance: number }[],
		tile: number,
		y: number,
		col: string,
	) => {
		const sel = pick(levels);
		return (
			<g key={name}>
				<HandLabel x={0} y={y - 7} size={LADDER_LABEL + 1} color={col}>
					{name}
				</HandLabel>
				{levels.map((l, i) => {
					const x0 = i === 0 ? lx(100) : lx(levels[i - 1].maxDistance);
					const x1 = lx(l.maxDistance);
					return (
						<g key={l.z}>
							{i === sel ? (
								<Hachure
									d={rectPath(x0 + 1, y, Math.max(1, x1 - x0 - 2), 26)}
									seed={`dem-ladder-lit-${name}-${l.z}`}
									color={col}
									gap={2.4}
									width={1.3}
									opacity={0.9}
								/>
							) : (
								<Wash
									d={rectPath(x0 + 1, y, Math.max(1, x1 - x0 - 2), 26)}
									seed={`dem-ladder-wash-${name}-${l.z}`}
									color={col}
								/>
							)}
							<SketchPath
								d={rectPath(x0 + 1, y, Math.max(1, x1 - x0 - 2), 26)}
								seed={`dem-ladder-edge-${name}-${l.z}`}
								color={col}
								width={i === sel ? 1.6 : 0.9}
								opacity={i === sel ? 1 : 0.55}
								passes={1}
								tolerance={0.6}
							/>
							<HandLabel
								x={(x0 + x1) / 2}
								y={y + 16}
								anchor="middle"
								size={LADDER_LABEL}
								color="var(--gb-ink)"
								weight={i === sel ? 700 : 400}
							>
								z{l.z}
							</HandLabel>
							<HandLabel
								x={(x0 + x1) / 2}
								y={y + 40}
								anchor="middle"
								size={LADDER_LABEL}
								color="var(--gb-secondary)"
							>
								{mPerPx(l.z, tile).toFixed(1)} m
							</HandLabel>
						</g>
					);
				})}
			</g>
		);
	};
	return (
		<Figure
			label="Fig. 3"
			caption="Slide the probe: the lit band is the zoom each map would use at that distance. Small numbers are metres per tile pixel."
		>
			<svg
				viewBox="0 0 600 150"
				className="block h-auto w-full"
				role="img"
				aria-label="Distance bands of the Terrarium and Mapterhorn tile ladders"
			>
				{row("terrarium (3 bands)", TERRAIN_LEVELS, 256, 22, TERRA)}
				{row("mapterhorn (6 bands)", MAPTERHORN.levels, 512, 88, MAP)}
				{[1000, 4000, 15000, 40000, 150000].map((m) => (
					<g key={m}>
						<PenLine
							seed={`dem-ladder-grid-${m}`}
							data
							from={[lx(m), 12]}
							to={[lx(m), 136]}
							color="faint"
							width={0.6}
						/>
						<HandLabel
							x={lx(m)}
							y={148}
							anchor="middle"
							size={LADDER_LABEL}
							color="var(--gb-secondary)"
						>
							{m >= 1000 ? `${m / 1000} km` : `${m} m`}
						</HandLabel>
					</g>
				))}
				<PenLine
					seed="dem-ladder-probe"
					data
					from={[lx(d), 4]}
					to={[lx(d), 138]}
					color="ink"
					width={1.7}
				/>
				<HandText
					x={lx(d) + (lx(d) > 300 ? -20 : 20)}
					y={75}
					anchor={lx(d) > 300 ? "end" : "start"}
					size={8}
					rotate={-1.5}
				>
					probe: Mapterhorn z{MAPTERHORN.levels[pick(MAPTERHORN.levels)].z},
					Terrarium z{TERRAIN_LEVELS[pick(TERRAIN_LEVELS)].z}
				</HandText>
				<PenArrow
					seed="dem-ladder-probe-arrow"
					from={[lx(d) + (lx(d) > 300 ? -17 : 17), 72]}
					to={[lx(d) + (lx(d) > 300 ? -2 : 2), 70]}
					color="ink"
					width={1}
					head={4}
				/>
			</svg>
			<label className="mt-2 flex items-center gap-3 font-mono text-[11px] gb-secondary">
				distance
				<input
					type="range"
					min={2}
					max={Math.log10(max) * 100}
					value={Math.log10(d) * 100}
					onChange={(e) =>
						setD(Math.round(10 ** (Number(e.target.value) / 100)))
					}
					className="flex-1 accent-[var(--accent)]"
					aria-label="Sample distance from camera"
				/>
				<span className="w-16 text-right gb-ink">
					{d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${d} m`}
				</span>
			</label>

			{data && (
				<p className="mt-1 font-mono text-[11px] gb-secondary">
					Measured at the Niederhorn camera: the selected band is{" "}
					{data.levels.mapterhorn[pick(MAPTERHORN.levels)].tiles} Mapterhorn
					tiles of {data.levels.mapterhorn[pick(MAPTERHORN.levels)].tileKm} km,
					or {data.levels.terrarium[pick(TERRAIN_LEVELS)].tiles} Terrarium tiles
					of {data.levels.terrarium[pick(TERRAIN_LEVELS)].tileKm} km
					(tilesAround count, {data.script}).
				</p>
			)}
		</Figure>
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

function Encoding({ d }: { d: TerrainData | null }) {
	return (
		<Figure
			label="D1"
			caption={
				<>
					The tile pixel under the camera in each source. <Measured data={d} />
				</>
			}
		>
			<div className="grid gap-3 sm:grid-cols-2">
				{(d?.rgb ?? []).map((p) => {
					const [r, g, b] = p.rgb;
					const col = p.source === "terrarium" ? TERRA : MAP;
					return (
						<div key={p.source} className="bg-[var(--gb-paper-deep)] p-4">
							<div className="flex items-center gap-3">
								<span
									className="size-10 shrink-0"
									style={{ background: `rgb(${r} ${g} ${b})` }}
								/>
								<div className="font-mono text-[11px] gb-secondary">
									<div style={{ color: col }}>{p.source}</div>
									tile {p.tile}, pixel ({p.px}, {p.py})
								</div>
							</div>
							<div className="mt-3 font-mono text-[13px] leading-relaxed whitespace-nowrap gb-ink">
								R {r} &middot; G {g} &middot; B {b}
								<br />
								{r}&times;256 + {g} + {b}/256 &minus; 32768
								<br />
								<span className="text-[var(--accent)]">
									= {p.height.toFixed(2)} m
								</span>
							</div>
						</div>
					);
				})}
			</div>
		</Figure>
	);
}

export default function Page(_: { node: GipfelbuchNode }) {
	const d = useTerrainData();
	const gaps = d?.eyes.map((e) => e.groundMapterhorn - e.groundTerrarium) ?? [];
	const gMin = gaps.length ? Math.min(...gaps) : null;
	const gMax = gaps.length ? Math.max(...gaps) : null;
	const tr = d?.transect;
	let worst = Number.NaN;
	if (tr) {
		const T = tr.terrarium["15"];
		const Mh = tr.mapterhorn["15"];
		worst = Math.max(...T.map((v, i) => Math.abs(v - Mh[i])));
	}
	return (
		<>
			<Hero d={d} />

			<Beat
				kicker="The idea"
				title="Two free height maps. One keeps the summit."
			>
				<p>
					Both are pictures where each pixel&rsquo;s colour is a height.
					<HandMark type="highlight">Mapterhorn is the map Rigi uses</HandMark>:
					global 30 m data, plus national surveys such as Swiss lidar. Terrarium
					is the older map we compare against.
				</p>
				{d && (
					<p>
						At their finest, tile pixels are {d.box.mapterhorn.nativeMPerPx} m
						wide in Mapterhorn and {d.box.terrarium.nativeMPerPx} m in
						Terrarium. Pixel size is only the grid: Terrarium is built from
						coarser surveys, so its{" "}
						<HandMark type="wavy">grid is finer than its detail</HandMark>
						<MarginNote mark="a">
							{d
								? `Same box, ${(d.box.mapterhorn.max - d.box.terrarium.max).toFixed(0)} m apart at the top. Why?`
								: "Same box, different summit. Why?"}
						</MarginNote>
						. The widest gap on the 12 km line is marked{" "}
						<CircledNumber value={1} /> in Fig. 2.
					</p>
				)}
			</Beat>

			<Disagree d={d} />

			<Beat
				kicker="How it works"
				title="A tile is a picture that spells heights."
			>
				<Trio
					steps={[
						{
							title: "Colour is a height",
							body: "Red, green and blue decode to metres.",
							visual: <PixelCard d={d} />,
						},
						{
							title: "Distance picks the zoom",
							body: "Sharp tiles near us, coarse tiles for far ridges.",
							visual: <BandsMini d={d} />,
						},
						{
							title: "A hole falls back",
							body: "No fine tile here? We use the next coarser one.",
							visual: <FallbackMini />,
						},
					]}
				/>
			</Beat>

			<DecodeEquation d={d} />

			<Ladder d={d} />

			<Beat
				kicker="Where it fails"
				title={
					gMin == null || gMax == null
						? "Terrarium sits lower under every camera."
						: `Terrarium sits ${gMin.toFixed(0)} to ${gMax.toFixed(0)} m lower under our cameras.`
				}
			>
				<p>
					Heights feed the skyline we match. In the benchmark, drawing on the
					wrong map moved the skyline by{" "}
					<HandMark type="double">1 to 27% of image height</HandMark>.
					<MarginNote mark="b">
						My first verification drew on Terrarium. It was wrong.
					</MarginNote>
				</p>
				<p>
					Fine tiles also exist only where surveys do. Elsewhere we fall back to
					coarser ones. Cascade result: <HandMark type="strike">14</HandMark>{" "}
					<span className="nb-hand" style={{ color: "var(--gb-red)" }}>
						25
					</span>{" "}
					correct poses once the map was Mapterhorn.
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
						value: Number.isNaN(worst) ? "…" : `${worst.toFixed(0)} m`,
						label: "largest gap on a 12 km line",
					},
					{
						value:
							gMin == null || gMax == null
								? "…"
								: `${gMin.toFixed(0)}–${gMax.toFixed(0)} m`,
						label: "ground gap across the 12 demo cameras",
					},
				]}
				source={
					<>
						Benchmark: reports/bench-wild.md (cascade re-run, all 100 photos).
						Others: measured by scripts/gipfelbuch/data-terrain.ts at the
						Niederhorn camera.
					</>
				}
			/>

			<Details>
				<h3>What a source is</h3>
				<p>
					A <code>DemSource</code> is a plain record: a name, a{" "}
					<code>url(TileKey)</code> function, a <code>tileSize</code>, the
					deepest <code>maxZoom</code> and a list of distance{" "}
					<code>levels</code>. <code>MAPTERHORN</code> ({MAPTERHORN.tileSize} px
					WebP, to z{MAPTERHORN.maxZoom}, swissALTI3D in Switzerland) is the
					user-approved default that every DEM consumer uses.{" "}
					<code>TERRAIN_LEVELS</code> belongs to <code>TERRARIUM_AWS</code> (
					{TERRARIUM_AWS.tileSize} px PNG, z{TERRARIUM_AWS.maxZoom}), kept as
					the comparison. Both are{" "}
					<A id="terrarium-encoding">Terrarium-encoded</A>, so the decoder is
					shared and a tile is a <A id="dem-tile">DEM tile</A> either way.
				</p>
				<p>
					Each source carries its own{" "}
					<A id="dem-lod-levels">distance-banded ladder</A>. The sampler asks
					for height at (lon, lat, distance from camera), picks the first band
					whose <code>maxDistance</code> covers it, and walks to coarser bands
					if that tile is missing. Mapterhorn&rsquo;s ladder is one zoom coarser
					per band than Terrarium&rsquo;s (its tiles are twice as wide) plus two
					finer near-field levels.
				</p>
				<Flow
					nodes={[
						{ label: "DemSource", sub: "url + levels", color: MAP },
						{ label: "tilesAround", sub: "per band" },
						{ label: "loadTile", sub: "cache, decode" },
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
							title: "Choose a band",
							body: "findIndex(l => distance <= l.maxDistance); beyond the last band, the coarsest one is used.",
						},
						{
							title: "Fall back on a miss",
							body: "Missing fine tiles (outside national lidar) return NaN, and sampleAt tries the next coarser level. ground() is just sampleAt(lon, lat, 0).",
						},
					]}
				/>
				<h3>Pixel decode, measured</h3>
				<Encoding d={d} />
				{d && (
					<>
						<h3>Coverage depends on place</h3>
						<p>
							&quot;To z17&quot; is the ceiling, not a promise. Probing the
							service for the finest tile that exists at six places gave:
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
						<p>
							Measured by <code>{d.script}</code>, {d.generated} (HTTP status of
							one tile per zoom).
						</p>
					</>
				)}
				<h3>Bare earth or treetops?</h3>
				<p>
					swissALTI3D is a bare-earth terrain model (0.5 m grid; standard
					deviation 0.3 to 0.5 m from lidar, 1 to 3 m above 2000 m where it
					comes from stereo images). Mapterhorn&rsquo;s global layer is
					Copernicus GLO-30, a 30 m surface model that includes canopy and
					roofs, with an absolute vertical error under 4 m (90%). So the same
					&ldquo;ground&rdquo; means bare earth in Switzerland and treetops
					elsewhere. We did not re-measure these figures; they come from the
					swisstopo and Copernicus product descriptions.
				</p>
				<h3>Why it matters in Rigi</h3>
				<p>
					Georeferencing depends on skyline notches and ridgelines matching the
					photo to a few hundredths of a degree. A DEM that rounds off summits
					moves exactly those features. Swapping Terrarium for Mapterhorn took
					the cascade from 14 to 25 correct poses on the 100-photo{" "}
					<A id="wild-benchmark">wild benchmark</A>, with no algorithm change
					(reports/bench-wild.md). It is also the licensing surface: see the{" "}
					<A id="licence-register">licence register</A>.
				</p>
				<h3>Gotchas and lessons</h3>
				<ul>
					<li>
						<strong>Verify on the DEM the method used.</strong> The first
						benchmark verification drew overlays on Terrarium while methods
						solved on Mapterhorn; ground differed by up to 114 m and the drawn
						skyline moved 1 to 27% of image height. The reported precision
						(0.72) and a &quot;GPS parallax&quot; story were wrong.
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
						Terrarium is for <code>/baseline</code> and research scripts only;
						it is not on product paths.
					</li>
				</ul>
				<Callout tone="negative" title="Terrarium cascade">
					14 correct vs 25 on Mapterhorn: the smoother DEM is not a cheaper
					equivalent; it silently changes accuracy.
				</Callout>
				<h3>Code</h3>
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/dem/sources.ts">
						DemSource, MAPTERHORN, TERRAIN_LEVELS
					</CodeRef>
					<CodeRef path="src/lib/geo/terrain.ts">
						TerrainSampler.sampleAt
					</CodeRef>
					<CodeRef path="src/lib/dem/index.ts">dem barrel</CodeRef>
					<CodeRef path="reports/bench-wild.md" />
					<CodeRef path="reports/licences.md" />
				</div>
			</Details>
		</>
	);
}
