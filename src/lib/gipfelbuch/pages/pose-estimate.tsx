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
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import {
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
	PhotoPicker,
	RealPhoto,
	Section,
	Stat,
	Steps,
	Sym,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
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
} from "#/components/gipfelbuch/viz/explain";
import { LAYER_INKS } from "#/components/gipfelbuch/viz/inks";
import {
	type BeatSpec,
	buildTimeline,
	ease,
	rampAt,
	smooth,
	useBeatClock,
} from "#/components/gipfelbuch/viz/motion";
import {
	horizonEl,
	peak,
	SCENE,
	summitOnSkyline,
} from "#/components/gipfelbuch/viz/scene";
import { gipfelbuchHref } from "#/lib/gipfelbuch/graph-utils";
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

// ---------- the real ground: demo-09's DEM horizon and summits (viz/scene.ts, pod D rule D1) ----------
// The camera is synthetic (four sliders), the mountains are the landing photo's: Niederhorn towards the
// Eiger, Mönch and Jungfrau. The story is that photo's real one: the phone's compass said 134.6°, the
// solve found 116.1°.
const ASPECT = SCENE.photo.width / SCENE.photo.height;
const vfovOf = (f: number) => (2 * Math.atan(SCENE.photo.height / 2 / f)) / D;
const poseOf = (p: (typeof SCENE)["prior"]): Pose => ({
	yaw: p.yaw,
	pitch: p.pitch,
	roll: p.roll,
	vfov: vfovOf(p.f),
});
const PRIOR = poseOf(SCENE.prior);
const SOLVED = poseOf(SCENE.solved);
/** Named summits on the drawn horizon, plan distance from the bake. */
const SUMMITS = [
	"Wetterhorn",
	"Schreckhorn",
	"Finsteraarhorn",
	"Eiger",
	"Mönch",
	"Jungfrau",
].map((name) => {
	const p = peak(name);
	return { name, km: p.km, ele: p.ele, ...summitOnSkyline(p) };
});
const skyEl = (az: number) => horizonEl(az);

const EXPLORE: BeatSpec[] = [
	{ id: "guess", kind: "setup", dwell: 2800, label: "the phone's guess" },
	{
		id: "skyline",
		kind: "evidence",
		dwell: 2200,
		label: "the photo's skyline",
	},
	{ id: "yaw", kind: "change", dwell: 2400, label: "yaw" },
	{ id: "pitch", kind: "change", dwell: 1600, label: "pitch" },
	{ id: "roll", kind: "change", dwell: 1600, label: "roll" },
	{ id: "focal", kind: "change", dwell: 1600, label: "focal length" },
	{ id: "solved", kind: "result", dwell: 4500, label: "solved" },
];
const EXPLORE_TL = buildTimeline(EXPLORE);
/** What each beat's note says, written by hand under the image. */
const EXPLORE_NOTE: Record<string, string> = {
	guess: "the phone's compass and gravity: a guess",
	skyline: "the skyline the photo really shows",
	yaw: `yaw turns the wedge: ${fmt(SOLVED.yaw - PRIOR.yaw)}°, the big error`,
	pitch: `pitch tilts the view up ${fmt(SOLVED.pitch - PRIOR.pitch)}°: the line drops`,
	roll: `roll tilts it: ${fmt(SOLVED.roll - PRIOR.roll)}°`,
	focal: `focal length scales it: ${fmt(SCENE.solved.f - SCENE.prior.f, 0)} px`,
	solved: "four numbers, one pose: the lines agree",
};

/** The pose the story shows at `ms`: each change beat moves one number from the guess to the solve. */
function explorePose(ms: number): Pose {
	const k = (id: string) => {
		const b = EXPLORE_TL.beats.find((x) => x.id === id);
		return rampAt(EXPLORE_TL, ms, id, 0, b ? b.end - b.start : 1, ease.out);
	};
	const mix = (a: number, b: number, u: number) => a + (b - a) * u;
	return {
		yaw: mix(PRIOR.yaw, SOLVED.yaw, k("yaw")),
		pitch: mix(PRIOR.pitch, SOLVED.pitch, k("pitch")),
		roll: mix(PRIOR.roll, SOLVED.roll, k("roll")),
		vfov: mix(PRIOR.vfov, SOLVED.vfov, k("focal")),
	};
}

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

// ======================================================================================
// Fig. D2 — one pose, two views. Plan (yaw + FOV wedge) and the image it produces, on demo-09's real
// horizon. The story turns the phone's guess into the solved pose one number per beat.
// ======================================================================================
const PE = {
	CX: 128,
	CY: 172,
	R: 104,
	/** Plan radius in km (summits sit 23–33 km out). */
	KM: 36,
	FX: 262,
	FY: 40,
	FW: 360,
};
const PE_FH = PE.FW / ASPECT;
const peSx = (u: number) => PE.FX + u * PE.FW;
const peSy = (v: number) => PE.FY + v * PE_FH;
const peAt = (az: number, r: number): [number, number] => [
	PE.CX + r * Math.sin(az * D),
	PE.CY - r * Math.cos(az * D),
];
const hfovOf = (p: Pose) =>
	(2 * Math.atan(Math.tan((p.vfov * D) / 2) * ASPECT)) / D;

/** The horizon (and its land below) under a pose, in panel px; exact geometry, recomputed per tick. */
function horizonPaths(pose: Pose) {
	const B = poseBasis(pose);
	const half = hfovOf(pose) / 2 + 6;
	let d = "";
	let first: [number, number] | null = null;
	let last: [number, number] | null = null;
	for (let a = pose.yaw - half; a <= pose.yaw + half; a += 0.25) {
		const el = skyEl(a);
		if (el == null) continue;
		const p = project(pose, ASPECT, dirENU(a, el), B);
		if (!p) continue;
		const x = peSx(p.u);
		const y = peSy(p.v);
		d += `${d ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
		first ??= [x, y];
		last = [x, y];
	}
	const land =
		first && last
			? `${d}L${last[0].toFixed(1)} ${(last[1] + 900).toFixed(1)}L${first[0].toFixed(1)} ${(first[1] + 900).toFixed(1)}Z`
			: "";
	return { d, land };
}
const wedgePath = (p: Pose) => {
	const h = hfovOf(p);
	const w0 = peAt(p.yaw - h / 2, PE.R + 8);
	const w1 = peAt(p.yaw + h / 2, PE.R + 8);
	return `M${PE.CX} ${PE.CY}L${w0[0].toFixed(1)} ${w0[1].toFixed(1)}A${PE.R + 8} ${PE.R + 8} 0 0 1 ${w1[0].toFixed(1)} ${w1[1].toFixed(1)}Z`;
};
const PE_SKYLINE = horizonPaths(SOLVED).d; // what the photo shows: measured layer, fixed
const PE_GUESS = horizonPaths(PRIOR).d; // the guess, kept as a ghost in the result
const PE_GUESS_WEDGE = wedgePath(PRIOR);
const PE_FRAME = `M${PE.FX} ${PE.FY}h${PE.FW}v${PE_FH}h${-PE.FW}Z`;

/** The static plan furniture and the image frame: sketched once. */
const ExploreBase = memo(function ExploreBase() {
	return (
		<g data-layer="ground">
			<HandLabel x={14} y={22} size={13} color="var(--gb-secondary)">
				plan, camera on the Niederhorn
			</HandLabel>
			{[10, 20, 30].map((km) => (
				<PenCircle
					key={km}
					center={[PE.CX, PE.CY]}
					radiusX={(km / PE.KM) * PE.R}
					seed={`pe-plan-ring-${km}`}
					color="faint"
					width={0.9}
					dash={km === 30 ? undefined : "2 4"}
				/>
			))}
			<PenLine
				seed="pe-plan-ns"
				from={[PE.CX, PE.CY - PE.R - 4]}
				to={[PE.CX, PE.CY + PE.R + 4]}
				color="faint"
				width={0.9}
			/>
			<PenLine
				seed="pe-plan-ew"
				from={[PE.CX - PE.R - 4, PE.CY]}
				to={[PE.CX + PE.R + 4, PE.CY]}
				color="faint"
				width={0.9}
			/>
			<HandLabel
				x={PE.CX}
				y={PE.CY - PE.R - 10}
				anchor="middle"
				size={13}
				color="var(--gb-secondary)"
			>
				N
			</HandLabel>
			<HandLabel
				x={PE.CX + PE.R + 10}
				y={PE.CY + 4}
				size={13}
				color="var(--gb-secondary)"
			>
				E
			</HandLabel>
			<NorthArrow x={24} y={70} length={24} seed="pe-north" />
			<HandScaleBar
				x={14}
				y={318}
				metersPerPixel={(PE.KM * 1000) / PE.R}
				meters={10000}
				segments={2}
				seed="pe-plan-scale"
			/>
			<HandLabel x={PE.FX} y={PE.FY - 12} size={13} color="var(--gb-secondary)">
				the image those numbers make
			</HandLabel>
			<SketchRect
				x={PE.FX}
				y={PE.FY}
				width={PE.FW}
				height={PE_FH}
				seed="pe-frame"
				color="pencil"
			/>
		</g>
	);
});

/** The land under the skyline: a fixed sketch, revealed through the moving land clip. */
const ExploreLand = memo(function ExploreLand() {
	return (
		<>
			<Wash d={PE_FRAME} color="ink" seed="pe-land-wash" layers={5} />
			<Hachure
				d={PE_FRAME}
				seed="pe-land-hatch"
				color="pencil"
				gap={5}
				opacity={0.55}
			/>
		</>
	);
});

function PoseExplorer() {
	const clock = useBeatClock<HTMLDivElement>(EXPLORE);
	const [manual, setManual] = useState<Pose | null>(null);
	const t = clock.ms;
	const story = explorePose(t);
	const pose = manual ?? story;
	const set = (k: keyof Pose) => (v: number) => setManual({ ...pose, [k]: v });
	const beatId = EXPLORE[clock.index].id;
	const solved = !manual && clock.kind === "result";
	const B = poseBasis(pose);
	const now = horizonPaths(pose);
	const hfov = hfovOf(pose);
	// the measured skyline wipes in left to right during its beat, and stays
	const wipe = rampAt(EXPLORE_TL, t, "skyline", 0, 900, smooth);
	const ghost = rampAt(EXPLORE_TL, t, "solved");
	const inView = (az: number) =>
		Math.abs(((az - pose.yaw + 540) % 360) - 180) <= hfov / 2;
	const marks = SUMMITS.map((s) => ({
		...s,
		p: project(pose, ASPECT, dirENU(s.az, s.el), B),
	}));
	const active = manual ? null : beatId;
	const note = manual
		? "your pose: drag any slider"
		: (EXPLORE_NOTE[beatId] ?? "");
	const dyaw = pose.yaw - SOLVED.yaw;

	return (
		<Figure
			label="Fig. D2"
			bleed
			pinned={SCENE.id}
			source="Skizze"
			caption={`One pose, two views, on the landing photo's real mountains. Left: the camera on the Niederhorn; yaw points the wedge, field of view sets its width, and the summits sit at their real bearings and distances. Right: the image those four numbers make, with the DEM horizon. The phone's guess turns into the solved pose one number at a time: the compass was ${fmt(PRIOR.yaw - SOLVED.yaw)}° off, gravity and lens nearly right.`}
		>
			<div ref={clock.ref} className="-m-1 sm:-m-2">
				<svg
					viewBox="0 0 640 336"
					className="block h-auto w-full"
					role="img"
					aria-label="A top-down compass wedge beside the projected skyline for the same pose, turning from the phone's guess to the solved pose"
				>
					<defs>
						<clipPath id="pe-clip">
							<rect x={PE.FX} y={PE.FY} width={PE.FW} height={PE_FH} />
						</clipPath>
						<clipPath id="pe-land">
							<path d={now.land || "M0 0"} />
						</clipPath>
						<clipPath id="pe-wedge">
							<path d={wedgePath(pose)} />
						</clipPath>
						<clipPath id="pe-wipe">
							<rect x={PE.FX} y={0} width={PE.FW * wipe} height={336} />
						</clipPath>
					</defs>
					<ExploreBase />

					{/* ---- plan: derived wedge, then summits, then the guess ghost ---- */}
					<g data-layer="derived">
						<g clipPath="url(#pe-wedge)">
							<Hachure
								d={`M${PE.CX - PE.R - 8} ${PE.CY}a${PE.R + 8} ${PE.R + 8} 0 1 0 ${2 * (PE.R + 8)} 0a${PE.R + 8} ${PE.R + 8} 0 1 0 ${-2 * (PE.R + 8)} 0Z`}
								seed="pe-wedge-hatch"
								color="blue"
								gap={5}
								opacity={0.5}
							/>
						</g>
						<path
							d={wedgePath(pose)}
							fill="none"
							stroke={LAYER_INKS.solved.paper}
							strokeWidth={1.2}
						/>
						<path
							d={`M${PE.CX} ${PE.CY}L${peAt(pose.yaw, PE.R + 8)
								.map((v) => v.toFixed(1))
								.join(" ")}`}
							stroke="var(--gb-red)"
							strokeWidth={2}
						/>
					</g>
					{ghost > 0 && (
						<path
							d={PE_GUESS_WEDGE}
							fill="none"
							stroke={LAYER_INKS.prior.paper}
							strokeWidth={1.1}
							strokeDasharray="6 5"
							opacity={0.35 * ghost}
							data-layer="derived"
							data-state="ghost"
						/>
					)}
					<g data-layer="measured">
						{SUMMITS.map((s) => {
							const [x, y] = peAt(s.az, (s.km / PE.KM) * PE.R);
							return (
								<g key={s.name} opacity={inView(s.az) ? 1 : 0.4}>
									<HandDot
										x={x}
										y={y}
										r={2.6}
										seed={`pe-summit-${s.name}`}
										color="navy"
										data
									/>
								</g>
							);
						})}
					</g>
					<HandDot x={PE.CX} y={PE.CY} r={3.6} seed="pe-eye" />
					<HandLabel
						x={PE.CX}
						y={PE.CY + PE.R + 26}
						anchor="middle"
						size={13}
						color={active === "yaw" ? "var(--gb-red)" : "var(--gb-secondary)"}
					>
						{`yaw ${fmt(wrap360(pose.yaw), 1)}° ${compass(pose.yaw)} · hfov ${hfov.toFixed(0)}°`}
					</HandLabel>

					{/* ---- image: land, ghost, derived model, measured skyline on top (grammar v0.2), names ---- */}
					<g clipPath="url(#pe-clip)">
						<g clipPath="url(#pe-land)" data-layer="ground">
							<ExploreLand />
						</g>
						{ghost > 0 && (
							<path
								d={PE_GUESS}
								fill="none"
								stroke={LAYER_INKS.prior.paper}
								strokeWidth={1.6}
								strokeDasharray="6 5"
								opacity={0.35 * ghost}
								data-layer="derived"
								data-state="ghost"
							/>
						)}
						<path
							d={now.d}
							fill="none"
							stroke={solved ? LAYER_INKS.solved.paper : LAYER_INKS.prior.paper}
							strokeWidth={2.2}
							strokeDasharray={solved ? undefined : "6 5"}
							strokeLinejoin="round"
							data-layer="derived"
						/>
						<g clipPath="url(#pe-wipe)" data-layer="measured">
							<path
								d={PE_SKYLINE}
								fill="none"
								stroke={LAYER_INKS.skyline.paper}
								strokeWidth={1.7}
								strokeLinejoin="round"
							/>
						</g>
						<g data-layer="notes">
							{marks.map(
								(m, i) =>
									m.p && (
										<g key={m.name}>
											<PenLine
												seed={`pe-mark-${m.name}`}
												from={[peSx(m.p.u), peSy(m.p.v) - 3]}
												to={[peSx(m.p.u), peSy(m.p.v) - (i % 2 ? 29 : 15)]}
												color="navy"
												width={1}
											/>
											<HandLabel
												x={peSx(m.p.u)}
												// neighbours alternate rows: Finsteraarhorn, Eiger and Mönch sit 4–5° apart
												y={peSy(m.p.v) - (i % 2 ? 33 : 19)}
												anchor="middle"
												caps
												color="var(--gb-navy)"
												size={12}
											>
												{m.name}
											</HandLabel>
										</g>
									),
							)}
						</g>
					</g>
					<g data-layer="notes">
						<HandText
							key={active ?? "manual"}
							x={PE.FX}
							y={PE.FY + PE_FH + 24}
							size={16}
							color={solved ? "forest" : "pencil"}
							rotate={-1.5}
							halo={false}
						>
							{note}
						</HandText>
						<HandLabel
							x={PE.FX + PE.FW}
							y={PE.FY + PE_FH + 46}
							anchor="end"
							size={13}
							color="var(--gb-secondary)"
						>
							{`pitch ${fmt(pose.pitch)}° · roll ${fmt(pose.roll)}° · yaw ${dyaw >= 0 ? "+" : "−"}${Math.abs(dyaw).toFixed(1)}° from solved`}
						</HandLabel>
					</g>
				</svg>
				<div className="flex flex-wrap items-center gap-2 px-4 pt-3 print:hidden">
					{EXPLORE.map((b, i) => (
						<button
							key={b.id}
							type="button"
							onClick={() => {
								setManual(null);
								clock.seek(i);
							}}
							aria-pressed={!manual && clock.index === i}
							className={`px-2.5 py-1 font-mono ${TYPE.micro} ${
								!manual && clock.index === i
									? "bg-[var(--gb-paper-deep)] text-[var(--gb-ink)] underline decoration-[var(--gb-red)] decoration-2 underline-offset-4"
									: "gb-secondary"
							}`}
						>
							{i + 1}. {b.label}
						</button>
					))}
					<button
						type="button"
						onClick={() => {
							setManual(null);
							clock.play();
						}}
						className={`bg-[var(--gb-paper-deep)] px-3 py-1 font-mono ${TYPE.micro} text-[var(--gb-ink)]`}
					>
						▶ again
					</button>
				</div>
				<ol className="hidden list-decimal pl-8 pt-2 print:block">
					{EXPLORE.map((b) => (
						<li key={b.id} className={TYPE.caption}>
							{EXPLORE_NOTE[b.id]}
						</li>
					))}
				</ol>
				<div className="grid gap-x-6 gap-y-1.5 px-4 pb-4 pt-3 sm:grid-cols-2">
					<Slider
						label="yaw"
						value={wrap360(pose.yaw)}
						// the baked horizon spans 31–201°: keep the view inside it
						min={70}
						max={165}
						step={0.5}
						unit="°"
						onChange={set("yaw")}
					/>
					<Slider
						label="pitch"
						value={pose.pitch}
						min={-25}
						max={10}
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
						label="field of view"
						value={pose.vfov}
						min={15}
						max={70}
						step={0.5}
						unit="°"
						onChange={set("vfov")}
					/>
				</div>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Fig. D3 — the DOF ladder: how many correspondences unlock which parts of the pose
// ======================================================================================
type Corrs = { point: number; dir: number; level: number; azimuth: number };
const KINDS: {
	k: keyof Corrs;
	label: string;
	sub: string;
	w: number;
}[] = [
	{ k: "point", label: "peak pin", sub: "a point on the map", w: 1 },
	{ k: "dir", label: "far direction", sub: "a direction only", w: 1 },
	{
		k: "level",
		label: "level",
		sub: "known height, e.g. a lake shore",
		w: 0.5,
	},
	{ k: "azimuth", label: "bearing", sub: "known compass direction", w: 0.5 },
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
			rule: "needs at least 1 evidence",
			held: "kept at gravity reading",
		},
		{
			name: "yaw",
			on: L.yaw,
			rule: "needs at least 1 with a direction",
			held: "kept at compass reading",
		},
		{
			name: "roll",
			on: L.roll,
			rule: "needs 2, or two level points",
			held: "kept at gravity reading",
		},
		{
			name: "field of view",
			on: L.fov,
			rule: "needs 3",
			held: "kept at the photo’s lens data",
		},
		{
			name: "camera position",
			on: L.pos,
			rule: "needs 4 including 3 peaks, plus parallax",
			held: "kept at GPS",
		},
	];
	const bump = (k: keyof Corrs, d: number) =>
		setC({ ...c, [k]: Math.max(0, Math.min(8, c[k] + d)) });
	return (
		<Figure
			label="Fig. D3"
			source="Skizze"
			caption="Synthetic evidence. The solver only fits what the evidence can pin down: unlocked rows are fitted, locked rows stay at the phone’s reading. Peak pins and far directions count 1; level and bearing count 0.5."
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
						evidence
					</div>
				</div>
				<label className="ml-auto flex items-center gap-2 text-[13px] gb-secondary">
					<input
						type="checkbox"
						checked={fov}
						onChange={(e) => setFov(e.target.checked)}
						style={{ accentColor: "var(--accent)" }}
					/>
					solve field of view
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
// Fig. 2 — provenance: what a pose is wrapped in, and how the app chooses one to show
// ======================================================================================
function ProvenanceCard() {
	const [conf, setConf] = useState(0.62);
	const [near, setNear] = useState(true);
	const state = conf > 0.2 ? "auto" : near ? "near compass" : "phone guess";
	const note = {
		auto: `Auto-aligned to skyline · confidence ${(conf * 100).toFixed(0)}%`,
		"near compass": "Skyline ambiguous: refined near the compass heading",
		"phone guess": "Using phone compass + gravity (skyline match was weak)",
	}[state];
	const SRC = ["saved", "hand-fitted", "solved", "phone guess"];
	return (
		<Figure
			label="Fig. 2"
			caption="A pose never travels bare. Left: the record stored per photo. Right: the three-way rule that picks which pose to show when a photo opens. Drag the confidence across 0.2 and the state flips. On the 12 demo photos, saved confidences run 0.63 to 1.00, so each opens as auto."
		>
			<div className="grid gap-4 md:grid-cols-2">
				<div className="bg-[var(--gb-paper-deep)] p-3 text-[13px] leading-relaxed gb-secondary">
					<p>
						Stored with each pose: the four angles, a confidence from 0 to 1,
						the method and the time.
					</p>
					<p className="mt-3">Source, best first:</p>
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
						Which pose is shown
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
						a match exists within 4° yaw / 1.5° pitch of the compass
					</label>
					<div className="mt-3 flex gap-1.5">
						{(["auto", "near compass", "phone guess"] as const).map((s) => (
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
			bleed
			caption={
				<>
					<Measured data={d} /> The teal curve is the terrain horizon projected
					through the solved pose; labelled peaks use the same pose.
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
							{x.accepted ? "ok" : "rejected"}
						</span>
					) : null;
				}}
			/>
			<div className="grid gap-5">
				<div>
					<RealPhoto
						key={id}
						bleed
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
							sub={`phone ${d.prior.yaw.toFixed(2)}° (${sgn(s.delta.yaw)})`}
						/>
						<Row
							k="pitch"
							v={`${s.pitch.toFixed(2)}°`}
							sub={`phone ${d.prior.pitch.toFixed(2)}°`}
						/>
						<Row
							k="roll"
							v={`${s.roll.toFixed(2)}°`}
							sub={`phone ${d.prior.roll.toFixed(2)}°`}
						/>
						<Row
							k="field of view"
							v={`${s.vfov.toFixed(2)}°`}
							sub={`phone ${d.prior.vfov.toFixed(2)}° (×${s.delta.focal.toFixed(3)} focal)`}
						/>
						<Row
							k="camera position"
							v={`${d.gps.eye.toFixed(0)} m`}
							sub={`GPS ±${d.gps.hAccuracy.toFixed(0)} m`}
						/>
						<div className="col-span-2 my-1.5" />
						<Row
							k="search"
							v={`${s.stage} · ${s.search}`}
							sub={s.accepted ? "accepted" : `rejected: ${s.rejectReason}`}
						/>
						<Row k="confidence" v={s.confidence.toFixed(3)} />
						<Row
							k="skyline miss (px)"
							v={`${s.residualPx.toFixed(2)}`}
							sub={`median ${d.residual.solved.median.toFixed(1)} px, p90 ${d.residual.solved.p90.toFixed(0)}`}
						/>
						<Row k="matching columns" v={s.inlierFraction.toFixed(3)} />
						<Row k="columns used" v={s.coverage.toFixed(3)} />
						<Row k="ambiguity" v={s.ambiguity.toFixed(3)} />
						<Row k="horizon relief" v={s.horizonRelief.toFixed(2)} />
						<div className="col-span-2 my-1.5" />
						<Row
							k="saved in app"
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

function Legacy() {
	const [id, setId] = useNotebookPhoto();
	return (
		<>
			<Section title="Four angles and a position" kicker="The object">
				<p>
					A pose is small: yaw, pitch, roll and field of view, in degrees, plus
					a camera position. Yaw is the heading, clockwise from north. Pitch is
					positive looking up. Roll is positive when the right side of the image
					goes down. Field of view is vertical.
				</p>
			</Section>

			<RealPose id={id} setId={setId} />

			<PoseExplorer />

			<Section title="How it works" kicker="Mechanism">
				<Steps
					steps={[
						{
							title: "Axes from angles",
							body: (
								<>
									Yaw and pitch fix where the camera points. Roll then turns the
									image about that direction, so it tilts the horizon without
									moving the aim.
								</>
							),
						},
						{
							title: "Project through the pinhole",
							body: (
								<>
									A point in the world lands in the image by simple pinhole
									geometry. Points behind the camera are not drawn. This gives
									the dashed horizon and skyline in Fig. D2.
								</>
							),
						},
						{
							title: "Solvers fit only what the pins constrain",
							body: (
								<>
									When a person pins points, the solver fits as many parameters
									as the pins support (Fig. D3).
								</>
							),
						},
					]}
				/>
			</Section>

			<DofLadder />

			<Section title="Uncertainty" kicker="Uncertainty">
				<p>
					The solver reports an uncertainty for every parameter it fits.
					Parameters it holds fixed keep the phone&rsquo;s uncertainty: gravity
					2°, compass 10°, field of view 3 %, position at least 5 m.
				</p>
				<div className="grid gap-4 py-2 sm:grid-cols-3">
					<Stat
						value="1.1 m"
						label="median position error after solving, against 17 m from GPS"
					/>
				</div>
				<p className="text-[13px] gb-secondary">
					Synthetic test: 3 to 15 pins at 0.5 to 30 km, 0 to 3 px noise, up to
					30 % outliers, 0 to 50 m GPS error.
				</p>
			</Section>

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
		</>
	);
}

// ======================================================================================
// Explainer front page (the figures above are folded into Details, except the provenance card)
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

/** The four numbers drawn on the photo they came from (the picked photo, full frame). */
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
						? `Four numbers place this photo: facing ${compass(s.yaw)}, pitch ${fmt(s.pitch)}°, roll ${fmt(s.roll)}°, a ${s.vfov.toFixed(0)}° view.`
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
								pitch {fmt(geo.pose.pitch)}°: the cross sits{" "}
								{geo.pose.pitch < 0 ? "below" : "above"} the dashes
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
								roll {fmt(geo.pose.roll)}°:{" "}
								{Math.abs(geo.pose.roll) < 0.5
									? "nearly level"
									: "the dashes lean"}
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
							line is a level horizon; the camera looks{" "}
							{s.pitch < 0 ? "below" : "above"} it.
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
			label="Fig. 4"
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
				Measured on the 12 demo photos.
			</p>
		</Figure>
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
			label="Fig. 3"
			bleed
			pinned="demo-09"
			caption={
				<>
					The same peak names, placed with the phone&rsquo;s heading{" "}
					<Key color={PRIOR_C}>phone</Key> and with the solved one{" "}
					<Key color={LAYER_STYLE.peaks.color}>solved</Key>
					{shift
						? `. A ${dyaw.toFixed(1)}° compass error moves them ${shift.lo.toFixed(0)} to ${shift.hi.toFixed(0)} px, a quarter of the frame.`
						: "."}{" "}
					<Measured data={d} />
				</>
			}
		>
			<RealPhoto
				bleed
				data={d}
				layers={["peaks", "priorPeaks"]}
				crop={d ? skylineBand(d, 300) : undefined}
				maxLabels={4}
				// the phone's heading against the solved one on the ruler
				spillCursor={
					d ? { az: d.prior.yaw, label: "phone", layer: "prior" } : null
				}
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

function PoseExplainer({ node: _node }: { node: GipfelbuchNode }) {
	const idx = useGipfelbuchIndex();
	// accepted photos only: a refused solve's yaw is not trusted (same definition as viewport-inference)
	const P = idx?.photos.filter((p) => p.accepted);
	const medDy = P ? medianOf(P.map((p) => Math.abs(p.delta.yaw))) : null;
	const maxDy = P ? Math.max(...P.map((p) => Math.abs(p.delta.yaw))) : null;
	return (
		<>
			<HeroPose />

			<Beat kicker="The idea" title="A pose is four angles and a position.">
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
					<MarginNote mark="a">All modules use the same convention.</MarginNote>
				</p>
			</Beat>

			<Beat kicker="How it works" title="Every pose records its source.">
				<p>
					The phone&rsquo;s sensors give a first pose, and the skyline solve
					corrects it (see{" "}
					<Link
						to={gipfelbuchHref("viewport-inference")}
						className="underline decoration-[var(--gb-red)]"
					>
						viewport inference
					</Link>
					).{" "}
					<HandMark type="underline">
						The pose keeps a record of who made it and how confident it is.
					</HandMark>
				</p>
			</Beat>

			<ProvenanceCard />

			<Beat
				kicker="Why the source is recorded"
				title="Phone compasses can be off by many degrees."
			>
				<p>
					Here the phone pointed <HandMark type="double">19° off</HandMark> on
					two photos. If the compass were trusted, every peak name would land on
					the wrong summit.
				</p>
			</Beat>

			<CompassShift />

			<CompassErrors />

			<Beat
				kicker="Where it fails"
				title="A weak solve does not replace the phone's pose."
			>
				<p>
					A solve that fails the{" "}
					<Link
						to={gipfelbuchHref("accept-rule")}
						className="underline decoration-[var(--gb-red)]"
					>
						accept rule
					</Link>{" "}
					is not shown. The pose stays the phone&rsquo;s own,{" "}
					<HandMark type="wavy">marked unverified</HandMark>.
				</p>
			</Beat>

			<Numbers
				items={[
					{
						value: medDy == null ? "…" : `${medDy.toFixed(1)}°`,
						label: "median compass error, accepted photos",
					},
					{
						value: maxDy == null ? "…" : `${maxDy.toFixed(1)}°`,
						label: "largest compass error, accepted photos",
					},
					{
						value: "0.008°",
						label: "median yaw error of the pin solver, 1,950 synthetic runs",
					},
					{
						value: "99.3 %",
						label: "of runs with 6+ pins within 0.5° and 1° field of view",
					},
				]}
				source="First two: measured on the 12 demo photos. Last two: synthetic tests, not real photos."
			/>

			<Details>
				<Legacy />
			</Details>
		</>
	);
}

export default memo(PoseExplainer);
