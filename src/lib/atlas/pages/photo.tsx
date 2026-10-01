import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	ATLAS_PHOTO_IDS,
	type AtlasPhotoData,
	type AtlasPhotoId,
	Callout,
	CodeRef,
	Figure,
	Measured,
	PhotoPicker,
	RealPhoto,
	Section,
	Steps,
	useAtlasPhoto,
	useReducedMotion,
	useTime,
} from "#/components/atlas/viz";
import {
	Beat,
	Details,
	Gallery,
	Mark,
	MarkList,
	Numbers,
	Trio,
} from "#/components/atlas/viz/explain";
import { groupColor } from "#/lib/atlas/graph-utils";
import type { AtlasNode } from "#/lib/atlas/types";

/* The real record of a demo photo: public/demo/manifest.json (what the ingest wrote) plus the atlas data
 * (public/demo/atlas/<id>.json, scripts/atlas/build-data.ts) for the derived prior. */
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
		blurb: "Upright JPEG, long side capped at MAX_PX = 2048.",
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
		blurb: "Pure functions turn tags into pitch, roll and a field of view.",
		rows: [
			["pitch", `${P.pitch.toFixed(2)} deg (orientationFromGravity)`],
			["roll", `${P.roll.toFixed(2)} deg`],
			["vfov", `${P.vfov.toFixed(2)} deg (vfovFromF35)`],
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
			["region", "demo-region"],
			["peaks, trails, water", "RegionData for that area"],
		],
	},
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
	const [ref, t] = useTime<HTMLDivElement>();
	const [picked, setPicked] = useState<number | null>(null);
	const auto = reduced ? 2 : Math.floor(t / 3.2) % 4;
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
		<div ref={ref} className="grid gap-5 md:grid-cols-[1.25fr_1fr]">
			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="h-auto w-full rounded-xl bg-black/40 ring-1 ring-white/10"
				role="img"
				aria-label={`Photo anatomy, layer ${L.name}`}
			>
				<defs>
					<clipPath id="ph-clip">
						<rect width={W} height={H} rx="10" />
					</clipPath>
				</defs>
				<g clipPath="url(#ph-clip)">
					<image
						href={`/demo/thumbs/${id}.jpg`}
						width={W}
						height={H}
						preserveAspectRatio="xMidYMid slice"
						style={{
							transition: tr,
							opacity: mapMode ? 0.12 : 1,
							filter: i === 1 ? "saturate(0.5) brightness(0.55)" : "none",
						}}
					/>
					{/* exif tag chips */}
					<g
						style={{ transition: tr, opacity: i === 1 ? 1 : 0 }}
						fontFamily="ui-monospace,monospace"
						fontSize="9.5"
					>
						{[
							"GPS lat/lon",
							"GPSAltitude",
							"GPSImgDirection",
							"MakerNote gravity",
							"FocalLengthIn35mm",
							"GPSDateStamp",
						].map((s, k) => (
							<g
								key={s}
								transform={`translate(${24 + (k % 2) * 180},${H * 0.13 + Math.floor(k / 2) * H * 0.23})`}
							>
								<rect
									width="160"
									height="34"
									rx="6"
									fill="rgba(255,255,255,.07)"
									stroke={accent}
									strokeOpacity=".5"
								/>
								<text x="10" y="21" fill="#ece6da">
									{s}
								</text>
							</g>
						))}
					</g>
					{/* derived prior: horizon, centre cross, fov brackets */}
					<g style={{ transition: tr, opacity: i === 2 ? 1 : 0 }}>
						<g transform={`rotate(${-P.roll} ${W / 2} ${H / 2})`}>
							<line
								x1={-40}
								x2={W + 40}
								y1={horizonY}
								y2={horizonY}
								stroke={accent}
								strokeWidth="1.6"
								strokeDasharray="6 4"
							/>
							<text
								x="10"
								y={horizonY - 6}
								fill={accent}
								fontSize="10"
								fontFamily="ui-monospace,monospace"
							>
								prior horizon
							</text>
						</g>
						<path
							d={`M${W / 2 - 8},${H / 2} h16 M${W / 2},${H / 2 - 8} v16`}
							stroke="#fff"
							strokeOpacity=".7"
						/>
						<g stroke="#ece6da" strokeWidth="1.2" fill="none">
							<path d={`M${W - 14},14 v${H - 28}`} />
							<path d={`M${W - 19},14 h10 M${W - 19},${H - 14} h10`} />
							<path d={`M14,${H - 14} h${W - 28}`} />
						</g>
						<g fontSize="10" fontFamily="ui-monospace,monospace" fill="#ece6da">
							<text x={W - 20} y={H / 2} textAnchor="end">
								vfov {P.vfov.toFixed(1)}°
							</text>
							<text x={W / 2} y={H - 20} textAnchor="middle">
								hfov {HFOV.toFixed(1)}°
							</text>
						</g>
					</g>
					{/* region map */}
					<g style={{ transition: tr, opacity: on(3) && mapMode ? 1 : 0 }}>
						<rect
							x="40"
							y="26"
							width="320"
							height={H - 52}
							rx="6"
							fill="none"
							stroke="#ffffff"
							strokeOpacity=".25"
							strokeDasharray="3 5"
						/>
						<text
							x="48"
							y="42"
							fill="#ece6da"
							fillOpacity=".55"
							fontSize="10"
							fontFamily="ui-monospace,monospace"
						>
							region ~20 km (not to scale)
						</text>
						{[40, 80, 120].map((r) => (
							<circle
								key={r}
								cx={cx}
								cy={cy}
								r={r}
								fill="none"
								stroke="#fff"
								strokeOpacity=".08"
							/>
						))}
						<path
							d={wedge(P.heading, 120, HFOV / 2)}
							fill={accent}
							fillOpacity=".25"
							stroke={accent}
						/>
						<circle cx={cx} cy={cy} r="9" fill={accent} fillOpacity=".25" />
						<circle cx={cx} cy={cy} r="3.5" fill="#fff" />
						<text
							x={cx + 14}
							y={cy + 4}
							fill="#ece6da"
							fontSize="10"
							fontFamily="ui-monospace,monospace"
						>
							photo, ±{P.hAcc.toFixed(0)} m
						</text>
						<text
							x="352"
							y={H - 38}
							textAnchor="end"
							fill={accent}
							fontSize="10"
							fontFamily="ui-monospace,monospace"
						>
							yaw {P.heading.toFixed(0)}° · hfov {HFOV.toFixed(0)}°
						</text>
						<text
							x="200"
							y="38"
							textAnchor="middle"
							fill="#ece6da"
							fontSize="10"
							fontWeight="600"
						>
							N
						</text>
					</g>
				</g>
				<rect
					width={W}
					height={H}
					rx="10"
					fill="none"
					stroke={accent}
					strokeOpacity={on(0) ? 0.35 : 0}
				/>
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
							className="rounded-full px-3 py-1 font-mono text-[11px] ring-1 transition"
							style={{
								background: i === k ? accent : "rgba(255,255,255,.04)",
								color: i === k ? "#0e1012" : "rgba(255,255,255,.7)",
								boxShadow: `inset 0 0 0 1px ${i === k ? accent : "rgba(255,255,255,.1)"}`,
							}}
						>
							{k + 1} · {l.name}
						</button>
					))}
				</div>
				<p className="text-[13.5px] leading-snug text-white/65">{L.blurb}</p>
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 font-mono text-[11.5px]">
					{L.rows.map(([k, v]) => (
						<div key={k} className="contents">
							<dt className="text-white/40">{k}</dt>
							<dd className="break-words text-white/80">{v}</dd>
						</div>
					))}
				</dl>
				{picked != null && (
					<button
						type="button"
						onClick={() => setPicked(null)}
						className="self-start font-mono text-[11px] text-white/45 underline underline-offset-4"
					>
						resume auto-cycle
					</button>
				)}
			</div>
		</div>
	);
}

function RealRecord({ accent }: { accent: string }) {
	const [id, setId] = useState<AtlasPhotoId>("demo-01");
	const m = useManifest();
	const d = useAtlasPhoto(id);
	const rec = m?.[id];
	return (
		<Figure
			label="Fig. 1"
			caption={
				<>
					<Measured data={d} /> Record fields are the ingest output in
					public/demo/manifest.json; the horizon and field of view in tab 3 are
					recomputed by the pure functions named in the Mechanism section.
					Auto-cycles; click a tab to hold a layer, or a thumbnail (badge = 35
					mm focal) to switch photo.
				</>
			}
		>
			<PhotoPicker
				value={id}
				onChange={setId}
				mark={(i) => (
					<span className="rounded bg-black/70 px-1 font-mono text-[9px] text-white/90">
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
				<div className="aspect-[4/3] w-full animate-pulse rounded-xl bg-white/[0.04]" />
			)}
		</Figure>
	);
}

function FieldRow({ id, m }: { id: AtlasPhotoId; m: ManifestPhoto }) {
	const d = useAtlasPhoto(id);
	const diff = d ? m.alt - d.gps.ground : null;
	const bad = diff != null && Math.abs(diff) > 200;
	return (
		<tr className="border-t border-white/8">
			<td className="py-1.5 pr-3 text-white/85">{id.slice(-2)}</td>
			<td className="pr-3">
				{m.holding === "portrait" ? "portrait" : "landscape"}
			</td>
			<td className="pr-3">
				{m.f35} mm → {m.vfov.toFixed(1)}°
			</td>
			<td className="pr-3">±{m.hAccuracy.toFixed(0)} m</td>
			<td className="pr-3">{m.alt.toFixed(0)}</td>
			<td className="pr-3">{d ? d.gps.ground.toFixed(0) : "…"}</td>
			<td
				className="pr-3"
				style={bad ? { color: "var(--accent)", fontWeight: 700 } : undefined}
			>
				{diff == null
					? "…"
					: `${diff > 0 ? "+" : "−"}${Math.abs(diff).toFixed(0)}`}
			</td>
			<td className="pr-3">{m.heading.toFixed(1)}°</td>
			<td>
				{m.pitch.toFixed(1)}° / {m.roll.toFixed(1)}°
			</td>
		</tr>
	);
}

function FieldsTable() {
	const m = useManifest();
	return (
		<Figure
			label="Fig. 2"
			caption={
				<>
					All 12 bundled photos, real record (public/demo/manifest.json) beside
					the DEM height at the fix (terrarium DEM, scripts/atlas/build-data.ts,
					2026-10-01). GPSAltitude sits 28 to 69 m above the DEM in eleven
					photos (a fix lands a few tens of metres off the summit track and the
					DEM is a 30 m model) and 730 m below it in demo-09, which is why the
					engine uses max(GPSAltitude, DEM + 1.6 m) as the eye rather than
					trusting the tag.
				</>
			}
		>
			<div className="overflow-x-auto">
				<table className="w-full min-w-[640px] border-collapse text-left font-mono text-[11px] text-white/60">
					<thead className="text-white/40">
						<tr>
							<th className="pb-1.5 pr-3 font-normal">photo</th>
							<th className="pr-3 font-normal">holding</th>
							<th className="pr-3 font-normal">f35 → vfov</th>
							<th className="pr-3 font-normal">hAccuracy</th>
							<th className="pr-3 font-normal">GPS alt m</th>
							<th className="pr-3 font-normal">DEM m</th>
							<th className="pr-3 font-normal">alt − DEM</th>
							<th className="pr-3 font-normal">heading</th>
							<th className="font-normal">pitch / roll</th>
						</tr>
					</thead>
					<tbody>
						{m
							? ATLAS_PHOTO_IDS.map((id) => (
									<FieldRow key={id} id={id} m={m[id]} />
								))
							: null}
					</tbody>
				</table>
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
		fix: "User pins position on the map; altitude and hAccuracy become null (DEM snaps the eye).",
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
		fix: "pitch/roll stay 0 placeholders; solver frees them (wide pitch search).",
	},
	{
		k: "focal",
		label: "35 mm focal",
		flag: "focalUnknown",
		off: "true",
		on: "false",
		fix: "f35 = DEFAULT_F35 (26, iPhone main camera); solver frees focal.",
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
						className="rounded-lg px-3 py-2 text-left font-mono text-[11.5px] transition"
						style={{
							background: have[t.k] ? `${accent}22` : "rgba(255,255,255,.03)",
							boxShadow: `inset 0 0 0 1px ${have[t.k] ? accent : "rgba(255,255,255,.12)"}`,
							color: have[t.k] ? "#ece6da" : "rgba(255,255,255,.4)",
							textDecoration: have[t.k] ? "none" : "line-through",
						}}
					>
						{t.label}
					</button>
				))}
			</div>
			<div className="mt-4 grid gap-1.5 font-mono text-[11.5px]">
				{TAGS.map((t) => (
					<div key={t.k} className="flex flex-wrap gap-x-3 text-white/60">
						<span className="text-white/40">local.{t.flag}</span>
						<span
							style={{ color: have[t.k] ? "rgba(255,255,255,.75)" : accent }}
						>
							{have[t.k] ? t.on : t.off}
						</span>
					</div>
				))}
			</div>
			<ul className="mt-4 list-none space-y-1.5 !pl-0 text-[13px] leading-snug text-white/65">
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
	<Link to="/atlas/$concept" params={{ concept: id }}>
		{children}
	</Link>
);

function Deep({ accent }: { accent: string }) {
	return (
		<>
			<Section kicker="Anatomy" title="One file, four layers">
				<p>
					Scrub through what a single bundled photo carries. Nothing here is
					solved yet: it is only what the device recorded and what pure
					functions can derive from it. All twelve Niederhorn photos are full
					phone records: every one has GPS, a true-north heading, the Apple
					gravity vector and a 35 mm focal, so none raises an unknown flag.
				</p>
			</Section>
			<RealRecord accent={accent} />
			<FieldsTable />

			<Section kicker="Definition" title="What it is">
				<p>
					A Photo is an image plus size, capture time, position, heading,
					gravity and lens. It may be bundled, uploaded (local), demo or
					benchmark: the shape is the same. It optionally has one{" "}
					<A id="camera-prior">camera prior</A> and belongs to a{" "}
					<A id="region">region</A>. A solved pose is deliberately not part of
					it: the photo is what the photographer brought.
				</p>
				<p>
					The app record is <code>PhotoMeta</code> in <code>lib/photos.ts</code>
					: id, src, width, height, takenAt, tzOffset, lat, lon, alt, hAccuracy,
					heading, f35, vfov, gravity, pitch, roll, holding, region. Uploads
					wear <code>LocalPhotoMeta</code>, the same record plus a{" "}
					<code>local</code> block of provenance flags.
				</p>
			</Section>

			<Section kicker="Mechanism" title="How it works">
				<Steps
					steps={[
						{
							title: "Read the tags",
							body: "readExif (exifr) returns ExifTags; raw date strings are read separately so no local-zone revival happens. The Apple MakerNote is parsed by hand: tag 0x0008 holds the gravity vector.",
						},
						{
							title: "Gravity to pitch and roll",
							body: "orientationFromGravity normalises the vector in the CoreMotion frame, picks the holding (landscape-left/right, portrait, portrait-upside) whose image-down best matches it, then derives pitch and roll.",
						},
						{
							title: "Focal to field of view",
							body: "vfovFromF35 converts the 35 mm-equivalent focal on the diagonal; with sensor and source sizes it is crop-aware. Missing focal falls back to 26 mm.",
						},
						{
							title: "Time and position",
							body: "captureTime prefers GPS date+time (UTC), then DateTimeOriginal with OffsetTime. A zone-less clock gets round(lon / 15) hours and is flagged tzEstimated.",
						},
						{
							title: "Assemble",
							body: "buildPhotoMeta returns the record. Missing tags never throw: they become placeholders plus a flag, which is the next figure.",
						},
					]}
				/>
			</Section>

			<Figure
				label="Fig. 3"
				caption="Interactive schematic. Drop tags from the file and watch which flags buildPhotoMeta raises. Flags mean 'placeholder, not measurement'."
			>
				<Survival accent={accent} />
			</Figure>

			<Section kicker="Role" title="Why it matters in Rigi">
				<p>
					Every pipeline starts here. The record seeds the{" "}
					<A id="exif-prior">EXIF pose prior</A>, and its flags are how{" "}
					<A id="prior-unknowns">prior unknowns</A> tell the solver cascade what
					to search over. <A id="photo-upload">Upload</A> produces the same
					shape as ingest, so a user photo and a bundled one take identical code
					paths, and the <A id="camera-roll">camera roll</A> clusters photos by
					position and time.
				</p>
				<p>
					Because gravity pins pitch and roll and focal pins field of view, only
					yaw and position remain uncertain for a typical iPhone image, which is
					why the compass is the first thing the solvers distrust.
				</p>
			</Section>

			<Section kicker="Hazards" title="Gotchas and lessons">
				<ul>
					<li>
						<strong>Two PhotoMeta types.</strong> <code>lib/photos.ts</code> is
						the app record; <code>lib/geo/photo-meta.ts</code> is raw EXIF with
						optional fields and <code>focal35</code>. The ontology files the
						second under raw-exif.
					</li>
					<li>
						<strong>Zeros are not measurements.</strong> Without gravity, pitch
						and roll are 0 and must be read with <code>pitchRollUnknown</code>.
					</li>
					<li>
						<strong>A pinned position has no altitude.</strong> alt and
						hAccuracy are null so the engine snaps to the DEM instead of
						trusting a made-up height.
					</li>
					<li>
						<strong>Heading may be magnetic.</strong> <code>headingRef</code>{" "}
						keeps T or M; iPhones write T.
					</li>
				</ul>
				<Callout tone="warning" title="Compass is a prior, not truth">
					Heading can be tens of degrees off. See the{" "}
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
	const d = useAtlasPhoto("demo-01");
	const W = d?.photo.width ?? 800;
	const H = d?.photo.height ?? 600;
	return (
		<Figure
			label="Fig. 1"
			caption={
				<>
					{d
						? `One photo, six facts the phone wrote down before we looked at a single pixel (GPS accuracy ±${d.gps.hAccuracy.toFixed(0)} m).`
						: "One photo, six facts the phone wrote down."}{" "}
					<Measured data={d} />
				</>
			}
		>
			<RealPhoto data={d} layers={[]}>
				{() => (
					<>
						<Mark x={70} y={H - 50} n={1} k={1.9} />
						<Mark x={70} y={H * 0.5} n={2} k={1.9} />
						<Mark x={W / 2} y={60} n={3} k={1.9} />
						<Mark x={W / 2} y={H * 0.5} n={4} k={1.9} />
						<Mark x={W - 70} y={H * 0.5} n={5} k={1.9} />
						<Mark x={W - 70} y={H - 50} n={6} k={1.9} />
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
							<strong>Tilt.</strong> {signed(d.sensor.pitch)}° up or down,{" "}
							{signed(d.sensor.roll)}° sideways.
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

/** Three tiny schematics, drawn from the real values of demo-01. */
function TagsMini({ d }: { d: AtlasPhotoData | null }) {
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
					className="flex justify-between rounded bg-white/[0.06] px-2 py-1"
				>
					<span className="text-white/45">{k}</span>
					<span className="text-white/85">{v}</span>
				</div>
			))}
		</div>
	);
}
function TiltMini({ d }: { d: AtlasPhotoData | null }) {
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
			<rect
				x="20"
				y="15"
				width="120"
				height="90"
				rx="6"
				fill="none"
				stroke="white"
				strokeOpacity=".3"
			/>
			<g transform={`rotate(${-roll} 80 60)`}>
				<line
					x1="0"
					x2="160"
					y1={y}
					y2={y}
					stroke="var(--accent)"
					strokeWidth="2"
					strokeDasharray="5 3"
				/>
			</g>
			<text
				x="80"
				y="116"
				textAnchor="middle"
				fontSize="9"
				fill="white"
				fillOpacity=".55"
				fontFamily="ui-monospace,monospace"
			>
				pitch {signed(pitch)}° · roll {signed(roll)}°
			</text>
		</svg>
	);
}
function LensMini({ d }: { d: AtlasPhotoData | null }) {
	if (!d) return <div className="aspect-[4/3]" />;
	const h = (d.prior.hfov / 2) * (Math.PI / 180);
	const r = 80;
	return (
		<svg
			viewBox="0 0 160 120"
			className="block h-auto w-full"
			role="img"
			aria-label="Field of view from focal length"
		>
			<path
				d={`M80 108 L${80 - r * Math.sin(h)} ${108 - r * Math.cos(h)} A${r} ${r} 0 0 1 ${80 + r * Math.sin(h)} ${108 - r * Math.cos(h)} Z`}
				fill="var(--accent)"
				fillOpacity=".22"
				stroke="var(--accent)"
			/>
			<circle cx="80" cy="108" r="3" fill="var(--rigi-paper)" />
			<text
				x="80"
				y="62"
				textAnchor="middle"
				fontSize="10"
				fill="white"
				fillOpacity=".8"
				fontFamily="ui-monospace,monospace"
			>
				{d.prior.hfov.toFixed(0)}° wide
			</text>
		</svg>
	);
}

/** Sky and ridge only: from just above the skyline to just below its median row, so foreground people stay out. */
function ridgeCrop(d: AtlasPhotoData): [number, number, number, number] {
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
			label="Fig. 2"
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
				tile={(d) => (
					<div
						className={`overflow-hidden rounded-lg ${Math.abs(d.gps.alt - d.gps.ground) > 200 ? "ring-2 ring-[var(--accent)]" : ""}`}
					>
						<RealPhoto data={d} layers={[]} crop={ridgeCrop(d)} />
					</div>
				)}
				label={(d) => {
					const diff = d.gps.alt - d.gps.ground;
					return (
						<>
							<span className="text-white/80">{d.id.slice(-2)}</span>
							{" · "}
							<span
								className={Math.abs(diff) > 200 ? "text-[var(--accent)]" : ""}
							>
								{signed(diff, 0)} m
							</span>
							{" · ±"}
							{d.gps.hAccuracy.toFixed(0)} m fix
						</>
					);
				}}
			/>
			<p className="mt-3 font-mono text-[10.5px] text-white/40">
				Ground = Terrarium DEM, the same one the atlas runs on; the real data
				table is in Details.
			</p>
		</Figure>
	);
}

function PhotoNumbers() {
	const m = useManifest();
	const d9 = useAtlasPhoto("demo-09");
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
					label: "worst altitude error against the map (demo-09)",
				},
				{
					value: "1.6 m",
					label: "minimum eye height we assume above the ground",
				},
			]}
			source="Measured: public/demo/manifest.json and atlas data, 2026-10-01. Eye height: src/lib/geo/pipeline.ts."
		/>
	);
}

export default function Page({ node }: { node: AtlasNode }) {
	const accent = groupColor(node.group);
	const d1 = useAtlasPhoto("demo-01");
	return (
		<>
			<HeroMarks />

			<Beat
				kicker="The idea"
				title="A photo is pixels plus what the phone knew."
			>
				<p>
					The phone writes down where it was and how it was held. That is a good
					first guess, not an answer.
				</p>
				<p>Only the pixels can say which way the camera really pointed.</p>
			</Beat>

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
			</Beat>

			<Beat
				kicker="Where it fails"
				title="A tag can lie, so one tag never decides alone."
			>
				<p>
					Demo-09 says it was 730 m below the ground. We take the higher of the
					GPS height and the ground plus 1.6 m.
				</p>
				<p>If a tag is missing, we search for that value instead.</p>
			</Beat>

			<AltitudeCheck />

			<PhotoNumbers />

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next: the <A id="camera-prior">camera prior</A>, the first guess these
				tags make about where the camera points.
			</p>

			<Details>
				<Deep accent={accent} />
			</Details>
		</>
	);
}
