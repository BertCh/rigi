// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import {
	Hachure,
	HandDot,
	HandText,
	PenArrow,
	PenCircle,
	PenDimension,
	PenLine,
	SketchPath,
} from "#/components/gipfelbuch/notebook/Ink";
import {
	CircledNumber,
	HandMark,
	Wash,
} from "#/components/gipfelbuch/notebook/marks";
import { useNotebookPhoto } from "#/components/gipfelbuch/notebook/useNotebookPhoto";
import { SWISS } from "#/components/gipfelbuch/swiss/palette";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import {
	Callout,
	CodeRef,
	DemPatch,
	Eq,
	Figure,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	HandLabel,
	HandRange,
	LiveStepInside,
	MarginNote,
	Measured,
	PhotoPicker,
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
	Object: "lifted to 3D",
	Terrain: "photo drape",
	Far: "terrain only",
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
	{ label: "climber", sub: "person mask", range: 14, dem: 31, person: true },
	{ label: "hut roof", sub: "against the sky", range: 38, dem: null },
	{ label: "boulder", sub: "well in front", range: 22, dem: 58 },
	{ label: "fence post", sub: "just above ground", range: 45, dem: 52 },
	{ label: "meadow", sub: "matches terrain", range: 71, dem: 74 },
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
	const [ref, t] = useTime<HTMLDivElement>(10);
	const [margin, setMargin] = useState(0.5);
	const [radius, setRadius] = useState(150);

	// the probe: a pixel whose model range sweeps through a ray that hits terrain at 140 m
	const probeDem = 140;
	// one pass in and out (0 to 7 s), then it eases back to rest on the ground, where range matches the terrain
	const kPass = 0.5 - 0.5 * Math.cos(Math.min(t, 7) * 0.45);
	const settle = Math.min(1, Math.max(0, (t - 7) / 3));
	const k = kPass + (0.77 - kPass) * settle * settle * (3 - 2 * settle);
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
			caption="Schematic with made-up rows, one pixel per row. Brown tick: how far the terrain model says the ground is along that pixel's ray. Dot: where the depth model puts the surface. Shaded band: the object zone, at least 3 m and a set share of the terrain distance in front of the ground. Objects are lifted into 3D; ground stays in the photo; beyond the near radius only terrain is drawn. Drag the sliders, or watch the last row."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<svg
					viewBox={`0 0 680 ${H}`}
					className="block h-auto w-full"
					role="img"
					aria-label="Range ruler showing per-pixel classification into terrain, object and far"
				>
					{/* far region */}
					<Wash
						d={rectPath(
							rx(radius),
							top - 8,
							AX1 + 14 - rx(radius),
							rows.length * RH + 8,
						)}
						color="brown"
						seed="si-wash-1"
						opacity={0.04}
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
					<HandLabel
						x={rx(radius)}
						y={top - 20}
						anchor="middle"
						color="var(--gb-contour)"
					>
						near radius {radius} m
					</HandLabel>
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
							<HandLabel
								x={rx(v)}
								y={H - 26}
								anchor="middle"
								size={13}
								color="var(--gb-secondary)"
								halo={0}
							>
								{v} m
							</HandLabel>
						</g>
					))}
					<HandLabel x={AX0} y={H - 4}>
						distance along the ray (log scale)
					</HandLabel>
					<PenArrow
						from={[rx(probe.range), H - 56]}
						to={[rx(probe.range), top + (rows.length - 1) * RH + RH / 2 + 12]}
						seed="si-probe-arrow"
						color="pencil"
						width={1}
					/>
					<HandText
						x={rx(probe.range) + 8}
						y={H - 52}
						size={16}
						color="pencil"
						rotate={-2}
					>
						{`probe: model ${probe.range.toFixed(0)} m, terrain ${probeDem} m, so ${classes[classes.length - 1]}`}
					</HandText>

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
								<HandLabel x={8} y={y - 2} size={14}>
									{r.label}
								</HandLabel>
								<HandLabel x={8} y={y + 12} size={12}>
									{r.sub}
								</HandLabel>
								{/* object zone */}
								{zoneW > 2 && (
									<Wash
										d={rectPath(AX0, y - 8, zoneW, 16)}
										color="forest"
										seed="si-wash-2"
										opacity={0.07}
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
									<HandLabel
										x={AX1 + 4}
										y={y - 12}
										anchor="end"
										size={12}
										color={DEM_C}
									>
										no terrain behind
									</HandLabel>
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
								<HandLabel x={AX1 + 22} y={y + 4} color={CLS_COLOR[c]}>
									{c} · {CLS_NOTE[c]}
								</HandLabel>
							</g>
						);
					})}
				</svg>
			</div>

			<div className="mt-4 grid gap-4 md:grid-cols-[1fr_1fr_auto]">
				<Slider
					label="margin"
					value={margin}
					min={0.1}
					max={0.9}
					step={0.05}
					fmt={(v) => v.toFixed(2)}
					onChange={setMargin}
				/>
				<Slider
					label="near radius"
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
	const [ref, t] = useTime<HTMLDivElement>(10);
	const [med, setMed] = useState(40);
	const r = Math.min(60, 0.5 * med) + 10; // confidenceRadiusFrom
	const W = 640;
	const H = 330;
	const ex = W / 2;
	const ey = H - 26;
	const s = 215 / (2.2 * med); // px per metre, adaptive so the scene always fits
	const m2 = (v: number) => v * s;

	// a wandering target offset, clamped to the radius exactly as StepCamera clamps position
	// it wanders for 8 s, then eases to a target past the edge and rests there, pinned to the disc
	const tw = Math.min(t, 8);
	const rest = Math.min(1, Math.max(0, (t - 8) / 2));
	const e = rest * rest * (3 - 2 * rest);
	let ox =
		(1 - e) *
			(1.5 * r * Math.sin(tw * 0.5) + 0.6 * r * Math.sin(tw * 1.3 + 1)) +
		e * 1.6 * r;
	let oy = (1 - e) * (1.2 * r * Math.sin(tw * 0.37 + 0.8)) + e * 0.9 * r;
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
			caption="Schematic, seen from above. The camera starts at the photo's position (bottom dot) and can roam only inside a disc of radius r = min(60, half the median object distance) + 10 m. Close subjects get a small disc, because moving would reveal what the photo never saw. Far views cap at 70 m. Drag the median distance."
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
					<Wash
						d={discPath(ex, ey, m2(r))}
						color="forest"
						seed="si-wash-disc"
						opacity={0.045}
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
					<HandLabel
						x={ex + m2(r) * 0.72 + 6}
						y={ey - m2(r) * 0.72 - 4}
						size={13}
						color={SWISS.forest}
					>
						r = {r.toFixed(0)} m
					</HandLabel>
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
					<HandLabel
						x={ex - m2(med) * 0.86 - 4}
						y={ey - m2(med) * 0.5}
						anchor="end"
					>
						median object range {med} m
					</HandLabel>
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
					<HandLabel x={ex} y={46} anchor="middle" color={DEM_C}>
						far field: terrain model, fixed
					</HandLabel>
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
					<HandLabel x={ex + 9} y={ey + 16}>
						photo position
					</HandLabel>
					<PenArrow
						from={[ex - m2(r) * 0.95 - 4, ey - m2(r) * 0.2 - 40]}
						to={[ex - m2(r) * 0.72, ey - m2(r) * 0.72 + 6]}
						seed="si-disc-note-arrow"
						color="pencil"
						width={1}
					/>
					<HandText
						x={ex - m2(r) * 0.95 - 8}
						y={ey - m2(r) * 0.2 - 44}
						anchor="end"
						size={16}
						color="pencil"
						rotate={-2}
					>
						{`median ${med} m, so only ${r.toFixed(0)} m to roam`}
					</HandText>
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
						<HandLabel
							x={m2(nice) + 6}
							y={3}
							size={11}
							color="var(--gb-secondary)"
							halo={0}
						>
							{nice} m
						</HandLabel>
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
					label="median object distance"
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
			d: "rebuilt by a model",
		},
		{ rgb: PROVENANCE_COLORS.dem, n: "terrain", d: "from the terrain model" },
		{
			rgb: PROVENANCE_COLORS.generated,
			n: "generated",
			d: "invented, never a measurement",
		},
	];
	return (
		<Figure
			label="D3"
			caption="The Truth toggle tints every surface by where it came from. Generated surfaces are never exported or measured."
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
				of the {ground.length * step} ground rows in the centre column land
				inside 150 m (nearest {minR.toFixed(0)} m
				{near.length ? `, farthest ${maxNear.toFixed(0)} m` : ""}). The rest is{" "}
				<em> far</em> and is left to the terrain model. Camera height here:{" "}
				{(d.gps.eye - d.gps.ground).toFixed(0)} m above ground.
			</p>
		);
	}
	return (
		<Figure
			label="Fig. 4"
			bleed
			caption={
				<>
					Each image row on the centre line is a ray from the camera; the
					terrain model gives the ray's length. Green: inside 150 m. Brown: far.
					Blue: sky. <Measured data={d} />
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
			label="Fig. 5"
			bleed
			caption={
				<>
					Bars: GPS height above the ground under each photo. White tick: the
					camera height we use, at least ground + 1.6 m.
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
						<HandLabel
							x={X(v)}
							y={H - 6}
							anchor="middle"
							size={11}
							color="var(--gb-secondary)"
							halo={0}
						>
							{v} m
						</HandLabel>
					</g>
				))}
				{rows.map((r, i) => {
					const y = 4 + i * rh;
					const ok = r.above > 0 && r.above < 200;
					return (
						<g key={r.id}>
							<HandLabel
								x={L - 8}
								y={y + 13}
								anchor="end"
								size={11}
								color="var(--gb-secondary)"
								halo={0}
							>
								{r.id}
							</HandLabel>
							<Wash
								d={rectPath(
									L,
									y + 3,
									Math.max(2, X(Math.min(80, Math.max(0, r.above))) - L),
									rh - 8,
								)}
								color={ok ? "forest" : "red"}
								seed="si-wash-3"
								opacity={0.1}
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
								<HandLabel x={L + 8} y={y + 14} size={13} color={SWISS.red}>
									GPS {r.gpsAlt.toFixed(0)} m, ground {r.ground.toFixed(0)} m:
									set to ground + 1.6 m
								</HandLabel>
							)}
						</g>
					);
				})}
			</svg>
			<p className={`mt-3 font-mono gb-secondary ${TYPE.micro}`}>
				{sane.length} of {rows.length} photos report a GPS height{" "}
				<span className="gb-ink">
					{lo.toFixed(0)}–{hi.toFixed(0)} m
				</span>{" "}
				above ground; {bad.length === 1 ? "one photo" : `${bad.length} photos`}{" "}
				({bad.map((b) => b.id).join(", ")}) reports{" "}
				{Math.abs(bad[0]?.above ?? 0).toFixed(0)} m <em>below</em> ground and
				gets the 1.6 m floor. Elsewhere on the Niederhorn, GPS height errors of
				7–37 m were found.
			</p>
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
						? "The terrain model gives the distance to the ground at each pixel."
						: `Along this photo's centre line, ${near} % of the ground we can see lies within 150 m.`}{" "}
					<Measured data={d} />
				</>
			}
		>
			<Stages
				stages={[
					{
						label: "Photo",
						caption: "A solved photo has a known camera position.",
						render: () => <RealPhoto data={d} layers={[]} bleed />,
					},
					{
						label: "How far?",
						caption:
							"Along the centre column Rigi reads the terrain model's distance: bright is near, dark is far.",
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
								<Key color="var(--accent)">nearby objects become 3D</Key>.
								Beyond it,{" "}
								<Key color={DEM_C}>the terrain model supplies the surface</Key>.
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
					<HandLabel
						x={X(Math.log(t))}
						y={H - B + 14}
						anchor={t === 3000 ? "end" : "middle"}
						size={11}
						color="var(--gb-secondary)"
						halo={0}
					>
						{t >= 1000 ? `${t / 1000} km` : `${t} m`}
					</HandLabel>
					<HandLabel
						x={L - 5}
						y={Y(Math.log(t)) + 3}
						anchor="end"
						size={11}
						color="var(--gb-secondary)"
						halo={0}
					>
						{t >= 1000 ? `${t / 1000} km` : `${t} m`}
					</HandLabel>
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
				<HandLabel x={X(Math.log(700))} y={Y(Math.log(520))}>
					raw depth model
				</HandLabel>
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
			<HandLabel
				x={W - 10}
				y={Y(near) - 5}
				anchor="end"
				size={13}
				color={SWISS.forest}
			>
				150 m near radius
			</HandLabel>
			<SketchPath
				d={curvePath}
				seed="si-ac-curve"
				data
				color="brown"
				width={2.2}
				passes={1}
			/>
			{x.map((a, i) => (
				<HandDot
					key={a}
					x={X(a)}
					y={Y(y[i])}
					r={3.6}
					seed={`si-ac-dot-${a}`}
					data
					color={SWISS.contour}
				/>
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
			<HandLabel x={(L + W) / 2} y={H - 4} anchor="middle">
				range the depth model says
			</HandLabel>
			<g transform={`rotate(-90 10 ${(H - B) / 2})`}>
				<HandLabel
					x={10}
					y={(H - B) / 2}
					anchor="middle"
					color="var(--gb-contour)"
				>
					range after anchoring to the terrain
				</HandLabel>
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
			label="Fig. 3"
			bleed
			caption={
				<>
					What the split decided on one photo.{" "}
					<Key color="var(--accent)">Lifted into 3D</Key>: {pct(c.object)} % of
					non-sky pixels, mostly the hiker and the lift cabin.{" "}
					<Key color={DEM_C}>Left to terrain</Key>: {pct(c.far)} %. The hiker is
					picked out by the person mask, not by depth.{" "}
					<Measured
						data={d as unknown as { script: string; generated: string }}
					/>
				</>
			}
		>
			<div className="grid items-center gap-5 lg:grid-cols-[1.5fr_1fr]">
				<Compare
					beforeLabel="photo"
					afterLabel="after the split"
					start={0.5}
					before={photo(false)}
					after={photo(true)}
				/>
				<div>
					<AnchorCurve d={d} />
					<p className={`mt-2 font-mono gb-secondary ${TYPE.micro}`}>
						Fitted curve: model {Math.exp(d.anchor.curve.x[3]).toFixed(0)} m =
						terrain {Math.exp(d.anchor.curve.y[3]).toFixed(0)} m. Fit quality{" "}
						{d.anchor.quality.toFixed(2)}, {d.anchor.n.toLocaleString("en")}{" "}
						ground pixels.
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
			<HandLabel x={8} y={14}>
				terrain ÷ model range
			</HandLabel>
			{bands.map((b, i) => (
				<g key={b.band}>
					<HandLabel x={8} y={31 + i * 38}>
						{b.band}
					</HandLabel>
					<Wash
						d={rectPath(8, 36 + i * 38, Math.max(6, (b.ratio / 6.6) * 150), 14)}
						color="forest"
						seed="si-wash-5"
						opacity={0.05 + i * 0.02}
					/>
					<Hachure
						d={rectPath(8, 36 + i * 38, Math.max(6, (b.ratio / 6.6) * 150), 14)}
						seed={`si-mini-bar-${b.band}`}
						color="forest"
						gap={3.2 - i * 0.5}
						width={1}
						opacity={0.9}
					/>
					<HandLabel
						x={Math.max(6, (b.ratio / 6.6) * 150) + 14}
						y={48 + i * 38}
					>
						{b.ratio}×
					</HandLabel>
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
				title="Far terrain comes from the map; only nearby objects are rebuilt in 3D."
			>
				<p>
					The terrain model contains the mountains.{" "}
					<HandMark type="highlight">
						It does not contain a hut ten metres away.
					</HandMark>
				</p>
				<p>
					So Rigi uses the terrain model for the terrain and lifts only objects
					in front of it into 3D. The camera then starts{" "}
					<HandMark type="underline">
						exactly where the photo was taken
					</HandMark>
					.
					<MarginNote mark="a">
						Inside the 150 m radius Rigi rebuilds objects; outside it Rigi uses
						the terrain model.
					</MarginNote>
				</p>
			</Beat>

			<LiveStepInside number="2" />

			<RealSplit />

			<Beat
				kicker="Along the centre column"
				title="Each image row has a distance, and 150 m separates near from far."
			>
				<p>
					Pick a photo. The stripe beside it marks each row of the central
					column: <CircledNumber value={1} color="forest" /> green is inside 150
					m, <CircledNumber value={2} color="brown" /> brown is far, blue is
					sky.
					<MarginNote mark="b">
						Low rows show nearby ground; higher up the stripe turns brown.
					</MarginNote>
				</p>
			</Beat>

			<RealRange />

			<Eq
				label="Split rule, per pixel"
				where={[
					{
						sym: "ρ",
						c: "var(--accent)",
						text: "distance from the depth model, anchored to the terrain (m)",
					},
					{
						sym: (
							<>
								ρ<sub>DEM</sub>
							</>
						),
						c: DEM_C,
						text: "distance to the terrain along the same ray (m)",
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
				title="Rescale depth, split every pixel, place the camera at the photo position."
			>
				<Trio
					steps={[
						{
							title: "Fix the scale",
							body: (
								<>
									A depth model compresses far distances; Rigi rescales it
									against the terrain ({A("dem-anchoring", "DEM anchoring")}).
								</>
							),
							visual: <MiniBars />,
						},
						{
							title: "Split near from far",
							body: "A pixel well in front of the terrain is an object. Beyond 150 m, terrain only.",
							visual: <MiniSplit />,
						},
						{
							title: "Place the camera at the photo position",
							body: "The camera starts where the photo was taken and stays close.",
							visual: <MiniEye />,
						},
					]}
				/>
			</Beat>

			<Beat
				kicker="Where it fails"
				title="Depth alone cannot separate a hut from the hill behind it."
			>
				<p>
					<HandMark type="wavy">Beyond 100 m the depth model drifts</HandMark>,
					and objects blur into the slope. The camera height is also uncertain,
					because phone GPS height is rough.
					<MarginNote mark="c">
						Beyond 150 m Rigi does not rebuild objects.
					</MarginNote>
				</p>
			</Beat>

			<RealEye />

			<Numbers
				items={[
					{
						value: "150 m",
						label: "near radius, beyond which only terrain is drawn",
					},
					{ value: "17 835", label: "splats rebuilt from the one demo photo" },
					{
						value: "15 %",
						label: "of ground smear removed; the goal was 80 %",
					},
				]}
				source="Radius: DEFAULT_SPLIT in src/lib/nearfield/controller.ts. Splats: public/demo/step/scene.json (IMG_7086). Smear: tools/nearfield/smear/REPORT.txt, deck renderer, 14 hand-labelled photos."
			/>

			<Details>
				<h3>The split rule, adjustable</h3>
				<SplitRuler />

				<h3>The pipeline, step by step</h3>
				<div className="space-y-3">
					<p>
						The split in D1 is{" "}
						<HandMark type="circle">the core of the method</HandMark>. The rest
						of the pipeline makes that comparison meaningful and turns the
						result into a scene you can move around in.
					</p>
				</div>
				<Steps
					steps={[
						{
							title: "Only accepted poses",
							body: (
								<>
									Only photos whose camera position was confirmed by the solver
									or set by you are used. See{" "}
									{A("accept-rule", "the accept rule")}. If WebGPU or the depth
									model is unavailable, the feature is not offered.
								</>
							),
						},
						{
							title: "Get depth and 3D points",
							body: (
								<>
									A depth model and a 3D-point model run once per photo and are
									cached, so changing the pose does not repeat the slow part.
									Meanwhile the renderer reads the terrain distance for every
									depth cell.
								</>
							),
						},
						{
							title: "Anchor model depth to the DEM",
							body: (
								<>
									Model depth is turned into metres against the terrain. How the
									curve is fitted, and when a poor fit hides the scene, is on{" "}
									{A("dem-anchoring", "DEM anchoring")}.
								</>
							),
						},
						{
							title: "Split every pixel",
							body: (
								<>
									Compare model distance with terrain distance (D1). People are
									always objects. A pixel with no terrain behind it, like a roof
									against the sky, is an object. Every other pixel follows the
									split rule above; its margin is wide because depth error grows
									with distance.
								</>
							),
						},
						{
							title: "Ground and place the objects",
							body: (
								<>
									Each object is scaled about the camera so that where it
									touches the ground it matches the terrain distance. Trees,
									poles and huts then stand on the ground instead of floating.
									Objects with too few ground contacts keep the fitted curve.
								</>
							),
						},
						{
							title: "Build the scene, mask the drape",
							body: (
								<>
									Kept points are placed in world coordinates and a roaming
									radius is derived from their distances (D2). Object pixels are
									cut out of the flat photo, so they are not drawn twice.
								</>
							),
						},
						{
							title: "Step in",
							body: (
								<>
									The camera starts at the solved position and eases back when
									you leave. Photo mode stays inside the confidence radius;
									orbit, fly and map modes roam freely but stay above the
									terrain. The Truth toggle recolours everything by provenance
									(D3).
								</>
							),
						},
					]}
				/>

				<ConfidenceDisc />

				<Provenance />

				<Stat
					value="200k"
					label="points render at 60 fps; a million run at about 35-45 fps"
				/>

				<Callout tone="note" title="Why depth alone is not trusted">
					The scene is only as good as the camera position and the anchor
					beneath it.{" "}
					<HandMark type="box">
						Nothing generated is ever exported as a measurement.
					</HandMark>
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
							rule of D1; <code>DEFAULT_SPLIT</code> holds margin 0.5, radius
							150, gap 3.
							<br />
							<CodeRef path="src/lib/nearfield/split.ts" />{" "}
							<CodeRef path="src/lib/nearfield/types.ts" />
						</li>
						<li>
							<code>buildNearFieldScene</code> and{" "}
							<code>confidenceRadiusFrom</code> produce the ENU splats and the
							disc of D2.
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
			</Details>
		</>
	);
}
