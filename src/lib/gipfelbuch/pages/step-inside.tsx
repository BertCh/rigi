// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import {
	Hachure,
	HandDot,
	HandText,
	PenCircle,
	PenDimension,
	PenLine,
	SketchPath,
} from "#/components/gipfelbuch/notebook/Ink";
import { useNotebookPhoto } from "#/components/gipfelbuch/notebook/useNotebookPhoto";
import { SWISS } from "#/components/gipfelbuch/swiss/palette";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import {
	Callout,
	CodeRef,
	DemPatch,
	Eq,
	Figure,
	Flow,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	HandRange,
	Measured,
	PhotoPicker,
	PrintLabel,
	RealPhoto,
	Stat,
	Steps,
	Sym,
	useGipfelbuchPhoto,
	useTime,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Compare,
	Details,
	Key,
	Numbers,
	Stages,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";
import { PROVENANCE_COLORS } from "#/lib/nearfield/provenance";

// Step Inside: how a solved photo becomes a place you can move around in.
// Every constant below is the real default:
//   STEP_SPLIT objectMargin 0.5, nearRadius 150 m, minGapM 3 m   (src/lib/nearfield/controller.ts, types.ts DEFAULT_SPLIT)
//   classifyRange order: person > beyond radius (Far) > no DEM hit (Object) > margin + gap (Object) > Terrain (split.ts)
//   confidence radius r = min(60, 0.5 * median object range) + 10, no content -> 10 m (scene.ts confidenceRadiusFrom)
//   ANCHOR_MIN_QUALITY 0.15 hides the scene, LOW_TRUST_QUALITY 0.35 badges it (types.ts, controller.ts)
//   provenance tint colours (provenance.ts), tint mix 0.65.
// The ruler rows and the plan-view objects are illustrative values, not measurements.

const PAPER = "var(--gb-ink)";
const DEM_C = "var(--nb-brown)"; // provenance 'dem'
const OBS_C = "var(--nb-forest)"; // provenance 'observed'
/** A solid graded tint of an ink, for value-carrying marks (hatch only decorates on top). */
const tintOf = (color: string, pct = 55) =>
	`color-mix(in srgb, ${color} ${pct}%, var(--gb-paper))`;
const rectPath = (x: number, y: number, w: number, h: number) =>
	`M${x} ${y}H${x + w}V${y + h}H${x}Z`;
/** A closed polygon approximating a circle, for hachure fills. */
const discPath = (cx: number, cy: number, r: number, n = 40) =>
	`${Array.from({ length: n }, (_, i) => {
		const a = (i / n) * Math.PI * 2;
		return `${i ? "L" : "M"}${(cx + Math.cos(a) * r).toFixed(1)} ${(cy + Math.sin(a) * r).toFixed(1)}`;
	}).join("")}Z`;

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
	Object: "var(--nb-forest)",
	Terrain: "var(--nb-pencil)",
	Far: DEM_C,
	Sky: "var(--nb-navy)",
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
	{ label: "grass at feet", sub: "gap under 3 m", range: 18, dem: 20 },
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
// D1: one range ruler per pixel, the DEM against the anchored model depth
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
	const H = top + rows.length * RH + 48;

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
			label="D1"
			bleed
			caption="Schematic (illustrative rows, not measurements). The depth split, one pixel per row. Brown is how far the DEM says the terrain is along that pixel's ray; the accent dot is where the anchored model depth puts the surface. The shaded band is the Object zone (model depth under dem x (1 - margin), at least 3 m in front). Inside it the pixel is lifted into a splat; on the DEM it stays in the drape; past the near radius it is left to the terrain. Drag the two parameters, or watch the last row sweep through all three outcomes."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<svg
					viewBox={`0 0 680 ${H}`}
					className="block h-auto w-full"
					role="img"
					aria-label="Range ruler showing per-pixel classification into terrain, object and far"
				>
					{/* far region */}
					<path
						d={rectPath(
							rx(radius),
							top - 8,
							AX1 + 14 - rx(radius),
							rows.length * RH + 8,
						)}
						style={{ fill: tintOf(DEM_C, 14) }}
					/>
					<Hachure
						d={rectPath(
							rx(radius),
							top - 8,
							AX1 + 14 - rx(radius),
							rows.length * RH + 8,
						)}
						seed="si-far"
						color="brown"
						gap={6}
						opacity={0.4}
					/>
					<PenLine
						data
						seed="si-radius"
						from={[rx(radius), top - 14]}
						to={[rx(radius), top + rows.length * RH]}
						color="brown"
						width={1.3}
						dash="4 3"
					/>
					<PrintLabel
						x={rx(radius)}
						y={top - 20}
						anchor="middle"
						color="var(--gb-contour)"
					>
						nearRadius {radius} m
					</PrintLabel>
					{/* axis */}
					{ticks.map((v) => (
						<g key={v}>
							<PenLine
								seed={`si-tick-${v}`}
								from={[rx(v), top - 8]}
								to={[rx(v), top + rows.length * RH]}
								color="faint"
								width={0.5}
							/>
							<text
								x={rx(v)}
								y={H - 26}
								textAnchor="middle"
								fontSize="13"
								className="nb-num font-mono"
								fill="var(--gb-secondary)"
							>
								{v} m
							</text>
						</g>
					))}
					<PrintLabel x={AX0} y={H - 4}>
						range along the pixel ray (log scale)
					</PrintLabel>

					{rows.map((r, i) => {
						const y = top + i * RH + RH / 2;
						const c = classes[i];
						const zoneHi =
							r.dem == null ? RMAX : Math.min(r.dem * (1 - margin), r.dem - 3);
						const isProbe = i === rows.length - 1;
						const zoneW = r.person
							? AX1 - AX0
							: zoneHi > RMIN
								? Math.max(0, rx(Math.min(zoneHi, radius)) - AX0)
								: 0;
						return (
							<g key={r.label}>
								<PrintLabel x={8} y={y - 2} size={14}>
									{r.label}
								</PrintLabel>
								<PrintLabel x={8} y={y + 12} size={12}>
									{r.sub}
								</PrintLabel>
								{/* object zone */}
								{zoneW > 2 && (
									<path
										d={rectPath(AX0, y - 8, zoneW, 16)}
										style={{ fill: tintOf(OBS_C, 30) }}
									/>
								)}
								{zoneW > 2 && (
									<Hachure
										d={rectPath(AX0, y - 8, zoneW, 16)}
										seed={`si-zone-${r.label}`}
										color="forest"
										gap={4}
										width={0.9}
										opacity={0.65}
									/>
								)}
								{/* DEM tick */}
								{r.dem != null ? (
									<g>
										<PenLine
											data
											seed={`si-dem-${r.label}`}
											from={[rx(r.dem), y - 9]}
											to={[rx(r.dem), y + 9]}
											color="brown"
											width={2.2}
										/>
										<PenLine
											data
											seed={`si-gap-${r.label}`}
											from={[rx(r.range), y]}
											to={[rx(r.dem), y]}
											color="pencil"
											width={1}
											dash="2 3"
										/>
									</g>
								) : (
									<PrintLabel
										x={AX1 + 4}
										y={y - 12}
										anchor="end"
										size={12}
										color={DEM_C}
									>
										no DEM hit
									</PrintLabel>
								)}
								{/* model dot */}
								<HandDot
									x={rx(r.range)}
									y={y}
									r={isProbe ? 6 : 5}
									data
									seed={`si-dot-${r.label}`}
									color={CLS_COLOR[c]}
									opacity={1}
								/>
								<PenCircle
									seed={`si-dot-ring-${r.label}`}
									center={[rx(r.range), y]}
									radiusX={isProbe ? 8.5 : 7.5}
									color="ink"
									width={1.2}
								/>
								{/* verdict */}
								<PrintLabel x={AX1 + 22} y={y + 4} color={CLS_COLOR[c]}>
									{c} · {CLS_NOTE[c]}
								</PrintLabel>
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
				<dl className={`grid grid-cols-3 gap-x-5 font-mono ${TYPE.micro}`}>
					{(["Object", "Terrain", "Far"] as Cls[]).map((c) => (
						<div key={c}>
							<dt className="gb-secondary">{c}</dt>
							<dd
								className={` ${TYPE.caption}`}
								style={{ color: CLS_COLOR[c] }}
							>
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
		<div className="block">
			<span
				className={`flex justify-between font-mono gb-secondary ${TYPE.micro}`}
			>
				<span>{label}</span>
				<span style={{ color: PAPER }}>{fmt(value)}</span>
			</span>
			<HandRange
				value={value}
				min={min}
				max={max}
				step={step}
				label={label}
				onChange={onChange}
			/>
		</div>
	);
}

// ======================================================================================
// D2: the confidence radius, and the camera that is allowed to roam inside it
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
			label="D2"
			bleed
			caption="Schematic (illustrative objects). Plan view, looking down. The camera starts on the photo eye (the dot at the bottom) and may orbit, pan and dolly, but every position is clamped to a disc of radius r = min(60, 0.5 x median object range) + 10 m. Close subjects give a small disc because parallax would expose what one view never saw; a far panorama is capped at 70 m. Drag the median range."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<svg
					viewBox={`0 0 ${W} ${H}`}
					className="block h-auto w-full"
					role="img"
					aria-label="Plan view of the confidence radius around the photo eye with a camera clamped inside it"
				>
					{/* photo frustum from the eye: two pencil edges */}
					<SketchPath
						d={`M${ex - Math.tan(fov) * m2(med) * 2.3} ${ey - m2(med) * 2.3}L${ex} ${ey}L${ex + Math.tan(fov) * m2(med) * 2.3} ${ey - m2(med) * 2.3}`}
						seed="si-frustum"
						color="pencil"
						width={1}
						opacity={0.8}
					/>
					{/* confidence disc */}
					<circle
						cx={ex}
						cy={ey}
						r={m2(r)}
						style={{ fill: tintOf(OBS_C, 16) }}
					/>
					<Hachure
						d={discPath(ex, ey, m2(r))}
						seed="si-disc"
						color="forest"
						gap={7}
						width={0.8}
						opacity={0.45}
					/>
					<PenCircle
						data
						seed="si-disc-edge"
						center={[ex, ey]}
						radiusX={m2(r)}
						color="forest"
						width={1.5}
					/>
					<text
						x={ex + m2(r) * 0.72 + 6}
						y={ey - m2(r) * 0.72 - 4}
						fontSize={13}
						fill={SWISS.forest}
						className="gb-num"
						paintOrder="stroke"
						stroke={SWISS.paper}
						strokeWidth={3}
						strokeLinejoin="round"
					>
						r = {r.toFixed(0)} m
					</text>
					{/* median ring */}
					<PenCircle
						data
						seed="si-median"
						center={[ex, ey]}
						radiusX={m2(med)}
						color="pencil"
						width={1}
						dash="1 5"
					/>
					<PrintLabel
						x={ex - m2(med) * 0.86 - 4}
						y={ey - m2(med) * 0.5}
						anchor="end"
					>
						median object range {med} m
					</PrintLabel>
					{/* object splats */}
					{MULT.map((mu, i) => {
						const a = (ANG[i] * Math.PI) / 180;
						const rr = med * mu;
						const x = ex + Math.sin(a) * m2(rr);
						const y = ey - Math.cos(a) * m2(rr);
						return (
							<HandDot
								key={`o${ANG[i]}`}
								x={x}
								y={y}
								r={3.6}
								seed={`si-obj-${ANG[i]}`}
								color={OBS_C}
								opacity={0.95}
							/>
						);
					})}
					{/* far field: DEM */}
					<SketchPath
						d={`M${ex - 250} 24 Q${ex - 120} 6 ${ex} 20 T${ex + 250} 22`}
						seed="si-far-dem"
						color="brown"
						width={1.6}
					/>
					<PrintLabel x={ex} y={46} anchor="middle" color={DEM_C}>
						far field: DEM terrain, never moves
					</PrintLabel>
					{/* roaming camera */}
					<PenLine
						seed="si-roam"
						from={[ex, ey]}
						to={[cx, cy]}
						color="pencil"
						width={1}
						dash="2 3"
					/>
					<SketchPath
						d={`M${cone[0][0]} ${cone[0][1]}L${cx} ${cy}L${cone[1][0]} ${cone[1][1]}`}
						seed="si-cone"
						color={clamped ? "pencil" : "forest"}
						width={1.4}
						passes={1}
					/>
					<HandDot
						x={cx}
						y={cy}
						r={5.5}
						seed="si-cam"
						color="forest"
						opacity={1}
					/>
					<PenCircle
						seed="si-cam-ring"
						center={[cx, cy]}
						radiusX={8}
						color="ink"
						width={1.2}
					/>
					{/* photo eye */}
					<PenCircle
						seed="si-eye"
						center={[ex, ey]}
						radiusX={4.5}
						color="ink"
						width={1.6}
					/>
					<PrintLabel x={ex + 9} y={ey + 16}>
						photo eye
					</PrintLabel>
					{/* scale */}
					<g transform={`translate(14 ${H - 14})`}>
						<PenDimension
							data
							seed="si-scale"
							from={[0, 0]}
							to={[m2(nice), 0]}
							color="pencil"
							width={1.1}
						/>
						<text
							x={m2(nice) + 6}
							y="3"
							fontSize="11"
							className="nb-num font-mono"
							fill="var(--gb-secondary)"
						>
							{nice} m
						</text>
					</g>
					{clamped && (
						<HandText
							x={W - 10}
							y={H - 12}
							anchor="end"
							size={14}
							color="forest"
						>
							clamped to the disc
						</HandText>
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
				<dl className={`grid grid-cols-2 gap-x-6 font-mono ${TYPE.micro}`}>
					<div>
						<dt className="gb-secondary">radius</dt>
						<dd className={` ${TYPE.caption}`} style={{ color: PAPER }}>
							{r.toFixed(1)} m
						</dd>
					</div>
					<div>
						<dt className="gb-secondary">cap reached</dt>
						<dd className={` ${TYPE.caption}`} style={{ color: PAPER }}>
							{med >= 120 ? "yes (70 m)" : "no"}
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
		{
			rgb: PROVENANCE_COLORS.observed,
			n: "observed",
			d: "seen in the photo, depth-lifted",
		},
		{
			rgb: PROVENANCE_COLORS.reconstructed,
			n: "reconstructed",
			d: "model / multi-view geometry",
		},
		{ rgb: PROVENANCE_COLORS.dem, n: "dem", d: "terrain model" },
		{
			rgb: PROVENANCE_COLORS.generated,
			n: "generated",
			d: "invented, never measurable",
		},
	];
	return (
		<Figure
			label="D3"
			caption="The Truth toggle mixes 65 % of a provenance tint into every surface. The generated class is the only one filtered out of exports and readouts (provenance.ts filterForExport)."
		>
			<div className="grid gap-3 sm:grid-cols-4">
				{items.map((i) => (
					<div key={i.n} className="bg-[var(--gb-paper-deep)] p-3">
						<div
							className="h-3 w-full"
							style={{ background: `rgb(${i.rgb.join(" ")})` }}
							aria-hidden="true"
						/>
						<div
							className={`mt-2 font-mono ${TYPE.caption}`}
							style={{ color: PAPER }}
						>
							{i.n}
						</div>
						<div className={`mt-0.5 gb-secondary ${TYPE.caption}`}>{i.d}</div>
					</div>
				))}
			</div>
		</Figure>
	);
}

// ======================================================================================
// Real data: measured on the bundled Niederhorn demo photos (scripts/gipfelbuch/build-data.ts, data-step-inside.ts)
// ======================================================================================
const RANGE_IDS = ["demo-01", "demo-02", "demo-03", "demo-06"] as const;
const NEAR_R = 150; // DEFAULT_SPLIT nearRadius, m
const R_EARTH = 6_371_000;
const SKY_C = "var(--nb-blue)";

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
	const [picked] = useNotebookPhoto();
	const [chosen, setId] = useState<GipfelbuchPhotoId | null>(null);
	// follows the page-level photo when it is one of the four with a baked profile, else demo-03
	const id: GipfelbuchPhotoId =
		chosen ??
		((RANGE_IDS as readonly string[]).includes(picked) ? picked : "demo-03");
	const d = useGipfelbuchPhoto(id);
	const picker = (
		<PhotoPicker
			value={id}
			onChange={setId}
			ids={RANGE_IDS as unknown as readonly GipfelbuchPhotoId[]}
		/>
	);
	let body: ReactNode = (
		<div className="aspect-[4/3] w-full animate-pulse bg-[var(--gb-paper-deep)]" />
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
		// the right panel is 0.85 of the photo's width and as tall, so a pixel viewBox keeps strokes uniform
		const RW = 0.85 * W;
		const xp = (m: number) => (xOf(m) / 100) * RW;
		const colour = (r: number | null) =>
			r == null ? SKY_C : r < NEAR_R ? "var(--nb-forest)" : DEM_C;
		const segs: { pts: string; c: string }[] = [];
		let cur: { pts: string; c: string } | null = null;
		for (const s of samples) {
			if (s.r == null) {
				cur = null;
				continue;
			}
			const c = colour(s.r);
			const pt = `${((xOf(s.r) / 100) * RW).toFixed(1)} ${(s.v + step / 2).toFixed(1)}`;
			if (!cur || cur.c !== c) {
				cur = { pts: `M${pt}`, c };
				segs.push(cur);
			} else cur.pts += `L${pt}`;
		}
		const minR = Math.min(...ground.map((s) => s.r as number));
		const maxNear = Math.max(...near.map((s) => s.r as number), 0);
		body = (
			<div className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
				<svg
					viewBox={`0 0 ${W} ${H}`}
					className="block h-auto w-full"
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
						stroke="var(--nb-paper)"
						strokeOpacity={0.7}
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
				<div className="relative aspect-[16/9] min-h-[200px] overflow-hidden bg-[var(--gb-paper-deep)] lg:aspect-auto">
					<svg
						viewBox={`0 0 ${RW} ${H}`}
						preserveAspectRatio="none"
						className="absolute inset-0 size-full"
						aria-hidden="true"
					>
						{[10, 100, 1000, 10000].map((m) => (
							<PenLine
								key={m}
								seed={`si-rr-grid-${m}`}
								from={[xp(m), 0]}
								to={[xp(m), H]}
								color="faint"
								width={1}
							/>
						))}
						<PenLine
							data
							seed="si-rr-near"
							from={[xp(NEAR_R), 0]}
							to={[xp(NEAR_R), H]}
							color="forest"
							width={2}
							dash="8 8"
						/>
						{segs.map((s) => (
							<SketchPath
								key={s.pts.slice(0, 24)}
								d={s.pts}
								seed={`si-rr-${s.c}-${s.pts.slice(0, 16)}`}
								data
								color={s.c}
								width={3.6}
								passes={1}
								tolerance={0.8}
							/>
						))}
					</svg>
					{[
						[10, "10 m"],
						[100, "100 m"],
						[1000, "1 km"],
						[10000, "10 km"],
					].map(([m, l]) => (
						<span
							key={l}
							className={`absolute top-1 -translate-x-1/2 font-mono gb-secondary ${TYPE.micro}`}
							style={{
								left: `${Math.min(92, Math.max(8, xOf(m as number)))}%`,
							}}
						>
							{l}
						</span>
					))}
					<span
						className={`absolute bottom-1.5 font-mono text-[var(--accent)] ${TYPE.micro}`}
						style={{ left: `${xOf(NEAR_R) + 1.5}%` }}
					>
						150 m
					</span>
				</div>
			</div>
		);
		stats = (
			<p className={`mt-3 font-mono gb-secondary ${TYPE.micro}`}>
				<span className="gb-ink">
					{((near.length / ground.length) * 100).toFixed(0)} %
				</span>{" "}
				of the {ground.length * step} image rows that see ground in the central
				column hit it inside the 150 m near radius (nearest hit{" "}
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
			label="Fig. 3"
			bleed
			caption={
				<>
					Every image row on the centre line is a ray from the eye; its length
					to the first hill is read off the terrain. Green is inside 150 m,
					brown is far, blue is sky.{" "}
					<Measured data={d}>
						<span>
							Ranges ray-cast from its{" "}
							<span className="gb-ink">terrainProfile</span>.
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
		fetch("/demo/gipfelbuch/step-inside/eye.json")
			.then((r) => r.json())
			.then((v) => live && setD(v))
			.catch((e) => console.warn("[gipfelbuch] step-inside eye data", e));
		return () => {
			live = false;
		};
	}, []);
	if (!d)
		return (
			<div className="my-12 aspect-[16/7] w-full animate-pulse bg-[var(--gb-paper-deep)]" />
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
			label="Fig. 4"
			bleed
			caption={
				<>
					Bars: GPS altitude above the terrain under each photo. White tick: the
					eye height we use, never below ground plus 1.6 m. Measured by{" "}
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
						<PenLine
							seed={`si-eye-grid-${v}`}
							from={[X(v), 0]}
							to={[X(v), H - 22]}
							color="faint"
							width={0.5}
						/>
						<text
							x={X(v)}
							y={H - 6}
							textAnchor="middle"
							fontSize="11"
							className="nb-num font-mono"
							fill="var(--gb-secondary)"
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
								fontSize="11"
								className="nb-num font-mono"
								fill="var(--gb-secondary)"
							>
								{r.id}
							</text>
							<path
								d={rectPath(
									L,
									y + 3,
									Math.max(2, X(Math.min(80, Math.max(0, r.above))) - L),
									rh - 8,
								)}
								style={{ fill: tintOf(ok ? OBS_C : "var(--nb-red)", 55) }}
							/>
							<Hachure
								d={rectPath(
									L,
									y + 3,
									Math.max(2, X(Math.min(80, Math.max(0, r.above))) - L),
									rh - 8,
								)}
								seed={`si-eye-bar-${r.id}`}
								color={ok ? "forest" : "red"}
								gap={3}
								width={1}
								opacity={0.85}
							/>
							<PenLine
								data
								seed={`si-eye-use-${r.id}`}
								from={[X(r.eye - r.ground), y]}
								to={[X(r.eye - r.ground), y + rh - 2]}
								color="ink"
								width={2}
							/>
							{!ok && (
								<text
									x={L + 8}
									y={y + 14}
									fontSize={13}
									fill={SWISS.red}
									className="gb-num"
									paintOrder="stroke"
									stroke={SWISS.paper}
									strokeWidth={3}
									strokeLinejoin="round"
								>
									EXIF {r.gpsAlt.toFixed(0)} m vs ground {r.ground.toFixed(0)}{" "}
									m: eye clamped to ground + 1.6
								</text>
							)}
						</g>
					);
				})}
			</svg>
			<p className={`mt-3 font-mono gb-secondary ${TYPE.micro}`}>
				{sane.length} of {rows.length} photos report an altitude{" "}
				<span className="gb-ink">
					{lo.toFixed(0)}–{hi.toFixed(0)} m
				</span>{" "}
				above the DEM ground;{" "}
				{bad.length === 1 ? "one photo" : `${bad.length} photos`} (
				{bad.map((b) => b.id).join(", ")}) reports an altitude{" "}
				{Math.abs(bad[0]?.above ?? 0).toFixed(0)} m <em>below</em> the ground
				and falls back to the 1.6 m floor. The step-inside report found the same
				scale of error at the Niederhorn spot: GPS eye errors of 7–37 m
				(reports/step-inside-results.md, finding 7).
			</p>
		</Figure>
	);
}

/** Reported DEM/model depth ratios (reports/step-inside-results.md, finding 1; MoGe-2 vs the DEM on terrain pixels). */
function RealCompression() {
	const bands = [
		{ band: "about 20 m", ratio: 1 },
		{ band: "100–300 m", ratio: 2.9 },
		{ band: "300–1000 m", ratio: 6.6 },
	];
	const W = 720;
	const L = 110;
	const X = (v: number) => L + (v / 7) * (W - L - 40);
	return (
		<Figure
			label="D4"
			caption="Why the anchor exists. The monocular model (MoGe-2) compresses range: the DEM distance divided by the model distance, on terrain pixels, is about 1 at 20 m but 2.9 at 100–300 m and 6.6 at 300–1000 m. One global scale would leave a median terrain error of 0.34 (log); a per-photo monotone log-log curve brings it to 0.13. Figures quoted from reports/step-inside-results.md findings 1 and 2 (2026-09-29), not measured by the gipfelbuch script."
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
						<PenLine
							seed={`si-comp-grid-${v}`}
							from={[X(v), 8]}
							to={[X(v), 100]}
							color="faint"
							width={0.5}
						/>
						<text
							x={X(v)}
							y={118}
							textAnchor="middle"
							fontSize="11"
							className="nb-num font-mono"
							fill="var(--gb-secondary)"
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
							className="nb-num font-mono"
							fill="var(--gb-secondary)"
						>
							{b.band}
						</text>
						<path
							d={rectPath(L, 18 + i * 30, X(b.ratio) - L, 18)}
							style={{ fill: tintOf(OBS_C, 45 + i * 20) }}
						/>
						<Hachure
							d={rectPath(L, 18 + i * 30, X(b.ratio) - L, 18)}
							seed={`si-comp-bar-${b.band}`}
							color="forest"
							gap={3.2 - i * 0.5}
							width={1}
							opacity={0.9}
						/>
						<PrintLabel x={X(b.ratio) + 8} y={31 + i * 30}>
							{b.ratio}×
						</PrintLabel>
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
function rangeSamples(d: GipfelbuchPhotoData) {
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
	d: GipfelbuchPhotoData;
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
				fill="var(--nb-paper)"
				fillOpacity={0.7}
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
							? "var(--nb-forest)"
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
	const [heroPhoto] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(heroPhoto);
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
			plate
			caption={
				<>
					{near == null
						? "The terrain model tells us how far away each pixel is."
						: `Along this photo's centre line, ${near} % of the ground we can see lies within 150 m.`}{" "}
					<Measured data={d} />
				</>
			}
		>
			<Stages
				stages={[
					{
						label: "Photo",
						caption: "A solved photo knows exactly where its camera stood.",
						render: () => <RealPhoto data={d} layers={[]} bleed />,
					},
					{
						label: "How far?",
						caption:
							"Down the centre we ask the terrain model: bright is near, dark is far.",
						render: () => (
							<RealPhoto data={d} layers={[]} bleed>
								{(x) => <RangeBar d={x} mode="ramp" />}
							</RealPhoto>
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
							<RealPhoto data={d} layers={[]} bleed>
								{(x) => <RangeBar d={x} mode="split" />}
							</RealPhoto>
						),
					},
				]}
			/>
		</Figure>
	);
}

type SplitData = {
	generated: string;
	script: string;
	photo: string;
	photoId: string;
	model: string;
	classes: {
		sky: number;
		terrain: number;
		object: number;
		far: number;
		total: number;
	};
	anchor: {
		quality: number;
		n: number;
		curve: { x: number[]; y: number[] };
	};
	medianObjectRange: number;
};

function useSplitData() {
	const [d, setD] = useState<SplitData | null>(null);
	useEffect(() => {
		let live = true;
		fetch("/demo/gipfelbuch/step-inside/split.json")
			.then((r) => r.json())
			.then((v) => live && setD(v))
			.catch((e) => console.warn("[gipfelbuch] step-inside split data", e));
		return () => {
			live = false;
		};
	}, []);
	return d;
}

/** The anchor curve of the baked scene: model range (x) against the range the terrain says (y), both log. */
function AnchorCurve({ d }: { d: SplitData }) {
	const { x, y } = d.anchor.curve;
	const W = 360;
	const H = 250;
	const L = 46;
	const B = 34;
	const lo = Math.log(10);
	const hi = Math.log(3000);
	const X = (lx: number) => L + ((lx - lo) / (hi - lo)) * (W - L - 8);
	const Y = (ly: number) => 8 + (1 - (ly - lo) / (hi - lo)) * (H - B - 8);
	const ticks = [10, 30, 100, 300, 1000, 3000];
	// the curve's own points, then slope 1 beyond the last (anchor.ts curveRange)
	const last = x.length - 1;
	const pts: [number, number][] = x.map((v, i) => [v, y[i]]);
	pts.push([
		x[last] + (hi - y[last] > 0 ? Math.min(hi - y[last], 0.9) : 0),
		y[last] + Math.min(hi - y[last], 0.9),
	]);
	const near = Math.log(NEAR_R);
	// model range at which the anchored range crosses the 150 m radius (log-log interpolation on the data)
	let crossModel: number | null = null;
	for (let i = 0; i < last; i++)
		if (y[i] <= near && y[i + 1] >= near)
			crossModel = Math.exp(
				x[i] + ((near - y[i]) / (y[i + 1] - y[i])) * (x[i + 1] - x[i]),
			);
	const curvePath = pts
		.map(([a, b], i) => `${i ? "L" : "M"}${X(a)},${Y(b)}`)
		.join("");
	return (
		<svg
			viewBox={`0 0 ${W} ${H}`}
			className="block h-auto w-full"
			role="img"
			aria-label="Anchor curve: the depth model's range against the range the terrain gives, both on log axes"
		>
			<title>Anchor curve</title>
			{ticks.map((t) => (
				<g key={t}>
					<PenLine
						seed={`si-ac-gx-${t}`}
						from={[X(Math.log(t)), 8]}
						to={[X(Math.log(t)), H - B]}
						color="faint"
						width={0.5}
					/>
					<PenLine
						seed={`si-ac-gy-${t}`}
						from={[L, Y(Math.log(t))]}
						to={[W - 8, Y(Math.log(t))]}
						color="faint"
						width={0.5}
					/>
					<text
						x={X(Math.log(t))}
						y={H - B + 14}
						textAnchor={t === 3000 ? "end" : "middle"}
						fontSize="11"
						className="nb-num font-mono"
						fill="var(--gb-secondary)"
					>
						{t >= 1000 ? `${t / 1000} km` : `${t} m`}
					</text>
					<text
						x={L - 5}
						y={Y(Math.log(t)) + 3}
						textAnchor="end"
						fontSize="11"
						className="nb-num font-mono"
						fill="var(--gb-secondary)"
					>
						{t >= 1000 ? `${t / 1000} km` : `${t} m`}
					</text>
				</g>
			))}
			<PenLine
				data
				seed="si-ac-identity"
				from={[X(lo), Y(lo)]}
				to={[X(hi), Y(hi)]}
				color="pencil"
				width={1.1}
				dash="4 4"
			/>
			<g transform={`rotate(-38 ${X(Math.log(700))} ${Y(Math.log(520))})`}>
				<PrintLabel x={X(Math.log(700))} y={Y(Math.log(520))}>
					model as is
				</PrintLabel>
			</g>
			<PenLine
				data
				seed="si-ac-near"
				from={[L, Y(near)]}
				to={[W - 8, Y(near)]}
				color="forest"
				width={1.2}
				dash="3 3"
			/>
			<text
				x={W - 10}
				y={Y(near) - 5}
				textAnchor="end"
				fontSize={13}
				fill={SWISS.forest}
				className="gb-num"
				paintOrder="stroke"
				stroke={SWISS.paper}
				strokeWidth={3}
				strokeLinejoin="round"
			>
				150 m near radius
			</text>
			<SketchPath
				d={curvePath}
				seed="si-ac-curve"
				data
				color="brown"
				width={2.2}
				passes={1}
			/>
			{x.map((a, i) => (
				<circle key={a} cx={X(a)} cy={Y(y[i])} r={3.6} fill={SWISS.contour} />
			))}
			{crossModel != null && (
				<PenLine
					data
					seed="si-ac-cross"
					from={[X(Math.log(crossModel)), Y(near)]}
					to={[X(Math.log(crossModel)), H - B]}
					color="forest"
					width={1.2}
				/>
			)}
			<PrintLabel x={(L + W) / 2} y={H - 4} anchor="middle">
				range the depth model says
			</PrintLabel>
			<g transform={`rotate(-90 10 ${(H - B) / 2})`}>
				<PrintLabel
					x={10}
					y={(H - B) / 2}
					anchor="middle"
					color="var(--gb-contour)"
				>
					range after anchoring to the terrain
				</PrintLabel>
			</g>
		</svg>
	);
}

function RealSplit() {
	const d = useSplitData();
	if (!d)
		return (
			<div className="my-12 aspect-[16/10] w-full animate-pulse bg-[var(--gb-paper-deep)]" />
		);
	const c = d.classes;
	const ground = c.total - c.sky;
	const pct = (v: number) => Math.round((v / ground) * 100);
	const photo = (overlay: boolean) => (
		<div className="relative">
			<img
				src={d.photo}
				alt="A hiker on the Niederhorn ridge above Lake Thun"
				className="block h-auto w-full"
			/>
			{overlay && (
				<img
					src="/demo/gipfelbuch/step-inside/split.png"
					alt=""
					className="absolute inset-0 size-full"
				/>
			)}
		</div>
	);
	return (
		<Figure
			label="Fig. 2"
			bleed
			caption={
				<>
					What the split decided on one baked photo.{" "}
					<Key color="var(--accent)">Lifted into 3D</Key>: {pct(c.object)} % of
					the pixels that are not sky, mostly the hiker and the lift cabin.{" "}
					<Key color={DEM_C}>Left to the terrain</Key>: {pct(c.far)} %. The
					hiker is lifted by the people mask, not by depth.{" "}
					<Measured
						data={d as unknown as { script: string; generated: string }}
					/>
				</>
			}
		>
			<div className="grid items-center gap-5 lg:grid-cols-[1.5fr_1fr]">
				<Compare
					beforeLabel="photo"
					afterLabel="what the split decided"
					start={0.5}
					before={photo(false)}
					after={photo(true)}
				/>
				<div>
					<AnchorCurve d={d} />
					<p className={`mt-2 font-mono gb-secondary ${TYPE.micro}`}>
						The fitted curve: the model says{" "}
						{Math.exp(d.anchor.curve.x[3]).toFixed(0)} m where the terrain says{" "}
						{Math.exp(d.anchor.curve.y[3]).toFixed(0)} m. Fit quality{" "}
						{d.anchor.quality.toFixed(2)}, from{" "}
						{d.anchor.n.toLocaleString("en")} terrain pixels.
					</p>
				</div>
			</div>
		</Figure>
	);
}

function MiniBars() {
	const bands = [
		{ band: "20 m", ratio: 1 },
		{ band: "100–300 m", ratio: 2.9 },
		{ band: "300–1000 m", ratio: 6.6 },
	];
	return (
		<svg
			viewBox="0 0 200 150"
			className="block h-auto w-full"
			role="img"
			aria-label="The terrain range divided by the depth-model range grows with distance: 1 times at 20 metres, 6.6 times at 300 to 1000 metres"
		>
			<title>Terrain range divided by depth-model range, by distance</title>
			<PrintLabel x={8} y={14}>
				terrain ÷ model range
			</PrintLabel>
			{bands.map((b, i) => (
				<g key={b.band}>
					<PrintLabel x={8} y={31 + i * 38}>
						{b.band}
					</PrintLabel>
					<path
						d={rectPath(8, 36 + i * 38, Math.max(6, (b.ratio / 6.6) * 150), 14)}
						style={{ fill: tintOf(OBS_C, 45 + i * 20) }}
					/>
					<Hachure
						d={rectPath(8, 36 + i * 38, Math.max(6, (b.ratio / 6.6) * 150), 14)}
						seed={`si-mini-bar-${b.band}`}
						color="forest"
						gap={3.2 - i * 0.5}
						width={1}
						opacity={0.9}
					/>
					<PrintLabel
						x={Math.max(6, (b.ratio / 6.6) * 150) + 14}
						y={48 + i * 38}
					>
						{b.ratio}×
					</PrintLabel>
				</g>
			))}
		</svg>
	);
}

function MiniSplit() {
	const [photo] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photo);
	return (
		<RealPhoto data={d} layers={[]}>
			{(x) => <RangeBar d={x} mode="split" width={40} />}
		</RealPhoto>
	);
}

function MiniEye() {
	const [photo] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photo);
	return <DemPatch data={d} cone={["solved"]} peaks={false} />;
}

export default function Page({ node }: { node: GipfelbuchNode }) {
	void node;
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

			<RealSplit />

			<Beat
				kicker="Down the centre line"
				title="Every image row has a range, and 150 m splits them."
			>
				<p>
					Pick a photo. The stripe beside it marks each row of the central
					column: green is inside 150 m, brown is far, blue is sky.
				</p>
			</Beat>

			<RealRange />

			<Eq
				label="The split rule, per pixel"
				where={[
					{
						sym: "ρ",
						c: "var(--accent)",
						text: "range from the depth model, after anchoring to the terrain, in metres",
					},
					{
						sym: (
							<>
								ρ<sub>DEM</sub>
							</>
						),
						c: DEM_C,
						text: "range to the terrain along the same ray, from the terrain model",
					},
				]}
			>
				<div>
					<Sym c="var(--accent)">ρ</Sym> &lt; ½{" "}
					<Sym c={DEM_C}>
						ρ<sub>DEM</sub>
					</Sym>{" "}
					<span className="gb-secondary">and</span>{" "}
					<Sym c={DEM_C}>
						ρ<sub>DEM</sub>
					</Sym>{" "}
					− <Sym c="var(--accent)">ρ</Sym> ≥ 3 m
				</div>
				<div>
					<span className="gb-secondary">and</span>{" "}
					<Sym c="var(--accent)">ρ</Sym> ≤ 150 m{" "}
					<span className="gb-secondary">⇒ object</span>
				</div>
			</Eq>

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
							body: "A pixel well in front of the terrain is an object. Beyond 150 m, terrain only.",
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
					Beyond 100 m the depth model drifts, and objects blur into the slope.
					The start point is also uncertain, because phone GPS height is rough.
				</p>
			</Beat>

			<RealEye />

			<Numbers
				items={[
					{
						value: "150 m",
						label: "near radius, beyond which only terrain is drawn",
					},
					{ value: "60 fps", label: "with 200 000 splats on screen" },
					{
						value: "15 %",
						label: "of non-person drape smear removed on deck.gl (WebGL2)",
					},
					{ value: "80 %", label: "was the target, so the gate is not met" },
				]}
				source={
					<>reports/step-inside-results.md (verdict, rendering, finding 5).</>
				}
			/>

			<Details>
				<h3>The split rule, tunable (illustrative rows)</h3>
				<SplitRuler />

				<h3>How it works</h3>
				<div className="space-y-3">
					<p>
						The split in Fig. 2 is the heart of it: the per-pixel decision in{" "}
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
									always Objects. Beyond 150 m everything is Far. A model pixel
									with no terrain behind it, such as a roof against the sky, is
									an Object. Otherwise a pixel is an Object only if it is more
									than half the DEM range in front <em>and</em> at least 3 m in
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
						value="150 m"
						label="near radius: beyond it the DEM alone draws the world"
					/>
					<Stat
						value="200k"
						label="splats render at 60 fps; 1M runs at about 35-45 fps (reports/step-inside-results.md)"
					/>
					<Stat
						value="2"
						label="renderers shared one near-camera DEM and agreed within 3 % (three.js has since been removed)"
					/>
				</div>

				<RealCompression />

				<Callout
					tone="negative"
					title="The headline gate is not met"
					className="!mt-0"
				>
					Measured against hand labels, the split removed about 15 % of the
					non-person drape smear on accepted photos with deck.gl (4 % with the
					since-removed three.js engine), against an 80 % target: depth cannot
					separate huts and trees at 100–300 m from the terrain behind them. The
					feature works end to end and is honest about provenance, but this part
					of the claim is still open (reports/step-inside-results.md, verdict
					and finding 5).
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
