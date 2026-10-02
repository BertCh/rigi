// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	type RefObject,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Hachure, SketchPath, SketchPolyline } from "../notebook/Ink";
import type { Point } from "../notebook/sketch";
import { SWISS } from "../swiss/inks";
import { projectAzEl } from "../tafel/project";
import type { TafelBake } from "../tafel/useTafelBake";
import { useReducedMotion } from "./hooks";
import { LAYER_INKS, type PhotoLayer } from "./inks";
import type { GipfelbuchPhotoData } from "./real";
import { poseAt } from "./story";

// The landing page's surround (src/components/site/Surround.tsx), redrawn for the notebook. The photo
// keeps its full width, and its measured world runs out past the figure onto the sheet's margins:
// - the Tafel bake's ridge strokes, inked in contour brown through the stroke mask (`.tafel-spill`,
//   from tafel.css, which ConceptPage loads with the Tafel; no CSS import here, so node checks load this);
// - a compass ruler drawn by hand along the top;
// - the summits outside the frame, named with a hand leader as on a Panoramatafel.
// The spill also carries the figure's concept past the frame (`echo`): the layers the photo shows go on
// into the margins, drawn from the bake's wide DEM horizon (`TafelBake.horizon`) through the same
// projector as priorRows / solvedRows, so each meets its line in the photo at the frame's edge:
// - sky: navy hachure above the horizon (the map knows where the sky is past the frame);
// - skyline: the horizon at the spill's pose, dashed: past the frame the line is the map's, not the eye's;
// - prior / solved: the DEM horizon at the phone's guess and at the solved pose, in their inks, faded
//   by the alignment story as in the photo;
// - peaks / priorPeaks: the summit marks take the solved or the guess ink.
// A `cursor` (a sweep's column, a ray's azimuth) is marked on the ruler with its bearing, and dropped
// to the horizon when it points past the frame. All of it fades towards the outer edges. The layer reaches no further than the nearest
// `[data-gb-bleed-bounds]` ancestor (less EDGE), or the window's edge as on the landing. A bounds
// value of "left" or "right" clamps that side only. Phones get the ruler and no side spill, as on the landing.
// The whole layer's opacity reads `--gb-spill-reveal` (default 1), so a figure that animates its own
// reveal (PhotoStory's pen wipe) can bloom the margins in by setting that var on an ancestor, without
// re-rendering the spill; the spill adds no transition of its own.

/** CSS px kept above the photo for the ruler. */
export const RULER_BAND = 30;
/** Kept clear inside an ancestor's bounds (a side map beside the photo). */
const EDGE = 28;
/** Spill under the photo, as a fraction of its height. */
const BOTTOM = 0.1;
const PHONE = 640;
const MAX_PEAKS = 5;

const CARDINAL: Record<number, string> = {
	0: "N",
	45: "NE",
	90: "E",
	135: "SE",
	180: "S",
	225: "SW",
	270: "W",
	315: "NW",
};
const norm = (a: number) => ((a % 360) + 360) % 360;
const RAD = Math.PI / 180;
/** Past this angle off the axis a pinhole blows up; the spill never reaches it. */
const MAX_OFF_AXIS = 80;
/** The sky polygon's top, CSS px above the box (masked away). */
const SKY_TOP = 120;

/** What the photo shows, carried past the frame (see the header). */
export type SpillEcho = {
	layers: readonly PhotoLayer[];
	/** Stroke opacity of the prior and solved lines (the story's fade in the photo); default 1. */
	opacity?: Partial<Record<"prior" | "solved", number>>;
};

/** Where the figure points: a column of the photo (working px) or an azimuth (deg). */
export type SpillCursor = {
	x?: number;
	az?: number;
	/** Replaces the bearing under the mark. */
	label?: string;
	/** The ink of the mark (default the red of a correction). */
	layer?: PhotoLayer;
};

type Pose = ReturnType<typeof poseAt>;

/** The pose each photo's spill last showed, so a stage that remounts the photo slides on from it. */
const lastT = new Map<string, number>();
const SLIDE_MS = 620;

/** The spill's pose, eased from the last one shown for this photo; `immediate` follows a drag. */
function useSlide(id: string, target: number, immediate: boolean): number {
	const reduce = useReducedMotion();
	const [shown, setShown] = useState(() => lastT.get(id) ?? target);
	const cur = useRef(shown);
	useEffect(() => {
		const from = cur.current;
		const settle = (v: number) => {
			cur.current = v;
			lastT.set(id, v);
			setShown(v);
		};
		if (immediate || reduce || Math.abs(from - target) < 1e-4) {
			settle(target);
			return;
		}
		const t0 = performance.now();
		let raf = 0;
		const tick = (now: number) => {
			const u = Math.min(1, (now - t0) / SLIDE_MS);
			settle(from + (target - from) * (1 - (1 - u) ** 3));
			if (u < 1) raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [id, target, immediate, reduce]);
	return shown;
}

/** The DEM horizon as working-px points at `pose`, or null for a bake without one. */
export function horizonPoints(
	bake: TafelBake,
	data: GipfelbuchPhotoData,
	pose: Pose,
): Point[] | null {
	const h = bake.horizon;
	if (!h) return null;
	const { width: W, height: H } = data.photo;
	const out: Point[] = [];
	for (let i = 0; i < h.el.length; i++) {
		const az = h.az0 + i * h.step;
		if (Math.abs(norm(az - pose.yaw + 180) - 180) > MAX_OFF_AXIS) continue;
		out.push(projectAzEl(pose, W, H, az, h.el[i]));
	}
	return out;
}

/** The horizon's elevation (deg) at `az`, or null outside the bake's horizon. */
export function horizonEl(bake: TafelBake, az: number): number | null {
	const h = bake.horizon;
	if (!h) return null;
	const f = norm(az - h.az0) / h.step;
	const i = Math.floor(f);
	if (i < 0 || i + 1 >= h.el.length) return null;
	return h.el[i] + (h.el[i + 1] - h.el[i]) * (f - i);
}

/** The observer's pencil note, for what the figure shows. */
export function spillNote(on: (l: PhotoLayer) => boolean): string {
	if (on("prior") && on("solved")) return "same turn, all the way round";
	if (on("prior")) return "the phone's guess, carried past the frame";
	if (on("solved")) return "the solved pose fits past the frame too";
	if (on("sky")) return "the map knows where the sky is, frame or not";
	if (on("skyline"))
		return "past the frame the line is the map's, not the eye's";
	return "the ridges run on past the frame, traced from the DEM";
}

type Room = { width: number; left: number; right: number };

/** The photo box's CSS width and the room left and right of it inside the bleed bounds. */
export function useRoom(
	ref: RefObject<HTMLElement | null>,
	on: boolean,
): Room | null {
	const [room, setRoom] = useState<Room | null>(null);
	useLayoutEffect(() => {
		if (!on) return;
		let el: HTMLElement | null = null;
		let ro: ResizeObserver | null = null;
		let gone = false;
		const measure = () => {
			if (!el) return;
			const r = el.getBoundingClientRect();
			if (!r.width) return;
			// the window without its scrollbar, so the spill never adds a horizontal scroll
			let left = r.left;
			let right = document.documentElement.clientWidth - r.right;
			for (
				let at = el.parentElement?.closest<HTMLElement>(
					"[data-gb-bleed-bounds]",
				);
				at;
				at = at.parentElement?.closest<HTMLElement>("[data-gb-bleed-bounds]")
			) {
				const side = at.dataset.gbBleedBounds;
				const b = at.getBoundingClientRect();
				if (side !== "right") left = Math.min(left, r.left - b.left - EDGE);
				if (side !== "left") right = Math.min(right, b.right - r.right - EDGE);
			}
			const phone = window.innerWidth < PHONE;
			const next = {
				width: r.width,
				left: phone ? 0 : Math.max(0, left),
				right: phone ? 0 : Math.max(0, right),
			};
			setRoom((p) =>
				p &&
				Math.abs(p.width - next.width) < 0.5 &&
				Math.abs(p.left - next.left) < 0.5 &&
				Math.abs(p.right - next.right) < 0.5
					? p
					: next,
			);
		};
		const start = () => {
			el = ref.current;
			if (gone || !el) return;
			measure();
			ro = new ResizeObserver(measure);
			ro.observe(el);
		};
		// on a first commit the host's ref is attached after this child's layout effect (a bake already
		// cached, as when a Stages step remounts the photo): start once the commit has attached it
		if (ref.current) start();
		else queueMicrotask(start);
		window.addEventListener("resize", measure);
		return () => {
			gone = true;
			ro?.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [ref, on]);
	return on ? room : null;
}

export function GeoSpill({
	hostRef,
	data,
	bake,
	frame,
	maxSpill,
	t: target,
	immediate = false,
	echo,
	cursor,
}: {
	/** The photo's box (the svg's wrapper, under the ruler band). */
	hostRef: RefObject<HTMLElement | null>;
	data: GipfelbuchPhotoData;
	bake: TafelBake | null;
	/** The shown crop, working px. */
	frame: [number, number, number, number];
	/** The furthest spill per side, as a fraction of the photo's width. */
	maxSpill: number;
	/** Alignment story position: 0 draws the world where the phone's guess puts it, 1 at the solved pose. */
	t: number;
	/** Follow `t` at once (a dragged wipe); otherwise the spill slides to it. */
	immediate?: boolean;
	/** The photo's layers, carried past the frame. */
	echo?: SpillEcho;
	/** Where the figure points, marked on the ruler. */
	cursor?: SpillCursor | null;
}) {
	const room = useRoom(hostRef, !!bake);
	const t = useSlide(data.id, target, immediate);
	const layers = echo?.layers;
	const on = (l: PhotoLayer) => !!layers?.includes(l);
	// the prior and solved horizons sit at fixed poses: project once per bake
	const fixed = useMemo(
		() =>
			bake && data
				? {
						prior: horizonPoints(bake, data, poseAt(data, 0)),
						solved: horizonPoints(bake, data, poseAt(data, 1)),
					}
				: null,
		[bake, data],
	);
	if (!bake || !room) return null;
	const [x0, y0, x1, y1] = frame;
	const s = room.width / (x1 - x0); // CSS px per working px
	const photoH = (y1 - y0) * s;
	// the bake canvas in working px (canvas px per working px, then its box)
	const k = (bake.width * bake.photo.w) / data.photo.width;
	const cw = bake.width / k;
	const ch = bake.height / k;
	// the bake is drawn at its own camera; at another pose the world slides by f·tan(Δyaw) across
	// and f·tan(pitch) down (roll and the focal change are small here and left out)
	const pose = poseAt(data, t);
	const dYaw = norm(bake.camera.yaw - pose.yaw + 180) - 180;
	const dx = pose.f * Math.tan(dYaw * RAD);
	const dy =
		pose.f * Math.tan(pose.pitch * RAD) -
		bake.camera.f * Math.tan(bake.camera.pitch * RAD);
	const canvasX = (-(bake.photo.x * bake.width) / k + dx - x0) * s;
	const canvasY = (-(bake.photo.y * bake.height) / k + dy - y0) * s;
	// never past the bake's own canvas, the bounds or maxSpill
	const L = Math.min(room.left, maxSpill * room.width, Math.max(0, -canvasX));
	const R = Math.min(
		room.right,
		maxSpill * room.width,
		Math.max(0, canvasX + cw * s - room.width),
	);
	const B = photoH * BOTTOM;
	const boxW = L + room.width + R;
	const boxH = RULER_BAND + photoH + B;
	const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
	// the outer 60% of each side fades out; strokes start under the ruler and fade below the photo
	const fadeL = L > 0 ? pct((L * 0.6) / boxW) : "0%";
	const fadeR = R > 0 ? pct(1 - (R * 0.6) / boxW) : "100%";
	const sides = `linear-gradient(to right, transparent, #000 ${fadeL}, #000 ${fadeR}, transparent)`;
	const below = `linear-gradient(to bottom, transparent ${pct((RULER_BAND - 4) / boxH)}, #000 ${pct(RULER_BAND / boxH)}, #000 ${pct((RULER_BAND + photoH) / boxH)}, transparent)`;
	const toBox = (wx: number) => (wx - x0) * s + L;
	const toBoxPt = (q: Point): Point => [
		(q[0] - x0) * s + L,
		(q[1] - y0) * s + RULER_BAND,
	];
	// the echo: lines in box px, cut to the box (with a margin) so nothing is drawn off the page
	const inBox = (q: Point) => q[0] >= -24 && q[0] <= boxW + 24;
	const boxLine = (pts: Point[] | null | undefined) =>
		pts ? pts.map(toBoxPt).filter(inBox) : null;
	const showSky = on("sky");
	const showSkyline = on("skyline");
	const showPrior = on("prior");
	const showSolved = on("solved");
	const here =
		showSky || showSkyline ? boxLine(horizonPoints(bake, data, pose)) : null;
	const priorLine = showPrior ? boxLine(fixed?.prior) : null;
	const solvedLine = showSolved ? boxLine(fixed?.solved) : null;
	const skyD =
		showSky && here && here.length > 1
			? // closed well above the box, so the hachure's edge indication only follows the horizon
				`M${here[0][0].toFixed(1)} ${-SKY_TOP}${here.map((q) => `L${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join("")}L${here[here.length - 1][0].toFixed(1)} ${-SKY_TOP}Z`
			: null;
	const peakInk = on("peaks")
		? SWISS.navy
		: on("priorPeaks")
			? LAYER_INKS.priorPeaks.paperHex
			: SWISS.navy;
	const rulerY = RULER_BAND - 9;
	const ticks = bake.ticks
		.map((tick) => ({
			...tick,
			a: norm(Math.round(tick.az)),
			x: toBox(-(bake.photo.x * bake.width) / k + tick.x * cw + dx),
		}))
		.filter((tick) => tick.x >= 0 && tick.x <= boxW);
	// the cursor: a column of the photo, or an azimuth placed between the ruler's ticks
	let mark: { x: number; az: number; drop: number | null } | null = null;
	if (cursor && (cursor.x != null || cursor.az != null)) {
		const az =
			cursor.az ??
			pose.yaw +
				Math.atan(((cursor.x as number) - data.photo.width / 2) / pose.f) / RAD;
		let x: number | null = cursor.x != null ? toBox(cursor.x) : null;
		if (x == null)
			for (let i = 1; i < ticks.length && x == null; i++) {
				const a = ticks[i - 1];
				const b = ticks[i];
				const span = norm(b.az - a.az) || 360;
				const into = norm(az - a.az);
				if (into <= span) x = a.x + ((b.x - a.x) * into) / span;
			}
		if (x != null && x >= 0 && x <= boxW) {
			// past the frame the mark drops to the horizon it points at
			const outside = x < L || x > L + room.width;
			const el = outside ? horizonEl(bake, az) : null;
			const drop =
				el == null
					? null
					: toBoxPt(
							projectAzEl(pose, data.photo.width, data.photo.height, az, el),
						)[1];
			mark = { x, az: norm(az), drop };
		}
	}
	const markInk = cursor?.layer ? LAYER_INKS[cursor.layer].paper : SWISS.red;
	// summits beyond the frame, highest first, kept clear of each other
	const placed: {
		name: string;
		ele: number;
		km: number;
		x: number;
		y: number;
	}[] = [];
	for (const p of [...bake.peaks].sort((a, b) => b.ele - a.ele)) {
		if (placed.length >= MAX_PEAKS) break;
		const x = toBox(-(bake.photo.x * bake.width) / k + p.x * cw + dx);
		const y =
			(-(bake.photo.y * bake.height) / k + p.y * ch + dy - y0) * s + RULER_BAND;
		const outside = x < L - 8 || x > L + room.width + 8;
		const inside =
			x > 24 && x < boxW - 24 && y > RULER_BAND + 48 && y < RULER_BAND + photoH;
		if (!outside || !inside) continue;
		if (placed.some((q) => Math.abs(q.x - x) < 96)) continue;
		placed.push({ ...p, x, y });
	}
	const label = (tick: (typeof ticks)[number]) =>
		CARDINAL[tick.a] ?? (tick.a % 15 === 0 ? `${tick.a}°` : null);
	return (
		<div
			aria-hidden
			data-testid="gb-geo-spill"
			className="pointer-events-none absolute -z-10 select-none"
			style={{
				left: -L,
				top: -RULER_BAND,
				width: boxW,
				height: boxH,
				maskImage: sides,
				WebkitMaskImage: sides,
				opacity: "var(--gb-spill-reveal, 1)",
			}}
		>
			{/* ridges: terrain ink through the bake's stroke coverage */}
			<div
				className="absolute inset-0"
				style={{ maskImage: below, WebkitMaskImage: below }}
			>
				<div
					className="tafel-spill opacity-90"
					style={{
						left: canvasX + L,
						top: canvasY + RULER_BAND,
						width: cw * s,
						height: ch * s,
						maskImage: `url(${bake.src})`,
						WebkitMaskImage: `url(${bake.src})`,
					}}
				/>
				{(skyD || here || priorLine || solvedLine) && (
					<svg
						className="absolute inset-0 overflow-visible"
						width={boxW}
						height={boxH}
						viewBox={`0 0 ${boxW} ${boxH}`}
						aria-hidden="true"
						data-testid="gb-geo-spill-echo"
					>
						{skyD && (
							<Hachure
								d={skyD}
								seed={`${data.id}-spill-sky`}
								color={LAYER_INKS.sky.paper}
								width={0.7}
								opacity={0.4}
								angle={-60}
								gap={5}
								inset={26}
							/>
						)}
						{showSkyline && here && here.length > 1 && (
							<SketchPolyline
								points={here}
								seed={`${data.id}-spill-skyline`}
								color={LAYER_INKS.skyline.paper}
								width={1.6}
								dash="5 4"
								opacity={0.9}
								data
							/>
						)}
						{priorLine && priorLine.length > 1 && (
							<SketchPolyline
								points={priorLine}
								seed={`${data.id}-spill-prior`}
								color={LAYER_INKS.prior.paper}
								width={1.6}
								dash="6 5"
								opacity={echo?.opacity?.prior ?? 1}
								data
							/>
						)}
						{solvedLine && solvedLine.length > 1 && (
							<SketchPolyline
								points={solvedLine}
								seed={`${data.id}-spill-solved`}
								color={LAYER_INKS.solved.paper}
								width={1.8}
								opacity={echo?.opacity?.solved ?? 1}
								data
							/>
						)}
					</svg>
				)}
			</div>
			<svg
				className="absolute inset-0 overflow-visible"
				width={boxW}
				height={boxH}
				viewBox={`0 0 ${boxW} ${boxH}`}
				aria-hidden="true"
			>
				{/* the compass ruler, by hand: every 5°, lettered every 15° and at the cardinals */}
				<SketchPath
					d={`M0 ${rulerY}L${boxW.toFixed(1)} ${rulerY}`}
					seed={`${data.id}-spill-ruler`}
					color={SWISS.ink}
					width={0.9}
					opacity={0.55}
					passes={2}
					tolerance={0.9}
				/>
				<SketchPath
					d={ticks
						.map(
							(tick) =>
								`M${tick.x.toFixed(1)} ${rulerY}L${tick.x.toFixed(1)} ${rulerY + (label(tick) ? 6 : 3.5)}`,
						)
						.join("")}
					seed={`${data.id}-spill-ticks`}
					color={SWISS.ink}
					width={0.9}
					opacity={0.65}
					passes={1}
					tolerance={0.4}
				/>
				{/* summit leaders: a pen stroke up from a hand triangle */}
				{placed.map((p) => (
					<g key={p.name}>
						<path
							d={`M${p.x} ${p.y - 1}l-3.2 5.5h6.4z`}
							fill={peakInk}
							fillOpacity={0.35}
						/>
						<SketchPath
							d={`M${p.x} ${p.y - 1}l-3.2 5.5h6.4zM${p.x} ${p.y - 4}L${p.x} ${p.y - 18}`}
							seed={`spill-peak-${p.name}`}
							color={peakInk}
							width={1.1}
							passes={2}
							tolerance={0.5}
						/>
					</g>
				))}
				{/* the cursor: a caret on the ruler, a pencil drop to the photo or to the horizon it names */}
				{mark && (
					<g data-testid="gb-geo-spill-cursor">
						<path
							d={`M${mark.x.toFixed(1)} ${rulerY + 1}l-4 7h8z`}
							fill={markInk}
						/>
						<SketchPath
							d={`M${mark.x.toFixed(1)} ${rulerY + 8}L${mark.x.toFixed(1)} ${(mark.drop ?? RULER_BAND).toFixed(1)}`}
							seed={`${data.id}-spill-cursor`}
							color={markInk}
							width={1}
							dash="3 3"
							opacity={0.8}
							passes={1}
							tolerance={0.4}
						/>
						{mark.drop != null && (
							<circle
								cx={mark.x}
								cy={mark.drop}
								r={3}
								fill="none"
								stroke={markInk}
								strokeWidth={1.2}
							/>
						)}
					</g>
				)}
			</svg>
			{ticks.map((tick) => {
				const text = label(tick);
				if (!text) return null;
				const cardinal = !!CARDINAL[tick.a];
				return (
					<span
						key={tick.az}
						className={`absolute -translate-x-1/2 leading-none whitespace-nowrap ${cardinal ? "nb-label text-[12px] text-[var(--gb-red)]" : "nb-num text-[10.5px] text-[var(--gb-secondary)]"}`}
						style={{ left: tick.x, top: rulerY - 15 }}
					>
						{text}
					</span>
				);
			})}
			{mark && (
				<span
					className="nb-num absolute -translate-x-1/2 leading-none whitespace-nowrap text-[11px] font-semibold"
					style={{
						left: mark.x,
						top: rulerY - 15,
						color: markInk,
						textShadow:
							"0 0 3px var(--gb-paper), 0 0 2px var(--gb-paper), 0 0 1px var(--gb-paper)",
					}}
				>
					{cursor?.label ?? `${Math.round(mark.az)}°`}
				</span>
			)}
			{placed.map((p) => (
				<span
					key={p.name}
					className="absolute leading-none whitespace-nowrap"
					style={{
						left: p.x + 4,
						top: p.y - 46,
						textShadow:
							"0 0 3px var(--gb-paper), 0 0 2px var(--gb-paper), 0 0 1px var(--gb-paper)",
					}}
				>
					<span className="nb-label block text-[12.5px] text-[var(--gb-navy)]">
						{p.name}
					</span>
					<span className="nb-num mt-0.5 block text-[10.5px] text-[var(--gb-secondary)] italic">
						{p.ele} m · {p.km < 10 ? p.km.toFixed(1) : Math.round(p.km)} km
					</span>
				</span>
			))}
			{/* the observer's note in the left margin, under the photo's bottom edge */}
			{L >= 140 && (
				<span
					className="nb-hand absolute w-[120px] text-right text-[17px] leading-[19px] text-[var(--gb-pencil)]"
					style={{
						left: L - 132,
						top: RULER_BAND + photoH - 40,
						rotate: "-3deg",
					}}
				>
					{spillNote(on)}
				</span>
			)}
		</div>
	);
}
