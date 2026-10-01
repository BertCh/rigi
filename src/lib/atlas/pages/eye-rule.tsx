// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useEffect, useMemo, useState } from "react";
import {
	type AtlasPhotoData,
	Callout,
	CodeRef,
	Figure,
	Flow,
	Measured,
	Plot,
	RealPhoto,
	useAtlasIndex,
	useAtlasPhoto,
	useTime,
} from "#/components/atlas/viz";
import {
	Beat,
	Details,
	Numbers,
	Stages,
	skylineBand,
	Trio,
} from "#/components/atlas/viz/explain";
import { atlasHref } from "#/lib/atlas/graph-utils";
import type { AtlasNode } from "#/lib/atlas/types";

// Constants mirrored from src/lib/concord/priors/altitude.ts (EYE_PRIOR_DEFAULTS) and engine.ts.
const H = 1.6;
const SIGMA_A = 3;
const ALT_BIAS = -7;
const G0 = 1000;
const X0 = -140;
const X1 = 140;

/** A synthetic ridge flank: rising to the right with a few shoulders. */
const ground = (x: number) =>
	G0 + 0.16 * x + 5 * Math.sin(x / 21) + 0.0009 * x * x;

type Solved = {
	floorEye: number;
	mapX: number | null;
	mapEye: number | null;
	bandFrac: number;
	band: [number, number][];
	source: "gps+alt-contour" | "gps+dem-floor";
};

/** 1-D version of scanDisk + eyePriorFromExif: J = (x/sH)^2 + (r/sA)^2 on |x| <= 2 sH. */
function solve(
	altRel: number,
	sH: number,
	bias: boolean,
	noAlt: boolean,
): Solved {
	const g0 = ground(0);
	const alt = G0 + altRel;
	const floorEye = Math.max(noAlt ? g0 : alt, g0 + H);
	if (noAlt)
		return {
			floorEye,
			mapX: null,
			mapEye: null,
			bandFrac: 0,
			band: [],
			source: "gps+dem-floor",
		};
	const a = bias ? alt - ALT_BIAS : alt;
	let best: { x: number; J: number } | null = null;
	let n = 0;
	let inBand = 0;
	const band: [number, number][] = [];
	for (let x = -2 * sH; x <= 2 * sH + 1e-9; x += 1) {
		const r = ground(x) + H - a;
		n++;
		if (Math.abs(r) <= SIGMA_A) {
			inBand++;
			band.push([x, ground(x)]);
		}
		const J = (x / sH) ** 2 + (r / SIGMA_A) ** 2;
		if (!best || J < best.J) best = { x, J };
	}
	if (!inBand || !best)
		return {
			floorEye,
			mapX: null,
			mapEye: null,
			bandFrac: 0,
			band,
			source: "gps+dem-floor",
		};
	return {
		floorEye,
		mapX: best.x,
		mapEye: ground(best.x) + H,
		bandFrac: inBand / n,
		band,
		source: "gps+alt-contour",
	};
}

function Slider(p: {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	unit: string;
	onChange: (v: number) => void;
}) {
	return (
		<label className="flex min-w-[200px] flex-1 flex-col gap-1.5">
			<span className="flex justify-between font-mono text-[11px] tracking-wide text-white/55 uppercase">
				{p.label}
				<span className="text-[var(--accent)] normal-case">
					{p.value > 0 && p.label.startsWith("GPS") ? "+" : ""}
					{p.value} {p.unit}
				</span>
			</span>
			<input
				type="range"
				min={p.min}
				max={p.max}
				step={p.step ?? 1}
				value={p.value}
				onChange={(e) => p.onChange(Number(e.target.value))}
				className="w-full accent-[var(--accent)]"
			/>
		</label>
	);
}

function Toggle(p: { on: boolean; set: (b: boolean) => void; label: string }) {
	return (
		<button
			type="button"
			onClick={() => p.set(!p.on)}
			aria-pressed={p.on}
			className={`rounded-full px-3 py-1.5 font-mono text-[11px] ring-1 transition ${p.on ? "bg-[var(--accent)]/20 text-white ring-[var(--accent)]/60" : "bg-white/[0.04] text-white/55 ring-white/12 hover:bg-white/[0.08]"}`}
		>
			{p.label}
		</button>
	);
}

function Readout(p: { k: string; v: string; sub: string; color?: string }) {
	return (
		<div className="min-w-[140px] flex-1 rounded-lg bg-white/[0.035] px-3.5 py-2.5 ring-1 ring-white/8">
			<div className="font-mono text-[10px] tracking-[0.14em] text-white/45 uppercase">
				{p.k}
			</div>
			<div
				className="display-title text-[22px] leading-tight"
				style={{ color: p.color ?? "var(--rigi-paper)" }}
			>
				{p.v}
			</div>
			<div className="text-[12px] leading-snug text-white/50">{p.sub}</div>
		</div>
	);
}

const WARM = "#e8a06a";
const BAD = "#e5604d";

function Hero() {
	const [ref, t] = useTime<HTMLDivElement>();
	const [altRel, setAltRel] = useState(-12);
	const [hAcc, setHAcc] = useState(30);
	const [bias, setBias] = useState(true);
	const [noAlt, setNoAlt] = useState(false);
	const sH = Math.min(100, Math.max(5, hAcc));
	const s = useMemo(
		() => solve(altRel, sH, bias, noAlt),
		[altRel, sH, bias, noAlt],
	);

	const W = 720;
	const Hh = 330;
	const px = (x: number) => 30 + ((x - X0) / (X1 - X0)) * (W - 60);
	const yLo = G0 - 45;
	const yHi = G0 + 70;
	const py = (z: number) => 28 + (1 - (z - yLo) / (yHi - yLo)) * (Hh - 70);
	const xs = Array.from({ length: 141 }, (_, i) => X0 + (i * (X1 - X0)) / 140);
	const line = xs
		.map(
			(x, i) =>
				`${i ? "L" : "M"}${px(x).toFixed(1)},${py(ground(x)).toFixed(1)}`,
		)
		.join("");
	const alt = G0 + altRel;
	const err = s.mapEye != null ? s.floorEye - s.mapEye : null;
	const pulse = 1 + 0.25 * Math.sin(t * 3);
	const fig = (x: number, z: number, c: string, o = 1) => (
		<g
			opacity={o}
			stroke={c}
			strokeWidth={1.8}
			fill="none"
			strokeLinecap="round"
		>
			<line
				x1={px(x)}
				y1={py(z)}
				x2={px(x)}
				y2={py(z - H) + 0}
				strokeWidth={0}
			/>
			<circle cx={px(x)} cy={py(z)} r={3.2} fill={c} />
			<line x1={px(x)} y1={py(z) + 3} x2={px(x)} y2={py(z - H)} />
		</g>
	);
	return (
		<Figure
			label="Fig. 4"
			caption="Schematic (synthetic ridge, not a photo): one fix, two eyes. Drag the GPS altitude below the ground at the fix and watch the floor rule lift the photographer onto the air while the altitude contour slides them down the hill to where DEM + 1.6 m actually matches."
		>
			<div ref={ref}>
				<svg
					viewBox={`0 0 ${W} ${Hh}`}
					className="h-auto w-full"
					role="img"
					aria-label="Terrain profile with the GPS fix, floor-rule eye and altitude-contour eye"
				>
					<defs>
						<linearGradient id="er-g" x1="0" x2="0" y1="0" y2="1">
							<stop offset="0" stopColor="var(--accent)" stopOpacity="0.22" />
							<stop offset="1" stopColor="var(--accent)" stopOpacity="0.02" />
						</linearGradient>
					</defs>
					<path
						d={`${line}L${px(X1)},${Hh - 40}L${px(X0)},${Hh - 40}Z`}
						fill="url(#er-g)"
					/>
					<path
						d={line}
						fill="none"
						stroke="var(--rigi-paper)"
						strokeOpacity={0.7}
						strokeWidth={1.6}
					/>
					{/* GPS altitude contour */}
					<line
						x1={px(X0)}
						x2={px(X1)}
						y1={py(alt)}
						y2={py(alt)}
						stroke={WARM}
						strokeDasharray="4 5"
						strokeOpacity={0.7}
					/>
					<text
						x={px(X1) - 4}
						y={py(alt) - 6}
						textAnchor="end"
						fontSize={10.5}
						fill={WARM}
						fontFamily="monospace"
					>
						GPS altitude {noAlt ? "(none)" : `${alt.toFixed(0)} m`}
					</text>
					{noAlt && (
						<rect
							x={px(X0)}
							y={py(alt) - 12}
							width={W}
							height={24}
							fill="var(--rigi-ink)"
							opacity={0.0}
						/>
					)}
					{/* 2 sigma_H disk */}
					<g stroke="white" strokeOpacity={0.35}>
						<line x1={px(-2 * sH)} x2={px(2 * sH)} y1={Hh - 24} y2={Hh - 24} />
						<line x1={px(-2 * sH)} x2={px(-2 * sH)} y1={Hh - 29} y2={Hh - 19} />
						<line x1={px(2 * sH)} x2={px(2 * sH)} y1={Hh - 29} y2={Hh - 19} />
					</g>
					<text
						x={px(0)}
						y={Hh - 8}
						textAnchor="middle"
						fontSize={10.5}
						fill="white"
						fillOpacity={0.5}
						fontFamily="monospace"
					>
						2σH = ±{(2 * sH).toFixed(0)} m horizontal
					</text>
					{/* iso-band */}
					{s.band.length > 1 && (
						<path
							d={s.band
								.map(
									([x, g], i) =>
										`${i ? "L" : "M"}${px(x).toFixed(1)},${py(g).toFixed(1)}`,
								)
								.join("")}
							fill="none"
							stroke="var(--accent)"
							strokeWidth={5}
							strokeLinecap="round"
							opacity={0.9}
						/>
					)}
					{/* GPS fix */}
					<line
						x1={px(0)}
						x2={px(0)}
						y1={py(ground(0))}
						y2={Hh - 34}
						stroke="white"
						strokeOpacity={0.25}
						strokeDasharray="2 3"
					/>
					<text
						x={px(0)}
						y={Hh - 44}
						textAnchor="middle"
						fontSize={10}
						fill="white"
						fillOpacity={0.5}
						fontFamily="monospace"
					>
						GPS fix
					</text>
					{/* floor eye */}
					<line
						x1={px(0)}
						x2={px(0)}
						y1={py(ground(0))}
						y2={py(s.floorEye)}
						stroke={WARM}
						strokeWidth={2}
					/>
					{fig(0, s.floorEye, WARM)}
					<text
						x={px(0) + 9}
						y={py(s.floorEye) - 4}
						fontSize={11}
						fill={WARM}
						fontFamily="monospace"
					>
						max rule {s.floorEye.toFixed(1)} m
					</text>
					{/* MAP eye */}
					{s.mapEye != null && s.mapX != null && (
						<g>
							<circle
								cx={px(s.mapX)}
								cy={py(s.mapEye)}
								r={9 * pulse}
								fill="var(--accent)"
								opacity={0.18}
							/>
							{fig(s.mapX, s.mapEye, "var(--accent)")}
							<line
								x1={px(s.mapX)}
								x2={px(s.mapX)}
								y1={py(ground(s.mapX))}
								y2={py(s.mapEye)}
								stroke="var(--accent)"
								strokeWidth={2}
							/>
							<text
								x={px(s.mapX) + (s.mapX > 60 ? -9 : 9)}
								y={py(s.mapEye) - 10}
								textAnchor={s.mapX > 60 ? "end" : "start"}
								fontSize={11}
								fill="var(--accent)"
								fontFamily="monospace"
							>
								contour MAP {s.mapEye.toFixed(1)} m
							</text>
						</g>
					)}
				</svg>
			</div>
			<div className="mt-4 flex flex-wrap gap-x-6 gap-y-4">
				<Slider
					label="GPS alt vs ground at fix"
					value={altRel}
					min={-30}
					max={25}
					unit="m"
					onChange={setAltRel}
				/>
				<Slider
					label="GPSHPositioningError"
					value={hAcc}
					min={5}
					max={70}
					unit="m"
					onChange={setHAcc}
				/>
			</div>
			<div className="mt-3 flex flex-wrap gap-2">
				<Toggle
					on={noAlt}
					set={setNoAlt}
					label={
						noAlt ? "no altitude (EXIF stripped / pin)" : "altitude present"
					}
				/>
				<Toggle
					on={bias}
					set={setBias}
					label={bias ? "altBias −7 m applied" : "altBias off"}
				/>
			</div>
			<div className="mt-4 flex flex-wrap gap-3">
				<Readout
					k="Source"
					v={noAlt ? "dem-floor" : s.source.replace("gps+", "")}
					sub={
						noAlt
							? "no altitude: DEM + 1.6 m"
							: s.mapEye != null
								? `iso-band covers ${(100 * s.bandFrac).toFixed(0)}% of the 2σH disk`
								: "iso-band empty: fall back to the max rule"
					}
				/>
				<Readout
					k="Max rule eye"
					v={`${(s.floorEye - ground(0)).toFixed(1)} m`}
					sub="above the DEM at the fix"
					color={WARM}
				/>
				<Readout
					k="Contour eye"
					v={
						err == null
							? "same"
							: `${((s.mapEye ?? 0) - ground(s.mapX ?? 0)).toFixed(1)} m`
					}
					sub={
						err == null
							? "prior defers to the old rule"
							: `${err >= 0 ? "max rule is " : "max rule is -"}${Math.abs(err).toFixed(1)} m ${err >= 0 ? "too high" : "too low"}; shifted ${(s.mapX ?? 0).toFixed(0)} m`
					}
					color="var(--accent)"
				/>
			</div>
		</Figure>
	);
}

// ---------------------------------------------------------------------------------------------
// Real data: scripts/atlas/data-eye-rule.ts (the real eyePriorFromExif on the 12 Niederhorn fixes)
// ---------------------------------------------------------------------------------------------
type EyeRow = {
	id: string;
	alt: number;
	hAcc: number;
	ground: number;
	floorEye: number;
	source: string;
	bandFrac: number;
	mapEye: number | null;
	mapShiftM: number | null;
};
type EyeData = {
	generated: string;
	script: string;
	terrarium: EyeRow[];
	mapterhorn: EyeRow[] | null;
};
function useEyeData(): EyeData | null {
	const [d, setD] = useState<EyeData | null>(null);
	useEffect(() => {
		let live = true;
		fetch("/demo/atlas/eye-rule/eye-rule.json")
			.then((r) => r.json())
			.then((v) => live && setD(v))
			.catch((e) => console.warn("[atlas]", e));
		return () => {
			live = false;
		};
	}, []);
	return d;
}
const median = (a: number[]) => {
	const s = [...a].sort((x, y) => x - y);
	return s[s.length >> 1];
};
const sg = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(0)}`;
const TERRA = "#f4d35e";

const AX0 = -45;
const AX1 = 75;
/** GPS altitude minus DEM ground at the fix, for each of the 12 photos, on two DEMs. */
function RealOffsets() {
	const data = useEyeData();
	const demo = useAtlasIndex();
	if (!data || !data.mapterhorn)
		return (
			<Figure label="Fig. 2" caption="Loading measured fixes…">
				<div className="aspect-[2/1] animate-pulse rounded-xl bg-white/[0.04]" />
			</Figure>
		);
	const W = 440;
	const rowH = 23;
	const top = 34;
	const H = top + 12 * rowH + 38;
	const x0 = 82;
	const x1 = W - 16;
	const px = (v: number) =>
		x0 + ((Math.max(AX0, Math.min(AX1, v)) - AX0) / (AX1 - AX0)) * (x1 - x0);
	const rows = data.terrarium.map((t, i) => ({
		t,
		m: (data.mapterhorn as EyeRow[])[i],
	}));
	const offT = rows.map((r) => r.t.alt - r.t.ground).filter((v) => v > -200);
	const offM = rows.map((r) => r.m.alt - r.m.ground).filter((v) => v > -200);
	const glitch = rows.find((r) => r.t.alt - r.t.ground < -200);
	const dd = rows.map((r) => r.m.ground - r.t.ground);
	return (
		<Figure
			label="Fig. 2"
			caption={
				<>
					The phone's altitude lands tens of metres either side of the ground,
					depending on the map; the maps differ by {Math.min(...dd).toFixed(0)}{" "}
					to {Math.max(...dd).toFixed(0)} m. Left of the amber line, the rule
					drops the altitude.{" "}
					<Measured data={demo}>
						{" "}
						Rule: floorEye in src/lib/concord/priors/altitude.ts, via{" "}
						{data.script}.
					</Measured>
				</>
			}
			bleed
		>
			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="block h-auto w-full"
				role="img"
				aria-label="GPS altitude minus DEM ground for 12 photos on two DEMs"
			>
				<rect
					x={x0}
					y={top - 8}
					width={px(1.6) - x0}
					height={12 * rowH + 8}
					fill={WARM}
					opacity={0.1}
				/>
				{[-40, -20, 0, 20, 40, 60].map((v) => (
					<g key={v}>
						<line
							x1={px(v)}
							x2={px(v)}
							y1={top - 8}
							y2={top + 12 * rowH}
							stroke="white"
							strokeOpacity={v === 0 ? 0.35 : 0.1}
						/>
						<text
							x={px(v)}
							y={top + 12 * rowH + 14}
							textAnchor="middle"
							fontSize={11.5}
							fill="white"
							fillOpacity={0.5}
							fontFamily="monospace"
						>
							{v > 0 ? `+${v}` : v}
						</text>
					</g>
				))}
				<line
					x1={px(1.6)}
					x2={px(1.6)}
					y1={top - 8}
					y2={top + 12 * rowH}
					stroke={WARM}
					strokeWidth={1.5}
				/>
				<text
					x={px(1.6) - 4}
					y={top - 14}
					textAnchor="end"
					fontSize={11}
					fill={WARM}
					fontFamily="monospace"
				>
					altitude ignored
				</text>
				<text
					x={px(1.6) + 4}
					y={top - 14}
					fontSize={11}
					fill="white"
					fillOpacity={0.55}
					fontFamily="monospace"
				>
					altitude used
				</text>
				{rows.map((r, i) => {
					const y = top + i * rowH + rowH / 2 - 4;
					const a = r.t.alt - r.t.ground;
					const b = r.m.alt - r.m.ground;
					return (
						<g key={r.t.id}>
							<text
								x={x0 - 8}
								y={y + 3.5}
								textAnchor="end"
								fontSize={11.5}
								fill="white"
								fillOpacity={0.6}
								fontFamily="monospace"
							>
								{r.t.id.slice(5)} ±{Math.round(r.t.hAcc)}m
							</text>
							<line
								x1={px(a)}
								x2={px(b)}
								y1={y}
								y2={y}
								stroke="white"
								strokeOpacity={0.16}
							/>
							<circle cx={px(a)} cy={y} r={4.2} fill={TERRA} />
							<circle cx={px(b)} cy={y} r={4.2} fill="var(--accent)" />
							{(a < -200 || b < -200) && (
								<text
									x={x0 + 14}
									y={y + 3.5}
									fontSize={11}
									fill={BAD}
									fontFamily="monospace"
								>
									◂ alt {r.t.alt.toFixed(0)} m: {a.toFixed(0)} m (off scale)
								</text>
							)}
						</g>
					);
				})}
				<g fontSize={11.5} fontFamily="monospace">
					<circle cx={x0} cy={H - 8} r={4} fill={TERRA} />
					<text x={x0 + 8} y={H - 4.5} fill="white" fillOpacity={0.65}>
						Terrarium z13
					</text>
					<circle cx={x0 + 118} cy={H - 8} r={4} fill="var(--accent)" />
					<text x={x0 + 126} y={H - 4.5} fill="white" fillOpacity={0.65}>
						Mapterhorn z15
					</text>
				</g>
			</svg>
			{glitch && (
				<p className="mt-3 text-[13px] leading-relaxed text-white/60">
					Photo {glitch.t.id.slice(5)} recorded {glitch.t.alt.toFixed(0)} m,
					about 730 m under the ridge. The rule falls back to ground + 1.6 m (
					{glitch.t.floorEye.toFixed(1)} m on Terrarium,{" "}
					{glitch.m.floorEye.toFixed(1)} m on Mapterhorn). The other eleven read{" "}
					{sg(median(offT))} m (Terrarium) or {sg(median(offM))} m (Mapterhorn)
					from the ground.
				</p>
			)}
		</Figure>
	);
}

/** The real altitude-contour prior against the max rule, Mapterhorn z15. */
function RealContour() {
	const data = useEyeData();
	if (!data?.mapterhorn) return null;
	const rows = data.mapterhorn;
	const diffs = rows
		.filter((r) => r.mapEye != null)
		.map((r) => r.floorEye - (r.mapEye as number));
	const maxAbs = 16;
	return (
		<Figure
			label="Fig. 3"
			caption={
				<>
					Bar: standing-rule eye minus the optional prior's eye, on Mapterhorn.
					Right of centre, the rule stands the photographer higher. Photo 09
					finds no match and falls back. <Measured data={data} />
				</>
			}
		>
			<div className="space-y-1.5">
				<div className="grid grid-cols-[2.6rem_1fr_3.6rem_3.2rem] items-center gap-x-3 font-mono text-[9.5px] text-white/40 uppercase tracking-wider">
					<span>photo</span>
					<span className="text-center">max rule − contour (m)</span>
					<span className="text-right">band</span>
					<span className="text-right">shift</span>
				</div>
				{rows.map((r) => {
					const d = r.mapEye == null ? null : r.floorEye - r.mapEye;
					return (
						<div
							key={r.id}
							className="grid grid-cols-[2.6rem_1fr_3.6rem_3.2rem] items-center gap-x-3 font-mono text-[11px] text-white/65"
						>
							<span>{r.id.slice(5)}</span>
							<div className="relative h-3.5">
								<div className="absolute inset-y-0 left-1/2 w-px bg-white/25" />
								{d != null && (
									<div
										className="absolute inset-y-[3px] rounded-sm"
										style={{
											background: d >= 0 ? WARM : "var(--accent)",
											left: d >= 0 ? "50%" : `${50 + (d / maxAbs) * 50}%`,
											width: `${(Math.abs(d) / maxAbs) * 50}%`,
										}}
									/>
								)}
								<span
									className="absolute top-0 text-[10px] text-white/50"
									style={{
										left:
											d == null
												? "50%"
												: d >= 0
													? `${50 + (d / maxAbs) * 50 + 1.5}%`
													: undefined,
										right:
											d != null && d < 0
												? `${50 + (-d / maxAbs) * 50 + 1.5}%`
												: undefined,
										transform: d == null ? "translateX(-50%)" : undefined,
									}}
								>
									{d == null
										? "fallback"
										: `${d > 0 ? "+" : ""}${d.toFixed(1)}`}
								</span>
							</div>
							<span className="text-right">
								{r.bandFrac ? `${(r.bandFrac * 100).toFixed(0)}%` : "0%"}
							</span>
							<span className="text-right">
								{r.mapShiftM == null ? "–" : `${r.mapShiftM.toFixed(0)} m`}
							</span>
						</div>
					);
				})}
			</div>
			<p className="mt-3 text-[12.5px] leading-relaxed text-white/50">
				“band” is the fraction of the 2σH disk where DEM + 1.6 m is within σA of
				the altitude; “shift” is how far the MAP eye moves from the GPS fix.
				Across the {diffs.length} fixes max rule minus contour eye runs from{" "}
				{Math.min(...diffs).toFixed(1)} to {Math.max(...diffs).toFixed(1)} m
				(median {median(diffs).toFixed(1)} m). There is no true eye height here
				to score either against; the skyline cannot tell
				(reports/concordance-research.md: a 10 m eye shift moves the skyline
				residual by 0.2 to 2 px).
			</p>
		</Figure>
	);
}

/** Pixel shift of a 0.2 m eye-height drift against the distance of a ridge. */
function DriftPlot() {
	const F = 26 / 36; // f35 = 26 mm default (ontology rule)
	const W = 4000;
	const pts: [number, number][] = [];
	for (let lg = 1.7; lg <= 4.3; lg += 0.05) {
		const d = 10 ** lg;
		pts.push([lg, W * F * Math.atan(0.2 / d)]);
	}
	return (
		<Figure
			label="Fig. 5"
			caption="Computed from the pinhole model, not measured: pixel shift of a ridge when the eye moves 0.2 m (1.6 vs 1.8), on a 4000 px frame at the default 26 mm equivalent. Only the foreground cares."
		>
			<Plot
				x={[1.7, 4.3]}
				y={[0, 60]}
				xLabel="distance to terrain"
				yLabel="shift (px)"
				fmtX={(v) =>
					10 ** v >= 1000
						? `${(10 ** v / 1000).toFixed(0)} km`
						: `${Math.round(10 ** v)} m`
				}
				fmtY={(v) => `${v}`}
			>
				{(sc) => (
					<>
						<path
							d={sc.line(pts)}
							fill="none"
							stroke="var(--accent)"
							strokeWidth={2.2}
						/>
						{[2, 3, 4].map((lg) => (
							<g key={lg}>
								<circle
									cx={sc.x(lg)}
									cy={sc.y(W * F * Math.atan(0.2 / 10 ** lg))}
									r={4}
									fill="var(--accent)"
								/>
								<text
									x={sc.x(lg) + 8}
									y={sc.y(W * F * Math.atan(0.2 / 10 ** lg)) - 8}
									fontSize={11}
									fill="white"
									fillOpacity={0.7}
									fontFamily="monospace"
								>
									{(W * F * Math.atan(0.2 / 10 ** lg)).toFixed(2)} px
								</text>
							</g>
						))}
					</>
				)}
			</Plot>
		</Figure>
	);
}

/** Hero: the demo-09 fix in side view, with the real terrain under the camera. */
const XS0 = 0;
const XS1 = 1200;
const YS0 = 1100;
const YS1 = 2060;
function SideView({
	d,
	stage,
}: {
	d: AtlasPhotoData | null;
	stage: 0 | 1 | 2;
}) {
	if (!d)
		return (
			<div className="aspect-[2/1] animate-pulse rounded-xl bg-white/[0.04]" />
		);
	const W = 640;
	const Ht = 300;
	const px = (x: number) => 14 + ((x - XS0) / (XS1 - XS0)) * (W - 28);
	const py = (z: number) => 16 + (1 - (z - YS0) / (YS1 - YS0)) * (Ht - 40);
	const pts = d.terrainProfile.points.filter(([x]) => x <= XS1);
	const line = pts
		.map(
			([x, z], i) => `${i ? "L" : "M"}${px(x).toFixed(1)},${py(z).toFixed(1)}`,
		)
		.join("");
	const ground = d.gps.ground;
	const fix = d.gps.alt;
	const eye = d.gps.eye;
	const under = Math.round(ground - fix);
	return (
		<svg
			viewBox={`0 0 ${W} ${Ht}`}
			className="block h-auto w-full rounded-xl bg-black/25"
			role="img"
			aria-label={`Side view: the GPS fix at ${fix.toFixed(0)} m sits ${under} m below the ground, and the rule lifts the eye to ${eye.toFixed(1)} m`}
		>
			<path
				d={`${line}L${px(pts[pts.length - 1][0])},${Ht}L${px(0)},${Ht}Z`}
				fill="rgba(236,230,218,.07)"
			/>
			<path
				d={line}
				fill="none"
				stroke="rgba(236,230,218,.7)"
				strokeWidth={1.6}
			/>
			<text
				x={W - 16}
				y={py(pts[pts.length - 1][1]) - 8}
				textAnchor="end"
				fontSize={14}
				fill="white"
				fillOpacity={0.45}
				fontFamily="monospace"
			>
				ground along the view
			</text>
			<text
				x={px(60)}
				y={Ht - 10}
				fontSize={14}
				fill="white"
				fillOpacity={0.35}
				fontFamily="monospace"
			>
				inside the mountain
			</text>
			{stage >= 1 && (
				<line
					x1={px(0)}
					x2={px(0)}
					y1={py(fix)}
					y2={py(eye)}
					stroke={WARM}
					strokeWidth={2}
					strokeDasharray="4 3"
				/>
			)}
			<circle cx={px(0)} cy={py(fix)} r={6} fill={BAD} />
			<text
				x={px(0) + 14}
				y={py(fix) + 4}
				fontSize={16}
				fill={BAD}
				fontFamily="monospace"
			>
				phone says {fix.toFixed(0)} m
			</text>
			{stage >= 1 && (
				<text
					x={px(0) + 14}
					y={(py(fix) + py(eye)) / 2}
					fontSize={16}
					fill={WARM}
					fontFamily="monospace"
				>
					+{under} m
				</text>
			)}
			<circle cx={px(0)} cy={py(ground)} r={3} fill="white" fillOpacity={0.7} />
			<text
				x={px(0) + 14}
				y={py(ground) + 18}
				fontSize={14}
				fill="white"
				fillOpacity={0.6}
				fontFamily="monospace"
			>
				ground {ground.toFixed(0)} m
			</text>
			{stage >= 2 && (
				<g>
					<circle cx={px(0)} cy={py(eye)} r={6.5} fill="var(--accent)" />
					<text
						x={px(0) + 14}
						y={py(eye) - 8}
						fontSize={16}
						fill="var(--accent)"
						fontFamily="monospace"
					>
						eye {eye.toFixed(1)} m = ground + 1.6
					</text>
				</g>
			)}
		</svg>
	);
}

function HeroStages() {
	const d = useAtlasPhoto("demo-09");
	const crop = useMemo(() => (d ? skylineBand(d) : undefined), [d]);
	const under = d ? Math.round(d.gps.ground - d.gps.alt) : null;
	const frame = (stage: 0 | 1 | 2) => () => (
		<div className="grid items-start gap-3 md:grid-cols-[1.7fr_1fr]">
			<SideView d={d} stage={stage} />
			<RealPhoto data={d} layers={["skyline"]} crop={crop} />
		</div>
	);
	return (
		<Figure
			label="Fig. 1"
			caption={
				<>
					{under == null
						? "One real fix, far under the ground."
						: `On demo-09 the phone put the camera ${under} m inside the mountain; the rule lifts it onto the slope.`}{" "}
					<Measured data={d} />
				</>
			}
		>
			<Stages
				stages={[
					{
						label: "The phone says",
						caption:
							"This photo's altitude is far below the ground it was taken on.",
						render: frame(0),
					},
					{
						label: "The rule",
						caption:
							"The camera may never sit below the ground plus a standing eye.",
						render: frame(1),
					},
					{
						label: "Snapped",
						caption:
							"The eye stands on the slope, and the skyline then matches.",
						render: frame(2),
					},
				]}
			/>
		</Figure>
	);
}

function NumberCard({ big, small }: { big: string; small: string }) {
	return (
		<div className="flex aspect-[4/3] flex-col items-center justify-center rounded-lg bg-black/20 ring-1 ring-white/8">
			<span className="display-title text-[1.6rem] font-bold text-[var(--accent)]">
				{big}
			</span>
			<span className="mt-1 font-mono text-[10.5px] text-white/50">
				{small}
			</span>
		</div>
	);
}

export default function Page({ node: _node }: { node: AtlasNode }) {
	const data = useEyeData();
	const rows = data?.mapterhorn
		? data.terrarium.map((t, i) => ({ t, m: (data.mapterhorn as EyeRow[])[i] }))
		: [];
	const ok = rows.filter((r) => r.t.alt - r.t.ground > -200);
	const medT = ok.length ? median(ok.map((r) => r.t.alt - r.t.ground)) : null;
	const medM = ok.length ? median(ok.map((r) => r.m.alt - r.m.ground)) : null;
	const bandN = data?.mapterhorn?.filter(
		(r) => r.source === "gps+alt-contour",
	).length;
	const bad = rows.find((r) => r.t.alt - r.t.ground < -200);
	return (
		<>
			<HeroStages />

			<Beat
				kicker="The idea"
				title="The camera never stands inside the mountain."
			>
				<p>
					Every photo needs a camera height. We take the higher of two numbers:
					the phone's altitude, or the ground plus 1.6 m, a standing eye.
				</p>
				<p>
					Phone altitude can be badly wrong. The ground cannot. So the ground
					sets a floor.
				</p>
			</Beat>

			<Beat
				kicker="How it works"
				title="Read the altitude, look up the ground, take the higher."
			>
				<Trio
					steps={[
						{
							title: "Read the altitude",
							body: "The photo's metadata carries a GPS height.",
							visual: (
								<NumberCard
									big={bad ? `${bad.t.alt.toFixed(0)} m` : "…"}
									small="demo-09 phone altitude"
								/>
							),
						},
						{
							title: "Look up the ground",
							body: "The map gives the ground at that spot, plus 1.6 m.",
							visual: (
								<NumberCard
									big={bad ? `${(bad.t.ground + 1.6).toFixed(0)} m` : "…"}
									small="ground + 1.6 m"
								/>
							),
						},
						{
							title: "Take the higher",
							body: "That is the eye height used for the whole solve.",
							visual: (
								<NumberCard
									big={bad ? `${bad.t.floorEye.toFixed(1)} m` : "…"}
									small="eye height"
								/>
							),
						},
					]}
				/>
			</Beat>

			<RealOffsets />

			<Beat
				kicker="Where it fails"
				title="On a summit the rule can stand you too high."
			>
				<p>
					Near a summit the GPS spot can land up-slope. The ground there is
					higher, so the eye is too high by metres.
				</p>
				<p>
					A second, optional prior treats the altitude as a measurement and
					looks for where it matches the ground. If it finds nothing, it steps
					aside.
				</p>
			</Beat>

			<RealContour />

			<Numbers
				items={[
					{
						value: bad ? `${Math.round(bad.t.ground - bad.t.alt)} m` : "…",
						label: "demo-09 altitude below the ground (Terrarium)",
					},
					{
						value: medM == null ? "…" : `${sg(medM)} m`,
						label: `median phone altitude over Mapterhorn ground, other 11 photos (Terrarium: ${medT == null ? "…" : sg(medT)} m)`,
					},
					{
						value: bandN == null ? "…" : `${bandN} / 12`,
						label: "photos where the optional prior finds a match",
					},
					{
						value: "0.2 m",
						label:
							"gap between two no-altitude eye heights in the code (1.6 vs 1.8 m)",
					},
				]}
				source={
					<>
						Fixes and DEMs: {data?.script ?? "scripts/atlas/data-eye-rule.ts"}.
						The 1.6 / 1.8 drift: reports/ontology.md.
					</>
				}
			/>

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next: the{" "}
				<a className="text-[var(--accent)]" href={atlasHref("terrain-sampler")}>
					terrain sampler
				</a>{" "}
				supplies the ground, and the{" "}
				<a className="text-[var(--accent)]" href={atlasHref("dem-horizon")}>
					DEM horizon
				</a>{" "}
				is traced from this height.
			</p>

			<Details>
				<h3>What it is</h3>
				<p>
					<code>eye = max(GPS altitude, DEM + 1.6 m)</code>. With no altitude at
					all, stand on the{" "}
					<a href={atlasHref("terrain-sampler")}>sampled terrain</a> plus a
					standing eye height. It fixes the vertical component of the{" "}
					<a href={atlasHref("eye")}>eye</a> and is the first rung the solver's
					position prior is built on.
				</p>
				<Flow
					nodes={[
						{ label: "EXIF", sub: "lat, lon, GPSAltitude, hAcc" },
						{ label: "DEM at fix", sub: "ground g0" },
						{ label: "max(alt, g0 + 1.6)", sub: "the floor rule", color: WARM },
						{ label: "iso-band scan", sub: "DEM + 1.6 ≈ alt within 2σH" },
						{ label: "Gaussian prior", sub: "eye0, σH, σV" },
					]}
				/>
				<p>
					The floor rule is right whenever the fix lands on the ground the
					photographer stood on. It breaks on summits, cliff lips and slopes:
					the fix is off by <code>hAcc</code> (6 to 70 m), the DEM there is
					higher, and the rule puts the eye too high. iPhone altitude is MSL
					(EGM2008) and, where the fix is good, should agree with the DEM to a
					few metres. On the twelve Niederhorn fixes it does against Mapterhorn
					but not Terrarium (Fig. 2), so the photographer most likely stood
					where <code>DEM + 1.6 ≈ alt</code> inside the horizontal error disk.
				</p>
				<p>
					The prior in <code>altitude.ts</code> minimises{" "}
					<code>J = |x|²/σH² + ((DEM + 1.6 − alt)/σA)²</code> over the 2σH disk
					with <code>σA = {SIGMA_A} m</code>; the fitted{" "}
					<code>altBias = {ALT_BIAS} m</code> says phone altitude reads about 7
					m below ground + eye on the dev set. It is a prior, never a snap: it
					returns a Gaussian and a cost term, pipelines opt in through{" "}
					<code>?concord=eye</code>, and when the band is empty it hands back
					the old rule, which bounds the damage of a wrong bias.
				</p>
				<Hero />
				<h3>Why it matters downstream</h3>
				<p>
					Height shapes the horizon profile, which terrain occludes which, and
					near-field parallax. The{" "}
					<a href={atlasHref("camera-prior")}>camera prior</a> and the{" "}
					<a href={atlasHref("exif-prior")}>EXIF prior</a> both start here;{" "}
					<a href={atlasHref("eye-refinement")}>eye refinement</a> and the{" "}
					<a href={atlasHref("eye-search-gpu")}>GPU eye search</a> search around
					this height. That is why the 1.6 versus 1.8 drift has survived: 0.2 m
					is about 6 px on a 100 m foreground and under a pixel beyond 1 km. It
					is recorded as a finding, not a bug.
				</p>
				<DriftPlot />
				<Callout tone="warning" title="Known drift">
					With no altitude, <code>engine.ts</code> (<code>eyeAltitude</code>)
					and the roll ridgelines worker use DEM + 1.8 m, while{" "}
					<code>geo/pipeline.ts</code> (<code>EYE_ABOVE_GROUND</code>) and the
					concord prior use DEM + 1.6 m. The ontology marks it for unification
					in the engine owner's pass.
				</Callout>
				<Callout tone="lesson" title="Altitude is evidence, not a floor">
					The max rule throws altitude away whenever the fix lands on higher
					ground than the photographer's. Treating it as a contour recovers it,
					but the −7 m bias was fitted on 10 dev photos (9 Swiss, 4 days), and
					no-GT US fixes read near 0, which is why the prior falls back. See{" "}
					<a href={atlasHref("datum-msl-vs-ellipsoid")}>MSL versus ellipsoid</a>{" "}
					before mixing altitude sources.
				</Callout>
				<Callout tone="note" title="Pins carry no altitude">
					Positions typed in or picked on a map have their altitude nulled on
					import, so they always take the DEM-floor branch (
					<code>source: "pin"</code>).
				</Callout>
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/concord/priors/altitude.ts">
						eyePriorFromExif, concordEye, floorEye
					</CodeRef>
					<CodeRef path="src/lib/engine.ts">eyeAltitude</CodeRef>
					<CodeRef path="src/lib/geo/pipeline.ts">EYE_ABOVE_GROUND</CodeRef>
					<CodeRef path="src/lib/roll/mosaic/ridgelines.worker.ts" />
					<CodeRef path="reports/ontology.md" />
				</div>
			</Details>
		</>
	);
}
