// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { BRAND, brandAlpha } from "#/brand/khipu";
import {
	HandDot,
	HandText,
	PenArrow,
	PenCircle,
	PenLine,
	PenRule,
	SketchPolyline,
} from "#/components/gipfelbuch/notebook/Ink";
import {
	type Angles,
	azEl,
	camera,
	lerpAngles,
	smooth,
} from "#/components/site/how/model";
import { DEG } from "#/lib/geodesy";
import {
	horizonEl,
	type RollPhoto,
	rollObservations,
	useRoll,
	wrap180,
	wrap360,
} from "./data";

// "Where the compass put them, where the skyline put them": the demo day from its shared
// viewpoint, one panel per viewing direction, all at the same degrees-to-pixels scale. Each photo
// is a print of its skyline band placed by its pose; one slider moves every print from the phone's
// compass pose to the solved pose, where its skyline (amber) locks onto the terrain skyline
// (dashed paper). Under the panels, the compass error per photo, sorted. Everything comes from
// public/demo/meta/roll.json.

const C = {
	photo: BRAND.lesson,
	terrain: BRAND.paper,
	error: BRAND.trap,
	good: BRAND.result,
	rejected: BRAND.negative,
	ink: BRAND.ink,
};

/** Vertical strips per photo: each is placed at its own azimuth, so the pinhole's tan() and the
 * camera roll are honoured to a fraction of a degree. */
const STRIPS = 14;
const DEFAULT_ID = "demo-09";
/** Seconds: hold at the compass, then the move to the skyline. */
const HOLD = 0.7;
const MOVE = 2.6;
/** A gap this wide (deg) between solved headings starts a new viewing direction. The demo day
 * faced three ways (Hohgant, the Bernese Alps, Niesen), 60° or more apart. */
const CLUSTER_GAP = 50;
/** Degrees of margin either side of a panel's views. */
const MARGIN = 2;
/** Phones scroll a panel sideways rather than shrink it below this (px per degree). */
const MIN_PPD = 4.5;
/** What the photos faced: peaks the app labels in them (public/demo/gipfelbuch/<id>.json). */
const REGIONS = [
	{ az: 45, label: "Hohgant" },
	{ az: 135, label: "Eiger · Mönch · Jungfrau" },
	{ az: 232, label: "Niesen" },
];
const POINTS = [
	"north",
	"northeast",
	"east",
	"southeast",
	"south",
	"southwest",
	"west",
	"northwest",
];

const hfovOf = (p: RollPhoto) =>
	(2 * Math.atan(Math.tan((p.solved.vfov * DEG) / 2) * (p.width / p.height))) /
	DEG;
const errorOf = (p: RollPhoto) => wrap180(p.solved.yaw - p.prior.yaw);
const clock = (p: RollPhoto) => {
	const d = new Date(p.takenAt);
	// The roll was shot in Switzerland (UTC+2 on the day).
	const h = (d.getUTCHours() + 2) % 24;
	return `${h}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const signed = (v: number, d = 1) =>
	`${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}°`;

function useReducedMotionOnce() {
	const [r] = useState(
		() =>
			typeof window !== "undefined" &&
			(window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
				navigator.webdriver === true),
	);
	return r;
}

function useWidth<T extends HTMLElement>(fallback: number) {
	const ref = useRef<T>(null);
	const [w, setW] = useState(fallback);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setW(el.clientWidth));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	return [ref, w] as const;
}

/** The skyline band of a photo (fractions of its height), kept tight to spare the foreground. */
function bandOf(p: RollPhoto): [number, number] {
	const rows = p.skyline.rows
		.filter((r, i): r is number => r !== null && p.skyline.weight[i] > 0.3)
		.sort((a, b) => a - b);
	const q = (f: number) =>
		rows[Math.min(rows.length - 1, Math.floor(f * rows.length))];
	const top = Math.max(0, q(0.05) - 0.03);
	// At most 16% of the frame: the ultra-wide shots (vfov ~86°) would otherwise bring in faces.
	return [top, Math.min(1, q(0.5) + 0.04, top + 0.16)];
}

type Placed = {
	/** One quad per strip: unrolled azimuth (deg from the cut) and elevation (deg) at the band's
	 * top and bottom rows; c0..c1 are the strip's photo columns. */
	strips: {
		x0: number;
		x1: number;
		top: number;
		bottom: number;
		c0: number;
		c1: number;
	}[];
	outline: [number, number][];
	skyline: [number, number][][];
	centre: [number, number];
};

/** Lays one photo's band onto a panel for a given pose. */
function place(
	p: RollPhoto,
	a: Angles,
	cut: number,
	band: [number, number],
): Placed {
	const cam = camera(a, p.width, p.height);
	const yT = band[0] * p.height;
	const yB = band[1] * p.height;
	const yM = (yT + yB) / 2;
	const at = (x: number, y: number): [number, number] => {
		const [az, el] = azEl(cam, x, y);
		return [wrap360(az - cut), el];
	};
	const strips = [];
	const top: [number, number][] = [];
	const bottom: [number, number][] = [];
	for (let i = 0; i < STRIPS; i++) {
		const c0 = (i / STRIPS) * p.width;
		const c1 = ((i + 1) / STRIPS) * p.width;
		const xc = (c0 + c1) / 2;
		strips.push({
			x0: at(c0, yM)[0],
			x1: at(c1, yM)[0],
			top: at(xc, yT)[1],
			bottom: at(xc, yB)[1],
			c0,
			c1,
		});
		top.push(at(c0, yT));
		bottom.push(at(c0, yB));
		if (i === STRIPS - 1) {
			top.push(at(c1, yT));
			bottom.push(at(c1, yB));
		}
	}
	const skyline: [number, number][][] = [];
	let run: [number, number][] = [];
	let prevX = -1;
	for (const o of rollObservations(p)) {
		if (o.y < yT || o.y > yB || o.w < 0.3) continue;
		if (prevX >= 0 && o.x - prevX > p.width / 40 && run.length) {
			skyline.push(run);
			run = [];
		}
		run.push(at(o.x, o.y));
		prevX = o.x;
	}
	if (run.length) skyline.push(run);
	return {
		strips,
		outline: [...top, ...bottom.reverse()],
		skyline,
		centre: at(p.width / 2, yM),
	};
}

type Cluster = {
	/** In time order: drawn back to front. */
	photos: RollPhoto[];
	cut: number;
	span: number;
	elLo: number;
	elHi: number;
	direction: string;
	region: string | null;
	errLo: number;
	errHi: number;
	worst: number;
};

/** Groups the photos by solved heading and frames each group (both poses, every print). */
function clusterPhotos(
	photos: RollPhoto[],
	bands: Map<string, [number, number]>,
) {
	const byYaw = [...photos].sort(
		(a, b) => wrap360(a.solved.yaw) - wrap360(b.solved.yaw),
	);
	// Start at the widest gap round the circle so no group is split across north.
	let start = 0;
	let widest = -1;
	byYaw.forEach((p, i) => {
		const prev = byYaw[(i + byYaw.length - 1) % byYaw.length];
		const g = wrap360(p.solved.yaw - prev.solved.yaw);
		if (g > widest) {
			widest = g;
			start = i;
		}
	});
	const ring = [...byYaw.slice(start), ...byYaw.slice(0, start)];
	const groups: RollPhoto[][] = [];
	for (const p of ring) {
		const last = groups.at(-1);
		const prev = last?.at(-1);
		if (last && prev && wrap360(p.solved.yaw - prev.solved.yaw) <= CLUSTER_GAP)
			last.push(p);
		else groups.push([p]);
	}
	return groups
		.map((g): Cluster => {
			const ref = g[0].solved.yaw;
			let lo = Number.POSITIVE_INFINITY;
			let hi = Number.NEGATIVE_INFINITY;
			for (const p of g)
				for (const a of [p.prior, p.solved]) {
					const h = hfovOf(p) / 2 + 1;
					const d = wrap180(a.yaw - ref);
					lo = Math.min(lo, d - h);
					hi = Math.max(hi, d + h);
				}
			const cut = wrap360(ref + lo - MARGIN);
			let elLo = Number.POSITIVE_INFINITY;
			let elHi = Number.NEGATIVE_INFINITY;
			let span = 0;
			for (const p of g)
				for (const a of [p.prior, p.solved])
					for (const [x, e] of place(
						p,
						a,
						cut,
						bands.get(p.id) as [number, number],
					).outline) {
						span = Math.max(span, x);
						elLo = Math.min(elLo, e);
						elHi = Math.max(elHi, e);
					}
			const centre = wrap360(cut + span / 2);
			const region = REGIONS.find(
				(r) => Math.abs(wrap180(r.az - centre)) < span / 2,
			);
			const errs = g.map(errorOf);
			return {
				photos: [...g].sort((a, b) => a.takenAt.localeCompare(b.takenAt)),
				cut,
				span: span + MARGIN,
				elLo,
				elHi,
				direction: POINTS[Math.round(centre / 45) % 8],
				region: region?.label ?? null,
				errLo: Math.min(...errs),
				errHi: Math.max(...errs),
				worst: Math.max(...errs.map(Math.abs)),
			};
		})
		.sort((a, b) => b.worst - a.worst);
}

/** `sketch` redraws the figure as a pen-and-paper field-book plate (the Gipfelbuch look); the
 * default keeps the dark /dev/meta rendering. */
export function RollCompasses({
	className,
	sketch = false,
}: {
	className?: string;
	sketch?: boolean;
}) {
	const roll = useRoll();
	const photos = useMemo(
		() =>
			roll
				? [...roll.photos].sort((a, b) => a.takenAt.localeCompare(b.takenAt))
				: null,
		[roll],
	);
	const [hover, setHover] = useState<string | null>(null);
	if (!photos)
		return (
			<div
				className={
					sketch
						? `aspect-[16/10] animate-pulse bg-[var(--gb-paper-deep)] ${className ?? ""}`
						: `aspect-[16/10] animate-pulse rounded-md bg-white/5 ${className ?? ""}`
				}
			/>
		);
	const active = hover ?? DEFAULT_ID;
	const errors = photos.map(errorOf);
	const lo = Math.min(...errors);
	const hi = Math.max(...errors);
	const abs = errors.map(Math.abs).sort((a, b) => a - b);
	const median = (abs[5] + abs[6]) / 2;
	const rejected = photos.filter((p) => !p.accepted);
	return (
		<figure
			className={
				sketch
					? `${className ?? ""}`
					: `overflow-hidden rounded-md bg-white/[0.02] ${className ?? ""}`
			}
			style={{ touchAction: "pan-y" }}
		>
			<Panels
				sketch={sketch}
				photos={photos}
				active={active}
				hover={hover}
				setHover={setHover}
			/>
			{sketch && <PenRule seed="roll-rule-strip" />}
			<div
				className={
					sketch
						? "px-1 pt-4 pb-3"
						: "border-t border-white/8 px-4 pt-4 pb-3 sm:px-6"
				}
			>
				<div className="max-w-2xl">
					<ErrorStrip
						sketch={sketch}
						photos={photos}
						active={active}
						setHover={setHover}
						lo={lo}
						hi={hi}
						median={median}
					/>
				</div>
			</div>
			{sketch && <PenRule seed="roll-rule-caption" />}
			<figcaption
				className={
					sketch
						? "nb-hand px-1 py-3 text-[14px] leading-relaxed text-[var(--nb-pencil)]"
						: "border-t border-white/8 px-4 py-3 text-[13px] leading-relaxed text-white/55 sm:px-6"
				}
			>
				<span
					className={
						sketch ? "text-[var(--nb-ink)]" : "text-[var(--rigi-paper)]"
					}
				>
					The phone's compass was off by {signed(lo)} to {signed(hi)} on one
					afternoon, for photos taken around one summit.
				</span>{" "}
				Placed by the compass, the photos' skylines miss the terrain's; placed
				by the skyline, each photo aligns and the photos facing one way join
				into one view. {rejected.length === 2 ? "Two" : rejected.length} (
				{rejected.map(clock).join(" and ")}) are rejected by the solver for low
				confidence. The demo still has a saved pose for them, from the app's
				later passes, and they are drawn there.
			</figcaption>
		</figure>
	);
}

function Panels({
	sketch,
	photos,
	active,
	hover,
	setHover,
}: {
	sketch: boolean;
	photos: RollPhoto[];
	active: string;
	hover: string | null;
	setHover: (id: string | null) => void;
}) {
	const reduced = useReducedMotionOnce();
	const [k, setK] = useState(() => (reduced ? 1 : 0));
	const [box, boxW] = useWidth<HTMLDivElement>(1100);
	// Play the move once, when the panels first come into view.
	const played = useRef(reduced);
	useEffect(() => {
		const el = box.current;
		if (!el || played.current) return;
		let raf = 0;
		const io = new IntersectionObserver(
			(es) => {
				if (!es.some((e) => e.isIntersecting) || played.current) return;
				played.current = true;
				io.disconnect();
				const t0 = performance.now();
				const tick = () => {
					const t = (performance.now() - t0) / 1000;
					setK(smooth((t - HOLD) / MOVE));
					if (t < HOLD + MOVE) raf = requestAnimationFrame(tick);
				};
				raf = requestAnimationFrame(tick);
			},
			{ threshold: 0.35 },
		);
		io.observe(el);
		return () => {
			io.disconnect();
			cancelAnimationFrame(raf);
		};
	}, [box]);

	const bands = useMemo(
		() => new Map(photos.map((p) => [p.id, bandOf(p)])),
		[photos],
	);
	const clusters = useMemo(() => clusterPhotos(photos, bands), [photos, bands]);
	// One scale for every panel, so a degree of correction looks the same everywhere.
	const ppd = Math.max(
		MIN_PPD,
		boxW / Math.max(...clusters.map((c) => c.span)),
	);

	return (
		<div className={sketch ? "pt-1" : "px-4 pt-4 sm:px-6 sm:pt-5"}>
			<div className="mb-2 flex flex-wrap items-center justify-between gap-3">
				<div
					className={
						sketch
							? "nb-hand flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-[var(--nb-pencil)]"
							: "flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-white/55"
					}
				>
					<Key
						swatch={
							<Line
								color={sketch ? SK.photo : C.photo}
								sketch={sketch}
								seed="key-photo"
							/>
						}
						label="photo skyline"
					/>
					<Key
						swatch={
							<Line
								color={sketch ? SK.terrain : C.terrain}
								dashed
								sketch={sketch}
								seed="key-terrain"
							/>
						}
						label="terrain skyline"
					/>
					<Key
						swatch={
							<Line
								color={sketch ? SK.error : C.error}
								sketch={sketch}
								seed="key-error"
							/>
						}
						label="compass → skyline"
					/>
				</div>
				<label
					className={
						sketch
							? "nb-hand flex items-center gap-2 text-[13px] text-[var(--nb-pencil)]"
							: "flex items-center gap-2 font-mono text-[10.5px] text-white/60"
					}
				>
					<span
						className={
							k < 0.5
								? sketch
									? "text-[var(--nb-ink)] underline decoration-[var(--nb-red)] underline-offset-4"
									: "text-[var(--rigi-paper)]"
								: ""
						}
					>
						compass
					</span>
					<input
						type="range"
						min={0}
						max={1}
						step={0.01}
						value={k}
						onChange={(e) => {
							played.current = true;
							setK(Number(e.target.value));
						}}
						className={`w-32 sm:w-44 ${sketch ? "accent-[var(--nb-red)]" : "accent-[var(--rigi-glow)]"}`}
						aria-label="Place the photos by the phone's compass or by the skyline"
					/>
					<span
						className={
							k >= 0.5
								? sketch
									? "text-[var(--nb-ink)] underline decoration-[var(--nb-red)] underline-offset-4"
									: "text-[var(--rigi-paper)]"
								: ""
						}
					>
						skyline
					</span>
				</label>
			</div>
			<div ref={box}>
				{clusters.map((c, index) => (
					<Panel
						key={c.cut}
						sketch={sketch}
						first={index === 0}
						cluster={c}
						bands={bands}
						ppd={ppd}
						k={k}
						active={active}
						hover={hover}
						setHover={setHover}
					/>
				))}
			</div>
		</div>
	);
}

/** Room above the prints for one row of correction arrows per photo. */
const ARROW_ROW = 11;

function Panel({
	sketch,
	first,
	cluster: c,
	bands,
	ppd,
	k,
	active,
	hover,
	setHover,
}: {
	sketch: boolean;
	first: boolean;
	cluster: Cluster;
	bands: Map<string, [number, number]>;
	ppd: number;
	k: number;
	active: string;
	hover: string | null;
	setHover: (id: string | null) => void;
}) {
	const TOP = 10 + c.photos.length * ARROW_ROW;
	const AXIS = 26;
	const W = c.span * ppd;
	const plotH = (c.elHi - c.elLo + 1.5) * ppd;
	const H = TOP + plotH + AXIS;
	const X = (u: number) => u * ppd;
	const Y = (el: number) => TOP + (c.elHi + 0.75 - el) * ppd;
	const pts = (ps: [number, number][]) =>
		ps.map(([x, e]) => `${X(x).toFixed(1)},${Y(e).toFixed(1)}`).join(" ");
	// The terrain skyline from where this group stood: the panel's accepted photo with the median
	// eye height (the day's spots are up to ~15 m apart in height and some metres in position).
	const terrain = useMemo(() => {
		const pool = c.photos.filter((p) => p.accepted);
		const sorted = [...(pool.length ? pool : c.photos)].sort(
			(a, b) => a.eye - b.eye,
		);
		const terrainRef = sorted[Math.floor(sorted.length / 2)];
		const out: [number, number][] = [];
		for (let u = 0; u <= c.span; u += 0.2)
			out.push([u, horizonEl(terrainRef, c.cut + u)]);
		return out;
	}, [c]);
	const placed = c.photos.map((p) => {
		const band = bands.get(p.id) as [number, number];
		return {
			p,
			band,
			now: place(p, lerpAngles(p.prior, p.solved, k), c.cut, band),
			ghost: place(p, p.prior, c.cut, band),
		};
	});
	// Back to front by time; the active print comes forward.
	const order = [...placed].sort(
		(a, b) => Number(a.p.id === active) - Number(b.p.id === active),
	);
	const done = k > 0.999;
	const sel = placed.find((q) => q.p.id === active)?.p;
	const mono = sketch ? "nb-num" : "font-mono";
	const arrowId = `roll-${Math.round(c.cut)}`;
	return (
		<div
			className={
				sketch
					? "pt-3 pb-4"
					: "border-t border-white/8 pt-3 pb-4 first:border-t-0 first:pt-1"
			}
		>
			{sketch && !first && (
				<PenRule seed={`${arrowId}-rule`} className="mb-3" />
			)}
			<div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
				<p
					className={
						sketch
							? "nb-hand text-[16px] text-[var(--nb-ink)]"
							: "text-[13px] text-[var(--rigi-paper)]"
					}
				>
					Facing {c.direction}
					{c.region && (
						<span
							className={sketch ? "text-[var(--nb-pencil)]" : "text-white/55"}
						>
							{" "}
							· {c.region}
						</span>
					)}
				</p>
				<p
					className={
						sketch
							? "nb-num text-[10.5px] text-[var(--nb-pencil)]"
							: "font-mono text-[10.5px] text-white/50"
					}
				>
					{c.photos.length} photo{c.photos.length === 1 ? "" : "s"} · compass
					off {signed(c.errLo)} … {signed(c.errHi)}
					{sel && (
						<span
							style={{
								color: sel.accepted
									? sketch
										? SK.error
										: C.error
									: sketch
										? SK.rejected
										: C.rejected,
							}}
						>
							{" "}
							· {clock(sel)} {sel.accepted ? signed(errorOf(sel)) : "rejected"}
						</span>
					)}
				</p>
			</div>
			<div
				className="overflow-x-auto overflow-y-hidden"
				style={{ touchAction: "pan-x pan-y" }}
			>
				<svg
					width={W}
					height={H}
					viewBox={`0 0 ${W} ${H}`}
					className="block select-none"
					role="img"
					aria-label={`Photos facing ${c.direction}, placed by compass or by skyline`}
					onPointerLeave={() => setHover(null)}
				>
					<defs>
						<marker
							id={`roll-arrow-${Math.round(c.cut)}`}
							viewBox="0 0 8 8"
							refX={7}
							refY={4}
							markerWidth={5}
							markerHeight={5}
							orient="auto"
						>
							<path d="M0,0L8,4L0,8z" fill={C.error} />
						</marker>
					</defs>
					{/* compass ghosts: where the phone put each print */}
					{done &&
						placed.map(({ p, ghost }) =>
							sketch ? (
								<SketchPolyline
									key={`g-${p.id}`}
									points={ghost.outline.map(([x, e]) => [X(x), Y(e)])}
									closed
									seed={`${arrowId}-ghost-${p.id}`}
									color="pencil"
									width={1}
									opacity={p.id === active ? 0.9 : 0.45}
									dash="3 4"
									passes={1}
								/>
							) : (
								<polygon
									key={`g-${p.id}`}
									points={pts(ghost.outline)}
									fill="none"
									stroke={brandAlpha("paper", p.id === active ? 0.5 : 0.18)}
									strokeDasharray="3 3"
								/>
							),
						)}
					{order.map(({ p, now, band }) => {
						const on = p.id === active;
						const dim = hover !== null && !on;
						// Thumbs are 360 px on the long side (portrait photos are 270 wide).
						const tw = 360 * Math.min(1, p.width / p.height);
						const th = (tw * p.height) / p.width;
						const sx = tw / p.width;
						return (
							// biome-ignore lint/a11y/noStaticElementInteractions: hover only links the views
							<g
								key={p.id}
								onPointerEnter={() => setHover(p.id)}
								onClick={() => setHover(p.id)}
								style={{ cursor: "pointer" }}
								opacity={dim ? 0.4 : 1}
							>
								{/* an ink rim first, so overlapping prints read as layers; in the
								 * field book it is a paper margin, like a pasted print */}
								<polygon
									points={pts(now.outline)}
									fill={sketch ? "var(--nb-paper)" : C.ink}
									stroke={sketch ? "var(--nb-paper)" : C.ink}
									strokeWidth={sketch ? 3 : 4}
									strokeLinejoin="round"
								/>
								{now.strips.map((s) => {
									const y0 = Y(Math.max(s.top, s.bottom));
									const y1 = Y(Math.min(s.top, s.bottom));
									return (
										<svg
											key={s.c0}
											x={X(Math.min(s.x0, s.x1))}
											y={y0}
											width={Math.abs(X(s.x1) - X(s.x0)) + 0.6}
											height={y1 - y0}
											viewBox={`${s.c0 * sx} ${band[0] * th} ${(s.c1 - s.c0) * sx} ${(band[1] - band[0]) * th}`}
											preserveAspectRatio="none"
											overflow="hidden"
											aria-hidden="true"
										>
											<image
												href={p.thumb}
												width={tw}
												height={th}
												opacity={p.accepted ? (sketch ? 0.95 : 0.78) : 0.35}
											/>
										</svg>
									);
								})}
								{sketch ? (
									<SketchPolyline
										points={now.outline.map(([x, e]) => [X(x), Y(e)])}
										closed
										seed={`${arrowId}-print-${p.id}`}
										color={!p.accepted ? "pencil" : on ? "ink" : "pencil"}
										width={on ? 1.3 : 0.9}
										opacity={on ? 0.9 : 0.6}
										dash={p.accepted ? undefined : "4 3"}
										passes={1}
										tolerance={0.7}
									/>
								) : (
									<polygon
										points={pts(now.outline)}
										fill="none"
										stroke={
											!p.accepted
												? C.rejected
												: on
													? C.terrain
													: brandAlpha("paper", 0.28)
										}
										strokeWidth={on ? 1.5 : 1}
										strokeDasharray={p.accepted ? undefined : "4 3"}
									/>
								)}
								{now.skyline.map((run, runIndex) =>
									sketch ? (
										<g key={`${run[0][0]}`}>
											<polyline
												points={pts(run)}
												fill="none"
												stroke="var(--nb-paper)"
												strokeOpacity={0.8}
												strokeWidth={on ? 4.5 : 3.5}
												strokeLinejoin="round"
											/>
											<SketchPolyline
												points={run.map(([x, e]) => [X(x), Y(e)])}
												seed={`${arrowId}-sky-${p.id}-${runIndex}`}
												color={SK.photo}
												width={on ? 2.2 : 1.6}
												passes={1}
												tolerance={0.7}
											/>
										</g>
									) : (
										<g key={`${run[0][0]}`}>
											<polyline
												points={pts(run)}
												fill="none"
												stroke={C.ink}
												strokeOpacity={0.7}
												strokeWidth={on ? 5 : 4}
												strokeLinejoin="round"
											/>
											<polyline
												points={pts(run)}
												fill="none"
												stroke={C.photo}
												strokeWidth={on ? 2.4 : 1.8}
												strokeLinejoin="round"
											/>
										</g>
									),
								)}
							</g>
						);
					})}
					{sketch ? (
						<g pointerEvents="none">
							<SketchPolyline
								points={terrain.map(([x, e]) => [X(x), Y(e)])}
								seed={`${arrowId}-terrain`}
								color={SK.terrain}
								width={1.8}
								dash="6 4"
								passes={1}
								tolerance={0.7}
							/>
						</g>
					) : (
						<polyline
							points={pts(terrain)}
							fill="none"
							stroke={C.terrain}
							strokeWidth={1.4}
							strokeDasharray="6 4"
							pointerEvents="none"
						/>
					)}
					{/* the correction per print, compass → skyline, one row each */}
					{done &&
						placed.map(({ p, ghost, now }, i) => {
							const y = 8 + i * ARROW_ROW;
							const on = p.id === active;
							const x1 = X(ghost.centre[0]);
							const x2 = X(now.centre[0]);
							const right = x2 >= x1;
							const label = `${clock(p)} ${signed(errorOf(p))}${p.accepted ? "" : " · rejected: low confidence"}`;
							return (
								<g
									key={`a-${p.id}`}
									opacity={hover !== null && !on ? 0.35 : 1}
									pointerEvents="none"
								>
									{sketch ? (
										<>
											{Math.abs(x2 - x1) > 6 ? (
												<PenArrow
													from={[x1, y]}
													to={[x2, y]}
													seed={`${arrowId}-arrow-${p.id}`}
													color={p.accepted ? SK.error : SK.rejected}
													width={on ? 2 : 1.4}
													bend={0.05}
													head={5}
												/>
											) : (
												<HandDot
													x={x2}
													y={y}
													r={2}
													seed={`${arrowId}-arrow-${p.id}`}
													color={p.accepted ? SK.error : SK.rejected}
												/>
											)}
											<HandText
												x={right ? x2 + 6 : x2 - 6}
												y={y + 3.5}
												anchor={right ? "start" : "end"}
												size={11.5}
												color={p.accepted ? SK.error : SK.rejected}
											>
												{label}
											</HandText>
										</>
									) : (
										<>
											<line
												x1={x1}
												x2={x2}
												y1={y}
												y2={y}
												stroke={p.accepted ? C.error : C.rejected}
												strokeWidth={on ? 2.2 : 1.5}
												markerEnd={`url(#roll-arrow-${Math.round(c.cut)})`}
											/>
											<text
												x={right ? x2 + 6 : x2 - 6}
												y={y}
												dominantBaseline="central"
												textAnchor={right ? "start" : "end"}
												className="font-mono"
												fontSize={9.5}
												fill={p.accepted ? C.error : C.rejected}
											>
												{label}
											</text>
										</>
									)}
								</g>
							);
						})}
					{/* azimuth axis */}
					{sketch ? (
						<PenLine
							from={[0, H - AXIS + 4]}
							to={[W, H - AXIS + 4]}
							seed={`${arrowId}-axis`}
							color="ink"
							width={1.2}
							opacity={0.7}
						/>
					) : (
						<line
							x1={0}
							x2={W}
							y1={H - AXIS + 4}
							y2={H - AXIS + 4}
							stroke={brandAlpha("paper", 0.15)}
						/>
					)}
					{Array.from({ length: 72 }, (_, i) => i * 5)
						.map((az) => ({ az, u: wrap360(az - c.cut) }))
						.filter(({ u }) => u <= c.span)
						.map(({ az, u }) => {
							const card = ({ 0: "N", 90: "E", 180: "S", 270: "W" } as const)[
								az as 0 | 90 | 180 | 270
							];
							const major = az % 10 === 0;
							return (
								<g key={az}>
									{sketch ? (
										<PenLine
											from={[X(u), H - AXIS + 4]}
											to={[X(u), H - AXIS + (card ? 11 : major ? 8 : 6)]}
											seed={`${arrowId}-tick-${az}`}
											color="ink"
											width={card ? 1.2 : 0.8}
											opacity={card ? 0.9 : major ? 0.6 : 0.4}
										/>
									) : (
										<line
											x1={X(u)}
											x2={X(u)}
											y1={H - AXIS + 4}
											y2={H - AXIS + (card ? 11 : major ? 8 : 6)}
											stroke={brandAlpha(
												"paper",
												card ? 0.5 : major ? 0.25 : 0.12,
											)}
										/>
									)}
									{(card || az % 20 === 0) &&
										(sketch && card ? (
											<HandText
												x={X(u)}
												y={H - AXIS + 22}
												anchor="middle"
												size={14}
												halo={false}
											>
												{card}
											</HandText>
										) : (
											<text
												x={X(u)}
												y={H - AXIS + 20}
												textAnchor="middle"
												className={mono}
												fontSize={card ? 10.5 : 9.5}
												fill={
													sketch
														? "var(--nb-pencil)"
														: brandAlpha("paper", card ? 0.75 : 0.35)
												}
											>
												{card ?? `${az}°`}
											</text>
										))}
								</g>
							);
						})}
				</svg>
			</div>
		</div>
	);
}

/** The pen-drawn inks of the sketch look (the --nb-* tokens the Gipfelbuch page defines). */
const SK = {
	photo: "blue",
	terrain: "brown",
	error: "red",
	rejected: "pencil",
} as const;

function Line({
	color,
	dashed = false,
	sketch = false,
	seed = "key",
}: {
	color: string;
	dashed?: boolean;
	sketch?: boolean;
	seed?: string;
}) {
	return (
		<svg width={18} height={8} aria-hidden="true">
			{sketch ? (
				<PenLine
					from={[0, 4]}
					to={[18, 4]}
					seed={seed}
					color={color}
					width={2}
					dash={dashed ? "4 3" : undefined}
				/>
			) : (
				<line
					x1={0}
					x2={18}
					y1={4}
					y2={4}
					stroke={color}
					strokeWidth={2}
					strokeDasharray={dashed ? "4 2" : undefined}
				/>
			)}
		</svg>
	);
}

function Key({ swatch, label }: { swatch: ReactNode; label: string }) {
	return (
		<span className="inline-flex items-center gap-1.5">
			{swatch}
			{label}
		</span>
	);
}

// ---- the compass error, sorted ----

function ErrorStrip({
	sketch,
	photos,
	active,
	setHover,
	lo,
	hi,
	median,
}: {
	sketch: boolean;
	photos: RollPhoto[];
	active: string;
	setHover: (id: string | null) => void;
	lo: number;
	hi: number;
	median: number;
}) {
	// Drawn at its measured pixel width, so labels keep one size at every screen width.
	const [box, W] = useWidth<HTMLDivElement>(520);
	const H = 58;
	const L = 14;
	const R = 14;
	const x = (e: number) => L + ((e + 20) / 35) * (W - L - R);
	const sorted = [...photos].sort((a, b) => errorOf(a) - errorOf(b));
	const mono = sketch ? "nb-num" : "font-mono";
	return (
		<div ref={box}>
			<p
				className={
					sketch
						? "nb-hand mb-1 text-[14px] text-[var(--nb-ink)]"
						: "mb-1 font-mono text-[10px] tracking-[0.14em] text-white/45 uppercase"
				}
			>
				Compass error per photo
			</p>
			<svg
				width={W}
				height={H}
				viewBox={`0 0 ${W} ${H}`}
				className="block"
				role="img"
				aria-label={`Compass error per photo, from ${lo.toFixed(1)} to ${hi.toFixed(1)} degrees`}
				onPointerLeave={() => setHover(null)}
			>
				{sketch ? (
					<PenLine
						from={[L, 24]}
						to={[W - R, 24]}
						seed="roll-err-axis"
						color="ink"
						width={1.2}
						opacity={0.8}
					/>
				) : (
					<line
						x1={L}
						x2={W - R}
						y1={24}
						y2={24}
						stroke={brandAlpha("paper", 0.15)}
					/>
				)}
				{[-20, -10, 0, 10, 15].map((v) => (
					<g key={v}>
						{sketch ? (
							<PenLine
								from={[x(v), v === 0 ? 8 : 20]}
								to={[x(v), v === 0 ? 40 : 28]}
								seed={`roll-err-tick-${v}`}
								color="ink"
								width={v === 0 ? 1.2 : 0.8}
								opacity={v === 0 ? 0.9 : 0.6}
							/>
						) : (
							<line
								x1={x(v)}
								x2={x(v)}
								y1={v === 0 ? 8 : 20}
								y2={v === 0 ? 40 : 28}
								stroke={brandAlpha("paper", v === 0 ? 0.4 : 0.2)}
							/>
						)}
						<text
							x={x(v)}
							y={52}
							textAnchor="middle"
							className={mono}
							fontSize={10}
							fill={sketch ? "var(--nb-pencil)" : brandAlpha("paper", 0.4)}
						>
							{v === 0 ? "0°" : signed(v, 0)}
						</text>
					</g>
				))}
				{sorted.map((p, i) => {
					const on = p.id === active;
					// Stack near-equal errors so every dot stays visible.
					const prev = sorted[i - 1];
					const stacked =
						prev && Math.abs(errorOf(p) - errorOf(prev)) < 0.9 && i % 2;
					if (sketch) {
						const cx = x(errorOf(p));
						const cy = stacked ? 14 : 24;
						const color = p.accepted ? SK.error : SK.rejected;
						return (
							<g
								key={p.id}
								onPointerEnter={() => setHover(p.id)}
								style={{ cursor: "pointer" }}
							>
								<circle cx={cx} cy={cy} r={8} fill="transparent" />
								{p.accepted ? (
									<HandDot
										x={cx}
										y={cy}
										r={on ? 5.5 : 4}
										seed={`roll-err-dot-${p.id}`}
										color={color}
									/>
								) : (
									<PenCircle
										center={[cx, cy]}
										radiusX={on ? 6 : 4.5}
										seed={`roll-err-ring-${p.id}`}
										color={color}
										width={1.5}
									/>
								)}
								{on && (
									<PenCircle
										center={[cx, cy]}
										radiusX={9}
										seed={`roll-err-on-${p.id}`}
										color="ink"
										width={1.2}
									/>
								)}
							</g>
						);
					}
					return (
						<circle
							key={p.id}
							cx={x(errorOf(p))}
							cy={stacked ? 14 : 24}
							r={on ? 6 : 4.5}
							fill={p.accepted ? C.error : "none"}
							stroke={p.accepted ? (on ? BRAND.paper : "none") : C.rejected}
							strokeWidth={1.5}
							onPointerEnter={() => setHover(p.id)}
							style={{ cursor: "pointer" }}
						/>
					);
				})}
				<text
					x={x(lo)}
					y={40}
					textAnchor="start"
					className={mono}
					fontSize={10}
					fill={sketch ? "var(--nb-red)" : C.error}
				>
					{signed(lo)}
				</text>
				<text
					x={x(hi)}
					y={40}
					textAnchor="end"
					className={mono}
					fontSize={10}
					fill={sketch ? "var(--nb-red)" : C.error}
				>
					{signed(hi)}
				</text>
			</svg>
			<p
				className={
					sketch
						? "nb-hand mt-1 text-[13px] leading-snug text-[var(--nb-pencil)]"
						: "mt-1 text-[11.5px] leading-snug text-white/45"
				}
			>
				Median size {median.toFixed(1)}°: enough to label the wrong summit. The
				skyline corrects it.
			</p>
		</div>
	);
}
