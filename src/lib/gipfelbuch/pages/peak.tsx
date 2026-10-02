// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { CircledKey } from "#/components/gipfelbuch/notebook/carto";
import {
	Hachure,
	HandDot,
	HandText,
	inkColor,
	PenArrow,
	PenCircle,
	PenCross,
	PenLine,
	SketchPath,
	SketchPolyline,
} from "#/components/gipfelbuch/notebook/Ink";
import {
	CircledNumber,
	HandMark,
} from "#/components/gipfelbuch/notebook/marks";
import type { Point } from "#/components/gipfelbuch/notebook/sketch";
import { SWISS } from "#/components/gipfelbuch/swiss/palette";
import {
	Callout,
	CodeRef,
	CrispLine,
	DemPatch,
	Eq,
	Figure,
	Frac,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	HandLabel,
	HandNote,
	HandRange,
	LAYER_STYLE,
	LiveReveal,
	MarginNote,
	Op,
	PhotoPicker,
	RealPhoto,
	Section,
	Steps,
	Sym,
	useGipfelbuchPhoto,
	useReducedMotion,
	useTime,
} from "#/components/gipfelbuch/viz";
import {
	Beat,
	Compare,
	Details,
	Gallery,
	Numbers,
	skylineBand,
	Trio,
} from "#/components/gipfelbuch/viz/explain";
import { cameraFromAngles, directionENU, project } from "#/lib/geo/camera";
import { byId, gipfelbuchHref } from "#/lib/gipfelbuch/graph-utils";
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";

// Peak: from an OSM node to a label in the photo. Everything below mirrors src/lib/geo/peaks.ts:
//   apparentElevation = atan2(h - eye - d²/(2 R_eff), d), R_eff = R / (1 - 0.13)  (REFRACTION_K, geodesy.ts)
//   viewPeaks: distance 50 m .. 150 km, ray march from 20 m with step max(10 m, 0.4 % of d),
//              stops max(150 m, 2 % of d) short of the summit, hidden if a sample is > 0.05° above the summit
//   score = prominence + 800·wikidata − 3000·unnamed + 0.1·height + 400·elevationDeg − 0.002·distance
//   layoutPeakLabels: maxLabels 20, minSpacingPx = 3 % of the image width, greedy by score, then sorted left to right
// The terrain and the candidate summits are synthetic (fictional names); every number the figures
// compute is produced by the code's formulas.

const R_EFF = 6371008.8 / (1 - 0.13);
const RAD = 180 / Math.PI;
const TOL = 0.05;
const DEG1 = Math.PI / 180;

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

/** peaks.ts apparentElevation: degrees above the eye's horizontal, with curvature + refraction. */
const appElev = (h: number, eye: number, d: number) =>
	Math.atan2(h - eye - (d * d) / (2 * R_EFF), d) * RAD;

// ======================================================================================
// Fig. 1 — a side profile and the ray march that decides "visible"
// ======================================================================================
type Summit = { id: string; name: string; km: number; ele: number; w: number };
const SUMMITS: Summit[] = [
	{ id: "A", name: "Rotstock", km: 11, ele: 2050, w: 1.0 },
	{ id: "B", name: "Hohbalm", km: 24, ele: 2900, w: 1.1 },
	{ id: "C", name: "Grauhorn", km: 34, ele: 4300, w: 1.3 },
];
// unnamed ridges that decide the argument
const SHOULDERS = [
	{ km: 6, ele: 1500, w: 1.2 },
	{ km: 16, ele: 2480, w: 1.6 },
];
const GROUND = 700;
const BUMPS = [...SUMMITS, ...SHOULDERS];
function terrain(km: number) {
	let h = GROUND + 60 * Math.sin(km * 0.7);
	for (const b of BUMPS)
		h = Math.max(
			h,
			GROUND + (b.ele - GROUND) * Math.exp(-(((km - b.km) / b.w) ** 2)),
		);
	return h;
}
const KM_MAX = 36;

/** viewPeaks' ray march, optionally cut short at `limitD` metres to animate the sweep. */
function scan(eye: number, s: Summit, limitD = Number.POSITIVE_INFINITY) {
	const dist = s.km * 1000;
	const el = appElev(s.ele, eye, dist);
	const stopAt = dist - Math.max(150, dist * 0.02);
	let n = 0;
	let maxA = Number.NEGATIVE_INFINITY;
	let maxD = 0;
	let maxH = 0;
	let blocked: { d: number; h: number } | null = null;
	let done = true;
	for (let d = 20; d < stopAt; d += Math.max(10, d * 0.004)) {
		if (d > limitD) {
			done = false;
			break;
		}
		const h = terrain(d / 1000);
		const a = appElev(h, eye, d);
		n++;
		if (a > maxA) {
			maxA = a;
			maxD = d;
			maxH = h;
		}
		if (a > el + TOL) {
			blocked = { d, h };
			break;
		}
	}
	return { el, n, maxA, maxD, maxH, blocked, done };
}
/** Lowest eye height (m MSL, 10 m grid) from which the summit passes the visibility test. */
const THRESH = Object.fromEntries(
	SUMMITS.map((s) => {
		for (let e = 800; e <= 2200; e += 10)
			if (!scan(e, s).blocked) return [s.id, e];
		return [s.id, null];
	}),
) as Record<string, number | null>;

const FW = 640;
const FH = 300;
const fx = (km: number) => 22 + (km / KM_MAX) * 596;
const fy = (m: number) => 282 - ((m - 400) / 4100) * 262;
const TERR_PTS: Point[] = [];
for (let k = 0; k <= KM_MAX + 1e-6; k += 0.1)
	TERR_PTS.push([fx(k), fy(terrain(k))]);
const TERR_AREA = `M${fx(0)} ${FH}L${TERR_PTS.map((q) => `${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join("L")}L${fx(KM_MAX)} ${FH}Z`;

// Label sizes: the 640-wide schematics render at the text column (~720 px), so 11 px and 13 px rendered
// are these viewBox units. YAW_NAME is the same 13 px for the 800-px-wide photo crop of YawSlide.
const FIG_LABEL = Math.round(((11 * 640) / 720) * 2) / 2;
const FIG_NAME = Math.round(((13 * 640) / 720) * 2) / 2;
const YAW_NAME = Math.round(((13 * 800) / 720) * 2) / 2;

function RayMarch() {
	const [ref, t] = useTime<HTMLDivElement>(6);
	const reduce = useReducedMotion();
	const [sel, setSel] = useState("B");
	const [eye, setEye] = useState(1000);
	const s = SUMMITS.find((x) => x.id === sel) ?? SUMMITS[1];

	const full = scan(eye, s);
	const stopAt = s.km * 1000 - Math.max(150, s.km * 1000 * 0.02);
	// sweep: march out over ~4.2 s once, then rest. Reduced motion: shown complete.
	const ph = reduce ? 1 : Math.min(1, t / 4.2); // marches once, rests complete
	const limit =
		ph >= 1 ? Number.POSITIVE_INFINITY : 20 + (stopAt - 20) * ph ** 1.6;
	const cur = scan(eye, s, limit);
	const visible = !full.blocked;
	const sweeping = !cur.done && !cur.blocked;

	// the sight line to the summit, in true heights: straight in "effective" space, bent by d²/(2 R_eff)
	const sight = useMemo(() => {
		const tan = Math.tan(full.el / RAD);
		const pts: Point[] = [];
		for (let k = 0; k <= s.km + 1e-6; k += 0.5) {
			const d = k * 1000;
			pts.push([fx(k), fy(eye + tan * d + (d * d) / (2 * R_EFF))]);
		}
		return pts;
	}, [full.el, eye, s.km]);
	const dropAtPeak = (s.km * 1000) ** 2 / (2 * R_EFF);
	const accent = "var(--nb-forest)";
	const bad = "var(--nb-red)";

	return (
		<Figure
			label="Fig. D1"
			bleed
			source="Skizze"
			caption="The visibility test. From the eye, each terrain sample along the ray is converted to the same apparent elevation angle as the summit (curvature and refraction lower it by d²/2R_eff). The summit is hidden once one sample rises more than 0.05° above it. Steps are max(10 m, 0.4 % of d), fine up close and coarse far away, and the march stops short of the summit so its own flank cannot hide it."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<svg
					viewBox={`0 0 ${FW} ${FH}`}
					className="block h-auto w-full"
					role="img"
					aria-label="Side profile of terrain with a sight line from the eye to a summit and the samples that test for occlusion"
				>
					{[1000, 2000, 3000, 4000].map((m) => (
						<g key={m}>
							<PenLine
								from={[22, fy(m)]}
								to={[FW - 22, fy(m)]}
								seed={`pk-rm-grid-${m}`}
								color="faint"
								width={0.5}
							/>
							<HandLabel x={24} y={fy(m) - 3} size={FIG_LABEL} halo={0}>
								{m} m
							</HandLabel>
						</g>
					))}
					<Hachure
						d={TERR_AREA}
						seed="pk-rm-terrain"
						color="brown"
						gap={5}
						opacity={0.55}
					/>
					<SketchPolyline
						points={TERR_PTS}
						seed="pk-rm-ridge"
						data
						color="brown"
						width={1.6}
						passes={1}
					/>
					<PenLine
						from={[22, FH - 2]}
						to={[FW - 22, FH - 2]}
						seed="pk-rm-axis"
						width={1.2}
					/>

					{/* summits */}
					{SUMMITS.map((p) => (
						<g key={p.id}>
							<HandDot
								x={fx(p.km)}
								y={fy(p.ele)}
								r={p.id === sel ? 5 : 3}
								seed={`pk-rm-summit-${p.id}`}
								color={p.id === sel ? (visible ? accent : bad) : "pencil"}
							/>
							<HandNote
								x={fx(p.km)}
								y={fy(p.ele) - 10}
								anchor="middle"
								size={FIG_NAME}
								color={inkColor("navy")}
							>
								{p.id} · {p.name}
							</HandNote>
						</g>
					))}
					{SHOULDERS.map((sh) => (
						<HandNote
							key={sh.km}
							x={fx(sh.km)}
							y={fy(sh.ele) - 8}
							anchor="middle"
							size={FIG_LABEL}
						>
							unnamed ridge
						</HandNote>
					))}

					{/* sight line */}
					<SketchPolyline
						points={sight}
						seed={`pk-rm-sight-${s.id}-${eye}`}
						color={visible ? accent : bad}
						width={1.8}
						dash="5 4"
						passes={1}
					/>

					{/* running worst-case terrain ray so far */}
					{Number.isFinite(cur.maxA) && (
						<PenLine
							from={[fx(0), fy(eye)]}
							to={[fx(cur.maxD / 1000), fy(cur.maxH)]}
							seed="pk-rm-worst"
							color="pencil"
							width={1}
						/>
					)}
					{/* sweep head */}
					{sweeping && (
						<PenLine
							from={[fx(limit / 1000), 20]}
							to={[fx(limit / 1000), FH]}
							seed="pk-rm-head"
							color="faint"
							width={0.9}
						/>
					)}
					{/* blocker */}
					{cur.blocked && (
						<g>
							<PenCircle
								center={[fx(cur.blocked.d / 1000), fy(cur.blocked.h)]}
								radiusX={7}
								seed="pk-rm-blocker"
								color="red"
								width={2}
							/>
							<HandNote
								x={fx(cur.blocked.d / 1000)}
								y={fy(cur.blocked.h) + 24}
								anchor="middle"
								size={FIG_NAME}
								color={inkColor("red")}
							>
								blocked at {(cur.blocked.d / 1000).toFixed(1)} km
							</HandNote>
						</g>
					)}

					{/* the eye */}
					<PenLine
						from={[fx(0), fy(eye)]}
						to={[fx(0), FH]}
						seed="pk-rm-eyeline"
						color="faint"
						width={0.9}
						dash="2 3"
					/>
					<HandDot x={fx(0)} y={fy(eye)} r={4.5} seed="pk-rm-eye" color="ink" />
					<HandNote x={fx(0) + 9} y={fy(eye) + 16} size={FIG_NAME}>
						eye {eye} m
					</HandNote>
					<HandLabel
						x={26}
						y={FH - 10}
						size={FIG_LABEL}
						color="var(--gb-ink)"
						caps
					>
						{`${sweeping ? "MARCHING" : full.blocked ? "HIDDEN" : "VISIBLE"} · ${cur.n} samples`}
					</HandLabel>
					<PenArrow
						from={[fx(s.km) - 60, 30]}
						to={[fx(s.km) - 8, fy(s.ele) - 22]}
						seed="pk-rm-note-arrow"
						color="pencil"
						width={1}
					/>
					<HandText
						x={fx(s.km) - 64}
						y={26}
						size={17}
						anchor="end"
						color="pencil"
					>
						{THRESH[s.id] != null
							? THRESH[s.id] === 800
								? `${s.name}: any eye sees it`
								: `${s.name}: needs an eye ≥ ${THRESH[s.id]} m`
							: `${s.name}: never seen from here`}
					</HandText>
					<HandText
						x={fx(0) + 12}
						y={fy(eye) - 14}
						size={16}
						color="pencil"
						rotate={-2}
					>
						earth drops {dropAtPeak.toFixed(0)} m by {s.km} km
					</HandText>
				</svg>
			</div>

			<div className="mt-4 grid gap-4 md:grid-cols-[1fr_auto]">
				<div className="space-y-3">
					<div className="flex flex-wrap gap-2">
						{SUMMITS.map((p) => (
							<button
								key={p.id}
								type="button"
								onClick={() => setSel(p.id)}
								aria-pressed={p.id === sel}
								className={`px-3 py-1 font-mono text-[11px] transition ${
									p.id === sel
										? "bg-[var(--gb-ink)] text-[var(--gb-paper)]"
										: "bg-[var(--gb-paper-deep)] gb-secondary hover:text-[var(--gb-ink)]"
								}`}
							>
								{p.id} · {p.name} · {p.km} km
							</button>
						))}
					</div>
					<div className="block">
						<span className="flex justify-between font-mono text-[11px] gb-secondary">
							<span>eye height, m a.s.l.</span>
							<span className="text-[var(--gb-ink)]">{eye} m</span>
						</span>
						<HandRange
							min={800}
							max={2200}
							step={10}
							value={eye}
							label="Eye height, metres above sea level"
							onChange={setEye}
						/>
					</div>
				</div>
				<dl className="grid min-w-0 grid-cols-2 gap-x-5 gap-y-2 font-mono text-[11px] md:w-[250px]">
					<div>
						<dt className="gb-secondary">summit angle</dt>
						<dd className="text-[13px] text-[var(--gb-ink)]">
							{full.el.toFixed(2)}°
						</dd>
					</div>
					<div>
						<dt className="gb-secondary">earth-curve drop</dt>
						<dd className="text-[13px] text-[var(--gb-ink)]">
							{dropAtPeak.toFixed(0)} m
						</dd>
					</div>
					<div>
						<dt className="gb-secondary">verdict</dt>
						<dd
							className="text-[13px]"
							style={{ color: visible ? accent : bad }}
						>
							{visible ? "visible" : "hidden"}
						</dd>
					</div>
					<div>
						<dt className="gb-secondary">seen from</dt>
						<dd className="text-[13px] text-[var(--gb-ink)]">
							{THRESH[s.id] != null
								? THRESH[s.id] === 800
									? "any eye"
									: `≥ ${THRESH[s.id]} m`
								: "never here"}
						</dd>
					</div>
				</dl>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Fig. 2 — ranking and greedy label layout
// ======================================================================================
type Cand = {
	name?: string;
	prom?: number;
	wd?: boolean;
	h: number;
	el: number; // apparent elevation, deg
	km: number;
	x: number; // 0..1 across the frame
	visible: boolean;
};
const CANDS: Cand[] = [
	{
		name: "Grauhorn",
		prom: 1100,
		wd: true,
		h: 3980,
		el: 5.2,
		km: 31,
		x: 0.1,
		visible: true,
	},
	{
		name: "Stockspitz",
		prom: 650,
		wd: true,
		h: 3890,
		el: 4.8,
		km: 30,
		x: 0.125,
		visible: true,
	},
	{ name: "Alpligrat", h: 2760, el: 2.6, km: 14, x: 0.24, visible: true },
	{
		name: "Chlifurgg",
		prom: 320,
		h: 3120,
		el: 3.9,
		km: 22,
		x: 0.33,
		visible: true,
	},
	{ h: 2431, el: 1.7, km: 11, x: 0.4, visible: true },
	{
		name: "Firnhorn",
		prom: 800,
		wd: true,
		h: 4010,
		el: 2.6,
		km: 36,
		x: 0.45,
		visible: false,
	},
	{
		name: "Hohbalm",
		prom: 540,
		wd: true,
		h: 3410,
		el: 4.4,
		km: 26,
		x: 0.52,
		visible: true,
	},
	{ name: "Spitzmeilen", h: 2890, el: 3.0, km: 18, x: 0.6, visible: true },
	{
		name: "Rotspitz",
		prom: 210,
		h: 2650,
		el: 2.3,
		km: 9,
		x: 0.67,
		visible: true,
	},
	{
		name: "Wildhorn",
		prom: 900,
		wd: true,
		h: 3770,
		el: 5.0,
		km: 38,
		x: 0.75,
		visible: true,
	},
	{ name: "Nollen", h: 2330, el: 1.2, km: 7, x: 0.82, visible: true },
	{
		name: "Tallistock",
		prom: 300,
		h: 3300,
		el: 2.2,
		km: 29,
		x: 0.89,
		visible: false,
	},
];
/** score() from peaks.ts, verbatim. */
const score = (c: Cand) =>
	(c.prom ?? 0) +
	(c.wd ? 800 : 0) +
	(c.name ? 0 : -3000) +
	0.1 * c.h +
	400 * c.el -
	0.002 * c.km * 1000;

const PW = 640;
const PH = 250;
const py = (el: number) => 218 - el * 30;
const skyEl = (x: number) => {
	let e = 0.9 + 0.25 * Math.sin(x * 21) + 0.15 * Math.sin(x * 47 + 1);
	for (const c of CANDS)
		if (c.visible)
			e = Math.max(e, c.el * Math.exp(-(((x - c.x) / 0.03) ** 2)) + 0.0);
	return e;
};
const SKY_PTS: Point[] = Array.from({ length: 201 }, (_, i) => {
	const x = i / 200;
	return [x * PW, py(skyEl(x))] as Point;
});
const SKY_PATH = (() => {
	const pts: string[] = [];
	for (let i = 0; i <= 200; i++) {
		const x = i / 200;
		pts.push(`${(x * PW).toFixed(1)} ${py(skyEl(x)).toFixed(1)}`);
	}
	return `M0 ${PH} L${pts.join(" L")} L${PW} ${PH} Z`;
})();

type Verdict = {
	c: Cand;
	s: number;
	state: "kept" | "spacing" | "cap" | "hidden";
	why: string;
};

function layout(maxLabels: number, spacingPct: number): Verdict[] {
	const minSpacing = (spacingPct / 100) * PW;
	const vis = CANDS.filter((c) => c.visible).sort(
		(a, b) => score(b) - score(a),
	);
	const kept: Cand[] = [];
	const out: Verdict[] = [];
	let capped = false;
	for (const c of vis) {
		const s = score(c);
		if (capped || kept.length >= maxLabels) {
			capped = true;
			out.push({ c, s, state: "cap", why: `cap reached (${maxLabels})` });
			continue;
		}
		const clash = kept.find((k) => Math.abs(k.x - c.x) * PW < minSpacing);
		if (clash) {
			out.push({
				c,
				s,
				state: "spacing",
				why: `${Math.round(Math.abs(clash.x - c.x) * PW)} px from ${clash.name ?? "peak"} (needs ${Math.round(minSpacing)})`,
			});
		} else {
			kept.push(c);
			out.push({ c, s, state: "kept", why: "kept" });
		}
	}
	return out;
}

function LabelLayout() {
	const [ref, t] = useTime<HTMLDivElement>(60);
	const reduce = useReducedMotion();
	const [manual, setManual] = useState(false);
	const [maxL, setMaxL] = useState(6);
	const [sp, setSp] = useState(3);
	const verdicts = layout(maxL, sp);
	const n = verdicts.length;
	const cursor = manual || reduce ? n : Math.min(n, Math.floor(t * 1.1)); // walks once, rests complete
	const shown = verdicts.slice(0, cursor);
	const hidden = CANDS.filter((c) => !c.visible);
	const keptX = shown
		.filter((v) => v.state === "kept")
		.map((v) => v.c.x)
		.sort((a, b) => a - b);

	return (
		<Figure
			label="Fig. D2"
			bleed
			source="Skizze"
			caption="From visible summits to labels. Candidates are scored, then taken best first. A summit is kept unless a kept one is closer than the minimum spacing (default 3 % of image width); the walk stops at the label cap (default 20; 6 here so the cap shows). The two hollow summits are hidden and never enter the ranking. The unnamed spot height loses 3000 points."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<svg
					viewBox={`0 0 ${PW} ${PH + 20}`}
					className="block h-auto w-full"
					role="img"
					aria-label="A horizon with ranked summits being labelled greedily with a minimum horizontal spacing"
				>
					<Hachure
						d={SKY_PATH}
						seed="pk-ll-sky"
						color="brown"
						gap={7}
						opacity={0.45}
					/>
					<SketchPolyline
						points={SKY_PTS}
						seed="pk-ll-skyline"
						data
						color="brown"
						width={1.6}
						passes={1}
					/>
					<PenLine
						from={[0, PH - 1]}
						to={[PW, PH - 1]}
						seed="pk-ll-axis"
						width={1.2}
					/>

					{/* spacing exclusion bands of the labels already kept */}
					{shown
						.filter((v) => v.state === "kept")
						.map((v) => {
							const bx0 = v.c.x * PW - (sp / 100) * PW;
							const bx1 = bx0 + ((2 * sp) / 100) * PW;
							return (
								<Hachure
									key={`b${v.c.x}`}
									d={`M${bx0} 14L${bx1} 14L${bx1} ${PH}L${bx0} ${PH}Z`}
									seed={`pk-ll-band-${v.c.x}-${sp}`}
									color="pencil"
									gap={7}
									opacity={0.4}
								/>
							);
						})}

					{hidden.map((c) => (
						<g key={c.x}>
							<PenCircle
								center={[c.x * PW, py(c.el)]}
								radiusX={4.5}
								seed={`pk-ll-hid-${c.x}`}
								color="pencil"
								width={1.2}
								dash="2 2"
							/>
							<HandNote
								x={c.x * PW}
								y={py(c.el) + 18}
								anchor="middle"
								size={FIG_LABEL}
							>
								hidden
							</HandNote>
						</g>
					))}

					{shown.map((v, i) => {
						const x = v.c.x * PW;
						const y = py(v.c.el);
						const kept = v.state === "kept";
						const row = kept ? keptX.indexOf(v.c.x) % 2 : 0;
						const ty = 22 + row * 18;
						const seed = `pk-ll-${v.c.x}-${v.c.h}`;
						return (
							<g key={`${v.c.x}-${v.c.h}`}>
								{kept ? (
									<>
										<PenLine
											from={[x, y]}
											to={[x, ty + 4]}
											seed={`${seed}-leader`}
											width={1}
										/>
										<HandDot x={x} y={y} r={4.5} seed={seed} color="navy" />
										<HandNote
											x={x}
											y={ty}
											anchor="middle"
											size={FIG_NAME}
											color={inkColor("navy")}
										>
											{v.c.name ?? "·"}
										</HandNote>
										<HandLabel
											x={x}
											y={ty - 12}
											anchor="middle"
											size={FIG_LABEL}
											halo={0}
										>
											{`#${i + 1}`}
										</HandLabel>
									</>
								) : (
									<>
										<PenCircle
											center={[x, y]}
											radiusX={4.5}
											seed={`${seed}-ring`}
											color="red"
											width={1.5}
										/>
										<PenCross
											center={[x, y]}
											size={3}
											seed={`${seed}-x`}
											color="red"
											width={1.2}
										/>
									</>
								)}
							</g>
						);
					})}
					<HandLabel
						x={PW - 8}
						y={PH + 14}
						anchor="end"
						size={FIG_LABEL}
						halo={0}
					>
						{`${shown.filter((v) => v.state === "kept").length} labels · min spacing ${Math.round((sp / 100) * PW)} px`}
					</HandLabel>
				</svg>
			</div>

			<ol className="mt-4 grid list-none gap-x-8 gap-y-2 p-0 font-mono text-[11px] leading-[14px] md:grid-cols-2">
				{verdicts.map((v, i) => (
					<li
						key={`${v.c.x}-${v.c.h}`}
						className="grid grid-cols-[1.25rem_minmax(5.5rem,auto)_3rem_1fr] items-baseline gap-x-2 transition-opacity"
						style={{ opacity: i < cursor ? 1 : 0.25 }}
					>
						<span className="gb-secondary">{i + 1}</span>
						<span className="gb-ink">{v.c.name ?? "(unnamed)"}</span>
						<span className="text-right gb-secondary">{Math.round(v.s)}</span>
						<span
							className="whitespace-normal"
							style={{
								color:
									v.state === "kept" ? "var(--gb-forest)" : "var(--gb-red)",
							}}
						>
							{v.why}
						</span>
					</li>
				))}
			</ol>

			<div className="mt-4 grid gap-4 sm:grid-cols-2">
				<div className="block">
					<span className="flex justify-between font-mono text-[11px] gb-secondary">
						<span>label cap (default 20)</span>
						<span className="text-[var(--gb-ink)]">{maxL}</span>
					</span>
					<HandRange
						min={1}
						max={10}
						step={1}
						value={maxL}
						label="Label cap"
						onChange={(v) => {
							setManual(true);
							setMaxL(v);
						}}
					/>
				</div>
				<div className="block">
					<span className="flex justify-between font-mono text-[11px] gb-secondary">
						<span>minimum spacing, % of image width (default 3)</span>
						<span className="text-[var(--gb-ink)]">{sp.toFixed(1)} %</span>
					</span>
					<HandRange
						min={0}
						max={12}
						step={0.5}
						value={sp}
						label="Minimum spacing, percent of image width"
						onChange={(v) => {
							setManual(true);
							setSp(v);
						}}
					/>
				</div>
			</div>
			<div className="mt-3">
				<button
					type="button"
					onClick={() => setManual(false)}
					className="bg-[var(--gb-paper-deep)] px-3 py-1 font-mono text-[11px] gb-secondary transition hover:text-[var(--gb-ink)]"
				>
					{manual ? "↻ replay the walk" : "auto-playing"}
				</button>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Measured: the ray march replayed on a real hidden summit (scripts/gipfelbuch/data-peak.ts)
// ======================================================================================
type PeakData = {
	script: string;
	generated: string;
	dem: string;
	counts: Record<
		string,
		{ inFrame: number; visible: number; hidden: number; labelled: number }
	>;
	profile: {
		id: string;
		name: string;
		azimuth: number;
		distance: number;
		height: number;
		elevationDeg: number;
		eye: number;
		toleranceDeg: number;
		firstBlocker: [number, number, number];
		highestAngle: [number, number, number];
		terrain: [number, number][];
	};
};
let peakDataPromise: Promise<PeakData> | null = null;
function usePeakData() {
	const [d, setD] = useState<PeakData | null>(null);
	useEffect(() => {
		let live = true;
		peakDataPromise ??= fetch("/demo/gipfelbuch/peak/peak.json").then((r) =>
			r.json(),
		);
		peakDataPromise.then((v) => live && setD(v)).catch(() => {});
		return () => {
			live = false;
		};
	}, []);
	return d;
}

// paper inks of the cyan solved and red prior layers (PAPER_INK kin)
const CYAN_TEXT = "var(--gb-water)";
const RED_TEXT = "var(--gb-red)";

function HiddenSummit() {
	const d = useGipfelbuchPhoto("demo-10");
	const pk = usePeakData();
	const pr = pk?.profile;
	const crop: [number, number, number, number] = [320, 120, 760, 250];
	const summit = d?.peaks.find((p) => p.name === pr?.name);
	const q = summit?.solved;
	const k = (crop[2] - crop[0]) / 800;
	const skyY = q && d ? d.solvedRows[Math.round(q[0])] : null;

	// side view
	const FW = 640;
	const FH = 230;
	const km = pr ? pr.distance / 1000 : 35;
	const fx = (m: number) => 14 + (m / 1000 / km) * 612;
	const fy = (h: number) => 214 - ((h - 1500) / 3000) * 190;
	const bent = (theta: number, m: number) =>
		(pr?.eye ?? 0) + Math.tan(theta / RAD) * m + (m * m) / (2 * R_EFF);
	const terr = pr
		? `M${fx(0)} ${FH} L${pr.terrain.map(([m, h]) => `${fx(m).toFixed(1)} ${fy(h).toFixed(1)}`).join(" L")} L${fx(pr.distance)} ${FH} Z`
		: "";
	const line = (theta: number, to: number) => {
		const pts: string[] = [];
		for (let m = 0; m <= to; m += 500)
			pts.push(`${fx(m).toFixed(1)} ${fy(bent(theta, m)).toFixed(1)}`);
		return `M${pts.join(" L")}`;
	};
	const ridgeDeg = pr?.highestAngle[2] ?? 0;
	const gapDeg = pr ? ridgeDeg - pr.elevationDeg : 0;

	return (
		<Figure
			label="Fig. 3"
			bleed
			pinned="demo-10"
			caption={
				<>
					{pr ? (
						<>
							{pr.name} ({pr.height} m, {(pr.distance / 1000).toFixed(0)} km)
							<CircledNumber value={1} color="blue" /> would sit{" "}
							{gapDeg.toFixed(1)}° below the ridge <CircledNumber value={2} />{" "}
							{(pr.highestAngle[0] / 1000).toFixed(0)} km in front of it, so it
							gets no label.{" "}
						</>
					) : null}
				</>
			}
		>
			<RealPhoto
				bleed
				data={d}
				layers={["solved", "peaks"]}
				crop={crop}
				maxLabels={5}
				// the hidden summit's bearing, on the compass ruler
				spillCursor={q ? { x: q[0], label: pr?.name } : null}
			>
				{() =>
					q && skyY != null ? (
						<g>
							<CrispLine
								d={`M${q[0]} ${q[1]}L${q[0]} ${skyY}`}
								color={LAYER_STYLE.prior.color}
								width={1.8 * k}
							/>
							<PenCircle
								center={[q[0], q[1]]}
								radiusX={5.5 * k}
								seed="pk-hs-summit"
								color="blue"
								width={2 * k}
							/>
							<HandNote
								x={q[0] + 10 * k}
								y={q[1] + 22 * k}
								size={12.5 * k}
								color={inkColor("blue")}
							>
								{pr?.name}, hidden
							</HandNote>
							<HandNote
								x={q[0] + 10 * k}
								y={(q[1] + skyY) / 2 + 4 * k}
								size={12.5 * k}
								color={inkColor("red")}
							>
								{Math.round(q[1] - skyY)} px of ridge
							</HandNote>
						</g>
					) : null
				}
			</RealPhoto>
			{pr && (
				<svg
					viewBox={`0 0 ${FW} ${FH}`}
					className="mt-3 block h-auto w-full"
					role="img"
					aria-label="Side view along the bearing to the hidden summit: the sight line to the ridge passes above the summit"
				>
					<Hachure
						d={terr}
						seed="pk-hs-terrain"
						color="brown"
						gap={5}
						opacity={0.55}
					/>
					<SketchPath
						d={`M${pr.terrain.map(([m, h]) => `${fx(m).toFixed(1)} ${fy(h).toFixed(1)}`).join("L")}`}
						seed="pk-hs-ridge"
						data
						color="brown"
						width={1.8}
					/>
					<SketchPath
						d={line(pr.elevationDeg, pr.distance)}
						seed="pk-hs-sight-summit"
						data
						color="blue"
						width={1.8}
						dash="5 4"
					/>
					<SketchPath
						d={line(ridgeDeg, pr.distance)}
						seed="pk-hs-sight-ridge"
						data
						color="red"
						width={2}
					/>
					<PenArrow
						from={[fx(pr.distance) - 150, fy(pr.height) - 52]}
						to={[fx(pr.distance) - 14, fy(pr.height) - 6]}
						seed="pk-hs-gap-arrow"
						color="pencil"
						width={1}
					/>
					<HandText
						x={fx(pr.distance) - 154}
						y={fy(pr.height) - 56}
						anchor="end"
						size={17}
						color="pencil"
						rotate={-2}
					>
						{`only ${gapDeg.toFixed(1)}° too low to clear it`}
					</HandText>
					<HandDot
						x={fx(0)}
						y={fy(pr.eye)}
						r={4}
						seed="pk-hs-eye"
						color="ink"
					/>
					<HandText x={fx(0) + 9} y={fy(pr.eye) + 18} size={15}>
						eye {Math.round(pr.eye)} m
					</HandText>
					<PenCircle
						center={[fx(pr.highestAngle[0]), fy(pr.highestAngle[1])]}
						radiusX={5.5}
						seed="pk-hs-ridgering"
						color="red"
						width={2}
					/>
					<HandNote
						x={fx(pr.highestAngle[0]) - 4}
						y={fy(pr.highestAngle[1]) + 24}
						anchor="end"
						size={FIG_NAME}
						color={inkColor("red")}
					>
						ridge, {(pr.highestAngle[0] / 1000).toFixed(0)} km
					</HandNote>
					<PenCircle
						center={[fx(pr.distance), fy(pr.height)]}
						radiusX={4.5}
						seed="pk-hs-summitring"
						color="blue"
						width={1.8}
					/>
					<CircledKey
						x={fx(pr.distance) + 18}
						y={fy(pr.height) - 4}
						value={1}
						color="blue"
						seed="pk-hs-key1"
					/>
					<CircledKey
						x={fx(pr.highestAngle[0]) + 16}
						y={fy(pr.highestAngle[1]) - 8}
						value={2}
						seed="pk-hs-key2"
					/>
					<HandNote
						x={fx(pr.distance) - 9}
						y={fy(pr.height) - 12}
						anchor="end"
						size={FIG_NAME}
						color={inkColor("blue")}
					>
						{pr.name}, {(pr.distance / 1000).toFixed(0)} km
					</HandNote>
				</svg>
			)}
			{pr && (
				<Eq
					className="!mb-0"
					where={[
						{
							sym: (
								<>
									θ<sub>summit</sub>
								</>
							),
							c: CYAN_TEXT,
							text: (
								<>
									angle up to the summit: {pr.elevationDeg.toFixed(2)}° (dashed
									line)
								</>
							),
						},
						{
							sym: (
								<>
									θ<sub>ridge</sub>
								</>
							),
							c: RED_TEXT,
							text: (
								<>
									steepest angle to any ground on the way: {ridgeDeg.toFixed(2)}
									° (solid line)
								</>
							),
						},
						{
							sym: "z",
							text: <>eye height {Math.round(pr.eye)} m above sea level</>,
						},
					]}
				>
					<Sym c={RED_TEXT}>θ</Sym>
					<sub>ridge</sub> = <Op op="max" under={<Sym>d</Sym>} />
					<Sym>θ</Sym>(<Sym>h</Sym>(<Sym>d</Sym>), <Sym>d</Sym>)
					<br />
					{ridgeDeg.toFixed(2)}° &gt; <Sym c={CYAN_TEXT}>θ</Sym>
					<sub>summit</sub> + 0.05° ({pr.elevationDeg.toFixed(2)}° + 0.05°) ⇒
					hidden
					<br />
					<Sym>θ</Sym>(<Sym>h</Sym>, <Sym>d</Sym>) = atan2(<Sym>h</Sym> −{" "}
					<Sym>z</Sym> −{" "}
					<Frac
						n={<>d²</>}
						d={
							<>
								2R<sub>eff</sub>
							</>
						}
					/>
					, <Sym>d</Sym>)
				</Eq>
			)}
		</Figure>
	);
}

// ======================================================================================
// Measured: 1° of yaw error moves every label by f·tan(1°) px (demo-01 solved camera)
// ======================================================================================
const YAW_CROP: [number, number, number, number] = [0, 150, 800, 330];

function YawSlide() {
	const d = useGipfelbuchPhoto("demo-01");
	const [err, setErr] = useState(3);
	const cams = useMemo(() => {
		if (!d) return null;
		const mk = (yawErr: number) =>
			cameraFromAngles({
				width: d.photo.width,
				height: d.photo.height,
				f: d.solved.f,
				yaw: d.solved.yaw + yawErr,
				pitch: d.solved.pitch,
				roll: d.solved.roll,
			});
		return { truth: mk(0), at: mk };
	}, [d]);
	const picks = useMemo(() => {
		if (!d) return [];
		const lab = d.peaks.filter(
			(p) => p.labelled && p.solved && p.solved[1] >= YAW_CROP[1],
		);
		return [...lab]
			.sort((a, b) => (a.solved?.[0] ?? 0) - (b.solved?.[0] ?? 0))
			.filter((_, i) => i % 3 === 0)
			.slice(0, 6);
	}, [d]);
	const cam = cams?.at(err);
	const f = d?.solved.f ?? 0;
	const pxPerDeg = f * Math.tan(DEG1);
	const shifted = picks.map((p) => {
		const qq = cam && project(cam, directionENU(p.az, p.el));
		return { p, q: qq };
	});
	return (
		<Figure
			label="Fig. 5"
			bleed
			caption={
				<>
					Each degree of compass error slides every label sideways by{" "}
					{pxPerDeg.toFixed(1)} px, whatever the peak. Rings are where the
					summits really are.
				</>
			}
		>
			<RealPhoto
				bleed
				data={d}
				layers={[]}
				crop={YAW_CROP}
				// where the erring compass thinks the centre points
				spillCursor={
					d
						? {
								az: d.solved.yaw + err,
								label: `compass ${err > 0 ? "+" : ""}${err.toFixed(1)}°`,
								layer: "prior",
							}
						: null
				}
			>
				{() => (
					<g>
						{shifted.map(({ p, q }) => {
							const t = p.solved as [number, number];
							if (!q) return null;
							return (
								<g key={p.name}>
									<CrispLine
										d={`M${t[0]} ${t[1]}L${q[0]} ${q[1]}`}
										color={SWISS.paper}
										width={1.6}
									/>
									<PenCircle
										center={[t[0], t[1]]}
										radiusX={6.5}
										seed={`pk-yaw-true-${p.name}`}
										color="blue"
										width={2}
									/>
									<HandDot
										x={q[0]}
										y={q[1]}
										r={4}
										seed={`pk-yaw-dot-${p.name}`}
										color="ink"
									/>
									<HandNote
										x={q[0]}
										y={q[1] - 12}
										anchor="middle"
										size={YAW_NAME}
										color={inkColor("navy")}
									>
										{p.name}
									</HandNote>
								</g>
							);
						})}
					</g>
				)}
			</RealPhoto>
			<div className="mt-3 block">
				<span className="flex justify-between font-mono text-[11px] gb-secondary">
					<span>compass error</span>
					<span className="text-[var(--gb-ink)]">
						{err.toFixed(1)}° · {(f * Math.tan(err * DEG1)).toFixed(0)} px
					</span>
				</span>
				<HandRange
					min={0}
					max={10}
					step={0.5}
					value={err}
					label="Compass error in degrees"
					onChange={setErr}
				/>
			</div>
			<Eq
				className="!mb-0"
				where={[
					{
						sym: "f",
						text: <>focal length in pixels: {f.toFixed(0)} px (photo 01)</>,
					},
					{ sym: "Δψ", c: "var(--accent)", text: "yaw (compass) error" },
				]}
			>
				<Sym c="var(--accent)">Δx</Sym> ≈ <Sym>f</Sym> · tan(<Sym>Δψ</Sym>)
				<br />= {f.toFixed(0)} px × {Math.tan(err * DEG1).toFixed(3)} ={" "}
				<Sym c="var(--accent)">{(f * Math.tan(err * DEG1)).toFixed(0)} px</Sym>
			</Eq>
		</Figure>
	);
}

// ======================================================================================
// Page
// ======================================================================================
// ======================================================================================
// Measured figures: the real pipeline on the Niederhorn demo photos (public/demo/gipfelbuch)
// ======================================================================================
const REAL_IDS = ["demo-10", "demo-09", "demo-03"] as const;
// crop to the skyline band (keeps the people in demo-09/10 out of frame)
const REAL_CROP: Record<string, [number, number, number, number]> = {
	"demo-10": [320, 110, 760, 250],
	"demo-09": [300, 20, 800, 190],
	"demo-03": [0, 235, 800, 435],
};

function MiniDem() {
	const d = useGipfelbuchPhoto("demo-01");
	return <DemPatch data={d} cone={["solved"]} peaks={false} />;
}

function RealSummits() {
	const [id, setId] = useState<GipfelbuchPhotoId>("demo-10");
	const d = useGipfelbuchPhoto(id);
	const [showHidden, setShowHidden] = useState(true);
	const crop = REAL_CROP[id];
	const inFrame = d?.peaks.filter((p) => p.solved) ?? [];
	// One source for every count on the page: the usePeakData memo (the full run); the bake keeps only the
	// tallest peaks per photo, so the rings are drawn from those.
	const pc = usePeakData()?.counts[id];
	const hid = inFrame
		.filter((p) => !p.visible && p.solved)
		.sort((a, b) => b.dem - a.dem);
	const RINGED = 6;
	const lab = d?.peaks.filter((p) => p.labelled && p.solved) ?? [];
	const names = new Set(lab.map((p) => p.name));
	const nLabelled = names.size;
	return (
		<Figure
			label="Fig. 1"
			bleed
			caption={
				<>
					Red rings mark the {Math.min(RINGED, hid.length)} tallest hidden
					summits; below, the same rays from above.
				</>
			}
		>
			<PhotoPicker
				value={id}
				onChange={setId}
				ids={REAL_IDS}
				mark={() => null}
			/>
			<div className="grid gap-4">
				<div>
					<RealPhoto
						data={d}
						layers={["peaks"]}
						crop={crop}
						labelInfo
						bleed
						maxLabels={7}
					>
						{(dd) =>
							showHidden ? (
								<HiddenRings d={dd} crop={crop} top={hid.slice(0, RINGED)} />
							) : null
						}
					</RealPhoto>
					<button
						type="button"
						onClick={() => setShowHidden((v) => !v)}
						aria-pressed={showHidden}
						className="mt-3 inline-flex items-center gap-1.5 bg-[var(--gb-paper-deep)] px-2.5 py-1 font-mono text-[11px] gb-ink"
					>
						<svg
							viewBox="0 0 12 12"
							className="size-3"
							style={{ opacity: showHidden ? 1 : 0.3 }}
							aria-hidden="true"
						>
							<PenCircle
								center={[6, 6]}
								radiusX={4.2}
								seed="pk-rs-toggle"
								color="red"
								width={1.3}
							/>
						</svg>
						hidden summits (behind a nearer ridge)
					</button>
				</div>
			</div>
			<div className="mt-4 grid items-center gap-4 lg:grid-cols-[1.5fr_1fr]">
				<DemPatch data={d} cone={["solved"]} peaks={false}>
					{(_dd, toPx) => {
						const o = toPx(0, 0);
						const rays = (
							list: GipfelbuchPhotoData["peaks"],
							color: string,
							dash?: string,
						) =>
							list.map((p) => {
								const q = toPx(p.az, Math.min(p.distance, 60_000));
								return (
									<PenLine
										key={`${p.name}-${p.az}`}
										from={[o[0], o[1]]}
										to={[q[0], q[1]]}
										seed={`pk-ray-${p.name}-${p.az}`}
										data
										color={color}
										opacity={0.95}
										width={1.4}
										dash={dash}
									/>
								);
							});
						return (
							<>
								{rays(lab.slice(0, 12), SWISS.paper)}
								{showHidden && rays(hid.slice(0, RINGED), SWISS.red, "3 3")}
							</>
						);
					}}
				</DemPatch>
				<dl className="grid grid-cols-3 gap-x-4 font-mono text-[13px] leading-[16px] gb-secondary">
					<div>
						<dt className="gb-secondary">visible</dt>
						<dd className="text-[22px] gb-ink">{pc ? pc.visible : "…"}</dd>
					</div>
					<div>
						<dt className="gb-secondary">labelled</dt>
						<dd className="text-[22px] text-[var(--gb-forest)]">
							{pc ? pc.labelled : nLabelled}
						</dd>
					</div>
					<div>
						<dt className="gb-secondary">
							hidden (tallest {Math.min(RINGED, hid.length)} ringed)
						</dt>
						<dd className="text-[22px] text-[var(--gb-red)]">
							{pc ? pc.hidden : "…"}
						</dd>
					</div>
				</dl>
			</div>
		</Figure>
	);
}

function HiddenRings({
	d,
	crop,
	top,
}: {
	d: GipfelbuchPhotoData;
	crop: [number, number, number, number];
	top: GipfelbuchPhotoData["peaks"];
}) {
	const k = (crop[2] - crop[0]) / d.photo.width;
	return (
		<g>
			{top.map((p) => {
				const [x, y] = p.solved as [number, number];
				if (y < crop[1] || y > crop[3]) return null;
				return (
					<PenCircle
						key={`${p.name}-${p.az}`}
						center={[x, y]}
						radiusX={7 * k}
						seed={`pk-ring-${p.name}-${p.az}`}
						color="red"
						width={2.4 * k}
					/>
				);
			})}
		</g>
	);
}

// Fig: azimuth vs elevation angle, DEM skyline against every summit
function RealOcclusion() {
	const d = useGipfelbuchPhoto("demo-10");
	if (!d)
		return (
			<div className="my-12 aspect-[2/1] animate-pulse bg-[var(--gb-paper-deep)] motion-reduce:animate-none" />
		);
	const P = d.horizon.profile;
	const W = 640;
	const H = 300;
	const [a0, a1] = [P[0].az, P[P.length - 1].az];
	const els = d.peaks.map((p) => p.el);
	const [e0, e1] = [
		Math.min(-0.5, Math.min(...els) - 0.3),
		Math.max(...els) + 0.6,
	];
	const x = (a: number) => 34 + ((a - a0) / (a1 - a0)) * (W - 48);
	const y = (e: number) => 14 + (1 - (e - e0) / (e1 - e0)) * (H - 40);
	const near = (a: number) =>
		P.reduce((b, q) => (Math.abs(q.az - a) < Math.abs(b.az - a) ? q : b), P[0]);
	const tall = d.peaks.filter((p) => p.dem >= 3300 && p.az >= a0 && p.az <= a1);
	const gap = (p: (typeof tall)[number]) => p.el - near(p.az).el;
	const hid = tall.filter((p) => !p.visible);
	const vis = tall.filter((p) => p.visible);
	const worst = [...hid].sort((a, b) => gap(a) - gap(b))[0];
	const named = hid.find((p) => p.name === "Aletschhorn") ?? worst;
	return (
		<Figure
			label="Fig. 4"
			pinned="demo-10"
			caption={
				<>
					{hid.length} tall summits sit{" "}
					{Math.min(...hid.map((p) => -gap(p))).toFixed(1)}–
					{Math.max(...hid.map((p) => -gap(p))).toFixed(1)}° below the horizon
					(the {vis.length} visible ones sit on it).{" "}
					{named && (
						<>
							{named.name} is {(-gap(named)).toFixed(1)}° under it.
						</>
					)}
				</>
			}
		>
			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="block h-auto w-full"
				role="img"
				aria-label="Terrain horizon elevation angle against azimuth, with visible summits on it and hidden summits below it"
			>
				{[0, 2, 4, 6]
					.filter((e) => e >= e0 && e <= e1)
					.map((e) => (
						<g key={e}>
							<PenLine
								from={[34, y(e)]}
								to={[W - 14, y(e)]}
								seed={`pk-ro-grid-${e}`}
								color="faint"
								width={0.5}
							/>
							<HandLabel
								x={28}
								y={y(e) + 3}
								anchor="end"
								size={FIG_LABEL}
								halo={0}
							>
								{`${e}°`}
							</HandLabel>
						</g>
					))}
				<PenLine
					from={[34, H - 26]}
					to={[W - 14, H - 26]}
					seed="pk-ro-axis"
					width={1.2}
				/>
				<SketchPath
					d={`M${P.map((q) => `${x(q.az).toFixed(1)} ${y(q.el).toFixed(1)}`).join("L")}`}
					seed="pk-ro-skyline"
					data
					color="brown"
					width={2}
				/>
				{hid.map((p) => (
					<g key={`${p.name}-${p.az}`}>
						<PenLine
							from={[x(p.az), y(p.el)]}
							to={[x(p.az), y(near(p.az).el)]}
							seed={`pk-ro-gap-${p.name}-${p.az}`}
							color="faint"
							width={0.9}
						/>
						<PenCircle
							center={[x(p.az), y(p.el)]}
							radiusX={4.8}
							seed={`pk-ro-hid-${p.name}-${p.az}`}
							data
							color="red"
							width={1.8}
						/>
					</g>
				))}
				{vis.map((p) => (
					<HandDot
						key={`${p.name}-${p.az}`}
						x={x(p.az)}
						y={y(p.el)}
						r={p.labelled ? 4.2 : 3.4}
						seed={`pk-ro-vis-${p.name}-${p.az}`}
						data
						color={p.labelled ? "forest" : "pencil"}
					/>
				))}
				{named && (
					<HandNote
						x={x(named.az) + 7}
						y={y(named.el) - 6}
						size={FIG_NAME}
						color={inkColor("red")}
					>
						{named.name}
					</HandNote>
				)}
				<HandLabel x={W - 14} y={H - 6} anchor="end" size={FIG_LABEL} halo={0}>
					{`azimuth ${a0.toFixed(0)}°–${a1.toFixed(0)}°`}
				</HandLabel>
				{worst && (
					<>
						<PenArrow
							from={[x(worst.az) + 70, y(worst.el) - 34]}
							to={[x(worst.az) + 8, y(worst.el) - 4]}
							seed="pk-ro-worst-arrow"
							color="pencil"
							width={1}
						/>
						<HandText
							x={x(worst.az) + 74}
							y={y(worst.el) - 38}
							size={17}
							color="pencil"
							rotate={-2}
						>
							{`${worst.name}: ${Math.abs(gap(worst)).toFixed(2)}° under the horizon`}
						</HandText>
					</>
				)}
				<HandText x={40} y={H - 34} size={16} color="pencil" rotate={-1.5}>
					horizon = steepest ground in every direction
				</HandText>
			</svg>
			<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] gb-secondary">
				<span>
					<span className="text-[var(--gb-forest)]">●</span> labelled
				</span>
				<span>
					<span
						style={{
							color: "color-mix(in srgb, var(--gb-ink) 40%, var(--gb-paper))",
						}}
					>
						●
					</span>{" "}
					visible, not labelled
				</span>
				<span>
					<span className="text-[var(--gb-red)]">○</span> hidden by terrain
				</span>
			</div>
		</Figure>
	);
}

function HiddenMini() {
	const d = useGipfelbuchPhoto("demo-10");
	const crop = REAL_CROP["demo-10"];
	const hid = (d?.peaks ?? [])
		.filter((p) => p.solved && !p.visible)
		.sort((a, b) => b.dem - a.dem)
		.slice(0, 6);
	return (
		<RealPhoto data={d} layers={["peaks"]} crop={crop} maxLabels={4}>
			{(dd) => <HiddenRings d={dd} crop={crop} top={hid} />}
		</RealPhoto>
	);
}

function BandPeaks({
	id,
	maxLabels = 6,
}: {
	id: GipfelbuchPhotoId;
	maxLabels?: number;
}) {
	const d = useGipfelbuchPhoto(id);
	return (
		<RealPhoto
			data={d}
			layers={["peaks"]}
			crop={d ? skylineBand(d, 220) : undefined}
			maxLabels={maxLabels}
		/>
	);
}

const GALLERY_IDS = ["demo-01", "demo-02", "demo-03", "demo-06"] as const;
export default function Page({ node }: { node: GipfelbuchNode }) {
	void node;
	const d1 = useGipfelbuchPhoto("demo-01");
	const peakData = usePeakData();
	const pc = peakData?.counts["demo-10"];
	const visible10 = pc ? pc.visible : null;
	// Fig. 1: how far the labelled summits move between the phone's guess and the solved pose
	const moved = d1
		? d1.peaks
				.filter((p) => p.labelled && p.solved && p.prior)
				.map((p) =>
					Math.hypot(
						(p.solved as [number, number])[0] -
							(p.prior as [number, number])[0],
						(p.solved as [number, number])[1] -
							(p.prior as [number, number])[1],
					),
				)
		: [];
	const movedMedian = [...moved].sort((a, b) => a - b)[
		Math.floor(moved.length / 2)
	];
	const pxDeg = d1 ? d1.solved.f * Math.tan(DEG1) : null;
	const crop1: [number, number, number, number] = [0, 40, 800, 360];
	return (
		<>
			<RealSummits />

			<Beat
				kicker="The idea"
				title="A summit becomes a label only if the eye can see it."
			>
				<p>
					A map says a mountain exists.{" "}
					<HandMark type="highlight">It does not say you can see it.</HandMark>
				</p>
				<p>
					For each summit we ask: how high, which way, is it hidden, is it worth
					the space? Each summit is first {link("terrain-snapping", "snapped")}{" "}
					onto the real ridge.
					<MarginNote mark="a">
						{movedMedian
							? `Compass ${Math.abs(d1?.solved.delta.yaw ?? 0).toFixed(1)}° off: the median summit slid ${movedMedian.toFixed(0)} px.`
							: "A bad pose slides every summit sideways."}
					</MarginNote>
				</p>
			</Beat>

			<Figure
				label="Fig. 2"
				bleed
				caption={
					moved.length
						? `${moved.length} labelled summits move a median ${movedMedian.toFixed(0)} px between the phone's guess and the solved pose (compass ${Math.abs(d1?.solved.delta.yaw ?? 0).toFixed(1)}° off).`
						: "Same photo, same summits: only the camera pose changes."
				}
			>
				<Compare
					start={0.5}
					beforeLabel="phone's guess"
					afterLabel="solved pose"
					before={
						<RealPhoto
							bleed
							data={d1}
							layers={["prior", "priorPeaks"]}
							crop={crop1}
							maxLabels={7}
						/>
					}
					after={
						<RealPhoto
							bleed
							data={d1}
							layers={["solved", "peaks"]}
							crop={crop1}
							maxLabels={7}
						/>
					}
				/>
			</Figure>

			<Beat
				kicker="How it works"
				title="Aim at it, look along the ray, keep the best."
			>
				<Trio
					steps={[
						{
							title: "Aim",
							body: "Height and bearing give the angle above your eye.",
							visual: <MiniDem />,
						},
						{
							title: "Look",
							body: "A nearer ridge higher than the summit hides it (red rings).",
							visual: <HiddenMini />,
						},
						{
							title: "Choose",
							body: "Best-known first. Drop any label that crowds a neighbour.",
							visual: <BandPeaks id="demo-03" />,
						},
					]}
				/>
			</Beat>

			<Beat kicker="Why it is hidden" title="Terrain hides most named summits.">
				<p>
					{pc ? (
						<>
							Of {pc.inFrame} named peaks in photo 10's frame,{" "}
							<HandMark type="double">
								{pc.hidden} sit behind a nearer ridge
							</HandMark>
							.
						</>
					) : (
						"Most named peaks in the frame sit behind a nearer ridge."
					)}
				</p>
				<p>
					We compare angles: a summit is hidden if{" "}
					<HandMark type="underline">
						any ground on the way looks higher
					</HandMark>{" "}
					than it does.
				</p>
			</Beat>

			<HiddenSummit />

			<RealOcclusion />

			<Beat
				kicker="Where it fails"
				title="A few degrees of compass error put every name on the wrong ridge."
			>
				<p>
					Every label moves by the same{" "}
					<HandMark type="wavy">
						{pxDeg ? `${pxDeg.toFixed(0)} px` : "…"}
					</HandMark>{" "}
					per degree. That is why the {link("accept-rule", "accept rule")} comes
					first.
				</p>
				<p>
					Even with a good pose,{" "}
					{pc && visible10 != null
						? `only ${pc.labelled} of the ${visible10} visible summits`
						: "few visible summits"}{" "}
					get a label.{" "}
					<HandMark type="underline">
						Spacing and a 20-label cap drop the rest.
					</HandMark>
				</p>
			</Beat>

			<YawSlide />

			<Figure
				label="Fig. 6"
				caption={
					<>
						Four more photos, same rules: terrain hides most named peaks, the
						label cap trims the rest.
					</>
				}
			>
				<Gallery
					ids={GALLERY_IDS}
					cols={2}
					tile={(d) => <BandPeaks id={d.id} />}
					label={(d) => {
						const c = peakData?.counts[d.id];
						return c ? (
							<>
								<span className="gb-ink">{c.inFrame}</span> in frame,{" "}
								<span className="text-[var(--gb-red)]">{c.hidden}</span> hidden,{" "}
								<span className="text-[var(--accent)]">{c.labelled}</span>{" "}
								labelled
							</>
						) : null;
					}}
				/>
			</Figure>

			{/* A photo figure of its own, so the plate spills its surround too (README, concept spill). */}
			<LiveReveal
				number="Fig. 7"
				photoId="demo-01"
				title="The labels, drawn into the photo"
				notes={[
					{
						text: "each name stands on a summit that survived the four questions",
						at: [0.5, 0.25],
						side: "right",
						y: 0.1,
					},
					{
						text: "the ridge in front is why the far names are missing",
						at: [0.3, 0.7],
						side: "left",
					},
				]}
			/>

			<Numbers
				items={[
					{
						value: pc ? `${pc.hidden} of ${pc.inFrame}` : "…",
						label: "named peaks in photo 10's frame hidden by terrain",
					},
					{
						value:
							pc && visible10 != null ? `${pc.labelled} of ${visible10}` : "…",
						label: "visible summits that get a label (photo 10)",
					},
					{
						value: "0.05°",
						label: "how far a ridge may rise above a summit before it hides it",
					},
					{ value: "150 km", label: "farthest summit considered" },
				]}
				source="Counts for photo 10: named OpenStreetMap peaks within 120 km."
			/>

			<Details>
				<Section
					title="A summit has to survive four questions"
					kicker="Mechanism"
				>
					<p>
						An OSM node says only that a mountain exists somewhere near a point.
						To become a label in the photo it has to answer: how high is it, in
						which direction and at what angle from this eye, can the eye
						actually see it, and is it worth the pixels.
						<MarginNote mark="b">
							Four questions, four steps below. The third is the one that drops
							most.
						</MarginNote>{" "}
						The {link("terrain-snapping", "snapping sheet")} covers the first
						half of question one (moving the node onto the DEM summit).
					</p>
				</Section>
				<Section title="The mechanism, in isolation" kicker="Schematic">
					<p>
						Invented summits: move the eye and watch one ray march pass or fail.
					</p>
				</Section>

				<RayMarch />

				<Section title="How it works" kicker="Step by step">
					<Steps
						steps={[
							{
								title: "Ask Overpass for summits",
								body: (
									<>
										<code>overpassPeaksQuery</code> fetches{" "}
										<code>natural=peak</code> and <code>natural=volcano</code>{" "}
										nodes in a radius around the photo.{" "}
										<code>parseOverpassPeaks</code> keeps nodes only and reads{" "}
										<code>name</code> (falling back to <code>name:de</code>,{" "}
										<code>name:en</code>), <code>ele</code>,{" "}
										<code>prominence</code> and <code>wikidata</code>. Heights
										parse in several formats, including feet.
									</>
								),
							},
							{
								title: "Settle the height",
								body: (
									<>
										<code>
											height = max(DEM local max near the node, OSM ele)
										</code>
										. The local-max search is the one described on the snapping
										page: OSM nodes sit a little off the summit and the DEM
										knows the ridge. Taking the larger of the two means a good
										tagged <code>ele</code> still wins when the DEM is smoothed.
									</>
								),
							},
							{
								title: "Direction and apparent angle",
								body: (
									<>
										<code>distanceBearing</code> gives azimuth and range from
										the eye. <code>apparentElevation</code> turns height into an
										angle with the same <code>d² / (2 R_eff)</code> drop the{" "}
										{link("dem-horizon", "horizon trace")} uses, so a label and
										the ridge it names agree about where the summit is. Peaks
										nearer than 50 m or farther than 150 km are skipped.
									</>
								),
							},
							{
								title: "March the ray",
								body: (
									<>
										Fig. D1. From 20 m outward, sample the{" "}
										{link("terrain-sampler", "terrain")} along the bearing; if
										any sample appears more than 0.05° above the summit, it is
										hidden. The last <code>max(150 m, 2 % of d)</code> is
										ignored, because the summit's own flank is allowed to look
										higher than its top.
									</>
								),
							},
							{
								title: "Project, rank, space out",
								body: (
									<>
										<code>layoutPeakLabels</code> projects each visible summit
										through the camera, drops anything outside the frame, sorts
										by <code>score</code>, and keeps a label only if no kept
										label is within <code>minSpacingPx</code> horizontally. Fig.
										D2. The survivors are returned left to right, ready for the
										overlay.
									</>
								),
							},
						]}
					/>
				</Section>

				<LabelLayout />

				<Section title="What the score rewards" kicker="Ranking">
					<p>
						<code>
							score = prominence + 800·wikidata − 3000·unnamed + 0.1·height +
							400·elevation° − 0.002·distance
						</code>
						. Prominence is the best signal and is rarely tagged, so the rest
						stands in: a <code>wikidata</code> link means someone thought the
						peak worth a page, a missing name is nearly disqualifying, and{" "}
						<code>400 · elevation</code> favours summits that stand tall in the
						frame, which is what a person would point at. Distance only breaks
						ties. The result is that{" "}
						<HandMark type="highlight">
							the biggest, best-known, best-seen summits get the first claim on
							screen space
						</HandMark>
						.
						<MarginNote mark="c">
							Unnamed costs 3000: that is a veto, not a ranking.
						</MarginNote>
					</p>
				</Section>

				<Section title="Where it fits" kicker="Context">
					<p>
						Visibility depends on the eye height, so the{" "}
						{link("eye-rule", "eye rule")} feeds it directly, and the pose that
						places labels comes from{" "}
						{link("viewport-inference", "viewport inference")}. A peak is also
						the thing a person taps in {link("tap-a-peak", "tap-a-peak")} to pin
						the pose, and the labels themselves are drawn in the{" "}
						{link("photo-workspace", "photo workspace")}.
					</p>
				</Section>

				<Callout tone="lesson" title="Lesson">
					A label is a claim about the photo. Filtering by the same
					ray-and-angle model that built the horizon means the app never names a
					mountain the terrain says is behind another.
				</Callout>
				<div className="mt-10 flex flex-wrap gap-2">
					<CodeRef path="src/lib/geo/peaks.ts" />
					<CodeRef path="src/lib/photos.ts" />
					<CodeRef path="src/lib/picker/candidates.ts" />
					<CodeRef path="reports/ontology.md" />
				</div>
				<dl className="mt-4 grid gap-x-6 gap-y-1 font-mono text-[11px] gb-secondary sm:grid-cols-2">
					<div>
						<dt className="inline text-[var(--accent)]">
							overpassPeaksQuery / parseOverpassPeaks
						</dt>
						<dd className="inline"> · fetch and normalise</dd>
					</div>
					<div>
						<dt className="inline text-[var(--accent)]">
							viewPeaks(peaks, terrain, lat, lon, eye)
						</dt>
						<dd className="inline"> · PeakView[] with visible</dd>
					</div>
					<div>
						<dt className="inline text-[var(--accent)]">
							apparentElevation(h, eye, d)
						</dt>
						<dd className="inline"> · degrees, curvature + refraction</dd>
					</div>
					<div>
						<dt className="inline text-[var(--accent)]">
							layoutPeakLabels(views, cam, opts)
						</dt>
						<dd className="inline"> · PeakLabel[] left to right</dd>
					</div>
				</dl>
			</Details>
		</>
	);
}
