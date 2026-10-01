import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
	type AtlasPhotoData,
	type AtlasPhotoId,
	Callout,
	CodeRef,
	DemPatch,
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
	Compare,
	Details,
	Gallery,
	Numbers,
	skylineBand,
	Trio,
} from "#/components/atlas/viz/explain";
import { atlasHref, byId } from "#/lib/atlas/graph-utils";
import type { AtlasNode } from "#/lib/atlas/types";

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

function link(id: string, label: string) {
	if (!byId.has(id)) return <>{label}</>;
	return (
		<Link to={atlasHref(id)} className="underline decoration-white/25">
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

function RayMarch() {
	const [ref, t] = useTime<HTMLDivElement>(6);
	const reduce = useReducedMotion();
	const [sel, setSel] = useState("B");
	const [eye, setEye] = useState(1000);
	const s = SUMMITS.find((x) => x.id === sel) ?? SUMMITS[1];

	const full = scan(eye, s);
	const stopAt = s.km * 1000 - Math.max(150, s.km * 1000 * 0.02);
	// sweep: march out over ~4.2 s, hold, repeat. Reduced motion: shown complete.
	const ph = reduce ? 1 : Math.min(1, (t % 7.5) / 4.2);
	const limit =
		ph >= 1 ? Number.POSITIVE_INFINITY : 20 + (stopAt - 20) * ph ** 1.6;
	const cur = scan(eye, s, limit);
	const visible = !full.blocked;
	const sweeping = !cur.done && !cur.blocked;

	const terr = (() => {
		const pts: string[] = [];
		for (let k = 0; k <= KM_MAX + 1e-6; k += 0.1)
			pts.push(`${fx(k).toFixed(1)} ${fy(terrain(k)).toFixed(1)}`);
		return `M${fx(0)} ${FH} L${pts.join(" L")} L${fx(KM_MAX)} ${FH} Z`;
	})();
	// the sight line to the summit, in true heights: straight in "effective" space, bent by d²/(2 R_eff)
	const sight = (() => {
		const tan = Math.tan(full.el / RAD);
		const pts: string[] = [];
		for (let k = 0; k <= s.km + 1e-6; k += 0.5) {
			const d = k * 1000;
			pts.push(
				`${fx(k).toFixed(1)} ${fy(eye + tan * d + (d * d) / (2 * R_EFF)).toFixed(1)}`,
			);
		}
		return `M${pts.join(" L")}`;
	})();
	const dropAtPeak = (s.km * 1000) ** 2 / (2 * R_EFF);
	const accent = "var(--accent)";
	const bad = "var(--rigi-trap)";

	return (
		<Figure
			label="Schematic 1"
			bleed
			caption="The visibility test in viewPeaks. From the eye, every terrain sample along the ray is converted to the same apparent elevation angle as the summit (curvature and refraction lower it by d²/2R_eff). The summit is hidden as soon as one sample rises more than 0.05° above it. The marcher steps by max(10 m, 0.4 % of d), so it is fine up close and coarse far away, and it stops short of the summit so the peak's own flank cannot hide it. Terrain and summits are synthetic."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<svg
					viewBox={`0 0 ${FW} ${FH}`}
					className="block h-auto w-full rounded-xl"
					role="img"
					aria-label="Side profile of terrain with a sight line from the eye to a summit and the samples that test for occlusion"
				>
					<defs>
						<linearGradient id="pk-ter" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0" stopColor="#4a5560" />
							<stop offset="1" stopColor="#1b2025" />
						</linearGradient>
					</defs>
					<rect width={FW} height={FH} fill="#12171c" />
					{[1000, 2000, 3000, 4000].map((m) => (
						<g key={m}>
							<line
								x1="22"
								x2={FW - 22}
								y1={fy(m)}
								y2={fy(m)}
								stroke="rgba(236,230,218,.08)"
							/>
							<text
								x="24"
								y={fy(m) - 3}
								fontSize="9"
								className="font-mono"
								fill="rgba(236,230,218,.35)"
							>
								{m} m
							</text>
						</g>
					))}
					<path d={terr} fill="url(#pk-ter)" />

					{/* summits */}
					{SUMMITS.map((p) => (
						<g key={p.id}>
							<circle
								cx={fx(p.km)}
								cy={fy(p.ele)}
								r={p.id === sel ? 5 : 3}
								fill={
									p.id === sel
										? visible
											? accent
											: bad
										: "rgba(236,230,218,.55)"
								}
							/>
							<text
								x={fx(p.km)}
								y={fy(p.ele) - 10}
								textAnchor="middle"
								fontSize="10"
								className="font-mono"
								fill="rgba(236,230,218,.7)"
							>
								{p.id} · {p.name}
							</text>
						</g>
					))}
					{SHOULDERS.map((sh) => (
						<text
							key={sh.km}
							x={fx(sh.km)}
							y={fy(sh.ele) - 8}
							textAnchor="middle"
							fontSize="9"
							className="font-mono"
							fill="rgba(236,230,218,.4)"
						>
							unnamed ridge
						</text>
					))}

					{/* sight line */}
					<path
						d={sight}
						fill="none"
						stroke={visible ? accent : bad}
						strokeWidth="1.4"
						strokeDasharray="5 4"
						strokeOpacity=".9"
					/>

					{/* running worst-case terrain ray so far */}
					{Number.isFinite(cur.maxA) && (
						<line
							x1={fx(0)}
							y1={fy(eye)}
							x2={fx(cur.maxD / 1000)}
							y2={fy(cur.maxH)}
							stroke="var(--rigi-paper)"
							strokeOpacity=".55"
							strokeWidth="1"
						/>
					)}
					{/* sweep head */}
					{sweeping && (
						<line
							x1={fx(limit / 1000)}
							x2={fx(limit / 1000)}
							y1="20"
							y2={FH}
							stroke={accent}
							strokeOpacity=".5"
						/>
					)}
					{/* blocker */}
					{cur.blocked && (
						<g>
							<circle
								cx={fx(cur.blocked.d / 1000)}
								cy={fy(cur.blocked.h)}
								r="7"
								fill="none"
								stroke={bad}
								strokeWidth="2"
							/>
							<text
								x={fx(cur.blocked.d / 1000)}
								y={fy(cur.blocked.h) + 22}
								textAnchor="middle"
								fontSize="10"
								className="font-mono"
								fill={bad}
							>
								blocked at {(cur.blocked.d / 1000).toFixed(1)} km
							</text>
						</g>
					)}

					{/* the eye */}
					<line
						x1={fx(0)}
						x2={fx(0)}
						y1={fy(eye)}
						y2={FH}
						stroke="rgba(236,230,218,.35)"
						strokeDasharray="2 3"
					/>
					<circle cx={fx(0)} cy={fy(eye)} r="4.5" fill="var(--rigi-paper)" />
					<text
						x={fx(0) + 8}
						y={fy(eye) + 14}
						fontSize="10"
						className="font-mono"
						fill="var(--rigi-paper)"
					>
						eye {eye} m
					</text>
					<text
						x={FW - 22}
						y="16"
						textAnchor="end"
						fontSize="10"
						className="font-mono"
						fill="rgba(236,230,218,.5)"
					>
						{sweeping ? "MARCHING" : full.blocked ? "HIDDEN" : "VISIBLE"} ·{" "}
						{cur.n} samples
					</text>
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
								className={`rounded-full px-3 py-1 font-mono text-[11px] ring-1 transition ${
									p.id === sel
										? "bg-[var(--accent)]/15 text-[var(--rigi-paper)] ring-[var(--accent)]"
										: "text-white/60 ring-white/15 hover:text-white"
								}`}
							>
								{p.id} · {p.name} · {p.km} km
							</button>
						))}
					</div>
					<label className="block">
						<span className="flex justify-between font-mono text-[11px] text-white/45">
							<span>eye height, m MSL</span>
							<span className="text-[var(--rigi-paper)]">{eye} m</span>
						</span>
						<input
							type="range"
							min={800}
							max={2200}
							step={10}
							value={eye}
							onChange={(e) => setEye(Number(e.target.value))}
							className="mt-1 w-full accent-[var(--accent)]"
						/>
					</label>
				</div>
				<dl className="grid min-w-[230px] grid-cols-2 gap-x-5 gap-y-2 font-mono text-[11px]">
					<div>
						<dt className="text-white/40">summit angle</dt>
						<dd className="text-[13px] text-[var(--rigi-paper)]">
							{full.el.toFixed(2)}°
						</dd>
					</div>
					<div>
						<dt className="text-white/40">curve + refr. drop</dt>
						<dd className="text-[13px] text-[var(--rigi-paper)]">
							{dropAtPeak.toFixed(0)} m
						</dd>
					</div>
					<div>
						<dt className="text-white/40">verdict</dt>
						<dd
							className="text-[13px]"
							style={{ color: visible ? accent : bad }}
						>
							{visible ? "visible" : "hidden"}
						</dd>
					</div>
					<div>
						<dt className="text-white/40">seen from</dt>
						<dd className="text-[13px] text-[var(--rigi-paper)]">
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
				why: `${Math.round(Math.abs(clash.x - c.x) * PW)} px from ${clash.name ?? "peak"} (< ${Math.round(minSpacing)})`,
			});
		} else {
			kept.push(c);
			out.push({ c, s, state: "kept", why: "kept" });
		}
	}
	return out;
}

function LabelLayout() {
	const [ref, t] = useTime<HTMLDivElement>(0);
	const reduce = useReducedMotion();
	const [manual, setManual] = useState(false);
	const [maxL, setMaxL] = useState(6);
	const [sp, setSp] = useState(3);
	const verdicts = layout(maxL, sp);
	const n = verdicts.length;
	const cursor =
		manual || reduce ? n : Math.min(n, Math.floor((t * 1.1) % (n + 5)));
	const shown = verdicts.slice(0, cursor);
	const hidden = CANDS.filter((c) => !c.visible);
	const keptX = shown
		.filter((v) => v.state === "kept")
		.map((v) => v.c.x)
		.sort((a, b) => a - b);

	return (
		<Figure
			label="Schematic 2"
			bleed
			caption="From visible summits to labels. Candidates are scored with the exact formula in peaks.ts, then taken best first. A summit is kept unless one already kept is closer than the minimum spacing across the image (default 3 % of the width), and the walk stops at maxLabels (default 20; 6 here so the cap shows). The two hollow summits failed the ray march and never enter the ranking. The unnamed spot height loses 3000 points and is placed last. Summits and scores are synthetic."
		>
			<div ref={ref} className="-m-1 sm:-m-2">
				<svg
					viewBox={`0 0 ${PW} ${PH + 20}`}
					className="block h-auto w-full rounded-xl"
					role="img"
					aria-label="A skyline with ranked summits being labelled greedily with a minimum horizontal spacing"
				>
					<rect width={PW} height={PH + 20} fill="#12171c" />
					<path d={SKY_PATH} fill="#2a323a" />
					<path
						d={SKY_PATH}
						fill="none"
						stroke="rgba(236,230,218,.25)"
						strokeWidth="1.5"
					/>

					{/* spacing exclusion bands of the labels already kept */}
					{shown
						.filter((v) => v.state === "kept")
						.map((v) => (
							<rect
								key={`b${v.c.x}`}
								x={v.c.x * PW - (sp / 100) * PW}
								width={((2 * sp) / 100) * PW}
								y="14"
								height={PH - 14}
								fill="var(--accent)"
								fillOpacity=".08"
							/>
						))}

					{hidden.map((c) => (
						<g key={c.x}>
							<circle
								cx={c.x * PW}
								cy={py(c.el)}
								r="4"
								fill="none"
								stroke="rgba(236,230,218,.4)"
								strokeDasharray="2 2"
							/>
							<text
								x={c.x * PW}
								y={py(c.el) + 16}
								textAnchor="middle"
								fontSize="10"
								className="font-mono"
								fill="rgba(236,230,218,.35)"
							>
								hidden
							</text>
						</g>
					))}

					{shown.map((v, i) => {
						const x = v.c.x * PW;
						const y = py(v.c.el);
						const kept = v.state === "kept";
						const row = kept ? keptX.indexOf(v.c.x) % 2 : 0;
						const ty = 22 + row * 18;
						return (
							<g key={`${v.c.x}-${v.c.h}`}>
								{kept ? (
									<>
										<line
											x1={x}
											x2={x}
											y1={y}
											y2={ty + 4}
											stroke="var(--accent)"
											strokeOpacity=".7"
										/>
										<circle cx={x} cy={y} r="4.5" fill="var(--accent)" />
										<text
											x={x}
											y={ty}
											textAnchor="middle"
											fontSize="13"
											className="display-title"
											fill="var(--rigi-paper)"
										>
											{v.c.name ?? "·"}
										</text>
										<text
											x={x}
											y={ty - 12}
											textAnchor="middle"
											fontSize="9"
											className="font-mono"
											fill="var(--accent)"
										>
											{`#${i + 1}`}
										</text>
									</>
								) : (
									<>
										<circle
											cx={x}
											cy={y}
											r="4"
											fill="none"
											stroke="var(--rigi-trap)"
											strokeWidth="1.5"
										/>
										<path
											d={`M${x - 3} ${y - 3} L${x + 3} ${y + 3} M${x + 3} ${y - 3} L${x - 3} ${y + 3}`}
											stroke="var(--rigi-trap)"
											strokeWidth="1.2"
										/>
									</>
								)}
							</g>
						);
					})}
					<text
						x={PW - 8}
						y={PH + 14}
						textAnchor="end"
						fontSize="10"
						className="font-mono"
						fill="rgba(236,230,218,.45)"
					>
						{shown.filter((v) => v.state === "kept").length} labels · min
						spacing {Math.round((sp / 100) * PW)} px of {PW}
					</text>
				</svg>
			</div>

			<ol className="mt-4 grid gap-x-6 gap-y-1 font-mono text-[11px] sm:grid-cols-2">
				{verdicts.map((v, i) => (
					<li
						key={`${v.c.x}-${v.c.h}`}
						className="flex items-baseline gap-2 transition-opacity"
						style={{ opacity: i < cursor ? 1 : 0.25 }}
					>
						<span className="w-5 text-white/35">{i + 1}</span>
						<span className="min-w-[88px] text-[var(--rigi-paper)]">
							{v.c.name ?? "(unnamed)"}
						</span>
						<span className="w-12 text-right text-white/50">
							{Math.round(v.s)}
						</span>
						<span
							className="truncate"
							style={{
								color:
									v.state === "kept" ? "var(--accent)" : "var(--rigi-trap)",
							}}
							title={v.why}
						>
							{v.why}
						</span>
					</li>
				))}
			</ol>

			<div className="mt-4 grid gap-4 sm:grid-cols-2">
				<label className="block">
					<span className="flex justify-between font-mono text-[11px] text-white/45">
						<span>maxLabels (code default 20)</span>
						<span className="text-[var(--rigi-paper)]">{maxL}</span>
					</span>
					<input
						type="range"
						min={1}
						max={10}
						step={1}
						value={maxL}
						onChange={(e) => {
							setManual(true);
							setMaxL(Number(e.target.value));
						}}
						className="mt-1 w-full accent-[var(--accent)]"
					/>
				</label>
				<label className="block">
					<span className="flex justify-between font-mono text-[11px] text-white/45">
						<span>minSpacing, % of image width (default 3)</span>
						<span className="text-[var(--rigi-paper)]">{sp.toFixed(1)} %</span>
					</span>
					<input
						type="range"
						min={0}
						max={12}
						step={0.5}
						value={sp}
						onChange={(e) => {
							setManual(true);
							setSp(Number(e.target.value));
						}}
						className="mt-1 w-full accent-[var(--accent)]"
					/>
				</label>
			</div>
			<div className="mt-3">
				<button
					type="button"
					onClick={() => setManual(false)}
					className="rounded-full px-3 py-1 font-mono text-[11px] text-white/70 ring-1 ring-white/15 transition hover:text-white"
				>
					{manual ? "↻ replay the walk" : "auto-playing"}
				</button>
			</div>
		</Figure>
	);
}

// ======================================================================================
// Page
// ======================================================================================
const SHAPES: [string, string][] = [
	["Peak", "geo/peaks.ts: OSM node with ele, prominence, wikidata"],
	[
		"RegionPeak",
		"photos.ts: stored per region, ele and prominence may be null",
	],
	["PoolPeak", "picker/candidates.ts: summit in the engine's ENU metres"],
	["PeakInput", "export/geojson.ts: what exports write"],
	[
		"PeakLabel ×3",
		"settings, deck/scene, geo/peaks: the projected, placed result",
	],
];

// ======================================================================================
// Measured figures: the real pipeline on the Niederhorn demo photos (public/demo/atlas)
// ======================================================================================
const REAL_IDS = ["demo-10", "demo-09", "demo-03"] as const;
// crop to the skyline band (keeps the people in demo-09/10 out of frame)
const REAL_CROP: Record<string, [number, number, number, number]> = {
	"demo-10": [320, 110, 760, 250],
	"demo-09": [300, 20, 800, 190],
	"demo-03": [0, 235, 800, 435],
};

function MiniDem() {
	const d = useAtlasPhoto("demo-01");
	return <DemPatch data={d} cone={["solved"]} peaks={false} />;
}

function RealSummits() {
	const [id, setId] = useState<AtlasPhotoId>("demo-10");
	const d = useAtlasPhoto(id);
	const [showHidden, setShowHidden] = useState(true);
	const crop = REAL_CROP[id];
	const inFrame = d?.peaks.filter((p) => p.solved) ?? [];
	const vis = inFrame.filter((p) => p.visible);
	const hid = inFrame
		.filter((p) => !p.visible && p.solved)
		.sort((a, b) => b.dem - a.dem);
	const lab = d?.peaks.filter((p) => p.labelled && p.solved) ?? [];
	const names = new Set(lab.map((p) => p.name));
	const nLabelled = names.size;
	return (
		<Figure
			label="Fig. 2"
			bleed
			caption={
				<>
					White labels survive; red rings are the tallest summits a nearer ridge
					hides. Right: the same rays from above. <Measured data={d} />
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
						maxLabels={9}
					>
						{(dd) =>
							showHidden ? (
								<HiddenRings d={dd} crop={crop} top={hid.slice(0, 6)} />
							) : null
						}
					</RealPhoto>
					<button
						type="button"
						onClick={() => setShowHidden((v) => !v)}
						className="mt-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10.5px] text-white/80 ring-1 ring-white/20"
					>
						<span
							className="size-2 rounded-full ring-1 ring-[#ff6b6b]"
							style={{ opacity: showHidden ? 1 : 0.3 }}
						/>
						hidden summits (failed ray march)
					</button>
				</div>
			</div>
			<div className="mt-4 grid items-center gap-4 sm:grid-cols-[minmax(0,300px)_1fr]">
				<DemPatch data={d} cone={["solved"]} peaks={false}>
					{(_dd, toPx) => {
						const o = toPx(0, 0);
						const rays = (
							list: AtlasPhotoData["peaks"],
							color: string,
							dash?: string,
						) =>
							list.map((p) => {
								const q = toPx(p.az, Math.min(p.distance, 60_000));
								return (
									<line
										key={`${p.name}-${p.az}`}
										x1={o[0]}
										y1={o[1]}
										x2={q[0]}
										y2={q[1]}
										stroke={color}
										strokeWidth={1}
										strokeOpacity={0.8}
										strokeDasharray={dash}
									/>
								);
							});
						return (
							<>
								{rays(lab.slice(0, 12), "#ece6da")}
								{showHidden && rays(hid.slice(0, 6), "#ff6b6b", "3 3")}
							</>
						);
					}}
				</DemPatch>
				<dl className="grid grid-cols-3 gap-x-4 font-mono text-[11px] text-white/60">
					<div>
						<dt className="text-white/40">in frame, visible</dt>
						<dd className="text-lg text-white/90">{vis.length}</dd>
					</div>
					<div>
						<dt className="text-white/40">labelled</dt>
						<dd className="text-lg text-[var(--accent)]">{nLabelled}</dd>
					</div>
					<div>
						<dt className="text-white/40">hidden (tallest 40 kept)</dt>
						<dd className="text-lg text-[#ff6b6b]">{hid.length}</dd>
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
	d: AtlasPhotoData;
	crop: [number, number, number, number];
	top: AtlasPhotoData["peaks"];
}) {
	const k = (crop[2] - crop[0]) / d.photo.width;
	return (
		<g>
			{top.map((p) => {
				const [x, y] = p.solved as [number, number];
				if (y < crop[1] || y > crop[3]) return null;
				return (
					<circle
						key={`${p.name}-${p.az}`}
						cx={x}
						cy={y}
						r={4.5 * k}
						fill="none"
						stroke="#ff6b6b"
						strokeWidth={1.6 * k}
					/>
				);
			})}
		</g>
	);
}

// Fig: azimuth vs elevation angle, DEM skyline against every summit
function RealOcclusion() {
	const d = useAtlasPhoto("demo-10");
	if (!d) return <Figure label="Fig. 3">Loading…</Figure>;
	const P = d.horizon.profile;
	const W = 640;
	const H = 250;
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
	const line = P.map(
		(q, i) => `${i ? "L" : "M"}${x(q.az).toFixed(1)} ${y(q.el).toFixed(1)}`,
	).join("");
	const worst = [...hid].sort((a, b) => gap(a) - gap(b))[0];
	const named = hid.find((p) => p.name === "Aletschhorn") ?? worst;
	return (
		<Figure
			label="Fig. 3"
			caption={
				<>
					{hid.length} tall summits sit{" "}
					{Math.min(...hid.map((p) => -gap(p))).toFixed(1)}–
					{Math.max(...hid.map((p) => -gap(p))).toFixed(1)}° below the skyline
					(demo-10; the {vis.length} visible ones sit on it).{" "}
					{named && (
						<>
							{named.name} is {(-gap(named)).toFixed(1)}° under it.{" "}
						</>
					)}
					<Measured data={d} />
				</>
			}
		>
			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="block h-auto w-full"
				role="img"
				aria-label="DEM skyline elevation angle against azimuth, with visible summits on it and hidden summits below it"
			>
				{[0, 2, 4, 6]
					.filter((e) => e >= e0 && e <= e1)
					.map((e) => (
						<g key={e}>
							<line
								x1={34}
								x2={W - 14}
								y1={y(e)}
								y2={y(e)}
								stroke="rgba(236,230,218,.08)"
							/>
							<text
								x={28}
								y={y(e) + 3}
								textAnchor="end"
								fontSize={9}
								fill="rgba(236,230,218,.45)"
								fontFamily="ui-monospace, monospace"
							>
								{e}°
							</text>
						</g>
					))}
				<path
					d={line}
					fill="none"
					stroke="rgba(236,230,218,.7)"
					strokeWidth={1.6}
				/>
				{hid.map((p) => (
					<g key={`${p.name}-${p.az}`}>
						<line
							x1={x(p.az)}
							x2={x(p.az)}
							y1={y(p.el)}
							y2={y(near(p.az).el)}
							stroke="#ff6b6b"
							strokeOpacity={0.5}
						/>
						<circle
							cx={x(p.az)}
							cy={y(p.el)}
							r={3.6}
							fill="none"
							stroke="#ff6b6b"
							strokeWidth={1.4}
						/>
					</g>
				))}
				{vis.map((p) => (
					<circle
						key={`${p.name}-${p.az}`}
						cx={x(p.az)}
						cy={y(p.el)}
						r={3.2}
						fill={p.labelled ? "var(--accent)" : "#ece6da"}
						fillOpacity={p.labelled ? 1 : 0.55}
					/>
				))}
				{named && (
					<text
						x={x(named.az) + 6}
						y={y(named.el) - 6}
						fontSize={10}
						fill="#ff6b6b"
						stroke="#0e1012"
						strokeWidth={3}
						paintOrder="stroke"
					>
						{named.name}
					</text>
				)}
				<text
					x={W - 14}
					y={H - 6}
					textAnchor="end"
					fontSize={9}
					fill="rgba(236,230,218,.45)"
					fontFamily="ui-monospace, monospace"
				>
					azimuth {a0.toFixed(0)}°–{a1.toFixed(0)}° · skyline step{" "}
					{d.horizon.step}°
				</text>
			</svg>
			<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10.5px] text-white/60">
				<span>
					<span className="text-[var(--accent)]">●</span> labelled
				</span>
				<span>
					<span className="text-white/60">●</span> visible, not labelled
				</span>
				<span>
					<span className="text-[#ff6b6b]">○</span> hidden by terrain
				</span>
			</div>
		</Figure>
	);
}

function HiddenMini() {
	const d = useAtlasPhoto("demo-10");
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
	id: AtlasPhotoId;
	maxLabels?: number;
}) {
	const d = useAtlasPhoto(id);
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
const countIn = (d: AtlasPhotoData) => ({
	vis: d.peaks.filter((p) => p.visible && p.solved).length,
	lab: new Set(d.peaks.filter((p) => p.labelled && p.solved).map((p) => p.name))
		.size,
});

export default function Page({ node }: { node: AtlasNode }) {
	void node;
	const d1 = useAtlasPhoto("demo-01");
	const c1 = d1 ? countIn(d1) : null;
	const crop1: [number, number, number, number] = [0, 40, 800, 360];
	return (
		<>
			<Figure
				label="Fig. 1"
				bleed
				caption={
					<>
						Same photo, same summits: only the camera pose changes. The compass
						was {d1 ? Math.abs(d1.solved.delta.yaw).toFixed(1) : "…"}° off.{" "}
						<Measured data={d1} />
					</>
				}
			>
				<Compare
					start={0.5}
					beforeLabel="phone's guess"
					afterLabel="solved pose"
					before={
						<RealPhoto
							data={d1}
							layers={["prior", "priorPeaks"]}
							crop={crop1}
							maxLabels={7}
						/>
					}
					after={
						<RealPhoto
							data={d1}
							layers={["solved", "peaks"]}
							crop={crop1}
							maxLabels={7}
						/>
					}
				/>
			</Figure>

			<Beat
				kicker="The idea"
				title="A summit becomes a label only if the eye can see it."
			>
				<p>A map says a mountain exists. It does not say you can see it.</p>
				<p>
					For each summit we ask: how high, which way, is it hidden, is it worth
					the space? Each summit is first {link("terrain-snapping", "snapped")}{" "}
					onto the real ridge.
				</p>
			</Beat>

			<RealSummits />

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

			<Beat
				kicker="Why it is hidden"
				title="Hidden summits sit below the skyline in front of them."
			>
				<p>Each dot is a summit. A red ring means a nearer ridge covers it.</p>
			</Beat>

			<RealOcclusion />

			<Beat
				kicker="Where it fails"
				title="Crowding, not terrain, removes most summits."
			>
				<p>
					Most visible summits never get a label. The spacing rule drops them to
					keep names readable.
				</p>
				<p>
					A wrong pose is worse: a right name lands on the wrong ridge. That is
					why the {link("accept-rule", "accept rule")} comes first.
				</p>
			</Beat>

			<Figure
				label="Fig. 4"
				caption={
					<>
						Four people-free photos, same rule: many summits visible, at most a
						few dozen named. <Measured data={d1} />
					</>
				}
			>
				<Gallery
					ids={GALLERY_IDS}
					cols={2}
					tile={(d) => <BandPeaks id={d.id} />}
					label={(d) => {
						const c = countIn(d);
						return (
							<>
								<span className="text-white/80">{c.vis}</span> visible,{" "}
								<span className="text-[var(--accent)]">{c.lab}</span> labelled
							</>
						);
					}}
				/>
			</Figure>

			<Numbers
				items={[
					{
						value: c1 ? String(c1.vis) : "…",
						label: "summits visible in demo-01's frame",
					},
					{
						value: c1 ? String(c1.lab) : "…",
						label: "of them get a label",
					},
					{
						value: "0.05°",
						label: "how far a nearer ridge may rise above a summit",
					},
					{ value: "150 km", label: "farthest summit considered" },
				]}
				source={
					<>
						Counts: measured on demo-01 (scripts/atlas/build-data.ts). Tolerance
						and range: src/lib/geo/peaks.ts.
					</>
				}
			/>

			<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-white/60">
				Next: a person can name a summit themselves with{" "}
				{link("tap-a-peak", "tap a peak")}, and that tap fixes the pose.
			</p>

			<Details>
				<Section
					title="A summit has to survive four questions"
					kicker="Mechanism"
				>
					<p>
						An OSM node says only that a mountain exists somewhere near a point.
						To become a label in the photo it has to answer: how high is it, in
						which direction and at what angle from <em>this</em> eye, can the
						eye actually see it, and is it worth the pixels. All four live in{" "}
						<code>geo/peaks.ts</code>, in about two hundred lines. The{" "}
						{link("terrain-snapping", "snapping page")} covers the first half of
						question one (moving the node onto the DEM summit); this page
						follows a peak from there to the screen.
					</p>
				</Section>
				<Section title="The mechanism, in isolation" kicker="Schematic">
					<p>
						Schematic 1 below is a schematic with invented summits: it exists so
						you can move the eye and watch a single ray march succeed or fail.
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
										are forgiving: <code>"1,234.5"</code> and{" "}
										<code>"4000 ft"</code> both parse, the latter converted at
										0.3048.
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
										Schematic 1. From 20 m outward, sample the{" "}
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
										2. The survivors are returned left to right, ready for the
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
						ties. The result is that the biggest, best-known, best-seen summits
						get the first claim on screen space.
					</p>
				</Section>

				<Section title="Seven shapes, one concept" kicker="In the ontology">
					<p>
						The same summit appears as different types depending on the stage it
						is in. The catalogue in <code>reports/ontology.md</code> names the
						canonical one and the bridges:
					</p>
					<dl className="mt-3 grid gap-x-6 gap-y-1.5 font-mono text-[12px] sm:grid-cols-[auto_1fr]">
						{SHAPES.map(([k, v]) => (
							<div key={k} className="contents">
								<dt className="text-[var(--accent)]">{k}</dt>
								<dd className="text-white/60">{v}</dd>
							</div>
						))}
					</dl>
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
				<dl className="mt-4 grid gap-x-6 gap-y-1 font-mono text-[11px] text-white/55 sm:grid-cols-2">
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
