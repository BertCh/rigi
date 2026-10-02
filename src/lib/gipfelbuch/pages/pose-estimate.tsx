// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { memo, useMemo, useState } from "react";
import {
	CircledNumber,
	HandMark,
	HandScaleBar,
	NorthArrow,
	Wash,
} from "#/components/gipfelbuch/notebook";
import {
	Hachure,
	HandDot,
	HandText,
	PenArrow,
	PenCircle,
	PenLine,
	SketchPath,
	SketchRect,
} from "#/components/gipfelbuch/notebook/Ink";
import { useNotebookPhoto } from "#/components/gipfelbuch/notebook/useNotebookPhoto";
import { SWISS } from "#/components/gipfelbuch/swiss/palette";
import {
	Callout,
	CodeRef,
	Eq,
	Figure,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	HandLabel,
	HandRange,
	LAYER_STYLE,
	MarginNote,
	Measured,
	type PhotoLayer,
	PhotoPicker,
	Plot,
	RealPhoto,
	Section,
	Stat,
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
	skylineBand,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { byId, gipfelbuchHref } from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// Pose estimate: four angles plus an eye, in one convention shared by every solver.
// Mirrored literally from the code (no engine imports):
//   Pose = { yaw, pitch, roll, vfov } (degrees)            src/lib/camera/index.ts
//   poseBasis / projectPoint                                src/lib/camera/index.ts  (same maths as pose.ts applyPose)
//   DOF ladder, priors (gravity 2°, compass 10°, vfov 3 %)  src/lib/pose6dof/README.md
//   choosePreview: accept > 0.2, near-compass 4° / 1.5°     src/lib/integration/second-opinion.ts
// Accuracy numbers: src/lib/pose6dof/README.md "Verified numbers" (1950 synthetic trials).

const D = Math.PI / 180;
type V3 = [number, number, number];
type Pose = { yaw: number; pitch: number; roll: number; vfov: number };

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];

/** Camera axes in ENU: the formulas of camera/index.ts poseBasis. */
function poseBasis(p: Pose) {
	const y = p.yaw * D;
	const pt = p.pitch * D;
	const r = p.roll * D;
	const f: V3 = [
		Math.sin(y) * Math.cos(pt),
		Math.cos(y) * Math.cos(pt),
		Math.sin(pt),
	];
	const r0: V3 = [Math.cos(y), -Math.sin(y), 0];
	const u0 = cross(r0, f);
	const cr = Math.cos(r);
	const sr = Math.sin(r);
	const right = [0, 1, 2].map((i) => r0[i] * cr - u0[i] * sr) as V3;
	const up = [0, 1, 2].map((i) => u0[i] * cr + r0[i] * sr) as V3;
	return { f, right, up };
}

const dirENU = (az: number, el: number): V3 => [
	Math.sin(az * D) * Math.cos(el * D),
	Math.cos(az * D) * Math.cos(el * D),
	Math.sin(el * D),
];

/** projectPoint with the eye at the origin: normalised image coords (0..1, y down), null if behind. */
function project(p: Pose, aspect: number, d: V3, B = poseBasis(p)) {
	const z = dot(d, B.f);
	if (z <= 0) return null;
	const t = Math.tan((p.vfov * D) / 2);
	const x = dot(d, B.right) / z / (t * aspect);
	const y = dot(d, B.up) / z / t;
	return { u: 0.5 + x / 2, v: 0.5 - y / 2 };
}

const fmt = (v: number, d = 1) =>
	`${v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;
const wrap360 = (a: number) => ((a % 360) + 360) % 360;
const COMPASS = [
	"N",
	"NNE",
	"NE",
	"ENE",
	"E",
	"ESE",
	"SE",
	"SSE",
	"S",
	"SSW",
	"SW",
	"WSW",
	"W",
	"WNW",
	"NW",
	"NNW",
];
const compass = (a: number) => COMPASS[Math.round(wrap360(a) / 22.5) % 16];

// ---------- a synthetic skyline: elevation (deg) of the horizon at each azimuth ----------
const BUMPS = [
	{ c: 8, h: 5.5, w: 3 },
	{ c: 24, h: 8.4, w: 2.2 },
	{ c: 41, h: 6.2, w: 3.4 },
	{ c: 58, h: 9.6, w: 1.9 },
	{ c: 76, h: 6.8, w: 3 },
	{ c: 95, h: 5.2, w: 3.6 },
];
function skyEl(az: number) {
	let e = 1.4 + 0.6 * Math.sin(az * D * 3) + 0.3 * Math.sin(az * D * 7 + 1);
	for (const b of BUMPS) {
		const d = (((az - b.c + 540) % 360) - 180) / b.w;
		if (Math.abs(d) < 4) e = Math.max(e, b.h * Math.exp(-d * d) + 1);
	}
	return e;
}
// named summits: azimuth, distance (km) for the plan view; elevation comes from the skyline
const SUMMITS = [
	{ k: "A", az: 24, km: 11 },
	{ k: "B", az: 58, km: 17 },
	{ k: "C", az: 8, km: 7 },
	{ k: "D", az: 41, km: 13 },
	{ k: "E", az: 76, km: 9 },
];

const ASPECT = 1.5;
const PRIOR: Pose = { yaw: 38, pitch: 1.5, roll: 0, vfov: 38 };

function Slider(props: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	unit: string;
	onChange: (v: number) => void;
}) {
	return (
		<div className="flex items-center gap-2 text-[13px] gb-secondary">
			<span className="w-11 shrink-0 font-mono gb-secondary">
				{props.label}
			</span>
			<span className="min-w-0 flex-1">
				<HandRange
					min={props.min}
					max={props.max}
					step={props.step}
					value={props.value}
					label={props.label}
					onChange={props.onChange}
				/>
			</span>
			<span className="w-16 shrink-0 text-right font-mono tabular-nums text-[var(--gb-ink)]">
				{fmt(props.value)}
				{props.unit}
			</span>
		</div>
	);
}

// ======================================================================================
// Fig. 1 — hero: one Pose, two views. Plan (yaw + FOV wedge) and the image it produces.
// ======================================================================================
function PoseExplorer() {
	const [ref, t] = useTime<HTMLDivElement>(7);
	const [manual, setManual] = useState<Pose | null>(null);
	const auto: Pose = {
		yaw: 40 + 26 * Math.sin(t * 0.45),
		pitch: 1.5 + 4 * Math.sin(t * 0.7 + 1),
		roll: 9 * Math.sin(t * 0.33 + 2),
		vfov: 38 + 9 * Math.sin(t * 0.25),
	};
	const pose = manual ?? auto;
	const set = (k: keyof Pose) => (v: number) => setManual({ ...pose, [k]: v });
	const B = poseBasis(pose);

	// image panel
	const FX = 268;
	const FY = 34;
	const FW = 354;
	const FH = FW / ASPECT;
	const sx = (u: number) => FX + u * FW;
	const sy = (v: number) => FY + v * FH;

	const sky: string[] = [];
	let first: [number, number] | null = null;
	let last: [number, number] | null = null;
	for (let a = pose.yaw - 75; a <= pose.yaw + 75; a += 0.5) {
		const p = project(pose, ASPECT, dirENU(a, skyEl(a)), B);
		if (!p) continue;
		const x = sx(p.u);
		const y = sy(p.v);
		sky.push(`${sky.length ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`);
		if (!first) first = [x, y];
		last = [x, y];
	}
	const fill =
		first && last
			? `${sky.join(" ")} L${last[0]} ${last[1] + 900} L${first[0]} ${first[1] + 900} Z`
			: "";
	const hor: string[] = [];
	for (let a = pose.yaw - 75; a <= pose.yaw + 75; a += 5) {
		const p = project(pose, ASPECT, dirENU(a, 0), B);
		if (p)
			hor.push(
				`${hor.length ? "L" : "M"}${sx(p.u).toFixed(1)} ${sy(p.v).toFixed(1)}`,
			);
	}
	const marks = SUMMITS.map((s) => {
		const p = project(pose, ASPECT, dirENU(s.az, skyEl(s.az)), B);
		return { ...s, p };
	});

	// plan panel
	const CX = 128;
	const CY = 168;
	const R = 100;
	const hfov = (2 * Math.atan(Math.tan((pose.vfov * D) / 2) * ASPECT)) / D;
	const at = (az: number, r: number): [number, number] => [
		CX + r * Math.sin(az * D),
		CY - r * Math.cos(az * D),
	];
	const w0 = at(pose.yaw - hfov / 2, R + 8);
	const w1 = at(pose.yaw + hfov / 2, R + 8);
	const large = hfov > 180 ? 1 : 0;
	const wedgeD = `M${CX} ${CY} L${w0[0].toFixed(1)} ${w0[1].toFixed(1)} A${R + 8} ${R + 8} 0 ${large} 1 ${w1[0].toFixed(1)} ${w1[1].toFixed(1)} Z`;
	const inView = (az: number) =>
		Math.abs(((az - pose.yaw + 540) % 360) - 180) <= hfov / 2;

	return (
		<Figure
			label="Fig. D3"
			bleed
			caption="Schematic. One Pose, two views. Left: the eye at the centre of a compass; yaw points the wedge, vertical FOV sets its width. Right: the image those four numbers produce, computed with the same poseBasis / projectPoint formulas the renderer and every solver share. Pitch slides the horizon, roll tilts it, FOV scales everything. The scene is synthetic; the maths is the code's."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<svg
					viewBox="0 0 640 330"
					className="block h-auto w-full"
					role="img"
					aria-label="A top-down compass wedge beside the projected skyline for the same pose"
				>
					<defs>
						<clipPath id="pe-clip">
							<rect x={FX} y={FY} width={FW} height={FH} />
						</clipPath>
						<clipPath id="pe-land">
							<path d={fill || "M0 0"} />
						</clipPath>
						<clipPath id="pe-wedge">
							<path d={wedgeD} />
						</clipPath>
					</defs>

					{/* ---- plan ---- */}
					<HandLabel x={14} y={22} size={11.56} color="var(--gb-secondary)">
						plan · ENU, eye at centre
					</HandLabel>
					{[0.33, 0.66, 1].map((k) => (
						<PenCircle
							key={k}
							center={[CX, CY]}
							radiusX={R * k}
							seed={`pe-plan-ring-${k}`}
							color="faint"
							width={0.9}
						/>
					))}
					<PenLine
						seed="pe-plan-ns"
						from={[CX, CY - R - 4]}
						to={[CX, CY + R + 4]}
						color="faint"
						width={0.9}
					/>
					<PenLine
						seed="pe-plan-ew"
						from={[CX - R - 4, CY]}
						to={[CX + R + 4, CY]}
						color="faint"
						width={0.9}
					/>
					<HandLabel
						x={CX}
						y={CY - R - 10}
						anchor="middle"
						size={11.56}
						color="var(--gb-secondary)"
					>
						N
					</HandLabel>
					{/* the view wedge: fixed hand hatching revealed through the moving wedge */}
					<g clipPath="url(#pe-wedge)">
						<Hachure
							d={`M${CX - R - 8} ${CY}a${R + 8} ${R + 8} 0 1 0 ${2 * (R + 8)} 0a${R + 8} ${R + 8} 0 1 0 ${-2 * (R + 8)} 0Z`}
							seed="pe-wedge-hatch"
							color="blue"
							gap={5}
							opacity={0.6}
						/>
					</g>
					<SketchPath
						d={wedgeD}
						seed="pe-wedge-edge"
						color="blue"
						width={1.2}
						passes={1}
					/>
					<PenLine
						seed="pe-yaw-ray"
						from={[CX, CY]}
						to={at(pose.yaw, R + 8)}
						color="red"
						width={2}
					/>
					{SUMMITS.map((s) => {
						const [x, y] = at(s.az, (s.km / 20) * R);
						const on = inView(s.az);
						return (
							<g key={s.k} opacity={on ? 1 : 0.35}>
								<SketchPath
									d={`M${x} ${y - 5}L${x + 5} ${y + 4}L${x - 5} ${y + 4}Z`}
									seed={`pe-summit-${s.k}`}
									color="navy"
									width={1.5}
									passes={1}
								/>
								<HandLabel
									x={x + 8}
									y={y + 5}
									color="var(--gb-navy)"
									size={11.56}
								>
									{s.k}
								</HandLabel>
							</g>
						);
					})}
					<HandDot x={CX} y={CY} r={3.6} seed="pe-eye" />
					<HandLabel
						x={CX}
						y={CY + R + 26}
						anchor="middle"
						size={(11 * 640) / 720}
						color="var(--gb-secondary)"
					>
						yaw {fmt(wrap360(pose.yaw), 0)}° {compass(pose.yaw)} · hfov{" "}
						{hfov.toFixed(0)}°
					</HandLabel>
					<NorthArrow x={26} y={74} length={24} seed="pe-north" />
					<HandScaleBar
						x={14}
						y={314}
						metersPerPixel={200}
						meters={10000}
						segments={2}
						seed="pe-plan-scale"
					/>
					<HandText x={14} y={262} size={13} rotate={-3}>
						red ray: where I point
					</HandText>
					<PenArrow
						seed="pe-yaw-note-arrow"
						from={[78, 254]}
						to={at(pose.yaw, 52)}
						color="ink"
						width={1}
						head={5}
					/>

					{/* ---- image ---- */}
					<HandLabel x={FX} y={22} size={11.56} color="var(--gb-secondary)">
						the image · {ASPECT}:1
					</HandLabel>
					<g clipPath="url(#pe-clip)">
						<g clipPath="url(#pe-land)">
							<Wash
								d={`M${FX} ${FY}h${FW}v${FH}h${-FW}Z`}
								color="ink"
								seed="pe-land-wash"
								layers={5}
							/>
							<Hachure
								d={`M${FX} ${FY}h${FW}v${FH}h${-FW}Z`}
								seed="pe-land-hatch"
								color="pencil"
								gap={5}
								opacity={0.55}
							/>
						</g>
						{sky.length > 0 && (
							<SketchPath
								d={sky.join(" ")}
								seed="pe-skyline"
								data
								color={SWISS.ink}
								width={1.8}
							/>
						)}
						{hor.length > 0 && (
							<SketchPath
								d={hor.join(" ")}
								seed="pe-horizon"
								data
								color={SWISS.contour}
								width={1.8}
								dash="5 4"
							/>
						)}
						{marks.map(
							(m) =>
								m.p && (
									<g key={m.k}>
										<PenLine
											seed={`pe-mark-${m.k}`}
											from={[sx(m.p.u), sy(m.p.v)]}
											to={[sx(m.p.u), sy(m.p.v) - 14]}
											color="navy"
											width={1.2}
										/>
										<HandLabel
											x={sx(m.p.u)}
											y={sy(m.p.v) - 18}
											anchor="middle"
											color="var(--gb-navy)"
											size={11.56}
										>
											{m.k}
										</HandLabel>
									</g>
								),
						)}
						<PenLine
							seed="pe-cross-h"
							from={[sx(0.5) - 7, sy(0.5)]}
							to={[sx(0.5) + 7, sy(0.5)]}
							color="faint"
							width={1}
						/>
						<PenLine
							seed="pe-cross-v"
							from={[sx(0.5), sy(0.5) - 7]}
							to={[sx(0.5), sy(0.5) + 7]}
							color="faint"
							width={1}
						/>
					</g>
					<SketchRect
						x={FX}
						y={FY}
						width={FW}
						height={FH}
						seed="pe-frame"
						color="pencil"
					/>
					<HandLabel
						x={FX}
						y={FY + FH + 18}
						size={11.56}
						color="var(--gb-secondary)"
					>
						<tspan style={{ fill: "var(--gb-contour)" }}>- - -</tspan> true
						horizon (elevation 0) · ink: skyline
					</HandLabel>
					<HandLabel
						x={FX + FW}
						y={FY + FH + 38}
						anchor="end"
						size={(11 * 640) / 720}
						color="var(--gb-secondary)"
					>
						pitch {fmt(pose.pitch)}° · roll {fmt(pose.roll)}°
					</HandLabel>
					<HandText x={FX} y={326} size={14} rotate={-1}>
						pitch slides the horizon, roll tilts it, FOV scales it all
					</HandText>
				</svg>
				<div className="grid gap-x-6 gap-y-1.5 px-4 pb-4 pt-3 sm:grid-cols-2">
					<Slider
						label="yaw"
						value={wrap360(pose.yaw)}
						min={0}
						max={360}
						step={0.5}
						unit="°"
						onChange={set("yaw")}
					/>
					<Slider
						label="pitch"
						value={pose.pitch}
						min={-15}
						max={25}
						step={0.1}
						unit="°"
						onChange={set("pitch")}
					/>
					<Slider
						label="roll"
						value={pose.roll}
						min={-25}
						max={25}
						step={0.1}
						unit="°"
						onChange={set("roll")}
					/>
					<Slider
						label="vfov"
						value={pose.vfov}
						min={15}
						max={70}
						step={0.5}
						unit="°"
						onChange={set("vfov")}
					/>
					<div className="flex items-center gap-3 text-[13px] gb-secondary sm:col-span-2">
						<button
							type="button"
							onClick={() => setManual(manual ? null : { ...auto })}
							className="bg-[var(--gb-paper-deep)] px-3 py-1.5 font-mono text-[11px] leading-[12px] text-[var(--gb-ink)] hover:bg-[var(--gb-sign-light)]"
						>
							{manual ? "Resume animation" : "Take control"}
						</button>
						<button
							type="button"
							onClick={() => setManual({ ...PRIOR })}
							className="bg-[var(--gb-paper-deep)] px-3 py-1.5 font-mono text-[11px] leading-[12px] text-[var(--gb-ink)] hover:bg-[var(--gb-sign-light)]"
						>
							Reset to a phone prior
						</button>
						<span className="hidden sm:inline">
							Drag any slider to move the camera.
						</span>
					</div>
				</div>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Fig. 2 — the DOF ladder: how many correspondences unlock which parts of the pose
// ======================================================================================
type Corrs = { point: number; dir: number; level: number; azimuth: number };
const KINDS: {
	k: keyof Corrs;
	label: string;
	sub: string;
	w: number;
}[] = [
	{ k: "point", label: "point", sub: "finite world point · 2 eqs", w: 1 },
	{ k: "dir", label: "dir", sub: "az/el at infinity · 2 eqs", w: 1 },
	{
		k: "level",
		label: "level",
		sub: "known elevation (shoreline) · 0.5",
		w: 0.5,
	},
	{ k: "azimuth", label: "azimuth", sub: "known bearing · 0.5", w: 0.5 },
];
const PRESETS: { name: string; c: Corrs }[] = [
	{ name: "a lake shore", c: { point: 0, dir: 0, level: 1, azimuth: 0 } },
	{ name: "one summit tap", c: { point: 1, dir: 0, level: 0, azimuth: 0 } },
	{ name: "two summits", c: { point: 2, dir: 0, level: 0, azimuth: 0 } },
	{ name: "four pins", c: { point: 3, dir: 1, level: 0, azimuth: 0 } },
	{ name: "six pins + shore", c: { point: 4, dir: 2, level: 1, azimuth: 0 } },
];

function ladder(c: Corrs, solveFov: boolean) {
	const neff = c.point + c.dir + 0.5 * (c.level + c.azimuth);
	const bearing = c.point + c.dir + c.azimuth > 0;
	const pitch = neff > 0;
	const yaw = neff >= 1 && bearing;
	const roll = neff >= 2 || c.level >= 2;
	const fov = neff >= 3 && solveFov;
	const pos = neff >= 4 && c.point >= 3;
	return { neff, pitch, yaw, roll, fov, pos };
}

function DofLadder() {
	const [c, setC] = useState<Corrs>({ point: 2, dir: 0, level: 1, azimuth: 0 });
	const [fov, setFov] = useState(true);
	const L = ladder(c, fov);
	const rows: {
		name: string;
		on: boolean;
		rule: string;
		held: string;
	}[] = [
		{
			name: "pitch",
			on: L.pitch,
			rule: "n_eff > 0",
			held: "held at gravity, σ 2°",
		},
		{
			name: "yaw",
			on: L.yaw,
			rule: "n_eff ≥ 1 and a bearing-carrying correspondence",
			held: "held at compass, σ 10°",
		},
		{
			name: "roll",
			on: L.roll,
			rule: "n_eff ≥ 2, or two level points",
			held: "held at gravity, σ 2°",
		},
		{
			name: "vfov",
			on: L.fov,
			rule: "n_eff ≥ 3 and solveFov",
			held: "held at EXIF, σ 3 %",
		},
		{
			name: "eye (dx dy dz)",
			on: L.pos,
			rule: "n_eff ≥ 4, ≥ 3 finite points, observable parallax",
			held: "held at GPS, σH ≥ 5 m",
		},
	];
	const bump = (k: keyof Corrs, d: number) =>
		setC({ ...c, [k]: Math.max(0, Math.min(8, c[k] + d)) });
	return (
		<Figure
			label="Fig. D4"
			caption="Schematic (synthetic correspondences). The degrees-of-freedom ladder of solvePose6dof. The solver never solves what the evidence cannot pin down: each unlocked row is fitted, each locked row is held at its sensor prior and its prior variance still feeds the reported σ of the rows above it (the 'consider covariance'). Counts are inliers; n_eff counts point and dir as 1, level and azimuth as 0.5."
		>
			<div className="flex flex-wrap gap-2 pb-3">
				{PRESETS.map((p) => (
					<button
						key={p.name}
						type="button"
						onClick={() => setC(p.c)}
						className="nb-hand bg-[var(--gb-paper-deep)] px-3 py-0.5 text-[16px] gb-secondary underline decoration-dotted underline-offset-4 hover:text-[var(--gb-ink)] hover:decoration-[var(--nb-red)]"
					>
						{p.name}
					</button>
				))}
			</div>
			<div className="grid gap-2 sm:grid-cols-4">
				{KINDS.map((kd) => (
					<div key={kd.k} className="bg-[var(--gb-paper-deep)] p-2.5">
						<div className="flex items-center justify-between">
							<span className="font-mono text-[13px] text-[var(--gb-ink)]">
								{kd.label}
							</span>
							<span className="flex items-center gap-1.5">
								<button
									type="button"
									aria-label={`fewer ${kd.label}`}
									onClick={() => bump(kd.k, -1)}
									className="nb-hand h-6 w-6 bg-[var(--gb-paper)] text-[18px] leading-none gb-secondary hover:text-[var(--nb-red)]"
								>
									−
								</button>
								<span className="w-4 text-center font-mono text-[13px] tabular-nums text-[var(--gb-ink)]">
									{c[kd.k]}
								</span>
								<button
									type="button"
									aria-label={`more ${kd.label}`}
									onClick={() => bump(kd.k, 1)}
									className="nb-hand h-6 w-6 bg-[var(--gb-paper)] text-[18px] leading-none gb-secondary hover:text-[var(--nb-red)]"
								>
									+
								</button>
							</span>
						</div>
						<div className="mt-1 text-[11px] leading-snug gb-secondary">
							{kd.sub}
						</div>
					</div>
				))}
			</div>
			<div className="mt-4 flex items-end gap-4">
				<div>
					<div
						className="font-light gb-num text-[40px] leading-none"
						style={{ color: "var(--accent)" }}
					>
						{L.neff.toFixed(1)}
					</div>
					<div className="text-[11px] uppercase tracking-wider gb-secondary">
						n_eff
					</div>
				</div>
				<label className="ml-auto flex items-center gap-2 text-[13px] gb-secondary">
					<input
						type="checkbox"
						checked={fov}
						onChange={(e) => setFov(e.target.checked)}
						style={{ accentColor: "var(--accent)" }}
					/>
					solveFov
				</label>
			</div>
			<ul className="mt-3 space-y-1.5 !pl-0 !list-none">
				{rows.map((r) => (
					<li
						key={r.name}
						className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 transition-colors duration-500"
						style={{
							background: r.on
								? "color-mix(in srgb, var(--gb-forest) 22%, var(--gb-paper))"
								: "transparent",
						}}
					>
						<svg
							viewBox="0 0 12 12"
							className="size-3 shrink-0"
							aria-hidden="true"
							role="presentation"
						>
							<HandDot
								x={6}
								y={6}
								r={4.6}
								seed={`pe-rung-${r.name}`}
								color={r.on ? "forest" : "pencil"}
								opacity={r.on ? 1 : 0.55}
							/>
						</svg>
						<span className="w-28 shrink-0 font-mono text-[13px] text-[var(--gb-ink)]">
							{r.name}
						</span>
						<span className="min-w-0 flex-1 text-[13px] gb-secondary">
							{r.on ? (
								<span className="font-semibold text-[var(--gb-forest)]">
									solved
								</span>
							) : (
								r.held
							)}
						</span>
						<span className="w-full text-[11px] gb-secondary sm:w-auto">
							{r.rule}
						</span>
					</li>
				))}
			</ul>
		</Figure>
	);
}

// ======================================================================================
// Fig. 3 — provenance: what a pose is wrapped in, and how the app chooses one to show
// ======================================================================================
function ProvenanceCard() {
	const [conf, setConf] = useState(0.62);
	const [near, setNear] = useState(true);
	const state = conf > 0.2 ? "auto" : near ? "near-compass" : "prior";
	const note = {
		auto: `Auto-aligned to skyline · confidence ${(conf * 100).toFixed(0)}%`,
		"near-compass": "Skyline ambiguous: refined near the compass heading",
		prior: "Using phone compass + gravity (skyline match was weak)",
	}[state];
	const SRC = ["saved", "ground-truth", "solved", "prior"];
	return (
		<Figure
			label="Fig. D5"
			caption="A pose is never bare. Left: the SolvedPose record the roll aligner stores per photo. Right: choosePreview, the three-way rule that decides which pose the workspace shows when a photo opens. Drag the confidence across 0.2 and the state flips. On the 12 demo photos the saved poses carry confidences of 0.63 to 1.00 (public/demo/manifest.json), all above 0.2, so each opens as auto; the saved yaw agrees with a fresh run of the CPU pipeline to within 0.4° on 11 and 1.2° on demo-11."
		>
			<div className="grid gap-4 md:grid-cols-2">
				<div className="bg-[var(--gb-paper-deep)] p-3 font-mono text-[13px] leading-relaxed gb-secondary">
					<div className="gb-secondary">{"// src/lib/roll/types.ts"}</div>
					<div>
						<span className="text-[var(--accent)]">SolvedPose</span> {"{"}
					</div>
					<div className="pl-4">
						pose: {"{"} yaw, pitch, roll, vfov {"}"},
					</div>
					<div className="pl-4">confidence: 0..1,</div>
					<div className="pl-4">
						method: <span className="text-[var(--gb-ink)]">"cascade"</span> |{" "}
						<span className="text-[var(--gb-ink)]">
							"propagated-suggestion"
						</span>
						,
					</div>
					<div className="pl-4">at: ISO time</div>
					<div>{"}"}</div>
					<div className="mt-3 gb-secondary">{"// PoseSource, best first"}</div>
					<div className="mt-1 flex flex-wrap items-center gap-1">
						{SRC.map((s, i) => (
							<span key={s} className="flex items-center gap-1">
								<span
									className="px-1.5 py-0.5"
									style={{
										color: i === 2 ? "var(--gb-ink)" : undefined,
										textDecoration:
											i === 2 ? "underline wavy var(--nb-red)" : undefined,
										textUnderlineOffset: 3,
									}}
								>
									{s}
								</span>
								{i < SRC.length - 1 && <span className="gb-secondary">›</span>}
							</span>
						))}
					</div>
				</div>
				<div className="bg-[var(--gb-paper-deep)] p-3">
					<div className="text-[11px] uppercase tracking-wider gb-secondary">
						choosePreview (AppAlign)
					</div>
					<div className="mt-2 flex items-center gap-2 text-[13px] gb-secondary">
						<span className="w-20 shrink-0 font-mono gb-secondary">
							confidence
						</span>
						<span className="min-w-0 flex-1">
							<HandRange
								min={0}
								max={1}
								step={0.01}
								value={conf}
								label="solver confidence"
								onChange={setConf}
							/>
						</span>
						<span className="w-10 text-right font-mono tabular-nums text-[var(--gb-ink)]">
							{conf.toFixed(2)}
						</span>
					</div>
					<label className="mt-2 flex items-center gap-2 text-[13px] gb-secondary">
						<input
							type="checkbox"
							checked={near}
							onChange={(e) => setNear(e.target.checked)}
							style={{ accentColor: "var(--accent)" }}
						/>
						an alternative lies within 4° yaw / 1.5° pitch of the compass
					</label>
					<div className="mt-3 flex gap-1.5">
						{(["auto", "near-compass", "prior"] as const).map((s) => (
							<span
								key={s}
								className="flex-1 px-2 py-2 text-center font-mono text-[13px] transition-colors duration-300"
								style={{
									background: state === s ? "var(--gb-ink)" : "var(--gb-paper)",
									color:
										state === s ? "var(--gb-paper)" : "var(--gb-secondary)",
								}}
							>
								{s}
							</span>
						))}
					</div>
					<p className="mt-3 text-[13px] text-[var(--gb-ink)]">{note}</p>
					<p className="mt-1 text-[11px] gb-secondary">
						Only "auto" counts as accepted.
					</p>
				</div>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Real data: SolvedPose records of the 12 bundled Niederhorn photos (public/demo/gipfelbuch/*.json, produced by
// scripts/gipfelbuch/build-data.ts with the real solvePose, then refinePose on a reject).

const sgn = (v: number, n = 2) =>
	`${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(n)}`;

/** A crop over the rows the skyline curves occupy, so people at the bottom of the frame stay out. */
function skyBand(d: GipfelbuchPhotoData): [number, number, number, number] {
	const all = [d.skyline.rows, d.priorRows, d.solvedRows]
		.flat()
		.filter((v): v is number => v != null)
		.sort((a, b) => a - b);
	const lo = all[Math.floor(all.length * 0.02)];
	const hi = all[Math.floor(all.length * 0.98)];
	const y0 = Math.max(0, Math.floor(lo - 90));
	const y1 = Math.min(d.photo.height, Math.max(Math.ceil(hi + 60), y0 + 280));
	return [0, y0, d.photo.width, y1];
}

function Row({ k, v, sub }: { k: string; v: string; sub?: string }) {
	return (
		<div className="contents">
			<dt className="gb-secondary">{k}</dt>
			<dd className="gb-ink">
				{v}
				{sub && <span className="ml-2 gb-secondary">{sub}</span>}
			</dd>
		</div>
	);
}

function RealPose({
	id,
	setId,
}: {
	id: GipfelbuchPhotoId;
	setId: (i: GipfelbuchPhotoId) => void;
}) {
	const d = useGipfelbuchPhoto(id);
	const idx = useGipfelbuchIndex();
	const s = d?.solved;
	return (
		<Figure
			label="Fig. D1"
			caption={
				<>
					<Measured data={d} /> The teal curve is the DEM skyline projected
					through the solved {"{ yaw, pitch, roll, vfov }"} and the eye;
					labelled peaks are placed with the same pose. The solved record is the
					one solvePose returned (refinePose for demo-12).
				</>
			}
		>
			<PhotoPicker
				value={id}
				onChange={setId}
				mark={(i) => {
					const x = idx?.photos.find((p) => p.id === i);
					return x ? (
						<span
							className="px-1 font-mono text-[11px]"
							style={{
								background: x.accepted ? "var(--gb-water)" : "var(--gb-red)",
								color: "var(--gb-paper)",
							}}
						>
							{x.accepted ? "ok" : "rej"}
						</span>
					) : null;
				}}
			/>
			<div className="grid gap-5">
				<div>
					<RealPhoto
						key={id}
						data={d}
						layers={["skyline", "solved", "peaks"]}
						toggles={["skyline", "solved", "peaks"]}
						crop={d ? skyBand(d) : undefined}
						maxLabels={5}
					/>
				</div>
				{d && s ? (
					<dl className="grid grid-cols-[auto_1fr] content-start gap-x-4 gap-y-1.5 font-mono text-[11px]">
						<Row
							k="yaw"
							v={`${s.yaw.toFixed(2)}°`}
							sub={`prior ${d.prior.yaw.toFixed(2)}° (${sgn(s.delta.yaw)})`}
						/>
						<Row
							k="pitch"
							v={`${s.pitch.toFixed(2)}°`}
							sub={`prior ${d.prior.pitch.toFixed(2)}°`}
						/>
						<Row
							k="roll"
							v={`${s.roll.toFixed(2)}°`}
							sub={`prior ${d.prior.roll.toFixed(2)}°`}
						/>
						<Row
							k="vfov"
							v={`${s.vfov.toFixed(2)}°`}
							sub={`prior ${d.prior.vfov.toFixed(2)}° (×${s.delta.focal.toFixed(3)} focal)`}
						/>
						<Row
							k="eye"
							v={`${d.gps.eye.toFixed(0)} m`}
							sub={`GPS ±${d.gps.hAccuracy.toFixed(0)} m`}
						/>
						<div className="col-span-2 my-1.5" />
						<Row
							k="stage"
							v={`${s.stage} · ${s.search}`}
							sub={s.accepted ? "accepted" : `rejected: ${s.rejectReason}`}
						/>
						<Row k="confidence" v={s.confidence.toFixed(3)} />
						<Row
							k="residualPx"
							v={`${s.residualPx.toFixed(2)}`}
							sub={`median ${d.residual.solved.median.toFixed(1)} px, p90 ${d.residual.solved.p90.toFixed(0)}`}
						/>
						<Row k="inlierFraction" v={s.inlierFraction.toFixed(3)} />
						<Row k="coverage" v={s.coverage.toFixed(3)} />
						<Row k="ambiguity" v={s.ambiguity.toFixed(3)} />
						<Row k="horizonRelief" v={s.horizonRelief.toFixed(2)} />
						<div className="col-span-2 my-1.5" />
						<Row
							k="app saved"
							v={d.app ? `yaw ${d.app.yaw.toFixed(2)}°` : "none"}
							sub={
								d.app
									? `${d.app.source}, conf ${d.app.confidence.toFixed(2)}, Δ${Math.abs(d.app.yaw - s.yaw).toFixed(2)}° from this run`
									: undefined
							}
						/>
					</dl>
				) : (
					<div className="h-60 animate-pulse bg-[var(--gb-paper-deep)]" />
				)}
			</div>
		</Figure>
	);
}

function PoseResiduals({
	sel,
	onPick,
}: {
	sel: GipfelbuchPhotoId;
	onPick: (i: GipfelbuchPhotoId) => void;
}) {
	const idx = useGipfelbuchIndex();
	if (!idx)
		return <div className="h-64 animate-pulse bg-[var(--gb-paper-deep)]" />;
	const P = idx.photos;
	const worstAt = P.reduce(
		(best, p, i) =>
			p.residual.prior.median > P[best].residual.prior.median ? i : best,
		0,
	);
	const meds = P.filter((p) => p.accepted)
		.map((p) => p.residual.solved.median)
		.sort((a, b) => a - b);
	return (
		<Figure
			label="Fig. D2"
			caption={
				<>
					Measured on the 12 demo photos by scripts/gipfelbuch/build-data.ts,
					2026-10-01. Median |detected skyline − DEM skyline| over confident
					columns, at the sensor-prior pose (red dots) and at the solved pose
					(navy dots). Hollow navy: the confidence gate rejected the solve.
					Click a point to load it in Fig. D1.
				</>
			}
		>
			<Plot
				x={[0.4, 12.6]}
				y={[0, 50]}
				xLabel="demo photo"
				yLabel="median skyline error, px"
				xTicks={12}
				yTicks={5}
				fmtX={(v) => (Number.isInteger(v) && v >= 1 && v <= 12 ? `${v}` : "")}
				fmtY={(v) => `${v}`}
			>
				{(s) => (
					<g>
						<g>
							<HandDot
								x={s.box.x1 - 150}
								y={s.box.y0 + 12}
								r={4.5}
								seed="pe-leg-prior"
								color="red"
								opacity={1}
							/>
							<HandLabel
								x={s.box.x1 - 140}
								y={s.box.y0 + 16}
								size={11}
								color="var(--gb-ink)"
							>
								sensor prior
							</HandLabel>
							<HandDot
								x={s.box.x1 - 150}
								y={s.box.y0 + 30}
								r={4.5}
								seed="pe-leg-solved"
								color="navy"
								opacity={1}
							/>
							<HandLabel
								x={s.box.x1 - 140}
								y={s.box.y0 + 34}
								size={11}
								color="var(--gb-ink)"
							>
								solved (hollow: rejected)
							</HandLabel>
						</g>
						{P.map((p, i) => {
							const x = s.x(i + 1);
							const on = p.id === sel;
							return (
								// biome-ignore lint/a11y/useSemanticElements: SVG marker group
								<g
									key={p.id}
									role="button"
									tabIndex={0}
									aria-label={p.id}
									onClick={() => onPick(p.id)}
									onKeyDown={(e) => e.key === "Enter" && onPick(p.id)}
									className="cursor-pointer"
								>
									{on && (
										<Wash
											d={`M${x - 13} ${s.box.y0}H${x + 13}V${s.box.y1}H${x - 13}Z`}
											color="red"
											seed={`pe-res-sel-${p.id}`}
											layers={5}
										/>
									)}
									{/* transparent hit area for the whole column */}
									<rect
										x={x - 13}
										y={s.box.y0}
										width={26}
										height={s.box.y1 - s.box.y0}
										fill="transparent"
									/>
									<PenLine
										seed={`pe-res-link-${p.id}`}
										from={[x, s.y(p.residual.prior.median)]}
										to={[x, s.y(p.residual.solved.median)]}
										color="faint"
										width={1.2}
									/>
									<HandDot
										x={x}
										y={s.y(p.residual.prior.median)}
										r={6}
										seed={`pe-res-prior-${p.id}`}
										data
										color="red"
										opacity={1}
									/>
									{p.accepted ? (
										<HandDot
											x={x}
											y={s.y(p.residual.solved.median)}
											r={6}
											seed={`pe-res-solved-${p.id}`}
											data
											color="navy"
											opacity={1}
										/>
									) : (
										<PenCircle
											seed={`pe-res-rej-${p.id}`}
											data
											center={[x, s.y(p.residual.solved.median)]}
											radiusX={5.5}
											color="navy"
											width={2.2}
										/>
									)}
								</g>
							);
						})}
						<HandText
							x={s.x(worstAt + 1) + 22}
							y={s.y(P[worstAt].residual.prior.median) + 4}
							size={16}
							color="ink"
							rotate={-2}
						>
							demo-{String(worstAt + 1).padStart(2, "0")}:{" "}
							{P[worstAt].residual.prior.median.toFixed(0)} px off, then{" "}
							{P[worstAt].residual.solved.median.toFixed(1)}
						</HandText>
						<PenArrow
							seed="pe-res-note-arrow"
							from={[
								s.x(worstAt + 1) + 18,
								s.y(P[worstAt].residual.prior.median) + 8,
							]}
							to={[
								s.x(worstAt + 1) + 8,
								s.y(P[worstAt].residual.prior.median) + 3,
							]}
							color="ink"
							width={1}
							head={4}
						/>
					</g>
				)}
			</Plot>
			<div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Stat
					value={`${P.filter((p) => p.accepted).length} / 12`}
					label="poses accepted (9 by solvePose, 1 by refinePose)"
				/>
				<Stat
					value={`${meds[0].toFixed(1)}–${meds[meds.length - 1].toFixed(1)} px`}
					label="median residual at the solved pose (accepted)"
				/>
				<Stat
					value={`${Math.min(...P.map((p) => p.residual.prior.median)).toFixed(0)}–${Math.max(...P.map((p) => p.residual.prior.median)).toFixed(0)} px`}
					label="median residual at the sensor prior"
				/>
				<Stat
					value={`${P.map((p) => p.confidence)
						.sort((a, b) => a - b)[0]
						.toFixed(2)}–${Math.max(...P.map((p) => p.confidence)).toFixed(2)}`}
					label="solve confidence range"
				/>
			</div>
		</Figure>
	);
}

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

function Legacy() {
	const [id, setId] = useNotebookPhoto();
	return (
		<>
			<Section title="Four angles and an eye" kicker="The object">
				<p>
					A pose estimate is deliberately small:{" "}
					<code>{"{ yaw, pitch, roll, vfov }"}</code> in degrees, plus an eye
					position in a local east-north-up frame. Yaw is the true heading,
					clockwise from north. Pitch is positive looking up. Roll is positive
					when the right side of the image goes down. FOV is the vertical field
					of view. That is the whole camera: <code>poseBasis</code> turns the
					angles into three axes (forward, right, up), and{" "}
					<code>projectPoint</code> turns an ENU point into image coordinates,
					0..1 with y down.
				</p>
				<p>
					The value of such a small object is that it is{" "}
					<HandMark type="underline">a single convention</HandMark>. The skyline
					matcher, the pin solver, the renderer, the roll aligner and the 6-DoF
					solver all read and write it, and the pose6dof tests check its
					projection against <code>pose.ts</code> to{" "}
					<HandMark type="double">7e-15</HandMark> and its angles against{" "}
					<code>geo/camera.ts</code> to 1e-12 px. A pose from any one of them
					can be dropped into any other.
				</p>
			</Section>

			<RealPose id={id} setId={setId} />
			<PoseResiduals sel={id} onPick={setId} />

			<PoseExplorer />

			<Section title="How it works" kicker="Mechanism">
				<Steps
					steps={[
						{
							title: "Axes from angles",
							body: (
								<>
									Forward is{" "}
									<code>(sin yaw cos pitch, cos yaw cos pitch, sin pitch)</code>
									. A level right axis <code>(cos yaw, −sin yaw, 0)</code> is
									crossed with forward to give the level up axis, then both are
									rotated about forward by roll. Roll therefore tilts the
									horizon without moving where the camera points.
								</>
							),
						},
						{
							title: "Project through the pinhole",
							body: (
								<>
									A world vector from the eye has depth{" "}
									<code>z = v · forward</code>. With{" "}
									<code>t = tan(vfov / 2)</code>, the image coordinates are{" "}
									<code>x = v · right / (z · t · aspect)</code> and{" "}
									<code>y = v · up / (z · t)</code>. Behind the camera (z ≤ 0)
									is null. This is the dashed horizon and the skyline in Fig.
									D3.
								</>
							),
						},
						{
							title: "Phones supply a prior pose",
							body: (
								<>
									<code>cameraFromGravity</code> reads the accelerometer for
									pitch and roll (up is minus gravity) and the compass for yaw;
									focal comes from EXIF. That prior is the starting point that{" "}
									{link("camera-prior", "Camera Prior")} describes, and where{" "}
									{link("viewport-inference", "viewport inference")} begins its
									search.
								</>
							),
						},
						{
							title: "Solvers fit what the evidence supports",
							body: (
								<>
									When a person pins points, <code>solvePose6dof</code> runs
									RANSAC over minimal solvers (P3P, DLT, a 2-point Horn
									rotation) and polishes with Levenberg-Marquardt under priors.
									How far it goes is set by the ladder in Fig. D4.
								</>
							),
						},
						{
							title: "Wrap it in provenance",
							body: (
								<>
									The numbers are stored with who produced them, a confidence
									and a time (Fig. D5), so the UI can tell a hand-fitted pose
									from a cascade solve from a bare sensor prior.
								</>
							),
						},
					]}
				/>
			</Section>

			<DofLadder />

			<Section title="Honest about what is known" kicker="Uncertainty">
				<p>
					The 6-DoF solver reports a 1σ for every parameter it touched, from the
					covariance over its inliers. Parameters it did not solve report their
					prior σ, so GPS error still shows up in the yaw σ when position is
					held. Priors come from the photo itself: gravity 2°, compass 10°
					(unknown if there is no heading), vfov 3 %, and a position σ of{" "}
					<code>max(hAccuracy, 5)</code> m horizontally. A σ of exactly 0 holds
					a parameter fixed; <code>Infinity</code> means unknown.
				</p>
				<div className="grid gap-4 py-2 sm:grid-cols-3">
					<Stat
						value="99.3 %"
						label="trials with every angle within 0.5° and vfov within 1°, with six or more points"
					/>
					<Stat
						value="0.008°"
						label="median yaw error over the 1950 synthetic trials (pitch 0.009°, roll 0.017°)"
					/>
					<Stat
						value="1.1 m"
						label="median eye error after the position solve, against 17 m for the GPS prior"
					/>
				</div>
				<p className="text-[13px] gb-secondary">
					Synthetic sweep of 3 to 15 points at 0.5 to 30 km, 0 to 3 px noise, up
					to 30 % outliers and 0 to 50 m GPS error. Source:{" "}
					<code>src/lib/pose6dof/README.md</code>.
				</p>
			</Section>

			<ProvenanceCard />

			<Callout tone="lesson" title="One frame, one origin">
				The solver works in whatever ENU frame the correspondences are in, and
				the eye prior is absolute in that frame. The renderer's frame has its
				origin at sea level, with the eye at <code>(0, 0, eyeAlt)</code>. Feed
				the default <code>[0,0,0]</code> eye and the solve projects from sea
				level, which a regression test shows costs about 3° of pitch and roll.
				The result's <code>eyeOffset</code> is the new eye, replacing the old
				one rather than adding to it.
			</Callout>

			<Section title="In the code" kicker="Where to look">
				<ul className="!list-none !pl-0 space-y-2">
					{[
						[
							"src/lib/camera/index.ts",
							"Pose type, poseBasis, projectPoint, unprojectDir: the single projection every module shares.",
						],
						[
							"src/lib/pose.ts",
							"three.js adapter: applyPose sets a PerspectiveCamera (up = +Z, vfov, aspect) from a Pose and an eye.",
						],
						[
							"src/lib/geo/camera.ts",
							"Camera from gravity and heading, cameraFromAngles, perturbCamera, ENU direction and azimuth/elevation helpers.",
						],
						[
							"src/lib/pose6dof/README.md",
							"solvePose6dof, refinePosition, correspondence kinds, DOF ladder, SolveResult with σ.",
						],
						[
							"src/lib/roll/types.ts",
							"SolvedPose, PoseSource, RollPhoto: the pose with provenance.",
						],
						[
							"src/lib/integration/second-opinion.ts",
							"AppAlign and choosePreview: auto, near-compass or prior.",
						],
					].map(([p, d]) => (
						<li
							key={p}
							className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
						>
							<CodeRef path={p} />
							<span className="min-w-0 flex-1 text-[13px] gb-secondary">
								{d}
							</span>
						</li>
					))}
				</ul>
			</Section>

			<Section title="Where it fits" kicker="Context">
				<p>
					{link("viewport-inference", "Viewport inference")} produces the pose
					by matching the photo's {link("skyline", "skyline")} to the{" "}
					{link("dem-horizon", "DEM horizon")}, and{" "}
					{link("terrain-snapping", "terrain snapping")} fixes the eye height it
					is measured from. The finished pose feeds the{" "}
					{link("photo-workspace", "photo workspace")}, where it is drawn over
					the image, and the {link("camera-roll", "camera roll")}, where many
					poses stitch into a panorama.
				</p>
			</Section>
		</>
	);
}

// ======================================================================================
// Explainer front page (the figures above are folded into Details)
// ======================================================================================
const PRIOR_C = LAYER_STYLE.prior.color;
const SOLVED_C = LAYER_STYLE.solved.color;
const LINE_LIGHT = "#f4efe4";
const medianOf = (a: number[]) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length % 2
		? s[(s.length - 1) / 2]
		: (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** The four numbers drawn on the photo they came from (demo-01, people-free, full frame). */
function HeroPose() {
	const [heroId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(heroId);
	const geo = useMemo(() => {
		if (!d) return null;
		const { width: W, height: H } = d.photo;
		const pose: Pose = {
			yaw: d.solved.yaw,
			pitch: d.solved.pitch,
			roll: d.solved.roll,
			vfov: d.solved.vfov,
		};
		const B = poseBasis(pose);
		// a level horizon (elevation 0) through the solved camera, as a straight line in the photo
		const pts = [-1, 1].map((sgnA) => {
			const q = project(
				pose,
				W / H,
				dirENU(pose.yaw + sgnA * (d.solved.hfov / 2 - 1), 0),
				B,
			);
			return q ? ([q.u * W, q.v * H] as [number, number]) : null;
		});
		return { W, H, pts, pose };
	}, [d]);
	const s = d?.solved;
	return (
		<Figure
			label="Fig. 1"
			bleed
			caption={
				<>
					{s
						? `Four numbers place this photo: facing ${compass(s.yaw)}, a slight look down, a small tilt, a ${s.vfov.toFixed(0)}° view.`
						: "Four numbers place a photo."}{" "}
					<Measured data={d} />
				</>
			}
		>
			<RealPhoto data={d} layers={["solved"]} bleed>
				{() => {
					if (!geo || !geo.pts[0] || !geo.pts[1]) return null;
					const [a, b] = geo.pts;
					const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
					const K = 2.4;
					return (
						<g>
							<PenLine
								seed="pe-hero-level-casing"
								data
								from={[0, mid[1]]}
								to={[geo.W, mid[1]]}
								color="rgba(12, 14, 18, 0.7)"
								width={4.4}
								dash="3 6"
							/>
							<PenLine
								seed="pe-hero-level"
								data
								from={[0, mid[1]]}
								to={[geo.W, mid[1]]}
								color={LINE_LIGHT}
								width={2.4}
								dash="3 6"
							/>
							<PenLine
								seed="pe-hero-horizon-casing"
								data
								from={a}
								to={b}
								color="rgba(12, 14, 18, 0.7)"
								width={5.2}
								dash="8 5"
							/>
							<PenLine
								seed="pe-hero-horizon"
								data
								from={a}
								to={b}
								color={LAYER_STYLE.prior.color}
								width={3.2}
								dash="8 5"
							/>
							<PenLine
								seed="pe-hero-pitch"
								data
								from={[geo.W / 2, geo.H / 2]}
								to={[geo.W / 2, mid[1]]}
								color={LINE_LIGHT}
								width={2.4}
							/>
							<PenLine
								seed="pe-hero-cross-h"
								data
								from={[geo.W / 2 - 14, geo.H / 2]}
								to={[geo.W / 2 + 14, geo.H / 2]}
								color={LINE_LIGHT}
								width={2.8}
							/>
							<PenLine
								seed="pe-hero-cross-v"
								data
								from={[geo.W / 2, geo.H / 2 - 14]}
								to={[geo.W / 2, geo.H / 2 + 14]}
								color={LINE_LIGHT}
								width={2.8}
							/>
							<Mark x={geo.W / 2 + 26} y={geo.H / 2 + 26} n={1} k={K} />
							<Mark
								x={geo.W / 2 - 26}
								y={(geo.H / 2 + mid[1]) / 2}
								n={2}
								k={K}
							/>
							<Mark x={b[0] - 34} y={b[1] - 26} n={3} k={K} />
							<PenArrow
								seed="pe-hero-vfov"
								data
								from={[26, geo.H / 2]}
								to={[26, 8]}
								color={LINE_LIGHT}
								width={2.6}
								head={9}
							/>
							<PenArrow
								seed="pe-hero-vfov-down"
								data
								from={[26, geo.H / 2]}
								to={[26, geo.H - 8]}
								color={LINE_LIGHT}
								width={2.6}
								head={9}
							/>
							<Mark x={52} y={geo.H / 2} n={4} k={K} />
							<HandText
								x={geo.W / 2 + 60}
								y={mid[1] + 36}
								size={20}
								color={LINE_LIGHT}
								rotate={-2}
							>
								pitch {fmt(geo.pose.pitch)}°: the cross sits below the dashes
							</HandText>
							<PenArrow
								seed="pe-hero-note-arrow"
								from={[geo.W / 2 + 56, mid[1] + 28]}
								to={[geo.W / 2 + 18, geo.H / 2 + 6]}
								color={LINE_LIGHT}
								width={2}
								head={8}
							/>
							<HandText
								x={geo.W - 20}
								y={geo.H - 30}
								anchor="end"
								size={20}
								color={LINE_LIGHT}
								rotate={1.5}
							>
								roll {fmt(geo.pose.roll)}°: tiny, but the dashes lean
							</HandText>
						</g>
					);
				}}
			</RealPhoto>
			{s && (
				<MarkList
					items={[
						<>
							<strong>Yaw {s.yaw.toFixed(1)}°.</strong> The cross is where the
							camera points: {compass(s.yaw)}, measured clockwise from north.
						</>,
						<>
							<strong>Pitch {fmt(s.pitch)}°.</strong> Up is positive. The dashed
							line is a level horizon; the camera looks below it.
						</>,
						<>
							<strong>Roll {fmt(s.roll)}°.</strong> The tilt of that line
							against a flat one.
						</>,
						<>
							<strong>View angle {s.vfov.toFixed(1)}°.</strong> How much sky and
							land fit top to bottom.
						</>,
					]}
				/>
			)}
		</Figure>
	);
}

/** A small compass: the phone's heading (magenta) against the solved heading (cyan). Needles are measured, so plain lines. */
function Dial({ d }: { d: GipfelbuchPhotoData }) {
	const R = 31;
	const pt = (deg: number, r = R): [number, number] => [
		50 + Math.sin(deg * D) * r,
		46 - Math.cos(deg * D) * r,
	];
	const a = d.prior.yaw;
	const b = d.solved.yaw;
	const [ax, ay] = pt(a);
	const [bx, by] = pt(b);
	const dl = d.solved.delta.yaw;
	const arc = `M${ax.toFixed(1)} ${ay.toFixed(1)}A${R} ${R} 0 ${Math.abs(dl) > 180 ? 1 : 0} ${dl >= 0 ? 1 : 0} ${bx.toFixed(1)} ${by.toFixed(1)}`;
	return (
		<svg
			viewBox="0 0 100 104"
			className="block h-auto w-full"
			role="img"
			aria-label={`${d.id}: phone heading ${a.toFixed(0)} degrees, solved ${b.toFixed(0)} degrees`}
		>
			<PenCircle
				center={[50, 46]}
				radiusX={R}
				seed={`pe-dial-${d.id}`}
				color="faint"
				width={0.9}
			/>
			<HandLabel
				x={50}
				y={10}
				anchor="middle"
				size={5.5}
				halo={0}
				color={SWISS.secondary}
			>
				N
			</HandLabel>
			<SketchPath
				d={arc}
				seed={`pe-dial-arc-${d.id}`}
				data
				color={SWISS.secondary}
				opacity={0.4}
				width={3.2}
			/>
			<PenLine
				seed={`pe-dial-prior-${d.id}`}
				data
				from={[50, 46]}
				to={[ax, ay]}
				color={PRIOR_C}
				width={2}
				dash="4 3"
			/>
			<PenLine
				seed={`pe-dial-solved-${d.id}`}
				data
				from={[50, 46]}
				to={[bx, by]}
				color={SOLVED_C}
				width={2.6}
			/>
			<HandDot
				x={50}
				y={46}
				r={2.6}
				seed={`pe-dial-eye-${d.id}`}
				data
				color="ink"
				opacity={1}
			/>
			<HandLabel
				x={50}
				y={99}
				anchor="middle"
				size={6}
				halo={0}
				weight={700}
				color={SWISS.ink}
			>
				{dl > 0 ? "+" : "−"}
				{Math.abs(dl).toFixed(1)}°
			</HandLabel>
		</svg>
	);
}

function CompassErrors() {
	return (
		<Figure
			label="Fig. 3"
			bleed
			caption={
				<>
					Phone heading against the solved one, on all 12 photos. The compass
					was off by up to 19° and it errs both ways.{" "}
					<Key color={PRIOR_C} dashed>
						phone
					</Key>{" "}
					<Key color={SOLVED_C}>solved</Key>
				</>
			}
		>
			<Gallery
				cols={4}
				tile={(d) => <Dial d={d} />}
				tone={(d) => (d.solved.accepted ? "result" : "failure")}
				label={(d) => (
					<>
						{d.id.slice(-2)} · {d.prior.yaw.toFixed(0)}° →{" "}
						{d.solved.yaw.toFixed(0)}°
					</>
				)}
			/>
			<p className="mt-2 font-mono text-[11px] gb-secondary">
				Measured on the 12 demo photos by scripts/gipfelbuch/build-data.ts,
				2026-10-01.
			</p>
		</Figure>
	);
}

function MiniPose({ layers }: { layers: PhotoLayer[] }) {
	const [id] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(id);
	const crop = useMemo(() => (d ? skylineBand(d) : undefined), [d]);
	return <RealPhoto data={d} layers={layers} crop={crop} />;
}

function Tag() {
	const [tagId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(tagId);
	return (
		<div className="flex aspect-[4/3] flex-col justify-center gap-1 bg-[var(--gb-paper-deep)] p-4 font-mono text-[11px] leading-relaxed gb-secondary">
			{d ? (
				<>
					<div>
						yaw <span className="gb-ink">{d.solved.yaw.toFixed(1)}°</span> pitch{" "}
						<span className="gb-ink">{fmt(d.solved.pitch)}°</span>
					</div>
					<div>
						roll <span className="gb-ink">{fmt(d.solved.roll)}°</span> view{" "}
						<span className="gb-ink">{d.solved.vfov.toFixed(1)}°</span>
					</div>
					<div className="mt-2 pt-1">
						from: <span className="gb-ink">skyline solve</span>
					</div>
					<div>
						confidence:{" "}
						<span className="gb-ink">{d.solved.confidence.toFixed(2)}</span>
					</div>
				</>
			) : null}
		</div>
	);
}

/** Compass error made visible: the same peak names at the phone's heading and at the solved one. */
function CompassShift() {
	const d = useGipfelbuchPhoto("demo-09");
	const shift = useMemo(() => {
		if (!d) return null;
		const xs = d.peaks
			.filter((p) => p.labelled && p.solved && p.prior)
			.map((p) => Math.abs((p.solved?.[0] ?? 0) - (p.prior?.[0] ?? 0)))
			.sort((a, b) => a - b);
		return xs.length
			? { lo: xs[0], hi: xs[xs.length - 1], n: xs.length }
			: null;
	}, [d]);
	const dyaw = d ? Math.abs(d.solved.delta.yaw) : 0;
	const centre = d ? d.prior.f * dyaw * D : 0;
	return (
		<Figure
			label="Fig. 2"
			bleed
			caption={
				<>
					Fixed: demo-09. The same peak names, placed with the phone&rsquo;s
					heading <Key color={PRIOR_C}>phone</Key> and with the solved one{" "}
					<Key color={LAYER_STYLE.peaks.color}>solved</Key>
					{shift
						? `. A ${dyaw.toFixed(1)}° compass error moves them ${shift.lo.toFixed(0)} to ${shift.hi.toFixed(0)} px, a quarter of the frame.`
						: "."}{" "}
					<Measured data={d} />
				</>
			}
		>
			<RealPhoto
				data={d}
				layers={["peaks", "priorPeaks"]}
				crop={d ? skylineBand(d, 300) : undefined}
				maxLabels={4}
			/>
			<Eq
				where={[
					{
						sym: "Δx",
						c: "prior",
						text: `how far a label slides sideways, in pixels (about ${centre.toFixed(0)} px at the centre here)`,
					},
					{
						sym: "f",
						text: `focal length in pixels (${d ? d.prior.f.toFixed(0) : "…"} at 800 px wide)`,
					},
					{ sym: "Δψ", text: "yaw error, the compass minus the solve" },
				]}
			>
				<Sym c="prior">Δx</Sym> ≈ <Sym>f</Sym> · <Sym>Δψ</Sym> · π / 180
			</Eq>
		</Figure>
	);
}

const REJECTED: GipfelbuchPhotoId[] = ["demo-07", "demo-11"];

function PoseExplainer({ node: _node }: { node: GipfelbuchNode }) {
	const idx = useGipfelbuchIndex();
	const P = idx?.photos;
	const medDy = P ? medianOf(P.map((p) => Math.abs(p.delta.yaw))) : null;
	const maxDy = P ? Math.max(...P.map((p) => Math.abs(p.delta.yaw))) : null;
	return (
		<>
			<HeroPose />

			<Beat kicker="The idea" title="One small record is the whole camera.">
				<p>
					Four angles and a position say where a photo was taken and where it
					looks.{" "}
					<HandMark type="highlight">
						Every part of Rigi reads and writes that same record.
					</HandMark>{" "}
					The four angles are numbered <CircledNumber value={1} /> to{" "}
					<CircledNumber value={4} /> on the photo.
				</p>
				<p>
					So a pose from the phone, a solver or a person can swap in anywhere.
					<MarginNote mark="a">
						One convention, so nothing needs translating. I like that.
					</MarginNote>
				</p>
			</Beat>

			<Beat kicker="How it works" title="A guess, a correction, a label.">
				<Trio
					steps={[
						{
							title: "Sensors guess",
							body: "Compass, gravity and lens give a first pose.",
							visual: <MiniPose layers={["skyline", "prior"]} />,
						},
						{
							title: "The skyline corrects",
							body: "A solver turns the camera until the lines meet.",
							visual: <MiniPose layers={["skyline", "solved"]} />,
						},
						{
							title: "A label travels along",
							body: "Who made the pose, and how sure, stays attached.",
							visual: <Tag />,
						},
					]}
				/>
			</Beat>

			<Beat
				kicker="Why the label matters"
				title="Phone compasses are wrong by degrees, not by hair."
			>
				<p>
					Here the phone pointed <HandMark type="double">19° off</HandMark> on
					two photos. Trust it blindly and every peak name lands on the wrong
					summit.
					<MarginNote mark="b">
						Why do two photos err by the same 19°?
					</MarginNote>
				</p>
			</Beat>

			<CompassShift />

			<CompassErrors />

			<Beat
				kicker="Where it fails"
				title="A weak solve never overwrites the guess."
			>
				<p>
					On these two photos the fit was{" "}
					<HandMark type="wavy">too weak</HandMark>. The pose stays the phone's
					own, marked unverified.
					<MarginNote mark="c">
						Confidence under 0.5: refused, not trusted. Accepted ✓ on the other
						ten.
					</MarginNote>
				</p>
			</Beat>

			<Figure
				label="Fig. 4"
				caption={
					<>
						Fixed: demo-07 and demo-11. Both refused: confidence under 0.5.
						Magenta is the map at the phone's pose, the pose we keep.
					</>
				}
			>
				<Gallery
					ids={REJECTED}
					cols={2}
					tile={(d) => (
						<RealPhoto
							data={d}
							layers={["skyline", "prior"]}
							crop={skylineBand(d)}
						/>
					)}
					tone={() => "failure"}
					label={(d) => (
						<>
							{d.id} · confidence {d.solved.confidence.toFixed(2)}, below the
							0.5 bar
						</>
					)}
				/>
			</Figure>

			<Numbers
				items={[
					{
						value: medDy == null ? "…" : `${medDy.toFixed(1)}°`,
						label: "median compass error found, 12 demo photos",
					},
					{
						value: maxDy == null ? "…" : `${maxDy.toFixed(1)}°`,
						label: "largest compass error, 12 demo photos",
					},
					{
						value: "0.008°",
						label: "median yaw error of the pin solver, 1,950 synthetic trials",
					},
					{
						value: "99.3 %",
						label: "of trials with 6+ pins within 0.5° and 1° vfov",
					},
				]}
				source={
					<>
						First two: measured on the 12 demo photos. Last two:
						src/lib/pose6dof/README.md (synthetic sweep, not real photos).
					</>
				}
			/>

			<Details>
				<Legacy />
			</Details>
		</>
	);
}

export default memo(PoseExplainer);
