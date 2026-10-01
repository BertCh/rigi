// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { BRAND, BREZINE, brandAlpha } from "#/brand/khipu";
import {
	azEl,
	type Cam,
	camera,
	dirENU,
	project,
	R_EFF,
} from "#/components/site/how/model";
import { type Hero, type Section, useHero, wrap180 } from "./data";

// "The skyline is the farthest thing you can see": a ladder-of-abstraction pair from one demo
// photo (public/demo/meta/hero.json, baked by scripts/meta/bake.ts). On top, the photo at its
// solved pose with every ridge crest the DEM predicts, tinted by distance, so the view comes apart
// into depth layers. Below, the side section along one bearing: the terrain (curvature already
// dropped), the line of sight from the eye, the ridges it clears and the ground it never sees.
// Drag across the photo to move the bearing.

const PHOTO_W = 2048;
const PHOTO_H = 1536;
/**
 * Crests nearer than this are left out: the summit's own lip and the lake shore, which sit behind
 * the foreground (grass, the hut) and only clutter the layers.
 */
const NEAR = 5000;
/** The default bearing: the Eiger (public/demo/how/scene.json peaks). */
const PEAKS_URL = "/demo/how/scene.json";

type Peak = { name: string; ele: number; az: number; el: number; dist: number };

/** Near is warm, far is pale: khipu swatches by Ascher code. */
const RAMP: { upTo: number; color: string }[] = [
	{ upTo: 4_000, color: BREZINE.SB.hex },
	{ upTo: 9_000, color: BREZINE["0Y"].hex },
	{ upTo: 15_000, color: BREZINE.YB.hex },
	{ upTo: 22_000, color: BREZINE.LG.hex },
	{ upTo: Number.POSITIVE_INFINITY, color: BREZINE.BL.hex },
];
const rampIndex = (d: number) => RAMP.findIndex((b) => d < b.upTo);
const distColor = (d: number) => RAMP[rampIndex(d)].color;

const km = (m: number) =>
	m >= 10_000 ? `${Math.round(m / 1000)} km` : `${(m / 1000).toFixed(1)} km`;
const drop = (d: number) => (d * d) / (2 * R_EFF);

function useWidth() {
	const ref = useRef<HTMLDivElement>(null);
	const [w, setW] = useState(0);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setW(el.clientWidth));
		ro.observe(el);
		setW(el.clientWidth);
		return () => ro.disconnect();
	}, []);
	return [ref, w] as const;
}

function usePeaks() {
	const [peaks, setPeaks] = useState<Peak[]>([]);
	useEffect(() => {
		let live = true;
		fetch(PEAKS_URL)
			.then((r) => (r.ok ? r.json() : null))
			.then((s) => live && s && setPeaks(s.peaks as Peak[]))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);
	return peaks;
}

export function SideSection({ className }: { className?: string }) {
	const hero = useHero();
	const peaks = usePeaks();
	if (!hero)
		return (
			<div
				className={`aspect-[16/12] animate-pulse rounded-2xl bg-white/5 ring-1 ring-white/8 ${className ?? ""}`}
			/>
		);
	return <Figure hero={hero} peaks={peaks} className={className} />;
}

/** The peak that forms the skyline at this bearing, if any. */
function peakAt(peaks: Peak[], s: Section) {
	return peaks.find(
		(p) =>
			Math.abs(wrap180(p.az - s.az)) < 0.75 &&
			Math.abs(p.dist - s.skyline.d) < 2_500,
	);
}

function Figure({
	hero,
	peaks,
	className,
}: {
	hero: Hero;
	peaks: Peak[];
	className?: string;
}) {
	const cam = useMemo(() => camera(hero.solved, PHOTO_W, PHOTO_H), [hero]);
	const layers = useMemo(() => crestLayers(hero, cam), [hero, cam]);
	const sections = hero.sections;
	const eiger = peaks.find((p) => p.name === "Eiger");
	const [picked, setPicked] = useState<number | null>(null);
	const index = useMemo(() => {
		if (picked !== null) return picked;
		const target = eiger?.az ?? hero.solved.yaw;
		return nearestSection(sections, target);
	}, [picked, eiger, sections, hero]);
	const sec = sections[index];

	const [ref, w] = useWidth();
	const s = w / PHOTO_W;
	const bandH = (layers.y1 - layers.y0) * s;

	const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const r = e.currentTarget.getBoundingClientRect();
		const x = (e.clientX - r.left) / s;
		const y = layers.y0 + (e.clientY - r.top) / s;
		const [az] = azEl(cam, x, y);
		setPicked(nearestSection(sections, az));
	};

	// The cursor follows the bearing down the photo (it leans with roll).
	const top = project(cam, dirENU(sec.az, sec.skyline.el + 3));
	const peak = peakAt(peaks, sec);
	const cleared = sec.ridges.filter((r) => r.d >= NEAR);
	const lowest = Math.min(sec.skyline.el, ...cleared.map((r) => r.el));
	const bottom = project(cam, dirENU(sec.az, lowest - 1.5));

	return (
		<figure
			className={`overflow-hidden rounded-2xl bg-[var(--rigi-ink)] ring-1 ring-white/10 ${className ?? ""}`}
		>
			<div
				ref={ref}
				className="relative w-full cursor-ew-resize touch-pan-y select-none"
				style={{ height: bandH || undefined }}
				onPointerMove={onMove}
				onPointerDown={onMove}
			>
				{w > 0 && (
					<svg
						width={w}
						height={bandH}
						viewBox={`0 ${layers.y0} ${PHOTO_W} ${layers.y1 - layers.y0}`}
						className="block"
						role="img"
						aria-label="The photo with each ridge the elevation model predicts, tinted from near (orange) to far (pale)"
					>
						<image
							href={hero.photo}
							x={0}
							y={0}
							width={PHOTO_W}
							height={PHOTO_H}
							opacity={0.72}
						/>
						<rect
							x={0}
							y={layers.y0}
							width={PHOTO_W}
							height={layers.y1 - layers.y0}
							fill={brandAlpha("ink", 0.2)}
						/>
						{layers.paths.map((d, i) =>
							d ? (
								<path
									key={RAMP[i].upTo}
									d={d}
									fill="none"
									stroke={RAMP[i].color}
									strokeWidth={2.4 / Math.max(s, 0.3)}
									strokeLinecap="round"
									opacity={0.9}
								/>
							) : null,
						)}
						<path
							d={layers.skyline}
							fill="none"
							stroke={BRAND.paper}
							strokeWidth={2.6 / Math.max(s, 0.3)}
							strokeDasharray={`${7 / Math.max(s, 0.3)} ${5 / Math.max(s, 0.3)}`}
						/>
						{top && bottom && (
							<line
								x1={top[0]}
								y1={top[1]}
								x2={bottom[0]}
								y2={bottom[1]}
								stroke={BRAND.paper}
								strokeOpacity={0.55}
								strokeWidth={1.2 / Math.max(s, 0.3)}
							/>
						)}
						{[...cleared, sec.skyline].map((r) => {
							const p = project(cam, dirENU(sec.az, r.el));
							if (!p) return null;
							const sky = r === sec.skyline;
							return (
								<circle
									key={r.d}
									cx={p[0]}
									cy={p[1]}
									r={(sky ? 6 : 5) / Math.max(s, 0.3)}
									fill={sky ? BRAND.paper : distColor(r.d)}
									stroke={BRAND.ink}
									strokeWidth={1.5 / Math.max(s, 0.3)}
								/>
							);
						})}
					</svg>
				)}
				{top && w > 0 && (
					<div
						className="pointer-events-none absolute -translate-x-1/2 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10.5px] whitespace-nowrap text-[var(--rigi-paper)] backdrop-blur-sm"
						style={{
							left: Math.min(Math.max(top[0] * s, 60), w - 60),
							top: Math.max(4, (top[1] - layers.y0) * s - 22),
						}}
					>
						{peak ? `${peak.name} · ` : ""}
						{Math.round(sec.az)}°
					</div>
				)}
				<DepthKey className="pointer-events-none absolute right-2 bottom-2 sm:right-3 sm:bottom-3" />
			</div>
			<SectionPlot sec={sec} eye={hero.eye} peak={peak} />
			<figcaption className="border-t border-white/8 px-4 py-3 text-[13px] leading-relaxed text-white/70 sm:px-5">
				<span className="font-semibold text-[var(--rigi-paper)]">
					{peak
						? `${peak.name}, ${peak.ele} m`
						: `Bearing ${Math.round(sec.az)}°`}
					:
				</span>{" "}
				the line of sight clears {cleared.length}{" "}
				{cleared.length === 1 ? "ridge" : "ridges"} and meets the skyline{" "}
				{km(sec.skyline.d)} away. The Earth's curve lowers that point by{" "}
				{Math.round(drop(sec.skyline.d))} m.{" "}
				<span className="text-white/40">Drag across the photo.</span>
			</figcaption>
		</figure>
	);
}

function nearestSection(sections: Section[], az: number) {
	let best = 0;
	sections.forEach((s, i) => {
		if (
			Math.abs(wrap180(s.az - az)) < Math.abs(wrap180(sections[best].az - az))
		)
			best = i;
	});
	return best;
}

/**
 * The crests as silhouette lines in photo pixels: each crest links to the crest in the next column
 * at about the same distance and angle, one path per distance band. Plus the skyline.
 */
function crestLayers(hero: Hero, cam: Cam) {
	const { az0, step, crests } = hero.ridges;
	const bands = RAMP.map(() => [] as string[]);
	const sky: string[] = [];
	let y0 = Number.POSITIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	const px = (az: number, el: number) => project(cam, dirENU(az, el));
	for (let k = 0; k < crests.length; k++) {
		const az = az0 + k * step;
		const col = crests[k];
		const skyline = col[col.length - 1];
		const sp = px(az, skyline[0]);
		if (sp) {
			sky.push(
				`${sky.length ? "L" : "M"}${sp[0].toFixed(1)},${sp[1].toFixed(1)}`,
			);
			y0 = Math.min(y0, sp[1]);
		}
		if (k === crests.length - 1) continue;
		const next = crests[k + 1].slice(0, -1);
		for (const [el, d] of col.slice(0, -1)) {
			if (d < NEAR) continue;
			const a = px(az, el);
			if (!a) continue;
			y1 = Math.max(y1, a[1]);
			// the same ridge one column on: closest in distance, within 12% and 0.6°
			let link: [number, number] | null = null;
			for (const c of next)
				if (
					Math.abs(c[1] - d) < 0.12 * d &&
					Math.abs(c[0] - el) < 0.6 &&
					(!link || Math.abs(c[1] - d) < Math.abs(link[1] - d))
				)
					link = c;
			const b = link ? px(az + step, link[0]) : px(az + step * 0.5, el);
			if (!b) continue;
			bands[rampIndex(link ? (d + link[1]) / 2 : d)].push(
				`M${a[0].toFixed(1)},${a[1].toFixed(1)}L${b[0].toFixed(1)},${b[1].toFixed(1)}`,
			);
		}
	}
	const pad = (y1 - y0) * 0.12;
	return {
		paths: bands.map((b) => b.join("")),
		skyline: sky.join(""),
		y0: Math.max(0, y0 - pad * 1.6),
		y1: Math.min(PHOTO_H, y1 + pad),
	};
}

function DepthKey({ className }: { className?: string }) {
	return (
		<div
			className={`rounded-md bg-black/55 px-1.5 py-1 font-mono text-[8.5px] sm:px-2 sm:py-1.5 sm:text-[9.5px] text-white/60 backdrop-blur-sm ${className ?? ""}`}
		>
			<div className="flex items-center gap-1">
				<span>near</span>
				{RAMP.map((b) => (
					<span
						key={b.upTo}
						className="inline-block h-[3px] w-3.5 rounded-full"
						style={{ background: b.color }}
					/>
				))}
				<span>far</span>
				<span
					className="ml-1.5 inline-block h-0 w-4 border-t-2 border-dashed"
					style={{ borderColor: BRAND.paper }}
				/>
				<span>skyline</span>
			</div>
		</div>
	);
}

const PAD = { l: 14, r: 14, t: 34, b: 30 };

function SectionPlot({
	sec,
	eye,
	peak,
}: {
	sec: Section;
	eye: number;
	peak: Peak | undefined;
}) {
	const [ref, w] = useWidth();
	const H = w < 520 ? 230 : 300;
	const pts = sec.points;
	const reach = pts[pts.length - 1][0];
	const tanSky = Math.tan((sec.skyline.el * Math.PI) / 180);
	const hs = pts.map((p) => p[1]);
	const lo = Math.min(...hs);
	const hi = Math.max(...hs, eye + reach * tanSky);
	const yLo = lo - (hi - lo) * 0.08;
	const yHi = hi + (hi - lo) * 0.06;
	const innerW = Math.max(1, w - PAD.l - PAD.r);
	const innerH = H - PAD.t - PAD.b;
	const X = (d: number) => PAD.l + (d / reach) * innerW;
	const Y = (h: number) => PAD.t + (1 - (h - yLo) / (yHi - yLo)) * innerH;
	const exaggeration = innerH / (yHi - yLo) / (innerW / reach);

	// What the eye sees: a point is visible when its angle beats every angle before it.
	const seen = useMemo(() => {
		const out: { d: number; h: number; vis: boolean; occ: number }[] = [];
		let best = Number.NEGATIVE_INFINITY;
		for (const [d, h] of pts) {
			if (d <= 0) {
				out.push({ d, h, vis: true, occ: h });
				continue;
			}
			const t = (h - eye) / d;
			const vis = t >= best;
			if (vis) best = t;
			out.push({ d, h, vis, occ: eye + best * d });
		}
		return out;
	}, [pts, eye]);

	if (w === 0) return <div ref={ref} style={{ height: H }} />;

	const ground = `M${X(0)},${Y(yLo)}${pts.map(([d, h]) => `L${X(d).toFixed(1)},${Y(h).toFixed(1)}`).join("")}L${X(reach)},${Y(yLo)}Z`;
	// Hidden ground: between the grazing ray (from the last crest) and the terrain.
	const shadows: string[] = [];
	let run: typeof seen = [];
	const flush = () => {
		if (run.length > 1) {
			const topLine = run.map(
				(p) => `${X(p.d).toFixed(1)},${Y(p.occ).toFixed(1)}`,
			);
			const floor = [...run]
				.reverse()
				.map((p) => `${X(p.d).toFixed(1)},${Y(p.h).toFixed(1)}`);
			shadows.push(`M${topLine.join("L")}L${floor.join("L")}Z`);
		}
		run = [];
	};
	seen.forEach((p, i) => {
		if (!p.vis) {
			if (!run.length && i > 0)
				run.push({ ...seen[i - 1], occ: seen[i - 1].h });
			run.push(p);
		} else flush();
	});
	flush();
	// The visible surface, stroked in the depth colour of the photo layer it becomes.
	const lit: { d: string; color: string }[] = [];
	for (let i = 1; i < seen.length; i++) {
		const a = seen[i - 1];
		const b = seen[i];
		if (!b.vis || !a.vis) continue;
		lit.push({
			d: `M${X(a.d).toFixed(1)},${Y(a.h).toFixed(1)}L${X(b.d).toFixed(1)},${Y(b.h).toFixed(1)}`,
			color: distColor(b.d),
		});
	}
	// Flat-earth ghost: the same terrain without the curvature drop.
	const flat = pts
		.filter(([d]) => d > reach * 0.45)
		.map(
			([d, h], i) =>
				`${i ? "L" : "M"}${X(d).toFixed(1)},${Y(h + drop(d)).toFixed(1)}`,
		)
		.join("");

	const ridges = sec.ridges.filter((r) => r.d >= NEAR);
	const crestH = (r: { el: number; d: number }) =>
		eye + r.d * Math.tan((r.el * Math.PI) / 180);
	const skyX = X(sec.skyline.d);
	const skyY = Y(crestH(sec.skyline));
	const rayEnd = reach;
	// distance labels left to right, skipping any that would collide
	let lastX = Number.NEGATIVE_INFINITY;
	const labelled = new Set<number>();
	for (const r of ridges) {
		const x = X(r.d);
		if (x - lastX > 44 && skyX - x > 52) {
			labelled.add(r.d);
			lastX = x;
		}
	}
	const kmTicks: number[] = [];
	const tick = reach > 60_000 ? 20_000 : reach > 25_000 ? 5_000 : 2_000;
	for (let d = tick; d < reach; d += tick) kmTicks.push(d);
	const dropM = Math.round(drop(sec.skyline.d));
	const hiddenSpot = hiddenLabelSpot(seen, X, Y);
	const skyName = peak
		? `${peak.name} ${peak.ele} m`
		: `skyline ${Math.round(crestH(sec.skyline) + drop(sec.skyline.d))} m`;

	return (
		<div ref={ref} className="relative border-t border-white/8">
			<svg
				width={w}
				height={H}
				className="block [&_text]:[paint-order:stroke] [&_text]:[stroke-linejoin:round] [&_text]:[stroke-width:3px] [&_text]:[stroke:var(--rigi-ink)]"
				role="img"
				aria-label={`Side section along bearing ${Math.round(sec.az)}°`}
			>
				<defs>
					<pattern
						id="side-section-hatch"
						width={6}
						height={6}
						patternUnits="userSpaceOnUse"
						patternTransform="rotate(45)"
					>
						<line
							x1={0}
							y1={0}
							x2={0}
							y2={6}
							stroke={BRAND.paper}
							strokeOpacity={0.16}
							strokeWidth={1}
						/>
					</pattern>
				</defs>
				<text
					x={PAD.l}
					y={16}
					fill={BRAND.paper}
					fillOpacity={0.4}
					fontSize={10}
					className="font-mono tracking-[0.14em] uppercase"
				>
					Side section · bearing {Math.round(sec.az)}° · heights ×
					{exaggeration.toFixed(exaggeration < 10 ? 1 : 0)}
				</text>
				<path d={ground} fill={brandAlpha("paper", 0.05)} />
				{shadows.map((d) => (
					<path key={d.slice(0, 24)} d={d} fill="url(#side-section-hatch)" />
				))}
				{lit.map((l) => (
					<path
						key={l.d}
						d={l.d}
						stroke={l.color}
						strokeWidth={2}
						strokeLinecap="round"
					/>
				))}
				{/* rays to each ridge crest, then the line of sight to the skyline */}
				{ridges.map((r) => (
					<line
						key={r.d}
						x1={X(0)}
						y1={Y(eye)}
						x2={X(r.d)}
						y2={Y(crestH(r))}
						stroke={distColor(r.d)}
						strokeOpacity={0.35}
						strokeWidth={1}
					/>
				))}
				<line
					x1={X(0)}
					y1={Y(eye)}
					x2={skyX}
					y2={skyY}
					stroke={BRAND.paper}
					strokeWidth={1.6}
				/>
				<line
					x1={skyX}
					y1={skyY}
					x2={X(rayEnd)}
					y2={Y(eye + rayEnd * tanSky)}
					stroke={BRAND.paper}
					strokeOpacity={0.4}
					strokeWidth={1.2}
					strokeDasharray="3 4"
				/>
				<path
					d={flat}
					fill="none"
					stroke={BRAND.paper}
					strokeOpacity={0.45}
					strokeWidth={1}
					strokeDasharray="2 3"
				/>
				{ridges.map((r) => {
					const x = X(r.d);
					const y = Y(crestH(r));
					return (
						<g key={r.d}>
							<circle
								cx={x}
								cy={y}
								r={3.5}
								fill={distColor(r.d)}
								stroke={BRAND.ink}
								strokeWidth={1.2}
							/>
							{labelled.has(r.d) && (
								<text
									x={x}
									y={y - 8}
									textAnchor="middle"
									fill={distColor(r.d)}
									fontSize={10}
									className="font-mono"
								>
									{km(r.d)}
								</text>
							)}
						</g>
					);
				})}
				<circle
					cx={skyX}
					cy={skyY}
					r={4.5}
					fill={BRAND.paper}
					stroke={BRAND.ink}
					strokeWidth={1.4}
				/>
				<text
					x={Math.min(skyX, w - PAD.r)}
					y={skyY - 22}
					textAnchor={skyX > w - 120 ? "end" : "middle"}
					fill={BRAND.paper}
					fontSize={11}
					fontWeight={600}
				>
					{skyName}
				</text>
				<text
					x={Math.min(skyX, w - PAD.r)}
					y={skyY - 9}
					textAnchor={skyX > w - 120 ? "end" : "middle"}
					fill={BRAND.paper}
					fillOpacity={0.6}
					fontSize={10}
					className="font-mono"
				>
					{km(sec.skyline.d)} · −{dropM} m curve
				</text>
				{/* eye level: crests above it are looked up at, crests below it down at */}
				<line
					x1={X(0)}
					y1={Y(eye)}
					x2={w - PAD.r}
					y2={Y(eye)}
					stroke={BRAND.lesson}
					strokeOpacity={0.3}
					strokeWidth={1}
					strokeDasharray="1 4"
				/>
				<text
					x={w - PAD.r - 4}
					y={Y(eye) + 13}
					textAnchor="end"
					fill={BRAND.lesson}
					fillOpacity={0.6}
					fontSize={9.5}
					className="font-mono"
				>
					eye level
				</text>
				{/* the eye */}
				<circle cx={X(0)} cy={Y(eye)} r={4} fill={BRAND.lesson} />
				<text
					x={X(0) + 8}
					y={Y(eye) - 8}
					fill={BRAND.lesson}
					fontSize={10.5}
					className="font-mono"
				>
					you · {Math.round(eye)} m
				</text>
				{/* hidden-ground key, on the largest shadow */}
				{hiddenSpot && (
					<text
						x={Math.min(Math.max(hiddenSpot.x, 40), w - 40)}
						y={hiddenSpot.y}
						textAnchor="middle"
						fill={BRAND.paper}
						fillOpacity={0.45}
						fontSize={10}
						className="font-mono"
					>
						not seen
					</text>
				)}
				{/* distance axis */}
				<line
					x1={PAD.l}
					x2={w - PAD.r}
					y1={H - PAD.b + 6}
					y2={H - PAD.b + 6}
					stroke={BRAND.paper}
					strokeOpacity={0.15}
				/>
				{kmTicks.map((d) => (
					<text
						key={d}
						x={X(d)}
						y={H - PAD.b + 20}
						textAnchor="middle"
						fill={BRAND.paper}
						fillOpacity={0.35}
						fontSize={9.5}
						className="font-mono"
					>
						{d / 1000} km
					</text>
				))}
			</svg>
			<div className="pointer-events-none absolute top-2 right-3 hidden items-center gap-1.5 font-mono text-[9.5px] text-white/45 sm:flex">
				<span
					className="inline-block h-0 w-4 border-t border-dashed"
					style={{ borderColor: BRAND.paper }}
				/>
				ground without the Earth's curve
			</div>
		</div>
	);
}

/** Where to write "not seen": the hidden point with the most room above it, if any has room. */
function hiddenLabelSpot(
	seen: { d: number; h: number; vis: boolean; occ: number }[],
	X: (d: number) => number,
	Y: (h: number) => number,
) {
	let best: { x: number; y: number; gap: number } | null = null;
	for (const p of seen) {
		if (p.vis) continue;
		const gap = Y(p.h) - Y(p.occ);
		if (!best || gap > best.gap)
			best = { x: X(p.d), y: (Y(p.occ) + Y(p.h)) / 2 + 4, gap };
	}
	return best && best.gap > 18 ? best : null;
}
