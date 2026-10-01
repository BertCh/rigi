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
	type Scene,
} from "#/components/site/how/model";
import { type Hero, useHero } from "./data";

// "Every pixel is a place": with the pose solved, each pixel of the photo is a ray from the
// camera. The depth grid (scripts/meta/bake.ts, demo-09) says where each ray meets the ground.
// The photo is banded by that distance; the map plots where every ray lands, in the same bands,
// so each part of the photo finds its patch of ground. The hovered pixel's ray runs from the
// camera to its landing point.

const DEG = Math.PI / 180;
const PEAKS_URL = "/demo/how/scene.json";
/** Below this distance the ray is in the foreground the terrain model knows only as bare ground. */
const NEAR_M = 150;
/** Fraction of the photo height shown: the skyline band and the hut, not the people below. */
const CROP_Y = 0.58;
/** A cell whose neighbours differ by more than this ratio straddles a silhouette: no line there. */
const JUMP = 1.6;
/** The peak the figure opens on: snow and glacier, clear of cloud in this photo. */
const HOME_PEAK = "Jungfrau";
/** Cells around the hovered one whose landing dots light up on the map. */
const HILITE_CELLS = 4;
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** Distance bands (m, upper bounds) shared by the photo tint, the lines and the map dots. */
const BANDS: { to: number; color: string; label: string }[] = [
	{ to: 1_000, color: BREZINE.SB.hex, label: "< 1 km" },
	{ to: 5_000, color: BREZINE.SY.hex, label: "1–5" },
	{ to: 10_000, color: BREZINE.YY.hex, label: "5–10" },
	{ to: 20_000, color: BREZINE.LG.hex, label: "10–20" },
	{ to: Number.POSITIVE_INFINITY, color: BREZINE.W.hex, label: "> 20 km" },
];
/** The band boundaries drawn as lines on the photo. */
const LEVELS = BANDS.slice(0, -1).map((b) => b.to);

const bandOf = (m: number) => BANDS.findIndex((b) => m < b.to);
const hexRgb = (h: string): [number, number, number] => {
	const n = Number.parseInt(h.slice(1), 16);
	return [n >> 16, (n >> 8) & 255, n & 255];
};
const BAND_RGB = BANDS.map((b) => hexRgb(b.color));

const fmtDist = (m: number) =>
	m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (az: number) => COMPASS[Math.round(az / 45) % 8];

type Peak = Scene["peaks"][number];

function usePeaks() {
	const [peaks, setPeaks] = useState<Peak[] | null>(null);
	useEffect(() => {
		let live = true;
		fetch(PEAKS_URL)
			.then((r) => (r.ok ? (r.json() as Promise<Scene>) : null))
			.then((s) => live && setPeaks(s?.peaks ?? []))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);
	return peaks;
}

export function PixelToPlace({ className }: { className?: string }) {
	const hero = useHero();
	const peaks = usePeaks();
	if (!hero || !peaks)
		return (
			<div
				className={`aspect-[16/9] animate-pulse rounded-2xl bg-white/5 ring-1 ring-white/8 ${className ?? ""}`}
			/>
		);
	return <Figure hero={hero} peaks={peaks} className={className} />;
}

/** Grid cell under an image pixel. */
function cellAt(hero: Hero, x: number, y: number): [number, number] {
	const { w, h } = hero.depth;
	return [
		Math.min(w - 1, Math.max(0, Math.floor((x / hero.width) * w))),
		Math.min(h - 1, Math.max(0, Math.floor((y / hero.height) * h))),
	];
}

/** Depth (m) of the grid cell under an image pixel; 0 = sky. */
function depthAt(hero: Hero, x: number, y: number) {
	const [gx, gy] = cellAt(hero, x, y);
	return hero.depth.metres[gy * hero.depth.w + gx];
}

type Pt = [number, number];

/** Joins marching-squares segments into polylines by their shared endpoints. */
function chain(segs: [Pt, Pt][]): Pt[][] {
	const key = (p: Pt) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
	const at = new Map<string, number[]>();
	segs.forEach((s, i) => {
		for (const p of s) {
			const k = key(p);
			const list = at.get(k);
			if (list) list.push(i);
			else at.set(k, [i]);
		}
	});
	const used = new Uint8Array(segs.length);
	const lines: Pt[][] = [];
	const extend = (line: Pt[]) => {
		for (;;) {
			const end = line[line.length - 1];
			const next = (at.get(key(end)) ?? []).find((i) => !used[i]);
			if (next === undefined) return;
			used[next] = 1;
			const [a, b] = segs[next];
			line.push(key(a) === key(end) ? b : a);
		}
	};
	segs.forEach((s, i) => {
		if (used[i]) return;
		used[i] = 1;
		const line: Pt[] = [s[0], s[1]];
		extend(line);
		line.reverse();
		extend(line);
		lines.push(line);
	});
	return lines;
}

/** Chaikin corner cutting, endpoints kept. */
function chaikin(line: Pt[], rounds = 3): Pt[] {
	let p = line;
	for (let r = 0; r < rounds; r++) {
		const q: Pt[] = [p[0]];
		for (let i = 0; i < p.length - 1; i++) {
			const [a, b] = [p[i], p[i + 1]];
			q.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
			q.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
		}
		q.push(p[p.length - 1]);
		p = q;
	}
	return p;
}

/**
 * Band boundaries over the photo: marching squares on a blurred log-distance grid, skipping
 * cells that straddle a silhouette, chained and smoothed. Each level gets one label, at the
 * flattest stretch of its longest line inside the visible band.
 */
function isoLines(hero: Hero) {
	const { w, h, metres } = hero.depth;
	const sx = hero.width / w;
	const sy = hero.height / h;
	const raw = metres.map((m) => (m > 0 ? Math.log10(m) : Number.NaN));
	// 3×3 blur, twice, over ground cells only, never across a silhouette.
	let lg = raw;
	for (let pass = 0; pass < 2; pass++) {
		const src = lg;
		lg = src.map((v, idx) => {
			if (!Number.isFinite(v)) return v;
			const i = idx % w;
			const j = (idx - i) / w;
			let sum = 0;
			let n = 0;
			for (let dj = -1; dj <= 1; dj++)
				for (let di = -1; di <= 1; di++) {
					const ii = i + di;
					const jj = j + dj;
					if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
					const u = src[jj * w + ii];
					if (!Number.isFinite(u) || Math.abs(u - v) > Math.log10(JUMP))
						continue;
					sum += u;
					n++;
				}
			return sum / n;
		});
	}
	const maxY = hero.height * CROP_Y;
	return LEVELS.map((level) => {
		const L = Math.log10(level);
		const segs: [Pt, Pt][] = [];
		for (let j = 0; j < h - 1; j++)
			for (let i = 0; i < w - 1; i++) {
				const ids = [
					j * w + i,
					j * w + i + 1,
					(j + 1) * w + i + 1,
					(j + 1) * w + i,
				];
				const v = ids.map((k) => lg[k]);
				if (v.some((x) => !Number.isFinite(x))) continue;
				const r = ids.map((k) => raw[k]);
				if (Math.max(...r) - Math.min(...r) > Math.log10(JUMP)) continue;
				const cx = [i, i + 1, i + 1, i].map((g) => (g + 0.5) * sx);
				const cy = [j, j, j + 1, j + 1].map((g) => (g + 0.5) * sy);
				const pts: Pt[] = [];
				for (let e = 0; e < 4; e++) {
					const a = v[e];
					const b = v[(e + 1) % 4];
					if (a < L !== b < L) {
						const k = (L - a) / (b - a);
						const n = (e + 1) % 4;
						pts.push([
							cx[e] + (cx[n] - cx[e]) * k,
							cy[e] + (cy[n] - cy[e]) * k,
						]);
					}
				}
				if (pts.length >= 2) segs.push([pts[0], pts[1]]);
				if (pts.length === 4) segs.push([pts[2], pts[3]]);
			}
		const lines = chain(segs)
			.filter((l) => l.length >= 6 && l.some((p) => p[1] < maxY))
			.map((l) => chaikin(l));
		// Label: the flattest 40 px stretch of the longest line, inside the band.
		let label: Pt | null = null;
		const longest = lines
			.filter((l) => l.some((p) => p[1] < maxY - 16))
			.sort((a, b) => b.length - a.length)[0];
		if (longest) {
			let best = Number.POSITIVE_INFINITY;
			const span = 96; // points after three Chaikin rounds: ~12 grid cells
			for (let i = 0; i + span < longest.length; i += 8) {
				const a = longest[i];
				const b = longest[i + span];
				const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
				if (m[1] > maxY - 16 || m[0] < 30 || m[0] > hero.width - 30) continue;
				const dx = Math.abs(b[0] - a[0]);
				if (dx < 25) continue;
				const slope = Math.abs(b[1] - a[1]) / dx;
				if (slope < best) {
					best = slope;
					label = m;
				}
			}
		}
		const path = lines
			.map(
				(l) =>
					`M${l.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L")}`,
			)
			.join("");
		return { level, path, label };
	});
}

/** km east / north of the camera for a ground point at bearing az, distance d. */
const enKm = (az: number, d: number): Pt => [
	(d * Math.sin(az * DEG)) / 1000,
	(d * Math.cos(az * DEG)) / 1000,
];

/** Where each grid ray lands, km east / north of the camera, with its band; null for sky. */
function landings(hero: Hero, cam: Cam) {
	const { w, h, metres } = hero.depth;
	return metres.map((d, idx) => {
		if (d <= 0) return null;
		const i = idx % w;
		const j = (idx - i) / w;
		const [az] = azEl(
			cam,
			((i + 0.5) / w) * hero.width,
			((j + 0.5) / h) * hero.height,
		);
		return { en: enKm(az, d), band: bandOf(d) };
	});
}
type Landing = ReturnType<typeof landings>[number];

function Figure({
	hero,
	peaks,
	className,
}: {
	hero: Hero;
	peaks: Peak[];
	className?: string;
}) {
	const W = hero.width;
	const H = hero.height;
	const cam: Cam = useMemo(() => camera(hero.solved, W, H), [hero, W, H]);
	const iso = useMemo(() => isoLines(hero), [hero]);
	const land = useMemo(() => landings(hero, cam), [hero, cam]);

	// The default pixel: on the snow just under the Jungfrau's summit.
	const home = useMemo<Pt>(() => {
		const p = peaks.find((v) => v.name === HOME_PEAK);
		const q = p ? project(cam, dirENU(p.az, p.el)) : null;
		if (!q) return [W * 0.9, H * 0.17];
		for (let dy = 1; dy < 30; dy++)
			if (depthAt(hero, q[0], q[1] + dy) > 0) return [q[0], q[1] + dy + 3];
		return q;
	}, [peaks, cam, hero, W, H]);
	const [pt, setPt] = useState<Pt>(home);
	useEffect(() => setPt(home), [home]);

	// ---- the probe ----
	const probe = useMemo(() => {
		const [az] = azEl(cam, pt[0], pt[1]);
		const d = depthAt(hero, pt[0], pt[1]);
		// The grid ray runs through the cell centre: use its elevation for the landing height.
		const { w, h } = hero.depth;
		const [gx, gy] = cellAt(hero, pt[0], pt[1]);
		const [, el] = azEl(cam, ((gx + 0.5) / w) * W, ((gy + 0.5) / h) * H);
		const height =
			d > 0 ? hero.eye + d * Math.tan(el * DEG) - (d * d) / (2 * R_EFF) : null;
		// A named peak if the ray lands on its massif: same bearing, about the same distance.
		const peak =
			d > 0
				? (peaks
						.filter(
							(p) =>
								Math.abs(((p.az - az + 540) % 360) - 180) < 1.6 &&
								Math.abs(d - p.dist) < p.dist * 0.12,
						)
						.sort((a, b) => Math.abs(a.az - az) - Math.abs(b.az - az))[0] ??
					null)
				: null;
		// The landing dots of the cells around the hovered one.
		const near: Pt[] = [];
		for (let j = gy - HILITE_CELLS; j <= gy + HILITE_CELLS; j++)
			for (let i = gx - HILITE_CELLS; i <= gx + HILITE_CELLS; i++) {
				if (i < 0 || j < 0 || i >= w || j >= h) continue;
				const l = land[j * w + i];
				if (l) near.push(l.en);
			}
		return { az, el, d, height, peak, near };
	}, [pt, cam, hero, peaks, land, W, H]);

	const svgRef = useRef<SVGSVGElement>(null);
	const onPoint = (e: ReactPointerEvent<SVGSVGElement>) => {
		const r = svgRef.current?.getBoundingClientRect();
		if (!r) return;
		const x = ((e.clientX - r.left) / r.width) * W;
		const y = ((e.clientY - r.top) / r.height) * H;
		if (x < 0 || y < 0 || x > W || y > H * CROP_Y) return;
		setPt([x, y]);
	};

	const name = probe.peak?.name.split(" / ")[0];
	const claim =
		probe.d === 0
			? "Sky. This ray clears every ridge and never meets the ground."
			: probe.d < NEAR_M
				? `This pixel is ${fmtDist(probe.d)} away: the ground at your feet.`
				: name
					? `This pixel is ${fmtDist(probe.d)} away, on the ${name}.`
					: `This pixel is ${fmtDist(probe.d)} away, on ground at ${Math.round(probe.height ?? 0).toLocaleString("en")} m.`;
	const visH = H * CROP_Y;
	const tagLeft = pt[0] > W * 0.72;

	return (
		<figure className={className}>
			{/* the photo's skyline band, banded by distance */}
			<div
				className="relative overflow-hidden rounded-2xl bg-[var(--rigi-slate)] ring-1 ring-white/10"
				style={{ aspectRatio: `${W} / ${visH}` }}
			>
				<div className="absolute inset-x-0 top-0 aspect-[4/3]">
					<img
						src={hero.photo}
						alt="View from Niederhorn towards the Eiger, Mönch and Jungfrau"
						className="absolute inset-0 size-full object-cover"
						draggable={false}
					/>
					<DepthTint hero={hero} />
					<svg
						ref={svgRef}
						viewBox={`0 0 ${W} ${H}`}
						className="absolute inset-0 size-full cursor-crosshair select-none"
						style={{ touchAction: "pan-y" }}
						onPointerMove={onPoint}
						onPointerDown={onPoint}
						role="img"
						aria-label="Distance bands over the photo; point at a pixel to see where it lands"
					>
						{iso.map(({ level, path }) => (
							<path
								key={level}
								d={path}
								fill="none"
								stroke={brandAlpha("paper", 0.42)}
								strokeWidth={1}
								strokeLinejoin="round"
								strokeLinecap="round"
							/>
						))}
						{iso.map(({ level, label }) =>
							label ? (
								<text
									key={level}
									x={label[0]}
									y={label[1] - 4}
									textAnchor="middle"
									fontSize={9.5}
									fontFamily={MONO}
									fill={brandAlpha("paper", 0.8)}
									style={{ textShadow: "0 0 3px rgba(0,0,0,0.7)" }}
								>
									{level / 1000} km
								</text>
							) : null,
						)}
						<Crosshair x={pt[0]} y={pt[1]} />
						<text
							x={pt[0] + (tagLeft ? -20 : 20)}
							y={pt[1] - 11}
							textAnchor={tagLeft ? "end" : "start"}
							fontSize={14}
							fontWeight={600}
							fill={BRAND.lesson}
							style={{ textShadow: "0 0 4px rgba(0,0,0,0.85)" }}
							pointerEvents="none"
						>
							{probe.d > 0 ? fmtDist(probe.d) : "sky"}
						</text>
					</svg>
				</div>
			</div>

			<div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
				{/* the map: where the pixels land */}
				<div className="overflow-hidden rounded-2xl bg-[var(--rigi-ink)] ring-1 ring-white/10">
					<MapPanel hero={hero} peaks={peaks} probe={probe} land={land} />
				</div>
				<div className="flex flex-col overflow-hidden rounded-2xl bg-white/[0.03] ring-1 ring-white/10">
					<div className="p-5">
						<p className="mb-2 font-mono text-[10px] tracking-[0.16em] text-[var(--rigi-lesson)] uppercase">
							Follow the ray
						</p>
						<p className="text-lg leading-snug font-medium text-[var(--rigi-paper)]">
							{claim}
						</p>
						<p className="mt-3 text-[13px] leading-relaxed text-white/50">
							Point anywhere in the photo. Its ray stops at the first ground it
							meets, and its neighbours light up on the map.
						</p>
					</div>
					<Readout probe={probe} />
					<BandKey />
					<p className="px-5 pb-4 text-[12px] leading-snug text-white/50">
						On the map, each dot is one pixel's ray where it meets the ground,
						in the same colours. Gaps are slopes hidden behind nearer ridges.
					</p>
					<p className="mt-auto border-t border-white/8 px-5 py-3.5 text-[12px] leading-snug text-white/50">
						<span className="mr-1.5 font-mono text-[10px] tracking-[0.14em] text-[var(--rigi-trap)] uppercase">
							Blind spot
						</span>
						Huts and people aren't in the terrain: their pixels read the slope
						behind.
					</p>
				</div>
			</div>
			<figcaption className="mt-2.5 font-mono text-[10.5px] text-white/40">
				Demo photo 09, Niederhorn · solved pose · {hero.depth.w}×{hero.depth.h}{" "}
				rays cast into swissALTI3D · map north up
			</figcaption>
		</figure>
	);
}

function Crosshair({ x, y }: { x: number; y: number }) {
	const r = 8;
	const arm = 7;
	const segs = [
		[x - r - arm, y, x - r, y],
		[x + r, y, x + r + arm, y],
		[x, y - r - arm, x, y - r],
		[x, y + r, x, y + r + arm],
	];
	const draw = (stroke: string, width: number) => (
		<>
			{segs.map((s) => (
				<line
					key={s.join()}
					x1={s[0]}
					y1={s[1]}
					x2={s[2]}
					y2={s[3]}
					stroke={stroke}
					strokeWidth={width}
					strokeLinecap="round"
				/>
			))}
			<circle
				cx={x}
				cy={y}
				r={r}
				fill="none"
				stroke={stroke}
				strokeWidth={width}
			/>
		</>
	);
	return (
		<g pointerEvents="none">
			{draw(brandAlpha("ink", 0.6), 3.6)}
			{draw(BRAND.lesson, 1.6)}
		</g>
	);
}

/** The depth grid as a soft band tint over the photo, transparent in the sky. */
function DepthTint({ hero }: { hero: Hero }) {
	const ref = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const c = ref.current;
		const ctx = c?.getContext("2d");
		if (!c || !ctx) return;
		const { w, h, metres } = hero.depth;
		const img = ctx.createImageData(w, h);
		metres.forEach((m, i) => {
			if (m <= 0) return;
			const [r, g, b] = BAND_RGB[bandOf(m)];
			img.data.set([r, g, b, 64], 4 * i);
		});
		ctx.putImageData(img, 0, 0);
	}, [hero]);
	return (
		<canvas
			ref={ref}
			width={hero.depth.w}
			height={hero.depth.h}
			className="pointer-events-none absolute inset-0 size-full"
			style={{ filter: "blur(1.5px)" }}
		/>
	);
}

function BandKey() {
	return (
		<div className="border-t border-white/8 px-5 pt-3.5 pb-2.5">
			<p className="mb-2 font-mono text-[9.5px] tracking-[0.14em] text-white/40 uppercase">
				Distance, photo and map
			</p>
			<div className="flex flex-wrap gap-x-3 gap-y-1.5">
				{BANDS.map((b) => (
					<span
						key={b.label}
						className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-white/60"
					>
						<span
							className="size-2 rounded-full"
							style={{ background: b.color }}
						/>
						{b.label}
					</span>
				))}
			</div>
		</div>
	);
}

type Probe = {
	az: number;
	el: number;
	d: number;
	height: number | null;
	peak: Peak | null;
	near: Pt[];
};

/** Map pixel (north-up hillshade) for a point km east / north of the camera. */
function mapPoint(hero: Hero, [e, n]: Pt): Pt {
	const s = hero.map.px / (2 * hero.map.halfKm);
	return [hero.map.px / 2 + e * s, hero.map.px / 2 - n * s];
}

function MapPanel({
	hero,
	peaks,
	probe,
	land,
}: {
	hero: Hero;
	peaks: Peak[];
	probe: Probe;
	land: Landing[];
}) {
	const { px, halfKm } = hero.map;
	const s = px / (2 * halfKm); // map px per km
	const toMap = (en: Pt) => mapPoint(hero, en);
	const [cx, cy] = toMap([0, 0]);

	// Crop to the landing cloud (1st–99th percentile) plus the camera, with a margin.
	const vb = useMemo(() => {
		const es: number[] = [0];
		const ns: number[] = [0];
		for (const l of land)
			if (l && Math.abs(l.en[0]) < halfKm && Math.abs(l.en[1]) < halfKm) {
				es.push(l.en[0]);
				ns.push(l.en[1]);
			}
		const q = (a: number[], f: number) =>
			[...a].sort((x, y) => x - y)[Math.floor(f * (a.length - 1))];
		const m = 2.5;
		const e0 = Math.min(0, q(es, 0.01)) - m;
		const e1 = Math.max(0, q(es, 0.99)) + m;
		const n0 = Math.min(0, q(ns, 0.01)) - m;
		const n1 = Math.max(0, q(ns, 0.99)) + m;
		return {
			x: px / 2 + e0 * s,
			y: px / 2 - n1 * s,
			w: (e1 - e0) * s,
			h: (n1 - n0) * s,
		};
	}, [land, halfKm, px, s]);

	// SVG units per CSS pixel, so marks and text keep their screen size whatever the crop.
	const box = useRef<HTMLDivElement>(null);
	const [dispW, setDispW] = useState(700);
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setDispW(el.clientWidth || 700));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const u = vb.w / dispW;

	// Every ray's landing point, as a dot cloud on a canvas in the crop's frame.
	const cloud = useRef<HTMLCanvasElement>(null);
	const SCALE = 3;
	useEffect(() => {
		const c = cloud.current;
		const ctx = c?.getContext("2d");
		if (!c || !ctx) return;
		ctx.clearRect(0, 0, c.width, c.height);
		const r = 1.35 * u * SCALE;
		for (const l of land) {
			if (!l) continue;
			const [mx, my] = mapPoint(hero, l.en);
			const [rr, g, b] = BAND_RGB[l.band];
			ctx.fillStyle = `rgba(${rr},${g},${b},0.85)`;
			ctx.beginPath();
			ctx.arc((mx - vb.x) * SCALE, (my - vb.y) * SCALE, r, 0, 2 * Math.PI);
			ctx.fill();
		}
	}, [hero, land, vb, u]);

	// The view wedge at the solved yaw, out past the crop.
	const reach = 80_000;
	const wedge = [
		[cx, cy],
		toMap(enKm(hero.solved.yaw - hero.hfov / 2, reach)),
		toMap(enKm(hero.solved.yaw + hero.hfov / 2, reach)),
	];
	const hit = probe.d > 0 ? toMap(enKm(probe.az, probe.d)) : null;
	const sky = toMap(enKm(probe.az, reach));
	const rings = [10, 20, 30];

	return (
		<div className="relative">
			<p className="absolute top-3 left-4 z-10 font-mono text-[10px] tracking-[0.16em] text-white/50 uppercase">
				Where the pixels land
			</p>
			<div
				ref={box}
				className="relative w-full"
				style={{ aspectRatio: `${vb.w} / ${vb.h}` }}
			>
				<svg
					viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
					className="absolute inset-0 size-full"
					role="img"
					aria-label="Hillshade map with every pixel's landing point, the camera and the ray to the chosen pixel"
				>
					<defs>
						<clipPath id="p2p-wedge">
							<polygon points={wedge.map((p) => p.join(",")).join(" ")} />
						</clipPath>
					</defs>
					<image
						href={hero.map.src}
						x={0}
						y={0}
						width={px}
						height={px}
						opacity={0.26}
						preserveAspectRatio="none"
					/>
					<image
						href={hero.map.src}
						x={0}
						y={0}
						width={px}
						height={px}
						opacity={0.4}
						clipPath="url(#p2p-wedge)"
						preserveAspectRatio="none"
					/>
					{rings.map((k) => (
						<circle
							key={k}
							cx={cx}
							cy={cy}
							r={k * s}
							fill="none"
							stroke={brandAlpha("paper", 0.12)}
							strokeDasharray={`${2 * u} ${4 * u}`}
							strokeWidth={u}
						/>
					))}
					<foreignObject x={vb.x} y={vb.y} width={vb.w} height={vb.h}>
						<canvas
							ref={cloud}
							width={Math.round(vb.w * SCALE)}
							height={Math.round(vb.h * SCALE)}
							style={{ width: "100%", height: "100%", display: "block" }}
						/>
					</foreignObject>
					{rings.map((k) => {
						// ring labels along the wedge's right edge, just outside it
						const [x, y] = toMap(
							enKm(hero.solved.yaw + hero.hfov / 2 + 3, k * 1000),
						);
						return (
							<text
								key={k}
								x={x}
								y={y}
								textAnchor="middle"
								fontSize={10 * u}
								fontFamily={MONO}
								fill={brandAlpha("paper", 0.4)}
							>
								{k} km
							</text>
						);
					})}
					<polyline
						points={wedge.map((p) => p.join(",")).join(" ")}
						fill="none"
						stroke={brandAlpha("paper", 0.3)}
						strokeWidth={0.8 * u}
					/>
					{/* the hovered pixel's neighbours */}
					{probe.near.map((en) => {
						const [x, y] = toMap(en);
						return (
							<circle
								key={`${x.toFixed(2)},${y.toFixed(2)}`}
								cx={x}
								cy={y}
								r={2 * u}
								fill={BRAND.lesson}
								stroke={brandAlpha("ink", 0.6)}
								strokeWidth={0.4 * u}
							/>
						);
					})}
					{peaks.map((p) => {
						const [x, y] = toMap(enKm(p.az, p.dist));
						const on = probe.peak?.name === p.name;
						return (
							<g key={p.name}>
								<path
									d={`M${x} ${y - 4.5 * u}L${x + 4 * u} ${y + 2.8 * u}L${x - 4 * u} ${y + 2.8 * u}Z`}
									fill={on ? BRAND.paper : brandAlpha("paper", 0.5)}
									stroke={brandAlpha("ink", 0.7)}
									strokeWidth={0.5 * u}
								/>
								{on && (
									<text
										x={x + 7 * u}
										y={y + 4 * u}
										fontSize={12 * u}
										fill={BRAND.paper}
										style={{ textShadow: "0 0 3px rgba(0,0,0,0.9)" }}
									>
										{p.name.split(" / ")[0]}
									</text>
								)}
							</g>
						);
					})}
					{/* the ray */}
					<line
						x1={cx}
						y1={cy}
						x2={hit ? hit[0] : sky[0]}
						y2={hit ? hit[1] : sky[1]}
						stroke={brandAlpha("ink", 0.6)}
						strokeWidth={4 * u}
						strokeLinecap="round"
					/>
					<line
						x1={cx}
						y1={cy}
						x2={hit ? hit[0] : sky[0]}
						y2={hit ? hit[1] : sky[1]}
						stroke={BRAND.lesson}
						strokeWidth={1.8 * u}
						strokeDasharray={hit ? undefined : `${4 * u} ${4 * u}`}
						strokeLinecap="round"
					/>
					{hit && (
						<circle
							cx={hit[0]}
							cy={hit[1]}
							r={5 * u}
							fill={BRAND.lesson}
							stroke={BRAND.ink}
							strokeWidth={1.4 * u}
						/>
					)}
					<circle
						cx={cx}
						cy={cy}
						r={4.5 * u}
						fill={BRAND.paper}
						stroke={BRAND.ink}
						strokeWidth={1.4 * u}
					/>
					<text
						x={cx}
						y={cy + 17 * u}
						textAnchor="middle"
						fontSize={12 * u}
						fill={brandAlpha("paper", 0.75)}
						style={{ textShadow: "0 0 3px rgba(0,0,0,0.9)" }}
					>
						camera
					</text>
					<text
						x={vb.x + vb.w - 12 * u}
						y={vb.y + vb.h - 12 * u}
						textAnchor="end"
						fontSize={11 * u}
						fontFamily={MONO}
						fill={brandAlpha("paper", 0.5)}
					>
						N ↑
					</text>
				</svg>
			</div>
		</div>
	);
}

function Readout({ probe }: { probe: Probe }) {
	const rows: [string, string][] = [
		["Distance", probe.d > 0 ? fmtDist(probe.d) : "sky"],
		[
			"Ground height",
			probe.height === null
				? "—"
				: `${Math.round(probe.height).toLocaleString("en")} m`,
		],
		["Bearing", `${probe.az.toFixed(1)}° ${compass(probe.az)}`],
		[
			"Ray angle",
			`${probe.el >= 0 ? "+" : "−"}${Math.abs(probe.el).toFixed(1)}°`,
		],
	];
	return (
		<dl className="grid grid-cols-2 gap-px border-t border-white/8 bg-white/8 sm:grid-cols-4 md:grid-cols-2">
			{rows.map(([k, v]) => (
				<div key={k} className="bg-[var(--rigi-ink)] px-4 py-3">
					<dt className="font-mono text-[9.5px] tracking-[0.14em] text-white/40 uppercase">
						{k}
					</dt>
					<dd
						className="mt-1 font-mono text-[13px] tabular-nums sm:text-sm"
						style={{ color: k === "Distance" ? BRAND.lesson : BRAND.paper }}
					>
						{v}
					</dd>
				</div>
			))}
		</dl>
	);
}
