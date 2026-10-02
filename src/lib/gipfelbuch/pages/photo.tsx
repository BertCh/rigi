// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import {
	CircledKey,
	CircledNumber,
	HandMark,
	HandScaleBar,
	KrokiTitle,
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
	Stipple,
} from "#/components/gipfelbuch/notebook/Ink";
import { useNotebookPhoto } from "#/components/gipfelbuch/notebook/useNotebookPhoto";
import { SWISS } from "#/components/gipfelbuch/swiss/palette";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import {
	Callout,
	CodeRef,
	Figure,
	GIPFELBUCH_PHOTO_IDS,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	HandLabel,
	HandRange,
	MarginNote,
	Measured,
	RealPhoto,
	Section,
	Stat,
	Steps,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
	useTime,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Key as ColorKey,
	Details,
	Gallery,
	Mark,
	MarkList,
	Numbers,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { Eq, Frac, Sym } from "#/components/gipfelbuch/viz/math";
import { PhotoStory } from "#/components/gipfelbuch/viz/PhotoStory";
import { groupColor } from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";
import { publicUrl } from "#/lib/public-url";

/* The record each demo photo carries: public/demo/manifest.json (what the ingest wrote). The prior and the solved pose
 * come from the gipfelbuch data (public/demo/gipfelbuch/<id>.json, scripts/gipfelbuch/build-data.ts). "Error" on this
 * sheet means solved minus prior: the solved pose is the pipeline's own estimate (skyline fit, accepted by the
 * confidence gate in 10 of 12), not a hand-registered truth. */

// Numbers below are the real defaults from the code:
//  gps     sigmaH = clamp(hAcc ?? 20, 5, 100) m           (geocam/priors/photo-priors.ts sigmaHFromHAcc)
//  gravity sigma 1.5 deg                                  (geocam/map/factors.ts gravityFactor)
//  compass sigmaNoise 5 deg + sigmaBias 5 deg, Student-t nu 3 (COMPASS_DEFAULTS)
//  alt     sigmaA 3 m                                     (concord/priors/altitude.ts EYE_PRIOR_DEFAULTS)
const H_MIN = 5;
const H_MAX = 100;
const NOISE = 5;
const BIAS = 5;
const SIG_YAW = Math.hypot(NOISE, BIAS);
const SIG_G = 1.5;
// What the production skyline solve uses (src/lib/geo/solve.ts DEFAULT_SIGMA.yaw, yawRange).
const SOLVE_SIGMA_YAW = 15;
const SEARCH_YAW = 25;
const TRUE_YAW = 14; // deg east of north, illustrative scene
const rad = (d: number) => (d * Math.PI) / 180;

type Key = "gps" | "compass" | "gravity" | "focal";
const KEYS: { k: Key; label: string; sub: string; params: number }[] = [
	{ k: "gps", label: "GPS fix", sub: "position", params: 3 },
	{ k: "compass", label: "Compass", sub: "yaw", params: 1 },
	{ k: "gravity", label: "Gravity", sub: "pitch + roll", params: 2 },
	{ k: "focal", label: "EXIF focal", sub: "field of view", params: 1 },
];

const wedge = (cx: number, cy: number, r: number, a0: number, a1: number) => {
	const p = (a: number) =>
		`${(cx + r * Math.sin(rad(a))).toFixed(1)} ${(cy - r * Math.cos(rad(a))).toFixed(1)}`;
	return `M${cx} ${cy} L${p(a0)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p(a1)} Z`;
};

const sgn = (v: number, n = 1) =>
	`${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(n)}`;

type ManifestPhoto = {
	id: string;
	src: string;
	width: number;
	height: number;
	takenAtUtc: string;
	tzOffset: string;
	lat: number;
	lon: number;
	alt: number;
	hAccuracy: number;
	heading: number;
	f35: number;
	vfov: number;
	pitch: number;
	roll: number;
	holding: string;
	gravity: number[];
};
function useManifest() {
	const [m, setM] = useState<Record<string, ManifestPhoto> | null>(null);
	useEffect(() => {
		let live = true;
		fetch(publicUrl("/demo/manifest.json"))
			.then((r) => r.json())
			.then((j: { photos: ManifestPhoto[] }) => {
				if (live) setM(Object.fromEntries(j.photos.map((p) => [p.id, p])));
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);
	return m;
}

/** The phone's reported horizontal accuracy per photo (manifest.json; the gipfelbuch JSON does not repeat it). */
function useHAcc(): Record<string, number> | null {
	const m = useManifest();
	return m
		? Object.fromEntries(Object.values(m).map((p) => [p.id, p.hAccuracy]))
		: null;
}

const A = ({ id, children }: { id: string; children: string }) => (
	<Link to="/gipfelbuch/$concept" params={{ concept: id }}>
		{children}
	</Link>
);

const COMPASS16 = [
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
] as const;
const compassName = (deg: number) =>
	COMPASS16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

function HeroMarks() {
	const [photoId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photoId);
	const W = d?.photo.width ?? 800;
	const H = d?.photo.height ?? 600;
	return (
		<Figure
			label="Fig. 1"
			bleed
			caption={
				<>
					{d
						? `One photo, six values the phone recorded before any pixel is analysed (GPS accuracy ±${d.gps.hAccuracy.toFixed(0)} m).`
						: "One photo, six values the phone recorded."}{" "}
					<Measured data={d} />
				</>
			}
		>
			<RealPhoto data={d} layers={[]} bleed>
				{() => (
					<>
						<Mark x={W * 0.1} y={H - 50} n={1} k={1.9} />
						<Mark x={W * 0.1} y={H * 0.5} n={2} k={1.9} />
						<Mark x={W / 2} y={60} n={3} k={1.9} />
						<Mark x={W / 2} y={H * 0.5} n={4} k={1.9} />
						<Mark x={W * 0.9} y={H * 0.5} n={5} k={1.9} />
						<Mark x={W * 0.9} y={H - 50} n={6} k={1.9} />
						<HandText
							x={W / 2 + 70}
							y={H * 0.32}
							size={34}
							color="red"
							rotate={-2}
						>
							up to 19° off on the demo set
						</HandText>
						<PenArrow
							seed="ph-hero-compass"
							from={[W / 2 + 90, H * 0.32 - 40]}
							to={[W / 2 + 22, 60 + 24]}
							color="red"
							width={2.4}
							head={14}
						/>
					</>
				)}
			</RealPhoto>
			{d && (
				<MarkList
					items={[
						<>
							<strong>Position.</strong> {d.gps.lat.toFixed(4)}° N,{" "}
							{d.gps.lon.toFixed(4)}° E.
						</>,
						<>
							<strong>Altitude.</strong> {d.gps.alt.toFixed(0)} m above sea
							level.
						</>,
						<>
							<strong>Compass.</strong> {d.sensor.heading.toFixed(0)}°, facing{" "}
							{compassName(d.sensor.heading)}.
						</>,
						<>
							<strong>Tilt.</strong> Pointing{" "}
							{Math.abs(d.sensor.pitch).toFixed(1)}°{" "}
							{d.sensor.pitch < 0 ? "down" : "up"}, rolled{" "}
							{Math.abs(d.sensor.roll).toFixed(1)}°.
						</>,
						<>
							<strong>Lens.</strong> {d.sensor.f35} mm equivalent, a{" "}
							{d.sensor.vfov.toFixed(0)}° tall view.
						</>,
						<>
							<strong>Time.</strong>{" "}
							{d.photo.takenAt.slice(0, 16).replace("T", " ")} UTC.
						</>,
					]}
				/>
			)}
		</Figure>
	);
}

function HeroCompare() {
	const [photoId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photoId);
	return (
		<PhotoStory
			photoId={photoId}
			focus="prior"
			number="Fig. 2"
			title="The phone's guess and the solved pose"
			caption={
				<>
					{d
						? `Sensors alone put the skyline ${d.residual.prior.median.toFixed(0)} px off (yaw ${sgn(d.solved.delta.yaw)}°). After solving, the median gap is ${d.residual.solved.median.toFixed(1)} px.`
						: "Sensors alone, then solved."}{" "}
					<ColorKey layer="prior">sensors only</ColorKey>
					{", "}
					<ColorKey layer="solved">solved</ColorKey>
					{", "}
					<ColorKey layer="skyline">skyline in the photo</ColorKey>.{" "}
					{d ? <Measured data={d} /> : null}
				</>
			}
		/>
	);
}

/** One worked example of what a yaw error does to the picture: the whole skyline slides sideways by f·tan(Δψ). */
function YawShift() {
	const [photoId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photoId);
	if (!d) return null;
	const dyaw = d.solved.delta.yaw;
	const shift = d.prior.f * Math.tan(rad(Math.abs(dyaw)));
	return (
		<>
			<Eq
				label="What a compass error does to the picture"
				where={[
					{ sym: "Δx", text: "how far the skyline slides sideways, in pixels" },
					{ sym: "f", text: "focal length in pixels, from the lens tag" },
					{ sym: "ψ", c: "prior", text: "yaw the compass reported" },
					{ sym: "ψ", c: "solved", text: "yaw the skyline fit found" },
				]}
			>
				<Sym>Δx</Sym> ≈ <Sym>f</Sym> · tan(<Sym c="solved">ψ</Sym> −{" "}
				<Sym c="prior">ψ</Sym>)
			</Eq>
			<p className={`-mt-3 mb-6 ${TYPE.caption} gb-secondary`}>
				Photo above: f = {d.prior.f.toFixed(0)} px, Δψ = {sgn(dyaw)}°, so Δx ={" "}
				{shift.toFixed(0)} px of an {d.photo.width} px frame. The ridge&rsquo;s
				slope turns that slide into the {d.residual.prior.median.toFixed(0)} px
				vertical gap.
			</p>
		</>
	);
}

function PriorTrio() {
	const [photoId] = useNotebookPhoto();
	const d = useGipfelbuchPhoto(photoId);
	const haccAll = useHAcc();
	const hacc = haccAll?.[photoId];
	// rank among the bundled photos by reported horizontal accuracy: 1 = loosest fix
	const haccValues = haccAll ? Object.values(haccAll) : [];
	const looseRank =
		hacc != null ? haccValues.filter((v) => v > hacc).length + 1 : null;
	const haccRankNote =
		looseRank == null || haccValues.length === 0
			? ""
			: looseRank === 1
				? `loosest of ${haccValues.length}`
				: looseRank === haccValues.length
					? `tightest of ${haccValues.length}`
					: `${looseRank}${looseRank === 2 ? "nd" : looseRank === 3 ? "rd" : "th"} loosest of ${haccValues.length}`;
	const ang = (deg: number, r: number) => [
		50 + r * Math.sin(rad(deg)),
		50 - r * Math.cos(rad(deg)),
	];
	const box = "block h-auto w-full";
	return (
		<Trio
			steps={[
				{
					title: "GPS gives a circle",
					body: "The camera is somewhere inside it. The phone reports the radius.",
					visual: (
						<svg
							viewBox="0 0 100 75"
							className={box}
							role="img"
							aria-label="GPS error disc"
						>
							<Stipple
								d={circleD(50, 37, 30)}
								seed="trio-gps"
								color="pencil"
								spacing={4}
								size={1.1}
								opacity={0.8}
							/>
							<SketchPath
								d={circleD(50, 37, 30)}
								seed="trio-gps-edge"
								color="pencil"
								width={0.9}
								passes={1}
							/>
							<HandDot
								x={50}
								y={37}
								r={2.6}
								seed="trio-gps-fix"
								color="red"
								opacity={1}
							/>
							<HandText x={52} y={46} size={5} halo={false}>
								fix
							</HandText>
							{haccRankNote && (
								<HandText x={4} y={9} size={5} rotate={-2} halo={false}>
									{haccRankNote}
								</HandText>
							)}
							<HandLabel
								x={50}
								y={73}
								anchor="middle"
								size={4.2}
								halo={0}
								color={SWISS.secondary}
							>
								{hacc ? `±${hacc.toFixed(0)} m` : ""}
							</HandLabel>
						</svg>
					),
				},
				{
					title: "The compass gives a direction",
					body: "Dashed: the compass. Blue: where the camera faced.",
					visual: (
						<svg
							viewBox="0 0 100 75"
							className={box}
							role="img"
							aria-label="Compass heading against solved heading"
						>
							{d &&
								[
									{ a: d.prior.yaw, key: "prior", c: "pencil", dash: "3 2" },
									{
										a: d.solved.yaw,
										key: "solved",
										c: "blue",
										dash: undefined,
									},
								].map((r) => {
									const [x, y] = ang(r.a - d.prior.yaw, 38);
									return (
										<PenLine
											key={r.key}
											seed={`trio-compass-${r.key}`}
											from={[50, 62]}
											to={[x, y + 12]}
											color={r.c as "pencil" | "blue"}
											width={r.key === "solved" ? 1.8 : 1.4}
											dash={r.dash}
										/>
									);
								})}
							<HandText x={4} y={10} size={5.5} rotate={-2} halo={false}>
								{d ? "compass reading vs solved heading" : ""}
							</HandText>
							<HandLabel
								x={50}
								y={73}
								anchor="middle"
								size={4.2}
								halo={0}
								color={SWISS.secondary}
							>
								{d ? `${sgn(d.solved.delta.yaw)}° apart` : ""}
							</HandLabel>
						</svg>
					),
				},
				{
					title: "Gravity and lens are close to the solve",
					body: "Tilt lands within 3° and view width within 5% of the solve.",
					visual: (
						<svg
							viewBox="0 0 100 75"
							className={box}
							role="img"
							aria-label="Field of view prior against solved"
						>
							{d &&
								[
									{ h: d.prior.hfov, key: "prior", c: "pencil", dash: "3 2" },
									{
										h: d.solved.hfov,
										key: "solved",
										c: "blue",
										dash: undefined,
									},
								].map((w) => {
									const [x1, y1] = ang(-w.h / 2, 55);
									const [x2, y2] = ang(w.h / 2, 55);
									return (
										<SketchPath
											key={w.key}
											d={`M${x1} ${y1 + 12} L50 62 L${x2} ${y2 + 12}`}
											seed={`trio-fov-${w.key}`}
											color={w.c as "pencil" | "blue"}
											width={w.key === "solved" ? 1.7 : 1.3}
											dash={w.dash}
											passes={1}
										/>
									);
								})}
							<HandLabel
								x={50}
								y={73}
								anchor="middle"
								size={4.2}
								halo={0}
								color={SWISS.secondary}
							>
								{d
									? `${d.prior.hfov.toFixed(0)}° vs ${d.solved.hfov.toFixed(0)}° wide`
									: ""}
							</HandLabel>
						</svg>
					),
				},
			]}
		/>
	);
}

// Label sizes: viewBox 720 drawn at ~880 px (wide track) is ~1.22x, so 10 -> ~12 px rendered.
const YAWBARS_W = 720;
const YAWBARS_LABEL = 10;

/** Twelve compass errors as one diverging bar each. Solid = accepted; red outline = the solve was rejected, so the error is not trusted. */
function YawBars() {
	const idx = useGipfelbuchIndex();
	if (!idx)
		return <div className="h-48 animate-pulse bg-[var(--gb-paper-deep)]" />;
	const W = YAWBARS_W;
	const zero = 120;
	const k = 5; // px per degree
	const bw = 38;
	const step = (W - 40) / 12;
	const photos = idx.photos;
	const worstAt = photos.reduce(
		(best, p, i) =>
			Math.abs(p.delta.yaw) > Math.abs(photos[best].delta.yaw) ? i : best,
		0,
	);
	const worstYaw = photos[worstAt];
	return (
		<Figure
			label="Fig. 3"
			caption={
				<>
					The compass is off by up to 19° across twelve photos. Shaded: the ±
					{SOLVE_SIGMA_YAW}° the solver allows for; the search reaches ±
					{SEARCH_YAW}°. Magnetic declination here is only +3.4° and iPhones
					already write true north. Red outline: rejected solves.{" "}
					<Measured data={idx} />
				</>
			}
		>
			<svg
				viewBox={`0 0 ${W} 250`}
				className="block h-auto w-full"
				role="img"
				aria-label="Compass error per photo"
			>
				<Wash
					d={rectD(
						20,
						zero - SOLVE_SIGMA_YAW * k,
						W - 20,
						zero + SOLVE_SIGMA_YAW * k,
					)}
					color="ink"
					seed="yawbars-sigma"
					opacity={0.04}
				/>
				<PenLine
					seed="yawbars-zero"
					data
					from={[20, zero]}
					to={[W - 20, zero]}
					color="ink"
					width={1.2}
				/>
				<HandLabel
					x={24}
					y={zero - SOLVE_SIGMA_YAW * k - 6}
					size={YAWBARS_LABEL}
					color="var(--gb-secondary)"
				>
					solver allows ±{SOLVE_SIGMA_YAW}°
				</HandLabel>
				{photos.map((p, i) => {
					const v = p.delta.yaw;
					const x = 20 + step * i + (step - bw) / 2;
					const h = Math.max(Math.abs(v) * k, 1);
					const top = v >= 0 ? zero - h : zero;
					return (
						<g key={p.id}>
							{p.accepted ? (
								<Hachure
									d={rectD(x, top, x + bw, top + h)}
									seed={`yawbars-hatch-${p.id}`}
									color="ink"
									gap={2.6}
									width={1.2}
									opacity={0.85}
								/>
							) : null}
							<SketchPath
								d={rectD(x, top, x + bw, top + h)}
								seed={`yawbars-bar-${p.id}`}
								data
								color={p.accepted ? "ink" : "red"}
								width={p.accepted ? 1.2 : 1.5}
							/>
							<HandLabel
								x={x + bw / 2}
								y={v >= 0 ? top - 6 : top + h + 14}
								anchor="middle"
								size={YAWBARS_LABEL}
								color={SWISS.ink}
							>
								{sgn(v, 1)}
							</HandLabel>
							<HandLabel
								x={x + bw / 2}
								y={244}
								anchor="middle"
								size={YAWBARS_LABEL}
								color="var(--gb-secondary)"
							>
								{p.id.slice(-2)}
							</HandLabel>
						</g>
					);
				})}
				<CircledKey x={W - 48} y={34} value={1} seed="yawbars-key" />
				<HandText x={W - 62} y={60} anchor="end" size={14} rotate={-2}>
					worst: {worstYaw.id.slice(-2)}, {sgn(worstYaw.delta.yaw, 1)}°
				</HandText>
				<PenArrow
					seed="yawbars-worst-arrow"
					from={[W - 130, 66]}
					to={[
						20 + step * worstAt + step / 2,
						zero + Math.abs(worstYaw.delta.yaw) * k + 22,
					]}
					color="ink"
					width={1.1}
				/>
			</svg>
		</Figure>
	);
}

/** Sky and ridge only: from just above the skyline to just below its median row, so foreground people stay out. */
function ridgeCrop(d: GipfelbuchPhotoData): [number, number, number, number] {
	const ys = d.skyline.rows
		.filter((v): v is number => v != null)
		.sort((a, b) => a - b);
	const lo = ys[Math.floor(ys.length * 0.02)] ?? 0;
	const med = ys[ys.length >> 1] ?? d.photo.height / 2;
	const y0 = Math.max(0, Math.round(lo - 70));
	const y1 = Math.min(d.photo.height, Math.max(Math.round(med + 40), y0 + 200));
	return [0, y0, d.photo.width, y1];
}

const ALT_IDS = [
	"demo-01",
	"demo-02",
	"demo-03",
	"demo-04",
	"demo-06",
	"demo-09",
	"demo-10",
] as const;

function AltitudeCheck() {
	return (
		<Figure
			label="Fig. 4"
			caption={
				<>
					Seven photos, one check: GPS altitude minus the map&rsquo;s ground
					height. One photo is 730 m off.
				</>
			}
		>
			<Gallery
				ids={ALT_IDS}
				cols={4}
				tone={(d) =>
					// an altitude check: no solver verdict on the tiles whose fix agrees
					Math.abs(d.gps.alt - d.gps.ground) > 200 ? "caution" : "neutral"
				}
				tag={(d) => `${Math.round(Math.abs(d.gps.alt - d.gps.ground))} m off`}
				tile={(d) => (
					<div className="overflow-hidden">
						<RealPhoto data={d} layers={[]} crop={ridgeCrop(d)} />
					</div>
				)}
				label={(d) => {
					const diff = d.gps.alt - d.gps.ground;
					return (
						<span className="gb-num text-[12px]">
							<span className="gb-ink">{d.id.slice(-2)}</span>
							{" · "}
							{sgn(diff, 0)} m{" · ±"}
							{d.gps.hAccuracy.toFixed(0)} m fix
						</span>
					);
				}}
			/>
			<p className="mt-3 font-mono text-[11px] gb-secondary">
				Ground = Terrarium height map.
			</p>
		</Figure>
	);
}

/** The one formula behind the lens step, worked on demo-01 (26 mm) and the ultra-wide demo-02 (13 mm). */
function LensEquation() {
	const [photoId] = useNotebookPhoto();
	const a = useGipfelbuchPhoto(photoId);
	const b = useGipfelbuchPhoto("demo-02");
	if (!a || !b) return null;
	return (
		<>
			<Eq
				label="From a lens number to a field of view"
				where={[
					{ sym: "f", c: "var(--accent)", text: "focal length in pixels" },
					{
						sym: "f₃₅",
						text: "35 mm-equivalent focal length from the tags, defined on the frame diagonal (43.27 mm)",
					},
					{ sym: "W, H", text: "photo width and height in pixels" },
				]}
			>
				<Sym c="var(--accent)">f</Sym> = <Sym>f₃₅</Sym> ·{" "}
				<Frac n={<>√(W² + H²)</>} d="43.27 mm" />
				{"   "}
				hfov = 2 · atan(
				<Frac
					n={<Sym>W</Sym>}
					d={
						<>
							2 <Sym c="var(--accent)">f</Sym>
						</>
					}
				/>
				)
			</Eq>
			<p className="-mt-3 mb-6 text-[13px] leading-snug gb-secondary">
				{a.id}: {a.sensor.f35} mm gives f = {a.prior.f.toFixed(0)} px and a{" "}
				{a.prior.hfov.toFixed(0)}° wide view. Photo 02 (the ultra-wide):{" "}
				{b.sensor.f35} mm gives {b.prior.hfov.toFixed(0)}°. We model a
				straight-line lens, with no distortion term, so the edges of an
				ultra-wide are the least trustworthy.
			</p>
		</>
	);
}

const rectD = (x0: number, y0: number, x1: number, y1: number) =>
	`M${x0} ${y0}H${x1}V${y1}H${x0}Z`;
const circleD = (cx: number, cy: number, r: number) =>
	`M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`;

// Label sizes: 11 and 13 px rendered at the text column (~720 px) for this 520-wide viewBox.
const STRIP_W = 520;
const STRIP_LABEL_SMALL = 9;
const STRIP_LABEL = 10.5;

function Strip({
	title,
	unit,
	vals,
	range,
	sigma,
	sel,
	onPick,
	fmt = (v: number) => `${v}`,
	band,
	note,
}: /** One horizontal strip: the 12 photos' errors as dots, with the prior's 1σ and 2σ bands stippled behind. */
{
	title: string;
	unit: string;
	vals: { id: GipfelbuchPhotoId; v: number }[];
	range: [number, number];
	sigma?: number;
	band?: [number, number];
	sel: GipfelbuchPhotoId;
	onPick: (i: GipfelbuchPhotoId) => void;
	fmt?: (v: number) => string;
	/** A hand note under the strip, from the measured values. */
	note?: ReactNode;
}) {
	const W = STRIP_W;
	const x0 = 14;
	const x1 = W - 14;
	const X = (v: number) =>
		x0 + ((v - range[0]) / (range[1] - range[0])) * (x1 - x0);
	const y = 40;
	const sorted = [...vals].sort((a, b) => a.v - b.v);
	const lane: number[] = [];
	const lastX: number[] = [];
	for (const p of sorted) {
		let k = lastX.findIndex((e) => X(p.v) - e > 15);
		if (k < 0) k = lastX.length;
		lastX[k] = X(p.v);
		lane.push(k);
	}
	const ticks = 4;
	return (
		<svg
			viewBox={`0 0 ${W} 108`}
			className="block h-auto w-full"
			role="img"
			aria-label={`${title}: measured error per photo`}
		>
			<HandLabel x={x0} y={14} size={STRIP_LABEL} color={SWISS.ink}>
				{title}
			</HandLabel>
			{sigma != null && (
				<>
					<Wash
						d={rectD(X(-2 * sigma), 22, X(2 * sigma), 82)}
						color="ink"
						seed={`strip-${title}-2sigma`}
						opacity={0.03}
					/>
					<Wash
						d={rectD(X(-sigma), 22, X(sigma), 82)}
						color="ink"
						seed={`strip-${title}-1sigma`}
						opacity={0.05}
					/>
					<HandLabel
						x={X(sigma) - 3}
						y={34}
						anchor="end"
						size={STRIP_LABEL}
						color={SWISS.secondary}
					>
						±1σ = {sigma.toFixed(1)}
					</HandLabel>
				</>
			)}
			{band && (
				<Wash
					d={rectD(X(band[0]), 22, X(band[1]), 82)}
					color="ink"
					seed={`strip-${title}-band`}
					opacity={0.05}
				/>
			)}
			<PenLine
				seed={`strip-${title}-axis`}
				from={[x0, y + 30]}
				to={[x1, y + 30]}
				color="pencil"
				width={1.1}
			/>
			{Array.from(
				{ length: ticks + 1 },
				(_, i) => range[0] + ((range[1] - range[0]) * i) / ticks,
			).map((v) => (
				<g key={v}>
					<PenLine
						seed={`strip-${title}-tick-${v}`}
						from={[X(v), y + 30]}
						to={[X(v), y + 36]}
						color="pencil"
						width={1}
					/>
					<HandLabel
						x={X(v)}
						y={y + 48}
						anchor="middle"
						size={STRIP_LABEL_SMALL}
						color={SWISS.secondary}
					>
						{fmt(v)}
					</HandLabel>
				</g>
			))}
			{range[0] < 0 && (
				<PenLine
					seed={`strip-${title}-zero`}
					from={[X(0), 22]}
					to={[X(0), y + 30]}
					color="pencil"
					width={0.9}
					dash="2 3"
				/>
			)}
			<HandLabel
				x={x1}
				y={14}
				anchor="end"
				size={STRIP_LABEL_SMALL}
				color={SWISS.secondary}
			>
				{unit}
			</HandLabel>
			{sorted.map((p, i) => {
				const cy = y + 18 - lane[i] * 11;
				const on = p.id === sel;
				return (
					// biome-ignore lint/a11y/useSemanticElements: SVG dot
					<g
						key={p.id}
						role="button"
						tabIndex={0}
						aria-label={p.id}
						onClick={() => onPick(p.id)}
						onKeyDown={(e) => e.key === "Enter" && onPick(p.id)}
						className="cursor-pointer"
					>
						<circle cx={X(p.v)} cy={cy} r={9} fill="transparent" />
						<HandDot
							x={X(p.v)}
							y={cy}
							r={on ? 6.8 : 4.6}
							seed={`strip-${title}-dot-${p.id}`}
							data
							color={on ? "red" : SWISS.ink}
							opacity={on ? 1 : 0.85}
						/>
						{on && (
							<>
								<PenCircle
									seed={`strip-${title}-sel-${p.id}`}
									center={[X(p.v), cy]}
									radiusX={9.5}
									color="red"
									width={1}
								/>
								<HandLabel
									x={X(p.v)}
									y={cy - 13}
									anchor="middle"
									size={STRIP_LABEL_SMALL}
									color="var(--gb-red)"
								>
									{p.id.slice(-2)} · {fmt(p.v)}
								</HandLabel>
							</>
						)}
					</g>
				);
			})}
			{note && (
				<HandText
					x={x1}
					y={104}
					anchor="end"
					size={10.5}
					rotate={-1}
					halo={false}
				>
					{note}
				</HandText>
			)}
		</svg>
	);
}

function PriorErrors({
	sel,
	onPick,
}: {
	sel: GipfelbuchPhotoId;
	onPick: (i: GipfelbuchPhotoId) => void;
}) {
	const idx = useGipfelbuchIndex();
	const hacc = useHAcc();
	if (!idx)
		return <div className="h-64 animate-pulse bg-[var(--gb-paper-deep)]" />;
	const photos = idx.photos;
	const by = (f: (p: (typeof photos)[number]) => number) =>
		photos.map((p) => ({ id: p.id, v: f(p) }));
	const med = (a: number[]) => {
		const s = [...a].map(Math.abs).sort((x, y) => x - y);
		return (s[5] + s[6]) / 2;
	};
	const yaw = by((p) => p.delta.yaw);
	const pit = by((p) => p.delta.pitch);
	const rol = by((p) => p.delta.roll);
	return (
		<Figure
			label="Fig. D2"
			caption={
				<>
					Measured on the 12 demo photos (error = solved − sensors; click a dot
					to pick that photo). Shaded bands are the assumed widths: compass{" "}
					{SIG_YAW.toFixed(1)}° (1σ and 2σ), gravity {SIG_G}°, GPS 5 to 100 m.
				</>
			}
		>
			<div className="grid gap-3">
				<Strip
					title="Compass heading error"
					unit="degrees"
					vals={yaw}
					range={[-20, 20]}
					sigma={SIG_YAW}
					sel={sel}
					onPick={onPick}
					fmt={(v) => sgn(v, 1)}
					note={`${yaw.filter((p) => Math.abs(p.v) > SIG_YAW).length} of 12 outside 1σ`}
				/>
				<Strip
					title="Gravity pitch error"
					unit="degrees"
					vals={pit}
					range={[-4, 4]}
					sigma={SIG_G}
					sel={sel}
					onPick={onPick}
					note={`${pit.filter((p) => Math.abs(p.v) > SIG_G).length} photos beyond ${SIG_G}°: gravity is tighter`}
				/>
				<Strip
					title="Gravity roll error"
					unit="degrees"
					vals={rol}
					range={[-4, 4]}
					sigma={SIG_G}
					sel={sel}
					onPick={onPick}
				/>
				{hacc ? (
					<Strip
						title="GPS accuracy (clamp band shaded)"
						unit="metres"
						vals={GIPFELBUCH_PHOTO_IDS.map((id) => ({ id, v: hacc[id] }))}
						range={[0, 140]}
						band={[H_MIN, H_MAX]}
						note="clamped to 5–100 m before use"
						sel={sel}
						onPick={onPick}
						fmt={(v) => v.toFixed(0)}
					/>
				) : (
					<div className="h-24 animate-pulse bg-[var(--gb-paper-deep)]" />
				)}
			</div>
			<div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Stat
					value={`${med(yaw.map((p) => p.v)).toFixed(1)}°`}
					label="median |compass error|, all 12 photos"
				/>
				<Stat
					value={`${yaw.filter((p) => Math.abs(p.v) > SIG_YAW).length} / 12`}
					label={`beyond the assumed 1σ (${SIG_YAW.toFixed(1)}°)`}
				/>
				<Stat
					value={`${med(pit.map((p) => p.v)).toFixed(2)}° / ${med(rol.map((p) => p.v)).toFixed(2)}°`}
					label="median |pitch| / |roll| error"
				/>
				<Stat
					value={`${Math.max(...yaw.map((p) => Math.abs(p.v))).toFixed(1)}°`}
					label="worst compass error (photo 10)"
				/>
			</div>
		</Figure>
	);
}

// Static pen furniture for PriorLab, built once (the lab re-renders every frame).
const LAB_CX = 270;
const LAB_CY = 330;
const LAB_R = 280;
const LAB_PX_PER_M = 1.5;
const LAB_HALF_FUZZ_OFF = 22;
const LAB_RINGS = [100, 200, 300].map((r) => (
	<SketchPath
		key={r}
		d={circleD(LAB_CX, LAB_CY, r * LAB_PX_PER_M)}
		seed={`lab-ring-${r}`}
		color="faint"
		width={0.6}
		dash="2 5"
		passes={1}
	/>
));
const LAB_NORTH = (
	<g>
		<PenLine
			seed="lab-north"
			from={[LAB_CX, LAB_CY]}
			to={[LAB_CX, 14]}
			color="faint"
			width={0.8}
		/>
		<HandLabel x={LAB_CX + 8} y={24} size={13} color={SWISS.secondary}>
			N
		</HandLabel>
	</g>
);
const LAB_PIVOT = (
	<PenCircle
		seed="lab-pulse"
		center={[0, 0]}
		radiusX={10}
		color="pencil"
		width={1.2}
	/>
);
const LAB_CAMERA = (
	<HandDot
		x={LAB_CX}
		y={LAB_CY}
		r={4.8}
		seed="lab-camera"
		color="red"
		opacity={1}
	/>
);
const HORIZON_K = [-1, -0.5, 0, 0.5, 1];
const HORIZON_LINES = HORIZON_K.map((k) => (
	<PenLine
		key={k}
		seed={`lab-horizon-${k}`}
		from={[-160, 0]}
		to={[160, 0]}
		color="pencil"
		width={1.2}
	/>
));
const HORIZON_LEVEL = (
	<PenLine
		seed="lab-level"
		from={[-160, 0]}
		to={[160, 0]}
		color="ink"
		width={2}
	/>
);

function PriorLab(_props: { accent: string }) {
	const [on, setOn] = useState<Record<Key, boolean>>({
		gps: true,
		compass: false,
		gravity: false,
		focal: false,
	});
	const [hAcc, setHAcc] = useState(20);
	const [ref, t] = useTime<HTMLDivElement>(0);
	const sigH = Math.min(H_MAX, Math.max(H_MIN, hAcc));
	const nOn = KEYS.filter((k) => on[k.k]).reduce((a, k) => a + k.params, 0);
	const total = 7;

	// plan view
	const cx = LAB_CX;
	const cy = LAB_CY;
	const R = LAB_R;
	const pxPerM = LAB_PX_PER_M;
	const half = on.focal ? 32 : 40;
	const halfFuzz = on.focal ? 2 : LAB_HALF_FUZZ_OFF; // lens unknown: hfov could be anything in a band
	const sy = on.compass ? SIG_YAW : 180;
	const pulse = 0.5 + 0.5 * Math.sin(t * 1.6);
	const spin = (t * 40) % 360;

	// plan: yaw wedge layers (1,2,3 sigma)
	const yawLayers = on.compass
		? [3, 2, 1].map((k) => ({ k, a: Math.min(179, k * sy) }))
		: [];
	// The nominal view wedge is drawn once, pointing north, and turned with a transform: no re-sketching per frame.
	const fovAngle = on.compass ? TRUE_YAW : spin;
	const fovD = wedge(cx, cy, R - 20, -half, half);
	const fuzzLeftD = wedge(cx, cy, R - 20, -half - halfFuzz, -half);
	const fuzzRightD = wedge(cx, cy, R - 20, half, half + halfFuzz);
	const gpsSpacing = Math.max(5, (sigH * pxPerM) / 16);

	// gravity inset
	const wob = (s: number) => Math.sin(t * s) * 1;
	const tilt = on.gravity ? 0 : 22 * wob(0.9);
	const lift = on.gravity ? 0 : 18 * wob(1.3);
	const gx = 100;
	const gy = 100;
	const horizonAt = (k: number) => {
		const yc = gy + lift * (1 + k * 0.5);
		const dy = (tilt + k * 8) * 2.8;
		return `translate(${gx} ${yc.toFixed(2)}) rotate(${((-Math.atan2(dy, 160) * 180) / Math.PI).toFixed(2)})`;
	};

	return (
		<Figure
			label="Fig. D3"
			source="Skizze"
			caption="A diagram, not a photo. The camera prior holds one estimate per sensor. Toggle each sensor to see how the range of possible camera poses changes. Widths use the real defaults: GPS 5 to 100 m, compass 5° noise + 5° bias, gravity 1.5°."
		>
			<div ref={ref} className="p-3 sm:p-5">
				<div className="flex flex-wrap gap-2">
					{KEYS.map((k) => (
						<button
							key={k.k}
							type="button"
							aria-pressed={on[k.k]}
							onClick={() => setOn({ ...on, [k.k]: !on[k.k] })}
							className={`border-b-2 bg-[var(--gb-paper-deep)] px-3.5 py-1.5 text-left font-mono ${TYPE.caption} transition`}
							style={{
								borderColor: on[k.k] ? "var(--gb-ink)" : "transparent",
								color: on[k.k] ? "var(--gb-ink)" : "var(--gb-secondary)",
							}}
						>
							<svg
								width={10}
								height={10}
								viewBox="0 0 10 10"
								className="mr-2 inline-block"
								aria-hidden="true"
							>
								<HandDot
									x={5}
									y={5}
									r={3.4}
									seed={`lab-key-${k.k}`}
									color={on[k.k] ? "ink" : "faint"}
									opacity={1}
								/>
							</svg>
							{k.label}
							<span className="ml-2 gb-secondary">{k.sub}</span>
						</button>
					))}
				</div>

				<div className="mt-4 grid gap-4 lg:grid-cols-[1.7fr_1fr]">
					<svg
						viewBox="0 0 540 380"
						className="h-auto w-full bg-[var(--gb-paper-deep)]"
						role="img"
						aria-label="Plan view of the camera prior: position disc and yaw wedge"
					>
						<defs>
							<clipPath id="cp-clip">
								<rect x="0" y="0" width="540" height="380" />
							</clipPath>
						</defs>
						<g clipPath="url(#cp-clip)">
							{LAB_RINGS}
							{[100, 200].map((r) => (
								<HandLabel
									key={r}
									x={cx + 4}
									y={cy - r * pxPerM - 4}
									size={11}
									color={SWISS.secondary}
								>
									{r} m
								</HandLabel>
							))}
							{/* yaw wedge: stipple, denser toward the centre of belief */}
							{on.compass ? (
								yawLayers.map((l) => (
									<Stipple
										key={l.k}
										d={wedge(
											cx,
											cy,
											R,
											TRUE_YAW - l.a - half - halfFuzz,
											TRUE_YAW + l.a + half + halfFuzz,
										)}
										seed={`lab-yaw-${l.k}`}
										color="pencil"
										spacing={5 + l.k * 3.5}
										size={1.4}
										opacity={0.7}
									/>
								))
							) : (
								<Stipple
									d={circleD(cx, cy, R)}
									seed="lab-yaw-any"
									color="pencil"
									spacing={13}
									size={1.3}
									opacity={0.55}
								/>
							)}
							{/* field of view: nominal wedge, turned by a transform */}
							<g transform={`rotate(${fovAngle.toFixed(2)} ${cx} ${cy})`}>
								{on.compass ? (
									<Hachure
										d={fovD}
										seed="lab-fov"
										color="ink"
										gap={6}
										angle={-45 - TRUE_YAW}
										opacity={0.5}
									/>
								) : (
									<Stipple
										d={fovD}
										seed="lab-fov-spin"
										color="ink"
										spacing={9}
										size={1.4}
										opacity={0.5}
									/>
								)}
								<SketchPath
									d={fovD}
									seed="lab-fov-edge"
									color="ink"
									width={1.4}
									passes={1}
								/>
								{!on.focal && (
									<>
										<SketchPath
											d={fuzzLeftD}
											seed="lab-fuzz-l"
											color="pencil"
											width={1}
											dash="3 4"
											passes={1}
										/>
										<SketchPath
											d={fuzzRightD}
											seed="lab-fuzz-r"
											color="pencil"
											width={1}
											dash="3 4"
											passes={1}
										/>
									</>
								)}
							</g>
							{/* compass reading ray */}
							{on.compass && (
								<PenLine
									seed="lab-ray"
									from={[cx, cy]}
									to={[
										cx + (R - 8) * Math.sin(rad(TRUE_YAW)),
										cy - (R - 8) * Math.cos(rad(TRUE_YAW)),
									]}
									color="ink"
									width={1.2}
									dash="1 5"
								/>
							)}
							{LAB_NORTH}
							{/* position */}
							{on.gps ? (
								<>
									<Stipple
										d={circleD(cx, cy, sigH * pxPerM)}
										seed="lab-gps"
										color="pencil"
										spacing={gpsSpacing}
										size={1.6}
										opacity={0.85}
									/>
									<SketchPath
										d={circleD(cx, cy, sigH * pxPerM)}
										seed="lab-gps-edge"
										color="pencil"
										width={1}
										passes={1}
										opacity={0.8}
									/>
								</>
							) : (
								<Stipple
									d={rectD(6, 6, 534, 374)}
									seed="lab-gps-any"
									color="pencil"
									spacing={20}
									size={1.2}
									opacity={0.4}
								/>
							)}
							{LAB_CAMERA}
							<g
								transform={`translate(${cx} ${cy}) scale(${(1 + 0.3 * pulse).toFixed(3)})`}
							>
								{LAB_PIVOT}
							</g>
						</g>
						<KrokiTitle
							x={14}
							y={26}
							title="Plan view: where the prior places the camera"
							author=""
							seed="lab-title"
							size={16}
						/>
						<HandScaleBar
							x={400}
							y={356}
							metersPerPixel={1 / pxPerM}
							meters={100}
							segments={2}
							seed="lab-scale"
						/>
						<HandText x={cx + 16} y={cy + 34} size={15} rotate={-3}>
							{on.gps
								? "the camera is somewhere in this disc"
								: "no GPS: the camera could be anywhere"}
						</HandText>
						<PenArrow
							seed="lab-camera-arrow"
							from={[cx + 24, cy + 20]}
							to={[cx + 7, cy + 7]}
							color="ink"
							width={1.1}
							head={5}
						/>
						<HandLabel x={14} y={368} color="var(--gb-secondary)">
							{on.gps
								? `GPS width ${sigH.toFixed(0)} m`
								: "position: any (no GPS)"}
						</HandLabel>
					</svg>

					<div className="flex flex-col gap-3">
						<svg
							viewBox="0 0 200 200"
							className="h-auto w-full bg-[var(--gb-paper-deep)]"
							role="img"
							aria-label="Gravity inset: horizon tilt"
						>
							<defs>
								<clipPath id="cp-frame">
									<rect x="20" y="40" width="160" height="120" />
								</clipPath>
							</defs>
							<SketchRect
								x={20}
								y={40}
								width={160}
								height={120}
								seed="lab-frame"
								color="pencil"
							/>
							<g clipPath="url(#cp-frame)">
								{on.gravity ? (
									<g transform={horizonAt(0)}>{HORIZON_LEVEL}</g>
								) : (
									HORIZON_K.map((k, i) => (
										<g key={k} transform={horizonAt(k)}>
											{HORIZON_LINES[i]}
										</g>
									))
								)}
								{on.gravity && (
									<Hachure
										d={rectD(0, gy - SIG_G * 4, 200, gy + SIG_G * 4)}
										seed="lab-gravity-band"
										color="pencil"
										gap={2.5}
										opacity={0.8}
									/>
								)}
							</g>
							<HandLabel
								x={100}
								y={28}
								anchor="middle"
								color="var(--gb-secondary)"
							>
								{on.gravity
									? `pitch, roll ±${SIG_G}°`
									: "pitch, roll: unconstrained"}
							</HandLabel>
							<HandLabel
								x={100}
								y={184}
								anchor="middle"
								size={13}
								color={SWISS.secondary}
							>
								accelerometer, gravity vector
							</HandLabel>
						</svg>

						<div className="bg-[var(--gb-paper-deep)] p-3">
							<div className={`block font-mono ${TYPE.micro} gb-secondary`}>
								GPS accuracy
								{hAcc < H_MIN || hAcc > H_MAX ? ` (clamped to ${sigH})` : ""}
								<HandRange
									value={hAcc}
									min={1}
									max={150}
									step={1}
									label="GPS accuracy"
									onChange={setHAcc}
									readout={`${hAcc} m`}
								/>
							</div>
						</div>
					</div>
				</div>

				<div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
					<Stat
						value={on.gps ? `${sigH.toFixed(0)} m` : "free"}
						label="GPS width"
					/>
					<Stat
						value={on.compass ? `${SIG_YAW.toFixed(1)}°` : "360°"}
						label="yaw spread"
					/>
					<Stat
						value={on.gravity ? `${SIG_G}°` : "free"}
						label="pitch / roll width"
					/>
					<Stat value={`${nOn} / ${total}`} label="unknowns pinned" />
				</div>
				<svg
					viewBox="0 0 600 14"
					className="mt-3 block h-auto w-full"
					role="img"
					aria-label={`${nOn} of ${total} parameters have a prior`}
				>
					<PenLine
						seed="lab-progress-track"
						from={[0, 12]}
						to={[600, 12]}
						color="faint"
						width={0.9}
					/>
					{nOn > 0 && (
						<>
							<Hachure
								d={rectD(0, 2, (nOn / total) * 600, 10)}
								seed="lab-progress-hatch"
								color="ink"
								gap={2.4}
								width={1.1}
								opacity={0.9}
							/>
							<SketchPath
								d={rectD(0, 2, (nOn / total) * 600, 10)}
								seed="lab-progress-bar"
								data
								color="ink"
								width={1.2}
							/>
						</>
					)}
				</svg>
			</div>
		</Figure>
	);
}

function FieldRow({ id, m }: { id: GipfelbuchPhotoId; m: ManifestPhoto }) {
	const d = useGipfelbuchPhoto(id);
	const diff = d ? m.alt - d.gps.ground : null;
	const bad = diff != null && Math.abs(diff) > 200;
	const cells: [string, ReactNode, boolean?][] = [
		["held", m.holding === "portrait" ? "portrait" : "landscape"],
		["lens → view", `${m.f35} mm → ${m.vfov.toFixed(1)}°`],
		["GPS error", `±${m.hAccuracy.toFixed(0)} m`],
		["GPS alt (m)", m.alt.toFixed(0)],
		["ground (m)", d ? d.gps.ground.toFixed(0) : "…"],
		[
			"alt − ground",
			diff == null
				? "…"
				: `${diff > 0 ? "+" : "−"}${Math.abs(diff).toFixed(0)}`,
			bad,
		],
		["heading", `${m.heading.toFixed(1)}°`],
		["pitch / roll", `${m.pitch.toFixed(1)}° / ${m.roll.toFixed(1)}°`],
	];
	return (
		<div className={`${FIELD_GRID} py-1.5 odd:bg-[var(--gb-paper-deep)]`}>
			<div className="pl-2 gb-ink">{id.slice(-2)}</div>
			{cells.map(([label, value, flag]) => (
				<div
					key={label}
					style={flag ? { color: "var(--gb-red)", fontWeight: 700 } : undefined}
				>
					<span className="block text-[10px] gb-secondary @[640px]:hidden">
						{label}
					</span>
					{value}
				</div>
			))}
		</div>
	);
}

// 9 columns when the figure is wide; three rows of three, each cell labelled, when it is narrow (container query).
const FIELD_GRID =
	"grid grid-cols-3 gap-x-3 gap-y-1.5 @[640px]:grid-cols-[2rem_5.5rem_8rem_5rem_4.5rem_3.5rem_4.5rem_4rem_1fr] @[640px]:gap-y-0";
const FIELD_HEADS = [
	"photo",
	"held",
	"lens → view",
	"GPS error",
	"GPS alt (m)",
	"ground (m)",
	"alt − ground",
	"heading",
	"pitch / roll",
];

function FieldsTable() {
	const m = useManifest();
	return (
		<Figure
			label="Fig. D4"
			caption={
				<>
					All 12 demo photos: the phone&rsquo;s record beside the Terrarium
					height at the fix. GPS altitude sits 28 to 69 m above the map in
					eleven photos (a fix lands tens of metres off the summit track and the
					map is a 30 m model) and 730 m below it in photo 09, so the engine
					takes max(GPS altitude, ground + 1.6 m) rather than trusting the tag.
				</>
			}
		>
			<div className="@container font-mono text-[12px] gb-secondary">
				<div className={`${FIELD_GRID} mb-1.5 hidden @[640px]:grid`}>
					{FIELD_HEADS.map((h) => (
						<div key={h}>{h}</div>
					))}
				</div>
				{m
					? GIPFELBUCH_PHOTO_IDS.map((id) => (
							<FieldRow key={id} id={id} m={m[id]} />
						))
					: null}
			</div>
		</Figure>
	);
}

/* Which tags survive? Mirrors buildPhotoMeta's LocalPhotoExtras. */
const TAGS = [
	{
		k: "gps",
		label: "GPS fix",
		flag: "positionSource",
		off: "pin",
		on: "exif",
		fix: "User pins position on the map; altitude and GPS error are left empty; the engine uses the map's ground for the eye.",
	},
	{
		k: "head",
		label: "Compass heading",
		flag: "yawUnknown",
		off: "true",
		on: "false",
		fix: "Solver runs a full 360 deg yaw search.",
	},
	{
		k: "grav",
		label: "Apple gravity",
		flag: "pitchRollUnknown",
		off: "true",
		on: "false",
		fix: "pitch and roll stay 0 as placeholders; the solver frees them.",
	},
	{
		k: "focal",
		label: "35 mm focal",
		flag: "focalUnknown",
		off: "true",
		on: "false",
		fix: "focal defaults to 26 mm (iPhone main camera); the solver frees it.",
	},
] as const;

function Survival({ accent }: { accent: string }) {
	const [have, setHave] = useState<Record<string, boolean>>({
		gps: true,
		head: true,
		grav: true,
		focal: true,
	});
	const missing = TAGS.filter((t) => !have[t.k]);
	return (
		<div>
			<div className="flex flex-wrap gap-2">
				{TAGS.map((t) => (
					<button
						key={t.k}
						type="button"
						aria-pressed={have[t.k]}
						onClick={() => setHave({ ...have, [t.k]: !have[t.k] })}
						className="px-3 py-2 text-left font-mono text-[11px] transition"
						style={{
							background: have[t.k] ? "var(--gb-ink)" : "var(--gb-paper-deep)",
							color: have[t.k] ? "var(--gb-paper)" : "var(--gb-secondary)",
							textDecoration: have[t.k] ? "none" : "line-through",
						}}
					>
						{t.label}
					</button>
				))}
			</div>
			<div className="mt-4 grid gap-1.5 font-mono text-[11px]">
				{TAGS.map((t) => (
					<div key={t.k} className="flex flex-wrap gap-x-3 gb-secondary">
						<span className="gb-secondary">local.{t.flag}</span>
						<span
							style={{
								color: have[t.k]
									? "color-mix(in oklab, var(--gb-ink) 75%, transparent)"
									: accent,
							}}
						>
							{have[t.k] ? t.on : t.off}
						</span>
					</div>
				))}
			</div>
			<ul className="mt-4 list-none space-y-1.5 !pl-0 text-[13px] leading-snug gb-secondary">
				{missing.length === 0 && (
					<li className="!pl-0">
						Full phone photo: the record is a complete starting pose and nothing
						is freed.
					</li>
				)}
				{missing.map((t) => (
					<li key={t.k} className="!pl-0">
						<span style={{ color: accent }}>{t.label}:</span> {t.fix}
					</li>
				))}
			</ul>
		</div>
	);
}

function PhotoNumbers() {
	const idx = useGipfelbuchIndex();
	const hacc = useHAcc();
	const d9 = useGipfelbuchPhoto("demo-09");
	if (!idx) return null;
	const acc = idx.photos.filter((p) => p.accepted);
	const med = (a: number[]) => {
		const s = [...a].sort((x, y) => x - y);
		return s.length % 2
			? s[s.length >> 1]
			: (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
	};
	const hAcc = hacc ? Object.values(hacc) : [];
	return (
		<Numbers
			items={[
				{
					value: `${med(acc.map((p) => Math.abs(p.delta.yaw))).toFixed(1)}°`,
					label: `median compass error, ${acc.length} accepted photos`,
				},
				{
					value: `${med(acc.map((p) => Math.abs(p.delta.pitch))).toFixed(1)}°`,
					label: "median tilt error from gravity",
				},
				{
					value: hAcc.length
						? `${Math.min(...hAcc).toFixed(0)}–${Math.max(...hAcc).toFixed(0)} m`
						: "…",
					label: "GPS accuracy the phone reports across the 12 photos",
				},
				{
					value: d9 ? `${sgn(d9.gps.alt - d9.gps.ground, 0)} m` : "…",
					label: "worst altitude error against the map (photo 09)",
				},
			]}
			source="Compass and tilt: the 10 of 12 demo photos the solve accepted. GPS and altitude: all 12."
		/>
	);
}

function Deep({ accent }: { accent: string }) {
	const [id, setId] = useNotebookPhoto();
	return (
		<>
			<Callout tone="note" title="Two different compass widths">
				The figures below assume a compass width of 7.1° (5° noise plus 5°
				bias). The app&rsquo;s own solve is looser: it allows 15° and searches
				±25°. Six of the ten accepted photos miss by more than 7.1°. Pitch is
				searched only within ±3° of gravity, so &ldquo;gravity is tight&rdquo;
				is partly that window. Lens distortion is not modelled.
			</Callout>

			<Section kicker="Mechanism" title="How it works">
				<Steps
					steps={[
						{
							title: "Read the tags",
							body: "Tags are read as written. The Apple gravity vector is parsed by hand from the MakerNote.",
						},
						{
							title: "Gravity to pitch and roll",
							body: "orientationFromGravity normalises the vector in the CoreMotion frame, picks the holding (landscape-left/right, portrait, portrait-upside) whose image-down best matches it, then derives pitch and roll.",
						},
						{
							title: "Focal to field of view",
							body: "The 35 mm-equivalent focal, defined on the frame diagonal, gives the field of view. A missing focal falls back to 26 mm.",
						},
						{
							title: "Time and position",
							body: "Capture time prefers GPS date and time (UTC), then the camera clock with its offset. A clock without a zone gets round(lon / 15) hours and is flagged as estimated.",
						},
						{
							title: "Assemble",
							body: "The record is built. A missing tag never fails: it becomes a placeholder plus a flag (Fig. D1).",
						},
					]}
				/>
				<p>
					Each sensor gets its own width: GPS accuracy clamped to 5 to 100 m
					(default 20), gravity 1.5°, and a compass built from 5° noise plus 5°
					bias with heavy tails, so one wild reading cannot drag the yaw. A
					magnetic heading is first corrected to true north. Altitude is a
					separate hint (±3 m) unless the position was pinned by hand.
				</p>
			</Section>
			<LensEquation />

			<Figure
				label="Fig. D1"
				caption="Drop tags from the file and watch which flags rise. A flag means 'placeholder, not measurement'."
			>
				<Survival accent={accent} />
			</Figure>

			<PriorErrors sel={id} onPick={setId} />
			<p className={`${TYPE.caption} gb-secondary`}>
				Six photos sit beyond the assumed 7.1° and the worst, photo 10, is{" "}
				<HandMark type="double">19.0° off (2.7σ)</HandMark>, hence the heavy
				tails. Three photos exceed 1.5° in pitch (−2.7° photo 11, +2.6° photo
				02, −2.2° photo 12).
			</p>

			<PriorLab accent={accent} />

			<FieldsTable />

			<Section kicker="Role" title="Why it matters in Rigi">
				<p>
					Every solve starts here. Priors make the search finite: without a
					compass, yaw is a full circle; without GPS the camera could be
					anywhere. The record&rsquo;s flags tell the{" "}
					<A id="viewport-inference">solve</A> what to search over. A solved
					pose is deliberately not part of the photo; it lives in the{" "}
					<A id="pose-estimate">pose estimate</A>.
				</p>
				<p>
					An upload produces the same shape as ingest, so a user photo and a
					bundled one take identical code paths, and the{" "}
					<A id="camera-roll">camera roll</A> clusters photos by position and
					time.
				</p>
			</Section>

			<Section kicker="Hazards" title="Pitfalls">
				<ul>
					<li>
						<strong>A missing value is not zero.</strong> Without gravity, pitch
						and roll are 0 placeholders; without a compass or lens the value is
						a placeholder too. Each carries a flag, so the solver searches
						instead of trusting it.
					</li>
					<li>
						<strong>A pinned position has no altitude.</strong> Altitude and GPS
						error are empty, so the engine uses the map&rsquo;s ground instead
						of a made-up height.
					</li>
					<li>
						<strong>Magnetic versus true.</strong> iPhones store true north;
						others store magnetic. Declination is applied where the heading is{" "}
						<em>used</em>, never where it is stored.
					</li>
				</ul>
			</Section>

			<Section kicker="In the code" title="Where to look">
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/upload/exif.ts">
						exif.ts#buildPhotoMeta
					</CodeRef>
					<CodeRef path="src/lib/upload/exif.ts">
						exif.ts#orientationFromGravity
					</CodeRef>
					<CodeRef path="src/lib/upload/exif.ts">exif.ts#vfovFromF35</CodeRef>
					<CodeRef path="src/lib/upload/exif.ts">exif.ts#captureTime</CodeRef>
					<CodeRef path="src/lib/geocam/priors/heading.ts" />
					<CodeRef path="src/lib/geocam/map/factors.ts" />
					<CodeRef path="src/lib/concord/priors/altitude.ts" />
				</div>
			</Section>
		</>
	);
}

export default function Page({ node }: { node: GipfelbuchNode }) {
	const accent = groupColor(node.group);
	return (
		<>
			<HeroMarks />

			<Beat
				kicker="The idea"
				title="A photo is an image plus the phone's sensor readings."
			>
				<p>
					The phone writes down where it was and how it was held. Those readings
					make a rough first guess of the camera: the{" "}
					<strong>camera prior</strong>.{" "}
					<HandMark type="highlight">
						That is a useful first estimate, not the answer.
					</HandMark>
					<MarginNote mark="a">Six values, none from the pixels.</MarginNote>
				</p>
				<p>
					Only the <HandMark type="underline">pixels</HandMark> show which way
					the camera actually pointed.
				</p>
			</Beat>

			<HeroCompare />

			<YawShift />

			<Beat
				kicker="How it works"
				title="Each sensor gives one estimate with an uncertainty width."
			>
				<PriorTrio />
				<p>
					<HandMark type="underline">Gravity</HandMark> fixes pitch and roll,
					and focal fixes the field of view.
					<MarginNote mark="b">That leaves yaw to be found.</MarginNote>
				</p>
			</Beat>

			<Beat
				kicker="Where it fails"
				title="The compass is off, and any tag can be wrong."
			>
				<p>
					<HandMark type="highlight">
						Yaw (the direction the camera points) is the least accurate part.
					</HandMark>{" "}
					The worst photo is marked <CircledNumber value={1} /> in Fig. 3.
					<MarginNote mark="c">
						Why is one phone 19° off while another is within 2°?
					</MarginNote>
				</p>
			</Beat>

			<YawBars />

			<Beat kicker="Where it fails" title="No single tag decides the result.">
				<p>
					Photo 09 says it was{" "}
					<HandMark type="wavy">730 m below the ground</HandMark>. We take the
					higher of the GPS height and the ground plus 1.6 m.
					<MarginNote mark="d">
						730 m below the ground is impossible, so the tag is wrong, not the
						map.
					</MarginNote>
				</p>
				<p>
					If a tag is missing, we{" "}
					<HandMark type="double">search for that value instead</HandMark>.
				</p>
			</Beat>

			<AltitudeCheck />

			<Beat
				kicker="Where it fails"
				title="A prior is a starting point, not evidence."
			>
				<p>
					We tried{" "}
					<HandMark type="strike">
						trusting the phone&rsquo;s altitude more
					</HandMark>
					<MarginNote mark="e">
						Altitude hints act as vetoes, not as pulls toward a value.
					</MarginNote>
					. On held-out photos the skyline gap got worse:{" "}
					<HandMark type="double">median 12.0 to 13.4 px</HandMark>. So the
					prior only seeds the search.
				</p>
			</Beat>

			<PhotoNumbers />

			<Details>
				<Deep accent={accent} />
			</Details>
		</>
	);
}
