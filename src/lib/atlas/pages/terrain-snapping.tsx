import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	CodeRef,
	Figure,
	Measured as PhotoMeasured,
	RealPhoto,
	useAtlasPhoto,
} from "#/components/atlas/viz";
import {
	Beat,
	Details,
	Mark,
	MarkList,
	Numbers,
	Trio,
} from "#/components/atlas/viz/explain";
import { atlasHref, byId } from "#/lib/atlas/graph-utils";
import type { AtlasNode } from "#/lib/atlas/types";

// Terrain snapping hub: where a coordinate meets the DEM (eye height, peaks, near-field depth).
// Rules mirrored from the code (kept literal so the page has no engine imports):
//  eye       eyeAltitude = alt != null ? max(alt, dem + 1.6) : dem + 1.8      (engine.ts, deck/scene.ts)
//  lake      floor = level + 0.3 m, radius clamp(hAcc, 5, 100) + 30 m, drop <= 3 m; ?geoLakeFloor (geocam/lakes/floor.ts)
//  peaks     localMax(lat, lon, min(250, 60 + dist * 0.004)) on a 9x9 grid; peaks < 150 m or > 110 km dropped (engine.ts buildPeaks)
//  anchor    quality = inlierFrac * exp(-(err / 0.2)^2), hide < 0.15, low trust < 0.35 (nearfield/anchor.ts)
const EYE_ABOVE = 1.6;

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
	eyes: {
		id: string;
		alt: number;
		hAcc: number;
		groundTerrarium: number;
		groundMapterhorn: number;
		eye: number;
		lift: number;
	}[];
	lake: { mapterhornMin: number; terrariumMin: number };
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
const Measured = ({ d, what }: { d: TerrainData | null; what: string }) => (
	<span className="text-white/50">
		Measured: {what} Real tiles and the real TerrainSampler, by{" "}
		<span className="font-mono">
			{d?.script ?? "scripts/atlas/data-terrain.ts"}
		</span>
		{d ? `, ${d.generated}` : ""}.
	</span>
);

function link(id: string, label: string) {
	if (!byId.has(id)) return <>{label}</>;
	return (
		<Link to={atlasHref(id)} className="underline decoration-white/25">
			{label}
		</Link>
	);
}

function RealEye({ d }: { d: TerrainData | null }) {
	if (!d)
		return (
			<Figure label="Fig. 3" bleed caption="Loading measured eye heights">
				<div className="aspect-[2/1] animate-pulse rounded-xl bg-white/[0.04]" />
			</Figure>
		);
	const rows = d.eyes.map((e) => ({
		...e,
		liftT: Math.max(0, e.groundTerrarium + EYE_ABOVE - e.alt),
		liftM: Math.max(0, e.groundMapterhorn + EYE_ABOVE - e.alt),
	}));
	const MAX = 30;
	const RH = 22;
	const X0 = 74;
	const X1 = 330;
	const bx = (v: number) => X0 + (Math.min(v, MAX) / MAX) * (X1 - X0);
	const nM = rows.filter((r) => r.liftM > 0).length;
	const nT = rows.filter((r) => r.liftT > 0).length;
	const med = (a: number[]) => {
		const s = [...a].sort((x, y) => x - y);
		return s[Math.floor(s.length / 2)];
	};
	const liftsM = rows
		.filter((r) => r.liftM > 0 && r.liftT <= MAX)
		.map((r) => r.liftM);
	return (
		<Figure
			label="Fig. 3"
			bleed
			caption={
				<>
					The same GPS fix lifts the eye by very different amounts on two maps.{" "}
					<Measured
						d={d}
						what="the eye rule on the 12 Niederhorn photos, ground read at each fix."
					/>
				</>
			}
		>
			<svg
				viewBox={`0 0 560 ${40 + rows.length * RH + 24}`}
				className="block h-auto w-full"
				role="img"
				aria-label="Metres each demo photo's eye is lifted by the eye rule, for Terrarium and Mapterhorn ground"
			>
				{[0, 10, 20, 30].map((v) => (
					<g key={v}>
						<line
							x1={bx(v)}
							x2={bx(v)}
							y1={28}
							y2={28 + rows.length * RH}
							stroke="white"
							strokeOpacity={0.1}
						/>
						<text
							x={bx(v)}
							y={20}
							textAnchor="middle"
							fontSize="9"
							fill="rgba(236,230,218,.5)"
							className="font-mono"
						>
							{v} m
						</text>
					</g>
				))}
				{rows.map((r, i) => {
					const y = 32 + i * RH;
					const big = r.liftT > MAX;
					return (
						<g key={r.id}>
							<text
								x={X0 - 8}
								y={y + 11}
								textAnchor="end"
								fontSize="10"
								fill="rgba(236,230,218,.7)"
								className="font-mono"
							>
								{r.id}
							</text>
							<rect
								x={X0}
								y={y}
								width={Math.max(0, bx(r.liftM) - X0)}
								height={7}
								fill="var(--accent)"
							/>
							<rect
								x={X0}
								y={y + 9}
								width={Math.max(0, bx(r.liftT) - X0)}
								height={7}
								fill="#e69a8d"
							/>
							{big && (
								<text
									x={X1 + 10}
									y={y + 12}
									fontSize="9.5"
									fill="rgba(236,230,218,.75)"
									className="font-mono"
								>
									+{r.liftT.toFixed(0)} m: alt {r.alt.toFixed(0)} vs ground{" "}
									{r.groundTerrarium.toFixed(0)}
								</text>
							)}
							{!big && r.liftM > 0 && (
								<text
									x={bx(r.liftM) + 4}
									y={y + 7}
									fontSize="9"
									fill="rgba(236,230,218,.6)"
									className="font-mono"
								>
									{r.liftM.toFixed(0)}
								</text>
							)}
						</g>
					);
				})}
				<g fontSize="10" className="font-mono">
					<rect
						x={X0}
						y={40 + rows.length * RH}
						width="9"
						height="9"
						fill="var(--accent)"
					/>
					<text
						x={X0 + 14}
						y={48 + rows.length * RH}
						fill="rgba(236,230,218,.7)"
					>
						Mapterhorn ground
					</text>
					<rect
						x={X0 + 150}
						y={40 + rows.length * RH}
						width="9"
						height="9"
						fill="#e69a8d"
					/>
					<text
						x={X0 + 164}
						y={48 + rows.length * RH}
						fill="rgba(236,230,218,.7)"
					>
						Terrarium ground
					</text>
				</g>
			</svg>
			<p className="mt-3 font-mono text-[11px] leading-relaxed text-white/60">
				Bar = metres the eye is lifted above the raw GPS altitude. On Mapterhorn
				ground the rule lifts {nM} of {rows.length} photos (excluding demo-09:
				median {med(liftsM).toFixed(0)} m, up to{" "}
				{Math.max(...liftsM).toFixed(0)} m): the photographer stands on the
				crest, and the finer DEM has the crest higher than the GPS altitude. On
				Terrarium ground, which smooths that crest down, it lifts only {nT} (the
				build-data run used Terrarium). demo-09 carries a GPS altitude of{" "}
				{rows.find((r) => r.id === "demo-09")?.alt.toFixed(0)} m,{" "}
				{Math.round(
					(rows.find((r) => r.id === "demo-09")?.groundTerrarium ?? 0) -
						(rows.find((r) => r.id === "demo-09")?.alt ?? 0),
				)}{" "}
				m below the ground.
			</p>
		</Figure>
	);
}

function PeakReal({ d }: { d: TerrainData | null }) {
	const ex = d?.snapExample;
	if (!d || !ex)
		return (
			<Figure label="Fig. 2" bleed caption="Loading measured peak snaps">
				<div className="aspect-[2/1] animate-pulse rounded-xl bg-white/[0.04]" />
			</Figure>
		);
	const pr = d.peakRule;
	const hs = ex.grid.map((g) => g[2]);
	const lo = Math.min(...hs);
	const hi = Math.max(...hs);
	const sr = (ex.radius / ex.halfM) * (ex.px / 2);
	return (
		<Figure
			label="Fig. 2"
			bleed
			caption={
				<>
					The snap moves {ex.name} {ex.move} m onto its summit; the median over{" "}
					{pr.n} peaks is {pr.medianMoveMapterhorn} m.{" "}
					<Measured
						d={d}
						what="the engine's snap rule on Mapterhorn around the real OSM nodes within 40 km."
					/>
				</>
			}
		>
			<div className="grid items-start gap-6 md:grid-cols-[1fr_1fr]">
				<svg
					viewBox={`0 0 ${ex.px} ${ex.px}`}
					className="block h-auto w-full rounded-xl bg-black/20"
					role="img"
					aria-label={`Hillshade around the OSM node of ${ex.name}, with the 9 by 9 search grid and the snapped summit`}
				>
					<image
						href="/demo/atlas/terrain/snap-0.jpg"
						width={ex.px}
						height={ex.px}
					/>
					<rect
						x={ex.osmPx[0] - sr}
						y={ex.osmPx[1] - sr}
						width={2 * sr}
						height={2 * sr}
						fill="none"
						stroke="var(--rigi-paper)"
						strokeOpacity={0.6}
						strokeDasharray="4 3"
					/>
					{ex.grid.map(([x, y, h]) => (
						<circle
							key={`${x}-${y}`}
							cx={x}
							cy={y}
							r={1.8}
							fill="var(--accent)"
							fillOpacity={0.25 + 0.75 * ((h - lo) / (hi - lo || 1))}
						/>
					))}
					<line
						x1={ex.osmPx[0]}
						y1={ex.osmPx[1]}
						x2={ex.snapPx[0]}
						y2={ex.snapPx[1]}
						stroke="#ff5fa2"
						strokeWidth={1}
					/>
					<circle
						cx={ex.osmPx[0]}
						cy={ex.osmPx[1]}
						r={4}
						fill="none"
						stroke="#ff5fa2"
						strokeWidth={1.6}
					/>
					<circle
						cx={ex.snapPx[0]}
						cy={ex.snapPx[1]}
						r={4}
						fill="var(--accent)"
						stroke="#0e1012"
						strokeWidth={1.2}
					/>
					<text
						x={8}
						y={ex.px - 8}
						fontSize="9"
						fill="#ece6da"
						stroke="#0e1012"
						strokeWidth="2.5"
						paintOrder="stroke"
						className="font-mono"
					>
						{ex.halfM * 2} m across
					</text>
				</svg>
				<div className="font-mono text-[11.5px] text-white/60">
					<div className="rounded-lg bg-white/[0.04] p-3 ring-1 ring-white/10">
						<div className="text-[var(--rigi-paper)]">{ex.name}</div>
						<div className="mt-1 flex justify-between">
							<span>distance, radius</span>
							<span className="text-[var(--rigi-paper)]">
								{(ex.dist / 1000).toFixed(1)} km, {ex.radius} m
							</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>DEM at the OSM node</span>
							<span className="text-[var(--rigi-paper)]">
								{ex.osmH.toFixed(1)} m
							</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>DEM at the snapped point</span>
							<span className="text-[var(--accent)]">
								{ex.snapH.toFixed(1)} m
							</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>OSM ele tag</span>
							<span className="text-[var(--rigi-paper)]">
								{ex.ele ?? "none"} m
							</span>
						</div>
						<div className="mt-1 flex justify-between">
							<span>moved</span>
							<span className="text-[var(--rigi-paper)]">{ex.move} m</span>
						</div>
					</div>
					<div className="mt-3 grid grid-cols-3 gap-2 text-center">
						<div className="rounded-lg p-2 ring-1 ring-white/10">
							<div className="text-[15px] text-[var(--rigi-paper)]">
								{pr.medianMoveMapterhorn} m
							</div>
							median move
						</div>
						<div className="rounded-lg p-2 ring-1 ring-white/10">
							<div className="text-[15px] text-[var(--rigi-paper)]">
								{pr.p90MoveMapterhorn} m
							</div>
							90th percentile
						</div>
						<div className="rounded-lg p-2 ring-1 ring-white/10">
							<div className="text-[15px] text-[var(--rigi-paper)]">{pr.n}</div>
							peaks, 150 m to 40 km
						</div>
					</div>
					<p className="mt-3 text-[11px] leading-relaxed">
						Does the snap agree with OSM&apos;s own ele tag? Median |ele minus
						DEM| over {pr.nWithEle} tagged peaks:{" "}
						{pr.medianAbsEleMinusOsmNodeMapterhorn} m at the node,{" "}
						{pr.medianAbsEleMinusSnapMapterhorn} m at the snapped point
						(Mapterhorn); on Terrarium, which blunts summits, the snapped point
						is {pr.medianAbsEleMinusSnapTerrarium} m off.
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
	where: string;
	when: string;
}[] = [
	{
		what: "Eye height",
		verb: "snap",
		rule: "max(GPS alt, DEM + 1.6 m); DEM + 1.8 m without altitude",
		where: "src/lib/deck/scene.ts",
		when: "always",
	},
	{
		what: "OSM peaks",
		verb: "snap",
		rule: "highest of 9×9 samples within ±min(250, 60 + 0.004·d) m",
		where: "src/lib/engine.ts",
		when: "always (150 m – 110 km)",
	},
	{
		what: "Eye on a lake",
		verb: "bound",
		rule: "eye ≥ lake level + 0.3 m; lifts only, fail-open",
		where: "src/lib/geocam/lakes/floor.ts",
		when: "?geoLakeFloor",
	},
	{
		what: "GPS altitude",
		verb: "prior",
		rule: "Gaussian + iso-band where DEM + 1.6 ≈ alt; never moves the fix",
		where: "src/lib/concord/priors/altitude.ts",
		when: "?concord=eye",
	},
	{
		what: "Near-field depth",
		verb: "calibrate",
		rule: "monotone log-log curve to DEM range, 15 m – 3 km, quality-gated",
		where: "src/lib/nearfield/anchor.ts",
		when: "Step Inside",
	},
	{
		what: "Near-field objects",
		verb: "snap",
		rule: "scale each object to the DEM range at its ground contacts",
		where: "src/lib/nearfield/ground.ts",
		when: "Step Inside",
	},
];
const VERB_C: Record<string, string> = {
	snap: "var(--accent)",
	bound: "#6fa8d8",
	prior: "#c79be0",
	calibrate: "#e6a06a",
};

function Ledger() {
	return (
		<div>
			<div className="-mx-1 overflow-x-auto">
				<table className="w-full min-w-[560px] border-collapse text-left text-[13px]">
					<thead>
						<tr className="font-mono text-[10px] tracking-[0.12em] text-white/40 uppercase">
							<th className="px-2 pb-2 font-normal">What</th>
							<th className="px-2 pb-2 font-normal">Role</th>
							<th className="px-2 pb-2 font-normal">Rule</th>
							<th className="px-2 pb-2 font-normal">When</th>
						</tr>
					</thead>
					<tbody>
						{LEDGER.map((r) => (
							<tr key={r.what} className="border-t border-white/8 align-top">
								<td className="px-2 py-2.5 text-[var(--rigi-paper)]">
									{r.what}
									<div className="mt-1">
										<CodeRef path={r.where} />
									</div>
								</td>
								<td className="px-2 py-2.5">
									<span
										className="rounded-full px-2 py-0.5 font-mono text-[10.5px]"
										style={{
											color: VERB_C[r.verb],
											boxShadow: `inset 0 0 0 1px ${VERB_C[r.verb]}`,
										}}
									>
										{r.verb}
									</span>
								</td>
								<td className="px-2 py-2.5 text-white/65">{r.rule}</td>
								<td className="px-2 py-2.5 font-mono text-[11px] text-white/45">
									{r.when}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
// ============================================================================================
// Hero: one photo, three things pinned to the map.
// ============================================================================================
function Hero({ d }: { d: TerrainData | null }) {
	const photo = useAtlasPhoto("demo-03");
	const crop: [number, number, number, number] = [0, 300, 800, 900];
	const peak = photo?.peaks.find((p) => p.name === "Blüemlisalphorn")?.solved;
	return (
		<Figure
			label="Fig. 1"
			caption={
				<>
					{d
						? `Three things in this photo are pinned to the map; a typical peak moves ${d.peakRule.medianMoveMapterhorn} m onto its summit.`
						: "Three things in this photo are pinned to the map."}{" "}
					<PhotoMeasured data={photo}>
						Peak moves: {d?.script ?? "scripts/atlas/data-terrain.ts"}.
					</PhotoMeasured>
				</>
			}
		>
			<RealPhoto data={photo} layers={[]} crop={crop}>
				{() => (
					<g>
						<Mark x={400} y={850} n={1} k={2} />
						{peak && (
							<>
								<Mark x={peak[0]} y={peak[1]} n={2} k={2} />
								<text
									x={peak[0] - 26}
									y={peak[1] + 8}
									textAnchor="end"
									fontSize={24}
									fill="#ece6da"
									stroke="#0e1012"
									strokeWidth={3}
									paintOrder="stroke"
								>
									Blüemlisalphorn
								</text>
							</>
						)}
						<Mark x={300} y={790} n={3} k={2} />
					</g>
				)}
			</RealPhoto>
			<MarkList
				items={[
					<>
						<strong className="text-[var(--rigi-paper)]">The camera</strong> is
						never below the ground. {link("eye-rule", "Eye rule")}
					</>,
					<>
						<strong className="text-[var(--rigi-paper)]">Peaks</strong> climb to
						the highest map point nearby. {link("peak", "Peak")}
					</>,
					<>
						<strong className="text-[var(--rigi-paper)]">Depth</strong> is bent
						onto the map's distances. {link("dem-anchoring", "DEM anchoring")}
					</>,
				]}
			/>
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
			className="block h-auto w-full rounded-lg bg-black/20"
			role="img"
			aria-label={label}
		>
			{children}
		</svg>
	);
}
const HILL =
	"M0 110 C40 100 60 40 100 36 C140 32 160 90 200 100 L200 130 L0 130Z";

function MiniSnap() {
	return (
		<MiniSvg label="A peak label jumps from beside the summit onto it">
			<path
				d={HILL}
				fill="rgba(236,230,218,.08)"
				stroke="rgba(236,230,218,.6)"
			/>
			<circle
				cx={150}
				cy={64}
				r={5}
				fill="none"
				stroke="#ff5fa2"
				strokeWidth={1.6}
			/>
			<line
				x1={146}
				y1={62}
				x2={106}
				y2={40}
				stroke="#ff5fa2"
				strokeDasharray="3 2"
			/>
			<circle cx={100} cy={36} r={5} fill="var(--accent)" />
		</MiniSvg>
	);
}
function MiniBound() {
	return (
		<MiniSvg label="An eye kept above the lake level">
			<rect
				x={0}
				y={80}
				width={200}
				height={50}
				fill="#6fa8d8"
				fillOpacity={0.25}
			/>
			<line
				x1={0}
				x2={200}
				y1={80}
				y2={80}
				stroke="#6fa8d8"
				strokeWidth={1.6}
			/>
			<line
				x1={0}
				x2={200}
				y1={70}
				y2={70}
				stroke="#6fa8d8"
				strokeDasharray="4 3"
			/>
			<circle
				cx={100}
				cy={92}
				r={5}
				fill="none"
				stroke="#ff5fa2"
				strokeWidth={1.6}
			/>
			<line
				x1={100}
				x2={100}
				y1={86}
				y2={74}
				stroke="var(--accent)"
				markerEnd="none"
			/>
			<circle cx={100} cy={70} r={5} fill="var(--accent)" />
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
			<line x1={10} x2={190} y1={110} y2={110} stroke="rgba(236,230,218,.4)" />
			<path d={pts} fill="none" stroke="#c79be0" strokeWidth={2} />
			<line
				x1={100}
				x2={100}
				y1={30}
				y2={110}
				stroke="#c79be0"
				strokeDasharray="3 3"
				strokeOpacity={0.6}
			/>
		</MiniSvg>
	);
}

export default function Page({ node }: { node: AtlasNode }) {
	void node;
	const d = useTerrainData();
	const gaps = d?.eyes.map((e) => e.groundMapterhorn - e.groundTerrarium);
	return (
		<>
			<Hero d={d} />

			<Beat
				kicker="The idea"
				title="The map is the referee for everything we place."
			>
				<p>
					A photo brings a GPS spot, maybe an altitude, and named peaks. None of
					them agree exactly with the terrain the solver measures.
				</p>
				<p>
					We trust the map only where it is plainly better. Elsewhere it gives a
					floor or a hint.
				</p>
			</Beat>

			<Beat kicker="Three roles" title="Snap it, bound it, or hint at it.">
				<Trio
					steps={[
						{
							title: "Snap",
							body: "The map is clearly right: move the thing onto it. Peaks do this.",
							visual: <MiniSnap />,
						},
						{
							title: "Bound",
							body: "The map only rules out a region: keep the eye above the lake.",
							visual: <MiniBound />,
						},
						{
							title: "Hint",
							body: "The sensor still knows something: GPS altitude stays a soft hint.",
							visual: <MiniPrior />,
						},
					]}
				/>
			</Beat>

			<Beat
				kicker="Peaks"
				title="Map peaks sit beside their summits; we climb them."
			>
				<p>
					Named peaks come from OpenStreetMap, often a few dozen metres off the
					real top.
				</p>
			</Beat>

			<PeakReal d={d} />

			<Beat
				kicker="Where it fails"
				title="The answer depends on which map you ask."
			>
				<p>
					Two elevation maps put the same spot at different heights. The eye
					lift changes with them. Treating a hint as a snap would throw the
					measurement away.
				</p>
			</Beat>

			<RealEye d={d} />

			<Numbers
				items={[
					{
						value: d ? `${d.peakRule.medianMoveMapterhorn} m` : "…",
						label: `median peak move (${d?.peakRule.n ?? "…"} named peaks within 40 km)`,
					},
					{
						value: d ? `${d.peakRule.p90MoveMapterhorn} m` : "…",
						label: "90th-percentile peak move",
					},
					{
						value: gaps
							? `${Math.round(Math.min(...gaps))} to ${Math.round(Math.max(...gaps))} m`
							: "…",
						label: "two maps' ground height at the same 12 GPS fixes",
					},
					{
						value: "0.13",
						label:
							"median depth error after anchoring, 23 photos (one scale: 0.34)",
					},
				]}
				source={
					<>
						Peaks and ground: {d?.script ?? "scripts/atlas/data-terrain.ts"},
						Mapterhorn and Terrarium. Depth: reports/step-inside-results.md.
					</>
				}
			/>

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next: the {link("eye-rule", "eye rule")}, then {link("peak", "peak")}{" "}
				placement, then {link("dem-anchoring", "DEM anchoring")}. The snapped
				heights feed the {link("dem-horizon", "DEM horizon")}.
			</p>

			<Details>
				<h3>Every place a coordinate meets the map</h3>
				<Ledger />
				<h3>Eye height</h3>
				<p>
					<code>eyeAltitude</code> keeps the GPS altitude unless it is below
					standing height over the DEM, then uses <code>DEM + 1.6 m</code>; with
					no altitude it uses <code>DEM + 1.8 m</code>. It only ever lifts the
					eye, so a barometer-aided altitude above the ground survives. Over
					Lake Thun the DEM's flat water cells read{" "}
					{d?.lake.terrariumMin ?? "…"} m (Terrarium) and{" "}
					{d?.lake.mapterhornMin ?? "…"} m (Mapterhorn), so the lake bound is a
					fixed level + 0.3 m rather than the DEM value. One metre of eye height
					moves a ridge 500 m away by about 0.11°, several pixels on a phone
					photo. Near a summit the horizontal fix can land up-slope and{" "}
					<code>DEM + 1.6</code> then puts the eye 5 to 20 m too high; the
					concord eye prior (<code>?concord=eye</code>) treats the altitude as a
					measurement through an iso-band and never snaps.
				</p>
				<p>
					The frame's origin matters too: the renderer's ENU frame sits at sea
					level, with the eye at <code>(0, 0, eyeAlt)</code>. A solver handed
					the default position prior <code>[0, 0, 0]</code> projects from sea
					level, which a regression test measured at about 3° of pitch and roll
					(<code>src/lib/pose6dof/README.md</code>).
				</p>
				<h3>Peaks</h3>
				<p>
					<code>buildPeaks</code> moves every peak between 150 m and 110 km to{" "}
					<code>localMax</code>: the highest of a 9×9 grid of DEM samples
					spanning ±r around the node, <code>r = min(250, 60 + 0.004·d)</code>{" "}
					metres. The radius grows 4 m per kilometre, from 60 m near the camera
					to the 250 m cap at 47.5 km. The search starts at the node's own
					height, so a sample must be strictly higher to win. Visibility tests
					against the DEM need the peak on the terrain, not floating.
				</p>
				<h3>Near-field depth</h3>
				<p>
					{link("dem-anchoring", "DEM anchoring")} fits a monotone log-log curve
					from model ray length to DEM range over terrain pixels between 15 m
					and 3 km (sky and people masked), by dynamic programming under a
					truncated L1 loss. Quality is{" "}
					<code>inlierFrac · exp(−(err/0.2)²)</code>; below 0.35 the view is low
					trust, below 0.15 hidden. Neither is a pose check. Each object is then
					scaled to the DEM range where it touches the terrain.
				</p>
				<h3>Curvature is not a snap</h3>
				<p>
					{link("curvature-refraction", "Curvature and refraction")} lower every
					DEM sample by <code>d² / (2 R_eff)</code>,{" "}
					<code>R_eff = R / (1 − 0.13)</code>: under a metre at 3 km, about 680
					m at 100 km.
				</p>
				<p>
					<strong>Lesson.</strong> Snap only what the DEM knows better than the
					sensor. A lake level only rules out the water below it, so it is a
					bound. A GPS altitude is still evidence, so it stays a prior.
				</p>
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/engine.ts" />
					<CodeRef path="src/lib/deck/scene.ts" />
					<CodeRef path="src/lib/terrain.ts" />
					<CodeRef path="src/lib/geo/horizon.ts" />
					<CodeRef path="src/lib/geocam/lakes/floor.ts" />
					<CodeRef path="src/lib/concord/priors/altitude.ts" />
					<CodeRef path="src/lib/nearfield/anchor.ts" />
					<CodeRef path="src/lib/nearfield/ground.ts" />
					<CodeRef path="src/lib/nearfield/near-dem.ts" />
				</div>
			</Details>
		</>
	);
}
