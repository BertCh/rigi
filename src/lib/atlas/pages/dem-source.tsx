import { useEffect, useState } from "react";
import {
	Callout,
	CodeRef,
	Figure,
	Flow,
	Measured,
	Plot,
	Steps,
} from "#/components/atlas/viz";
import {
	Beat,
	Compare,
	Details,
	Key,
	Numbers,
	Trio,
} from "#/components/atlas/viz/explain";
import { atlasHref } from "#/lib/atlas/graph-utils";
import type { AtlasNode } from "#/lib/atlas/types";
import { MAPTERHORN, TERRAIN_LEVELS, TERRARIUM_AWS } from "#/lib/dem/sources";

const TERRA = "#e69a8d";
const MAP = "#8fc08a";
const LAT = 46.8; // Swiss Alps, where the benchmark lives

/** Real DEM facts from scripts/atlas/data-terrain.ts (Niederhorn, demo-01 camera). */
type Level = {
	z: number;
	from: number;
	to: number;
	tiles: number;
	tileKm: number;
	mPerPx: number;
};
type TerrainData = {
	generated: string;
	script: string;
	levels: { terrarium: Level[]; mapterhorn: Level[] };
	rgb: {
		source: string;
		tile: string;
		px: number;
		py: number;
		rgb: [number, number, number];
		height: number;
	}[];
	box: {
		halfM: number;
		px: number;
		osmSummit: { name: string; ele: number | null };
		profile: { northM: number; terrarium: number[]; mapterhorn: number[] };
		terrarium: {
			z: number;
			nativeMPerPx: number;
			max: number;
			slopeP90: number;
		};
		mapterhorn: {
			z: number;
			nativeMPerPx: number;
			max: number;
			slopeP90: number;
		};
		meanAbsDiff: number;
		maxAbsDiff: number;
	};
	transect: {
		bearing: number;
		step: number;
		d: number[];
		terrarium: Record<string, number[]>;
		mapterhorn: Record<string, number[]>;
	};
	coverage: { name: string; finest: number }[];
	eyes: { id: string; groundTerrarium: number; groundMapterhorn: number }[];
};
let terrainCache: Promise<TerrainData> | null = null;
function useTerrainData() {
	const [d, setD] = useState<TerrainData | null>(null);
	useEffect(() => {
		let live = true;
		terrainCache ??= fetch("/demo/atlas/terrain/terrain.json").then((r) => {
			if (!r.ok) throw new Error(`terrain.json ${r.status}`);
			return r.json();
		});
		terrainCache.then(
			(v) => live && setD(v),
			(e) => {
				terrainCache = null;
				console.warn("[atlas]", e);
			},
		);
		return () => {
			live = false;
		};
	}, []);
	return d;
}
const A = ({ id, children }: { id: string; children: React.ReactNode }) => (
	<a
		href={atlasHref(id)}
		className="text-[var(--accent)] underline-offset-2 hover:underline"
	>
		{children}
	</a>
);

/** Metres per pixel of a Terrarium/Mapterhorn tile at latitude LAT. */
const mPerPx = (z: number, tile: number) =>
	(156543.03 * Math.cos((LAT * Math.PI) / 180)) / 2 ** z / (tile / 256);

const fmt = (v: number, n = 0) =>
	v.toLocaleString("en-US", {
		minimumFractionDigits: n,
		maximumFractionDigits: n,
	});

/* ---------- Hero: the wipe, on real hillshades ---------- */
function Hero({ d }: { d: TerrainData | null }) {
	const box = d?.box;
	const pf = box?.profile;
	const all = pf ? [...pf.terrarium, ...pf.mapterhorn] : [0, 1];
	const lo = Math.min(...all);
	const hi = Math.max(...all);
	const X = (x: number, n: number) => (x / (n - 1)) * 360;
	const Y = (v: number) => 74 - ((v - lo) / (hi - lo || 1)) * 62;
	const line = (a: number[]) =>
		a
			.map((v, x) => `${X(x, a.length).toFixed(1)},${Y(v).toFixed(1)}`)
			.join(" ");
	const gap = box ? box.mapterhorn.max - box.terrarium.max : null;
	return (
		<Figure
			label="Fig. 1"
			caption={
				<>
					{gap == null
						? "Terrarium rounds the summit low."
						: `Terrarium rounds the summit ${gap.toFixed(0)} m low.`}{" "}
					{box?.osmSummit.ele != null &&
						`The map's own tag says ${fmt(box.osmSummit.ele)} m. `}
					<Measured data={d} />
				</>
			}
		>
			<Compare
				beforeLabel="Terrarium"
				afterLabel="Mapterhorn"
				start={0.5}
				className="mx-auto max-w-[560px] overflow-hidden rounded-xl ring-1 ring-white/10"
				before={
					<img
						src="/demo/atlas/terrain/hs-terrarium.jpg"
						alt="Terrarium hillshade of the Niederhorn ridge"
						className="block aspect-square w-full object-cover"
						draggable={false}
					/>
				}
				after={
					<img
						src="/demo/atlas/terrain/hs-mapterhorn.jpg"
						alt="Mapterhorn hillshade of the same ridge"
						className="block size-full object-cover"
						draggable={false}
					/>
				}
			/>
			{box && pf && (
				<>
					<svg
						viewBox="0 0 360 86"
						className="mx-auto mt-4 block h-auto w-full max-w-[560px]"
						role="img"
						aria-label="West-east height profile through the highest pixel, Terrarium versus Mapterhorn"
					>
						<polyline
							points={line(pf.mapterhorn)}
							fill="none"
							stroke={MAP}
							strokeWidth="1.4"
						/>
						<polyline
							points={line(pf.terrarium)}
							fill="none"
							stroke={TERRA}
							strokeWidth="1.8"
						/>
						<text
							x="4"
							y="82"
							fontSize="8"
							fill="rgba(236,230,218,.5)"
							fontFamily="ui-monospace, monospace"
						>
							west
						</text>
						<text
							x="356"
							y="82"
							textAnchor="end"
							fontSize="8"
							fill="rgba(236,230,218,.5)"
							fontFamily="ui-monospace, monospace"
						>
							east
						</text>
						<text
							x="4"
							y="10"
							fontSize="8.5"
							fill={MAP}
							fontFamily="ui-monospace, monospace"
						>
							Mapterhorn peaks at {fmt(box.mapterhorn.max)} m
						</text>
						<text
							x="4"
							y="21"
							fontSize="8.5"
							fill={TERRA}
							fontFamily="ui-monospace, monospace"
						>
							Terrarium peaks at {fmt(box.terrarium.max)} m
						</text>
					</svg>
					<p className="mx-auto mt-1 max-w-[560px] text-[12.5px] text-white/55">
						<Key color={TERRA}>Terrarium</Key> and{" "}
						<Key color={MAP}>Mapterhorn</Key>, west to east through the highest
						pixel of the 1.2 km box.
					</p>
				</>
			)}
		</Figure>
	);
}

/* ---------- Where they disagree, along a real 12 km line ---------- */
function Disagree({ d }: { d: TerrainData | null }) {
	const tr = d?.transect;
	if (!tr)
		return (
			<Figure label="Fig. 2" caption="Loading measured transect.">
				<div className="aspect-[2/1] animate-pulse rounded-xl bg-white/[0.04]" />
			</Figure>
		);
	const T = tr.terrarium["15"];
	const Mh = tr.mapterhorn["15"];
	const km = tr.d.map((m) => m / 1000);
	const diff = T.map((v, i) => v - Mh[i]);
	let worst = 0;
	diff.forEach((v, i) => {
		if (Math.abs(v) > Math.abs(diff[worst])) worst = i;
	});
	return (
		<Figure
			label="Fig. 2"
			caption={
				<>
					Along 12 km the maps part by up to {Math.abs(diff[worst]).toFixed(0)}{" "}
					m, at {(tr.d[worst] / 1000).toFixed(1)} km. <Measured data={d} />
				</>
			}
		>
			<Plot
				x={[0, 12]}
				y={[400, 2400]}
				width={560}
				height={200}
				xLabel="distance from camera (km), bearing 150°, over Lake Thun"
				yLabel="height (m)"
				fmtX={(v) => v.toFixed(0)}
				fmtY={(v) => v.toFixed(0)}
			>
				{(s) => (
					<>
						<path
							d={s.area(km.map((x, i) => [x, Mh[i]]))}
							fill={MAP}
							fillOpacity={0.12}
						/>
						<path
							d={s.line(km.map((x, i) => [x, Mh[i]]))}
							fill="none"
							stroke={MAP}
							strokeWidth={1.6}
						/>
						<path
							d={s.line(km.map((x, i) => [x, T[i]]))}
							fill="none"
							stroke={TERRA}
							strokeWidth={1.2}
							strokeDasharray="4 3"
						/>
					</>
				)}
			</Plot>
			<Plot
				x={[0, 12]}
				y={[-80, 80]}
				width={560}
				height={130}
				xLabel="distance from camera (km)"
				yLabel="Terr. minus Map. (m)"
				fmtX={(v) => v.toFixed(0)}
				fmtY={(v) => v.toFixed(0)}
				yTicks={4}
			>
				{(s) => (
					<>
						<line
							x1={s.box.x0}
							x2={s.box.x1}
							y1={s.y(0)}
							y2={s.y(0)}
							stroke="white"
							strokeOpacity={0.3}
						/>
						<path
							d={s.line(km.map((x, i) => [x, diff[i]]))}
							fill="none"
							stroke="var(--accent)"
							strokeWidth={1.4}
						/>
					</>
				)}
			</Plot>
			<p className="mt-1 text-[12.5px] text-white/55">
				<Key color={MAP}>Mapterhorn</Key>,{" "}
				<Key color={TERRA} dashed>
					Terrarium
				</Key>
				. At the camera they read {T[0].toFixed(0)} m and {Mh[0].toFixed(0)} m.
			</p>
		</Figure>
	);
}

/* ---------- Ground under each camera: Terrarium minus Mapterhorn ---------- */
function GroundGap({ d }: { d: TerrainData | null }) {
	if (!d) return null;
	const rows = d.eyes.map((e) => ({
		id: e.id,
		gap: e.groundMapterhorn - e.groundTerrarium,
	}));
	const max = Math.max(...rows.map((r) => r.gap));
	return (
		<Figure
			label="Fig. 4"
			caption={
				<>
					At all 12 camera spots Terrarium puts the ground lower.{" "}
					<Measured data={d} />
				</>
			}
		>
			<svg
				viewBox="0 0 360 188"
				className="block h-auto w-full max-w-[560px]"
				role="img"
				aria-label="Ground height under each demo camera, Mapterhorn minus Terrarium"
			>
				{rows.map((r, i) => (
					<g key={r.id} transform={`translate(0 ${i * 15 + 4})`}>
						<text
							x="0"
							y="9"
							fontSize="8.5"
							fill="rgba(236,230,218,.6)"
							fontFamily="ui-monospace, monospace"
						>
							{r.id}
						</text>
						<rect
							x="52"
							y="1"
							width={(r.gap / max) * 250}
							height="10"
							rx="2"
							fill={TERRA}
							fillOpacity={0.8}
						/>
						<text
							x={52 + (r.gap / max) * 250 + 5}
							y="9"
							fontSize="8.5"
							fill="rgba(236,230,218,.85)"
							fontFamily="ui-monospace, monospace"
						>
							{r.gap.toFixed(0)} m
						</text>
					</g>
				))}
			</svg>
		</Figure>
	);
}

/* ---------- Trio visuals ---------- */
function PixelCard({ d }: { d: TerrainData | null }) {
	const p = d?.rgb.find((r) => r.source === "mapterhorn");
	if (!p) return <div className="aspect-[4/3] animate-pulse bg-white/[0.04]" />;
	const [r, g, b] = p.rgb;
	return (
		<div className="flex aspect-[4/3] flex-col items-center justify-center gap-2 p-3 font-mono text-[11px] text-white/70">
			<span
				className="size-14 rounded-lg ring-1 ring-white/25"
				style={{ background: `rgb(${r} ${g} ${b})` }}
			/>
			<span>
				R {r} · G {g} · B {b}
			</span>
			<span className="text-[var(--accent)]">= {p.height.toFixed(0)} m</span>
		</div>
	);
}

function BandsMini({ d }: { d: TerrainData | null }) {
	const lv = d?.levels.mapterhorn;
	if (!lv)
		return <div className="aspect-[4/3] animate-pulse bg-white/[0.04]" />;
	const x = (m: number) =>
		10 + ((Math.log10(Math.max(m, 100)) - 2) / (Math.log10(160_000) - 2)) * 280;
	return (
		<svg
			viewBox="0 0 300 130"
			className="block h-auto w-full"
			role="img"
			aria-label="Distance bands, each with its own tile zoom"
		>
			{lv.map((l, i) => {
				const x0 = i === 0 ? x(100) : x(lv[i - 1].to);
				const x1 = x(l.to);
				return (
					<g key={l.z}>
						<rect
							x={x0 + 1}
							y={30 + i * 3}
							width={Math.max(2, x1 - x0 - 2)}
							height={50 - i * 3}
							rx="3"
							fill={MAP}
							fillOpacity={0.2 + i * 0.12}
						/>
						<text
							x={(x0 + x1) / 2}
							y={96}
							textAnchor="middle"
							fontSize="8"
							fill="rgba(236,230,218,.7)"
							fontFamily="ui-monospace, monospace"
						>
							z{l.z}
						</text>
						<text
							x={(x0 + x1) / 2}
							y={108}
							textAnchor="middle"
							fontSize="6.5"
							fill="rgba(236,230,218,.45)"
							fontFamily="ui-monospace, monospace"
						>
							{l.mPerPx.toFixed(l.mPerPx < 10 ? 1 : 0)} m
						</text>
					</g>
				);
			})}
			<text
				x="10"
				y="18"
				fontSize="8"
				fill="rgba(236,230,218,.55)"
				fontFamily="ui-monospace, monospace"
			>
				near
			</text>
			<text
				x="290"
				y="18"
				textAnchor="end"
				fontSize="8"
				fill="rgba(236,230,218,.55)"
				fontFamily="ui-monospace, monospace"
			>
				far
			</text>
		</svg>
	);
}

function FallbackMini() {
	return (
		<svg
			viewBox="0 0 300 130"
			className="block h-auto w-full"
			role="img"
			aria-label="A missing fine tile falls back to a coarser one"
		>
			<defs>
				<pattern
					id="ds-miss"
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
						stroke="var(--rigi-trap)"
						strokeWidth="1.4"
						strokeOpacity="0.8"
					/>
				</pattern>
			</defs>
			<rect
				x="30"
				y="30"
				width="60"
				height="60"
				rx="4"
				fill={MAP}
				fillOpacity={0.15}
				stroke={MAP}
				strokeOpacity={0.5}
				strokeDasharray="3 3"
			/>
			<rect x="30" y="30" width="60" height="60" rx="4" fill="url(#ds-miss)" />
			<text
				x="60"
				y="108"
				textAnchor="middle"
				fontSize="8"
				fill="rgba(236,230,218,.6)"
				fontFamily="ui-monospace, monospace"
			>
				fine tile missing
			</text>
			<path
				d="M96 60h38"
				stroke="var(--accent)"
				strokeWidth="1.6"
				markerEnd="url(#ds-arr)"
			/>
			<path d="M134 60l-7 -4v8z" fill="var(--accent)" />
			<rect
				x="140"
				y="20"
				width="120"
				height="80"
				rx="4"
				fill={MAP}
				fillOpacity={0.5}
			/>
			<text
				x="200"
				y="64"
				textAnchor="middle"
				fontSize="9"
				fill="#0e1012"
				fontFamily="ui-monospace, monospace"
			>
				coarser tile
			</text>
		</svg>
	);
}

/* ---------- Fig 2: the distance ladder ---------- */
function Ladder({ d: data }: { d: TerrainData | null }) {
	const [d, setD] = useState(3000);
	const max = 160_000;
	const lx = (m: number) =>
		40 + ((Math.log10(Math.max(m, 100)) - 2) / (Math.log10(max) - 2)) * 540;
	const pick = (levels: { z: number; maxDistance: number }[]) => {
		let i = levels.findIndex((l) => d <= l.maxDistance);
		if (i < 0) i = levels.length - 1;
		return i;
	};
	const row = (
		name: string,
		levels: { z: number; maxDistance: number }[],
		tile: number,
		y: number,
		col: string,
	) => {
		const sel = pick(levels);
		return (
			<g key={name}>
				<text x="0" y={y - 8} fontSize="9" fill={col} className="font-mono">
					{name}
				</text>
				{levels.map((l, i) => {
					const x0 = i === 0 ? lx(100) : lx(levels[i - 1].maxDistance);
					const x1 = lx(l.maxDistance);
					return (
						<g key={l.z}>
							<rect
								x={x0 + 1}
								y={y}
								width={Math.max(1, x1 - x0 - 2)}
								height="26"
								rx="3"
								fill={col}
								opacity={i === sel ? 0.9 : 0.16 + i * 0.01}
							/>
							<text
								x={(x0 + x1) / 2}
								y={y + 16}
								fontSize="9"
								textAnchor="middle"
								fill={i === sel ? "#0e1012" : "currentColor"}
								className="font-mono text-white/70"
							>
								z{l.z}
							</text>
							<text
								x={(x0 + x1) / 2}
								y={y + 40}
								fontSize="7.5"
								textAnchor="middle"
								fill="currentColor"
								className="font-mono text-white/40"
							>
								{mPerPx(l.z, tile).toFixed(1)} m
							</text>
						</g>
					);
				})}
			</g>
		);
	};
	return (
		<Figure
			label="Fig. 3"
			caption="Slide the probe: the lit band is the zoom each map would use at that distance. Small numbers are metres per pixel."
		>
			<svg
				viewBox="0 0 600 150"
				className="h-auto w-full"
				role="img"
				aria-label="Distance bands of the Terrarium and Mapterhorn tile ladders"
			>
				{row("terrarium (3 bands)", TERRAIN_LEVELS, 256, 22, TERRA)}
				{row("mapterhorn (6 bands)", MAPTERHORN.levels, 512, 88, MAP)}
				{[1000, 4000, 15000, 40000, 150000].map((m) => (
					<g key={m}>
						<line
							x1={lx(m)}
							x2={lx(m)}
							y1="12"
							y2="136"
							stroke="currentColor"
							className="text-white/10"
						/>
						<text
							x={lx(m)}
							y="148"
							fontSize="8"
							textAnchor="middle"
							fill="currentColor"
							className="font-mono text-white/45"
						>
							{m >= 1000 ? `${m / 1000} km` : `${m} m`}
						</text>
					</g>
				))}
				<line
					x1={lx(d)}
					x2={lx(d)}
					y1="4"
					y2="138"
					stroke="var(--accent)"
					strokeWidth="1.5"
				/>
			</svg>
			<label className="mt-2 flex items-center gap-3 font-mono text-[11px] text-white/60">
				distance
				<input
					type="range"
					min={2}
					max={Math.log10(max) * 100}
					value={Math.log10(d) * 100}
					onChange={(e) =>
						setD(Math.round(10 ** (Number(e.target.value) / 100)))
					}
					className="flex-1 accent-[var(--accent)]"
					aria-label="Sample distance from camera"
				/>
				<span className="w-16 text-right text-white/85">
					{d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${d} m`}
				</span>
			</label>

			{data && (
				<p className="mt-1 font-mono text-[11px] text-white/50">
					Measured at the Niederhorn camera: the selected band is{" "}
					{data.levels.mapterhorn[pick(MAPTERHORN.levels)].tiles} Mapterhorn
					tiles of {data.levels.mapterhorn[pick(MAPTERHORN.levels)].tileKm} km,
					or {data.levels.terrarium[pick(TERRAIN_LEVELS)].tiles} Terrarium tiles
					of {data.levels.terrarium[pick(TERRAIN_LEVELS)].tileKm} km
					(tilesAround count, {data.script}).
				</p>
			)}
		</Figure>
	);
}

/* ---------- Fig 4: the encoding of a real pixel ---------- */
function Encoding({ d }: { d: TerrainData | null }) {
	return (
		<Figure
			label="Pixel decode"
			caption={
				<>
					The tile pixel under the camera in each source. <Measured data={d} />
				</>
			}
		>
			<div className="grid gap-3 sm:grid-cols-2">
				{(d?.rgb ?? []).map((p) => {
					const [r, g, b] = p.rgb;
					const col = p.source === "terrarium" ? TERRA : MAP;
					return (
						<div key={p.source} className="rounded-xl p-4 ring-1 ring-white/10">
							<div className="flex items-center gap-3">
								<span
									className="size-10 shrink-0 rounded-md ring-1 ring-white/20"
									style={{ background: `rgb(${r} ${g} ${b})` }}
								/>
								<div className="font-mono text-[11px] text-white/60">
									<div style={{ color: col }}>{p.source}</div>
									tile {p.tile}, pixel ({p.px}, {p.py})
								</div>
							</div>
							<div className="mt-3 font-mono text-[12px] leading-relaxed text-white/80">
								R {r} &middot; G {g} &middot; B {b}
								<br />
								{r}&times;256 + {g} + {b}/256 &minus; 32768
								<br />
								<span className="text-[var(--accent)]">
									= {p.height.toFixed(2)} m
								</span>
							</div>
						</div>
					);
				})}
			</div>
		</Figure>
	);
}

export default function Page(_: { node: AtlasNode }) {
	const d = useTerrainData();
	const gaps = d?.eyes.map((e) => e.groundMapterhorn - e.groundTerrarium) ?? [];
	const gMin = gaps.length ? Math.min(...gaps) : null;
	const gMax = gaps.length ? Math.max(...gaps) : null;
	const tr = d?.transect;
	let worst = Number.NaN;
	if (tr) {
		const T = tr.terrarium["15"];
		const Mh = tr.mapterhorn["15"];
		worst = Math.max(...T.map((v, i) => Math.abs(v - Mh[i])));
	}
	return (
		<>
			<Hero d={d} />

			<Beat
				kicker="The idea"
				title="Two free height maps. One keeps the summit."
			>
				<p>
					Both are pictures where each pixel&rsquo;s colour is a height.
					Terrarium is the global default. Mapterhorn adds Swiss survey data
					where it exists.
				</p>
				{d && (
					<p>
						At their finest, a Mapterhorn pixel is{" "}
						{d.box.mapterhorn.nativeMPerPx} m wide here. A Terrarium pixel is{" "}
						{d.box.terrarium.nativeMPerPx} m.
					</p>
				)}
			</Beat>

			<Disagree d={d} />

			<Beat
				kicker="How it works"
				title="A tile is a picture that spells heights."
			>
				<Trio
					steps={[
						{
							title: "Colour is a height",
							body: "Red, green and blue decode to metres.",
							visual: <PixelCard d={d} />,
						},
						{
							title: "Distance picks the zoom",
							body: "Sharp tiles near us, coarse tiles for far ridges.",
							visual: <BandsMini d={d} />,
						},
						{
							title: "A hole falls back",
							body: "No fine tile here? We use the next coarser one.",
							visual: <FallbackMini />,
						},
					]}
				/>
			</Beat>

			<Ladder d={d} />

			<Beat
				kicker="Where it fails"
				title={
					gMin == null || gMax == null
						? "Terrarium sits lower under every camera."
						: `Terrarium sits ${gMin.toFixed(0)} to ${gMax.toFixed(0)} m lower under our cameras.`
				}
			>
				<p>
					Heights feed the skyline we match. In the benchmark, drawing on the
					wrong map moved the skyline by 1 to 27% of image height.
				</p>
				<p>
					Fine tiles also exist only where surveys do. Elsewhere we fall back to
					coarser ones.
				</p>
			</Beat>

			<GroundGap d={d} />

			<Numbers
				items={[
					{
						value: "25 vs 14",
						label: "correct poses of 100 photos, Mapterhorn vs Terrarium",
					},
					{
						value: d
							? `${(d.box.mapterhorn.max - d.box.terrarium.max).toFixed(0)} m`
							: "…",
						label: "Niederhorn summit lower in Terrarium",
					},
					{
						value: Number.isNaN(worst) ? "…" : `${worst.toFixed(0)} m`,
						label: "largest gap on a 12 km line",
					},
					{
						value:
							gMin == null || gMax == null
								? "…"
								: `${gMin.toFixed(0)}–${gMax.toFixed(0)} m`,
						label: "ground gap across the 12 demo cameras",
					},
				]}
				source={
					<>
						Benchmark: reports/bench-wild.md (cascade re-run, all 100 photos).
						Others: measured by scripts/atlas/data-terrain.ts at the Niederhorn
						camera.
					</>
				}
			/>

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next: the <A id="terrain-sampler">terrain sampler</A> reads a height
				from these tiles. The <A id="dem-horizon">DEM horizon</A> uses it to
				draw the skyline.
			</p>

			<Details>
				<h3>What a source is</h3>
				<p>
					A <code>DemSource</code> is a plain record: a name, a{" "}
					<code>url(TileKey)</code> function, a <code>tileSize</code>, the
					deepest <code>maxZoom</code> and a list of distance{" "}
					<code>levels</code>. <code>MAPTERHORN</code> ({MAPTERHORN.tileSize} px
					WebP, to z{MAPTERHORN.maxZoom}, swissALTI3D in Switzerland) is the
					user-approved default that every DEM consumer uses.{" "}
					<code>TERRAIN_LEVELS</code> belongs to <code>TERRARIUM_AWS</code> (
					{TERRARIUM_AWS.tileSize} px PNG, z{TERRARIUM_AWS.maxZoom}), kept as
					the comparison. Both are{" "}
					<A id="terrarium-encoding">Terrarium-encoded</A>, so the decoder is
					shared and a tile is a <A id="dem-tile">DEM tile</A> either way.
				</p>
				<p>
					Each source carries its own{" "}
					<A id="dem-lod-levels">distance-banded ladder</A>. The sampler asks
					for height at (lon, lat, distance from camera), picks the first band
					whose <code>maxDistance</code> covers it, and walks to coarser bands
					if that tile is missing. Mapterhorn&rsquo;s ladder is one zoom coarser
					per band than Terrarium&rsquo;s (its tiles are twice as wide) plus two
					finer near-field levels.
				</p>
				<Flow
					nodes={[
						{ label: "DemSource", sub: "url + levels", color: MAP },
						{ label: "tilesAround", sub: "per band" },
						{ label: "loadTile", sub: "cache, decode" },
						{ label: "TerrainSampler", sub: "sampleAt" },
					]}
				/>
				<Steps
					steps={[
						{
							title: "Pick the base URL",
							body: "VITE_MAPTERHORN_URL (browser) or MAPTERHORN_URL (Node) overrides the public service, so a self-hosted pmtiles endpoint is a one-line change.",
						},
						{
							title: "Choose a band",
							body: "findIndex(l => distance <= l.maxDistance); beyond the last band, the coarsest one is used.",
						},
						{
							title: "Fall back on a miss",
							body: "Missing fine tiles (outside national lidar) return NaN, and sampleAt tries the next coarser level. ground() is just sampleAt(lon, lat, 0).",
						},
					]}
				/>
				<h3>Pixel decode, measured</h3>
				<Encoding d={d} />
				{d && (
					<>
						<h3>Coverage depends on place</h3>
						<p>
							&quot;To z17&quot; is the ceiling, not a promise. Probing the
							service for the finest tile that exists at six places gave:
						</p>
						<div className="flex flex-wrap gap-2 font-mono text-[11px]">
							{d.coverage.map((c) => (
								<span
									key={c.name}
									className="rounded-full px-3 py-1 ring-1 ring-white/15"
								>
									{c.name} <span style={{ color: MAP }}>z{c.finest}</span>
								</span>
							))}
						</div>
						<p>
							Measured by <code>{d.script}</code>, {d.generated} (HTTP status of
							one tile per zoom).
						</p>
					</>
				)}
				<h3>Why it matters in Rigi</h3>
				<p>
					Georeferencing depends on skyline notches and ridgelines matching the
					photo to a few hundredths of a degree. A DEM that rounds off summits
					moves exactly those features. Swapping Terrarium for Mapterhorn took
					the cascade from 14 to 25 correct poses on the 100-photo{" "}
					<A id="wild-benchmark">wild benchmark</A>, with no algorithm change
					(reports/bench-wild.md). It is also the licensing surface: see the{" "}
					<A id="licence-register">licence register</A>.
				</p>
				<h3>Gotchas and lessons</h3>
				<ul>
					<li>
						<strong>Verify on the DEM the method used.</strong> The first
						benchmark verification drew overlays on Terrarium while methods
						solved on Mapterhorn; ground differed by up to 114 m and the drawn
						skyline moved 1 to 27% of image height. The reported precision
						(0.72) and a &quot;GPS parallax&quot; story were wrong.
					</li>
					<li>
						The 12-photo ground truth was fitted against Terrarium notches, so
						it carries a small Terrarium bias.
					</li>
					<li>
						Self-hosted tiles must be the same 512 px Terrarium WebP, and
						missing tiles must return 404 or 204 so the ancestor fallback works.
					</li>
					<li>
						Terrarium is for <code>/baseline</code> and research scripts only;
						it is not on product paths.
					</li>
				</ul>
				<Callout tone="negative" title="Terrarium cascade">
					14 correct vs 25 on Mapterhorn: the smoother DEM is not a cheaper
					equivalent; it silently changes accuracy.
				</Callout>
				<h3>Code</h3>
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/dem/sources.ts">
						DemSource, MAPTERHORN, TERRAIN_LEVELS
					</CodeRef>
					<CodeRef path="src/lib/geo/terrain.ts">
						TerrainSampler.sampleAt
					</CodeRef>
					<CodeRef path="src/lib/dem/index.ts">dem barrel</CodeRef>
					<CodeRef path="reports/bench-wild.md" />
					<CodeRef path="reports/licences.md" />
				</div>
			</Details>
		</>
	);
}
