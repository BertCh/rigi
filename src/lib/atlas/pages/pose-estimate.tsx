import { Link } from "@tanstack/react-router";
import { memo, useMemo, useState } from "react";
import {
	type AtlasPhotoData,
	type AtlasPhotoId,
	Callout,
	CodeRef,
	Figure,
	Measured,
	type PhotoLayer,
	PhotoPicker,
	Plot,
	RealPhoto,
	Section,
	Stat,
	Steps,
	useAtlasIndex,
	useAtlasPhoto,
	useTime,
} from "#/components/atlas/viz";
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
} from "#/components/atlas/viz/explain";
import { atlasHref, byId } from "#/lib/atlas/graph-utils";
import type { AtlasNode } from "#/lib/atlas/types";

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
		<label className="flex items-center gap-2 text-xs text-white/70">
			<span className="w-11 shrink-0 font-mono text-white/55">
				{props.label}
			</span>
			<input
				type="range"
				min={props.min}
				max={props.max}
				step={props.step}
				value={props.value}
				onChange={(e) => props.onChange(Number(e.target.value))}
				className="min-w-0 flex-1"
				style={{ accentColor: "var(--accent)" }}
				aria-label={props.label}
			/>
			<span className="w-16 shrink-0 text-right font-mono tabular-nums text-[var(--rigi-paper)]">
				{fmt(props.value)}
				{props.unit}
			</span>
		</label>
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
	const inView = (az: number) =>
		Math.abs(((az - pose.yaw + 540) % 360) - 180) <= hfov / 2;

	return (
		<Figure
			label="Fig. 3"
			bleed
			caption="Schematic. One Pose, two views. Left: the eye at the centre of a compass; yaw points the wedge, vertical FOV sets its width. Right: the image those four numbers produce, computed with the same poseBasis / projectPoint formulas the renderer and every solver share. Pitch slides the horizon, roll tilts it, FOV scales everything. The scene is synthetic; the maths is the code's."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<svg
					viewBox="0 0 640 330"
					className="block h-auto w-full rounded-xl"
					role="img"
					aria-label="A top-down compass wedge beside the projected skyline for the same pose"
				>
					<defs>
						<linearGradient id="pe-sky" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0" stopColor="#1a2a3b" />
							<stop offset="1" stopColor="#4a5a68" />
						</linearGradient>
						<linearGradient id="pe-ridge" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0" stopColor="#66737d" />
							<stop offset="0.5" stopColor="#2c343a" />
							<stop offset="1" stopColor="#14181b" />
						</linearGradient>
						<clipPath id="pe-clip">
							<rect x={FX} y={FY} width={FW} height={FH} rx="4" />
						</clipPath>
					</defs>
					<rect width="640" height="330" fill="#0b0d0f" />

					{/* ---- plan ---- */}
					<text
						x="14"
						y="22"
						className="fill-white/45"
						fontSize="10"
						letterSpacing="1.6"
					>
						PLAN · ENU, EYE AT CENTRE
					</text>
					{[0.33, 0.66, 1].map((k) => (
						<circle
							key={k}
							cx={CX}
							cy={CY}
							r={R * k}
							fill="none"
							stroke="#fff"
							strokeOpacity="0.08"
						/>
					))}
					<line
						x1={CX}
						y1={CY - R - 4}
						x2={CX}
						y2={CY + R + 4}
						stroke="#fff"
						strokeOpacity="0.1"
					/>
					<line
						x1={CX - R - 4}
						y1={CY}
						x2={CX + R + 4}
						y2={CY}
						stroke="#fff"
						strokeOpacity="0.1"
					/>
					<text
						x={CX}
						y={CY - R - 10}
						textAnchor="middle"
						fontSize="10"
						className="fill-white/55"
					>
						N
					</text>
					<path
						d={`M${CX} ${CY} L${w0[0].toFixed(1)} ${w0[1].toFixed(1)} A${R + 8} ${R + 8} 0 ${large} 1 ${w1[0].toFixed(1)} ${w1[1].toFixed(1)} Z`}
						fill="var(--accent)"
						fillOpacity="0.16"
						stroke="var(--accent)"
						strokeOpacity="0.75"
					/>
					<line
						x1={CX}
						y1={CY}
						x2={at(pose.yaw, R + 8)[0]}
						y2={at(pose.yaw, R + 8)[1]}
						stroke="var(--accent)"
						strokeWidth="1.6"
					/>
					{SUMMITS.map((s) => {
						const [x, y] = at(s.az, (s.km / 20) * R);
						const on = inView(s.az);
						return (
							<g key={s.k}>
								<path
									d={`M${x} ${y - 5} L${x + 5} ${y + 4} L${x - 5} ${y + 4} Z`}
									fill={on ? "var(--accent)" : "#fff"}
									fillOpacity={on ? 1 : 0.3}
								/>
								<text
									x={x + 8}
									y={y + 4}
									fontSize="9.5"
									fill={on ? "var(--rigi-paper)" : "#fff"}
									fillOpacity={on ? 1 : 0.4}
								>
									{s.k}
								</text>
							</g>
						);
					})}
					<circle cx={CX} cy={CY} r="3.4" fill="var(--rigi-paper)" />
					<text
						x={CX}
						y={CY + R + 26}
						textAnchor="middle"
						fontSize="10.5"
						className="fill-white/70"
						fontFamily="ui-monospace,monospace"
					>
						yaw {fmt(wrap360(pose.yaw), 0)}° {compass(pose.yaw)} · hfov{" "}
						{hfov.toFixed(0)}°
					</text>

					{/* ---- image ---- */}
					<text
						x={FX}
						y="22"
						className="fill-white/45"
						fontSize="10"
						letterSpacing="1.6"
					>
						THE IMAGE · {ASPECT}:1
					</text>
					<g clipPath="url(#pe-clip)">
						<rect x={FX} y={FY} width={FW} height={FH} fill="url(#pe-sky)" />
						{fill && <path d={fill} fill="url(#pe-ridge)" />}
						{sky.length > 0 && (
							<path
								d={sky.join(" ")}
								fill="none"
								stroke="#e9e4da"
								strokeOpacity="0.55"
								strokeWidth="1.2"
							/>
						)}
						{hor.length > 0 && (
							<path
								d={hor.join(" ")}
								fill="none"
								stroke="var(--accent)"
								strokeWidth="1.4"
								strokeDasharray="5 4"
							/>
						)}
						{marks.map(
							(m) =>
								m.p && (
									<g key={m.k}>
										<line
											x1={sx(m.p.u)}
											y1={sy(m.p.v)}
											x2={sx(m.p.u)}
											y2={sy(m.p.v) - 14}
											stroke="var(--rigi-paper)"
											strokeOpacity="0.8"
										/>
										<text
											x={sx(m.p.u)}
											y={sy(m.p.v) - 18}
											textAnchor="middle"
											fontSize="10.5"
											fill="var(--rigi-paper)"
										>
											{m.k}
										</text>
									</g>
								),
						)}
						<line
							x1={sx(0.5) - 7}
							y1={sy(0.5)}
							x2={sx(0.5) + 7}
							y2={sy(0.5)}
							stroke="#fff"
							strokeOpacity="0.4"
						/>
						<line
							x1={sx(0.5)}
							y1={sy(0.5) - 7}
							x2={sx(0.5)}
							y2={sy(0.5) + 7}
							stroke="#fff"
							strokeOpacity="0.4"
						/>
					</g>
					<rect
						x={FX}
						y={FY}
						width={FW}
						height={FH}
						rx="4"
						fill="none"
						stroke="#fff"
						strokeOpacity="0.22"
					/>
					<text x={FX} y={FY + FH + 16} fontSize="10" className="fill-white/55">
						<tspan fill="var(--accent)">- - -</tspan> true horizon (elevation 0)
						· cream: skyline
					</text>
					<text
						x={FX + FW}
						y={FY + FH + 16}
						textAnchor="end"
						fontSize="10.5"
						className="fill-white/70"
						fontFamily="ui-monospace,monospace"
					>
						pitch {fmt(pose.pitch)}° · roll {fmt(pose.roll)}°
					</text>
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
					<div className="flex items-center gap-3 text-xs text-white/55 sm:col-span-2">
						<button
							type="button"
							onClick={() => setManual(manual ? null : { ...auto })}
							className="rounded-full border border-white/20 px-3 py-1 text-[var(--rigi-paper)] hover:border-[var(--accent)]"
						>
							{manual ? "Resume animation" : "Take control"}
						</button>
						<button
							type="button"
							onClick={() => setManual({ ...PRIOR })}
							className="rounded-full border border-white/20 px-3 py-1 text-[var(--rigi-paper)] hover:border-[var(--accent)]"
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
			label="Fig. 4"
			caption="Schematic (synthetic correspondences). The degrees-of-freedom ladder of solvePose6dof. The solver never solves what the evidence cannot pin down: each unlocked row is fitted, each locked row is held at its sensor prior and its prior variance still feeds the reported σ of the rows above it (the 'consider covariance'). Counts are inliers; n_eff counts point and dir as 1, level and azimuth as 0.5."
		>
			<div className="flex flex-wrap gap-2 pb-3">
				{PRESETS.map((p) => (
					<button
						key={p.name}
						type="button"
						onClick={() => setC(p.c)}
						className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/70 hover:border-[var(--accent)] hover:text-[var(--rigi-paper)]"
					>
						{p.name}
					</button>
				))}
			</div>
			<div className="grid gap-2 sm:grid-cols-4">
				{KINDS.map((kd) => (
					<div
						key={kd.k}
						className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5"
					>
						<div className="flex items-center justify-between">
							<span className="font-mono text-xs text-[var(--rigi-paper)]">
								{kd.label}
							</span>
							<span className="flex items-center gap-1.5">
								<button
									type="button"
									aria-label={`fewer ${kd.label}`}
									onClick={() => bump(kd.k, -1)}
									className="h-6 w-6 rounded-full border border-white/20 text-white/70 hover:border-[var(--accent)]"
								>
									−
								</button>
								<span className="w-4 text-center font-mono text-sm tabular-nums text-[var(--rigi-paper)]">
									{c[kd.k]}
								</span>
								<button
									type="button"
									aria-label={`more ${kd.label}`}
									onClick={() => bump(kd.k, 1)}
									className="h-6 w-6 rounded-full border border-white/20 text-white/70 hover:border-[var(--accent)]"
								>
									+
								</button>
							</span>
						</div>
						<div className="mt-1 text-[11px] leading-snug text-white/45">
							{kd.sub}
						</div>
					</div>
				))}
			</div>
			<div className="mt-4 flex items-end gap-4">
				<div>
					<div
						className="display-title text-4xl leading-none"
						style={{ color: "var(--accent)" }}
					>
						{L.neff.toFixed(1)}
					</div>
					<div className="text-[11px] uppercase tracking-wider text-white/45">
						n_eff
					</div>
				</div>
				<label className="ml-auto flex items-center gap-2 text-xs text-white/60">
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
						className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg border px-3 py-2 transition-colors duration-500"
						style={{
							borderColor: r.on ? "var(--accent)" : "rgba(255,255,255,0.08)",
							background: r.on
								? "color-mix(in srgb, var(--accent) 12%, transparent)"
								: "transparent",
						}}
					>
						<span
							className="h-2.5 w-2.5 shrink-0 rounded-full transition-colors duration-500"
							style={{
								background: r.on ? "var(--accent)" : "rgba(255,255,255,0.18)",
							}}
						/>
						<span className="w-28 shrink-0 font-mono text-sm text-[var(--rigi-paper)]">
							{r.name}
						</span>
						<span className="min-w-0 flex-1 text-xs text-white/55">
							{r.on ? "solved" : r.held}
						</span>
						<span className="w-full text-[11px] text-white/35 sm:w-auto">
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
			label="Fig. 5"
			caption="A pose is never bare. Left: the SolvedPose record the roll aligner stores per photo. Right: choosePreview, the three-way rule that decides which pose the workspace shows when a photo opens. Drag the confidence across 0.2 and the state flips. On the 12 demo photos the saved poses carry confidences of 0.63 to 1.00 (public/demo/manifest.json), all above 0.2, so each opens as auto; the saved yaw agrees with a fresh run of the CPU pipeline to within 0.4° on 11 and 1.2° on demo-11."
		>
			<div className="grid gap-4 md:grid-cols-2">
				<div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 font-mono text-[12px] leading-relaxed text-white/70">
					<div className="text-white/40">{"// src/lib/roll/types.ts"}</div>
					<div>
						<span className="text-[var(--accent)]">SolvedPose</span> {"{"}
					</div>
					<div className="pl-4">
						pose: {"{"} yaw, pitch, roll, vfov {"}"},
					</div>
					<div className="pl-4">confidence: 0..1,</div>
					<div className="pl-4">
						method: <span className="text-[var(--rigi-paper)]">"cascade"</span>{" "}
						|{" "}
						<span className="text-[var(--rigi-paper)]">
							"propagated-suggestion"
						</span>
						,
					</div>
					<div className="pl-4">at: ISO time</div>
					<div>{"}"}</div>
					<div className="mt-3 text-white/40">
						{"// PoseSource, best first"}
					</div>
					<div className="mt-1 flex flex-wrap items-center gap-1">
						{SRC.map((s, i) => (
							<span key={s} className="flex items-center gap-1">
								<span
									className="rounded border px-1.5 py-0.5"
									style={{
										borderColor:
											i === 2 ? "var(--accent)" : "rgba(255,255,255,0.15)",
										color: i === 2 ? "var(--rigi-paper)" : undefined,
									}}
								>
									{s}
								</span>
								{i < SRC.length - 1 && <span className="text-white/30">›</span>}
							</span>
						))}
					</div>
				</div>
				<div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
					<div className="text-[11px] uppercase tracking-wider text-white/45">
						choosePreview (AppAlign)
					</div>
					<label className="mt-2 flex items-center gap-2 text-xs text-white/70">
						<span className="w-20 shrink-0 font-mono text-white/55">
							confidence
						</span>
						<input
							type="range"
							min={0}
							max={1}
							step={0.01}
							value={conf}
							onChange={(e) => setConf(Number(e.target.value))}
							className="min-w-0 flex-1"
							style={{ accentColor: "var(--accent)" }}
							aria-label="solver confidence"
						/>
						<span className="w-10 text-right font-mono tabular-nums text-[var(--rigi-paper)]">
							{conf.toFixed(2)}
						</span>
					</label>
					<label className="mt-2 flex items-center gap-2 text-xs text-white/60">
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
								className="flex-1 rounded-lg border px-2 py-2 text-center font-mono text-xs transition-colors duration-300"
								style={{
									borderColor:
										state === s ? "var(--accent)" : "rgba(255,255,255,0.1)",
									background:
										state === s
											? "color-mix(in srgb, var(--accent) 16%, transparent)"
											: "transparent",
									color:
										state === s ? "var(--rigi-paper)" : "rgba(255,255,255,0.4)",
								}}
							>
								{s}
							</span>
						))}
					</div>
					<p className="mt-3 text-sm text-[var(--rigi-paper)]">{note}</p>
					<p className="mt-1 text-[11px] text-white/40">
						Only "auto" counts as accepted.
					</p>
				</div>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Real data: SolvedPose records of the 12 bundled Niederhorn photos (public/demo/atlas/*.json, produced by
// scripts/atlas/build-data.ts with the real solvePose, then refinePose on a reject).

const sgn = (v: number, n = 2) =>
	`${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(n)}`;

/** A crop over the rows the skyline curves occupy, so people at the bottom of the frame stay out. */
function skyBand(d: AtlasPhotoData): [number, number, number, number] {
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
			<dt className="text-white/40">{k}</dt>
			<dd className="text-white/85">
				{v}
				{sub && <span className="ml-2 text-white/40">{sub}</span>}
			</dd>
		</div>
	);
}

function RealPose({
	id,
	setId,
}: {
	id: AtlasPhotoId;
	setId: (i: AtlasPhotoId) => void;
}) {
	const d = useAtlasPhoto(id);
	const idx = useAtlasIndex();
	const s = d?.solved;
	return (
		<Figure
			label="Fig. 1"
			caption={
				<>
					<Measured data={d} /> The cyan curve is the DEM skyline projected
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
							className="rounded px-1 font-mono text-[9px] text-black"
							style={{ background: x.accepted ? "#5ee0f4" : "#ff5fa2" }}
						>
							{x.accepted ? "ok" : "rej"}
						</span>
					) : null;
				}}
			/>
			<div className="grid gap-5 md:grid-cols-[1.45fr_1fr]">
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
					<dl className="grid grid-cols-[auto_1fr] content-start gap-x-4 gap-y-1.5 font-mono text-[11.5px]">
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
						<div className="col-span-2 my-1 border-t border-white/10" />
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
						<div className="col-span-2 my-1 border-t border-white/10" />
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
					<div className="h-60 animate-pulse rounded-xl bg-white/[0.04]" />
				)}
			</div>
		</Figure>
	);
}

function PoseResiduals({
	sel,
	onPick,
}: {
	sel: AtlasPhotoId;
	onPick: (i: AtlasPhotoId) => void;
}) {
	const idx = useAtlasIndex();
	if (!idx)
		return <div className="h-64 animate-pulse rounded-xl bg-white/[0.04]" />;
	const P = idx.photos;
	const meds = P.filter((p) => p.accepted)
		.map((p) => p.residual.solved.median)
		.sort((a, b) => a - b);
	return (
		<Figure
			label="Fig. 2"
			caption={
				<>
					Measured on the 12 demo photos by scripts/atlas/build-data.ts,
					2026-10-01. Median |detected skyline − DEM skyline| over confident
					columns, at the sensor-prior pose (magenta) and at the solved pose
					(cyan). Hollow cyan: the confidence gate rejected the solve. Click a
					point to load it in Fig. 1.
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
									<rect
										x={x - 13}
										y={s.box.y0}
										width={26}
										height={s.box.y1 - s.box.y0}
										fill="var(--accent)"
										fillOpacity={on ? 0.12 : 0}
									/>
									<line
										x1={x}
										x2={x}
										y1={s.y(p.residual.prior.median)}
										y2={s.y(p.residual.solved.median)}
										stroke="white"
										strokeOpacity=".35"
									/>
									<circle
										cx={x}
										cy={s.y(p.residual.prior.median)}
										r={5}
										fill="#ff5fa2"
									/>
									<circle
										cx={x}
										cy={s.y(p.residual.solved.median)}
										r={5}
										fill={p.accepted ? "#5ee0f4" : "#0e1012"}
										stroke="#5ee0f4"
										strokeWidth={1.8}
									/>
								</g>
							);
						})}
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
		<Link to={atlasHref(id)} className="underline decoration-white/25">
			{label}
		</Link>
	);
}

function Legacy() {
	const [id, setId] = useState<AtlasPhotoId>("demo-03");
	return (
		<>
			<Section title="Four angles and an eye" kicker="The object">
				<p>
					A pose estimate is deliberately small:{" "}
					<code>{"{ yaw, pitch, roll, vfov }"}</code> in degrees, plus an eye
					position in a local east-north-up frame. Yaw is the true heading,
					clockwise from north. Pitch is positive looking up. Roll is positive
					when the right side of the image goes down. FOV is the{" "}
					<em>vertical</em> field of view. That is the whole camera:{" "}
					<code>poseBasis</code> turns the angles into three axes (forward,
					right, up), and <code>projectPoint</code> turns an ENU point into
					image coordinates, 0..1 with y down.
				</p>
				<p>
					The value of such a small object is that it is a single convention.
					The skyline matcher, the pin solver, the three.js renderer, the roll
					aligner and the 6-DoF solver all read and write it, and the pose6dof
					tests check its projection against <code>pose.ts</code> to 7e-15 and
					its angles against <code>geo/camera.ts</code> to 1e-12 px. A pose from
					any one of them can be dropped into any other.
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
									is null. This is the dashed horizon and the skyline in Fig. 3.
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
									How far it goes is set by the ladder in Fig. 4.
								</>
							),
						},
						{
							title: "Wrap it in provenance",
							body: (
								<>
									The numbers are stored with who produced them, a confidence
									and a time (Fig. 5), so the UI can tell a hand-fitted pose
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
				<p className="text-xs text-white/45">
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
							<span className="min-w-0 flex-1 text-sm text-white/60">{d}</span>
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
const PRIOR_C = "#ff5fa2";
const SOLVED_C = "#5ee0f4";
const medianOf = (a: number[]) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length % 2
		? s[(s.length - 1) / 2]
		: (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** The four numbers drawn on the photo they came from (demo-01, people-free, full frame). */
function HeroPose() {
	const d = useAtlasPhoto("demo-01");
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
			<RealPhoto data={d} layers={["solved"]}>
				{() => {
					if (!geo || !geo.pts[0] || !geo.pts[1]) return null;
					const [a, b] = geo.pts;
					const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
					const K = 2.4;
					return (
						<g>
							<line
								x1={0}
								x2={geo.W}
								y1={mid[1]}
								y2={mid[1]}
								stroke="#ece6da"
								strokeOpacity={0.5}
								strokeDasharray="3 6"
								strokeWidth={1.6}
							/>
							<line
								x1={a[0]}
								y1={a[1]}
								x2={b[0]}
								y2={b[1]}
								stroke="#ece6da"
								strokeWidth={2.4}
								strokeDasharray="8 5"
							/>
							<line
								x1={geo.W / 2}
								x2={geo.W / 2}
								y1={geo.H / 2}
								y2={mid[1]}
								stroke="#ece6da"
								strokeWidth={1.6}
							/>
							<g stroke="#ece6da" strokeWidth={2} fill="none">
								<path
									d={`M${geo.W / 2 - 14} ${geo.H / 2}h28M${geo.W / 2} ${geo.H / 2 - 14}v28`}
								/>
							</g>
							<Mark x={geo.W / 2 + 26} y={geo.H / 2 + 26} n={1} k={K} />
							<Mark
								x={geo.W / 2 - 26}
								y={(geo.H / 2 + mid[1]) / 2}
								n={2}
								k={K}
							/>
							<Mark x={b[0] - 34} y={b[1] - 26} n={3} k={K} />
							<path
								d={`M26 8v${geo.H - 16}M18 16l8 -8l8 8M18 ${geo.H - 16}l8 8l8 -8`}
								stroke="#ece6da"
								strokeWidth={2}
								fill="none"
							/>
							<Mark x={52} y={geo.H / 2} n={4} k={K} />
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

/** A small compass: the phone's heading (magenta) against the solved heading (cyan). */
function Dial({ d }: { d: AtlasPhotoData }) {
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
			className="block h-auto w-full rounded-lg bg-white/[0.03]"
			role="img"
			aria-label={`${d.id}: phone heading ${a.toFixed(0)} degrees, solved ${b.toFixed(0)} degrees`}
		>
			<circle
				cx={50}
				cy={46}
				r={R}
				fill="none"
				stroke="rgba(255,255,255,.15)"
			/>
			<text
				x={50}
				y={9}
				textAnchor="middle"
				fontSize={8}
				fill="rgba(236,230,218,.5)"
			>
				N
			</text>
			<path
				d={arc}
				fill="none"
				stroke="#ece6da"
				strokeOpacity={0.5}
				strokeWidth={5}
			/>
			<line
				x1={50}
				y1={46}
				x2={ax}
				y2={ay}
				stroke={PRIOR_C}
				strokeWidth={2}
				strokeDasharray="4 3"
			/>
			<line
				x1={50}
				y1={46}
				x2={bx}
				y2={by}
				stroke={SOLVED_C}
				strokeWidth={2.6}
			/>
			<circle cx={50} cy={46} r={2.6} fill="#ece6da" />
			<text
				x={50}
				y={100}
				textAnchor="middle"
				fontSize={11}
				fontWeight={700}
				fill="#ece6da"
				fontFamily="ui-monospace, monospace"
			>
				{dl > 0 ? "+" : "−"}
				{Math.abs(dl).toFixed(1)}°
			</text>
		</svg>
	);
}

function CompassErrors() {
	return (
		<Figure
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
				label={(d) => (
					<>
						{d.id.slice(-2)} · {d.prior.yaw.toFixed(0)}° →{" "}
						{d.solved.yaw.toFixed(0)}°
						{!d.solved.accepted && (
							<span className="text-[#ff7a66]"> · rejected</span>
						)}
					</>
				)}
			/>
			<p className="mt-2 font-mono text-[10.5px] text-white/40">
				Measured on the 12 demo photos by scripts/atlas/build-data.ts,
				2026-10-01.
			</p>
		</Figure>
	);
}

function MiniPose({ id, layers }: { id: AtlasPhotoId; layers: PhotoLayer[] }) {
	const d = useAtlasPhoto(id);
	const crop = useMemo(() => (d ? skylineBand(d) : undefined), [d]);
	return <RealPhoto data={d} layers={layers} crop={crop} />;
}

function Tag() {
	const d = useAtlasPhoto("demo-03");
	return (
		<div className="flex aspect-[4/3] flex-col justify-center gap-1 bg-black/30 p-4 font-mono text-[11.5px] leading-relaxed text-white/75">
			{d ? (
				<>
					<div>
						yaw <span className="text-white">{d.solved.yaw.toFixed(1)}°</span>{" "}
						pitch <span className="text-white">{fmt(d.solved.pitch)}°</span>
					</div>
					<div>
						roll <span className="text-white">{fmt(d.solved.roll)}°</span> view{" "}
						<span className="text-white">{d.solved.vfov.toFixed(1)}°</span>
					</div>
					<div className="mt-1 border-t border-white/15 pt-1">
						from: <span style={{ color: SOLVED_C }}>skyline solve</span>
					</div>
					<div>
						confidence:{" "}
						<span className="text-white">{d.solved.confidence.toFixed(2)}</span>
					</div>
				</>
			) : null}
		</div>
	);
}

const REJECTED: AtlasPhotoId[] = ["demo-07", "demo-11"];

function PoseExplainer({ node: _node }: { node: AtlasNode }) {
	const idx = useAtlasIndex();
	const P = idx?.photos;
	const medDy = P ? medianOf(P.map((p) => Math.abs(p.delta.yaw))) : null;
	const maxDy = P ? Math.max(...P.map((p) => Math.abs(p.delta.yaw))) : null;
	return (
		<>
			<HeroPose />

			<Beat kicker="The idea" title="One small record is the whole camera.">
				<p>
					Four angles and a position say where a photo was taken and where it
					looks. Every part of Rigi reads and writes that same record.
				</p>
				<p>
					So a pose from the phone, a solver or a person can swap in anywhere.
				</p>
			</Beat>

			<Beat kicker="How it works" title="A guess, a correction, a label.">
				<Trio
					steps={[
						{
							title: "Sensors guess",
							body: "Compass, gravity and lens give a first pose.",
							visual: <MiniPose id="demo-03" layers={["skyline", "prior"]} />,
						},
						{
							title: "The skyline corrects",
							body: "A solver turns the camera until the lines meet.",
							visual: <MiniPose id="demo-03" layers={["skyline", "solved"]} />,
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
					Here the phone pointed 19° off on two photos. Trust it blindly and
					every peak name lands on the wrong summit.
				</p>
			</Beat>

			<CompassErrors />

			<Beat
				kicker="Where it fails"
				title="A weak solve never overwrites the guess."
			>
				<p>
					On these two photos the fit was too weak. The pose stays the phone's
					own, marked unverified.
				</p>
			</Beat>

			<Figure
				caption={
					<>
						Both refused: confidence under 0.5. Magenta is the map at the
						phone's pose, the pose we keep.
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

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next: {link("viewport-inference", "viewport inference")} makes this pose
				from a skyline. The {link("accept-rule", "accept rule")} decides when to
				believe it.
			</p>

			<Details>
				<Legacy />
			</Details>
		</>
	);
}

export default memo(PoseExplainer);
