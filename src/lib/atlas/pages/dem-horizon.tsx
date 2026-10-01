import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
	type AtlasPhotoData,
	type AtlasPhotoId,
	Callout,
	CodeRef,
	DemPatch,
	Figure,
	Measured,
	PhotoPicker,
	Plot,
	RealPhoto,
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
	Stages,
	skylineBand,
	Trio,
} from "#/components/atlas/viz/explain";
import type { AtlasNode } from "#/lib/atlas/types";
import { cameraFromAngles, directionENU, project } from "#/lib/geo/camera";

// DEM Horizon: how src/lib/geo/horizon.ts turns terrain into a 360 degree skyline.
// Mechanism constants are the real defaults in computeHorizon():
//   step 0.05 deg (7,200 azimuths), minDistance 20 m, maxDistance 150 km, ray step max(10 m, 0.4 % of d),
//   minOcclusion 0.08, angle = atan2(h - eye - d^2 / (2 R'), d), R' = R / (1 - k), k = 0.13 (geodesy.ts).
// "Measured" figures use the real computeHorizon output on the Niederhorn demo photos (public/demo/atlas,
// scripts/atlas/build-data.ts); the profile is the real 7,200-azimuth result sampled every 0.5 deg over the view.
// The two terrains below are synthetic and deterministic; every angle, drop and crest is computed from them by the
// same loop as the code (coarser ray step in the demo, so it stays light).

const R_EFF = 6371008.8 / (1 - 0.13);
const DEG = 180 / Math.PI;
const drop = (d: number) => (d * d) / (2 * R_EFF);
const MIN_OCC = 0.08;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const sgn = (v: number, d = 1) =>
	`${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;

// =====================================================================================
// Fig. 1: one ray, marched
// =====================================================================================
const EYE = 1500;
const DMAX = 60_000;
// [centre m, summit m, half-width km]
const RIDGES: [number, number, number][] = [
	[3500, 1650, 0.7],
	[10_000, 1900, 1.0],
	[16_500, 2050, 1.2],
	[26_000, 2900, 1.6],
	[50_000, 4200, 1.8],
];
function terrainH(d: number) {
	let e = 1250 + 250 * Math.sin(d / 2300) + 180 * Math.sin(d / 890 + 1);
	for (const [c, H, w] of RIDGES) {
		const z = (d - c) / (w * 1000);
		if (Math.abs(z) < 4) e = Math.max(e, H * Math.exp(-z * z));
	}
	return e;
}

interface Sample {
	d: number;
	h: number;
	angle: number;
	best: number;
	bestD: number;
	isBest: boolean;
}
interface RayRun {
	samples: Sample[];
	crests: { d: number; angle: number; h: number }[];
}
/** The inner loop of computeHorizon, for one azimuth. */
function marchRay(curv: boolean): RayRun {
	const samples: Sample[] = [];
	const crests: RayRun["crests"] = [];
	let best = -90;
	let bestD = 0;
	let crest: { d: number; angle: number; h: number } | null = null;
	let prevVisible = false;
	for (let d = 20; d <= DMAX; d += Math.max(10, d * 0.01)) {
		const h = terrainH(d);
		const hEff = h - (curv ? drop(d) : 0);
		const angle = Math.atan2(hEff - EYE, d) * DEG;
		let isBest = false;
		if (angle > best) {
			isBest = true;
			best = angle;
			bestD = d;
			if (!prevVisible && crest && d - crest.d > MIN_OCC * crest.d)
				crests.push(crest);
			crest = { d, angle, h: hEff };
			prevVisible = true;
		} else prevVisible = false;
		samples.push({ d, h: hEff, angle, best, bestD, isBest });
	}
	return { samples, crests };
}
const RAY = { on: marchRay(true), off: marchRay(false) };

const FW = 640;
const FH = 372;
const PX0 = 46;
const PX1 = 628;
const TOP = { y0: 16, y1: 206, lo: 900, hi: 4500 };
const BOT = { y0: 252, y1: 344, lo: -1.5, hi: 4.5 };
const xD = (d: number) => PX0 + (d / DMAX) * (PX1 - PX0);
const yH = (h: number) =>
	TOP.y1 - ((h - TOP.lo) / (TOP.hi - TOP.lo)) * (TOP.y1 - TOP.y0);
const yA = (a: number) =>
	BOT.y1 -
	((clamp(a, BOT.lo, BOT.hi) - BOT.lo) / (BOT.hi - BOT.lo)) * (BOT.y1 - BOT.y0);

const TERRAIN_PATH = (curv: boolean) => {
	const pts: string[] = [];
	for (let d = 0; d <= DMAX; d += 120)
		pts.push(
			`L${xD(d).toFixed(1)} ${yH(terrainH(d) - (curv ? drop(d) : 0)).toFixed(1)}`,
		);
	return `M${PX0} ${TOP.y1 + 10} ${pts.join(" ")} L${PX1} ${TOP.y1 + 10} Z`;
};
const TERRAIN = { on: TERRAIN_PATH(true), off: TERRAIN_PATH(false) };

function RayMarch() {
	const [ref, t] = useTime<HTMLDivElement>(9);
	const [curv, setCurv] = useState(true);
	const [manual, setManual] = useState<number | null>(null);
	const run = curv ? RAY.on : RAY.off;
	const other = curv ? RAY.off : RAY.on;

	const ph = t % 12.5;
	const auto = clamp(ph / 9.5, 0, 1) * DMAX;
	const cur = manual ?? auto;
	let idx = 0;
	while (idx < run.samples.length - 1 && run.samples[idx + 1].d <= cur) idx++;
	const S = run.samples[idx];
	const upto = run.samples.slice(0, idx + 1);
	const done = idx >= run.samples.length - 2;
	const finalBest = run.samples[run.samples.length - 1];
	const otherBest = other.samples[other.samples.length - 1];
	const crests = run.crests.filter((c) => c.d <= S.d);
	const newBests = upto.filter((s) => s.isBest);

	const tanB = Math.tan((S.best * Math.PI) / 180);
	const lineEnd = DMAX;
	const sight = `M${xD(0)} ${yH(EYE)} L${xD(lineEnd)} ${yH(EYE + lineEnd * tanB)}`;
	const wedge = `M${xD(0)} ${yH(EYE)} L${xD(lineEnd)} ${yH(EYE + lineEnd * tanB)} L${xD(lineEnd)} ${TOP.y1} L${xD(0)} ${TOP.y1} Z`;
	const stair = upto
		.filter((_, i) => i % 3 === 0 || i === upto.length - 1)
		.map(
			(s, i) =>
				`${i ? "L" : "M"}${xD(s.d).toFixed(1)} ${yA(s.best).toFixed(1)}`,
		)
		.join(" ");
	const angleLine = upto
		.filter((_, i) => i % 2 === 0)
		.map(
			(s, i) =>
				`${i ? "L" : "M"}${xD(s.d).toFixed(1)} ${yA(s.angle).toFixed(1)}`,
		)
		.join(" ");
	const flips = Math.abs(finalBest.bestD - otherBest.bestD) > 2000;

	return (
		<Figure
			label="Synthetic 1"
			bleed
			caption="Synthetic scene, real algorithm (the real ray is Fig. 2). One azimuth, marched exactly as computeHorizon does (the demo samples every 1 % of distance instead of 0.4 %). Top: heights above the eye's sight plane, with curvature and refraction applied. Bottom: the elevation angle of every sample, and the running maximum that becomes the skyline. Drag the slider to scrub; toggle the Earth to watch the skyline jump."
		>
			<div ref={ref}>
				<svg
					viewBox={`0 0 ${FW} ${FH}`}
					className="block h-auto w-full"
					role="img"
					aria-label="Side view of a ray marched over terrain with its running-maximum elevation angle"
				>
					<defs>
						<linearGradient id="dh-land" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0" stopColor="#5a6770" />
							<stop offset="1" stopColor="#1c2226" />
						</linearGradient>
						<clipPath id="dh-clipb">
							<rect
								x={PX0}
								y={BOT.y0 - 4}
								width={PX1 - PX0}
								height={BOT.y1 - BOT.y0 + 8}
							/>
						</clipPath>
						<clipPath id="dh-clipt">
							<rect
								x={PX0}
								y={TOP.y0 - 6}
								width={PX1 - PX0}
								height={TOP.y1 - TOP.y0 + 16}
							/>
						</clipPath>
					</defs>
					{/* top panel */}
					<rect
						x={PX0}
						y={TOP.y0 - 6}
						width={PX1 - PX0}
						height={TOP.y1 - TOP.y0 + 16}
						fill="#0a0c0d"
						rx="6"
					/>
					{[0, 10, 20, 30, 40, 50, 60].map((km) => (
						<g key={km}>
							<line
								x1={xD(km * 1000)}
								x2={xD(km * 1000)}
								y1={TOP.y0 - 6}
								y2={BOT.y1}
								stroke="#fff"
								strokeOpacity="0.06"
							/>
							<text
								x={xD(km * 1000)}
								y={BOT.y1 + 16}
								textAnchor="middle"
								fontSize="9.5"
								fill="#fff"
								fillOpacity="0.4"
								fontFamily="ui-monospace,monospace"
							>
								{km}
								{km === 60 ? " km" : ""}
							</text>
						</g>
					))}
					<g clipPath="url(#dh-clipt)">
						<path d={TERRAIN[curv ? "on" : "off"]} fill="url(#dh-land)" />
						<path d={wedge} fill="var(--accent)" fillOpacity="0.1" />
						<path
							d={sight}
							stroke="var(--accent)"
							strokeWidth="1.4"
							fill="none"
							strokeDasharray="5 4"
						/>
						{/* the sample the marcher is on */}
						<line
							x1={xD(0)}
							y1={yH(EYE)}
							x2={xD(S.d)}
							y2={yH(S.h)}
							stroke="#ece6da"
							strokeOpacity="0.55"
							strokeWidth="1"
						/>
						{newBests.map((s) => (
							<circle
								key={s.d}
								cx={xD(s.d)}
								cy={yH(s.h)}
								r="2.2"
								fill="var(--accent)"
							/>
						))}
						{crests.map((c) => (
							<circle
								key={c.d}
								cx={xD(c.d)}
								cy={yH(c.h)}
								r="5.5"
								fill="none"
								stroke="#ece6da"
								strokeWidth="1.4"
							/>
						))}
						<circle
							cx={xD(S.bestD)}
							cy={yH(EYE + S.bestD * tanB)}
							r="4.5"
							fill="var(--accent)"
							stroke="#0e1012"
							strokeWidth="1.5"
						/>
						<circle cx={xD(S.d)} cy={yH(S.h)} r="3.2" fill="#ece6da" />
					</g>
					<circle cx={xD(0)} cy={yH(EYE)} r="4" fill="#ece6da" />
					<text
						x={PX0 + 8}
						y={yH(EYE) - 9}
						fontSize="10"
						fill="#ece6da"
						fontFamily="ui-monospace,monospace"
					>
						eye
					</text>
					<text
						x={PX1 - 4}
						y={TOP.y0 + 8}
						textAnchor="end"
						fontSize="9.5"
						fill="#fff"
						fillOpacity="0.4"
						fontFamily="ui-monospace,monospace"
					>
						height {curv ? "minus d²/2R′" : "(flat earth)"}
					</text>
					{/* bottom panel */}
					<rect
						x={PX0}
						y={BOT.y0 - 4}
						width={PX1 - PX0}
						height={BOT.y1 - BOT.y0 + 8}
						fill="#0a0c0d"
						rx="6"
					/>
					{[0, 2, 4].map((a) => (
						<g key={a}>
							<line
								x1={PX0}
								x2={PX1}
								y1={yA(a)}
								y2={yA(a)}
								stroke="#fff"
								strokeOpacity="0.07"
							/>
							<text
								x={PX0 - 6}
								y={yA(a) + 3}
								textAnchor="end"
								fontSize="9.5"
								fill="#fff"
								fillOpacity="0.4"
								fontFamily="ui-monospace,monospace"
							>
								{a}&deg;
							</text>
						</g>
					))}
					<g clipPath="url(#dh-clipb)">
						<path
							d={angleLine}
							fill="none"
							stroke="#ece6da"
							strokeOpacity="0.45"
							strokeWidth="1"
						/>
						<path
							d={stair}
							fill="none"
							stroke="var(--accent)"
							strokeWidth="2.2"
						/>
						<line
							x1={xD(S.d)}
							x2={xD(S.d)}
							y1={BOT.y0 - 4}
							y2={BOT.y1 + 4}
							stroke="#ece6da"
							strokeOpacity="0.3"
						/>
					</g>
					<text
						x={PX1 - 4}
						y={BOT.y0 + 8}
						textAnchor="end"
						fontSize="9.5"
						fill="var(--accent)"
						fontFamily="ui-monospace,monospace"
					>
						running max = skyline
					</text>
					<text
						x={PX0 + 6}
						y={BOT.y0 + 8}
						fontSize="9.5"
						fill="#fff"
						fillOpacity="0.4"
						fontFamily="ui-monospace,monospace"
					>
						elevation angle of each sample
					</text>
				</svg>

				<div className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-[1fr_auto]">
					<label className="block">
						<span className="flex justify-between font-mono text-[11px] text-white/45">
							<span>distance along the ray</span>
							<span className="text-[var(--rigi-paper)]">
								{(S.d / 1000).toFixed(1)} km
							</span>
						</span>
						<input
							type="range"
							min={0}
							max={DMAX}
							step={100}
							value={cur}
							aria-label="Distance along the ray"
							onChange={(e) => setManual(Number(e.target.value))}
							className="mt-1 w-full accent-[var(--accent)]"
						/>
					</label>
					<div className="flex items-end gap-2 font-mono text-[11px]">
						<button
							type="button"
							onClick={() => setCurv((v) => !v)}
							className="rounded-full px-3 py-1.5 ring-1 ring-white/20 hover:ring-white/40"
							style={{
								background: curv
									? "color-mix(in srgb, var(--accent) 25%, transparent)"
									: "transparent",
								color: "var(--rigi-paper)",
							}}
							aria-pressed={curv}
						>
							curvature + refraction {curv ? "on" : "off"}
						</button>
						{manual != null && (
							<button
								type="button"
								onClick={() => setManual(null)}
								className="rounded-full px-3 py-1.5 text-white/60 ring-1 ring-white/15 hover:text-white"
							>
								play
							</button>
						)}
					</div>
				</div>
				<dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-[11px] sm:grid-cols-4">
					<Read k="this sample" v={`${sgn(S.angle, 2)}°`} />
					<Read
						k="drop at d"
						v={curv ? `${drop(S.d).toFixed(0)} m` : "0 m (off)"}
					/>
					<Read
						k="skyline so far"
						v={`${sgn(S.best, 2)}° at ${(S.bestD / 1000).toFixed(1)} km`}
					/>
					<Read k="crests kept" v={String(crests.length)} />
				</dl>
				{done && (
					<p className="mt-3 text-[13px] leading-relaxed text-white/55">
						{curv ? "With" : "Without"} the Earth bending away, this ray&rsquo;s
						skyline is{" "}
						<span className="text-[var(--rigi-paper)]">
							{(finalBest.bestD / 1000).toFixed(1)} km
						</span>{" "}
						out at {sgn(finalBest.best, 2)}&deg;
						{flips
							? `; the other setting would put it at ${(otherBest.bestD / 1000).toFixed(1)} km, ${sgn(otherBest.best, 2)}°.`
							: "."}
					</p>
				)}
			</div>
		</Figure>
	);
}

function Read({ k, v }: { k: string; v: string }) {
	return (
		<div>
			<dt className="text-white/40">{k}</dt>
			<dd className="text-[13px] text-[var(--rigi-paper)]">{v}</dd>
		</div>
	);
}

// =====================================================================================
// Fig. 2: the azimuth sweep: top-down relief on the left, the skyline growing on the right
// =====================================================================================
const EYE2 = 1400;
// [east km, north km, summit m, sigma km]
const PEAKS: [number, number, number, number][] = [
	[2, 6, 2200, 0.9],
	[-6, 9, 2600, 1.2],
	[11, 4, 2900, 1.5],
	[14, -9, 3300, 1.8],
	[-12, -5, 2400, 1.3],
	[-3, -14, 3000, 1.6],
	[5, 18, 3400, 2.0],
	[-17, 15, 3600, 2.2],
	[24, 8, 3800, 2.4],
	[-24, -10, 3500, 2.2],
	[0, -28, 3900, 2.5],
	[-9, 26, 3300, 2.0],
	[20, -20, 3500, 2.3],
];
function height2(x: number, y: number) {
	let e =
		1350 + 120 * Math.sin(x * 0.9 + y * 0.4) + 90 * Math.sin(y * 1.3 - x * 0.5);
	for (const [px, py, H, s] of PEAKS) {
		const dx = (x - px) / s;
		const dy = (y - py) / s;
		const q = dx * dx + dy * dy;
		if (q < 14) e = Math.max(e, H * Math.exp(-q * 0.5));
	}
	return e;
}
const NAZ = 360;
const MAXKM = 40;
interface Sky {
	elev: number[];
	dist: number[];
	ridges: { az: number; angle: number; d: number }[];
}
let skyCache: Sky | null = null;
function sky(): Sky {
	if (skyCache) return skyCache;
	const elev: number[] = [];
	const dist: number[] = [];
	const ridges: Sky["ridges"] = [];
	const ds: number[] = [];
	for (let d = 0.1; d <= MAXKM; d += Math.max(0.05, d * 0.02)) ds.push(d);
	for (let i = 0; i < NAZ; i++) {
		const az = (i / NAZ) * 2 * Math.PI;
		const sx = Math.sin(az);
		const sy = Math.cos(az);
		let best = -90;
		let bd = 0;
		let crest: { d: number; angle: number } | null = null;
		let prev = false;
		for (const d of ds) {
			const h = height2(sx * d, sy * d);
			const angle = Math.atan2(h - EYE2 - drop(d * 1000), d * 1000) * DEG;
			if (angle > best) {
				if (!prev && crest && d - crest.d > MIN_OCC * crest.d)
					ridges.push({ az: i, angle: crest.angle, d: crest.d });
				best = angle;
				bd = d;
				crest = { d, angle };
				prev = true;
			} else prev = false;
		}
		elev.push(best);
		dist.push(bd);
	}
	skyCache = { elev, dist, ridges };
	return skyCache;
}

const MS = 300; // map svg size
const MR = 136; // map radius px for MAXKM
const mx = (km: number) => MS / 2 + (km / MAXKM) * MR;
const my = (km: number) => MS / 2 - (km / MAXKM) * MR;

function Sweep() {
	const [ref, t] = useTime<HTMLDivElement>(10);
	const [manual, setManual] = useState<number | null>(null);
	const S = sky();
	const ph = t % 14;
	const auto = clamp(ph / 10.5, 0, 1) * NAZ;
	const cur = manual ?? auto;
	const k = Math.min(NAZ - 1, Math.floor(cur));
	const full = cur >= NAZ - 1;

	const lo = -4;
	const hi = 24;
	const PW = 560;
	const PH = 200;
	const ax = (i: number) => 28 + (i / NAZ) * (PW - 36);
	const ay = (a: number) =>
		PH - 22 - ((clamp(a, lo, hi) - lo) / (hi - lo)) * (PH - 40);

	const skylinePath = (() => {
		let p = `M${ax(0)} ${PH - 22}`;
		for (let i = 0; i <= k; i++)
			p += ` L${ax(i).toFixed(1)} ${ay(S.elev[i]).toFixed(1)}`;
		return `${p} L${ax(k).toFixed(1)} ${PH - 22} Z`;
	})();
	const segs = [];
	for (let i = 1; i <= k; i++)
		segs.push(
			<line
				key={i}
				x1={ax(i - 1)}
				y1={ay(S.elev[i - 1])}
				x2={ax(i)}
				y2={ay(S.elev[i])}
				stroke="var(--accent)"
				strokeOpacity={0.35 + 0.65 * (1 - Math.min(1, S.dist[i] / MAXKM))}
				strokeWidth="2"
			/>,
		);
	const ridgesShown = S.ridges.filter((r) => r.az <= k);
	const azRad = (cur / NAZ) * 2 * Math.PI;
	const hit = (i: number) => {
		const a = (i / NAZ) * 2 * Math.PI;
		return [mx(Math.sin(a) * S.dist[i]), my(Math.cos(a) * S.dist[i])] as const;
	};
	const trail = (() => {
		let p = "";
		for (let i = 0; i <= k; i++) {
			const [x, y] = hit(i);
			p += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)} `;
		}
		return p;
	})();
	const cardinal = ["N", "E", "S", "W"];

	return (
		<Figure
			label="Synthetic 2"
			bleed
			caption={`Synthetic scene, real algorithm. Every azimuth gets its own ray. Left: the terrain from above, the sweeping ray, and where each ray's skyline actually sits (the trail). Right: the same rays unrolled into the 360° profile; brighter means nearer, rings are the ridge crests behind the skyline. The real thing does ${"7,200"} azimuths at 0.05° and up to 150 km; this demo does ${NAZ} at 1° and ${MAXKM} km.`}
		>
			<div ref={ref}>
				<div className="grid items-center gap-4 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)]">
					<svg
						viewBox={`0 0 ${MS} ${MS}`}
						className="mx-auto block h-auto w-full max-w-[300px]"
						role="img"
						aria-label="Top-down map with a sweeping ray and the skyline trail"
					>
						<defs>
							<radialGradient id="dh-peak">
								<stop offset="0" stopColor="#d9d3c4" stopOpacity="0.9" />
								<stop offset="0.5" stopColor="#8a949a" stopOpacity="0.4" />
								<stop offset="1" stopColor="#4b565d" stopOpacity="0" />
							</radialGradient>
						</defs>
						<circle
							cx={MS / 2}
							cy={MS / 2}
							r={MR}
							fill="#0a0c0d"
							stroke="#fff"
							strokeOpacity="0.1"
						/>
						{PEAKS.map(([x, y, H, s]) => (
							<circle
								key={`${x},${y}`}
								cx={mx(x)}
								cy={my(y)}
								r={(s * 2.6 * MR) / MAXKM}
								fill="url(#dh-peak)"
								opacity={0.35 + ((H - 2200) / 1700) * 0.65}
							/>
						))}
						{[10, 20, 30, 40].map((km) => (
							<circle
								key={km}
								cx={MS / 2}
								cy={MS / 2}
								r={(km / MAXKM) * MR}
								fill="none"
								stroke="#fff"
								strokeOpacity="0.09"
								strokeDasharray="2 4"
							/>
						))}
						{[0, 1, 2, 3].map((q) => {
							const a = (q * Math.PI) / 2;
							return (
								<text
									key={q}
									x={MS / 2 + Math.sin(a) * (MR + 10)}
									y={MS / 2 - Math.cos(a) * (MR + 10) + 4}
									textAnchor="middle"
									fontSize="10"
									fill="#fff"
									fillOpacity="0.4"
									fontFamily="ui-monospace,monospace"
								>
									{cardinal[q]}
								</text>
							);
						})}
						<path
							d={trail}
							fill="none"
							stroke="var(--accent)"
							strokeWidth="1.6"
							strokeLinejoin="round"
						/>
						{ridgesShown.map((r) => {
							const a = (r.az / NAZ) * 2 * Math.PI;
							return (
								<circle
									key={`${r.az}-${r.d}`}
									cx={mx(Math.sin(a) * r.d)}
									cy={my(Math.cos(a) * r.d)}
									r="1.6"
									fill="#ece6da"
									opacity="0.8"
								/>
							);
						})}
						{!full && (
							<>
								<path
									d={`M${MS / 2} ${MS / 2} L${MS / 2 + Math.sin(azRad - 0.14) * MR} ${MS / 2 - Math.cos(azRad - 0.14) * MR} A${MR} ${MR} 0 0 1 ${MS / 2 + Math.sin(azRad) * MR} ${MS / 2 - Math.cos(azRad) * MR} Z`}
									fill="var(--accent)"
									fillOpacity="0.16"
								/>
								<line
									x1={MS / 2}
									y1={MS / 2}
									x2={MS / 2 + Math.sin(azRad) * MR}
									y2={MS / 2 - Math.cos(azRad) * MR}
									stroke="var(--accent)"
									strokeWidth="1.5"
								/>
							</>
						)}
						<circle cx={MS / 2} cy={MS / 2} r="4" fill="#ece6da" />
					</svg>
					<svg
						viewBox={`0 0 ${PW} ${PH}`}
						className="block h-auto w-full"
						role="img"
						aria-label="The 360 degree skyline profile growing with the sweep"
					>
						<rect
							x="28"
							y="6"
							width={PW - 36}
							height={PH - 28}
							fill="#0a0c0d"
							rx="6"
						/>
						{[0, 10, 20].map((a) => (
							<g key={a}>
								<line
									x1="28"
									x2={PW - 8}
									y1={ay(a)}
									y2={ay(a)}
									stroke="#fff"
									strokeOpacity="0.07"
								/>
								<text
									x="23"
									y={ay(a) + 3}
									textAnchor="end"
									fontSize="9.5"
									fill="#fff"
									fillOpacity="0.4"
									fontFamily="ui-monospace,monospace"
								>
									{a}&deg;
								</text>
							</g>
						))}
						{[0, 90, 180, 270, 360].map((a) => (
							<text
								key={a}
								x={ax((a / 360) * NAZ)}
								y={PH - 8}
								textAnchor="middle"
								fontSize="9.5"
								fill="#fff"
								fillOpacity="0.4"
								fontFamily="ui-monospace,monospace"
							>
								{a}&deg;
							</text>
						))}
						<path d={skylinePath} fill="var(--accent)" fillOpacity="0.1" />
						{segs}
						{ridgesShown.map((r) => (
							<circle
								key={`${r.az}-${r.angle}`}
								cx={ax(r.az)}
								cy={ay(r.angle)}
								r="2.6"
								fill="none"
								stroke="#ece6da"
								strokeWidth="1.1"
								opacity="0.85"
							/>
						))}
						<line
							x1={ax(cur)}
							x2={ax(cur)}
							y1="6"
							y2={PH - 22}
							stroke="#ece6da"
							strokeOpacity="0.35"
						/>
					</svg>
				</div>
				<div className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-[1fr_auto]">
					<label className="block">
						<span className="flex justify-between font-mono text-[11px] text-white/45">
							<span>azimuth</span>
							<span className="text-[var(--rigi-paper)]">
								{k}&deg; &middot; skyline {sgn(S.elev[k], 1)}&deg; at{" "}
								{S.dist[k].toFixed(1)} km
							</span>
						</span>
						<input
							type="range"
							min={0}
							max={NAZ - 1}
							step={1}
							value={cur}
							aria-label="Azimuth"
							onChange={(e) => setManual(Number(e.target.value))}
							className="mt-1 w-full accent-[var(--accent)]"
						/>
					</label>
					{manual != null && (
						<button
							type="button"
							onClick={() => setManual(null)}
							className="self-end rounded-full px-3 py-1.5 font-mono text-[11px] text-white/60 ring-1 ring-white/15 hover:text-white"
						>
							play
						</button>
					)}
				</div>
			</div>
		</Figure>
	);
}

// =====================================================================================
// Measured figures: the real horizon on a real photo
// =====================================================================================
const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;
/** Near = warm yellow, far = cool blue, log scale 0.3 km .. 150 km. */
function distColor(d: number) {
	const t = clamp(Math.log(d / 300) / Math.log(150_000 / 300), 0, 1);
	return `hsl(${lerpN(46, 222, t).toFixed(0)} ${lerpN(80, 85, t).toFixed(0)}% ${lerpN(64, 68, t).toFixed(0)}%)`;
}
const km = (d: number) =>
	d < 10_000 ? `${(d / 1000).toFixed(1)}` : `${Math.round(d / 1000)}`;

function DistLegend() {
	return (
		<div className="flex items-center gap-2 font-mono text-[10.5px] text-white/55">
			<span>near</span>
			<span
				className="h-1.5 w-28 rounded-full"
				style={{
					background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => distColor(300 * (150_000 / 300) ** t)).join(",")})`,
				}}
			/>
			<span>far (0.3 to 150 km)</span>
		</div>
	);
}

function viewBand(d: AtlasPhotoData): [number, number, number, number] {
	const { width: W, height: H } = d.photo;
	const ys = d.skyline.rows
		.filter((v): v is number => v != null)
		.sort((a, b) => a - b);
	if (!ys.length) return [0, 0, W, H];
	const lo = ys[Math.floor(ys.length * 0.02)];
	const hi = ys[Math.floor(ys.length * 0.98)];
	const bh = Math.min(H, Math.max(320, hi - lo + 260));
	const y0 = Math.max(0, Math.min(H - bh, lo - 80));
	return [0, Math.round(y0), W, Math.round(y0 + bh)];
}

function useCam(d: AtlasPhotoData | null) {
	return useMemo(() => {
		if (!d) return null;
		const s = d.solved;
		return cameraFromAngles({
			width: d.photo.width,
			height: d.photo.height,
			f: s.f,
			yaw: s.yaw,
			pitch: s.pitch,
			roll: s.roll,
		});
	}, [d]);
}

/** Skyline + inner ridge crests, in photo px, coloured by distance. */
function HorizonOverlay({
	d,
	cam,
	k,
}: {
	d: AtlasPhotoData;
	cam: ReturnType<typeof useCam>;
	k: number;
}) {
	if (!cam) return null;
	const pts = d.horizon.profile.map((p) => ({
		d: p.d,
		q: project(cam, directionENU(p.az, p.el)),
		ridges: p.ridges,
		az: p.az,
	}));
	const W = d.photo.width;
	return (
		<g>
			{[0, 1].map((pass) =>
				pts.map((p, i) => {
					const r = pts[i + 1];
					if (!p.q || !r?.q) return null;
					if (Math.abs(r.q[1] - p.q[1]) > 60 || p.q[0] > W + 20 || r.q[0] < -20)
						return null;
					return (
						<line
							key={`s${pass}-${p.az}`}
							x1={p.q[0]}
							y1={p.q[1]}
							x2={r.q[0]}
							y2={r.q[1]}
							stroke={pass ? distColor(p.d) : "#0e1012"}
							strokeOpacity={pass ? 1 : 0.6}
							strokeWidth={(pass ? 2.4 : 4.4) * k}
							strokeLinecap="round"
						/>
					);
				}),
			)}
			{pts.flatMap((p) =>
				p.ridges.map(([el, dd]) => {
					const q = project(cam, directionENU(p.az, el));
					if (!q || q[0] < 0 || q[0] > W || q[1] < 0 || q[1] > d.photo.height)
						return null;
					return (
						<circle
							key={`r${p.az}-${dd}`}
							cx={q[0]}
							cy={q[1]}
							r={2.2 * k}
							fill={distColor(dd)}
							stroke="#0e1012"
							strokeWidth={0.8 * k}
						/>
					);
				}),
			)}
		</g>
	);
}

function ProfilePlot({ d }: { d: AtlasPhotoData }) {
	const prof = d.horizon.profile;
	const a0 = prof[0].az;
	const unwrap = (az: number) => (az < a0 ? az + 360 : az);
	const xs = prof.map((p) => unwrap(p.az));
	const x1 = xs[xs.length - 1];
	const els = prof.map((p) => p.el);
	const ymin = Math.floor(Math.min(...els)) - 6;
	const ymax = Math.ceil(Math.max(...els)) + 2;
	const yaw = unwrap(d.solved.yaw);
	const half = d.solved.hfov / 2;
	return (
		<Plot
			x={[a0, x1]}
			y={[ymin, ymax]}
			width={640}
			height={250}
			xLabel="azimuth (deg from north)"
			yLabel="elevation (deg)"
			fmtX={(v) => `${Math.round(v) % 360}`}
			fmtY={(v) => `${Math.round(v)}`}
		>
			{(s) => (
				<g>
					<rect
						x={s.x(yaw - half)}
						y={s.box.y0}
						width={s.x(yaw + half) - s.x(yaw - half)}
						height={s.box.y1 - s.box.y0}
						fill="#5ee0f4"
						fillOpacity={0.08}
					/>
					<text
						x={s.x(yaw)}
						y={s.box.y0 + 12}
						textAnchor="middle"
						fontSize={10}
						fill="#5ee0f4"
						fillOpacity={0.8}
						fontFamily="ui-monospace, monospace"
					>
						in the photo
					</text>
					{prof.flatMap((p, i) =>
						p.ridges
							.filter(([el]) => el > ymin)
							.map(([el, dd]) => (
								<circle
									key={`${p.az}-${dd}`}
									cx={s.x(xs[i])}
									cy={s.y(el)}
									r={1.8}
									fill={distColor(dd)}
									fillOpacity={0.85}
								/>
							)),
					)}
					{prof.slice(1).map((p, i) => (
						<line
							key={p.az}
							x1={s.x(xs[i])}
							y1={s.y(prof[i].el)}
							x2={s.x(xs[i + 1])}
							y2={s.y(p.el)}
							stroke={distColor(p.d)}
							strokeWidth={2.6}
							strokeLinecap="round"
						/>
					))}
				</g>
			)}
		</Plot>
	);
}

function RealHorizon({
	id,
	setId,
	d,
}: {
	id: AtlasPhotoId;
	setId: (i: AtlasPhotoId) => void;
	d: AtlasPhotoData | null;
}) {
	const idx = useAtlasIndex();
	const cam = useCam(d);
	const crop = useMemo(() => (d ? viewBand(d) : undefined), [d]);
	const k = crop && d ? (crop[2] - crop[0]) / d.photo.width : 1;
	const dists = d?.horizon.profile.map((p) => p.d) ?? [];
	const inView = d
		? d.horizon.profile.filter(
				(p) =>
					Math.abs(((p.az - d.solved.yaw + 540) % 360) - 180) <=
					d.solved.hfov / 2,
			)
		: [];
	const nearest = inView.length ? Math.min(...inView.map((p) => p.d)) : 0;
	const farthest = inView.length ? Math.max(...inView.map((p) => p.d)) : 0;
	const nRidge = inView.reduce((a, p) => a + p.ridges.length, 0);
	void dists;
	return (
		<Figure
			label="Fig. 3"
			bleed
			caption={
				<>
					Try any of the 12 photos. Line and dots: the map&rsquo;s skyline and
					the ridges behind it, coloured by distance. Below, the same curve as
					angle against bearing; the shaded band is what the photo sees.{" "}
					<Measured data={d} />
				</>
			}
		>
			<PhotoPicker
				value={id}
				onChange={setId}
				mark={(i) => {
					const p = idx?.photos.find((q) => q.id === i);
					return p ? (
						<span className="rounded bg-black/60 px-1 font-mono text-[8px] text-white/80">
							{(p.ms.horizon / 1000).toFixed(1)}s
						</span>
					) : null;
				}}
			/>
			<RealPhoto data={d} layers={[]} crop={crop}>
				{(dd) => <HorizonOverlay d={dd} cam={cam} k={k} />}
			</RealPhoto>
			<div className="mt-3 flex flex-wrap items-center justify-between gap-2">
				<DistLegend />
				{d && (
					<span className="font-mono text-[11px] text-white/60">
						in view: skyline from{" "}
						<span className="text-white/90">{km(nearest)} km</span> to{" "}
						<span className="text-white/90">{km(farthest)} km</span>, {nRidge}{" "}
						inner crests
					</span>
				)}
			</div>
			<div className="mt-3">{d && <ProfilePlot d={d} />}</div>
			{d && (
				<p className="mt-1 font-mono text-[11px] text-white/55">
					The full 360° took{" "}
					<span className="text-white/90">
						{(d.ms.horizon / 1000).toFixed(1)} s
					</span>{" "}
					on CPU; the plot keeps {d.horizon.profile.length} of 7,200 bearings.
				</p>
			)}
		</Figure>
	);
}
// =====================================================================================
// Explainer page: hero stages, ladder figure, trio, failures, numbers
// =====================================================================================
const median = (v: number[]) => {
	const s = [...v].sort((a, b) => a - b);
	return s.length
		? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2
		: Number.NaN;
};

/** Hero: one real photo, the terrain's skyline drawn from the map alone, then against the photo's own. */
function HeroStages() {
	const d = useAtlasPhoto("demo-03");
	const cam = useCam(d);
	const crop = useMemo(() => (d ? viewBand(d) : undefined), [d]);
	const k = crop && d ? (crop[2] - crop[0]) / d.photo.width : 1;
	return (
		<Figure
			label="Fig. 1"
			caption={
				<>
					{d
						? `Drawn from the map alone, the skyline lands within ${d.residual.solved.median.toFixed(1)} px of the photo's (median over columns, 800 px wide).`
						: "Drawn from the map alone, the skyline lands on the photo's."}{" "}
					<Measured data={d} />
				</>
			}
		>
			<Stages
				stages={[
					{
						label: "Photo",
						caption: "A phone photo, and a map of the same mountains.",
						render: () => <RealPhoto data={d} layers={[]} crop={crop} />,
					},
					{
						label: "Terrain's skyline",
						caption:
							"We draw the skyline the map predicts. Warm is near, cool is far.",
						render: () => (
							<RealPhoto data={d} layers={[]} crop={crop}>
								{(dd) => <HorizonOverlay d={dd} cam={cam} k={k} />}
							</RealPhoto>
						),
					},
					{
						label: "Against the photo",
						caption: (
							<>
								<Key color="#5ee0f4">map</Key> and{" "}
								<Key color="#f4d35e">photo</Key> nearly coincide.
							</>
						),
						render: () => (
							<RealPhoto data={d} layers={["skyline", "solved"]} crop={crop} />
						),
					},
				]}
			/>
		</Figure>
	);
}

/** Best sight line over the profile along the view axis, with the Earth's drop scaled by c (0 flat, 1 real). */
function sight(d: AtlasPhotoData, c: number) {
	const eye = d.gps.eye;
	let el = -90;
	let dist = 0;
	let h = 0;
	for (const [dd, hh] of d.terrainProfile.points) {
		if (dd < 20) continue;
		const a = Math.atan2(hh - eye - c * drop(dd), dd) * DEG;
		if (a > el) {
			el = a;
			dist = dd;
			h = hh - c * drop(dd);
		}
	}
	return { el, d: dist, h };
}

/** Ladder of abstraction: the photo's centre column, then the side view of the ground under that sight line. */
function Ladder() {
	const d = useAtlasPhoto("demo-03");
	const cam = useCam(d);
	const [c, setC] = useState(1);
	const crop = useMemo(() => (d ? viewBand(d) : undefined), [d]);
	if (!d)
		return (
			<Figure label="Fig. 2" caption="Loading measured data.">
				<div className="aspect-[4/3] animate-pulse rounded-xl bg-white/[0.04]" />
			</Figure>
		);
	const tp = d.terrainProfile;
	const eye = d.gps.eye;
	const dmax = Math.max(...tp.points.map((p) => p[0]));
	const live = sight(d, c);
	const flat = sight(d, 0);
	const real = sight(d, 1);
	const shiftDeg = flat.el - real.el;
	const shiftPx = d.solved.f * ((shiftDeg * Math.PI) / 180);
	const pts: [number, number][] = tp.points.map(([dd, h]) => [
		dd / 1000,
		h - c * drop(dd),
	]);
	const ys = tp.points.flatMap(([dd, h]) => [h, h - drop(dd)]);
	const ymin = Math.floor(Math.min(...ys, eye) / 500) * 500;
	const ymax =
		Math.ceil(Math.max(...ys, eye, flat.h, real.h) / 500) * 500 + 500;
	const q = cam ? project(cam, directionENU(tp.azimuth, real.el)) : null;
	const k = crop ? (crop[2] - crop[0]) / d.photo.width : 1;
	const rayTo = (s: { el: number; d: number }): [number, number] => [
		s.d / 1000,
		eye + s.d * Math.tan((s.el * Math.PI) / 180),
	];
	return (
		<Figure
			label="Fig. 2"
			caption={
				<>
					Earth&rsquo;s curve lowers this crest by {shiftDeg.toFixed(2)}°, about{" "}
					{shiftPx.toFixed(1)} px here, and more for farther peaks.{" "}
					<Measured data={d} />
				</>
			}
		>
			<RealPhoto data={d} layers={[]} crop={crop}>
				{(dd) => (
					<>
						<HorizonOverlay d={dd} cam={cam} k={k} />
						{q && (
							<>
								<line
									x1={q[0]}
									x2={q[0]}
									y1={0}
									y2={dd.photo.height}
									stroke="#ece6da"
									strokeOpacity={0.55}
									strokeDasharray="5 5"
								/>
								<Mark x={q[0]} y={q[1]} n={2} k={1.4 * k} />
							</>
						)}
					</>
				)}
			</RealPhoto>
			<div className="mt-3">
				<Plot
					x={[0, dmax / 1000]}
					y={[ymin, ymax]}
					width={640}
					height={260}
					xLabel="distance along the dashed column (km)"
					yLabel="height (m)"
					fmtX={(v) => `${Math.round(v)}`}
					fmtY={(v) => `${Math.round(v)}`}
				>
					{(s) => (
						<g>
							<path
								d={s.area(pts, ymin)}
								fill="var(--accent)"
								fillOpacity={0.18}
							/>
							<path
								d={s.line(pts)}
								fill="none"
								stroke="var(--accent)"
								strokeWidth={1.8}
							/>
							<path
								d={s.line([[0, eye], rayTo(flat)])}
								fill="none"
								stroke="#ece6da"
								strokeOpacity={0.45}
								strokeWidth={1.2}
								strokeDasharray="2 4"
							/>
							<path
								d={s.line([[0, eye], rayTo(live)])}
								fill="none"
								stroke="#f4d35e"
								strokeWidth={1.8}
							/>
							<Mark x={s.x(0)} y={s.y(eye)} n={1} k={1.6} color="#ece6da" />
							<Mark
								x={s.x(live.d / 1000)}
								y={s.y(rayTo(live)[1])}
								n={2}
								k={1.6}
								color="#f4d35e"
							/>
						</g>
					)}
				</Plot>
			</div>
			<label className="mt-1 flex items-center gap-3 font-mono text-[11px] text-white/60">
				flat
				<input
					type="range"
					min={0}
					max={1}
					step={0.01}
					value={c}
					onChange={(e) => setC(Number(e.target.value))}
					className="flex-1 accent-[var(--accent)]"
					aria-label="Bend the Earth from flat to real"
				/>
				real Earth
			</label>
			<MarkList
				items={[
					<>Camera, {Math.round(eye)} m above sea level.</>,
					<>
						The crest that draws this column: {km(live.d)} km away,{" "}
						{live.el.toFixed(2)}° up. Dotted line: if the Earth were flat.
					</>,
				]}
			/>
		</Figure>
	);
}

function MiniRays({ id }: { id: AtlasPhotoId }) {
	const d = useAtlasPhoto(id);
	return <DemPatch data={d} cone={["solved"]} peaks={false} />;
}

function MiniGround({ id }: { id: AtlasPhotoId }) {
	const d = useAtlasPhoto(id);
	if (!d) return <div className="aspect-[4/3] animate-pulse bg-white/[0.04]" />;
	const pts = d.terrainProfile.points;
	const dmax = Math.max(...pts.map((p) => p[0]));
	const hs = pts.map((p) => p[1]);
	const lo = Math.min(...hs) - 80;
	const hi = Math.max(...hs, d.gps.eye) + 120;
	const X = (v: number) => (v / dmax) * 300;
	const Y = (v: number) => 170 - ((v - lo) / (hi - lo)) * 160;
	const line = pts.map(([a, h]) => `${X(a).toFixed(1)} ${Y(h).toFixed(1)}`);
	return (
		<svg
			viewBox="0 0 300 180"
			className="block h-auto w-full"
			role="img"
			aria-label="Ground height along one bearing"
		>
			<path
				d={`M0 180L${line.join("L")}L300 180Z`}
				fill="var(--accent)"
				fillOpacity={0.22}
			/>
			<path
				d={`M${line.join("L")}`}
				fill="none"
				stroke="var(--accent)"
				strokeWidth={1.6}
			/>
			<circle cx={X(0)} cy={Y(d.gps.eye)} r={4} fill="#ece6da" />
			{[0.25, 0.5, 0.75].map((f) => (
				<line
					key={f}
					x1={X(dmax * f)}
					x2={X(dmax * f)}
					y1={Y(lo) - 4}
					y2={Y(lo) + 4}
					stroke="#ece6da"
					strokeOpacity={0.5}
				/>
			))}
		</svg>
	);
}

function MiniOutline({ id }: { id: AtlasPhotoId }) {
	const d = useAtlasPhoto(id);
	const cam = useCam(d);
	const crop = useMemo(() => (d ? viewBand(d) : undefined), [d]);
	const k = crop && d ? (crop[2] - crop[0]) / d.photo.width : 1;
	return (
		<RealPhoto data={d} layers={[]} crop={crop}>
			{(dd) => <HorizonOverlay d={dd} cam={cam} k={k} />}
		</RealPhoto>
	);
}

const MISS: AtlasPhotoId[] = ["demo-06", "demo-09", "demo-03"];

function Misses() {
	return (
		<Figure
			label="Fig. 4"
			caption="Most columns agree. The worst tenth miss by far more than the median."
		>
			<Gallery
				ids={MISS}
				cols={3}
				tile={(d) => (
					<RealPhoto
						data={d}
						layers={["skyline", "solved"]}
						crop={skylineBand(d)}
					/>
				)}
				label={(d) => (
					<>
						<span className="text-white/80">
							median {d.residual.solved.median.toFixed(1)} px
						</span>
						{" · "}worst tenth over {d.residual.solved.p90.toFixed(0)} px
					</>
				)}
			/>
			<p className="mt-2 text-[12.5px] text-white/55">
				<Key color="#5ee0f4">map</Key> and <Key color="#f4d35e">photo</Key>{" "}
				skylines, solved pose.
			</p>
		</Figure>
	);
}

export default function Page({ node: _node }: { node: AtlasNode }) {
	const [id, setId] = useState<AtlasPhotoId>("demo-03");
	const d = useAtlasPhoto(id);
	const idx = useAtlasIndex();
	const hm = idx?.photos.map((p) => p.ms.horizon);
	const gap = idx
		? median(
				idx.photos
					.filter((p) => p.accepted)
					.map((p) => p.residual.solved.median),
			)
		: null;
	const nAcc = idx?.photos.filter((p) => p.accepted).length ?? 0;
	const A = (id: string, label: string) => (
		<Link
			to="/atlas/$concept"
			params={{ concept: id }}
			className="underline decoration-white/30 underline-offset-2 hover:decoration-current"
		>
			{label}
		</Link>
	);
	return (
		<>
			<HeroStages />

			<Beat
				kicker="The idea"
				title="The map can draw the skyline before we look at the photo."
			>
				<p>
					From the camera, we shoot a ray at every compass bearing. Each ray
					climbs over the terrain and remembers its steepest angle. Anything
					flatter hides behind that crest.
				</p>
				<p>
					Together the angles form a 360° skyline curve. We then slide it
					against the photo.
				</p>
			</Beat>

			<Ladder />

			<Beat kicker="How it works" title="One ray, three jobs.">
				<Trio
					steps={[
						{
							title: "Walk outward",
							body: "Small steps near us, wider steps far away, out to 150 km.",
							visual: <MiniRays id="demo-03" />,
						},
						{
							title: "Read the ground",
							body: "At each step, ask the map how high the ground is.",
							visual: <MiniGround id="demo-03" />,
						},
						{
							title: "Keep the steepest",
							body: `Earth drops away ${drop(50_000).toFixed(0)} m by 50 km, so we correct for it.`,
							visual: <MiniOutline id="demo-03" />,
						},
					]}
				/>
			</Beat>

			<RealHorizon id={id} setId={setId} d={d} />

			<Beat
				kicker="Where it fails"
				title="The map knows the ground, not the trees on it."
			>
				<p>
					Trees and people on the ridge are in the photo but not in the map.
					Those columns disagree.
				</p>
				<p>
					The solver gives such columns less weight, so a few misses do not move
					the camera.
				</p>
			</Beat>

			<Misses />

			<Numbers
				items={[
					{
						value: gap == null ? "…" : `${gap.toFixed(1)} px`,
						label: `median gap, map vs photo skyline (${nAcc} accepted photos, 800 px wide)`,
					},
					{
						value: hm ? `${(median(hm) / 1000).toFixed(1)} s` : "…",
						label: "to draw the full 360° skyline on CPU (12 photos)",
					},
					{ value: "7,200", label: "bearings, 0.05° apart, per skyline" },
					{ value: "0.3 s", label: "with the fast marcher in the browser" },
				]}
				source={
					<>
						Gap and time: measured on the 12 demo photos
						(scripts/atlas/build-data.ts). Bearings: src/lib/geo/horizon.ts
						defaults. Fast marcher: src/lib/geo/README.md. Gap uses the solved
						pose, so it measures fit, not accuracy.
					</>
				}
			/>

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next: {A("viewport-inference", "viewport inference")} slides this curve
				against the {A("skyline", "photo's skyline")} until they overlap. Its
				heights come from the {A("terrain-sampler", "terrain sampler")}.
			</p>

			<Details>
				<h3>The mechanism, exactly</h3>
				<p>
					<code>computeHorizon</code> builds a 360° curve: for every azimuth,
					the highest elevation angle at which land meets sky. It marches a ray
					along each azimuth, steps outward over the DEM, and keeps the steepest
					angle; everything flatter is hidden behind it. The real horizon on a
					real photo is Fig. 3. The two synthetic figures below use
					deterministic terrain and the same loop as the code.
				</p>
				<Steps
					steps={[
						{
							title: "A distance ladder per ray",
							body: (
								<>
									Samples start at 20 m and step by{" "}
									<code>max(10 m, 0.4 % of d)</code> out to 150 km. With those
									defaults that is about 1,270 samples per azimuth, and about 9
									million per full horizon.
								</>
							),
						},
						{
							title: "Walk the great circle, read the DEM",
							body: (
								<>
									<code>destination(lat, lon, az, d)</code> gives each ground
									point, and <code>terrain.sampleAt(lon, lat, d)</code> reads a
									height at the zoom level suited to that distance, with a
									fallback to coarser levels when a fine tile is missing.
									Missing data is <code>NaN</code> and the sample is skipped.
									See the {A("terrain-sampler", "terrain sampler")}.
								</>
							),
						},
						{
							title: "Convert height to an angle, with the Earth bending away",
							body: (
								<>
									<code>
										atan2(h &minus; eye &minus; d&sup2;/(2R&prime;), d)
									</code>
									, where <code>R&prime; = R / (1 &minus; k)</code> and k = 0.13
									folds refraction into the radius. The drop is{" "}
									{drop(10_000).toFixed(0)} m at 10 km,{" "}
									{drop(50_000).toFixed(0)} m at 50 km and{" "}
									{drop(100_000).toFixed(0)} m at 100 km.
								</>
							),
						},
						{
							title: "Keep the running maximum",
							body: (
								<>
									A sample that beats the best angle so far becomes the skyline
									for this azimuth (<code>elevation[i]</code>, and{" "}
									<code>distance[i]</code>, the metres to the point that draws
									it). Ties keep the nearer point.
								</>
							),
						},
						{
							title: "Remember the crests that got eclipsed",
							body: (
								<>
									When a new best appears after a stretch of hidden samples, and
									the previous crest is more than 8 % of its own distance
									behind, that crest was an inner silhouette. It goes into{" "}
									<code>ridges[i]</code>, nearest first: the layered ridge lines
									behind the {A("skyline", "skyline")} that the overlay draws.
								</>
							),
						},
					]}
				/>
				<h3>Output</h3>
				<p>
					A <code>HorizonProfile</code>: one 0.05° step, then{" "}
					<code>elevation</code> and <code>distance</code> as{" "}
					<code>Float32Array</code>s of 7,200 entries, plus the crest lists.
					Each ray is independent, so the work parallelises by azimuth sector.
					The fast marcher (src/lib/horizon-fast/march.ts) skips a block of
					terrain when its max-mipmap height cannot beat the current best angle,
					and follows the same geometry as the classic one.
				</p>
				<RayMarch />
				<Sweep />
				<Callout tone="result" title="Why curvature earns its place">
					In the synthetic ray the same eye puts the skyline on the 26 km ridge
					with the Earth&rsquo;s drop and on a 50 km summit without it. On the
					real photo in Fig. 2 the shift is small ({"<"} 1°), so curvature
					matters most for far skylines and long lenses.
				</Callout>
				<h3>Code</h3>
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/geo/horizon.ts" />
					<CodeRef path="src/lib/geo/terrain.ts" />
					<CodeRef path="src/lib/horizon-fast/march.ts" />
					<CodeRef path="src/lib/geodesy.ts" />
					<CodeRef path="src/lib/geo/pipeline.ts" />
					<CodeRef path="src/lib/geo/README.md" />
				</div>
				<p className="font-mono text-[12.5px] text-white/55">
					computeHorizon, HorizonProfile, Ridge, HorizonOptions,
					TerrainSampler.sampleAt, EARTH_R, REFRACTION_K,
					computeHorizonFastCompat
				</p>
				<h3>Where it fits</h3>
				<p>
					This is the predicted half of the skyline match in{" "}
					{A("viewport-inference", "viewport inference")}. Its input is the{" "}
					{A("terrain-sampler", "terrain sampler")} over the{" "}
					{A("dem-source", "DEM source")}, seen from the eye height the{" "}
					{A("eye-rule", "eye rule")} sets; the{" "}
					{A("baseline-pipeline", "baseline pipeline")} runs it first. The same
					DEM is what {A("terrain-snapping", "terrain snapping")} snaps to.
				</p>
			</Details>
		</>
	);
}
