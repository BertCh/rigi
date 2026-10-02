// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { NorthArrow } from "#/components/gipfelbuch/notebook/carto";
import {
	Hachure,
	HandDot,
	HandText,
	PenArrow,
	PenLine,
	SketchPath,
} from "#/components/gipfelbuch/notebook/Ink";
import { HandMark } from "#/components/gipfelbuch/notebook/marks";
import { useNotebookPhoto } from "#/components/gipfelbuch/notebook/useNotebookPhoto";
import {
	Callout,
	CodeRef,
	Figure,
	GIPFELBUCH_PHOTO_IDS,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	HandLabel,
	LAYER_STYLE,
	LiveCompare,
	MarginNote,
	Measured,
	PhotoPicker,
	RealPhoto,
	Section,
	Steps,
	useGipfelbuchPhoto,
	useReducedMotion,
	useTime,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Details,
	Gallery,
	Mark,
	MarkList,
	Numbers,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { Eq, Frac, Sym } from "#/components/gipfelbuch/viz/math";
import { groupColor } from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

/* The real record of a demo photo: public/demo/manifest.json (what the ingest wrote) plus the gipfelbuch data
 * (public/demo/gipfelbuch/<id>.json, scripts/gipfelbuch/build-data.ts) for the derived prior. */
type Rec = {
	w: number;
	h: number;
	lat: number;
	lon: number;
	alt: number;
	hAcc: number;
	heading: number;
	f35: number;
	vfov: number;
	pitch: number;
	roll: number;
	holding: string;
	gravity: number[];
	takenAt: string;
	tz: string;
	src: string;
};
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
const recOf = (m: ManifestPhoto): Rec => ({
	w: m.width,
	h: m.height,
	lat: m.lat,
	lon: m.lon,
	alt: m.alt,
	hAcc: m.hAccuracy,
	heading: m.heading,
	f35: m.f35,
	vfov: m.vfov,
	pitch: m.pitch,
	roll: m.roll,
	holding: m.holding,
	gravity: m.gravity,
	takenAt: m.takenAtUtc.replace(/\.\d+Z$/, "Z"),
	tz: m.tzOffset,
	src: m.src,
});
function useManifest() {
	const [m, setM] = useState<Record<string, ManifestPhoto> | null>(null);
	useEffect(() => {
		let live = true;
		fetch("/demo/manifest.json")
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

type Layer = {
	key: string;
	name: string;
	blurb: string;
	rows: [string, string][];
};
const layersFor = (P: Rec, HFOV: number): Layer[] => [
	{
		key: "pixels",
		name: "Pixels",
		blurb: "Upright JPEG, long side at most 2048 px.",
		rows: [
			["width x height", `${P.w} x ${P.h}`],
			["src", P.src],
			["holding", P.holding],
		],
	},
	{
		key: "exif",
		name: "Device tags",
		blurb: "What the phone wrote: GPS, compass, gravity, lens, clock.",
		rows: [
			["GPS", `${P.lat.toFixed(4)}, ${P.lon.toFixed(4)}`],
			["GPSAltitude", `${P.alt.toFixed(0)} m`],
			["GPSHPositioningError", `${P.hAcc.toFixed(0)} m`],
			["GPSImgDirection", `${P.heading.toFixed(1)} deg (ref T)`],
			[
				"MakerNote gravity",
				`[${P.gravity.map((g) => g.toFixed(3)).join(", ")}]`,
			],
			["FocalLengthIn35mm", `${P.f35} mm`],
			["GPS date+time", `${P.takenAt} (${P.tz})`],
		],
	},
	{
		key: "prior",
		name: "Derived prior",
		blurb: "Tags become pitch, roll and a field of view.",
		rows: [
			["pitch", `${P.pitch.toFixed(2)} deg`],
			["roll", `${P.roll.toFixed(2)} deg`],
			["vfov", `${P.vfov.toFixed(2)} deg`],
			["hfov", `${HFOV.toFixed(1)} deg (from aspect)`],
			["yaw", `${P.heading.toFixed(1)} deg, true north`],
		],
	},
	{
		key: "region",
		name: "Position + region",
		blurb:
			"A lat/lon with an error disc, and a ~20 km region of mapped features around it.",
		rows: [
			["lat, lon", `${P.lat.toFixed(4)}, ${P.lon.toFixed(4)}`],
			["hAccuracy", `${P.hAcc.toFixed(0)} m`],
		],
	},
];

const EXIF_TAGS = [
	"GPS lat/lon",
	"GPSAltitude",
	"GPSImgDirection",
	"MakerNote gravity",
	"FocalLengthIn35mm",
	"GPSDateStamp",
];

function Anatomy({
	accent,
	P,
	HFOV,
	id,
}: {
	accent: string;
	P: Rec;
	HFOV: number;
	id: string;
}) {
	const LAYERS = layersFor(P, HFOV);
	const reduced = useReducedMotion();
	const [ref, t] = useTime<HTMLDivElement>(9.6);
	const [picked, setPicked] = useState<number | null>(null);
	// plays the four layers once, then rests on the last
	// + 1e-6: 9.6 / 3.2 is 2.9999999999999996 in floats, and the still frame must reach the last layer
	const auto = reduced ? 3 : Math.min(Math.floor(t / 3.2 + 1e-6), 3);
	const i = picked ?? auto;
	const L = LAYERS[i];
	const W = 400;
	const H = Math.round((W * P.h) / P.w);
	const f = H / 2 / Math.tan((P.vfov * Math.PI) / 360);
	const horizonY = H / 2 - f * Math.tan((-P.pitch * Math.PI) / 180);
	const on = (n: number) => (i >= n ? 1 : 0);
	const mapMode = i === 3;
	const cx = 200;
	const cy = H * 0.58;
	const wedge = (deg: number, r: number, half: number) => {
		const a = (d: number) => [
			cx + r * Math.sin((d * Math.PI) / 180),
			cy - r * Math.cos((d * Math.PI) / 180),
		];
		const [x1, y1] = a(deg - half);
		const [x2, y2] = a(deg + half);
		return `M${cx},${cy} L${x1},${y1} A${r},${r} 0 0 1 ${x2},${y2} Z`;
	};
	const tr = "opacity 700ms ease, filter 700ms ease";
	return (
		<div ref={ref} className="grid gap-5 lg:grid-cols-[1.25fr_1fr]">
			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="h-auto w-full"
				role="img"
				aria-label={`Photo anatomy, layer ${L.name}`}
			>
				<image
					href={`/demo/thumbs/${id}.jpg`}
					width={W}
					height={H}
					preserveAspectRatio="xMidYMid slice"
					style={{
						transition: tr,
						opacity: mapMode ? 0.12 : 1,
					}}
				/>
				{/* exif tags, written on the photo */}
				<g style={{ transition: tr, opacity: i === 1 ? 1 : 0 }}>
					{EXIF_TAGS.map((s, k) => {
						const x = 24 + (k % 2) * 180;
						const y = H * 0.13 + Math.floor(k / 2) * H * 0.23;
						return (
							<g key={s}>
								<rect
									x={x - 6}
									y={y - 2}
									width={162}
									height={34}
									fill="var(--gb-paper)"
									opacity={0.7}
								/>
								<PenLine
									seed={`ph-exif-${s}`}
									from={[x, y + 26]}
									to={[x + 150, y + 26]}
									color="ink"
									width={1.2}
								/>
								<HandLabel x={x + 2} y={y + 20} size={10} color="var(--gb-ink)">
									{s}
								</HandLabel>
							</g>
						);
					})}
				</g>
				<g style={{ transition: tr, opacity: i === 1 ? 1 : 0 }}>
					<HandText
						x={W - 14}
						y={H - 16}
						size={16}
						anchor="end"
						color="red"
						rotate={-2}
					>
						no solved pose yet, only what it wrote
					</HandText>
				</g>
				{/* derived prior: horizon, centre cross, fov brackets */}
				<g style={{ transition: tr, opacity: i === 2 ? 1 : 0 }}>
					<g transform={`rotate(${-P.roll} ${W / 2} ${H / 2})`}>
						<SketchPath
							d={`M-40 ${horizonY}H${W + 40}`}
							seed={`ph-prior-horizon-${id}`}
							data
							color={LAYER_STYLE.prior.color}
							width={2.2}
							dash="6 5"
						/>
						<HandLabel x={10} y={horizonY - 6} color={LAYER_STYLE.prior.color}>
							prior horizon
						</HandLabel>
					</g>
					<PenLine
						seed="ph-cross-h"
						from={[W / 2 - 8, H / 2]}
						to={[W / 2 + 8, H / 2]}
						width={1.4}
					/>
					<PenLine
						seed="ph-cross-v"
						from={[W / 2, H / 2 - 8]}
						to={[W / 2, H / 2 + 8]}
						width={1.4}
					/>
					<PenLine
						seed="ph-fov-v"
						from={[W - 14, 14]}
						to={[W - 14, H - 14]}
						width={1.3}
					/>
					<PenLine
						seed="ph-fov-t"
						from={[W - 19, 14]}
						to={[W - 9, 14]}
						width={1.3}
					/>
					<PenLine
						seed="ph-fov-b"
						from={[W - 19, H - 14]}
						to={[W - 9, H - 14]}
						width={1.3}
					/>
					<PenLine
						seed="ph-fov-h"
						from={[14, H - 14]}
						to={[W - 14, H - 14]}
						width={1.3}
					/>
					<HandText x={20} y={H * 0.3} size={16} color="pencil" rotate={-2}>
						gravity set this line: does it level?
					</HandText>
					<PenArrow
						seed="ph-note-horizon"
						from={[60, H * 0.3 + 6]}
						to={[70, horizonY - 12]}
						color="pencil"
						width={1.1}
					/>
					<HandLabel x={W - 22} y={H / 2} anchor="end" color="var(--gb-ink)">
						vfov {P.vfov.toFixed(1)}°
					</HandLabel>
					<HandLabel x={W / 2} y={H - 22} anchor="middle" color="var(--gb-ink)">
						hfov {HFOV.toFixed(1)}°
					</HandLabel>
				</g>
				{/* region map: the photo fades to paper and the view cone is hatched */}
				<g style={{ transition: tr, opacity: on(3) && mapMode ? 1 : 0 }}>
					<SketchPath
						d={`M40 26H360V${H - 26}H40Z`}
						seed={`ph-region-${id}`}
						color="pencil"
						width={1}
						dash="3 5"
						passes={1}
					/>
					<HandText x={48} y={H - 34} size={14} color="pencil">
						region ~20 km (not to scale)
					</HandText>
					{[40, 80, 120].map((r) => (
						<SketchPath
							key={r}
							d={`M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`}
							seed={`ph-range-${r}`}
							color="faint"
							width={0.7}
							passes={1}
						/>
					))}
					<Hachure
						d={wedge(P.heading, 120, HFOV / 2)}
						seed={`ph-wedge-${id}`}
						color="blue"
						gap={5}
						opacity={0.7}
					/>
					<SketchPath
						d={wedge(P.heading, 120, HFOV / 2)}
						seed={`ph-wedge-edge-${id}`}
						color="blue"
						width={1.4}
					/>
					<HandDot x={cx} y={cy} r={4.5} seed={`ph-camera-${id}`} color="ink" />
					<HandLabel x={cx + 12} y={cy + 5} color="var(--gb-ink)">
						photo, ±{P.hAcc.toFixed(0)} m
					</HandLabel>
					<HandLabel x={352} y={H - 38} anchor="end" color="var(--gb-water)">
						yaw {P.heading.toFixed(0)}° · hfov {HFOV.toFixed(0)}°
					</HandLabel>
					<NorthArrow x={340} y={96} length={30} seed="ph-north" color="ink" />
					<HandText x={cx + 8} y={cy - 130} size={15} color="red">
						heading is a prior, not the truth
					</HandText>
				</g>
			</svg>

			<div className="flex flex-col gap-3">
				<div className="flex flex-wrap gap-1.5" role="tablist">
					{LAYERS.map((l, k) => (
						<button
							key={l.key}
							type="button"
							role="tab"
							aria-selected={i === k}
							onClick={() => setPicked(k)}
							className="px-3 py-1 font-mono text-[11px] transition"
							style={{
								background: i === k ? accent : "var(--gb-paper-deep)",
								color:
									i === k
										? "var(--rigi-ink)"
										: "color-mix(in oklab, var(--gb-ink) 70%, transparent)",
							}}
						>
							{k + 1} · {l.name}
						</button>
					))}
				</div>
				<p className="text-[13px] leading-snug gb-secondary">{L.blurb}</p>
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 font-mono text-[11px]">
					{L.rows.map(([k, v]) => (
						<div key={k} className="contents">
							<dt className="gb-secondary">{k}</dt>
							<dd className="break-words gb-ink">{v}</dd>
						</div>
					))}
				</dl>
				{picked != null && (
					<button
						type="button"
						onClick={() => setPicked(null)}
						className="self-start font-mono text-[11px] gb-secondary underline underline-offset-4"
					>
						resume auto-cycle
					</button>
				)}
			</div>
		</div>
	);
}

function RealRecord({ accent }: { accent: string }) {
	const [id, setId] = useNotebookPhoto();
	const m = useManifest();
	const d = useGipfelbuchPhoto(id);
	const rec = m?.[id];
	return (
		<Figure
			label="Fig. D1"
			caption={
				<>
					<Measured data={d} /> The record as the phone wrote it; the horizon
					and field of view in tab 3 are recomputed. Click a tab to hold a
					layer, or a thumbnail (badge: 35 mm focal) to switch photo.
				</>
			}
		>
			<PhotoPicker
				value={id}
				onChange={setId}
				mark={(i) => (
					<span className="bg-[var(--gb-paper)] px-1 font-mono text-[11px] gb-ink">
						{m?.[i]?.f35 ?? ""}mm
					</span>
				)}
			/>
			{rec && d ? (
				<Anatomy
					key={id}
					accent={accent}
					P={recOf(rec)}
					HFOV={d.prior.hfov}
					id={id}
				/>
			) : (
				<div className="aspect-[4/3] w-full animate-pulse bg-[var(--gb-paper-deep)]" />
			)}
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
			label="Fig. 3"
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

const A = ({ id, children }: { id: string; children: string }) => (
	<Link to="/gipfelbuch/$concept" params={{ concept: id }}>
		{children}
	</Link>
);

function Deep({ accent }: { accent: string }) {
	return (
		<>
			<Section kicker="Anatomy" title="One file, four layers">
				<p>
					What one photo carries. Nothing is solved yet: only what the phone
					recorded and what can be derived from it. All twelve Niederhorn photos
					are full phone records (GPS, true-north heading, Apple gravity vector,
					35 mm focal), so none raises an unknown flag.
				</p>
			</Section>
			<RealRecord accent={accent} />

			<Section kicker="Definition" title="What it is">
				<p>
					A Photo is an image plus size, capture time, position, heading,
					gravity and lens. It may be bundled, uploaded (local), demo or
					benchmark: the shape is the same. It optionally has one{" "}
					<A id="camera-prior">camera prior</A> and belongs to a{" "}
					<A id="region">region</A>. A solved pose is deliberately not part of
					it: the photo is what the photographer brought.
				</p>
			</Section>

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
							body: "The record is built. A missing tag never fails: it becomes a placeholder plus a flag, shown next.",
						},
					]}
				/>
			</Section>

			<Figure
				label="Fig. D2"
				caption="Drop tags from the file and watch which flags rise. A flag means 'placeholder, not measurement'."
			>
				<Survival accent={accent} />
			</Figure>

			<Section kicker="Role" title="Why it matters in Rigi">
				<p>
					Every pipeline starts here. The record seeds the{" "}
					<A id="exif-prior">EXIF pose prior</A>, and its flags tell the{" "}
					<A id="prior-unknowns">solver</A> what to search over.{" "}
					<A id="photo-upload">Upload</A> produces the same shape as ingest, so
					a user photo and a bundled one take identical code paths, and the{" "}
					<A id="camera-roll">camera roll</A> clusters photos by position and
					time.
				</p>
				<p>
					Gravity pins pitch and roll and the focal pins the field of view, so
					only the heading stays badly uncertain on a typical iPhone photo. That
					is why the compass is the first thing the solver distrusts.
				</p>
			</Section>

			<Section kicker="Hazards" title="Pitfalls">
				<ul>
					<li>
						<strong>Zeros are not measurements.</strong> Without gravity, pitch
						and roll are 0 placeholders and carry a flag.
					</li>
					<li>
						<strong>A pinned position has no altitude.</strong> Altitude and GPS
						error are empty, so the engine uses the map&rsquo;s ground instead
						of a made-up height.
					</li>
					<li>
						<strong>Heading may be magnetic.</strong> The tag says true or
						magnetic north; iPhones write true.
					</li>
				</ul>
				<Callout tone="warning" title="Compass is a prior, not truth">
					Heading was up to 19° off on the demo photos. See the{" "}
					<A id="exif-prior">EXIF prior</A> page.
				</Callout>
			</Section>

			<div className="!mt-8 flex flex-wrap gap-2">
				<CodeRef path="src/lib/photos.ts">lib/photos.ts#PhotoMeta</CodeRef>
				<CodeRef path="src/lib/upload/exif.ts">exif.ts#buildPhotoMeta</CodeRef>
				<CodeRef path="src/lib/upload/exif.ts">
					exif.ts#orientationFromGravity
				</CodeRef>
				<CodeRef path="src/lib/upload/exif.ts">exif.ts#vfovFromF35</CodeRef>
				<CodeRef path="src/lib/upload/exif.ts">exif.ts#captureTime</CodeRef>
				<CodeRef path="reports/ontology.md" />
			</div>
		</>
	);
}

// ======================================================================================
// Explainer front: marks on one real photo, then the small-multiples check on GPS altitude.
// ======================================================================================
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
const signed = (v: number, n = 1) =>
	`${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(v).toFixed(n)}`;

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
						? `One photo, six facts the phone wrote down before we looked at a single pixel (GPS accuracy ±${d.gps.hAccuracy.toFixed(0)} m).`
						: "One photo, six facts the phone wrote down."}{" "}
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

// The mini schematics (viewBox 160) render about 230 px wide in the three-up row: 13 px ≈ 9 units.
const MINI_LABEL = (13 * 160) / 230;

/** Three tiny schematics, drawn from the real values of demo-01. */
function TagsMini({ d }: { d: GipfelbuchPhotoData | null }) {
	const rows: [string, string][] = d
		? [
				["GPS", `${d.gps.lat.toFixed(3)}, ${d.gps.lon.toFixed(3)}`],
				["alt", `${d.gps.alt.toFixed(0)} m`],
				["heading", `${d.sensor.heading.toFixed(1)}°`],
				["focal", `${d.sensor.f35} mm`],
			]
		: [];
	return (
		<div className="flex aspect-[4/3] flex-col justify-center gap-1.5 px-4 font-mono text-[11px]">
			{rows.map(([k, v]) => (
				<div
					key={k}
					className="flex justify-between bg-[var(--gb-paper-deep)] px-2 py-1"
				>
					<span className="gb-secondary">{k}</span>
					<span className="gb-ink">{v}</span>
				</div>
			))}
		</div>
	);
}
function TiltMini({ d }: { d: GipfelbuchPhotoData | null }) {
	if (!d) return <div className="aspect-[4/3]" />;
	const { pitch, roll } = d.sensor;
	// photo pitch is negative when the camera looks down: the horizon rises in the frame
	const y = 60 + pitch * 2.2;
	return (
		<svg
			viewBox="0 0 160 120"
			className="block h-auto w-full"
			role="img"
			aria-label="Tilt from gravity"
		>
			<SketchPath
				d="M20 15H140V105H20Z"
				seed="ph-tilt-frame"
				color="pencil"
				width={1.1}
				opacity={0.6}
			/>
			<g transform={`rotate(${-roll} 80 60)`}>
				<SketchPath
					d={`M0 ${y}H160`}
					seed="ph-tilt-horizon"
					data
					color="blue"
					width={2}
					dash="5 3"
				/>
			</g>
			<HandText x={96} y={36} size={13} color="pencil" rotate={-3}>
				horizon slopes with roll
			</HandText>
			<HandLabel
				x={80}
				y={116}
				anchor="middle"
				size={MINI_LABEL}
				color="var(--gb-secondary)"
			>
				pitch {signed(pitch)}° · roll {signed(roll)}°
			</HandLabel>
		</svg>
	);
}
function LensMini({ d }: { d: GipfelbuchPhotoData | null }) {
	if (!d) return <div className="aspect-[4/3]" />;
	const h = (d.prior.hfov / 2) * (Math.PI / 180);
	const r = 80;
	const wedge = `M80 108 L${80 - r * Math.sin(h)} ${108 - r * Math.cos(h)} A${r} ${r} 0 0 1 ${80 + r * Math.sin(h)} ${108 - r * Math.cos(h)} Z`;
	return (
		<svg
			viewBox="0 0 160 120"
			className="block h-auto w-full"
			role="img"
			aria-label="Field of view from focal length"
		>
			<Hachure d={wedge} seed="ph-lens-fill" color="blue" gap={5} />
			<SketchPath d={wedge} seed="ph-lens-edge" color="blue" width={1.4} />
			<HandDot x={80} y={108} r={3.4} seed="ph-lens-eye" />
			<HandLabel
				x={80}
				y={64}
				anchor="middle"
				size={MINI_LABEL}
				color="var(--gb-ink)"
			>
				{d.prior.hfov.toFixed(0)}° wide
			</HandLabel>
		</svg>
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
							{signed(diff, 0)} m{" · ±"}
							{d.gps.hAccuracy.toFixed(0)} m fix
						</span>
					);
				}}
			/>
			<p className="mt-3 font-mono text-[11px] gb-secondary">
				Ground = Terrarium height map. The full record table follows.
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

function PhotoNumbers() {
	const m = useManifest();
	const d9 = useGipfelbuchPhoto("demo-09");
	const acc = m ? Object.values(m).map((p) => p.hAccuracy) : [];
	const full = m
		? Object.values(m).filter(
				(p) =>
					p.gravity?.length === 3 &&
					p.heading != null &&
					p.f35 > 0 &&
					p.lat != null,
			).length
		: null;
	return (
		<Numbers
			items={[
				{
					value:
						full == null ? "…" : `${full} / ${m ? Object.keys(m).length : 12}`,
					label: "demo photos carry GPS, compass, gravity and lens",
				},
				{
					value: acc.length
						? `${Math.min(...acc).toFixed(0)}–${Math.max(...acc).toFixed(0)} m`
						: "…",
					label: "GPS accuracy the phone reports across the 12 photos",
				},
				{
					value: d9 ? `${signed(d9.gps.alt - d9.gps.ground, 0)} m` : "…",
					label: "worst altitude error against the map (photo 09)",
				},
				{
					value: "1.6 m",
					label: "minimum eye height we assume above the ground",
				},
			]}
			source="Measured on the 12 Niederhorn demo photos."
		/>
	);
}

export default function Page({ node }: { node: GipfelbuchNode }) {
	const accent = groupColor(node.group);
	const [photoId] = useNotebookPhoto();
	const d1 = useGipfelbuchPhoto(photoId);
	return (
		<>
			<HeroMarks />

			<Beat
				kicker="The idea"
				title="A photo is pixels plus what the phone knew."
			>
				<p>
					The phone writes down where it was and how it was held.{" "}
					<HandMark type="highlight">
						That is a good first guess, not an answer.
					</HandMark>
					<MarginNote mark="a">
						I notice six facts, and none came from the pixels.
					</MarginNote>
				</p>
				<p>
					Only the <HandMark type="underline">pixels</HandMark> can say which
					way the camera really pointed.
				</p>
			</Beat>

			<LiveCompare
				photoId="demo-09"
				number="Fig. 2"
				title="What the pixels add"
			/>

			<Beat
				kicker="How it works"
				title="We read the tags and turn them into a camera."
			>
				<Trio
					steps={[
						{
							title: "Read the tags",
							body: "Position, height, heading and lens come straight from the file.",
							visual: <TagsMini d={d1} />,
						},
						{
							title: "Gravity gives tilt",
							body: "The phone knows down, so we know the horizon's slope.",
							visual: <TiltMini d={d1} />,
						},
						{
							title: "Focal gives width",
							body: "A lens number says how wide a slice of the world we see.",
							visual: <LensMini d={d1} />,
						},
					]}
				/>
				<LensEquation />
				<p>
					<HandMark type="underline">Gravity</HandMark> fixes pitch and roll,
					and focal fixes the field of view.
					<MarginNote mark="d">
						So yaw is the one that is left to find.
					</MarginNote>
				</p>
			</Beat>

			<Beat
				kicker="Where it fails"
				title="A tag can lie, so one tag never decides alone."
			>
				<p>
					Photo 09 says it was{" "}
					<HandMark type="wavy">730 m below the ground</HandMark>. We take the
					higher of the GPS height and the ground plus 1.6 m.
					<MarginNote mark="b">
						730 m under the rock? Then the tag is wrong, not the map.
					</MarginNote>
				</p>
				<p>
					If a tag is missing, we{" "}
					<HandMark type="double">search for that value instead</HandMark>.
					<MarginNote mark="c">Missing is fine; made up is not.</MarginNote>
				</p>
			</Beat>

			<AltitudeCheck />

			<FieldsTable />

			<PhotoNumbers />

			<Details>
				<Deep accent={accent} />
			</Details>
		</>
	);
}
