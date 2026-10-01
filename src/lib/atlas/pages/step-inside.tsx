// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import {
	type AtlasPhotoData,
	type AtlasPhotoId,
	Callout,
	CodeRef,
	DemPatch,
	Figure,
	Flow,
	Measured,
	PhotoPicker,
	RealPhoto,
	Stat,
	Steps,
	useAtlasPhoto,
	useTime,
} from "#/components/atlas/viz";
import {
	Beat,
	Details,
	Key,
	Numbers,
	Stages,
	Trio,
} from "#/components/atlas/viz/explain";
import type { AtlasNode } from "#/lib/atlas/types";

// Step Inside: how a solved photo becomes a place you can move around in.
// Every constant below is the real default:
//   STEP_SPLIT objectMargin 0.5, nearRadius 150 m, minGapM 3 m   (src/lib/nearfield/controller.ts, types.ts DEFAULT_SPLIT)
//   classifyRange order: person > beyond radius (Far) > no DEM hit (Object) > margin + gap (Object) > Terrain (split.ts)
//   confidence radius r = min(60, 0.5 * median object range) + 10, no content -> 10 m (scene.ts confidenceRadiusFrom)
//   ANCHOR_MIN_QUALITY 0.15 hides the scene, LOW_TRUST_QUALITY 0.35 badges it (types.ts, controller.ts)
//   provenance tint colours (provenance.ts), tint mix 0.65.
// The ruler rows and the plan-view objects are illustrative values, not measurements.

const PAPER = "var(--rigi-paper)";
const DEM_C = "rgb(230,159,0)"; // provenance 'dem'
const OBS_C = "rgb(0,158,115)"; // provenance 'observed'
const REC_C = "rgb(86,180,233)"; // provenance 'reconstructed'
const GEN_C = "rgb(204,121,167)"; // provenance 'generated'

type Cls = "Sky" | "Terrain" | "Object" | "Far";

/** classifyRange from src/lib/nearfield/split.ts, with the params as sliders. */
function classify(
	range: number,
	dem: number | null,
	person: boolean,
	margin: number,
	radius: number,
	minGap = 3,
): Cls {
	if (person) return "Object";
	if (!(range <= radius)) return "Far";
	if (dem == null || !(dem > 0)) return "Object";
	if (range < dem * (1 - margin) && dem - range >= minGap) return "Object";
	return "Terrain";
}

const CLS_COLOR: Record<Cls, string> = {
	Object: "var(--accent)",
	Terrain: "rgba(236,230,218,.55)",
	Far: DEM_C,
	Sky: "#6b8bb0",
};
const CLS_NOTE: Record<Cls, string> = {
	Object: "splat",
	Terrain: "drape",
	Far: "DEM only",
	Sky: "photo sky",
};

type Row = {
	label: string;
	sub: string;
	range: number; // anchored model range, m
	dem: number | null; // DEM range along the same ray, m
	person?: boolean;
};
const ROWS: Row[] = [
	{ label: "climber", sub: "people mask", range: 14, dem: 31, person: true },
	{ label: "hut roof", sub: "against the sky", range: 38, dem: null },
	{ label: "boulder", sub: "well in front", range: 22, dem: 58 },
	{ label: "fence post", sub: "just above ground", range: 45, dem: 52 },
	{ label: "meadow", sub: "agrees with DEM", range: 71, dem: 74 },
	{ label: "grass at feet", sub: "gap under 3 m", range: 18, dem: 20 },
	{ label: "spruce", sub: "in front of slope", range: 118, dem: 290 },
	{ label: "far barn", sub: "beyond the radius", range: 210, dem: 380 },
];

const RMIN = 5;
const RMAX = 450;
const AX0 = 132;
const AX1 = 548;
const rx = (r: number) =>
	AX0 +
	(Math.log(Math.max(RMIN, r) / RMIN) / Math.log(RMAX / RMIN)) * (AX1 - AX0);

// ======================================================================================
// Fig. 1 hero: one range ruler per pixel, the DEM against the anchored model depth
// ======================================================================================
function SplitRuler() {
	const [ref, t] = useTime<HTMLDivElement>(5.2);
	const [margin, setMargin] = useState(0.5);
	const [radius, setRadius] = useState(150);

	// the probe: a pixel whose model range sweeps through a ray that hits terrain at 140 m
	const probeDem = 140;
	const k = 0.5 - 0.5 * Math.cos(t * 0.45);
	const probe: Row = {
		label: "sweeping probe",
		sub: "range slides in and out",
		range: Math.exp(Math.log(8) + k * (Math.log(330) - Math.log(8))),
		dem: probeDem,
	};
	const rows = [...ROWS, probe];
	const RH = 40;
	const top = 42;
	const H = top + rows.length * RH + 34;

	const counts = { Object: 0, Terrain: 0, Far: 0, Sky: 0 } as Record<
		Cls,
		number
	>;
	const classes = rows.map((r) => {
		const c = classify(r.range, r.dem, !!r.person, margin, radius);
		counts[c]++;
		return c;
	});
	const ticks = [5, 10, 20, 50, 100, 200, 400];

	return (
		<Figure
			label="Fig. 1"
			bleed
			caption="Schematic (illustrative rows, not measurements). The depth split, one pixel per row. Orange is how far the DEM says the terrain is along that pixel's ray; the accent dot is where the anchored model depth puts the surface. The shaded band is the Object zone (model depth under dem x (1 - margin), at least 3 m in front). Inside it the pixel is lifted into a splat; on the DEM it stays in the drape; past the near radius it is left to the terrain. Drag the two parameters, or watch the last row sweep through all three outcomes."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<svg
					viewBox={`0 0 640 ${H}`}
					className="block h-auto w-full"
					role="img"
					aria-label="Range ruler showing per-pixel classification into terrain, object and far"
				>
					<defs>
						<pattern
							id="si-far"
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
								stroke={DEM_C}
								strokeOpacity=".22"
								strokeWidth="2"
							/>
						</pattern>
					</defs>
					{/* far region */}
					<rect
						x={rx(radius)}
						y={top - 8}
						width={AX1 + 14 - rx(radius)}
						height={rows.length * RH + 8}
						fill="url(#si-far)"
					/>
					<line
						x1={rx(radius)}
						x2={rx(radius)}
						y1={top - 14}
						y2={top + rows.length * RH}
						stroke={DEM_C}
						strokeDasharray="4 3"
						strokeOpacity=".85"
					/>
					<text
						x={rx(radius)}
						y={top - 20}
						textAnchor="middle"
						fontSize="10"
						className="font-mono"
						fill={DEM_C}
					>
						nearRadius {radius} m
					</text>
					{/* axis */}
					{ticks.map((v) => (
						<g key={v}>
							<line
								x1={rx(v)}
								x2={rx(v)}
								y1={top - 8}
								y2={top + rows.length * RH}
								stroke="rgba(236,230,218,.07)"
							/>
							<text
								x={rx(v)}
								y={H - 12}
								textAnchor="middle"
								fontSize="10"
								className="font-mono"
								fill="rgba(236,230,218,.4)"
							>
								{v} m
							</text>
						</g>
					))}
					<text
						x={AX0}
						y={H - 1}
						fontSize="9"
						className="font-mono"
						fill="rgba(236,230,218,.3)"
					>
						range along the pixel ray (log scale)
					</text>

					{rows.map((r, i) => {
						const y = top + i * RH + RH / 2;
						const c = classes[i];
						const zoneHi =
							r.dem == null ? RMAX : Math.min(r.dem * (1 - margin), r.dem - 3);
						const isProbe = i === rows.length - 1;
						return (
							<g key={r.label}>
								{i % 2 === 0 && (
									<rect
										x="0"
										y={y - RH / 2}
										width="640"
										height={RH}
										fill="rgba(255,255,255,.02)"
									/>
								)}
								<text x="8" y={y - 2} fontSize="12" fill={PAPER}>
									{r.label}
								</text>
								<text
									x="8"
									y={y + 11}
									fontSize="9.5"
									className="font-mono"
									fill="rgba(236,230,218,.4)"
								>
									{r.sub}
								</text>
								{/* object zone */}
								{r.person ? (
									<rect
										x={AX0}
										y={y - 8}
										width={AX1 - AX0}
										height="16"
										rx="3"
										fill="var(--accent)"
										fillOpacity=".1"
									/>
								) : zoneHi > RMIN ? (
									<rect
										x={AX0}
										y={y - 8}
										width={Math.max(0, rx(Math.min(zoneHi, radius)) - AX0)}
										height="16"
										rx="3"
										fill="var(--accent)"
										fillOpacity=".14"
									/>
								) : null}
								{/* DEM tick */}
								{r.dem != null ? (
									<g>
										<line
											x1={rx(r.dem)}
											x2={rx(r.dem)}
											y1={y - 9}
											y2={y + 9}
											stroke={DEM_C}
											strokeWidth="2.4"
										/>
										<line
											x1={rx(r.range)}
											x2={rx(r.dem)}
											y1={y}
											y2={y}
											stroke="rgba(236,230,218,.18)"
											strokeDasharray="2 3"
										/>
									</g>
								) : (
									<text
										x={AX1 + 4}
										y={y - 12}
										textAnchor="end"
										fontSize="9"
										className="font-mono"
										fill={DEM_C}
										fillOpacity=".7"
									>
										no DEM hit
									</text>
								)}
								{/* model dot */}
								<circle
									cx={rx(r.range)}
									cy={y}
									r={isProbe ? 6 : 5}
									fill={CLS_COLOR[c]}
									stroke="#0e1012"
									strokeWidth="1.5"
								/>
								{/* verdict */}
								<g transform={`translate(${AX1 + 22},${y})`}>
									<rect
										x="-4"
										y="-10"
										width="76"
										height="20"
										rx="10"
										fill={CLS_COLOR[c]}
										fillOpacity=".16"
										stroke={CLS_COLOR[c]}
										strokeOpacity=".6"
									/>
									<text
										x="34"
										y="4"
										textAnchor="middle"
										fontSize="10.5"
										className="font-mono"
										fill={PAPER}
									>
										{c} · {CLS_NOTE[c]}
									</text>
								</g>
							</g>
						);
					})}
				</svg>
			</div>

			<div className="mt-4 grid gap-4 md:grid-cols-[1fr_1fr_auto]">
				<Slider
					label="objectMargin"
					value={margin}
					min={0.1}
					max={0.9}
					step={0.05}
					fmt={(v) => v.toFixed(2)}
					onChange={setMargin}
				/>
				<Slider
					label="nearRadius"
					value={radius}
					min={40}
					max={300}
					step={5}
					fmt={(v) => `${v} m`}
					onChange={setRadius}
				/>
				<dl className="grid grid-cols-3 gap-x-5 font-mono text-[11px]">
					{(["Object", "Terrain", "Far"] as Cls[]).map((c) => (
						<div key={c}>
							<dt className="text-white/40">{c}</dt>
							<dd className="text-[13px]" style={{ color: CLS_COLOR[c] }}>
								{counts[c]} / {rows.length}
							</dd>
						</div>
					))}
				</dl>
			</div>
		</Figure>
	);
}

function Slider({
	label,
	value,
	min,
	max,
	step,
	fmt,
	onChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	fmt: (v: number) => string;
	onChange: (v: number) => void;
}) {
	return (
		<label className="block">
			<span className="flex justify-between font-mono text-[11px] text-white/45">
				<span>{label}</span>
				<span style={{ color: PAPER }}>{fmt(value)}</span>
			</span>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				className="mt-1 w-full accent-[var(--accent)]"
			/>
		</label>
	);
}

// ======================================================================================
// Fig. 2: the confidence radius, and the camera that is allowed to roam inside it
// ======================================================================================
const MULT = [0.45, 0.7, 0.9, 1, 1.15, 1.5, 2.1];
const ANG = [-24, 12, -8, 3, 20, -16, 6];

function ConfidenceDisc() {
	const [ref, t] = useTime<HTMLDivElement>(7);
	const [med, setMed] = useState(40);
	const r = Math.min(60, 0.5 * med) + 10; // confidenceRadiusFrom
	const W = 640;
	const H = 330;
	const ex = W / 2;
	const ey = H - 26;
	const s = 215 / (2.2 * med); // px per metre, adaptive so the scene always fits
	const m2 = (v: number) => v * s;

	// a wandering target offset, clamped to the radius exactly as StepCamera clamps position
	let ox = 1.5 * r * Math.sin(t * 0.5) + 0.6 * r * Math.sin(t * 1.3 + 1);
	let oy = 1.2 * r * Math.sin(t * 0.37 + 0.8);
	const d = Math.hypot(ox, oy);
	const clamped = d > r;
	if (clamped) {
		ox = (ox / d) * r;
		oy = (oy / d) * r;
	}
	const cx = ex + m2(ox);
	const cy = ey - m2(oy);
	const px = ex;
	const py = ey - m2(med); // pivot at the median content
	const ang = Math.atan2(px - cx, cy - py);
	const fov = (52 * Math.PI) / 360;
	const L = m2(med) * 1.15;
	const cone = [-fov, fov].map((a) => [
		cx + Math.sin(ang + a) * L,
		cy - Math.cos(ang + a) * L,
	]);
	// scale bar
	const nice = [1, 2, 5, 10, 20, 50, 100].find((v) => m2(v) > 60) ?? 100;

	return (
		<Figure
			label="Fig. 2"
			bleed
			caption="Schematic (illustrative objects). Plan view, looking down. The camera starts on the photo eye (the dot at the bottom) and may orbit, pan and dolly, but every position is clamped to a disc of radius r = min(60, 0.5 x median object range) + 10 m. Close subjects give a small disc because parallax would expose what one view never saw; a far panorama is capped at 70 m. Drag the median range."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<svg
					viewBox={`0 0 ${W} ${H}`}
					className="block h-auto w-full"
					role="img"
					aria-label="Plan view of the confidence radius around the photo eye with a camera clamped inside it"
				>
					{/* photo frustum from the eye */}
					<path
						d={`M${ex} ${ey} L${ex - Math.tan(fov * 1) * m2(med) * 2.3} ${ey - m2(med) * 2.3} L${ex + Math.tan(fov) * m2(med) * 2.3} ${ey - m2(med) * 2.3} Z`}
						fill="rgba(236,230,218,.05)"
						stroke="rgba(236,230,218,.14)"
					/>
					{/* confidence disc */}
					<circle
						cx={ex}
						cy={ey}
						r={m2(r)}
						fill="var(--accent)"
						fillOpacity=".09"
						stroke="var(--accent)"
						strokeOpacity=".8"
						strokeDasharray="5 4"
					/>
					<text
						x={ex + m2(r) * 0.72 + 6}
						y={ey - m2(r) * 0.72 - 4}
						fontSize="11"
						className="font-mono"
						fill="var(--accent)"
					>
						r = {r.toFixed(0)} m
					</text>
					{/* median ring */}
					<circle
						cx={ex}
						cy={ey}
						r={m2(med)}
						fill="none"
						stroke="rgba(236,230,218,.14)"
						strokeDasharray="1 5"
					/>
					<text
						x={ex - m2(med) * 0.86 - 4}
						y={ey - m2(med) * 0.5}
						textAnchor="end"
						fontSize="10"
						className="font-mono"
						fill="rgba(236,230,218,.42)"
					>
						median object range {med} m
					</text>
					{/* object splats */}
					{MULT.map((mu, i) => {
						const a = (ANG[i] * Math.PI) / 180;
						const rr = med * mu;
						const x = ex + Math.sin(a) * m2(rr);
						const y = ey - Math.cos(a) * m2(rr);
						return (
							<g key={`o${ANG[i]}`}>
								<circle cx={x} cy={y} r="5" fill={OBS_C} fillOpacity=".25" />
								<circle cx={x} cy={y} r="2.4" fill={OBS_C} />
							</g>
						);
					})}
					{/* far field: DEM */}
					<path
						d={`M${ex - 250} 24 Q${ex - 120} 6 ${ex} 20 T${ex + 250} 22`}
						fill="none"
						stroke={DEM_C}
						strokeWidth="1.6"
						strokeOpacity=".8"
					/>
					<text
						x={ex}
						y="14"
						textAnchor="middle"
						fontSize="10"
						className="font-mono"
						fill={DEM_C}
					>
						far field: DEM terrain, never moves
					</text>
					{/* roaming camera */}
					<line
						x1={ex}
						y1={ey}
						x2={cx}
						y2={cy}
						stroke="rgba(236,230,218,.22)"
						strokeDasharray="2 3"
					/>
					<path
						d={`M${cx} ${cy} L${cone[0][0]} ${cone[0][1]} L${cone[1][0]} ${cone[1][1]} Z`}
						fill={clamped ? "rgba(255,255,255,.04)" : "var(--accent)"}
						fillOpacity={clamped ? 1 : 0.12}
						stroke="var(--accent)"
						strokeOpacity=".5"
					/>
					<circle
						cx={cx}
						cy={cy}
						r="5.5"
						fill="var(--accent)"
						stroke="#0e1012"
						strokeWidth="1.5"
					/>
					{/* photo eye */}
					<circle
						cx={ex}
						cy={ey}
						r="4"
						fill="none"
						stroke={PAPER}
						strokeWidth="1.6"
					/>
					<text
						x={ex + 9}
						y={ey + 14}
						fontSize="10"
						className="font-mono"
						fill="rgba(236,230,218,.6)"
					>
						photo eye
					</text>
					{/* scale */}
					<g transform={`translate(14 ${H - 14})`}>
						<line
							x1="0"
							x2={m2(nice)}
							y1="0"
							y2="0"
							stroke="rgba(236,230,218,.5)"
						/>
						<line x1="0" x2="0" y1="-3" y2="3" stroke="rgba(236,230,218,.5)" />
						<line
							x1={m2(nice)}
							x2={m2(nice)}
							y1="-3"
							y2="3"
							stroke="rgba(236,230,218,.5)"
						/>
						<text
							x={m2(nice) + 6}
							y="3"
							fontSize="10"
							className="font-mono"
							fill="rgba(236,230,218,.5)"
						>
							{nice} m
						</text>
					</g>
					{clamped && (
						<text
							x={W - 10}
							y={H - 12}
							textAnchor="end"
							fontSize="10"
							className="font-mono"
							fill="var(--accent)"
						>
							clamped to the disc
						</text>
					)}
				</svg>
			</div>
			<div className="mt-4 grid gap-4 md:grid-cols-[1fr_auto]">
				<Slider
					label="median range of the kept objects"
					value={med}
					min={5}
					max={200}
					step={1}
					fmt={(v) => `${v} m`}
					onChange={setMed}
				/>
				<dl className="grid grid-cols-2 gap-x-6 font-mono text-[11px]">
					<div>
						<dt className="text-white/40">radius</dt>
						<dd className="text-[13px]" style={{ color: PAPER }}>
							{r.toFixed(1)} m
						</dd>
					</div>
					<div>
						<dt className="text-white/40">cap reached</dt>
						<dd className="text-[13px]" style={{ color: PAPER }}>
							{med >= 120 ? "yes (70 m)" : "no"}
						</dd>
					</div>
				</dl>
			</div>
		</Figure>
	);
}

// ---------- provenance legend ----------
function Provenance() {
	const items = [
		{ c: OBS_C, n: "observed", d: "seen in the photo, depth-lifted" },
		{ c: REC_C, n: "reconstructed", d: "model / multi-view geometry" },
		{ c: DEM_C, n: "dem", d: "terrain model" },
		{ c: GEN_C, n: "generated", d: "invented, never measurable" },
	];
	return (
		<Figure
			label="Fig. 3"
			caption="The Truth toggle mixes 65 % of a provenance tint into every surface. The generated class is the only one filtered out of exports and readouts (provenance.ts filterForExport)."
		>
			<div className="grid gap-3 sm:grid-cols-4">
				{items.map((i) => (
					<div key={i.n} className="rounded-lg p-3 ring-1 ring-white/10">
						<div
							className="h-2 w-full rounded-full"
							style={{ background: i.c }}
						/>
						<div
							className="mt-2 font-mono text-[12px]"
							style={{ color: PAPER }}
						>
							{i.n}
						</div>
						<div className="mt-0.5 text-[12px] leading-snug text-white/50">
							{i.d}
						</div>
					</div>
				))}
			</div>
		</Figure>
	);
}

// ======================================================================================
// Real data: measured on the bundled Niederhorn demo photos (scripts/atlas/build-data.ts, data-step-inside.ts)
// ======================================================================================
const RANGE_IDS = ["demo-01", "demo-02", "demo-03", "demo-06"] as const;
const NEAR_R = 150; // DEFAULT_SPLIT nearRadius, m
const R_EARTH = 6_371_000;
const SKY_C = "#6b8bb0";

/** First ground hit (m) of a ray at elevation `elDeg` from the eye, over a [distance, height] profile; null = no hit. */
function firstHit(
	points: [number, number][],
	eye: number,
	elDeg: number,
): number | null {
	const t = Math.tan((elDeg * Math.PI) / 180);
	const h = (d: number) => eye + d * t - (0.87 * d * d) / (2 * R_EARTH);
	for (let i = 1; i < points.length; i++) {
		const [d0, g0] = points[i - 1];
		const [d1, g1] = points[i];
		const a = h(d0) - g0;
		const b = h(d1) - g1;
		if (a > 0 && b <= 0) return d0 + ((d1 - d0) * a) / (a - b);
	}
	return null;
}

function RealRange() {
	const [id, setId] = useState<AtlasPhotoId>("demo-03");
	const d = useAtlasPhoto(id);
	const picker = (
		<PhotoPicker
			value={id}
			onChange={setId}
			ids={RANGE_IDS as unknown as readonly AtlasPhotoId[]}
		/>
	);
	let body: ReactNode = (
		<div className="aspect-[4/3] w-full animate-pulse rounded-xl bg-white/[0.04]" />
	);
	let stats: ReactNode = null;
	if (d) {
		const { width: W, height: H } = d.photo;
		const { f, pitch } = d.solved;
		const step = 3;
		const samples: { v: number; r: number | null }[] = [];
		for (let v = 0; v < H; v += step) {
			const el =
				pitch - (Math.atan((v + step / 2 - H / 2) / f) * 180) / Math.PI;
			samples.push({ v, r: firstHit(d.terrainProfile.points, d.gps.eye, el) });
		}
		const ground = samples.filter((s) => s.r != null);
		const near = ground.filter((s) => (s.r as number) < NEAR_R);
		const xOf = (r: number) =>
			Math.max(0, Math.min(100, ((Math.log10(r) - 1) / 3) * 100));
		const colour = (r: number | null) =>
			r == null ? SKY_C : r < NEAR_R ? "var(--accent)" : DEM_C;
		const segs: { pts: string; c: string }[] = [];
		let cur: { pts: string; c: string } | null = null;
		for (const s of samples) {
			if (s.r == null) {
				cur = null;
				continue;
			}
			const c = colour(s.r);
			const pt = `${xOf(s.r).toFixed(2)} ${(((s.v + step / 2) / H) * 100).toFixed(2)}`;
			if (!cur || cur.c !== c) {
				cur = { pts: `M${pt}`, c };
				segs.push(cur);
			} else cur.pts += `L${pt}`;
		}
		const minR = Math.min(...ground.map((s) => s.r as number));
		const maxNear = Math.max(...near.map((s) => s.r as number), 0);
		body = (
			<div className="grid items-stretch gap-3 grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
				<svg
					viewBox={`0 0 ${W} ${H}`}
					className="block h-auto w-full rounded-lg"
					role="img"
					aria-label={`${d.id} with the DEM range along its central column`}
				>
					<title>The photo with a range bar down its central column</title>
					<image href={d.photo.src} width={W} height={H} />
					<line
						x1={W / 2}
						x2={W / 2}
						y1={0}
						y2={H}
						stroke="#0e1012"
						strokeOpacity={0.6}
						strokeWidth={20}
					/>
					{samples.map((s) => (
						<rect
							key={s.v}
							x={W / 2 - 8}
							y={s.v}
							width={16}
							height={step + 0.5}
							fill={colour(s.r)}
						/>
					))}
				</svg>
				<div className="relative min-h-[200px] overflow-hidden rounded-lg bg-[#11161a]">
					<svg
						viewBox="0 0 100 100"
						preserveAspectRatio="none"
						className="absolute inset-0 size-full"
						aria-hidden="true"
					>
						{[10, 100, 1000, 10000].map((m) => (
							<line
								key={m}
								x1={xOf(m)}
								x2={xOf(m)}
								y1={0}
								y2={100}
								stroke="rgba(236,230,218,.08)"
								vectorEffect="non-scaling-stroke"
							/>
						))}
						<line
							x1={xOf(NEAR_R)}
							x2={xOf(NEAR_R)}
							y1={0}
							y2={100}
							stroke="var(--accent)"
							strokeDasharray="4 4"
							strokeOpacity={0.8}
							vectorEffect="non-scaling-stroke"
						/>
						{segs.map((s) => (
							<path
								key={s.pts.slice(0, 24)}
								d={s.pts}
								fill="none"
								stroke={s.c}
								strokeWidth={2.4}
								vectorEffect="non-scaling-stroke"
							/>
						))}
					</svg>
					{[
						[10, "10 m"],
						[100, "100 m"],
						[1000, "1 km"],
						[10000, "10 km"],
					].map(([m, l]) => (
						<span
							key={l}
							className="absolute top-1 -translate-x-1/2 font-mono text-[9.5px] text-white/40"
							style={{
								left: `${Math.min(92, Math.max(8, xOf(m as number)))}%`,
							}}
						>
							{l}
						</span>
					))}
					<span
						className="absolute bottom-1.5 font-mono text-[9.5px] text-[var(--accent)]"
						style={{ left: `${xOf(NEAR_R) + 1.5}%` }}
					>
						150 m
					</span>
				</div>
			</div>
		);
		stats = (
			<p className="mt-3 font-mono text-[11.5px] leading-relaxed text-white/55">
				<span className="text-[var(--rigi-paper)]">
					{((near.length / ground.length) * 100).toFixed(0)} %
				</span>{" "}
				of the {ground.length * step} image rows that see ground in the central
				column hit it inside the 150 m near radius (nearest hit{" "}
				{minR.toFixed(0)} m
				{near.length ? `, farthest near hit ${maxNear.toFixed(0)} m` : ""}); the
				rest is <em>Far</em> and left to the DEM. The eye is{" "}
				{(d.gps.eye - d.gps.ground).toFixed(0)} m above the DEM ground here (see
				the next figure).
			</p>
		);
	}
	return (
		<Figure
			label="Real 1"
			bleed
			caption={
				<>
					Every image row on the centre line is a ray from the eye; its length
					to the first hill is read off the terrain. Accent is inside 150 m,
					orange is far, blue is sky.{" "}
					<Measured data={d}>
						<span>
							Ranges ray-cast from its{" "}
							<span className="text-[var(--rigi-paper)]">terrainProfile</span>.
						</span>
					</Measured>
				</>
			}
		>
			{picker}
			{body}
			{stats}
		</Figure>
	);
}

type EyeData = {
	generated: string;
	script: string;
	dem: string;
	rows: {
		id: string;
		gpsAlt: number;
		ground: number;
		eye: number;
		hAccuracy: number;
		accepted: boolean;
	}[];
};

function RealEye() {
	const [d, setD] = useState<EyeData | null>(null);
	useEffect(() => {
		let live = true;
		fetch("/demo/atlas/step-inside/eye.json")
			.then((r) => r.json())
			.then((v) => live && setD(v))
			.catch((e) => console.warn("[atlas] step-inside eye data", e));
		return () => {
			live = false;
		};
	}, []);
	if (!d)
		return (
			<div className="my-9 aspect-[16/7] w-full animate-pulse rounded-2xl bg-white/[0.04]" />
		);
	const rows = d.rows.map((r) => ({ ...r, above: r.gpsAlt - r.ground }));
	const sane = rows.filter((r) => r.above > 0 && r.above < 200);
	const bad = rows.filter((r) => !(r.above > 0 && r.above < 200));
	const lo = Math.min(...sane.map((r) => r.above));
	const hi = Math.max(...sane.map((r) => r.above));
	const W = 720;
	const L = 70;
	const X = (v: number) => L + (v / 80) * (W - L - 16);
	const rh = 22;
	const H = rows.length * rh + 34;
	return (
		<Figure
			label="Real 2"
			bleed
			caption={
				<>
					Bars: GPS altitude above the terrain under each photo. White tick: the
					eye height we use, never below ground plus 1.6 m. Measured by{" "}
					{d.script}, {d.generated}.
				</>
			}
		>
			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="block h-auto w-full"
				role="img"
				aria-label="Height of the GPS altitude above the DEM ground for each demo photo"
			>
				<title>GPS altitude above DEM ground per photo</title>
				{[0, 20, 40, 60, 80].map((v) => (
					<g key={v}>
						<line
							x1={X(v)}
							x2={X(v)}
							y1={0}
							y2={H - 22}
							stroke="rgba(236,230,218,.08)"
						/>
						<text
							x={X(v)}
							y={H - 6}
							textAnchor="middle"
							fontSize="10"
							fill="rgba(236,230,218,.5)"
							fontFamily="ui-monospace, monospace"
						>
							{v} m
						</text>
					</g>
				))}
				{rows.map((r, i) => {
					const y = 4 + i * rh;
					const ok = r.above > 0 && r.above < 200;
					return (
						<g key={r.id}>
							<text
								x={L - 8}
								y={y + 13}
								textAnchor="end"
								fontSize="10.5"
								fill="rgba(236,230,218,.7)"
								fontFamily="ui-monospace, monospace"
							>
								{r.id}
							</text>
							<rect
								x={L}
								y={y + 3}
								width={Math.max(2, X(Math.min(80, Math.max(0, r.above))) - L)}
								height={rh - 8}
								rx={2}
								fill={ok ? "var(--accent)" : "var(--rigi-trap)"}
								fillOpacity={ok ? 0.75 : 0.9}
							/>
							<line
								x1={X(r.eye - r.ground)}
								x2={X(r.eye - r.ground)}
								y1={y}
								y2={y + rh - 2}
								stroke="var(--rigi-paper)"
								strokeWidth={2}
							/>
							{!ok && (
								<text
									x={L + 8}
									y={y + 14}
									fontSize="10.5"
									fill="var(--rigi-trap)"
									fontFamily="ui-monospace, monospace"
								>
									EXIF {r.gpsAlt.toFixed(0)} m vs ground {r.ground.toFixed(0)}{" "}
									m: eye clamped to ground + 1.6
								</text>
							)}
						</g>
					);
				})}
			</svg>
			<p className="mt-3 font-mono text-[11.5px] leading-relaxed text-white/55">
				{sane.length} of {rows.length} photos report an altitude{" "}
				<span className="text-[var(--rigi-paper)]">
					{lo.toFixed(0)}–{hi.toFixed(0)} m
				</span>{" "}
				above the DEM ground;{" "}
				{bad.length === 1 ? "one photo" : `${bad.length} photos`} (
				{bad.map((b) => b.id).join(", ")}) reports an altitude{" "}
				{Math.abs(bad[0]?.above ?? 0).toFixed(0)} m <em>below</em> the ground
				and falls back to the 1.6 m floor. The step-inside report found the same
				scale of error at the Niederhorn spot: GPS eye errors of 7–37 m
				(reports/step-inside-results.md, finding 7).
			</p>
		</Figure>
	);
}

/** Reported DEM/model depth ratios (reports/step-inside-results.md, finding 1; MoGe-2 vs the DEM on terrain pixels). */
function RealCompression() {
	const bands = [
		{ band: "about 20 m", ratio: 1 },
		{ band: "100–300 m", ratio: 2.9 },
		{ band: "300–1000 m", ratio: 6.6 },
	];
	const W = 720;
	const L = 110;
	const X = (v: number) => L + (v / 7) * (W - L - 40);
	return (
		<Figure
			label="Real 3"
			caption="Why the anchor exists. The monocular model (MoGe-2) compresses range: the DEM distance divided by the model distance, on terrain pixels, is about 1 at 20 m but 2.9 at 100–300 m and 6.6 at 300–1000 m. One global scale would leave a median terrain error of 0.34 (log); a per-photo monotone log-log curve brings it to 0.13. Figures quoted from reports/step-inside-results.md findings 1 and 2 (2026-09-29), not measured by the atlas script."
		>
			<svg
				viewBox={`0 0 ${W} 130`}
				className="block h-auto w-full"
				role="img"
				aria-label="Ratio of DEM distance to model distance by range band"
			>
				<title>DEM to model depth ratio by range band</title>
				{[1, 2, 3, 4, 5, 6, 7].map((v) => (
					<g key={v}>
						<line
							x1={X(v)}
							x2={X(v)}
							y1={8}
							y2={100}
							stroke="rgba(236,230,218,.08)"
						/>
						<text
							x={X(v)}
							y={118}
							textAnchor="middle"
							fontSize="10"
							fill="rgba(236,230,218,.5)"
							fontFamily="ui-monospace, monospace"
						>
							{v}×
						</text>
					</g>
				))}
				{bands.map((b, i) => (
					<g key={b.band}>
						<text
							x={L - 10}
							y={30 + i * 30}
							textAnchor="end"
							fontSize="11"
							fill="rgba(236,230,218,.7)"
							fontFamily="ui-monospace, monospace"
						>
							{b.band}
						</text>
						<rect
							x={L}
							y={18 + i * 30}
							width={X(b.ratio) - L}
							height={18}
							rx={2}
							fill="var(--accent)"
							fillOpacity={0.4 + 0.2 * i}
						/>
						<text
							x={X(b.ratio) + 8}
							y={31 + i * 30}
							fontSize="11"
							fill="var(--rigi-paper)"
							fontFamily="ui-monospace, monospace"
						>
							{b.ratio}×
						</text>
					</g>
				))}
			</svg>
		</Figure>
	);
}

// ======================================================================================
// Explainer layer: hero, trio, numbers
// ======================================================================================
const BAR_STEP = 3;

/** Range (m) to the first DEM hit for every third image row of the central column; null = sky. */
function rangeSamples(d: AtlasPhotoData) {
	const { height: H } = d.photo;
	const { f, pitch } = d.solved;
	const out: { v: number; r: number | null }[] = [];
	for (let v = 0; v < H; v += BAR_STEP) {
		const el =
			pitch - (Math.atan((v + BAR_STEP / 2 - H / 2) / f) * 180) / Math.PI;
		out.push({ v, r: firstHit(d.terrainProfile.points, d.gps.eye, el) });
	}
	return out;
}

/** The central-column range bar, drawn in photo pixels (inside RealPhoto children). */
function RangeBar({
	d,
	mode,
	width = 26,
}: {
	d: AtlasPhotoData;
	mode: "ramp" | "split";
	width?: number;
}) {
	const W = d.photo.width;
	return (
		<g>
			<rect
				x={W / 2 - width / 2 - 5}
				y={0}
				width={width + 10}
				height={d.photo.height}
				fill="#0e1012"
				fillOpacity={0.6}
			/>
			{rangeSamples(d).map((s) => {
				if (s.r == null)
					return (
						<rect
							key={s.v}
							x={W / 2 - width / 2}
							y={s.v}
							width={width}
							height={BAR_STEP + 0.5}
							fill={SKY_C}
							fillOpacity={0.5}
						/>
					);
				const t = Math.max(0, Math.min(1, (Math.log10(s.r) - 1) / 3));
				const fill =
					mode === "split"
						? s.r < NEAR_R
							? "var(--accent)"
							: DEM_C
						: `rgb(${Math.round(236 - 150 * t)},${Math.round(230 - 150 * t)},${Math.round(218 - 140 * t)})`;
				return (
					<rect
						key={s.v}
						x={W / 2 - width / 2}
						y={s.v}
						width={width}
						height={BAR_STEP + 0.5}
						fill={fill}
					/>
				);
			})}
		</g>
	);
}

function HeroStages() {
	const d = useAtlasPhoto("demo-03");
	let near: number | null = null;
	if (d) {
		const g = rangeSamples(d).filter((s) => s.r != null);
		near = g.length
			? Math.round(
					(g.filter((s) => (s.r as number) < NEAR_R).length / g.length) * 100,
				)
			: null;
	}
	return (
		<Figure
			label="Fig. 1"
			caption={
				<>
					{near == null
						? "The terrain model tells us how far away each pixel is."
						: `Along this photo's centre line, ${near} % of the ground we can see lies within 150 m.`}{" "}
					<Measured data={d} />
				</>
			}
		>
			<Stages
				stages={[
					{
						label: "Photo",
						caption: "A solved photo knows exactly where its camera stood.",
						render: () => (
							<div className="mx-auto max-w-[340px]">
								<RealPhoto data={d} layers={[]} />
							</div>
						),
					},
					{
						label: "How far?",
						caption:
							"Down the centre we ask the terrain model: bright is near, dark is far.",
						render: () => (
							<div className="mx-auto max-w-[340px]">
								<RealPhoto data={d} layers={[]}>
									{(x) => <RangeBar d={x} mode="ramp" />}
								</RealPhoto>
							</div>
						),
					},
					{
						label: "Near or far?",
						caption: (
							<>
								Inside 150 m,{" "}
								<Key color="var(--accent)">near things become 3D</Key>. Beyond
								it, <Key color={DEM_C}>the terrain model draws the world</Key>.
							</>
						),
						render: () => (
							<div className="mx-auto max-w-[340px]">
								<RealPhoto data={d} layers={[]}>
									{(x) => <RangeBar d={x} mode="split" />}
								</RealPhoto>
							</div>
						),
					},
				]}
			/>
		</Figure>
	);
}

function MiniBars() {
	const bands = [
		{ band: "20 m", ratio: 1 },
		{ band: "100–300 m", ratio: 2.9 },
		{ band: "300–1000 m", ratio: 6.6 },
	];
	return (
		<svg
			viewBox="0 0 200 150"
			className="block h-auto w-full bg-[#11161a]"
			role="img"
			aria-label="Depth-model error grows with range: 1 times at 20 metres, 6.6 times at 300 to 1000 metres"
		>
			<title>Model depth error by range</title>
			{bands.map((b, i) => (
				<g key={b.band}>
					<text
						x={8}
						y={30 + i * 38}
						fontSize="9"
						fill="rgba(236,230,218,.6)"
						fontFamily="ui-monospace, monospace"
					>
						{b.band}
					</text>
					<rect
						x={8}
						y={36 + i * 38}
						width={Math.max(6, (b.ratio / 6.6) * 150)}
						height={14}
						rx={2}
						fill="var(--accent)"
						fillOpacity={0.4 + 0.2 * i}
					/>
					<text
						x={Math.max(6, (b.ratio / 6.6) * 150) + 14}
						y={47 + i * 38}
						fontSize="10"
						fill="var(--rigi-paper)"
						fontFamily="ui-monospace, monospace"
					>
						{b.ratio}×
					</text>
				</g>
			))}
		</svg>
	);
}

function MiniSplit() {
	const d = useAtlasPhoto("demo-01");
	return (
		<RealPhoto data={d} layers={[]}>
			{(x) => <RangeBar d={x} mode="split" width={40} />}
		</RealPhoto>
	);
}

function MiniEye() {
	const d = useAtlasPhoto("demo-06");
	return <DemPatch data={d} cone={["solved"]} peaks={false} />;
}

export default function Page({ node }: { node: AtlasNode }) {
	void node;
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
				title="Far mountains are measured. Only near things are rebuilt."
			>
				<p>
					The terrain model knows where the mountains are. It does not know the
					hut ten metres away.
				</p>
				<p>
					So we keep the terrain for the terrain, and lift only what stands in
					front of it into 3D. Then the camera starts exactly where the photo
					was taken.
				</p>
			</Beat>

			<RealRange />

			<Beat
				kicker="How it works"
				title="Fix the depth scale, split every pixel, stand at the eye."
			>
				<Trio
					steps={[
						{
							title: "Fix the scale",
							body: "A depth model squeezes far range. We re-scale it against the terrain.",
							visual: <MiniBars />,
						},
						{
							title: "Split near from far",
							body: "A pixel well in front of the terrain is an object. Beyond 150 m, terrain only.",
							visual: <MiniSplit />,
						},
						{
							title: "Stand at the eye",
							body: "The camera begins on the photo's own viewpoint, and stays close.",
							visual: <MiniEye />,
						},
					]}
				/>
			</Beat>

			<Beat
				kicker="Where it fails"
				title="Depth alone cannot tell a hut from the hill behind it."
			>
				<p>
					Beyond 100 m the depth model drifts, and objects blur into the slope.
					The start point is also uncertain, because phone GPS height is rough.
				</p>
			</Beat>

			<RealEye />

			<Numbers
				items={[
					{
						value: "150 m",
						label: "near radius, beyond which only terrain is drawn",
					},
					{ value: "60 fps", label: "with 200 000 splats on screen" },
					{
						value: "4 % / 15 %",
						label: "of non-person drape smear removed (three / deck)",
					},
					{ value: "80 %", label: "was the target, so the gate is not met" },
				]}
				source={
					<>reports/step-inside-results.md (verdict, rendering, finding 5).</>
				}
			/>

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next: {A("dem-anchoring", "DEM anchoring")} is the depth ruler this
				relies on, and {A("camera-roll", "the camera roll")} reuses the same
				viewer.
			</p>

			<Details>
				<h3>The split rule, tunable (illustrative rows)</h3>
				<SplitRuler />

				<h3>How it works</h3>
				<div className="space-y-3">
					<p>
						The split in Fig. 1 is the heart of it: the per-pixel decision in{" "}
						<code>split.ts</code>. The rest of the pipeline exists to make that
						comparison meaningful and to turn its answer into something you can
						walk around.
					</p>
				</div>
				<Steps
					steps={[
						{
							title: "Gate on an accepted pose",
							body: (
								<>
									<code>poseAccepted</code> admits only photos whose pose a
									solver confirmed or the user set (accepted, pinned, saved,
									manual, or auto with a verified, refined or matched verdict).
									See {A("accept-rule", "the accept rule")}. If the optional
									service is down, the feature simply is not offered.
								</>
							),
						},
						{
							title: "Ask the service for depth and splats",
							body: (
								<>
									<code>/depth</code> (monocular depth) and{" "}
									<code>/gaussians</code> (a splat cloud) run once per photo and
									are cached, so changing the pose does not repeat the slow
									part. The renderer meanwhile reads back its own DEM range for
									every depth cell.
								</>
							),
						},
						{
							title: "Anchor model depth to the DEM",
							body: (
								<>
									Monocular depth is compressed in range, so a calibration curve
									is fitted on terrain pixels to turn it into metres. That is
									its own algorithm: see {A("dem-anchoring", "DEM anchoring")}.
									The fit also yields a quality score: below 0.15 the scene is
									hidden, below 0.35 it carries a low-trust badge.
								</>
							),
						},
						{
							title: "Split every pixel",
							body: (
								<>
									Compare anchored range with DEM range (Fig. 1). People are
									always Objects. Beyond 150 m everything is Far. A model pixel
									with no terrain behind it, such as a roof against the sky, is
									an Object. Otherwise a pixel is an Object only if it is more
									than half the DEM range in front <em>and</em> at least 3 m in
									front; the margin is wide on purpose because depth error grows
									with range.
								</>
							),
						},
						{
							title: "Ground and place the objects",
							body: (
								<>
									Each connected Object component is scaled about the camera by
									the median of DEM range over model range at the cells where it
									touches calibrated terrain, so trees, poles and huts stand on
									the ground instead of floating. Components with too few
									contacts keep the calibration curve (<code>ground.ts</code>).
								</>
							),
						},
						{
							title: "Build the scene, mask the drape",
							body: (
								<>
									Surviving splats are converted to the photo's ENU frame, and a
									confidence radius is derived from their ranges (Fig. 2).
									Object pixels are then taken out of the flat photo drape, so
									the splats do not double up on their own copy.
								</>
							),
						},
						{
							title: "Step in",
							body: (
								<>
									The camera begins exactly on the solved pose and eases home
									when you leave. Photo mode is clamped to the confidence radius
									around the eye; orbit, fly and map modes roam freely but stay
									above the terrain. The Truth toggle recolours everything by
									provenance (Fig. 3).
								</>
							),
						},
					]}
				/>

				<ConfidenceDisc />

				<Flow
					nodes={[
						{ label: "accepted pose", sub: "poseAccepted" },
						{ label: "depth + splats", sub: "service, cached" },
						{ label: "anchor", sub: "quality gate" },
						{ label: "split", sub: "Terrain / Object / Far" },
						{ label: "scene", sub: "ENU splats + radius" },
						{ label: "step in", sub: "camera on the eye" },
					]}
				/>

				<Provenance />

				<div className="grid gap-6 sm:grid-cols-3">
					<Stat
						value="150 m"
						label="near radius: beyond it the DEM alone draws the world"
					/>
					<Stat
						value="200k"
						label="splats render at 60 fps; 1M runs at about 35-45 fps (reports/step-inside-results.md)"
					/>
					<Stat
						value="2"
						label="renderers (three, deck) share one near-camera DEM and agree within 3 %"
					/>
				</div>

				<RealCompression />

				<Callout
					tone="negative"
					title="The headline gate is not met"
					className="!mt-0"
				>
					Measured against hand labels, the split removes only about 4 % (three)
					or 15 % (deck) of the non-person drape smear on accepted photos,
					against an 80 % target: depth cannot separate huts and trees at
					100–300 m from the terrain behind them. The feature works end to end
					and is honest about provenance, but this part of the claim is still
					open (reports/step-inside-results.md, verdict and finding 5).
				</Callout>

				<Callout tone="note" title="Why the depth model alone is never trusted">
					The scene is only as good as the pose and the anchor beneath it. A
					scene is not drawn when the pose was not accepted, and the anchor
					residual decides whether it is shown, badged or hidden. Nothing
					generated is ever exported as a measurement.
				</Callout>

				<h3>In the code</h3>
				<div className="space-y-3">
					<ul>
						<li>
							<code>NearFieldController.build / adopt</code> orchestrates
							gating, service calls, DEM readback, scene build and the quality
							gate.
							<br />
							<CodeRef path="src/lib/nearfield/controller.ts" />
						</li>
						<li>
							<code>classifyRange</code> and <code>splitPixels</code> are the
							rule of Fig. 1; <code>DEFAULT_SPLIT</code> holds margin 0.5,
							radius 150, gap 3.
							<br />
							<CodeRef path="src/lib/nearfield/split.ts" />{" "}
							<CodeRef path="src/lib/nearfield/types.ts" />
						</li>
						<li>
							<code>buildNearFieldScene</code> and{" "}
							<code>confidenceRadiusFrom</code> produce the ENU splats and the
							disc of Fig. 2.
							<br />
							<CodeRef path="src/lib/nearfield/scene.ts" />
						</li>
						<li>
							<code>StepCamera</code> (photo, orbit, fly, map) and the Truth
							palette.
							<br />
							<CodeRef path="src/lib/nearfield/step-camera.ts" />{" "}
							<CodeRef path="src/lib/nearfield/provenance.ts" />{" "}
							<CodeRef path="src/components/nearfield/StepInsidePanel.tsx" />
						</li>
					</ul>
				</div>

				<h3>Where it fits</h3>
				<div className="space-y-3">
					<p>
						Step Inside is a consumer of the solve: the pose from{" "}
						{A("pose-estimate", "the pose estimate")}, found by{" "}
						{A("viewport-inference", "viewport inference")} and corrected by{" "}
						{A("terrain-snapping", "terrain snapping")}, is what lets a
						monocular depth map be read against the DEM at all.{" "}
						{A("dem-anchoring", "DEM anchoring")} supplies the metre ruler it
						relies on, and {A("camera-roll", "the camera roll")} reuses the same
						3D viewer for a whole day of photos.
					</p>
				</div>
			</Details>
		</>
	);
}
