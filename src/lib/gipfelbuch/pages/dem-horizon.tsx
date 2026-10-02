// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { memo, useMemo, useState } from "react";
import {
	CircledKey,
	HandScaleBar,
	NorthArrow,
} from "#/components/gipfelbuch/notebook/carto";
import {
	exactPolyline,
	Hachure,
	HandDot,
	HandText,
	PenArrow,
	PenCircle,
	PenLine,
	SketchPath,
	Stipple,
} from "#/components/gipfelbuch/notebook/Ink";
import {
	CircledNumber,
	HandMark,
	Wash,
} from "#/components/gipfelbuch/notebook/marks";
import type { Point } from "#/components/gipfelbuch/notebook/sketch";
import { useNotebookPhoto } from "#/components/gipfelbuch/notebook/useNotebookPhoto";
import { SWISS } from "#/components/gipfelbuch/swiss/palette";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import {
	Callout,
	CodeRef,
	DemPatch,
	Eq,
	Figure,
	Frac,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	HandLabel,
	HandRange,
	LAYER_STYLE,
	LivePanorama,
	MarginNote,
	Measured,
	PhotoPicker,
	Plot,
	RealPhoto,
	Steps,
	Sym,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
	useTime,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Details,
	Gallery,
	Key,
	Mark,
	MarkList,
	Numbers,
	Stages,
	skylineBand,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { SCENE, sectionHeight } from "#/components/gipfelbuch/viz/scene";
import { cameraFromAngles, directionENU, project } from "#/lib/geo/camera";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

/** Dark under-stroke for anything drawn on a photograph. */
const PHOTO_DARK = "rgba(12, 14, 18, 0.85)";

/** A measured line: one bounded pen pass on its pixels (SketchPath data). */
function DataLine({
	d,
	color,
	width,
	dash,
	opacity,
}: {
	d: string;
	color: string;
	width: number;
	dash?: string;
	opacity?: number;
}) {
	return (
		<SketchPath
			d={d}
			seed={`dh-data-${d.length}-${d.slice(0, 40)}`}
			data
			color={color}
			width={width}
			dash={dash}
			opacity={opacity}
		/>
	);
}

// DEM Horizon: how src/lib/geo/horizon.ts turns terrain into a 360 degree skyline.
// Mechanism constants are the real defaults in computeHorizon():
//   step 0.05 deg (7,200 azimuths), minDistance 20 m, maxDistance 150 km, ray step max(10 m, 0.4 % of d),
//   minOcclusion 0.08, angle = atan2(h - eye - d^2 / (2 R'), d), R' = R / (1 - k), k = 0.13 (geodesy.ts).
// "Measured" figures use the real computeHorizon output on the Niederhorn demo photos (public/demo/gipfelbuch,
// scripts/gipfelbuch/build-data.ts); the profile is the real 7,200-azimuth result sampled every 0.5 deg over the view.
// The two terrains below are synthetic and deterministic; every angle, drop and crest is computed from them by the
// same loop as the code (coarser ray step in the demo, so it stays light).

const R_EFF = 6371008.8 / (1 - 0.13);
const DEG = 180 / Math.PI;
const drop = (d: number) => (d * d) / (2 * R_EFF);
const MIN_OCC = 0.08;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const sgn = (v: number, d = 1) =>
	`${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;

// =====================================================================================
// Fig. D1: one ray, marched over real ground: demo-09's terrain section along its solved bearing (116.1°)
// from the Niederhorn towards the Schreckhorn (viz/scene.ts, pod D rule D1). The march loop is the
// code's; only its step is coarser (1 % of distance, the app 0.4 %).
// =====================================================================================
const EYE = SCENE.eye.m;
const DMAX = SCENE.section.points[SCENE.section.points.length - 1][0];
const terrainH = (d: number) => sectionHeight(d);

interface Sample {
	d: number;
	h: number;
	angle: number;
	best: number;
	bestD: number;
	isBest: boolean;
}
interface RayRun {
	samples: Sample[];
	crests: { d: number; angle: number; h: number }[];
}
/** The inner loop of computeHorizon, for one azimuth. */
function marchRay(curv: boolean): RayRun {
	const samples: Sample[] = [];
	const crests: RayRun["crests"] = [];
	let best = -90;
	let bestD = 0;
	let crest: { d: number; angle: number; h: number } | null = null;
	let prevVisible = false;
	for (let d = 20; d <= DMAX; d += Math.max(10, d * 0.01)) {
		const h = terrainH(d);
		const hEff = h - (curv ? drop(d) : 0);
		const angle = Math.atan2(hEff - EYE, d) * DEG;
		let isBest = false;
		if (angle > best) {
			isBest = true;
			best = angle;
			bestD = d;
			if (!prevVisible && crest && d - crest.d > MIN_OCC * crest.d)
				crests.push(crest);
			crest = { d, angle, h: hEff };
			prevVisible = true;
		} else prevVisible = false;
		samples.push({ d, h: hEff, angle, best, bestD, isBest });
	}
	return { samples, crests };
}
const RAY = { on: marchRay(true), off: marchRay(false) };

const FW = 640;
const FH = 372;
// Label sizes: 11 and 13 px rendered at the text column (~720 px) for this 640-wide viewBox.
const RM_LABEL_SMALL = Math.round(((11 * FW) / 720) * 2) / 2;
const RM_LABEL = Math.round(((13 * FW) / 720) * 2) / 2;
const PX0 = 46;
const PX1 = 628;
const TOP = { y0: 16, y1: 206, lo: 300, hi: 4000 };
const BOT = { y0: 252, y1: 344, lo: -1.5, hi: 4.5 };
const xD = (d: number) => PX0 + (d / DMAX) * (PX1 - PX0);
const yH = (h: number) =>
	TOP.y1 - ((h - TOP.lo) / (TOP.hi - TOP.lo)) * (TOP.y1 - TOP.y0);
const yA = (a: number) =>
	BOT.y1 -
	((clamp(a, BOT.lo, BOT.hi) - BOT.lo) / (BOT.hi - BOT.lo)) * (BOT.y1 - BOT.y0);

const TERRAIN_PATH = (curv: boolean) => {
	const pts: string[] = [];
	for (let d = 0; d <= DMAX; d += 120)
		pts.push(
			`L${xD(d).toFixed(1)} ${yH(terrainH(d) - (curv ? drop(d) : 0)).toFixed(1)}`,
		);
	return `M${PX0} ${TOP.y1 + 10} ${pts.join(" ")} L${PX1} ${TOP.y1 + 10} Z`;
};
const TERRAIN = { on: TERRAIN_PATH(true), off: TERRAIN_PATH(false) };
const TERRAIN_LINE = (curv: boolean): Point[] => {
	const pts: Point[] = [];
	for (let d = 0; d <= DMAX; d += 200)
		pts.push([xD(d), yH(terrainH(d) - (curv ? drop(d) : 0))]);
	return pts;
};
const TERRAIN_PTS = { on: TERRAIN_LINE(true), off: TERRAIN_LINE(false) };
const WEDGE_BOX = `M${PX0} ${TOP.y0 - 6}L${PX1} ${TOP.y0 - 6}L${PX1} ${TOP.y1}L${PX0} ${TOP.y1}Z`;
// Full-run series, drawn once and revealed by a moving clip (no re-sketching per frame).
const runPoints = (run: RayRun, every: number, y: (s: Sample) => number) =>
	run.samples
		.filter((_, i) => i % every === 0 || i === run.samples.length - 1)
		.map((s): Point => [xD(s.d), y(s)]);
const ANGLE_PTS = {
	on: runPoints(RAY.on, 2, (s) => yA(s.angle)),
	off: runPoints(RAY.off, 2, (s) => yA(s.angle)),
};
const STAIR_PTS = {
	on: runPoints(RAY.on, 3, (s) => yA(s.best)),
	off: runPoints(RAY.off, 3, (s) => yA(s.best)),
};

function RayMarch() {
	const [ref, t] = useTime<HTMLDivElement>(9.5);
	const [curv, setCurv] = useState(true);
	const [manual, setManual] = useState<number | null>(null);
	const run = curv ? RAY.on : RAY.off;
	const other = curv ? RAY.off : RAY.on;

	const ph = Math.min(t, 9.5); // marches once, rests on the finished horizon
	const auto = clamp(ph / 9.5, 0, 1) * DMAX;
	const cur = manual ?? auto;
	let idx = 0;
	while (idx < run.samples.length - 1 && run.samples[idx + 1].d <= cur) idx++;
	const S = run.samples[idx];
	const upto = run.samples.slice(0, idx + 1);
	const done = idx >= run.samples.length - 2;
	const finalBest = run.samples[run.samples.length - 1];
	const otherBest = other.samples[other.samples.length - 1];
	const crests = run.crests.filter((c) => c.d <= S.d);
	const newBests = upto.filter((s) => s.isBest);

	const tanB = Math.tan((S.best * Math.PI) / 180);
	const lineEnd = DMAX;
	const wedge = `M${xD(0)} ${yH(EYE)} L${xD(lineEnd)} ${yH(EYE + lineEnd * tanB)} L${xD(lineEnd)} ${TOP.y1} L${xD(0)} ${TOP.y1} Z`;
	const flips = Math.abs(finalBest.bestD - otherBest.bestD) > 2000;

	return (
		<Figure
			label="Fig. D1"
			bleed
			pinned={SCENE.id}
			caption={`Real ground, real method: the terrain under the landing photo's view, from the Niederhorn (${SCENE.eye.m.toLocaleString("en")} m) across Lake Thun, along the solved bearing (116.1°, 0.9° left of the Schreckhorn). One bearing, marched step by step (here every 1 % of distance, in the app 0.4 %). Top: ground height with Earth curvature and refraction, and the best sight line so far. Bottom: the elevation angle of each sample; the running maximum becomes the horizon. Curvature lowers this horizon from ${RAY.off.samples[RAY.off.samples.length - 1].best.toFixed(2)}° to ${RAY.on.samples[RAY.on.samples.length - 1].best.toFixed(2)}°.`}
		>
			<div ref={ref}>
				<svg
					viewBox={`0 0 ${FW} ${FH}`}
					className="block h-auto w-full"
					role="img"
					aria-label="Side view of a ray marched over terrain with its running-maximum elevation angle"
				>
					<defs>
						<clipPath id="dh-clipb">
							<rect
								x={PX0}
								y={BOT.y0 - 4}
								width={PX1 - PX0}
								height={BOT.y1 - BOT.y0 + 8}
							/>
						</clipPath>
						<clipPath id="dh-clipt">
							<rect
								x={PX0}
								y={TOP.y0 - 6}
								width={PX1 - PX0}
								height={TOP.y1 - TOP.y0 + 16}
							/>
						</clipPath>
						<clipPath id="dh-wedge">
							<path d={wedge} />
						</clipPath>
						<clipPath id="dh-prog">
							<rect
								x={PX0}
								y={BOT.y0 - 4}
								width={Math.max(0, xD(S.d) - PX0)}
								height={BOT.y1 - BOT.y0 + 8}
							/>
						</clipPath>
					</defs>
					{/* grid: faint pen rules, tick numbers in mono */}
					{[0, 5, 10, 15, 20, 25, 30].map((km) => (
						<g key={km}>
							<PenLine
								from={[xD(km * 1000), TOP.y0 - 6]}
								to={[xD(km * 1000), BOT.y1]}
								seed={`dh-rm-grid-${km}`}
								color="faint"
								width={0.5}
							/>
							<HandLabel
								x={xD(km * 1000)}
								y={BOT.y1 + 16}
								anchor="middle"
								size={RM_LABEL_SMALL}
								color={SWISS.pencil}
								halo={0}
							>
								{km}
								{km === 30 ? " km" : ""}
							</HandLabel>
						</g>
					))}
					<PenLine
						from={[PX0, TOP.y1 + 10]}
						to={[PX1, TOP.y1 + 10]}
						seed="dh-rm-axis-top"
						width={1.2}
					/>
					<PenLine
						from={[PX0, BOT.y1]}
						to={[PX1, BOT.y1]}
						seed="dh-rm-axis-bot"
						width={1.2}
					/>
					<g clipPath="url(#dh-clipt)">
						<Hachure
							d={TERRAIN[curv ? "on" : "off"]}
							seed={`dh-rm-land-${curv ? "on" : "off"}`}
							color="brown"
							gap={5}
							opacity={0.55}
						/>
						<DataLine
							d={exactPolyline(TERRAIN_PTS[curv ? "on" : "off"])}
							color={SWISS.contour}
							width={1.6}
						/>
						<g clipPath="url(#dh-wedge)">
							<Stipple
								d={WEDGE_BOX}
								seed="dh-rm-wedge"
								color="pencil"
								spacing={9}
								opacity={0.45}
							/>
						</g>
						<PenLine
							from={[xD(0), yH(EYE)]}
							to={[xD(lineEnd), yH(EYE + lineEnd * tanB)]}
							seed="dh-rm-sight"
							color="ink"
							width={1.4}
							dash="5 4"
						/>
						{/* the sample the marcher is on */}
						<PenLine
							from={[xD(0), yH(EYE)]}
							to={[xD(S.d), yH(S.h)]}
							seed="dh-rm-sample"
							color="pencil"
							width={0.9}
						/>
						{newBests.map((s) => (
							<HandDot
								key={s.d}
								x={xD(s.d)}
								y={yH(s.h)}
								r={2.2}
								seed={`dh-rm-best-${curv ? "on" : "off"}-${s.d.toFixed(0)}`}
								data
								color="ink"
							/>
						))}
						{crests.map((c) => (
							<PenCircle
								key={c.d}
								center={[xD(c.d), yH(c.h)]}
								radiusX={6}
								seed={`dh-rm-crest-${curv ? "on" : "off"}-${c.d.toFixed(0)}`}
								data
								width={1.4}
							/>
						))}
						<HandDot
							x={xD(S.bestD)}
							y={yH(EYE + S.bestD * tanB)}
							r={4.5}
							seed="dh-rm-bestnow"
							data
							color="red"
						/>
						<HandDot
							x={xD(S.d)}
							y={yH(S.h)}
							r={3.2}
							seed="dh-rm-now"
							data
							color="ink"
						/>
					</g>
					<HandDot x={xD(0)} y={yH(EYE)} r={4} seed="dh-rm-eye" color="ink" />
					<HandLabel
						x={PX0 + 10}
						y={yH(EYE) - 9}
						size={RM_LABEL}
						color={SWISS.ink}
					>
						Niederhorn
					</HandLabel>
					<HandLabel
						x={PX1 - 4}
						y={TOP.y0 + 10}
						anchor="end"
						size={RM_LABEL}
						color={SWISS.secondary}
					>
						{curv ? "height minus Earth drop" : "height (flat earth)"}
					</HandLabel>
					{/* bottom panel */}
					{[0, 2, 4].map((a) => (
						<g key={a}>
							<PenLine
								from={[PX0, yA(a)]}
								to={[PX1, yA(a)]}
								seed={`dh-rm-agrid-${a}`}
								color="faint"
								width={0.5}
							/>
							<HandLabel
								x={PX0 - 6}
								y={yA(a) + 3}
								anchor="end"
								size={RM_LABEL_SMALL}
								color={SWISS.pencil}
								halo={0}
							>
								{a}&deg;
							</HandLabel>
						</g>
					))}
					<g clipPath="url(#dh-prog)">
						<DataLine
							d={exactPolyline(ANGLE_PTS[curv ? "on" : "off"])}
							color={SWISS.pencil}
							width={1.2}
						/>
						<DataLine
							d={exactPolyline(STAIR_PTS[curv ? "on" : "off"])}
							color={SWISS.red}
							width={2.2}
						/>
					</g>
					<PenLine
						from={[xD(S.d), BOT.y0 - 4]}
						to={[xD(S.d), BOT.y1 + 4]}
						seed="dh-rm-cursor"
						color="faint"
						width={0.9}
					/>
					<HandText
						x={PX1 - 4}
						y={BOT.y0 + 10}
						anchor="end"
						size={14}
						color="red"
					>
						running max = horizon
					</HandText>
					<PenArrow
						from={[xD(S.bestD) + 46, TOP.y0 + 34]}
						to={[xD(S.bestD) + 6, yH(EYE + S.bestD * tanB) - 6]}
						seed="dh-rm-best-arrow"
						color="pencil"
						width={1}
					/>
					<HandText
						x={xD(S.bestD) + (xD(S.bestD) > PX1 - 240 ? -50 : 50)}
						y={TOP.y0 + 32}
						anchor={xD(S.bestD) > PX1 - 240 ? "end" : "start"}
						size={16}
						color="pencil"
						rotate={-2}
					>
						{`best so far: ${S.best.toFixed(2)}° at ${(S.bestD / 1000).toFixed(1)} km`}
					</HandText>
					{flips && done && (
						<>
							<CircledKey
								x={PX0 + 20}
								y={BOT.y1 - 16}
								value={1}
								seed="dh-rm-key1"
							/>
							<HandText x={PX0 + 36} y={BOT.y1 - 10} size={16} color="pencil">
								flat earth would crown a different ridge
							</HandText>
						</>
					)}
					<HandLabel
						x={PX0 + 6}
						y={BOT.y0 + 10}
						size={RM_LABEL}
						color={SWISS.secondary}
					>
						elevation angle of each sample
					</HandLabel>
				</svg>

				<div className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-[1fr_auto]">
					<div className="block">
						<span
							className={`flex justify-between font-mono ${TYPE.micro} gb-secondary`}
						>
							<span>distance along the ray</span>
							<span className="text-[var(--gb-ink)]">
								{(S.d / 1000).toFixed(1)} km
							</span>
						</span>
						<HandRange
							min={0}
							max={DMAX}
							step={100}
							value={cur}
							label="Distance along the ray"
							onChange={setManual}
						/>
					</div>
					<div
						className={`flex flex-wrap items-end gap-2 font-mono ${TYPE.micro}`}
					>
						<button
							type="button"
							onClick={() => setCurv((v) => !v)}
							className={`px-3 py-1.5 ${curv ? "bg-[var(--gb-ink)] text-[var(--gb-paper)]" : "bg-[var(--gb-paper-deep)] text-[var(--gb-ink)]"}`}
							aria-pressed={curv}
						>
							curvature + refraction {curv ? "on" : "off"}
						</button>
						{manual != null && (
							<button
								type="button"
								onClick={() => setManual(null)}
								className="bg-[var(--gb-paper-deep)] px-3 py-1.5 gb-secondary hover:text-[var(--gb-ink)]"
							>
								release
							</button>
						)}
					</div>
				</div>
				<dl
					className={`mt-3 grid grid-cols-2 gap-x-6 gap-y-2 font-mono ${TYPE.micro} sm:grid-cols-4`}
				>
					<Read k="this sample" v={`${sgn(S.angle, 2)}°`} />
					<Read
						k="drop at d"
						v={curv ? `${drop(S.d).toFixed(0)} m` : "0 m (off)"}
					/>
					<Read
						k="horizon so far"
						v={`${sgn(S.best, 2)}° at ${(S.bestD / 1000).toFixed(1)} km`}
					/>
					<Read k="ridges behind" v={String(crests.length)} />
				</dl>
				{done && (
					<p className={`mt-3 ${TYPE.caption} gb-secondary`}>
						{curv ? "With" : "Without"} the Earth bending away, this ray&rsquo;s
						horizon is{" "}
						<span className="text-[var(--gb-ink)]">
							{(finalBest.bestD / 1000).toFixed(1)} km
						</span>{" "}
						out at {sgn(finalBest.best, 2)}&deg;
						{flips
							? `; the other setting would put it at ${(otherBest.bestD / 1000).toFixed(1)} km, ${sgn(otherBest.best, 2)}°.`
							: "."}
					</p>
				)}
			</div>
		</Figure>
	);
}

function Read({ k, v }: { k: string; v: string }) {
	return (
		<div>
			<dt className="gb-secondary">{k}</dt>
			<dd className={`${TYPE.caption} text-[var(--gb-ink)]`}>{v}</dd>
		</div>
	);
}

// =====================================================================================
// Fig. 2: the azimuth sweep: top-down relief on the left, the skyline growing on the right
// =====================================================================================
const EYE2 = 1400;
// [east km, north km, summit m, sigma km]
const PEAKS: [number, number, number, number][] = [
	[2, 6, 2200, 0.9],
	[-6, 9, 2600, 1.2],
	[11, 4, 2900, 1.5],
	[14, -9, 3300, 1.8],
	[-12, -5, 2400, 1.3],
	[-3, -14, 3000, 1.6],
	[5, 18, 3400, 2.0],
	[-17, 15, 3600, 2.2],
	[24, 8, 3800, 2.4],
	[-24, -10, 3500, 2.2],
	[0, -28, 3900, 2.5],
	[-9, 26, 3300, 2.0],
	[20, -20, 3500, 2.3],
];
function height2(x: number, y: number) {
	let e =
		1350 + 120 * Math.sin(x * 0.9 + y * 0.4) + 90 * Math.sin(y * 1.3 - x * 0.5);
	for (const [px, py, H, s] of PEAKS) {
		const dx = (x - px) / s;
		const dy = (y - py) / s;
		const q = dx * dx + dy * dy;
		if (q < 14) e = Math.max(e, H * Math.exp(-q * 0.5));
	}
	return e;
}
const NAZ = 360;
const MAXKM = 40;
interface Sky {
	elev: number[];
	dist: number[];
	ridges: { az: number; angle: number; d: number }[];
}
let skyCache: Sky | null = null;
function sky(): Sky {
	if (skyCache) return skyCache;
	const elev: number[] = [];
	const dist: number[] = [];
	const ridges: Sky["ridges"] = [];
	const ds: number[] = [];
	for (let d = 0.1; d <= MAXKM; d += Math.max(0.05, d * 0.02)) ds.push(d);
	for (let i = 0; i < NAZ; i++) {
		const az = (i / NAZ) * 2 * Math.PI;
		const sx = Math.sin(az);
		const sy = Math.cos(az);
		let best = -90;
		let bd = 0;
		let crest: { d: number; angle: number } | null = null;
		let prev = false;
		for (const d of ds) {
			const h = height2(sx * d, sy * d);
			const angle = Math.atan2(h - EYE2 - drop(d * 1000), d * 1000) * DEG;
			if (angle > best) {
				if (!prev && crest && d - crest.d > MIN_OCC * crest.d)
					ridges.push({ az: i, angle: crest.angle, d: crest.d });
				best = angle;
				bd = d;
				crest = { d, angle };
				prev = true;
			} else prev = false;
		}
		elev.push(best);
		dist.push(bd);
	}
	skyCache = { elev, dist, ridges };
	return skyCache;
}

const MS = 300; // map svg size
const MR = 136; // map radius px for MAXKM
const mx = (km: number) => MS / 2 + (km / MAXKM) * MR;
const my = (km: number) => MS / 2 - (km / MAXKM) * MR;

const TRAIL_CHUNK = 30;
const PW = 560;
const PH = 200;
const SW_LO = -4;
const SW_HI = 24;
const ax = (i: number) => 28 + (i / NAZ) * (PW - 36);
const ay = (a: number) =>
	PH - 22 - ((clamp(a, SW_LO, SW_HI) - SW_LO) / (SW_HI - SW_LO)) * (PH - 40);

/** A pen ring for one ridge crest; memoised so the sweep does not re-sketch it every frame. */
const RidgeRing = memo(function RidgeRing({
	x,
	y,
	seed,
}: {
	x: number;
	y: number;
	seed: string;
}) {
	return (
		<PenCircle center={[x, y]} radiusX={2.8} seed={seed} width={1.1} data />
	);
});

/** Static furniture of the top-down map: contours round each summit, range rings, compass letters. */
const SweepMapBase = memo(function SweepMapBase() {
	const cardinal = ["N", "E", "S", "W"];
	return (
		<g>
			{PEAKS.map(([x, y, H, s]) => {
				const r0 = (s * 2.2 * MR) / MAXKM;
				const rings = H > 3300 ? 3 : 2;
				return [0, 0.34, 0.68]
					.slice(0, rings)
					.map((cut) => (
						<PenCircle
							key={`${x},${y},${cut}`}
							center={[mx(x), my(y)]}
							radiusX={r0 * (1 - cut)}
							seed={`dh-sw-contour-${x},${y}-${cut}`}
							color="brown"
							width={cut === 0 ? 0.8 : 1.1}
						/>
					));
			})}
			{[10, 20, 30, 40].map((km) => (
				<PenCircle
					key={km}
					center={[MS / 2, MS / 2]}
					radiusX={(km / MAXKM) * MR}
					seed={`dh-sw-range-${km}`}
					color={km === 40 ? "pencil" : "faint"}
					width={km === 40 ? 1 : 0.6}
					dash={km === 40 ? undefined : "2 4"}
				/>
			))}
			{[0, 1, 2, 3].map((q) => {
				const a = (q * Math.PI) / 2;
				return (
					<HandLabel
						key={q}
						x={MS / 2 + Math.sin(a) * (MR + 11)}
						y={MS / 2 - Math.cos(a) * (MR + 11) + 5}
						anchor="middle"
						size={13}
						color={SWISS.secondary}
					>
						{cardinal[q]}
					</HandLabel>
				);
			})}
			<NorthArrow x={22} y={52} length={24} seed="dh-sw-north" />
			<HandScaleBar
				x={MS - 92}
				y={MS - 12}
				metersPerPixel={(MAXKM * 1000) / MR}
				maxWidth={80}
				segments={2}
				seed="dh-sw-scale"
			/>
		</g>
	);
});

/** Static axes of the unrolled skyline profile. */
const SweepAxesBase = memo(function SweepAxesBase() {
	return (
		<g>
			{[0, 10, 20].map((a) => (
				<g key={a}>
					<PenLine
						from={[28, ay(a)]}
						to={[PW - 8, ay(a)]}
						seed={`dh-sw-agrid-${a}`}
						color={a === 0 ? "ink" : "faint"}
						width={a === 0 ? 1.2 : 0.5}
					/>
					<HandLabel
						x={23}
						y={ay(a) + 3}
						anchor="end"
						size={11}
						color={SWISS.pencil}
						halo={0}
					>
						{a}&deg;
					</HandLabel>
				</g>
			))}
			{[0, 90, 180, 270, 360].map((a) => (
				<HandLabel
					key={a}
					x={ax((a / 360) * NAZ)}
					y={PH - 8}
					anchor="middle"
					size={11}
					color={SWISS.pencil}
					halo={0}
				>
					{a}&deg;
				</HandLabel>
			))}
		</g>
	);
});

function Sweep() {
	const [ref, t] = useTime<HTMLDivElement>(10.5);
	const [manual, setManual] = useState<number | null>(null);
	const S = sky();
	const ph = Math.min(t, 10.5); // sweeps once, rests on the full circle
	const auto = clamp(ph / 10.5, 0, 1) * NAZ;
	const cur = manual ?? auto;
	const k = Math.min(NAZ - 1, Math.floor(cur));
	const full = cur >= NAZ - 1;

	const geo = useMemo(() => {
		const hitAt = (i: number): Point => {
			const a = (i / NAZ) * 2 * Math.PI;
			return [mx(Math.sin(a) * S.dist[i]), my(Math.cos(a) * S.dist[i])];
		};
		const trailPts: Point[] = S.elev.map((_, i) => hitAt(i));
		const trailChunks: Point[][] = [];
		for (let i = 0; i < NAZ - 1; i += TRAIL_CHUNK)
			trailChunks.push(trailPts.slice(i, i + TRAIL_CHUNK + 1));
		const segPts: Point[][] = [];
		for (let i = 1; i < NAZ; i++)
			segPts.push([
				[ax(i - 1), ay(S.elev[i - 1])],
				[ax(i), ay(S.elev[i])],
			]);
		let area = `M${ax(0)} ${PH - 22}`;
		for (let i = 0; i < NAZ; i++)
			area += ` L${ax(i).toFixed(1)} ${ay(S.elev[i]).toFixed(1)}`;
		area += ` L${ax(NAZ - 1).toFixed(1)} ${PH - 22} Z`;
		return { trailPts, trailChunks, segPts, area };
	}, [S]);
	const ridgesShown = S.ridges.filter((r) => r.az <= k);
	const azRad = (cur / NAZ) * 2 * Math.PI;
	const doneChunks = Math.floor(k / TRAIL_CHUNK);
	const trailRest = geo.trailPts.slice(doneChunks * TRAIL_CHUNK, k + 1);

	return (
		<Figure
			label="Fig. D2"
			bleed
			caption={`Invented terrain, real method. Every bearing gets its own ray. Left: the terrain from above, the sweeping ray and where each horizon point sits (the trail). Right: the same rays unrolled into the 360° profile; brighter is nearer, rings are ridges behind the horizon. The app uses ${"7,200"} bearings at 0.05° out to 150 km; this demo uses ${NAZ} at 1° out to ${MAXKM} km.`}
		>
			<div ref={ref}>
				<div className="grid items-center gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
					<svg
						viewBox={`0 0 ${MS} ${MS}`}
						className="mx-auto block h-auto w-full"
						role="img"
						aria-label="Top-down map with a sweeping ray and the skyline trail"
					>
						<SweepMapBase />
						{geo.trailChunks.slice(0, doneChunks).map((pts) => (
							<DataLine
								key={`${pts[0][0].toFixed(1)}-${pts[0][1].toFixed(1)}`}
								d={exactPolyline(pts)}
								color={SWISS.red}
								width={1.6}
							/>
						))}
						{trailRest.length > 1 && (
							<DataLine
								d={exactPolyline(trailRest)}
								color={SWISS.red}
								width={1.6}
							/>
						)}
						{ridgesShown.map((r) => {
							const a = (r.az / NAZ) * 2 * Math.PI;
							return (
								<HandDot
									key={`${r.az}-${r.d}`}
									x={mx(Math.sin(a) * r.d)}
									y={my(Math.cos(a) * r.d)}
									r={1.6}
									seed={`dh-sw-rd-${r.az}-${r.d.toFixed(2)}`}
									data
									color="ink"
								/>
							);
						})}
						{!full && (
							<PenLine
								from={[MS / 2, MS / 2]}
								to={[
									MS / 2 + Math.sin(azRad) * MR,
									MS / 2 - Math.cos(azRad) * MR,
								]}
								seed="dh-sw-ray"
								color="ink"
								width={1.5}
							/>
						)}
						<HandDot x={MS / 2} y={MS / 2} r={4} seed="dh-sw-eye" color="ink" />
					</svg>
					<svg
						viewBox={`0 0 ${PW} ${PH}`}
						className="block h-auto w-full"
						role="img"
						aria-label="The 360 degree skyline profile growing with the sweep"
					>
						<defs>
							<clipPath id="dh-sw-prog">
								<rect x="0" y="0" width={Math.max(0, ax(cur))} height={PH} />
							</clipPath>
						</defs>
						<SweepAxesBase />
						<g clipPath="url(#dh-sw-prog)">
							<Wash d={geo.area} color="brown" seed="dh-wash-1" />
							<Hachure
								d={geo.area}
								seed="dh-sw-area"
								color="brown"
								gap={5}
								opacity={0.5}
							/>
						</g>
						{geo.segPts.slice(0, k).map((pts, i) => (
							<DataLine
								key={pts[0][0]}
								d={exactPolyline(pts)}
								color={SWISS.red}
								width={2}
								opacity={0.35 + 0.65 * (1 - Math.min(1, S.dist[i + 1] / MAXKM))}
							/>
						))}
						{ridgesShown.map((r) => (
							<RidgeRing
								key={`${r.az}-${r.angle}`}
								x={ax(r.az)}
								y={ay(r.angle)}
								seed={`dh-sw-ring-${r.az}-${r.angle.toFixed(2)}`}
							/>
						))}
						<PenLine
							from={[ax(cur), 6]}
							to={[ax(cur), PH - 22]}
							seed="dh-sw-cursor"
							color="faint"
							width={0.9}
						/>
					</svg>
				</div>
				<div className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-[1fr_auto]">
					<div className="block">
						<span
							className={`flex justify-between font-mono ${TYPE.micro} gb-secondary`}
						>
							<span>bearing</span>
							<span className="text-[var(--gb-ink)]">
								{k}&deg; &middot; horizon {sgn(S.elev[k], 1)}&deg; at{" "}
								{S.dist[k].toFixed(1)} km
							</span>
						</span>
						<HandRange
							min={0}
							max={NAZ - 1}
							step={1}
							value={cur}
							label="Azimuth"
							onChange={setManual}
						/>
					</div>
					{manual != null && (
						<button
							type="button"
							onClick={() => setManual(null)}
							className={`self-end bg-[var(--gb-paper-deep)] px-3 py-1.5 font-mono ${TYPE.micro} gb-secondary hover:text-[var(--gb-ink)]`}
						>
							play
						</button>
					)}
				</div>
			</div>
		</Figure>
	);
}

// =====================================================================================
// Measured figures: the real horizon on a real photo
// =====================================================================================
const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;
/** Near = warm yellow, far = cool blue, log scale 0.3 km .. 150 km. */
function distColor(d: number) {
	const t = clamp(Math.log(d / 300) / Math.log(150_000 / 300), 0, 1);
	return `hsl(${lerpN(46, 222, t).toFixed(0)} ${lerpN(80, 85, t).toFixed(0)}% ${lerpN(64, 68, t).toFixed(0)}%)`;
}
const km = (d: number) =>
	d < 10_000 ? `${(d / 1000).toFixed(1)}` : `${Math.round(d / 1000)}`;

function DistLegend() {
	return (
		<div
			className={`flex items-center gap-2 font-mono ${TYPE.micro} gb-secondary`}
		>
			<span>near</span>
			<svg
				viewBox="0 0 112 10"
				className="h-[10px] w-28"
				role="img"
				aria-label="Distance colour scale"
			>
				{Array.from({ length: 28 }, (_, i) => i).map((i) => (
					<rect
						key={i}
						x={i * 4}
						y={0}
						width={4.4}
						height={10}
						style={{
							fill: distColor(300 * (150_000 / 300) ** ((i + 0.5) / 28)),
						}}
					/>
				))}
			</svg>
			<span>far (0.3 to 150 km)</span>
		</div>
	);
}

function viewBand(d: GipfelbuchPhotoData): [number, number, number, number] {
	const { width: W, height: H } = d.photo;
	const ys = d.skyline.rows
		.filter((v): v is number => v != null)
		.sort((a, b) => a - b);
	if (!ys.length) return [0, 0, W, H];
	const lo = ys[Math.floor(ys.length * 0.02)];
	const hi = ys[Math.floor(ys.length * 0.98)];
	const bh = Math.min(H, Math.max(320, hi - lo + 260));
	const y0 = Math.max(0, Math.min(H - bh, lo - 80));
	return [0, Math.round(y0), W, Math.round(y0 + bh)];
}

function useCam(d: GipfelbuchPhotoData | null) {
	return useMemo(() => {
		if (!d) return null;
		const s = d.solved;
		return cameraFromAngles({
			width: d.photo.width,
			height: d.photo.height,
			f: s.f,
			yaw: s.yaw,
			pitch: s.pitch,
			roll: s.roll,
		});
	}, [d]);
}

/** Consecutive segments of similar distance share one pen run (13 colour buckets over log distance). */
function colourRuns<T extends { d: number }>(
	items: T[],
	pointOf: (item: T) => Point | null,
	maxJump: number,
) {
	const bucket = (dist: number) =>
		Math.round(
			clamp(Math.log(dist / 300) / Math.log(150_000 / 300), 0, 1) * 12,
		);
	const runs: { colour: string; points: Point[] }[] = [];
	let current: { colour: string; points: Point[]; b: number } | null = null;
	let last: Point | null = null;
	for (const item of items) {
		const q = pointOf(item);
		if (!q) {
			current = null;
			last = null;
			continue;
		}
		const b = bucket(item.d);
		if (last && Math.abs(q[1] - last[1]) > maxJump) {
			current = null;
		}
		if (!current || current.b !== b) {
			current = {
				colour: distColor(item.d),
				points: current && last ? [last] : [],
				b,
			};
			runs.push(current);
		}
		current.points.push(q);
		last = q;
	}
	return runs.filter((run) => run.points.length > 1);
}

/** Skyline + inner ridge crests, in photo px, coloured by distance. */
function HorizonOverlay({
	d,
	cam,
	k,
}: {
	d: GipfelbuchPhotoData;
	cam: ReturnType<typeof useCam>;
	k: number;
}) {
	const geo = useMemo(() => {
		if (!cam) return null;
		const W = d.photo.width;
		const pts = d.horizon.profile.map((p) => ({
			d: p.d,
			q: project(cam, directionENU(p.az, p.el)),
			ridges: p.ridges,
			az: p.az,
		}));
		const runs = colourRuns(
			pts,
			(p) => (p.q && p.q[0] > -20 && p.q[0] < W + 20 ? p.q : null),
			60,
		);
		const dots = pts.flatMap((p) =>
			p.ridges.flatMap(([el, dd]) => {
				const q = project(cam, directionENU(p.az, el));
				if (!q || q[0] < 0 || q[0] > W || q[1] < 0 || q[1] > d.photo.height)
					return [];
				return [{ q, dd, az: p.az }];
			}),
		);
		return { runs, dots };
	}, [d, cam]);
	if (!geo) return null;
	return (
		<g>
			{geo.runs.map((run) => {
				const d = exactPolyline(run.points);
				return (
					<g key={`h-${run.points[0][0].toFixed(1)}`}>
						<DataLine d={d} color={PHOTO_DARK} width={4.2 * k} />
						<DataLine d={d} color={run.colour} width={2.4 * k} />
					</g>
				);
			})}
			{geo.dots.map((dot) => (
				<HandDot
					key={`r${dot.az}-${dot.dd}`}
					x={dot.q[0]}
					y={dot.q[1]}
					r={3 * k}
					seed={`dh-ridge-dot-${dot.az}-${dot.dd}`}
					data
					color={distColor(dot.dd)}
				/>
			))}
		</g>
	);
}

function ProfilePlot({ d }: { d: GipfelbuchPhotoData }) {
	const prof = d.horizon.profile;
	const a0 = prof[0].az;
	const unwrap = (az: number) => (az < a0 ? az + 360 : az);
	const xs = prof.map((p) => unwrap(p.az));
	const x1 = xs[xs.length - 1];
	const els = prof.map((p) => p.el);
	const ymin = Math.floor(Math.min(...els)) - 6;
	const ymax = Math.ceil(Math.max(...els)) + 2;
	const yaw = unwrap(d.solved.yaw);
	const half = d.solved.hfov / 2;
	return (
		<Plot
			x={[a0, x1]}
			y={[ymin, ymax]}
			width={640}
			height={250}
			xLabel="bearing (° from north)"
			yLabel="elevation (deg)"
			fmtX={(v) => `${Math.round(v) % 360}`}
			fmtY={(v) => `${Math.round(v)}`}
		>
			{(s) => {
				const bx0 = s.x(yaw - half);
				const bx1 = s.x(yaw + half);
				const band = `M${bx0} ${s.box.y0}L${bx1} ${s.box.y0}L${bx1} ${s.box.y1}L${bx0} ${s.box.y1}Z`;
				const runs = colourRuns(
					prof.map((p, i) => ({ d: p.d, x: xs[i], el: p.el })),
					(p) => [s.x(p.x), s.y(p.el)] as Point,
					1e9,
				);
				return (
					<g>
						<Wash d={band} color="blue" seed="dh-wash-2" />
						<HandText
							x={s.x(yaw)}
							y={s.box.y0 + 14}
							anchor="middle"
							size={15}
							color="blue"
						>
							in the photo
						</HandText>
						<HandText
							x={s.x(yaw - half) - 8}
							y={s.box.y1 - 12}
							anchor="end"
							size={15}
							color="pencil"
							rotate={-2}
						>
							cool dots = far ridges: they pin the compass
						</HandText>
						{prof.flatMap((p, i) =>
							p.ridges
								.filter(([el]) => el > ymin)
								.map(([el, dd]) => (
									<HandDot
										key={`${p.az}-${dd}`}
										x={s.x(xs[i])}
										y={s.y(el)}
										r={2.6}
										seed={`dh-prof-dot-${p.az}-${dd}`}
										data
										color={distColor(dd)}
									/>
								)),
						)}
						{runs.map((run) => (
							<DataLine
								key={run.points[0][0].toFixed(1)}
								d={exactPolyline(run.points)}
								color={run.colour}
								width={2.6}
							/>
						))}
					</g>
				);
			}}
		</Plot>
	);
}

function RealHorizon({
	id,
	setId,
	d,
}: {
	id: GipfelbuchPhotoId;
	setId: (i: GipfelbuchPhotoId) => void;
	d: GipfelbuchPhotoData | null;
}) {
	const idx = useGipfelbuchIndex();
	const cam = useCam(d);
	const crop = useMemo(() => (d ? viewBand(d) : undefined), [d]);
	const k = crop && d ? (crop[2] - crop[0]) / d.photo.width : 1;
	const dists = d?.horizon.profile.map((p) => p.d) ?? [];
	const inView = d
		? d.horizon.profile.filter(
				(p) =>
					Math.abs(((p.az - d.solved.yaw + 540) % 360) - 180) <=
					d.solved.hfov / 2,
			)
		: [];
	const nearest = inView.length ? Math.min(...inView.map((p) => p.d)) : 0;
	const farthest = inView.length ? Math.max(...inView.map((p) => p.d)) : 0;
	const nRidge = inView.reduce((a, p) => a + p.ridges.length, 0);
	void dists;
	return (
		<Figure
			label="Fig. 3"
			bleed
			caption={
				<>
					Try any of the 12 photos. Line and dots: the map&rsquo;s horizon and
					the ridges behind it, coloured by distance. Below, the same curve as
					angle against bearing; the shaded band is what the photo sees.{" "}
					<Measured data={d} />
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
							className={`bg-[var(--gb-paper)] px-1 font-mono ${TYPE.micro} gb-ink`}
						>
							{(p.ms.horizon / 1000).toFixed(1)}s
						</span>
					) : null;
				}}
			/>
			<RealPhoto bleed data={d} layers={[]} crop={crop}>
				{(dd) => <HorizonOverlay d={dd} cam={cam} k={k} />}
			</RealPhoto>
			<div className="mt-3 flex flex-wrap items-center justify-between gap-2">
				<DistLegend />
				{d && (
					<span className={`font-mono ${TYPE.micro} gb-secondary`}>
						in view: horizon from{" "}
						<span className="gb-ink">{km(nearest)} km</span> to{" "}
						<span className="gb-ink">{km(farthest)} km</span>, {nRidge} inner
						crests
					</span>
				)}
			</div>
			<div className="mt-3">{d && <ProfilePlot d={d} />}</div>
			{d && (
				<p className={`mt-1 font-mono ${TYPE.micro} gb-secondary`}>
					The full 360° took{" "}
					<span className="gb-ink">{(d.ms.horizon / 1000).toFixed(1)} s</span>.
					The plot shows {d.horizon.profile.length} of 7,200 bearings.
				</p>
			)}
		</Figure>
	);
}
// =====================================================================================
// Explainer page: hero stages, ladder figure, trio, failures, numbers
// =====================================================================================
const median = (v: number[]) => {
	const s = [...v].sort((a, b) => a - b);
	return s.length
		? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2
		: Number.NaN;
};

/** Hero: one real photo, the terrain's skyline drawn from the map alone, then against the photo's own. */
function HeroStages() {
	const [heroId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(heroId);
	const cam = useCam(d);
	const crop = useMemo(() => (d ? viewBand(d) : undefined), [d]);
	const k = crop && d ? (crop[2] - crop[0]) / d.photo.width : 1;
	return (
		<Figure
			label="Fig. 1"
			bleed
			caption={
				<>
					{d
						? `The map's horizon, seen from the solved camera, lands within ${d.residual.solved.median.toFixed(1)} px of the photo's skyline (median, 800 px wide). At the compass guess it was ${d.residual.prior.median.toFixed(0)} px off.`
						: "The map's horizon, seen from the solved camera, lands on the photo's skyline."}{" "}
					<Measured data={d} />
				</>
			}
		>
			<Stages
				stages={[
					{
						label: "Photo",
						frame: "photo",
						caption: "A phone photo, and a height map of the same mountains.",
						render: () => <RealPhoto bleed data={d} layers={[]} crop={crop} />,
					},
					{
						label: "Terrain's horizon",
						frame: "photo",
						caption:
							"We draw the horizon the map predicts. Warm is near, cool is far.",
						render: () => (
							<RealPhoto bleed data={d} layers={[]} crop={crop}>
								{(dd) => <HorizonOverlay d={dd} cam={cam} k={k} />}
							</RealPhoto>
						),
					},
					{
						label: "Against the photo",
						frame: "photo",
						caption: (
							<>
								<Key color={LAYER_STYLE.solved.color}>map</Key> and{" "}
								<Key color={LAYER_STYLE.skyline.color}>photo</Key> nearly
								coincide.
							</>
						),
						render: () => (
							<RealPhoto
								bleed
								data={d}
								layers={["skyline", "solved"]}
								crop={crop}
							/>
						),
					},
				]}
			/>
		</Figure>
	);
}

/** Best sight line over the profile along the view axis, with the Earth's drop scaled by c (0 flat, 1 real). */
function sight(d: GipfelbuchPhotoData, c: number) {
	const eye = d.gps.eye;
	let el = -90;
	let dist = 0;
	let h = 0;
	for (const [dd, hh] of d.terrainProfile.points) {
		if (dd < 20) continue;
		const a = Math.atan2(hh - eye - c * drop(dd), dd) * DEG;
		if (a > el) {
			el = a;
			dist = dd;
			h = hh - c * drop(dd);
		}
	}
	return { el, d: dist, h };
}

/** Ladder of abstraction: the photo's centre column, then the side view of the ground under that sight line. */
function Ladder() {
	const [ladderId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(ladderId);
	const cam = useCam(d);
	const [c, setC] = useState(1);
	const crop = useMemo(() => (d ? viewBand(d) : undefined), [d]);
	if (!d)
		return (
			<div className="aspect-[4/3] animate-pulse bg-[var(--gb-paper-deep)]" />
		);
	const tp = d.terrainProfile;
	const eye = d.gps.eye;
	const dmax = Math.max(...tp.points.map((p) => p[0]));
	const live = sight(d, c);
	const flat = sight(d, 0);
	const real = sight(d, 1);
	const shiftDeg = flat.el - real.el;
	const shiftPx = d.solved.f * ((shiftDeg * Math.PI) / 180);
	const pts: [number, number][] = tp.points.map(([dd, h]) => [
		dd / 1000,
		h - c * drop(dd),
	]);
	const ys = tp.points.flatMap(([dd, h]) => [h, h - drop(dd)]);
	const ymin = Math.floor(Math.min(...ys, eye) / 500) * 500;
	const ymax =
		Math.ceil(Math.max(...ys, eye, flat.h, real.h) / 500) * 500 + 500;
	const q = cam ? project(cam, directionENU(tp.azimuth, real.el)) : null;
	const k = crop ? (crop[2] - crop[0]) / d.photo.width : 1;
	const rayTo = (s: { el: number; d: number }): [number, number] => [
		s.d / 1000,
		eye + s.d * Math.tan((s.el * Math.PI) / 180),
	];
	return (
		<>
			<Figure
				label="Fig. 2"
				bleed
				caption={
					<>
						Curvature, less refraction, lowers this crest by{" "}
						{shiftDeg.toFixed(2)}°, about {shiftPx.toFixed(1)} px on this photo.{" "}
						<Measured data={d} />
					</>
				}
			>
				<RealPhoto
					bleed
					data={d}
					layers={[]}
					crop={crop}
					// the profiled bearing, on the compass ruler over the photo
					spillCursor={q ? { x: q[0], az: tp.azimuth } : null}
				>
					{(dd) => (
						<>
							<HorizonOverlay d={dd} cam={cam} k={k} />
							{q && (
								<>
									<PenLine
										from={[q[0], 0]}
										to={[q[0], dd.photo.height]}
										seed="dh-col-dark"
										data
										color={PHOTO_DARK}
										width={4 * k}
									/>
									<PenLine
										from={[q[0], 0]}
										to={[q[0], dd.photo.height]}
										seed="dh-col-light"
										data
										color={SWISS.paper}
										width={1.8 * k}
										dash={`${5 * k} ${5 * k}`}
									/>
									<Mark x={q[0]} y={q[1]} n={2} k={1.4 * k} />
								</>
							)}
						</>
					)}
				</RealPhoto>
				<div className="mt-3">
					<Plot
						x={[0, dmax / 1000]}
						y={[ymin, ymax]}
						width={640}
						height={260}
						xLabel="distance along the dashed column (km)"
						yLabel="height (m)"
						fmtX={(v) => `${Math.round(v)}`}
						fmtY={(v) => `${Math.round(v)}`}
					>
						{(s) => (
							<g>
								<Wash d={s.area(pts, ymin)} color="brown" seed="dh-wash-3" />
								<Hachure
									d={s.area(pts, ymin)}
									seed="dh-ladder-ground"
									color="brown"
									gap={5}
									opacity={0.5}
								/>
								<DataLine d={s.line(pts)} color={SWISS.contour} width={1.8} />
								<DataLine
									d={s.line([[0, eye], rayTo(flat)])}
									color={SWISS.pencil}
									width={1.4}
									dash="2 4"
								/>
								<DataLine
									d={s.line([[0, eye], rayTo(live)])}
									color={SWISS.ink}
									width={1.8}
								/>
								{c > 0.02 && (
									<>
										<PenLine
											from={[
												s.x(live.d / 1000),
												s.y(live.h + c * drop(live.d)),
											]}
											to={[s.x(live.d / 1000), s.y(live.h)]}
											seed="dh-ladder-drop"
											color="red"
											width={3.5}
										/>
										<HandText
											x={s.x(live.d / 1000) - 12}
											y={s.y(live.h + c * drop(live.d)) - 10}
											anchor="end"
											size={15}
											color="red"
										>
											curve −{Math.round(c * drop(live.d))} m
										</HandText>
									</>
								)}
								<Mark
									x={s.x(0)}
									y={s.y(eye)}
									n={1}
									k={1.6}
									color="var(--gb-ink)"
								/>
								<Mark
									x={s.x(live.d / 1000)}
									y={s.y(rayTo(live)[1])}
									n={2}
									k={1.2}
									color="var(--gb-water)"
								/>
							</g>
						)}
					</Plot>
				</div>
				<div
					className={`mt-1 flex items-center gap-3 font-mono ${TYPE.micro} gb-secondary`}
				>
					flat
					<span className="flex-1">
						<HandRange
							min={0}
							max={1}
							step={0.01}
							value={c}
							label="Bend the Earth from flat to real"
							onChange={setC}
						/>
					</span>
					real Earth
				</div>
				<MarkList
					items={[
						<>Camera, {Math.round(eye)} m above sea level.</>,
						<>
							The crest that draws this column: {km(live.d)} km away,{" "}
							{live.el.toFixed(2)}° up. Dotted line: if the Earth were flat. Red
							bar: how far the curve sinks it.
						</>,
					]}
				/>
			</Figure>
			<Eq
				label="The angle each ground point is seen at"
				where={[
					{
						sym: "a",
						c: "solved",
						text: (
							<>
								elevation angle of the ground at distance <Sym>d</Sym>. The
								largest one over all <Sym>d</Sym> is the skyline.
							</>
						),
					},
					{
						sym: "h",
						c: "var(--accent)",
						text: "ground height from the map (the filled profile).",
					},
					{
						sym: (
							<>
								h<sub>eye</sub>
							</>
						),
						text: <>camera height, {Math.round(eye)} m.</>,
					},
					{
						sym: "d²/2R′",
						c: "var(--rigi-lesson)",
						text: (
							<>
								how far the Earth&rsquo;s curve sinks the ground, net of
								refraction: {Math.round(drop(live.d))} m at {km(live.d)} km.
								<Sym>R′</Sym> = <Sym>R</Sym>/(1 − <Sym>k</Sym>), with Earth
								radius <Sym>R</Sym> = 6,371 km and <Sym>k</Sym> = 0.13 for
								refraction.
							</>
						),
					},
				]}
			>
				<Sym c="solved">a</Sym>(<Sym>d</Sym>) = atan
				<Frac
					n={
						<>
							<Sym c="var(--accent)">h</Sym>(<Sym>d</Sym>) &minus; <Sym>h</Sym>
							<sub>eye</sub> &minus;{" "}
							<Sym c="var(--rigi-lesson)">
								<Frac n={<>d&sup2;</>} d={<>2R&prime;</>} />
							</Sym>
						</>
					}
					d={<Sym>d</Sym>}
				/>
			</Eq>
		</>
	);
}

function MiniRays() {
	const [id] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(id);
	return <DemPatch data={d} cone={["solved"]} peaks={false} />;
}

function MiniGround() {
	const [id] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(id);
	if (!d)
		return (
			<div className="aspect-[4/3] animate-pulse bg-[var(--gb-paper-deep)]" />
		);
	const pts = d.terrainProfile.points;
	const dmax = Math.max(...pts.map((p) => p[0]));
	const hs = pts.map((p) => p[1]);
	const lo = Math.min(...hs) - 80;
	const hi = Math.max(...hs, d.gps.eye) + 120;
	const X = (v: number) => (v / dmax) * 300;
	const Y = (v: number) => 170 - ((v - lo) / (hi - lo)) * 160;
	const line = pts.map(([a, h]) => `${X(a).toFixed(1)} ${Y(h).toFixed(1)}`);
	return (
		<svg
			viewBox="0 0 300 180"
			className="block h-auto w-full"
			role="img"
			aria-label="Ground height along one bearing"
		>
			<Wash
				d={`M0 180L${line.join("L")}L300 180Z`}
				color="brown"
				seed="dh-wash-4"
			/>
			<Hachure
				d={`M0 180L${line.join("L")}L300 180Z`}
				seed={`dh-mini-ground-${id}`}
				color="brown"
				gap={5}
				opacity={0.5}
			/>
			<DataLine d={`M${line.join("L")}`} color={SWISS.contour} width={1.6} />
			<HandDot x={X(0)} y={Y(d.gps.eye)} r={4} seed={`dh-mini-eye-${id}`} />
			{[0.25, 0.5, 0.75].map((f) => (
				<PenLine
					key={f}
					from={[X(dmax * f), Y(lo) - 4]}
					to={[X(dmax * f), Y(lo) + 4]}
					seed={`dh-mini-tick-${id}-${f}`}
					color="pencil"
					width={1}
				/>
			))}
		</svg>
	);
}

function MiniOutline() {
	const [id] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(id);
	const cam = useCam(d);
	const crop = useMemo(() => (d ? viewBand(d) : undefined), [d]);
	const k = crop && d ? (crop[2] - crop[0]) / d.photo.width : 1;
	return (
		<RealPhoto data={d} layers={[]} crop={crop}>
			{(dd) => <HorizonOverlay d={dd} cam={cam} k={k} />}
		</RealPhoto>
	);
}

const MISS: GipfelbuchPhotoId[] = ["demo-08", "demo-07", "demo-12"];

/** The worst tenth of columns: a red stem from the detected skyline to the map's skyline wherever the gap reaches the p90. */
function WorstTenth({ d, k }: { d: GipfelbuchPhotoData; k: number }) {
	const stems = useMemo(() => {
		const rows = d.skyline.rows;
		const sx = d.photo.width / rows.length;
		// One stem per ~1/120 of the width: drawing every column fused the stems into a solid slab over the occluder.
		const stride = Math.max(1, Math.round(rows.length / 120));
		const out: string[] = [];
		for (let x = Math.floor(stride / 2); x < rows.length; x += stride) {
			const a = rows[x];
			const b = d.solvedRows[x];
			if (a == null || b == null) continue;
			if (Math.abs(a - b) < d.residual.solved.p90) continue;
			out.push(`M${((x + 0.5) * sx).toFixed(1)} ${a}V${b}`);
		}
		return { d: out.join(""), w: stride * sx };
	}, [d]);
	return (
		<g fill="none" strokeLinecap="round">
			<path
				d={stems.d}
				stroke="rgba(12,14,18,.55)"
				strokeWidth={0.5 * stems.w * k}
			/>
			<path d={stems.d} stroke={SWISS.red} strokeWidth={0.28 * stems.w * k} />
		</g>
	);
}

function Misses() {
	return (
		<Figure
			label="Fig. 5"
			caption="The median gap stays small, but a head on the ridge puts the worst tenth of columns 100 px or more off."
		>
			<Gallery
				ids={MISS}
				cols={3}
				tone={(d) => (d.solved.accepted ? "neutral" : "failure")}
				tile={(d) => {
					const crop = skylineBand(d);
					const k = (crop[2] - crop[0]) / d.photo.width;
					return (
						<RealPhoto data={d} layers={["skyline", "solved"]} crop={crop}>
							{(dd) => <WorstTenth d={dd} k={k} />}
						</RealPhoto>
					);
				}}
				label={(d) => (
					<>
						<span className="gb-ink">
							median {d.residual.solved.median.toFixed(1)} px
						</span>
						{" · "}worst tenth over {d.residual.solved.p90.toFixed(0)} px
						{" · "}
						{d.solved.accepted
							? "solved"
							: `rejected, ${Math.round((d.solved.inlierFraction ?? 0) * 100)}% of columns agree`}
					</>
				)}
			/>
			<p className={`mt-2 ${TYPE.caption} gb-secondary`}>
				<Key color={LAYER_STYLE.solved.color}>map</Key> horizon and{" "}
				<Key color={LAYER_STYLE.skyline.color}>photo</Key> skyline, solved pose.
				Red stems: the worst tenth of columns, where the two lines are furthest
				apart.
			</p>
		</Figure>
	);
}

export default function Page({ node: _node }: { node: GipfelbuchNode }) {
	const [id, setId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(id);
	const idx = useGipfelbuchIndex();
	const hm = idx?.photos.map((p) => p.ms.horizon);
	const gap = idx
		? median(
				idx.photos
					.filter((p) => p.accepted)
					.map((p) => p.residual.solved.median),
			)
		: null;
	const nAcc = idx?.photos.filter((p) => p.accepted).length ?? 0;
	const A = (id: string, label: string) => (
		<Link
			to="/gipfelbuch/$concept"
			params={{ concept: id }}
			className="underline decoration-[var(--gb-red)] underline-offset-2 hover:decoration-current"
		>
			{label}
		</Link>
	);
	return (
		<>
			<HeroStages />

			<Beat
				kicker="The idea"
				title="The map can draw the horizon before we look at the photo."
			>
				<p>
					From the camera, we shoot a ray at every compass bearing. Each ray
					climbs over the terrain and remembers{" "}
					<HandMark type="highlight">its steepest angle</HandMark>. Anything
					flatter hides behind that crest.
				</p>
				<p>
					Together the angles form a 360° horizon curve. Distant ground sinks
					below the line of sight, so we lower it first. Then we slide it
					against the photo.
					<MarginNote mark="a">
						{`At 50 km the ground has sagged ${drop(50_000).toFixed(0)} m. Not a rounding error.`}
					</MarginNote>
				</p>
			</Beat>

			<Ladder />

			<Beat kicker="How it works" title="One ray, three jobs.">
				<Trio
					steps={[
						{
							title: "Walk outward",
							body: "Small steps near us, wider steps far away, out to 150 km.",
							visual: <MiniRays />,
						},
						{
							title: "Read the ground",
							body: "At each step, ask the map how high the ground is.",
							visual: <MiniGround />,
						},
						{
							title: "Keep the steepest",
							body: `Past 50 km the ground sags ${drop(50_000).toFixed(0)} m, so we lower it.`,
							visual: <MiniOutline />,
						},
					]}
				/>
			</Beat>

			<RealHorizon id={id} setId={setId} d={d} />

			<Beat kicker="Why it works" title="Distant ridges identify the location.">
				<p>
					A 25 m GPS error shifts a ridge 2 km away by up to{" "}
					<HandMark type="double">0.7°, about 10 px</HandMark> at this
					photo&rsquo;s focal length. A ridge 25 km away moves under 1 px.
					<MarginNote mark="b">
						So near ridges forgive nothing and far ones forgive everything.
					</MarginNote>
				</p>
				<p>
					In Fig. 3 the cool, far parts of the line stay put when the position
					is off.{" "}
					<HandMark type="underline">They pin the compass bearing.</HandMark>
				</p>
			</Beat>

			<LivePanorama number="4" />

			<Beat
				kicker="Where it fails"
				title="The map knows the ground, not the trees on it."
			>
				<p>
					Trees and people on the ridge are in the photo but not in the map.
					Those columns <HandMark type="wavy">disagree, by a lot</HandMark>.
					<MarginNote mark="c">
						{idx
							? `Median gap is only ${gap?.toFixed(1)} px; the worst tenth is what hurts.`
							: "The median looks fine; the worst tenth is what hurts."}
					</MarginNote>
				</p>
				<p>
					The solver gives such columns less weight. If too many disagree, it{" "}
					<HandMark type="box">rejects the photo instead of guessing</HandMark>.
				</p>
			</Beat>

			<Misses />

			<Numbers
				items={[
					{
						value: gap == null ? "…" : `${gap.toFixed(1)} px`,
						label: `median gap, map horizon vs photo skyline (${nAcc} solved photos, 800 px wide)`,
					},
					{
						value: hm ? `${(median(hm) / 1000).toFixed(1)} s` : "…",
						label: "to compute the full 360° horizon (12 photos)",
					},
					{ value: "7,200", label: "bearings, 0.05° apart, per horizon" },
					{ value: "0.3 s", label: "with the fast marcher in the browser" },
				]}
				source={
					<>
						Gap and time: measured on the 12 demo photos. The gap uses the
						solved pose, so it measures fit, not accuracy.
					</>
				}
			/>

			<Details>
				<h3>The mechanism, exactly</h3>
				<p>
					The horizon is a 360° curve: for every bearing, the highest elevation
					angle at which land meets sky. A ray marches outward over the terrain
					and keeps the steepest angle; everything flatter is hidden behind it.
					Fig. 3 shows it on a real photo. Below, Fig. D1 marches the real
					ground under that photo; Fig. D2 sweeps invented terrain with the same
					method.
				</p>
				<Steps
					steps={[
						{
							title: "A distance ladder per ray",
							body: (
								<>
									Samples start at 20 m and step by the larger of 10 m and 0.4 %
									of the distance, out to 150 km: about 1,270 per bearing, about
									9 million per full horizon.
								</>
							),
						},
						{
							title: "Walk the great circle, read the DEM",
							body: (
								<>
									<code>destination(lat, lon, az, d)</code> gives each ground
									point, and <code>terrain.sampleAt(lon, lat, d)</code> reads a
									height at the zoom level suited to that distance, with a
									fallback to coarser levels when a fine tile is missing.
									Missing data is <code>NaN</code> and the sample is skipped.
									See the {A("terrain-sampler", "terrain sampler")}.
								</>
							),
						},
						{
							title: "Convert height to an angle, with the Earth bending away",
							body: (
								<>
									<code>
										atan2(h &minus; eye &minus; d&sup2;/(2R&prime;), d)
									</code>
									, where <code>R&prime; = R / (1 &minus; k)</code> and k = 0.13
									folds refraction into the radius. The drop is{" "}
									{drop(10_000).toFixed(0)} m at 10 km,{" "}
									{drop(50_000).toFixed(0)} m at 50 km and{" "}
									{drop(100_000).toFixed(0)} m at 100 km.
								</>
							),
						},
						{
							title: "Keep the running maximum",
							body: (
								<>
									A sample that beats the best angle so far becomes the horizon
									for this bearing, with the distance to the point that draws
									it. Ties keep the nearer point.
								</>
							),
						},
						{
							title: "Remember the crests that got eclipsed",
							body: (
								<>
									When a new best appears after a stretch of hidden samples, and
									the previous crest is more than 8 % of its own distance
									behind, that crest is kept as an inner ridge, nearest first.
									These are the layered ridge lines the overlay draws behind the{" "}
									{A("skyline", "horizon")}.
								</>
							),
						},
					]}
				/>
				<h3>Output</h3>
				<p>
					The result: 7,200 elevations and distances, 0.05° apart, plus the
					ridge lists. Each ray is independent, so the work splits by bearing.
					The fast version skips a block of terrain when its highest point
					cannot beat the current best angle; the geometry is the same.
				</p>
				<RayMarch />
				<Sweep />
				<p>
					<CircledNumber value={1} /> Flat Earth: the horizon at{" "}
					<HandMark type="strike">3.23°</HandMark>{" "}
					<span className="nb-hand text-[var(--gb-red)]">3.11°</span> once the
					Earth drops, on the same crest 29 km out.
				</p>
				<Callout tone="result" title="Why curvature earns its place">
					On the real ground of Fig. D1 the drop lowers the 29 km crest by 0.11°
					and keeps the same crest; with farther, lower ridges behind it, the
					drop can hand the horizon to a nearer ridge. On the real photo in Fig.
					2 the curve moves it by about 1.5 px. The angular shift is
					d/2R&prime;, linear in distance (about 0.004° per km), so far horizons
					and long lenses are where it bites.
				</Callout>
				<p>
					k = 0.13 is an average; real air varies. With k = 0.18 the drop
					changes by 4 m at 33 km (0.1 px at this photo&rsquo;s focal length)
					and by 39 m at 100 km (0.3 px). Radio engineers use an effective
					radius of 4/3 R, a stronger bend.
				</p>
				<h3>Code</h3>
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/geo/horizon.ts" />
					<CodeRef path="src/lib/geo/terrain.ts" />
					<CodeRef path="src/lib/horizon-fast/march.ts" />
					<CodeRef path="src/lib/geodesy.ts" />
					<CodeRef path="src/lib/geo/pipeline.ts" />
					<CodeRef path="src/lib/geo/README.md" />
				</div>
				<h3>Where it fits</h3>
				<p>
					This is the predicted half of the horizon match in{" "}
					{A("viewport-inference", "viewport inference")}. Its input is the{" "}
					{A("terrain-sampler", "terrain sampler")} over the{" "}
					{A("dem-source", "DEM source")}, seen from the camera height the{" "}
					{A("eye-rule", "eye rule")} sets; the{" "}
					{A("baseline-pipeline", "baseline pipeline")} runs it first.{" "}
					{A("terrain-snapping", "Terrain snapping")} snaps to the same DEM.
				</p>
			</Details>
		</>
	);
}
