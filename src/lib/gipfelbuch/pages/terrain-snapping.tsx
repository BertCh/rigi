// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	CircledKey,
	CircledNumber,
	HandMark,
	HandScaleBar,
	KrokiTitle,
	NorthArrow,
} from "#/components/gipfelbuch/notebook";
import {
	Hachure,
	HandDot,
	HandText,
	PenArrow,
	PenCircle,
	PenLine,
	SketchPath,
} from "#/components/gipfelbuch/notebook/Ink";
import { SpotHeight } from "#/components/gipfelbuch/swiss/Marks";
import { SWISS } from "#/components/gipfelbuch/swiss/palette";
import { TYPE } from "#/components/gipfelbuch/swiss/type";
import {
	CodeRef,
	Eq,
	Figure,
	HandLabel,
	MarginNote,
	RealPhoto,
	Sym,
	useGipfelbuchPhoto,
} from "#/components/gipfelbuch/viz";
import { Beat, Details, Mark, Trio } from "#/components/gipfelbuch/viz/explain";
import { byId, gipfelbuchHref } from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// Terrain snapping hub (chapter II): snap, bound, hint, with links out to eye-rule, peak and
// dem-anchoring. The peak snap is drawn here because the peak sheet starts after it.
// Rules mirrored from the code (kept literal so the page has no engine imports):
//  eye       eyeAltitude = alt != null ? max(alt, dem + 1.6) : dem + 1.8      (engine.ts, deck/scene.ts)
//  lake      floor = level + 0.3 m, radius clamp(hAcc, 5, 100) + 30 m, drop <= 3 m; ?geoLakeFloor (geocam/lakes/floor.ts)
//  peaks     localMax(lat, lon, min(250, 60 + dist * 0.004)) on a 9x9 grid; peaks < 150 m or > 110 km dropped (engine.ts buildPeaks)
//  anchor    quality = inlierFrac * exp(-(err / 0.2)^2), hide < 0.15, low trust < 0.35 (nearfield/anchor.ts)
const rectPath = (x: number, y: number, w: number, h: number) =>
	`M${x} ${y}H${x + w}V${y + h}H${x}Z`;

// tiles around the Niederhorn demo camera, real TerrainSampler, the engine's peak-snap rule re-run on it).
type PeakRow = {
	name: string;
	ele: number | null;
	dist: number;
	radius: number;
	osmMapterhorn: number;
	snapMapterhorn: number;
	moveMapterhorn: number;
	snapTerrarium: number;
};
type TerrainData = {
	generated: string;
	script: string;
	peakRule: {
		n: number;
		nWithEle: number;
		medianAbsEleMinusSnapMapterhorn: number;
		medianAbsEleMinusSnapTerrarium: number;
		medianAbsEleMinusOsmNodeMapterhorn: number;
		medianMoveMapterhorn: number;
		p90MoveMapterhorn: number;
		rows: PeakRow[];
	};
	snapExample?: {
		name: string;
		ele: number | null;
		dist: number;
		radius: number;
		halfM: number;
		px: number;
		osmPx: [number, number];
		snapPx: [number, number];
		osmH: number;
		snapH: number;
		move: number;
		grid: [number, number, number][];
	};
};
let terrainCache: Promise<TerrainData> | null = null;

function useTerrainData() {
	const [d, setD] = useState<TerrainData | null>(null);
	useEffect(() => {
		let live = true;
		terrainCache ??= fetch("/demo/gipfelbuch/terrain/terrain.json").then(
			(r) => {
				if (!r.ok) throw new Error(`terrain.json ${r.status}`);
				return r.json();
			},
		);
		terrainCache.then(
			(v) => live && setD(v),
			(e) => {
				terrainCache = null;
				console.warn("[gipfelbuch]", e);
			},
		);
		return () => {
			live = false;
		};
	}, []);
	return d;
}
const Measured = ({ what }: { d: TerrainData | null; what: string }) => (
	<span className="gb-secondary">Measured: {what}</span>
);

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

/** The shipped radius rule with the measured example substituted; the dashed square in Fig. 2 is this r. */
function SnapEquation({ d }: { d: TerrainData | null }) {
	const ex = d?.snapExample;
	return (
		<Eq
			label="How far we search"
			where={[
				{
					sym: "r",
					c: "var(--gb-ink)",
					text: "half-width of the dashed search square, in metres",
				},
				{
					sym: "d",
					text: "distance from camera to the OSM peak, in metres",
				},
			]}
		>
			<Sym c="var(--gb-ink)">r</Sym> = min(250, 60 + 0.004 <Sym>d</Sym>)
			{ex && (
				<>
					<br />= min(250, 60 + 0.004 × {Math.round(ex.dist)}) ={" "}
					<Sym c="var(--gb-ink)">{ex.radius}</Sym> m
				</>
			)}
		</Eq>
	);
}

function PeakReal({ d }: { d: TerrainData | null }) {
	const ex = d?.snapExample;
	if (!d || !ex)
		return (
			<div className="aspect-[2/1] animate-pulse bg-[var(--gb-paper-deep)]" />
		);
	const pr = d.peakRule;
	const hs = ex.grid.map((g) => g[2]);
	const lo = Math.min(...hs);
	const hi = Math.max(...hs);
	const sr = (ex.radius / ex.halfM) * (ex.px / 2);
	// 13 px at about 420 px rendered width (hillshade in the left half of the wide figure)
	const snapLabel = (13 * ex.px) / 420;
	return (
		<Figure
			label="Fig. 2"
			bleed
			caption={
				<>
					The snap moves {ex.name} {ex.move} m onto its summit (red = highest of
					the 9 by 9 samples). Median over {pr.n} peaks:{" "}
					{pr.medianMoveMapterhorn} m.{" "}
					<Measured d={d} what="peaks within 40 km, Mapterhorn." />
				</>
			}
		>
			<div className="grid items-start gap-6 lg:grid-cols-[1fr_1fr]">
				<svg
					viewBox={`0 0 ${ex.px} ${ex.px}`}
					className="block h-auto w-full"
					role="img"
					aria-label={`Hillshade around the OSM node of ${ex.name}, with the 9 by 9 search grid and the snapped summit`}
				>
					<image
						href="/demo/gipfelbuch/terrain/snap-0.jpg"
						width={ex.px}
						height={ex.px}
					/>
					<SketchPath
						d={rectPath(ex.osmPx[0] - sr, ex.osmPx[1] - sr, 2 * sr, 2 * sr)}
						seed="snap-sq-casing"
						data
						color="var(--gb-paper)"
						opacity={0.8}
						width={3.4}
					/>
					<SketchPath
						d={rectPath(ex.osmPx[0] - sr, ex.osmPx[1] - sr, 2 * sr, 2 * sr)}
						seed="snap-sq"
						data
						color="ink"
						width={1.4}
						dash="4 3"
					/>
					{ex.grid.map(([x, y, h]) => (
						<HandDot
							key={`${x}-${y}`}
							x={x}
							y={y}
							r={h === hi ? 4.2 : 3}
							seed={`snap-g-${x}-${y}`}
							data
							color={h === hi ? "red" : "ink"}
							opacity={h === hi ? 1 : 0.45 + 0.55 * ((h - lo) / (hi - lo || 1))}
						/>
					))}
					<PenLine
						data
						from={[ex.osmPx[0], ex.osmPx[1]]}
						to={[ex.snapPx[0], ex.snapPx[1]]}
						seed="snap-move-casing"
						color="var(--gb-paper)"
						opacity={0.8}
						width={3.6}
					/>
					<PenLine
						data
						from={[ex.osmPx[0], ex.osmPx[1]]}
						to={[ex.snapPx[0], ex.snapPx[1]]}
						seed="snap-move"
						color="red"
						width={1.8}
					/>
					<PenCircle
						seed="snap-osm"
						center={ex.osmPx}
						radiusX={5}
						color="pencil"
						width={1.8}
					/>
					<PenCircle
						seed="snap-top-ring"
						data
						center={ex.snapPx}
						radiusX={5.4}
						color="var(--gb-paper)"
						width={1.6}
					/>
					<HandDot
						x={ex.snapPx[0]}
						y={ex.snapPx[1]}
						r={4.2}
						seed="snap-top"
						data
						color="red"
						opacity={1}
					/>
					<HandLabel
						x={ex.snapPx[0] + 8}
						y={ex.snapPx[1] - 8}
						size={snapLabel * 0.9}
						italic
						color={SWISS.ink}
					>
						{ex.snapH.toFixed(1)}
					</HandLabel>
					<KrokiTitle
						x={8}
						y={snapLabel * 1.7}
						title={ex.name}
						size={snapLabel * 1.5}
						seed="snap-title"
					/>
					<NorthArrow x={ex.px - 22} y={snapLabel * 4.2} seed="snap-north" />
					<HandScaleBar
						x={10}
						y={ex.px - 14}
						metersPerPixel={(ex.halfM * 2) / ex.px}
						maxWidth={ex.px * 0.3}
						seed="snap-scale"
					/>
					<HandText
						x={ex.px - 10}
						y={ex.px - 12}
						size={snapLabel * 1.1}
						anchor="end"
						rotate={-2}
					>
						OSM point here; the summit is elsewhere in the grid
					</HandText>
					<CircledKey
						x={ex.osmPx[0] - 14}
						y={ex.osmPx[1] + 14}
						value="1"
						seed="snap-key-1"
						color="ink"
						r={7 * (ex.px / 420)}
					/>
					<CircledKey
						x={ex.snapPx[0] - 14}
						y={ex.snapPx[1] - 10}
						value="2"
						seed="snap-key-2"
						r={7 * (ex.px / 420)}
					/>
					<HandLabel x={8} y={ex.px - 30} size={snapLabel} color={SWISS.ink}>
						{`${ex.halfM * 2} m across`}
					</HandLabel>
				</svg>
				<div className={`w-full font-mono gb-secondary ${TYPE.micro}`}>
					<div className="bg-[var(--gb-paper-deep)] p-3">
						<div className={`gb-ink ${TYPE.caption}`}>{ex.name}</div>
						<div className="mt-1 flex justify-between">
							<span>distance, search radius</span>
							<span className="gb-ink">
								{(ex.dist / 1000).toFixed(1)} km, {ex.radius} m
							</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>height at OSM point</span>
							<span className="gb-ink">{ex.osmH.toFixed(1)} m</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>height at summit</span>
							<span className="text-[var(--accent)]">
								<SpotHeight value={ex.snapH.toFixed(1)} unit="m" />
							</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>OSM height tag</span>
							<span className="gb-ink">
								{ex.ele == null ? "none" : `${ex.ele} m`}
							</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>moved</span>
							<span className="gb-ink">{ex.move} m</span>
						</div>
					</div>
					<div className="mt-3 grid grid-cols-3 gap-2 text-center">
						<div className="bg-[var(--gb-paper-deep)] p-2">
							<div className={`gb-ink ${TYPE.body}`}>
								{pr.medianMoveMapterhorn} m
							</div>
							median move
						</div>
						<div className="bg-[var(--gb-paper-deep)] p-2">
							<div className={`gb-ink ${TYPE.body}`}>
								{pr.p90MoveMapterhorn} m
							</div>
							90th percentile
						</div>
						<div className="bg-[var(--gb-paper-deep)] p-2">
							<div className={`gb-ink ${TYPE.body}`}>{pr.n}</div>
							peaks (150 m to 40 km)
						</div>
					</div>
					<p className={`mt-3 font-sans ${TYPE.caption}`}>
						Check against OSM&apos;s own height tag ({pr.nWithEle} tagged peaks,
						median error): {pr.medianAbsEleMinusOsmNodeMapterhorn} m at the OSM
						point, {pr.medianAbsEleMinusSnapMapterhorn} m after the snap
						(Mapterhorn), {pr.medianAbsEleMinusSnapTerrarium} m on Terrarium.
					</p>
				</div>
			</div>
		</Figure>
	);
}

// ============================================================================================
// The ledger: where the DEM overrules, bounds or merely informs.
// ============================================================================================

const LEDGER: {
	what: string;
	verb: "snap" | "bound" | "prior" | "calibrate";
	rule: string;
	when: string;
}[] = [
	{
		what: "Eye height",
		verb: "snap",
		rule: "higher of GPS altitude and ground + 1.6 m; ground + 1.8 m without altitude",
		when: "always",
	},
	{
		what: "OSM peaks",
		verb: "snap",
		rule: "highest of 9×9 samples in a search square",
		when: "always (150 m – 110 km)",
	},
	{
		what: "Eye on a lake",
		verb: "bound",
		rule: "never below lake level + 0.3 m; only lifts",
		when: "optional",
	},
	{
		what: "GPS altitude",
		verb: "prior",
		rule: "soft hint around where ground + 1.6 m matches the altitude; never moves the fix",
		when: "optional",
	},
	{
		what: "Near-field depth",
		verb: "calibrate",
		rule: "curve fitted to terrain distance, 15 m to 3 km, used only when it fits well",
		when: "Step Inside",
	},
	{
		what: "Near-field objects",
		verb: "snap",
		rule: "scale each object to the terrain distance at its ground contacts",
		when: "Step Inside",
	},
];
const VERB_C: Record<string, string> = {
	snap: "var(--accent)",
	bound: "var(--gb-navy)",
	prior: "var(--gb-pencil)",
	calibrate: "var(--gb-contour)",
};

function Ledger() {
	return (
		<div className="@container">
			<ul className="m-0 list-none p-0">
				{LEDGER.map((r) => (
					<li
						key={r.what}
						className="grid gap-x-4 gap-y-1 px-2 py-3 even:bg-[var(--gb-paper-deep)] @[640px]:grid-cols-[10rem_5.5rem_1fr_9rem]"
					>
						<div className={`gb-ink ${TYPE.caption}`}>{r.what}</div>
						<div>
							<span
								className={`nb-hand px-1 underline decoration-wavy decoration-1 underline-offset-4 ${TYPE.body}`}
								style={{ color: VERB_C[r.verb] }}
							>
								{r.verb}
							</span>
						</div>
						<div className={`gb-secondary ${TYPE.caption}`}>{r.rule}</div>
						<div className={`font-mono gb-secondary ${TYPE.micro}`}>
							{r.when}
						</div>
					</li>
				))}
			</ul>
		</div>
	);
}
// ============================================================================================
// Hero: one photo, three things pinned to the map.
// ============================================================================================
function Hero({ d }: { d: TerrainData | null }) {
	const photo = useGipfelbuchPhoto("demo-03");
	const crop: [number, number, number, number] = [0, 300, 800, 900];
	const peak = photo?.peaks.find((p) => p.name === "Blüemlisalphorn")?.solved;
	return (
		<Figure
			label="Fig. 1"
			bleed
			pinned="demo-03"
			caption={
				d
					? `Three things in this photo are corrected using the terrain; a typical peak moves ${d.peakRule.medianMoveMapterhorn} m onto its summit.`
					: "Three things in this photo are corrected using the terrain."
			}
		>
			<RealPhoto bleed data={photo} layers={[]} crop={crop}>
				{() => (
					<g>
						<Mark x={400} y={850} n={1} k={2} />
						{peak && (
							<>
								<Mark x={peak[0]} y={peak[1]} n={2} k={2} />
								<HandLabel
									x={peak[0] - 26}
									y={peak[1] + 8}
									anchor="end"
									size={16}
									color="#fff"
									halo={4}
									haloColor="rgba(12,14,18,.85)"
									mono={false}
									condensed
								>
									Blüemlisalphorn
								</HandLabel>
							</>
						)}
						<Mark x={300} y={790} n={3} k={2} />
						<HandText x={420} y={846} size={22} rotate={-2}>
							camera kept above ground
						</HandText>
						{d && (
							<HandText x={300} y={760} size={22} anchor="end" rotate={2}>
								{`typical peak moves up ${d.peakRule.medianMoveMapterhorn} m`}
							</HandText>
						)}
					</g>
				)}
			</RealPhoto>
		</Figure>
	);
}

function MiniSvg({
	children,
	label,
}: {
	children: React.ReactNode;
	label: string;
}) {
	return (
		<svg
			viewBox="0 0 200 130"
			className="block h-auto w-full"
			role="img"
			aria-label={label}
		>
			{children}
		</svg>
	);
}
const HILL =
	"M0 110 C40 100 60 40 100 36 C140 32 160 90 200 100 L200 130 L0 130Z";
const HILL_RIDGE = "M0 110 C40 100 60 40 100 36 C140 32 160 90 200 100";

function MiniSnap() {
	return (
		<MiniSvg label="A peak label jumps from beside the summit onto it">
			<Hachure d={HILL} seed="mini-snap-hill" color="brown" gap={6} />
			<SketchPath
				d={HILL_RIDGE}
				seed="mini-snap-ridge"
				color="brown"
				width={1.6}
			/>
			<PenCircle
				seed="mini-snap-osm"
				center={[150, 64]}
				radiusX={6}
				color="pencil"
				width={1.6}
			/>
			<PenArrow
				seed="mini-snap-move"
				from={[145, 61]}
				to={[106, 40]}
				color="red"
				width={1.4}
				dash="3 3"
			/>
			<HandDot
				x={100}
				y={36}
				r={4.5}
				seed="mini-snap-top"
				color="red"
				opacity={1}
			/>
			<HandLabel x={152} y={52} size={12} color="var(--gb-secondary)">
				OSM node
			</HandLabel>
			<HandLabel x={100} y={24} anchor="middle" size={12}>
				summit
			</HandLabel>
		</MiniSvg>
	);
}
function MiniBound() {
	return (
		<MiniSvg label="An eye kept above the lake level">
			<Hachure
				d="M0 80H200V130H0Z"
				seed="mini-bound-lake"
				color="blue"
				gap={5}
			/>
			<PenLine
				seed="mini-bound-level"
				from={[0, 80]}
				to={[200, 80]}
				color="blue"
				width={1.6}
			/>
			<PenLine
				seed="mini-bound-floor"
				from={[0, 70]}
				to={[200, 70]}
				color="pencil"
				width={1.2}
				dash="4 3"
			/>
			<PenCircle
				seed="mini-bound-below"
				center={[100, 94]}
				radiusX={6}
				color="pencil"
				width={1.4}
			/>
			<PenArrow
				seed="mini-bound-lift"
				from={[100, 86]}
				to={[100, 75]}
				color="ink"
				width={1.3}
			/>
			<HandDot
				x={100}
				y={66}
				r={4.5}
				seed="mini-bound-eye"
				color="red"
				opacity={1}
			/>
			<HandLabel
				x={196}
				y={64}
				anchor="end"
				size={12}
				color="var(--gb-secondary)"
			>
				level + 0.3 m
			</HandLabel>
			<HandLabel x={196} y={100} anchor="end" size={12} color="var(--gb-water)">
				lake
			</HandLabel>
		</MiniSvg>
	);
}
function MiniPrior() {
	const pts = Array.from({ length: 41 }, (_, i) => {
		const x = 20 + i * 4.5;
		return `${i ? "L" : "M"}${x.toFixed(1)} ${(110 - 80 * Math.exp(-(((x - 100) / 30) ** 2))).toFixed(1)}`;
	}).join("");
	return (
		<MiniSvg label="A soft bump of likely heights, not a single point">
			<PenLine
				seed="mini-prior-axis"
				from={[10, 110]}
				to={[190, 110]}
				color="ink"
				width={1.2}
			/>
			<Hachure
				d={`${pts}L190 110L20 110Z`}
				seed="mini-prior-bump"
				color="pencil"
				gap={5}
				opacity={0.6}
			/>
			<SketchPath d={pts} seed="mini-prior-curve" color="pencil" width={1.8} />
			<PenLine
				seed="mini-prior-mid"
				from={[100, 30]}
				to={[100, 110]}
				color="faint"
				width={1}
				dash="3 3"
			/>
			<HandLabel x={106} y={26} size={12}>
				soft hint
			</HandLabel>
		</MiniSvg>
	);
}

export default function Page({ node }: { node: GipfelbuchNode }) {
	void node;
	const d = useTerrainData();
	return (
		<>
			<Hero d={d} />

			<Beat
				kicker="The idea"
				title="The terrain model overrides the photo's metadata where it is more accurate."
			>
				<p>
					A photo comes with a GPS position, sometimes an altitude, and named
					peaks. None of them match the terrain exactly.
				</p>
				<p>
					<HandMark type="highlight">
						We use the terrain only where it is clearly more accurate.
					</HandMark>{" "}
					Elsewhere it sets a lower limit or a hint. In Fig. 1:{" "}
					<CircledNumber value={1} seed="ts-p1" /> camera,{" "}
					<CircledNumber value={2} seed="ts-p2" /> peak,{" "}
					<CircledNumber value={3} seed="ts-p3" /> depth.
					{d && (
						<MarginNote mark="a">
							{`A typical peak moves ${d.peakRule.medianMoveMapterhorn} m; the 90th percentile ${d.peakRule.p90MoveMapterhorn} m.`}
						</MarginNote>
					)}
				</p>
			</Beat>

			<Beat
				kicker="Three roles"
				title="Three ways the terrain is used: snap, bound, hint."
			>
				<Trio
					steps={[
						{
							title: "Snap",
							body: (
								<>
									The terrain is clearly more accurate, so the value is moved
									onto it. OSM peaks move onto the terrain summit before the
									visibility test. {link("peak", "Peak")}
								</>
							),
							visual: <MiniSnap />,
						},
						{
							title: "Bound",
							body: (
								<>
									The terrain only rules out some values, so it sets a limit:
									the camera stays at least standing height above the ground and
									above a lake. {link("eye-rule", "Eye rule")}
								</>
							),
							visual: <MiniBound />,
						},
						{
							title: "Hint",
							body: (
								<>
									Depth from one photo has no scale, so terrain distances
									suggest one; it is used only when the fit is good.{" "}
									{link("dem-anchoring", "DEM anchoring")}
								</>
							),
							visual: <MiniPrior />,
						},
					]}
				/>
			</Beat>

			<Beat
				kicker="Peaks"
				title="OSM peaks are slightly off their summits, so we move them."
			>
				<p>
					Named peaks come from OpenStreetMap, often a few dozen metres off the
					real top. We search a square around the OSM point, wider for far
					peaks, and move the peak to the{" "}
					<HandMark type="underline">highest terrain point</HandMark>. In Fig.
					2: <CircledNumber value={1} color="ink" seed="ts-p-n1" /> OSM point,{" "}
					<CircledNumber value={2} seed="ts-p-n2" /> summit.
					<MarginNote mark="b">
						Why 9 by 9? That is enough samples to find the crest inside the
						square.
					</MarginNote>
				</p>
				<SnapEquation d={d} />
			</Beat>

			<PeakReal d={d} />

			<Beat
				kicker="Where it fails"
				title="The result depends on which terrain model is used."
			>
				<p>
					Two terrain models put the same spot at different heights, so every
					snap moves with the model: see {link("dem-source", "Terrain model")}.{" "}
					<HandMark type="double">
						Treating a hint as a snap would discard the sensor measurement.
					</HandMark>
				</p>
			</Beat>

			<Details>
				<h3>Every place a coordinate is matched to the terrain</h3>
				<Ledger />
				<h3>Peak snap in code</h3>
				<p>
					<code>buildPeaks</code> moves every peak between 150 m and 110 km to{" "}
					<code>localMax</code>. The radius grows 4 m per kilometre, from 60 m
					near the camera to the 250 m cap at 47.5 km. The search starts at the
					node&apos;s own height, so a sample must be strictly higher to win.
				</p>
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/deck/engine.ts" />
					<CodeRef path="src/lib/concord/priors/altitude.ts" />
					<CodeRef path="src/lib/nearfield/ground.ts" />
				</div>
			</Details>
		</>
	);
}
