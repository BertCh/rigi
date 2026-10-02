// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useEffect, useMemo, useState } from "react";
import {
	CircledKey,
	CircledNumber,
	HandMark,
	PencilLayer,
} from "#/components/gipfelbuch/notebook";
import {
	Hachure,
	HandDot,
	HandText,
	type InkColor,
	PenArrow,
	PenCircle,
	PenDimension,
	PenLine,
	SketchPath,
	SketchPolyline,
} from "#/components/gipfelbuch/notebook/Ink";
import type { Point } from "#/components/gipfelbuch/notebook/sketch";
import { SWISS } from "#/components/gipfelbuch/swiss/palette";
import {
	Callout,
	CodeRef,
	Eq,
	Figure,
	Flow,
	type GipfelbuchPhotoData,
	HandLabel,
	HandRange,
	MarginNote,
	Measured,
	PhotoStory,
	Plot,
	RealPhoto,
	Sym,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
	useTime,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Details,
	Numbers,
	Stages,
	skylineBand,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { gipfelbuchHref } from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// Constants mirrored from src/lib/concord/priors/altitude.ts (EYE_PRIOR_DEFAULTS) and deck/scene.ts (eyeAltitude).
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
		<div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
			<span className="flex justify-between font-mono text-[11px] tracking-wide gb-secondary uppercase">
				{p.label}
				<span className="text-[var(--accent)] normal-case">
					{p.value > 0 && p.label.startsWith("GPS") ? "+" : ""}
					{p.value} {p.unit}
				</span>
			</span>
			<HandRange
				min={p.min}
				max={p.max}
				step={p.step ?? 1}
				value={p.value}
				label={p.label}
				onChange={p.onChange}
			/>
		</div>
	);
}

function Toggle(p: { on: boolean; set: (b: boolean) => void; label: string }) {
	return (
		<button
			type="button"
			onClick={() => p.set(!p.on)}
			aria-pressed={p.on}
			className={`px-3 py-1.5 font-mono text-[11px] transition ${p.on ? "nb-mark gb-ink" : "bg-[var(--gb-paper-deep)] gb-secondary hover:text-[var(--gb-ink)]"}`}
		>
			{p.label}
		</button>
	);
}

function Readout(p: { k: string; v: string; sub: string; color?: string }) {
	return (
		<div className="min-w-[140px] flex-1 bg-[var(--gb-paper-deep)] px-3.5 py-2.5">
			<div className="font-mono text-[11px] tracking-[0.14em] gb-secondary uppercase">
				{p.k}
			</div>
			<div
				className="font-light gb-num text-[24px] leading-tight"
				style={{ color: p.color ?? "var(--gb-ink)" }}
			>
				{p.v}
			</div>
			<div className="text-[13px] leading-snug gb-secondary">{p.sub}</div>
		</div>
	);
}

const WARM = "var(--nb-ink)";
const BAD = "var(--nb-red)";

const W = 720;
const Hh = 330;
const px = (x: number) => 30 + ((x - X0) / (X1 - X0)) * (W - 60);
const yLo = G0 - 45;
const yHi = G0 + 70;
const py = (z: number) => 28 + (1 - (z - yLo) / (yHi - yLo)) * (Hh - 70);
const xs = Array.from({ length: 141 }, (_, i) => X0 + (i * (X1 - X0)) / 140);
const line = xs
	.map(
		(x, i) => `${i ? "L" : "M"}${px(x).toFixed(1)},${py(ground(x)).toFixed(1)}`,
	)
	.join("");
const groundPts: Point[] = xs.map((x): Point => [px(x), py(ground(x))]);

// Label sizes in viewBox units, for the wide figure track (about 960 px): Fig. 2 (760-wide viewBox) 12 px at
// 1.26x, the Fig. 1 side view (640-wide viewBox) 12 px at 1.5x, D1 (720-wide viewBox, in Details) about 12 px.
const OFFSETS_LABEL = 9.5;
const SIDE_LABEL = 8;
const HERO_LABEL = 11;

function Hero() {
	const [ref, t] = useTime<HTMLDivElement>(6);
	const [altRel, setAltRel] = useState(-12);
	const [hAcc, setHAcc] = useState(30);
	const [bias, setBias] = useState(true);
	const [noAlt, setNoAlt] = useState(false);
	const sH = Math.min(100, Math.max(5, hAcc));
	const s = useMemo(
		() => solve(altRel, sH, bias, noAlt),
		[altRel, sH, bias, noAlt],
	);

	const alt = G0 + altRel;
	const err = s.mapEye != null ? s.floorEye - s.mapEye : null;
	const pulse = 1 + 0.25 * Math.sin(t * 3) * Math.max(0, 1 - t / 2.4); // decays to 1
	const mapRight = s.mapX != null && s.mapX >= 0;
	const mapFlip = s.mapX != null && px(s.mapX) > W - 170;
	const fig = (x: number, z: number, c: InkColor, seed: string) => (
		<g>
			<HandDot
				data
				x={px(x)}
				y={py(z)}
				r={3.4}
				seed={`er-fig-${seed}`}
				color={c}
			/>
			<PenLine
				data
				from={[px(x), py(z) + 3]}
				to={[px(x), py(z - H)]}
				seed={`er-fig-${seed}-body`}
				color={c}
				width={1.8}
			/>
		</g>
	);
	return (
		<Figure
			label="D1"
			caption="Synthetic ridge, not a photo. Drag the GPS altitude below the ground: the floor rule lifts the eye into the air, the altitude contour slides it downhill to where ground + 1.6 m matches."
		>
			<div ref={ref}>
				<svg
					viewBox={`0 0 ${W} ${Hh}`}
					className="h-auto w-full"
					role="img"
					aria-label="Terrain profile with the GPS fix, floor-rule eye and altitude-contour eye"
				>
					<Hachure
						d={`${line}L${px(X1)},${Hh - 40}L${px(X0)},${Hh - 40}Z`}
						seed="er-hero-ground"
						color="brown"
						gap={6}
						opacity={0.5}
					/>
					<SketchPolyline
						points={groundPts}
						seed="er-hero-ridge"
						data
						color="brown"
						width={1.7}
						passes={1}
					/>
					{/* GPS altitude contour */}
					<PenLine
						data
						from={[px(X0), py(alt)]}
						to={[px(X1), py(alt)]}
						seed="er-hero-alt"
						color="pencil"
						width={1.2}
						dash="4 5"
					/>
					<HandLabel
						x={px(X1) - 4}
						y={py(alt) - 7}
						anchor="end"
						size={HERO_LABEL}
					>
						GPS altitude {noAlt ? "(none)" : `${alt.toFixed(0)} m`}
					</HandLabel>
					{/* 2 sigma_H disk */}
					<PenLine
						data
						from={[px(-2 * sH), Hh - 24]}
						to={[px(2 * sH), Hh - 24]}
						seed="er-hero-disk"
						color="pencil"
						width={1}
					/>
					<PenLine
						data
						from={[px(-2 * sH), Hh - 29]}
						to={[px(-2 * sH), Hh - 19]}
						seed="er-hero-disk-l"
						color="pencil"
						width={1}
					/>
					<PenLine
						data
						from={[px(2 * sH), Hh - 29]}
						to={[px(2 * sH), Hh - 19]}
						seed="er-hero-disk-r"
						color="pencil"
						width={1}
					/>
					<HandLabel x={px(0)} y={Hh - 8} anchor="middle" size={HERO_LABEL}>
						2σH = ±{(2 * sH).toFixed(0)} m horizontal
					</HandLabel>
					{/* iso-band */}
					{s.band.length > 1 && (
						<SketchPolyline
							points={s.band.map(([x, g]): Point => [px(x), py(g)])}
							seed="er-hero-band"
							data
							color="red"
							width={4}
							passes={1}
							opacity={0.85}
						/>
					)}
					{/* GPS fix */}
					<PenLine
						data
						from={[px(0), py(ground(0))]}
						to={[px(0), Hh - 34]}
						seed="er-hero-fix"
						color="faint"
						width={0.9}
						dash="2 3"
					/>
					<HandLabel
						x={px(0)}
						y={Hh - 44}
						anchor="middle"
						size={HERO_LABEL}
						color={SWISS.pencil}
					>
						GPS fix
					</HandLabel>
					{/* floor eye */}
					<PenLine
						data
						from={[px(0), py(ground(0))]}
						to={[px(0), py(s.floorEye)]}
						seed="er-hero-floor"
						color="ink"
						width={2}
					/>
					{fig(0, s.floorEye, "ink", "floor")}
					{/* the two eye labels sit on opposite sides of the fix and are staggered when the eyes are close */}
					<HandLabel
						x={px(0) - 10}
						y={py(s.floorEye) - 4}
						anchor="end"
						size={HERO_LABEL}
						color={SWISS.ink}
					>
						floor rule {s.floorEye.toFixed(1)} m
					</HandLabel>
					{/* MAP eye */}
					<PencilLayer>
						<PenLine
							from={[px(X0), py(ground(0) + H)]}
							to={[px(X1), py(ground(0) + H)]}
							seed="er-hero-guide-eye"
							width={0.8}
						/>
					</PencilLayer>
					<PenDimension
						from={[px(0) + 14, py(ground(0))]}
						to={[px(0) + 14, py(ground(0) + H)]}
						seed="er-hero-dim"
						color="pencil"
						width={1}
						tick={3}
					/>
					<HandText
						x={px(0) + 20}
						y={py(ground(0) + H / 2) + 4}
						size={14}
						color="pencil"
					>
						1.6 m standing eye
					</HandText>
					<HandText x={14} y={22} size={15} rotate={-2}>
						{err == null
							? "no match: the floor rule stands"
							: `floor rule is ${Math.abs(err).toFixed(1)} m too ${err >= 0 ? "high" : "low"} here`}
					</HandText>
					<HandText
						x={W - 14}
						y={Hh - 54}
						size={14}
						anchor="end"
						color="pencil"
					>
						red band: where DEM + 1.6 m matches the altitude
					</HandText>
					{s.mapEye != null && s.mapX != null && (
						<g>
							<PenCircle
								data
								center={[px(s.mapX), py(s.mapEye)]}
								radiusX={9 * pulse}
								seed="er-hero-pulse"
								color="red"
								width={1}
							/>
							{fig(s.mapX, s.mapEye, "red", "map")}
							<PenLine
								data
								from={[px(s.mapX), py(ground(s.mapX))]}
								to={[px(s.mapX), py(s.mapEye)]}
								seed="er-hero-map"
								color="red"
								width={2}
							/>
							{/* right of the dot (or left near the edge) and above; below it when the MAP eye is left of the fix, so it never meets the "max rule" label */}
							<HandLabel
								x={px(s.mapX) + (mapRight && !mapFlip ? 10 : -10)}
								y={py(s.mapEye) + (mapRight ? -11 : 19)}
								anchor={mapRight && !mapFlip ? "start" : "end"}
								size={HERO_LABEL}
								color={SWISS.red}
							>
								contour eye {s.mapEye.toFixed(1)} m
							</HandLabel>
						</g>
					)}
				</svg>
			</div>
			<div className="mt-4 flex flex-wrap gap-x-6 gap-y-4">
				<Slider
					label="GPS altitude vs ground"
					value={altRel}
					min={-30}
					max={25}
					unit="m"
					onChange={setAltRel}
				/>
				<Slider
					label="GPS horizontal error"
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
						noAlt ? "no altitude (stripped or pinned)" : "altitude present"
					}
				/>
				<Toggle
					on={bias}
					set={setBias}
					label={bias ? "−7 m bias applied" : "bias off"}
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
								? `band covers ${(100 * s.bandFrac).toFixed(0)}% of the ±2σH disk`
								: "no band: floor rule used"
					}
				/>
				<Readout
					k="Floor-rule eye"
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
							? "floor rule stands"
							: `${err >= 0 ? "floor rule is " : "floor rule is -"}${Math.abs(err).toFixed(1)} m ${err >= 0 ? "too high" : "too low"}; shifted ${(s.mapX ?? 0).toFixed(0)} m`
					}
					color="var(--nb-red)"
				/>
			</div>
		</Figure>
	);
}

// ---------------------------------------------------------------------------------------------
// Real data: scripts/gipfelbuch/data-eye-rule.ts (the real eyePriorFromExif on the 12 Niederhorn fixes)
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
		fetch("/demo/gipfelbuch/eye-rule/eye-rule.json")
			.then((r) => r.json())
			.then((v) => live && setD(v))
			.catch((e) => console.warn("[gipfelbuch]", e));
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
const TERRA = "var(--gb-sign)";
const MAPH = "var(--gb-forest)";

const AX0 = -45;
const AX1 = 75;
/** GPS altitude minus DEM ground at the fix, for each of the 12 photos, on two DEMs. */
function RealOffsets() {
	const data = useEyeData();
	const demo = useGipfelbuchIndex();
	if (!data || !data.mapterhorn)
		return (
			<Figure caption="Loading measured fixes…">
				<div className="aspect-[2/1] animate-pulse bg-[var(--gb-paper-deep)]" />
			</Figure>
		);
	const W = 760;
	const rowH = 26;
	const top = 40;
	const H = top + 12 * rowH + 44;
	const x0 = 110;
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
	const dropM = rows.filter((r) => r.m.alt < r.m.ground + 1.6).length;
	const dropT = rows.filter((r) => r.t.alt < r.t.ground + 1.6).length;
	return (
		<Figure
			label="Fig. 2"
			caption={
				<>
					The phone's altitude lands tens of metres either side of the ground,
					depending on the map; the maps differ by {Math.min(...dd).toFixed(0)}{" "}
					to {Math.max(...dd).toFixed(0)} m. Left of the black line the rule
					drops the altitude: {dropM} of 12 photos on Mapterhorn, {dropT} of 12
					on Terrarium. <Measured data={demo} />
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
				<Hachure
					d={`M${x0} ${top - 8}L${px(1.6)} ${top - 8}L${px(1.6)} ${top + 12 * rowH}L${x0} ${top + 12 * rowH}Z`}
					seed="er-ro-ignored"
					color="pencil"
					gap={7}
					opacity={0.45}
				/>
				{[-40, -20, 0, 20, 40, 60].map((v) => (
					<g key={v}>
						<PenLine
							data
							from={[px(v), top - 8]}
							to={[px(v), top + 12 * rowH]}
							seed={`er-ro-grid-${v}`}
							color={v === 0 ? "pencil" : "faint"}
							width={v === 0 ? 0.9 : 0.5}
						/>
						<HandLabel
							x={px(v)}
							y={top + 12 * rowH + 14}
							anchor="middle"
							size={OFFSETS_LABEL}
							color="var(--nb-pencil)"
						>
							{v > 0 ? `+${v}` : `${v}`}
						</HandLabel>
					</g>
				))}
				<PenLine
					data
					from={[px(1.6), top - 8]}
					to={[px(1.6), top + 12 * rowH]}
					seed="er-ro-floor"
					color="ink"
					width={1.5}
				/>
				<HandLabel
					x={px(1.6) - 5}
					y={top - 14}
					anchor="end"
					size={OFFSETS_LABEL + 1}
				>
					altitude ignored
				</HandLabel>
				<HandLabel x={px(1.6) + 5} y={top - 14} size={OFFSETS_LABEL + 1}>
					altitude used
				</HandLabel>
				{rows.map((r, i) => {
					const y = top + i * rowH + rowH / 2 - 4;
					const a = r.t.alt - r.t.ground;
					const b = r.m.alt - r.m.ground;
					return (
						<g key={r.t.id}>
							<HandLabel
								x={x0 - 8}
								y={y + 3.5}
								anchor="end"
								size={OFFSETS_LABEL}
								color="var(--nb-pencil)"
							>
								{`${r.t.id.slice(5)} ±${Math.round(r.t.hAcc)}m`}
							</HandLabel>
							<PenLine
								data
								from={[px(a), y]}
								to={[px(b), y]}
								seed={`er-ro-link-${r.t.id}`}
								color="faint"
								width={0.9}
							/>
							<HandDot
								x={px(a)}
								y={y}
								r={5}
								seed={`er-ro-t-${r.t.id}`}
								data
								color={TERRA}
								opacity={1}
							/>
							<PenCircle
								center={[px(a), y]}
								radiusX={5}
								seed={`er-ro-tr-${r.t.id}`}
								data
								color="ink"
								width={1}
							/>
							<HandDot
								x={px(b)}
								y={y}
								r={5}
								seed={`er-ro-m-${r.t.id}`}
								data
								color={MAPH}
								opacity={1}
							/>
							{(a < -200 || b < -200) && (
								<HandLabel
									x={x0 + 14}
									y={y + 4}
									size={OFFSETS_LABEL}
									color={SWISS.red}
									halo={6}
								>
									◂ alt {r.t.alt.toFixed(0)} m: {a.toFixed(0)} m (off scale)
								</HandLabel>
							)}
						</g>
					);
				})}
				<HandText
					x={x1}
					y={top + 12 * rowH + 36}
					size={14}
					anchor="end"
					color="pencil"
					rotate={-2}
				>
					the two maps disagree about where the ground is
				</HandText>
				<HandText x={px(1.6) + 14} y={top + 6 * rowH} size={14} color="pencil">
					{`${dropM} of 12 land left on Mapterhorn`}
				</HandText>
				<g>
					<HandDot
						x={x0}
						y={H - 9}
						r={5}
						seed="er-ro-key-t"
						color={TERRA}
						opacity={1}
					/>
					<PenCircle
						center={[x0, H - 9]}
						radiusX={5}
						seed="er-ro-key-tr"
						color="ink"
						width={1}
					/>
					<HandLabel x={x0 + 10} y={H - 5} size={OFFSETS_LABEL}>
						Terrarium
					</HandLabel>
					<HandDot
						x={x0 + 140}
						y={H - 9}
						r={5}
						seed="er-ro-key-m"
						color={MAPH}
						opacity={1}
					/>
					<HandLabel x={x0 + 150} y={H - 5} size={OFFSETS_LABEL}>
						Mapterhorn
					</HandLabel>
				</g>
			</svg>
			{glitch && (
				<p className="mt-3 text-[13px] leading-relaxed gb-secondary">
					Photo {glitch.t.id.slice(5)} recorded {glitch.t.alt.toFixed(0)} m,
					about 730 m under the ridge, so the rule uses ground + 1.6 m (
					{glitch.t.floorEye.toFixed(1)} m on Terrarium,{" "}
					{glitch.m.floorEye.toFixed(1)} m on Mapterhorn). The other eleven sit{" "}
					{sg(median(offT))} m (Terrarium) or {sg(median(offM))} m (Mapterhorn)
					above the ground.
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
	const CW = 640;
	const CROW = 22;
	const CH = 30 + rows.length * CROW;
	const cxm = 330;
	const CW_HALF = 230;
	return (
		<Figure
			label="Fig. 3"
			caption={
				<>
					Bar: floor-rule eye minus altitude-contour eye, on Mapterhorn. Red,
					right: the floor rule stands the eye higher. Navy, left: the contour
					eye is higher. Photo 09 finds no match. <Measured data={data} />
				</>
			}
		>
			<svg
				viewBox={`0 0 ${CW} ${CH}`}
				className="block h-auto w-full"
				role="img"
				aria-label="Standing-rule eye minus contour-prior eye for 12 photos, Mapterhorn"
			>
				<HandLabel x={8} y={14} size={10} caps color="var(--gb-secondary)">
					photo
				</HandLabel>
				<HandLabel
					x={cxm - 8}
					y={14}
					anchor="end"
					size={10.5}
					color="var(--gb-navy)"
				>
					◂ contour higher
				</HandLabel>
				<HandLabel x={cxm + 8} y={14} size={10.5} color="var(--gb-red)">
					contour lower ▸
				</HandLabel>
				<HandLabel
					x={CW - 66}
					y={14}
					anchor="end"
					size={10}
					caps
					color="var(--gb-secondary)"
				>
					band
				</HandLabel>
				<HandLabel
					x={CW - 6}
					y={14}
					anchor="end"
					size={10}
					caps
					color="var(--gb-secondary)"
				>
					shift
				</HandLabel>
				<PenLine
					from={[cxm, 22]}
					to={[cxm, 22 + rows.length * CROW]}
					seed="er-rc-axis"
					color="pencil"
					width={1}
				/>
				{rows.map((r, i) => {
					const d = r.mapEye == null ? null : r.floorEye - r.mapEye;
					const ink: InkColor = d != null && d < 0 ? "navy" : "red";
					const y = 22 + i * CROW + CROW / 2;
					const x1 = d == null ? cxm : cxm + (d / maxAbs) * CW_HALF;
					const bar =
						d == null ? "" : `M${cxm} ${y - 5}H${x1}V${y + 5}H${cxm}Z`;
					return (
						<g key={r.id}>
							<HandLabel x={8} y={y + 4} size={11} color="var(--gb-secondary)">
								{r.id.slice(5)}
							</HandLabel>
							{d != null && (
								<>
									<Hachure
										d={bar}
										seed={`er-rc-bar-${r.id}`}
										color={ink}
										gap={2.6}
										width={0.9}
										opacity={0.8}
									/>
									<PenLine
										data
										from={[x1, y - 6]}
										to={[x1, y + 6]}
										seed={`er-rc-end-${r.id}`}
										color={ink}
										width={2}
									/>
								</>
							)}
							<HandLabel
								x={d == null ? cxm + 8 : d >= 0 ? x1 + 6 : x1 - 6}
								y={y + 4}
								anchor={d != null && d < 0 ? "end" : "start"}
								size={11}
								color="var(--gb-secondary)"
							>
								{d == null ? "no match" : `${d > 0 ? "+" : ""}${d.toFixed(1)}`}
							</HandLabel>
							<HandLabel
								x={CW - 66}
								y={y + 4}
								anchor="end"
								size={11}
								color="var(--gb-secondary)"
							>
								{r.bandFrac ? `${(r.bandFrac * 100).toFixed(0)}%` : "0%"}
							</HandLabel>
							<HandLabel
								x={CW - 6}
								y={y + 4}
								anchor="end"
								size={11}
								color="var(--gb-secondary)"
							>
								{r.mapShiftM == null ? "–" : `${r.mapShiftM.toFixed(0)} m`}
							</HandLabel>
						</g>
					);
				})}
				{(() => {
					const fb = rows.findIndex((r) => r.mapEye == null);
					return fb >= 0 ? (
						<>
							<HandText
								x={cxm + 70}
								y={22 + fb * CROW + CROW / 2 + 22}
								size={14}
								rotate={-2}
							>
								{`photo ${rows[fb].id.slice(5)}: no match, floor rule stands`}
							</HandText>
							<PenArrow
								from={[cxm + 66, 22 + fb * CROW + CROW / 2 + 16]}
								to={[cxm + 30, 22 + fb * CROW + CROW / 2 + 4]}
								seed="er-rc-note-arrow"
								width={1.2}
							/>
						</>
					) : null;
				})()}
			</svg>
			<p className="mt-3 text-[13px] leading-relaxed gb-secondary">
				band: share of the ±2σH disk where ground + 1.6 m is within σA of the
				altitude. shift: how far the contour eye moves from the GPS fix. Across
				the {diffs.length} fixes, floor rule minus contour eye runs from{" "}
				{Math.min(...diffs).toFixed(1)} to {Math.max(...diffs).toFixed(1)} m
				(median {median(diffs).toFixed(1)} m). No true eye height exists to
				score either; a 10 m shift moves the skyline by only 0.2 to 2 px.
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
			label="D2"
			caption="Computed, not measured: pixel shift of a ridge when the eye height changes by 0.2 m, on a 4000 px frame at 26 mm equivalent."
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
						<SketchPath
							d={sc.line(pts)}
							seed="er-drift-line"
							data
							color="ink"
							width={2.2}
						/>
						{[2, 3, 4].map((lg) => (
							<g key={lg}>
								<HandDot
									x={sc.x(lg)}
									y={sc.y(W * F * Math.atan(0.2 / 10 ** lg))}
									r={4.5}
									seed={`er-drift-dot-${lg}`}
									data
									color="red"
									opacity={1}
								/>
								<HandLabel
									x={sc.x(lg) + 9}
									y={sc.y(W * F * Math.atan(0.2 / 10 ** lg)) - 8}
									size={13}
									color={SWISS.ink}
								>
									{(W * F * Math.atan(0.2 / 10 ** lg)).toFixed(2)} px
								</HandLabel>
							</g>
						))}
						<HandText
							x={sc.x(2.9)}
							y={sc.y(40)}
							size={16}
							anchor="end"
							rotate={-3}
						>
							only the foreground cares
						</HandText>
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
	d: GipfelbuchPhotoData | null;
	stage: 0 | 1 | 2;
}) {
	if (!d)
		return (
			<div className="aspect-[2/1] animate-pulse bg-[var(--gb-paper-deep)]" />
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
			className="block h-auto w-full"
			role="img"
			aria-label={`Side view: the GPS fix at ${fix.toFixed(0)} m sits ${under} m below the ground, and the rule lifts the eye to ${eye.toFixed(1)} m`}
		>
			<Hachure
				d={`${line}L${px(pts[pts.length - 1][0])},${Ht}L${px(0)},${Ht}Z`}
				seed="er-sv-ground"
				color="brown"
				gap={6}
				opacity={0.5}
			/>
			<SketchPath
				d={line}
				seed="er-sv-ridge"
				data
				color="brown"
				width={1.7}
				passes={1}
			/>
			<HandLabel
				x={W - 16}
				y={py(pts[pts.length - 1][1]) - 8}
				anchor="end"
				size={SIDE_LABEL}
			>
				ground along the view
			</HandLabel>
			<HandText x={px(60)} y={Ht - 10} size={17} color="pencil">
				inside the mountain
			</HandText>
			{stage >= 1 && (
				<PenLine
					data
					from={[px(0), py(fix)]}
					to={[px(0), py(eye)]}
					seed="er-sv-lift"
					color="ink"
					width={2}
					dash="4 3"
				/>
			)}
			<HandDot data x={px(0)} y={py(fix)} r={6} seed="er-sv-fix" color="red" />
			<CircledKey
				x={px(0) - 20}
				y={py(fix) + 4}
				value="1"
				seed="er-sv-key1"
				color="pencil"
			/>
			<HandLabel
				x={px(0) + 15}
				y={py(fix) + 5}
				size={SIDE_LABEL + 1}
				color={SWISS.red}
			>
				phone says {fix.toFixed(0)} m
			</HandLabel>
			{stage >= 1 && (
				<HandLabel
					x={px(0) + 15}
					y={(py(fix) + py(eye)) / 2}
					size={SIDE_LABEL}
					color={SWISS.ink}
				>
					+{under} m
				</HandLabel>
			)}
			<HandDot
				data
				x={px(0)}
				y={py(ground)}
				r={3}
				seed="er-sv-ground-dot"
				color="ink"
			/>
			<HandLabel x={px(0) + 15} y={py(ground) + 19} size={SIDE_LABEL}>
				ground {ground.toFixed(0)} m
			</HandLabel>
			<HandText
				x={W - 16}
				y={Ht - 40}
				size={13}
				anchor="end"
				color="pencil"
				rotate={-2}
			>
				{`a phone ${under} m under the ground cannot be right`}
			</HandText>
			{stage >= 2 && (
				<g>
					<CircledKey
						x={px(0) - 20}
						y={py(eye) + 4}
						value="2"
						seed="er-sv-key2"
						color="pencil"
					/>
					<HandDot
						data
						x={px(0)}
						y={py(eye)}
						r={6.5}
						seed="er-sv-eye"
						color="forest"
					/>
					<HandLabel
						x={px(0) + 15}
						y={py(eye) - 9}
						size={SIDE_LABEL + 1}
						color={SWISS.forest}
					>
						eye {eye.toFixed(1)} m = ground + 1.6
					</HandLabel>
				</g>
			)}
		</svg>
	);
}

function HeroStages() {
	const d = useGipfelbuchPhoto("demo-09");
	const crop = useMemo(() => (d ? skylineBand(d) : undefined), [d]);
	const eyeData = useEyeData();
	const under = d ? Math.round(d.gps.ground - d.gps.alt) : null;
	const underM = eyeData?.mapterhorn
		? Math.round(eyeData.mapterhorn[8].ground - eyeData.mapterhorn[8].alt)
		: null;
	const frame = (stage: 0 | 1 | 2) => () => (
		<div className="space-y-4">
			<SideView d={d} stage={stage} />
			{/* geo bleed: the measured terrain and the summits carry on past the photo's frame */}
			<RealPhoto data={d} layers={["skyline"]} crop={crop} bleed />
		</div>
	);
	return (
		<Figure
			label="Fig. 1"
			bleed
			caption={
				<>
					{under == null
						? "One real fix, far under the ground."
						: `Photo 09: the phone put the camera ${under} m inside the mountain; the rule lifts it onto the slope.`}{" "}
					{underM != null &&
						`(Drawn on Terrarium; on Mapterhorn, which Rigi uses, the gap is ${underM} m.) `}
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
							"The eye stands on the slope, and the horizon is traced from there.",
						render: frame(2),
					},
				]}
			/>
		</Figure>
	);
}

/** The rule as the code computes it, with demo-09's real numbers substituted (Terrarium, as drawn in Fig. 1). */
function EyeEquation() {
	const data = useEyeData();
	const row = data?.terrarium.find((r) => r.id === "demo-09");
	const alt = row?.alt;
	const g = row?.ground;
	return (
		<Eq
			label="The rule with photo 09's numbers (m)"
			where={[
				{
					sym: "alt",
					c: BAD,
					text: "the phone's GPS altitude (red dot in Fig. 1)",
				},
				{ sym: "g", text: "ground height under the fix, from the map" },
				{
					sym: "eye",
					c: "var(--nb-forest)",
					text: "camera height used from here on (green dot)",
				},
			]}
		>
			<Sym c="var(--nb-forest)">eye</Sym> = max(<Sym c={BAD}>alt</Sym>,{" "}
			<Sym>g</Sym> + 1.6)
			{alt != null && g != null && (
				<>
					{" "}
					<br />= max(<Sym c={BAD}>{alt.toFixed(0)}</Sym>, {g.toFixed(0)} + 1.6)
					= <Sym c="var(--nb-forest)">{Math.max(alt, g + 1.6).toFixed(1)}</Sym>
				</>
			)}
		</Eq>
	);
}

function NumberCard({ big, small }: { big: string; small: string }) {
	return (
		<div className="flex aspect-[4/3] flex-col items-center justify-center bg-[var(--gb-paper-deep)]">
			<span className="font-light gb-num text-[24px] text-[var(--accent)]">
				{big}
			</span>
			<span className="mt-1 font-mono text-[11px] gb-secondary">{small}</span>
		</div>
	);
}

export default function Page({ node: _node }: { node: GipfelbuchNode }) {
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
					the phone's altitude, or the ground plus 1.6 m, a standing eye. In
					Fig. 1, <CircledNumber value={1} color="pencil" seed="er-p1" /> is
					what the phone says and{" "}
					<CircledNumber value={2} color="pencil" seed="er-p2" /> is the eye we
					use.
				</p>
				<p>
					<HandMark type="highlight">
						GPS height is the weakest GPS number: its error is usually 1.5 to 3
						times the sideways error.
					</HandMark>{" "}
					The ground cannot move, so it sets a floor.
					{bad && (
						<MarginNote mark="a">
							{`Photo 09 says ${bad.t.alt.toFixed(0)} m, ${Math.round(bad.t.ground - bad.t.alt)} m under the ground.`}
						</MarginNote>
					)}
				</p>
				<EyeEquation />
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
									small="photo 09 phone altitude"
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
					higher, so{" "}
					<HandMark type="wavy">the eye is too high by metres</HandMark>.
					<MarginNote mark="b">
						Which is right, the rule or the contour? No true eye height to score
						either against.
					</MarginNote>
				</p>
				<p>
					A second, optional check treats the altitude as a measurement and
					looks for where it matches the ground. If it finds nothing, it steps
					aside.
				</p>
			</Beat>

			<RealContour />

			<PhotoStory
				number="Fig. 4"
				photoId="demo-09"
				title="From the phone's guess to the solved view"
				crop={[0, 40, 800, 360]}
			/>

			<Numbers
				items={[
					{
						value: bad ? `${Math.round(bad.t.ground - bad.t.alt)} m` : "…",
						label: "photo 09: altitude below the ground (Terrarium)",
					},
					{
						value: medM == null ? "…" : `${sg(medM)} m`,
						label: `median altitude above ground, other 11 photos (Mapterhorn; Terrarium: ${medT == null ? "…" : sg(medT)} m)`,
					},
					{
						value: bandN == null ? "…" : `${bandN} / 12`,
						label: "photos where the altitude contour finds a match",
					},
				]}
				source={
					<>
						Fixes: the 12 Niederhorn demo photos, on Terrarium and Mapterhorn.
					</>
				}
			/>

			<Details>
				<h3>What it is</h3>
				<p>
					<code>eye = max(GPS altitude, DEM + 1.6 m)</code>. With no altitude at
					all, stand on the{" "}
					<a href={gipfelbuchHref("terrain-sampler")}>sampled terrain</a> plus a
					standing eye height. It fixes the vertical component of the{" "}
					<a href={gipfelbuchHref("eye")}>eye</a> and is the first rung the
					solver's position prior is built on.
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
					higher, and the rule puts the eye too high. Phone altitude is reported
					above mean sea level (we did not check this per device) and, where the
					fix is good, should agree with the DEM to a few metres. A height above
					the ellipsoid would be about 50 m higher in Switzerland, where the
					geoid lies 45 to 55 m above it, so mixing the two datums would look
					like a 50 m altitude error. On the twelve Niederhorn fixes it does
					against Mapterhorn but not Terrarium (Fig. 2), so the photographer
					most likely stood where <code>DEM + 1.6 ≈ alt</code> inside the
					horizontal error disk.{" "}
					<HandMark type="strike">Phone altitude is a floor.</HandMark>{" "}
					<span
						className="nb-hand"
						style={{ color: "var(--nb-red)", fontSize: "1.25em" }}
					>
						Phone altitude is evidence.
					</span>
				</p>
				<p>
					The prior in <code>altitude.ts</code> minimises{" "}
					<code>J = |x|²/σH² + ((DEM + 1.6 − alt)/σA)²</code> over the 2σH disk
					with <code>σA = {SIGMA_A} m</code>; the fitted{" "}
					<code>altBias = {ALT_BIAS} m</code> says phone altitude reads about 7
					m below ground + eye on the photos it was fitted on. It is a prior,
					never a snap: it returns a Gaussian and a cost term, and when the band
					is empty it hands back the floor rule, which bounds the damage of a
					wrong bias.
				</p>
				<Hero />
				<h3>Why it matters downstream</h3>
				<p>
					Height shapes the horizon profile, which terrain occludes which, and
					near-field parallax. The{" "}
					<a href={gipfelbuchHref("camera-prior")}>camera prior</a> and the{" "}
					<a href={gipfelbuchHref("exif-prior")}>EXIF prior</a> both start here;{" "}
					<a href={gipfelbuchHref("eye-refinement")}>eye refinement</a> and the{" "}
					<a href={gipfelbuchHref("eye-search-gpu")}>GPU eye search</a> search
					around this height. Even 0.2 m is about 6 px on a 100 m foreground in
					a 4000 px frame (D2), and under a pixel beyond 1 km.
				</p>
				<DriftPlot />
				<Callout tone="lesson" title="Altitude is evidence, not a floor">
					The floor rule throws altitude away whenever the fix lands on higher
					ground than the photographer's. Treating it as a contour recovers it,
					but the −7 m bias was fitted on 10 photos (9 Swiss, 4 days), and fixes
					from US photos read near 0, which is why the prior falls back. See{" "}
					<a href={gipfelbuchHref("datum-msl-vs-ellipsoid")}>
						MSL versus ellipsoid
					</a>{" "}
					before mixing altitude sources.
				</Callout>
				<Callout tone="note" title="Pins carry no altitude">
					Positions typed in or picked on a map have their altitude nulled on
					import, so they always use ground + 1.6 m.
				</Callout>
				<div className="flex flex-wrap gap-2">
					<CodeRef path="src/lib/concord/priors/altitude.ts">
						eyePriorFromExif, concordEye, floorEye
					</CodeRef>
					<CodeRef path="src/lib/deck/scene.ts">eyeAltitude</CodeRef>
					<CodeRef path="src/lib/geo/pipeline.ts">EYE_ABOVE_GROUND</CodeRef>
					<CodeRef path="src/lib/roll/mosaic/ridgelines.worker.ts" />
					<CodeRef path="reports/ontology.md" />
				</div>
			</Details>
		</>
	);
}
