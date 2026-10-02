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
} from "#/components/gipfelbuch/notebook";
import {
	Hachure,
	HandDot,
	HandText,
	PenArrow,
	PenCircle,
	PenLine,
	SketchPath,
} from "#/components/gipfelbuch/notebook/Ink";
import { SpotHeight } from "#/components/gipfelbuch/swiss/Marks";
import { SWISS } from "#/components/gipfelbuch/swiss/palette";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import {
	CodeRef,
	Eq,
	Figure,
	HandLabel,
	MarginNote,
	Measured as PhotoMeasured,
	PhotoStory,
	RealPhoto,
	Sym,
	useGipfelbuchPhoto,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Details,
	Mark,
	MarkList,
	Numbers,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { byId, gipfelbuchHref } from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// Terrain snapping hub: where a coordinate meets the DEM (eye height, peaks, near-field depth).
// Rules mirrored from the code (kept literal so the page has no engine imports):
//  eye       eyeAltitude = alt != null ? max(alt, dem + 1.6) : dem + 1.8      (engine.ts, deck/scene.ts)
//  lake      floor = level + 0.3 m, radius clamp(hAcc, 5, 100) + 30 m, drop <= 3 m; ?geoLakeFloor (geocam/lakes/floor.ts)
//  peaks     localMax(lat, lon, min(250, 60 + dist * 0.004)) on a 9x9 grid; peaks < 150 m or > 110 km dropped (engine.ts buildPeaks)
//  anchor    quality = inlierFrac * exp(-(err / 0.2)^2), hide < 0.15, low trust < 0.35 (nearfield/anchor.ts)
const EYE_ABOVE = 1.6;
const rectPath = (x: number, y: number, w: number, h: number) =>
	`M${x} ${y}H${x + w}V${y + h}H${x}Z`;

// tiles around the Niederhorn demo camera, real TerrainSampler, the engine's peak-snap rule re-run on it).
type PeakRow = {
	name: string;
	ele: number | null;
	dist: number;
	radius: number;
	osmMapterhorn: number;
	snapMapterhorn: number;
	moveMapterhorn: number;
	snapTerrarium: number;
};
type TerrainData = {
	generated: string;
	script: string;
	eyes: {
		id: string;
		alt: number;
		hAcc: number;
		groundTerrarium: number;
		groundMapterhorn: number;
		eye: number;
		lift: number;
	}[];
	lake: { mapterhornMin: number; terrariumMin: number };
	peakRule: {
		n: number;
		nWithEle: number;
		medianAbsEleMinusSnapMapterhorn: number;
		medianAbsEleMinusSnapTerrarium: number;
		medianAbsEleMinusOsmNodeMapterhorn: number;
		medianMoveMapterhorn: number;
		p90MoveMapterhorn: number;
		rows: PeakRow[];
	};
	snapExample?: {
		name: string;
		ele: number | null;
		dist: number;
		radius: number;
		halfM: number;
		px: number;
		osmPx: [number, number];
		snapPx: [number, number];
		osmH: number;
		snapH: number;
		move: number;
		grid: [number, number, number][];
	};
};
let terrainCache: Promise<TerrainData> | null = null;
// Rendered label sizes (11 and 13 px) for figures whose viewBox is not 1:1 with the screen:
// fontSize = px * viewBox width / rendered width (~720 px full width, ~340 px per half column).
const EYE_LABEL = (11 * 560) / 800;
// solid fills encode the two ground models (Mapterhorn brown, Terrarium pencil grey); a light hatch rides on top as decoration only

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
const Measured = ({ d, what }: { d: TerrainData | null; what: string }) => (
	<span className="gb-secondary">
		Measured: {what} Real tiles and the real TerrainSampler, by{" "}
		<span className="font-mono">
			{d?.script ?? "scripts/gipfelbuch/data-terrain.ts"}
		</span>
		{d ? `, ${d.generated}` : ""}.
	</span>
);

function link(id: string, label: string) {
	if (!byId.has(id)) return <>{label}</>;
	return (
		<Link
			to={gipfelbuchHref(id)}
			className="underline decoration-[var(--gb-red)]"
		>
			{label}
		</Link>
	);
}

function RealEye({ d }: { d: TerrainData | null }) {
	if (!d)
		return (
			<div className="aspect-[2/1] animate-pulse bg-[var(--gb-paper-deep)]" />
		);
	const rows = d.eyes.map((e) => ({
		...e,
		liftT: Math.max(0, e.groundTerrarium + EYE_ABOVE - e.alt),
		liftM: Math.max(0, e.groundMapterhorn + EYE_ABOVE - e.alt),
	}));
	const MAX = 30;
	const RH = 22;
	const X0 = 74;
	const X1 = 330;
	const bx = (v: number) => X0 + (Math.min(v, MAX) / MAX) * (X1 - X0);
	const nM = rows.filter((r) => r.liftM > 0).length;
	const nT = rows.filter((r) => r.liftT > 0).length;
	const med = (a: number[]) => {
		const s = [...a].sort((x, y) => x - y);
		return s[Math.floor(s.length / 2)];
	};
	const liftsM = rows
		.filter((r) => r.liftM > 0 && r.liftT <= MAX)
		.map((r) => r.liftM);
	return (
		<Figure
			label="Fig. 4"
			bleed
			caption={
				<>
					The same GPS fix lifts the eye by very different amounts on two maps.{" "}
					<Measured
						d={d}
						what="the eye rule on the 12 Niederhorn photos, ground read at each fix."
					/>
				</>
			}
		>
			<svg
				viewBox={`0 0 560 ${40 + rows.length * RH + 24}`}
				className="block h-auto w-full"
				role="img"
				aria-label="Metres each demo photo's eye is lifted by the eye rule, for Terrarium and Mapterhorn ground"
			>
				{[0, 10, 20, 30].map((v) => (
					<g key={v}>
						<PenLine
							seed={`eye-grid-${v}`}
							from={[bx(v), 28]}
							to={[bx(v), 28 + rows.length * RH]}
							color="faint"
							width={0.5}
						/>
						<HandLabel
							x={bx(v)}
							y={20}
							anchor="middle"
							size={EYE_LABEL}
							color="var(--gb-secondary)"
							halo={0}
						>
							{v} m
						</HandLabel>
					</g>
				))}
				{rows.map((r, i) => {
					const y = 32 + i * RH;
					const big = r.liftT > MAX;
					return (
						<g key={r.id}>
							<HandLabel
								x={X0 - 8}
								y={y + 11}
								anchor="end"
								size={EYE_LABEL}
								color="var(--gb-secondary)"
								halo={0}
							>
								{r.id}
							</HandLabel>
							{bx(r.liftM) - X0 > 0.5 && (
								<g>
									<Hachure
										d={rectPath(X0, y, bx(r.liftM) - X0, 8)}
										seed={`eye-m-${r.id}`}
										color="brown"
										gap={2.2}
										width={0.9}
										opacity={0.85}
									/>
									<PenLine
										data
										from={[bx(r.liftM), y - 1]}
										to={[bx(r.liftM), y + 9]}
										seed={`eye-m-end-${r.id}`}
										color="brown"
										width={1.6}
									/>
								</g>
							)}
							{bx(r.liftT) - X0 > 0.5 && (
								<g>
									<Hachure
										d={rectPath(X0, y + 9, bx(r.liftT) - X0, 8)}
										seed={`eye-t-${r.id}`}
										color="forest"
										angle={45}
										gap={2.2}
										width={0.9}
										opacity={0.85}
									/>
									<PenLine
										data
										from={[bx(r.liftT), y + 8]}
										to={[bx(r.liftT), y + 18]}
										seed={`eye-t-end-${r.id}`}
										color="forest"
										width={1.6}
									/>
								</g>
							)}
							{big && (
								<HandLabel
									x={X1 + 10}
									y={y + 12}
									size={EYE_LABEL}
									color="var(--gb-secondary)"
									halo={0}
								>
									+{r.liftT.toFixed(0)} m: alt {r.alt.toFixed(0)} vs ground{" "}
									{r.groundTerrarium.toFixed(0)}
								</HandLabel>
							)}
							{!big && r.liftM > 0 && (
								<HandLabel
									x={bx(r.liftM) + 4}
									y={y + 7}
									size={EYE_LABEL}
									color="var(--gb-secondary)"
									halo={0}
								>
									{r.liftM.toFixed(0)}
								</HandLabel>
							)}
						</g>
					);
				})}
				<g>
					<Hachure
						d={rectPath(X0, 40 + rows.length * RH, 9, 9)}
						seed="eye-key-m"
						color="brown"
						gap={2.2}
						width={0.9}
						opacity={0.85}
					/>
					<HandLabel
						x={X0 + 14}
						y={48 + rows.length * RH}
						size={EYE_LABEL}
						color="var(--gb-secondary)"
					>
						Mapterhorn ground
					</HandLabel>
					<Hachure
						d={rectPath(X0 + 150, 40 + rows.length * RH, 9, 9)}
						seed="eye-key-t"
						color="forest"
						angle={45}
						gap={2.2}
						width={0.9}
						opacity={0.85}
					/>
					<HandLabel
						x={X0 + 164}
						y={48 + rows.length * RH}
						size={EYE_LABEL}
						color="var(--gb-secondary)"
					>
						Terrarium ground
					</HandLabel>
				</g>
				<PencilLayer>
					<PenLine
						from={[X0, 28 + rows.length * RH]}
						to={[X1, 28 + rows.length * RH]}
						seed="eye-base-guide"
						width={0.8}
					/>
				</PencilLayer>
				<HandText x={X1 + 14} y={36 + 5 * RH} size={14} rotate={-2}>
					finer map, higher crest: Mapterhorn lifts {nM} of {rows.length}
				</HandText>
				<PenArrow
					from={[X1 + 10, 32 + 5 * RH]}
					to={[X1 - 60, 28 + 5 * RH]}
					seed="eye-note-arrow"
					width={1.2}
				/>
			</svg>
			<p className={`mt-3 ${TYPE.caption}`}>
				Bar = metres the eye is lifted above the raw GPS altitude. On Mapterhorn
				ground the rule lifts {nM} of {rows.length} photos (excluding demo-09:
				median {med(liftsM).toFixed(0)} m, up to{" "}
				{Math.max(...liftsM).toFixed(0)} m): the photographer probably stands on
				the crest, and the finer DEM has the crest higher than the GPS altitude.
				On Terrarium ground, which smooths that crest down, it lifts only {nT}{" "}
				(the build-data run used Terrarium). demo-09 carries a GPS altitude of{" "}
				{rows.find((r) => r.id === "demo-09")?.alt.toFixed(0)} m,{" "}
				{Math.round(
					(rows.find((r) => r.id === "demo-09")?.groundTerrarium ?? 0) -
						(rows.find((r) => r.id === "demo-09")?.alt ?? 0),
				)}{" "}
				m below the ground.
			</p>
		</Figure>
	);
}

/** The shipped radius rule with the measured example substituted; the dashed square in Fig. 3 is this r. */
function SnapEquation({ d }: { d: TerrainData | null }) {
	const ex = d?.snapExample;
	return (
		<Eq
			label="How far we search"
			where={[
				{
					sym: "r",
					c: "var(--gb-ink)",
					text: "half-width of the dashed search square in Fig. 3, in metres",
				},
				{
					sym: "d",
					text: "distance from the camera to the OSM node, in metres",
				},
			]}
		>
			<Sym c="var(--gb-ink)">r</Sym> = min(250, 60 + 0.004 <Sym>d</Sym>)
			{ex && (
				<>
					<br />= min(250, 60 + 0.004 × {Math.round(ex.dist)}) ={" "}
					<Sym c="var(--gb-ink)">{ex.radius}</Sym> m
				</>
			)}
		</Eq>
	);
}

function PeakReal({ d }: { d: TerrainData | null }) {
	const ex = d?.snapExample;
	if (!d || !ex)
		return (
			<div className="aspect-[2/1] animate-pulse bg-[var(--gb-paper-deep)]" />
		);
	const pr = d.peakRule;
	const hs = ex.grid.map((g) => g[2]);
	const lo = Math.min(...hs);
	const hi = Math.max(...hs);
	const sr = (ex.radius / ex.halfM) * (ex.px / 2);
	// 13 px at about 420 px rendered width (hillshade in the left half of the wide figure)
	const snapLabel = (13 * ex.px) / 420;
	return (
		<Figure
			label="Fig. 3"
			bleed
			caption={
				<>
					Fixed example, not photo-specific: the snap moves {ex.name} {ex.move}{" "}
					m onto its summit (the red grid sample is the highest of the 9 by 9);
					the median over {pr.n} peaks is {pr.medianMoveMapterhorn} m.{" "}
					<Measured
						d={d}
						what="the engine's snap rule on Mapterhorn around the real OSM nodes within 40 km."
					/>
				</>
			}
		>
			<div className="grid items-start gap-6 lg:grid-cols-[1fr_1fr]">
				<svg
					viewBox={`0 0 ${ex.px} ${ex.px}`}
					className="block h-auto w-full"
					role="img"
					aria-label={`Hillshade around the OSM node of ${ex.name}, with the 9 by 9 search grid and the snapped summit`}
				>
					<image
						href="/demo/gipfelbuch/terrain/snap-0.jpg"
						width={ex.px}
						height={ex.px}
					/>
					<SketchPath
						d={rectPath(ex.osmPx[0] - sr, ex.osmPx[1] - sr, 2 * sr, 2 * sr)}
						seed="snap-sq-casing"
						data
						color="var(--gb-paper)"
						opacity={0.8}
						width={3.4}
					/>
					<SketchPath
						d={rectPath(ex.osmPx[0] - sr, ex.osmPx[1] - sr, 2 * sr, 2 * sr)}
						seed="snap-sq"
						data
						color="ink"
						width={1.4}
						dash="4 3"
					/>
					{ex.grid.map(([x, y, h]) => (
						<HandDot
							key={`${x}-${y}`}
							x={x}
							y={y}
							r={h === hi ? 4.2 : 3}
							seed={`snap-g-${x}-${y}`}
							data
							color={h === hi ? "red" : "ink"}
							opacity={h === hi ? 1 : 0.45 + 0.55 * ((h - lo) / (hi - lo || 1))}
						/>
					))}
					<PenLine
						data
						from={[ex.osmPx[0], ex.osmPx[1]]}
						to={[ex.snapPx[0], ex.snapPx[1]]}
						seed="snap-move-casing"
						color="var(--gb-paper)"
						opacity={0.8}
						width={3.6}
					/>
					<PenLine
						data
						from={[ex.osmPx[0], ex.osmPx[1]]}
						to={[ex.snapPx[0], ex.snapPx[1]]}
						seed="snap-move"
						color="red"
						width={1.8}
					/>
					<PenCircle
						seed="snap-osm"
						center={ex.osmPx}
						radiusX={5}
						color="pencil"
						width={1.8}
					/>
					<PenCircle
						seed="snap-top-ring"
						data
						center={ex.snapPx}
						radiusX={5.4}
						color="var(--gb-paper)"
						width={1.6}
					/>
					<HandDot
						x={ex.snapPx[0]}
						y={ex.snapPx[1]}
						r={4.2}
						seed="snap-top"
						data
						color="red"
						opacity={1}
					/>
					<HandLabel
						x={ex.snapPx[0] + 8}
						y={ex.snapPx[1] - 8}
						size={snapLabel * 0.9}
						italic
						color={SWISS.ink}
					>
						{ex.snapH.toFixed(1)}
					</HandLabel>
					<KrokiTitle
						x={8}
						y={snapLabel * 1.7}
						title={ex.name}
						size={snapLabel * 1.5}
						seed="snap-title"
					/>
					<NorthArrow x={ex.px - 22} y={snapLabel * 4.2} seed="snap-north" />
					<HandScaleBar
						x={10}
						y={ex.px - 14}
						metersPerPixel={(ex.halfM * 2) / ex.px}
						maxWidth={ex.px * 0.3}
						seed="snap-scale"
					/>
					<HandText
						x={ex.px - 10}
						y={ex.px - 12}
						size={snapLabel * 1.1}
						anchor="end"
						rotate={-2}
					>
						OSM node here, summit 9 by 9 samples away
					</HandText>
					<CircledKey
						x={ex.osmPx[0] - 14}
						y={ex.osmPx[1] + 14}
						value="1"
						seed="snap-key-1"
						color="ink"
						r={7 * (ex.px / 420)}
					/>
					<CircledKey
						x={ex.snapPx[0] - 14}
						y={ex.snapPx[1] - 10}
						value="2"
						seed="snap-key-2"
						r={7 * (ex.px / 420)}
					/>
					<HandLabel x={8} y={ex.px - 30} size={snapLabel} color={SWISS.ink}>
						{`${ex.halfM * 2} m across`}
					</HandLabel>
				</svg>
				<div className={`w-full font-mono gb-secondary ${TYPE.micro}`}>
					<div className="bg-[var(--gb-paper-deep)] p-3">
						<div className={`gb-ink ${TYPE.caption}`}>{ex.name}</div>
						<div className="mt-1 flex justify-between">
							<span>distance, radius</span>
							<span className="gb-ink">
								{(ex.dist / 1000).toFixed(1)} km, {ex.radius} m
							</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>DEM at the OSM node</span>
							<span className="gb-ink">{ex.osmH.toFixed(1)} m</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>DEM at the snapped point</span>
							<span className="text-[var(--accent)]">
								<SpotHeight value={ex.snapH.toFixed(1)} unit="m" />
							</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>OSM ele tag</span>
							<span className="gb-ink">
								{ex.ele == null ? "none" : `${ex.ele} m`}
							</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>moved</span>
							<span className="gb-ink">{ex.move} m</span>
						</div>
					</div>
					<div className="mt-3 grid grid-cols-3 gap-2 text-center">
						<div className="bg-[var(--gb-paper-deep)] p-2">
							<div className={`gb-ink ${TYPE.body}`}>
								{pr.medianMoveMapterhorn} m
							</div>
							median move
						</div>
						<div className="bg-[var(--gb-paper-deep)] p-2">
							<div className={`gb-ink ${TYPE.body}`}>
								{pr.p90MoveMapterhorn} m
							</div>
							90th percentile
						</div>
						<div className="bg-[var(--gb-paper-deep)] p-2">
							<div className={`gb-ink ${TYPE.body}`}>{pr.n}</div>
							peaks, 150 m to 40 km
						</div>
					</div>
					<p className={`mt-3 font-sans ${TYPE.caption}`}>
						Does the snap agree with OSM&apos;s own ele tag? Median |ele minus
						DEM| over {pr.nWithEle} tagged peaks:{" "}
						{pr.medianAbsEleMinusOsmNodeMapterhorn} m at the node,{" "}
						{pr.medianAbsEleMinusSnapMapterhorn} m at the snapped point
						(Mapterhorn); on Terrarium, which blunts summits, the snapped point
						is {pr.medianAbsEleMinusSnapTerrarium} m off.
					</p>
				</div>
			</div>
		</Figure>
	);
}

// ============================================================================================
// The ledger: where the DEM overrules, bounds or merely informs.
// ============================================================================================

const LEDGER: {
	what: string;
	verb: "snap" | "bound" | "prior" | "calibrate";
	rule: string;
	where: string;
	when: string;
}[] = [
	{
		what: "Eye height",
		verb: "snap",
		rule: "max(GPS alt, DEM + 1.6 m); DEM + 1.8 m without altitude",
		where: "src/lib/deck/scene.ts",
		when: "always",
	},
	{
		what: "OSM peaks",
		verb: "snap",
		rule: "highest of 9×9 samples within ±min(250, 60 + 0.004·d) m",
		where: "src/lib/deck/engine.ts",
		when: "always (150 m – 110 km)",
	},
	{
		what: "Eye on a lake",
		verb: "bound",
		rule: "eye ≥ lake level + 0.3 m; lifts only, fail-open",
		where: "src/lib/geocam/lakes/floor.ts",
		when: "?geoLakeFloor",
	},
	{
		what: "GPS altitude",
		verb: "prior",
		rule: "Gaussian + iso-band where DEM + 1.6 ≈ alt; never moves the fix",
		where: "src/lib/concord/priors/altitude.ts",
		when: "?concord=eye",
	},
	{
		what: "Near-field depth",
		verb: "calibrate",
		rule: "monotone log-log curve to DEM range, 15 m – 3 km, quality-gated",
		where: "src/lib/nearfield/anchor.ts",
		when: "Step Inside",
	},
	{
		what: "Near-field objects",
		verb: "snap",
		rule: "scale each object to the DEM range at its ground contacts",
		where: "src/lib/nearfield/ground.ts",
		when: "Step Inside",
	},
];
const VERB_C: Record<string, string> = {
	snap: "var(--accent)",
	bound: "var(--gb-navy)",
	prior: "var(--gb-pencil)",
	calibrate: "var(--gb-contour)",
};

function Ledger() {
	return (
		<div className="@container">
			<ul className="m-0 list-none p-0">
				{LEDGER.map((r) => (
					<li
						key={r.what}
						className="grid gap-x-4 gap-y-1 px-2 py-3 even:bg-[var(--gb-paper-deep)] @[640px]:grid-cols-[10rem_5.5rem_1fr_9rem]"
					>
						<div className={`gb-ink ${TYPE.caption}`}>
							{r.what}
							<div className="mt-1">
								<CodeRef path={r.where} />
							</div>
						</div>
						<div>
							<span
								className={`nb-hand px-1 underline decoration-wavy decoration-1 underline-offset-4 ${TYPE.body}`}
								style={{ color: VERB_C[r.verb] }}
							>
								{r.verb}
							</span>
						</div>
						<div className={`gb-secondary ${TYPE.caption}`}>{r.rule}</div>
						<div className={`font-mono gb-secondary ${TYPE.micro}`}>
							{r.when}
						</div>
					</li>
				))}
			</ul>
		</div>
	);
}
// ============================================================================================
// Hero: one photo, three things pinned to the map.
// ============================================================================================
function Hero({ d }: { d: TerrainData | null }) {
	const photo = useGipfelbuchPhoto("demo-03");
	const crop: [number, number, number, number] = [0, 300, 800, 900];
	const peak = photo?.peaks.find((p) => p.name === "Blüemlisalphorn")?.solved;
	return (
		<Figure
			label="Fig. 1"
			bleed
			caption={
				<>
					{d
						? `Three things in this photo are pinned to the map; a typical peak moves ${d.peakRule.medianMoveMapterhorn} m onto its summit.`
						: "Three things in this photo are pinned to the map."}{" "}
					Fixed: demo-03, with hand-placed marks.{" "}
					<PhotoMeasured data={photo}>
						Peak moves: {d?.script ?? "scripts/gipfelbuch/data-terrain.ts"}.
					</PhotoMeasured>
				</>
			}
		>
			<RealPhoto bleed data={photo} layers={[]} crop={crop}>
				{() => (
					<g>
						<Mark x={400} y={850} n={1} k={2} />
						{peak && (
							<>
								<Mark x={peak[0]} y={peak[1]} n={2} k={2} />
								<HandLabel
									x={peak[0] - 26}
									y={peak[1] + 8}
									anchor="end"
									size={16}
									color="#fff"
									halo={4}
									haloColor="rgba(12,14,18,.85)"
									mono={false}
									condensed
								>
									Blüemlisalphorn
								</HandLabel>
							</>
						)}
						<Mark x={300} y={790} n={3} k={2} />
						<HandText x={420} y={846} size={22} rotate={-2}>
							eye never below the ground
						</HandText>
						{d && (
							<HandText x={300} y={760} size={22} anchor="end" rotate={2}>
								{`typical peak climbs ${d.peakRule.medianMoveMapterhorn} m`}
							</HandText>
						)}
					</g>
				)}
			</RealPhoto>
			<MarkList
				items={[
					<>
						<strong className="gb-ink">The camera</strong> is never below the
						ground. {link("eye-rule", "Eye rule")}
					</>,
					<>
						<strong className="gb-ink">Peaks</strong> climb to the highest map
						point nearby. {link("peak", "Peak")}
					</>,
					<>
						<strong className="gb-ink">Depth</strong> is bent onto the map's
						distances. {link("dem-anchoring", "DEM anchoring")}
					</>,
				]}
			/>
		</Figure>
	);
}

function MiniSvg({
	children,
	label,
}: {
	children: React.ReactNode;
	label: string;
}) {
	return (
		<svg
			viewBox="0 0 200 130"
			className="block h-auto w-full"
			role="img"
			aria-label={label}
		>
			{children}
		</svg>
	);
}
const HILL =
	"M0 110 C40 100 60 40 100 36 C140 32 160 90 200 100 L200 130 L0 130Z";
const HILL_RIDGE = "M0 110 C40 100 60 40 100 36 C140 32 160 90 200 100";

function MiniSnap() {
	return (
		<MiniSvg label="A peak label jumps from beside the summit onto it">
			<Hachure d={HILL} seed="mini-snap-hill" color="brown" gap={6} />
			<SketchPath
				d={HILL_RIDGE}
				seed="mini-snap-ridge"
				color="brown"
				width={1.6}
			/>
			<PenCircle
				seed="mini-snap-osm"
				center={[150, 64]}
				radiusX={6}
				color="pencil"
				width={1.6}
			/>
			<PenArrow
				seed="mini-snap-move"
				from={[145, 61]}
				to={[106, 40]}
				color="red"
				width={1.4}
				dash="3 3"
			/>
			<HandDot
				x={100}
				y={36}
				r={4.5}
				seed="mini-snap-top"
				color="red"
				opacity={1}
			/>
			<HandLabel x={152} y={52} size={12} color="var(--gb-secondary)">
				OSM node
			</HandLabel>
			<HandLabel x={100} y={24} anchor="middle" size={12}>
				summit
			</HandLabel>
		</MiniSvg>
	);
}
function MiniBound() {
	return (
		<MiniSvg label="An eye kept above the lake level">
			<Hachure
				d="M0 80H200V130H0Z"
				seed="mini-bound-lake"
				color="blue"
				gap={5}
			/>
			<PenLine
				seed="mini-bound-level"
				from={[0, 80]}
				to={[200, 80]}
				color="blue"
				width={1.6}
			/>
			<PenLine
				seed="mini-bound-floor"
				from={[0, 70]}
				to={[200, 70]}
				color="pencil"
				width={1.2}
				dash="4 3"
			/>
			<PenCircle
				seed="mini-bound-below"
				center={[100, 94]}
				radiusX={6}
				color="pencil"
				width={1.4}
			/>
			<PenArrow
				seed="mini-bound-lift"
				from={[100, 86]}
				to={[100, 75]}
				color="ink"
				width={1.3}
			/>
			<HandDot
				x={100}
				y={66}
				r={4.5}
				seed="mini-bound-eye"
				color="red"
				opacity={1}
			/>
			<HandLabel
				x={196}
				y={64}
				anchor="end"
				size={12}
				color="var(--gb-secondary)"
			>
				level + 0.3 m
			</HandLabel>
			<HandLabel x={196} y={100} anchor="end" size={12} color="var(--gb-water)">
				lake
			</HandLabel>
		</MiniSvg>
	);
}
function MiniPrior() {
	const pts = Array.from({ length: 41 }, (_, i) => {
		const x = 20 + i * 4.5;
		return `${i ? "L" : "M"}${x.toFixed(1)} ${(110 - 80 * Math.exp(-(((x - 100) / 30) ** 2))).toFixed(1)}`;
	}).join("");
	return (
		<MiniSvg label="A soft bump of likely heights, not a single point">
			<PenLine
				seed="mini-prior-axis"
				from={[10, 110]}
				to={[190, 110]}
				color="ink"
				width={1.2}
			/>
			<Hachure
				d={`${pts}L190 110L20 110Z`}
				seed="mini-prior-bump"
				color="pencil"
				gap={5}
				opacity={0.6}
			/>
			<SketchPath d={pts} seed="mini-prior-curve" color="pencil" width={1.8} />
			<PenLine
				seed="mini-prior-mid"
				from={[100, 30]}
				to={[100, 110]}
				color="faint"
				width={1}
				dash="3 3"
			/>
			<HandLabel x={106} y={26} size={12}>
				soft hint
			</HandLabel>
		</MiniSvg>
	);
}

export default function Page({ node }: { node: GipfelbuchNode }) {
	void node;
	const d = useTerrainData();
	const gaps = d?.eyes.map((e) => e.groundMapterhorn - e.groundTerrarium);
	return (
		<>
			<Hero d={d} />

			<Beat
				kicker="The idea"
				title="The map is the referee for everything we place."
			>
				<p>
					A photo brings a GPS spot, maybe an altitude, and named peaks. None of
					them agree exactly with the terrain the solver measures.
				</p>
				<p>
					<HandMark type="highlight">
						We trust the map only where it is plainly better.
					</HandMark>{" "}
					Elsewhere it gives a floor or a hint. In Fig. 1,{" "}
					<CircledNumber value={1} seed="ts-p1" /> is the camera,{" "}
					<CircledNumber value={2} seed="ts-p2" /> a peak and{" "}
					<CircledNumber value={3} seed="ts-p3" /> the depth.
					{d && (
						<MarginNote mark="a">
							{`I notice a typical peak moves ${d.peakRule.medianMoveMapterhorn} m, the 90th percentile ${d.peakRule.p90MoveMapterhorn} m.`}
						</MarginNote>
					)}
				</p>
			</Beat>

			<Beat kicker="Three roles" title="Snap it, bound it, or hint at it.">
				<Trio
					steps={[
						{
							title: "Snap",
							body: "The map is clearly right: move the thing onto it. Peaks do this.",
							visual: <MiniSnap />,
						},
						{
							title: "Bound",
							body: "The map only rules out a region: keep the eye above the lake.",
							visual: <MiniBound />,
						},
						{
							title: "Hint",
							body: "The sensor still knows something: GPS altitude stays a soft hint.",
							visual: <MiniPrior />,
						},
					]}
				/>
			</Beat>

			<PhotoStory
				number="Fig. 2"
				bleed={false}
				title="Names snap onto their summits"
			/>

			<Beat
				kicker="Peaks"
				title="Map peaks sit beside their summits; we climb them."
			>
				<p>
					Named peaks come from OpenStreetMap, often a few dozen metres off the
					real top. We look in a square around the node, wider for far peaks,
					and move it to the{" "}
					<HandMark type="underline">highest map point</HandMark>. In Fig. 3,{" "}
					<CircledNumber value={1} color="ink" seed="ts-p-n1" /> is the OSM node
					and <CircledNumber value={2} seed="ts-p-n2" /> the summit it climbs
					to.
					<MarginNote mark="b">
						Why 9 by 9? Enough samples to find the crest inside the square.
					</MarginNote>
				</p>
				<SnapEquation d={d} />
			</Beat>

			<PeakReal d={d} />

			<Beat
				kicker="Where it fails"
				title="The answer depends on which map you ask."
			>
				<p>
					Two elevation maps put the same spot at different heights. The eye
					lift changes with them.{" "}
					<HandMark type="double">
						Treating a hint as a snap would throw the measurement away.
					</HandMark>
					<MarginNote mark="c">
						Which map is right? Neither is a true eye height, so none can score
						the lift.
					</MarginNote>
				</p>
				{gaps && (
					<p>
						<HandMark type="strike">Ground is ground, whichever map.</HandMark>{" "}
						<span
							className="nb-hand"
							style={{ color: "var(--nb-red)", fontSize: "1.25em" }}
						>
							{`They differ by ${Math.round(Math.min(...gaps))} to ${Math.round(Math.max(...gaps))} m.`}
						</span>
					</p>
				)}
			</Beat>

			<RealEye d={d} />

			<Numbers
				items={[
					{
						value: d ? `${d.peakRule.medianMoveMapterhorn} m` : "…",
						label: `median peak move (${d?.peakRule.n ?? "…"} named peaks within 40 km)`,
					},
					{
						value: d ? `${d.peakRule.p90MoveMapterhorn} m` : "…",
						label: "90th-percentile peak move",
					},
					{
						value: gaps
							? `${Math.round(Math.min(...gaps))} to ${Math.round(Math.max(...gaps))} m`
							: "…",
						label: "two maps' ground height at the same 12 GPS fixes",
					},
					{
						value: "0.13",
						label:
							"median depth error after anchoring, in log units (about 14%), 23 photos; one scale gives 0.34",
					},
				]}
				source={
					<>
						Peaks and ground:{" "}
						{d?.script ?? "scripts/gipfelbuch/data-terrain.ts"}, Mapterhorn and
						Terrarium. Depth: reports/step-inside-results.md.
					</>
				}
			/>

			<Details>
				<h3>Every place a coordinate meets the map</h3>
				<Ledger />
				<h3>Eye height</h3>
				<p>
					<code>eyeAltitude</code> keeps the GPS altitude unless it is below
					standing height over the DEM, then uses <code>DEM + 1.6 m</code>; with
					no altitude it uses <code>DEM + 1.8 m</code>. It only ever lifts the
					eye, so a barometer-aided altitude above the ground survives. Over
					Lake Thun the DEM's flat water cells read{" "}
					{d?.lake.terrariumMin ?? "…"} m (Terrarium) and{" "}
					{d?.lake.mapterhornMin ?? "…"} m (Mapterhorn), so the lake bound is a
					fixed level + 0.3 m rather than the DEM value. One metre of eye height
					moves a ridge 500 m away by about 0.11° (atan 1/500), about 6 px in a
					4000 px frame at 26 mm equivalent. Near a summit the horizontal fix
					can land up-slope and <code>DEM + 1.6</code> then puts the eye 5 to 20
					m too high; the concord eye prior (<code>?concord=eye</code>) treats
					the altitude as a measurement through an iso-band and never snaps.
				</p>
				<p>
					The frame's origin matters too: the renderer's ENU frame sits at sea
					level, with the eye at <code>(0, 0, eyeAlt)</code>. A solver handed
					the default position prior <code>[0, 0, 0]</code> projects from sea
					level, which a regression test measured at about 3° of pitch and roll
					(<code>src/lib/pose6dof/README.md</code>).
				</p>
				<h3>Peaks</h3>
				<p>
					<code>buildPeaks</code> moves every peak between 150 m and 110 km to{" "}
					<code>localMax</code>: the highest of a 9×9 grid of DEM samples
					spanning ±r around the node, <code>r = min(250, 60 + 0.004·d)</code>{" "}
					metres. The radius grows 4 m per kilometre, from 60 m near the camera
					to the 250 m cap at 47.5 km. The search starts at the node's own
					height, so a sample must be strictly higher to win. Visibility tests
					against the DEM need the peak on the terrain, not floating.
				</p>
				<h3>Near-field depth</h3>
				<p>
					{link("dem-anchoring", "DEM anchoring")} fits a monotone log-log curve
					from model ray length to DEM range over terrain pixels between 15 m
					and 3 km (sky and people masked), by dynamic programming under a
					truncated L1 loss. Quality is{" "}
					<code>inlierFrac · exp(−(err/0.2)²)</code>; below 0.35 the view is low
					trust, below 0.15 hidden. Neither is a pose check. Each object is then
					scaled to the DEM range where it touches the terrain.
				</p>
				<h3>Curvature is not a snap</h3>
				<p>
					{link("curvature-refraction", "Curvature and refraction")} lower every
					DEM sample by <code>d² / (2 R_eff)</code>,{" "}
					<code>R_eff = R / (1 − 0.13)</code>: under a metre at 3 km, about 680
					m at 100 km.
				</p>
				<p>
					<strong>Lesson.</strong> Snap only what the DEM knows better than the
					sensor. A lake level only rules out the water below it, so it is a
					bound. A GPS altitude is still evidence, so it stays a prior.
				</p>
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/deck/engine.ts" />
					<CodeRef path="src/lib/deck/scene.ts" />
					<CodeRef path="src/lib/dem/height-from-tile.ts" />
					<CodeRef path="src/lib/geo/horizon.ts" />
					<CodeRef path="src/lib/geocam/lakes/floor.ts" />
					<CodeRef path="src/lib/concord/priors/altitude.ts" />
					<CodeRef path="src/lib/nearfield/anchor.ts" />
					<CodeRef path="src/lib/nearfield/ground.ts" />
					<CodeRef path="src/lib/nearfield/near-dem.ts" />
				</div>
			</Details>
		</>
	);
}
