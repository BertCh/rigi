// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	type CSSProperties,
	type MutableRefObject,
	memo,
	type PointerEvent,
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { cn } from "#/lib/utils";
import { KrokiTitle } from "../notebook/carto";
import { HandDot, PenArrow, PenCircle, SketchPath } from "../notebook/Ink";
import { Struck, signedDegrees } from "../notebook/notes";
import { hashSeed, sketchArrow } from "../notebook/sketch";
import { useNotebookPhoto } from "../notebook/useNotebookPhoto";
import { projectAzEl } from "../tafel/project";
import { type TafelBake, useTafelBake } from "../tafel/useTafelBake";
import { Figure } from "./Figure";
import { horizonPoints } from "./GeoSpill";
import { HandFrame, HandLoop } from "./hand";
import { revealsImmediately } from "./hooks";
import { dashFor, inkFor } from "./inks";
import { HandLabel } from "./labels";
import {
	CrispLine,
	type GipfelbuchPeak,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
	LAYER_STYLE,
	RealPhoto,
	rowsPath,
	useGipfelbuchPhoto,
} from "./real";
import {
	AlignmentStoryProvider,
	poseAt,
	SpillSideContext,
	useAlignmentStory,
} from "./story";
import {
	beatSpan,
	type FilmBeatId,
	type FilmFrame,
	type FilmPlan,
	filmFrame,
	filmPlan,
	loopFrame,
	pickTickColumns,
	ridePoint,
	type StoryFocus,
} from "./storyFilm";
import {
	BEAT_LAYERS,
	beatLabel,
	gapTick,
	HOVER_REPLAY_MS,
	hairlineScales,
	horizonPathAt,
	horizonRowAt,
	nextArmed,
	riderOpacity,
	scrubMs,
	shouldCommitT,
	solvedAlpha,
	spillCursorFor,
	stepBeat,
	tickOpacity,
	viewShare,
} from "./storyGeometry";

export type { StoryFocus };

// The story on the photo, as a film. One real demo photo, its alignment written on it by hand in four
// beats (guess, measure, correct, snap; a refused solve ends on "keep"). The clock is a ref: every
// frame is written straight onto the DOM (clip widths, the moving DEM horizon, gap ticks, riding
// names, mask offsets), and React only hears about a beat change and, at most every 33 ms while it
// moves, the pose t that the margins' spill follows. The script is storyFilm.ts (pure, specced); the
// helpers are storyGeometry.ts. Static (reduced motion, webdriver, print, no IntersectionObserver)
// shows the settled frame: filmFrame(plan, plan.total).

const useIsomorphicLayoutEffect =
	typeof window === "undefined" ? useEffect : useLayoutEffect;

const PRIOR_INK = LAYER_STYLE.priorPeaks.color;
const SOLVED_PEAK_INK = LAYER_STYLE.peaks.color;
const RED = "var(--gb-red, #bf2233)";
const INK = "var(--gb-ink, #131313)";
const PAPER = "var(--gb-paper, #f6f4ef)";
/** Label size in working px (800 wide): about 13–17 CSS px across the wide track. */
const LABEL = 14;
const MAX_GUESSES = 4;
const GUESS_GAP = 130;
const TICKS_WIDE = 11;
const TICKS_NARROW = 7;
const NARROW_PX = 640;

const inFrame = (d: GipfelbuchPhotoData, q: [number, number] | null) =>
	!!q &&
	q[0] >= 0 &&
	q[0] <= d.photo.width &&
	q[1] >= 0 &&
	q[1] <= d.photo.height;

/** Rough hand-capitals width (px) of a name at `size`, for strikes and edge clamping. */
const nameWidth = (name: string, size: number) => name.length * size * 0.66;

/** Up to four guessed names, the most prominent first, kept apart along x. */
function pickGuesses(d: GipfelbuchPhotoData): GipfelbuchPeak[] {
	const out: GipfelbuchPeak[] = [];
	const candidates = d.peaks
		.filter((p) => p.labelled && inFrame(d, p.prior))
		.sort((a, b) => b.el - a.el);
	for (const p of candidates) {
		const x = (p.prior as [number, number])[0];
		if (
			out.every(
				(q) => Math.abs((q.prior as [number, number])[0] - x) >= GUESS_GAP,
			)
		)
			out.push(p);
		if (out.length >= MAX_GUESSES) break;
	}
	return out;
}

/** The peak whose prior and solved marks are both in frame, highest first: the arc's endpoints. */
function pickAnchor(d: GipfelbuchPhotoData): GipfelbuchPeak | null {
	return (
		d.peaks
			.filter((p) => p.labelled && inFrame(d, p.prior) && inFrame(d, p.solved))
			.sort((a, b) => b.el - a.el)[0] ?? null
	);
}

/** The most confident traced column in the left part of the frame, for the "traced" note. */
function pickTraced(d: GipfelbuchPhotoData): [number, number] | null {
	const { rows, weight } = d.skyline;
	let best = -1;
	for (let x = Math.round(d.photo.width * 0.06); x < d.photo.width * 0.4; x++)
		if (rows[x] != null && (best < 0 || weight[x] > weight[best])) best = x;
	return best < 0 ? null : [best + 0.5, rows[best] as number];
}

// --- the DOM the film writes -------------------------------------------------

type El = SVGElement | HTMLElement;
interface FilmNodes {
	wrap: HTMLElement | null;
	overlay: El | null;
	priorClip: El | null;
	skylineClip: El | null;
	priorGroup: El | null;
	solvedGroup: El | null;
	weightGroup: El | null;
	movingGroup: El | null;
	movingPath: El | null;
	movingHalo: El | null;
	arcMask: El | null;
	arcGroup: El | null;
	ringMask: El | null;
	tap: El | null;
	poseNote: El | null;
	tracedNote: El | null;
	readoutPrior: El | null;
	readoutSolved: El | null;
	numbers: El | null;
	verdict: El | null;
	ticks: (El | null)[];
	strikes: (El | null)[];
	pulses: (El | null)[];
	names: (El | null)[];
	riders: (El | null)[];
	hairs: (El | null)[];
}
type SingleNode = Exclude<
	keyof FilmNodes,
	"ticks" | "strikes" | "pulses" | "names" | "riders" | "hairs"
>;
type ListNode = "ticks" | "strikes" | "pulses" | "names" | "riders" | "hairs";

const newNodes = (): FilmNodes => ({
	wrap: null,
	overlay: null,
	priorClip: null,
	skylineClip: null,
	priorGroup: null,
	solvedGroup: null,
	weightGroup: null,
	movingGroup: null,
	movingPath: null,
	movingHalo: null,
	arcMask: null,
	arcGroup: null,
	ringMask: null,
	tap: null,
	poseNote: null,
	tracedNote: null,
	readoutPrior: null,
	readoutSolved: null,
	numbers: null,
	verdict: null,
	ticks: [],
	strikes: [],
	pulses: [],
	names: [],
	riders: [],
	hairs: [],
});

interface Geom {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	k: number;
}
interface GuessLayout {
	p: GipfelbuchPeak;
	x: number;
	y: number;
	tx: number;
	ty: number;
	w: number;
}

/** Everything applyFrame needs besides the frame; refreshed on each render. */
interface FilmCtx {
	d: GipfelbuchPhotoData;
	plan: FilmPlan;
	bake: TafelBake | null;
	geom: Geom;
	layout: GuessLayout[];
	riders: GipfelbuchPeak[];
	anchor: GipfelbuchPeak | null;
	tickCols: number[];
}

const attr = (el: El | null | undefined, name: string, v: number | string) =>
	el?.setAttribute(name, typeof v === "number" ? String(+v.toFixed(3)) : v);
const opacityOf = (el: El | null | undefined, v: number) =>
	attr(el, "opacity", Math.max(0, Math.min(1, v)));

/** A rider's position and opacity at frame `f`: the summit's projection at pose t, exact at the ends. */
function riderState(
	d: GipfelbuchPhotoData,
	p: GipfelbuchPeak,
	i: number,
	accepted: boolean,
	f: FilmFrame,
) {
	const { width: W, height: H } = d.photo;
	const [x, y] = ridePoint(
		(t) => projectAzEl(poseAt(d, t), W, H, p.az, p.el),
		p.prior as [number, number],
		p.solved as [number, number],
		f.t,
	);
	const ok = Number.isFinite(x) && Number.isFinite(y);
	return {
		x: ok ? x : 0,
		y: ok ? y : 0,
		opacity: ok ? riderOpacity(accepted, f.t, f.pulses[i] ?? 0) : 0,
	};
}

/** One tick's attributes at frame `f`, given the moving horizon's points (or null). */
function tickState(
	c: Pick<FilmCtx, "d" | "tickCols" | "plan">,
	i: number,
	f: FilmFrame,
	points: readonly [number, number][] | null,
) {
	const { d, plan } = c;
	const col = c.tickCols[i];
	const sy = d.skyline.rows[col];
	const hy = horizonRowAt(d.priorRows, d.solvedRows, points, col, f.t);
	if (sy == null || hy == null) return null;
	const tick = gapTick(hy, sy, f.ticks[i] ?? 0);
	return {
		x: col + 0.5,
		...tick,
		opacity: tickOpacity(
			f.ticks[i] ?? 0,
			tick.weight,
			f.verdict,
			plan.focus === "gaps",
		),
	};
}

const SOLVED_INK = inkFor("solved", "photo");
const PRIOR_LINE_INK = inkFor("prior", "photo");
const stroke = (el: El | null | undefined, color: string) => {
	if (el) (el as SVGElement).style.stroke = color;
};

/** Writes one frame onto the nodes: attributes and styles only, no React. */
function applyFrame(c: FilmCtx, n: FilmNodes, f: FilmFrame) {
	const { d, plan, geom, bake } = c;
	const { x0, x1 } = geom;
	const accepted = plan.accepted;
	const lastBeat = plan.beats.length - 1;
	opacityOf(n.overlay, f.overlay);
	n.wrap?.style.setProperty(
		"--gb-spill-reveal",
		String(+(f.spillReveal * f.overlay).toFixed(3)),
	);
	attr(n.priorClip, "width", (x1 - x0) * f.priorWipe);
	attr(n.skylineClip, "width", (x1 - x0) * f.skylineWipe);
	opacityOf(n.priorGroup, 1 - 0.65 * f.priorGhost);
	const hasMoving = !!bake?.horizon;
	opacityOf(n.solvedGroup, solvedAlpha(f, hasMoving, accepted, lastBeat));
	opacityOf(n.weightGroup, f.weight);

	// derived: the DEM horizon at the pose in between, and the ticks that ride on it
	const points =
		hasMoving && bake && f.t > 0 && f.t < 1
			? horizonPoints(bake, d, poseAt(d, f.t))
			: null;
	const path = horizonPathAt(points, geom.x0, geom.x1);
	attr(n.movingPath, "d", path);
	attr(n.movingHalo, "d", path);
	stroke(
		n.movingPath,
		`color-mix(in oklab, ${PRIOR_LINE_INK} ${Math.round((1 - f.t) * 100)}%, ${SOLVED_INK})`,
	);
	opacityOf(n.movingGroup, f.moving);
	c.tickCols.forEach((_, i) => {
		const el = n.ticks[i];
		if (!el) return;
		const s = tickState(c, i, f, points);
		if (!s) {
			opacityOf(el, 0);
			return;
		}
		attr(el, "x1", s.x);
		attr(el, "x2", s.x);
		attr(el, "y1", s.y1);
		attr(el, "y2", s.y2);
		stroke(el, s.red ? RED : SOLVED_INK);
		opacityOf(el, s.opacity);
	});

	// furniture
	attr(n.arcMask, "stroke-dashoffset", 1 - f.arc);
	opacityOf(n.arcGroup, !accepted && f.beat === lastBeat ? 0.6 : 1);
	c.layout.forEach((g, i) => {
		attr(n.strikes[i], "width", (g.w + 8) * (f.strikes[i] ?? 0));
	});
	c.riders.forEach((p, i) => {
		const el = n.pulses[i];
		if (!el || !p.solved) return;
		const pulse = f.pulses[i] ?? 0;
		const [cx, cy] = p.solved;
		attr(
			el,
			"transform",
			`translate(${cx} ${cy}) scale(${+(1 + 2.5 * pulse).toFixed(3)}) translate(${-cx} ${-cy})`,
		);
		opacityOf(el, pulse > 0 ? 1 - pulse : 0);
	});
	attr(n.ringMask, "stroke-dashoffset", 1 - f.ring);
	opacityOf(n.tap, f.tap);

	// notes
	c.layout.forEach((_, i) => {
		opacityOf(n.names[i], (f.names[i] ?? 0) * (1 - 0.65 * f.priorGhost));
	});
	c.riders.forEach((p, i) => {
		const el = n.riders[i];
		if (!el) return;
		const s = riderState(d, p, i, accepted, f);
		attr(el, "transform", `translate(${s.x.toFixed(2)} ${s.y.toFixed(2)})`);
		opacityOf(el, s.opacity);
	});
	opacityOf(n.poseNote, f.poseNote);
	opacityOf(n.tracedNote, f.tracedNote);
	opacityOf(n.readoutPrior, f.readoutPrior);
	opacityOf(n.readoutSolved, f.readoutSolved);
	opacityOf(n.numbers, f.numbers);
	opacityOf(n.verdict, f.verdict);

	hairlineScales(f, plan.beats.length).forEach((s, i) => {
		const el = n.hairs[i];
		if (el) el.style.transform = `scaleX(${+s.toFixed(3)})`;
	});
}

// --- the overlay ------------------------------------------------------------

const Film = memo(function Film({
	d,
	plan,
	f0,
	nodes,
	geom,
	layout,
	riders,
	anchor,
	tickCols,
	bake,
}: {
	d: GipfelbuchPhotoData;
	plan: FilmPlan;
	f0: FilmFrame;
	nodes: MutableRefObject<FilmNodes>;
	geom: Geom;
	layout: GuessLayout[];
	riders: GipfelbuchPeak[];
	anchor: GipfelbuchPeak | null;
	tickCols: number[];
	bake: TafelBake | null;
}) {
	const uid = useId().replace(/:/g, "");
	const { x0, y0, x1, y1, k } = geom;
	const W = d.photo.width;
	const accepted = plan.accepted;
	const focus = plan.focus;
	const sz = LABEL * k;
	const traced = useMemo(() => pickTraced(d), [d]);
	const priorPath = useMemo(() => rowsPath(d.priorRows, 12), [d]);
	const skylinePath = useMemo(() => rowsPath(d.skyline.rows, 8), [d]);
	const solvedPath = useMemo(() => rowsPath(d.solvedRows, 12), [d]);
	const hasMoving = !!bake?.horizon;
	const reg = (key: SingleNode) => (el: El | null) => {
		(nodes.current[key] as El | null) = el;
	};
	const regAt = (key: ListNode, i: number) => (el: El | null) => {
		nodes.current[key][i] = el;
	};
	const from = anchor?.prior ?? null;
	const to = anchor?.solved ?? null;
	const arc = useMemo(
		() =>
			from && to
				? sketchArrow(from, to, hashSeed("story-correct-halo"), {
						bend: 0.42,
						head: 8,
					}).shaft
				: null,
		[from, to],
	);
	const mx = from && to ? (from[0] + to[0]) / 2 : W / 2;
	const top =
		from && to
			? Math.max(y0 + 34 * k, Math.min(from[1], to[1]) - 26 * k)
			: y0 + 30 * k;
	const confidence = d.solved.confidence;
	const refusedText = `refused: ${
		d.solved.rejectReason && d.solved.rejectReason !== "low-confidence"
			? d.solved.rejectReason
			: `confidence ${confidence.toFixed(2)} < 0.5`
	}`;
	const verdictText = accepted
		? `confidence ${confidence.toFixed(2)}`
		: refusedText;
	const verdictW = nameWidth(verdictText, sz) * 0.9;
	const clipRect = (
		id: string,
		width: number,
		ref: (el: El | null) => void,
	) => (
		<clipPath id={`${uid}-${id}`}>
			<rect ref={ref} x={x0} y={y0} width={width} height={y1 - y0} />
		</clipPath>
	);
	const maskBox = {
		maskUnits: "userSpaceOnUse" as const,
		x: x0,
		y: y0,
		width: x1 - x0,
		height: y1 - y0,
	};
	const pointsNone = null;
	return (
		<g ref={reg("overlay")} opacity={f0.overlay}>
			<defs>
				{clipRect("prior", (x1 - x0) * f0.priorWipe, reg("priorClip"))}
				{clipRect("skyline", (x1 - x0) * f0.skylineWipe, reg("skylineClip"))}
				{arc && (
					<mask id={`${uid}-arc`} {...maskBox}>
						<path
							ref={reg("arcMask")}
							d={arc}
							pathLength={1}
							fill="none"
							stroke="white"
							strokeWidth={18 * k}
							strokeDasharray="1 1"
							strokeDashoffset={1 - f0.arc}
						/>
					</mask>
				)}
				{anchor?.solved && accepted && (
					<mask id={`${uid}-ring`} {...maskBox}>
						<circle
							ref={reg("ringMask")}
							cx={anchor.solved[0]}
							cy={anchor.solved[1]}
							r={10.5}
							transform={`rotate(-90 ${anchor.solved[0]} ${anchor.solved[1]})`}
							pathLength={1}
							fill="none"
							stroke="white"
							strokeWidth={14}
							strokeDasharray="1 1"
							strokeDashoffset={1 - f0.ring}
						/>
					</mask>
				)}
				{accepted &&
					layout.map((g, i) => (
						<clipPath key={g.p.name} id={`${uid}-strike-${i}`}>
							<rect
								ref={regAt("strikes", i)}
								x={g.tx - g.w / 2 - 4}
								y={g.ty - 22 * k}
								width={(g.w + 8) * (f0.strikes[i] ?? 0)}
								height={30 * k}
							/>
						</clipPath>
					))}
			</defs>

			{/* measured: the guessed horizon and the trace wipe in by hand; the solved line is the app's */}
			<g data-film="measured">
				<g ref={reg("priorGroup")} opacity={1 - 0.65 * f0.priorGhost}>
					<g clipPath={`url(#${uid}-prior)`}>
						<CrispLine
							d={priorPath}
							seed={`${d.id}-story-prior`}
							color={PRIOR_LINE_INK}
							width={2.2 * k}
							dash={dashFor("prior", k)}
						/>
					</g>
				</g>
				<g clipPath={`url(#${uid}-skyline)`}>
					<CrispLine
						d={skylinePath}
						seed={`${d.id}-story-skyline`}
						color={inkFor("skyline", "photo")}
						width={1.7 * k}
					/>
				</g>
				<g
					ref={reg("solvedGroup")}
					data-film="solved-line"
					opacity={solvedAlpha(f0, hasMoving, accepted, plan.beats.length - 1)}
				>
					<CrispLine
						d={solvedPath}
						seed={`${d.id}-story-solved`}
						color={SOLVED_INK}
						width={2.2 * k}
					/>
				</g>
				{focus === "trace" && (
					<g
						ref={reg("weightGroup")}
						clipPath={`url(#${uid}-skyline)`}
						opacity={f0.weight}
					>
						{d.skyline.rows.map((y, x) =>
							y == null || x % Math.max(1, Math.round(4 * k)) ? null : (
								<line
									// biome-ignore lint/suspicious/noArrayIndexKey: the index is the image column
									key={x}
									x1={x + 0.5}
									x2={x + 0.5}
									y1={y}
									y2={y - (4 + 26 * d.skyline.weight[x]) * k}
									stroke={LAYER_STYLE.weight.color}
									strokeWidth={2.4 * k}
									opacity={0.25 + 0.75 * d.skyline.weight[x]}
								/>
							),
						)}
					</g>
				)}
			</g>

			{/* derived: the map's horizon at the pose between the two, and the gaps to the trace */}
			<g data-film="derived">
				<g ref={reg("movingGroup")} opacity={f0.moving} fill="none">
					<path
						ref={reg("movingHalo")}
						d=""
						style={{ stroke: PAPER }}
						strokeOpacity={0.6}
						strokeWidth={2.2 * k + 4 * k}
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<path
						ref={reg("movingPath")}
						d=""
						style={{ stroke: PRIOR_LINE_INK }}
						strokeWidth={2.2 * k}
						strokeDasharray={dashFor("prior", k)}
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</g>
				{tickCols.map((col, i) => {
					const s = tickState({ d, tickCols, plan }, i, f0, pointsNone);
					return (
						<line
							key={col}
							ref={regAt("ticks", i)}
							data-film="tick"
							x1={s?.x ?? 0}
							x2={s?.x ?? 0}
							y1={s?.y1 ?? 0}
							y2={s?.y2 ?? 0}
							style={{ stroke: s?.red ? RED : SOLVED_INK }}
							strokeWidth={1.4 * k}
							strokeLinecap="round"
							opacity={s?.opacity ?? 0}
						/>
					);
				})}
			</g>

			{/* furniture: the hand's arc, strikes, rings; each sits on measured endpoints */}
			<g data-film="furniture">
				{arc && from && to && (
					<g
						ref={reg("arcGroup")}
						data-film="arc"
						mask={`url(#${uid}-arc)`}
						opacity={!accepted && plan.beats.length - 1 === f0.beat ? 0.6 : 1}
					>
						<PenArrow
							seed="story-correct-halo"
							from={from}
							to={to}
							bend={0.42}
							head={8}
							color={PAPER}
							width={4.4 * k}
							opacity={0.7}
						/>
						<PenArrow
							seed="story-correct-halo"
							from={from}
							to={to}
							bend={0.42}
							head={8}
							color={RED}
							width={2 * k}
						/>
					</g>
				)}
				{accepted &&
					layout.map((g, i) => (
						<g
							key={g.p.name}
							data-film="strike"
							clipPath={`url(#${uid}-strike-${i})`}
						>
							<SketchPath
								d={`M${g.tx - g.w / 2 - 4} ${g.ty - 3 * k}L${g.tx + g.w / 2 + 4} ${g.ty - 6 * k}`}
								seed={`story-strike-${g.p.name}`}
								color={RED}
								width={2 * k}
								passes={1}
							/>
						</g>
					))}
				{accepted &&
					riders.map((p, i) => (
						<g
							key={p.name}
							ref={regAt("pulses", i)}
							data-film="pulse"
							opacity={(f0.pulses[i] ?? 0) > 0 ? 1 - (f0.pulses[i] ?? 0) : 0}
						>
							<PenCircle
								center={p.solved as [number, number]}
								radiusX={7 * k}
								radiusY={6 * k}
								seed={`story-pulse-${p.name}`}
								color={RED}
								width={1.5 * k}
							/>
						</g>
					))}
				{accepted && anchor?.solved && (
					<g data-film="ring" mask={`url(#${uid}-ring)`}>
						<PenCircle
							center={anchor.solved}
							radiusX={11}
							radiusY={10}
							seed="story-snap-ring"
							color={RED}
							width={1.6 * k}
						/>
					</g>
				)}
				{focus === "tap" && anchor?.solved && (
					<g ref={reg("tap")} opacity={f0.tap}>
						<PenCircle
							center={anchor.solved}
							radiusX={14}
							radiusY={13}
							seed="story-tap-ring"
							color={RED}
							width={1.6 * k}
						/>
						<HandLabel
							x={anchor.solved[0]}
							y={anchor.solved[1] - 20 * k}
							anchor="middle"
							size={sz}
							color={RED}
						>
							{`tap: ${anchor.name}`}
						</HandLabel>
					</g>
				)}
			</g>

			{/* notes: hand lettering only */}
			<g data-film="notes">
				{layout.map((g, i) => (
					<g
						key={g.p.name}
						ref={regAt("names", i)}
						opacity={(f0.names[i] ?? 0) * (1 - 0.65 * f0.priorGhost)}
					>
						<HandDot
							x={g.x}
							y={g.y}
							r={3.2 * k}
							seed={`story-guess-${g.p.name}`}
							color={PRIOR_INK}
							opacity={1}
							data
						/>
						<SketchPath
							d={`M${g.x} ${g.y + 5 * k}L${g.tx} ${g.ty - 15 * k}`}
							seed={`story-guess-leader-${g.p.name}`}
							color={PRIOR_INK}
							width={1.1 * k}
						/>
						<HandLabel
							x={g.tx}
							y={g.ty}
							anchor="middle"
							size={sz}
							color={PRIOR_INK}
							caps
						>
							{g.p.name}
						</HandLabel>
					</g>
				))}
				{riders.map((p, i) => {
					const s = riderState(d, p, i, accepted, f0);
					return (
						<g
							key={p.name}
							ref={regAt("riders", i)}
							data-film="rider"
							transform={`translate(${s.x.toFixed(2)} ${s.y.toFixed(2)})`}
							opacity={s.opacity}
						>
							<HandDot
								x={0}
								y={0}
								r={3.2 * k}
								seed={`story-rider-${p.name}`}
								color={SOLVED_PEAK_INK}
								opacity={1}
							/>
							<HandLabel
								x={0}
								y={-9 * k}
								anchor="middle"
								size={sz}
								color={SOLVED_PEAK_INK}
								caps
							>
								{p.name}
							</HandLabel>
						</g>
					);
				})}
				{layout.length > 0 && (
					<g ref={reg("poseNote")} opacity={f0.poseNote}>
						<HandLabel
							x={x0 + 8 * k}
							y={y1 - 12 * k}
							size={sz - k}
							color={PRIOR_INK}
						>
							{`phone's guess: yaw ${d.prior.yaw.toFixed(1)}°, pitch ${d.prior.pitch.toFixed(1)}°`}
						</HandLabel>
					</g>
				)}
				{traced && (
					<g ref={reg("tracedNote")} opacity={f0.tracedNote}>
						<HandDot
							x={traced[0]}
							y={traced[1]}
							r={3 * k}
							seed="story-traced"
							color={LAYER_STYLE.skyline.color}
							opacity={1}
							data
						/>
						<HandLabel
							x={traced[0] + 8 * k}
							y={traced[1] - 10 * k}
							size={sz - k}
							color={INK}
						>
							traced skyline
						</HandLabel>
					</g>
				)}
				<g ref={reg("readoutPrior")} opacity={f0.readoutPrior}>
					<HandLabel
						x={x0 + 8 * k}
						y={y0 + 22 * k}
						size={sz + k}
						color={PRIOR_INK}
					>
						{`gap ${d.residual.prior.median.toFixed(1)} px (median)`}
					</HandLabel>
				</g>
				<g ref={reg("readoutSolved")} opacity={f0.readoutSolved}>
					<HandLabel
						x={x0 + 8 * k}
						y={y0 + 22 * k}
						size={sz + k}
						color={SOLVED_INK}
					>
						{`gap ${d.residual.solved.median.toFixed(1)} px`}
					</HandLabel>
				</g>
				<g ref={reg("numbers")} opacity={f0.numbers}>
					<HandLabel
						x={mx}
						y={top}
						anchor="middle"
						size={sz + 2 * k}
						color={RED}
					>
						{`${signedDegrees(d.solved.delta.yaw)} yaw`}
					</HandLabel>
					<HandLabel
						x={mx}
						y={top + 17 * k}
						anchor="middle"
						size={sz - k}
						color={RED}
					>
						{`${signedDegrees(d.solved.delta.pitch)} pitch`}
					</HandLabel>
				</g>
				<g ref={reg("verdict")} data-film="verdict" opacity={f0.verdict}>
					<HandLabel
						x={x1 - 12 * k}
						y={y1 - 12 * k}
						anchor="end"
						size={sz}
						color={accepted ? INK : RED}
					>
						{verdictText}
					</HandLabel>
					{accepted && (
						<PenCircle
							center={[x1 - 12 * k - verdictW / 2, y1 - 12 * k - sz * 0.35]}
							radiusX={verdictW / 2 + 9 * k}
							radiusY={sz * 0.95}
							seed="story-verdict-loop"
							color={RED}
							width={1.4 * k}
						/>
					)}
				</g>
			</g>
		</g>
	);
});

// --- captions and the stepper -------------------------------------------------

/** The hand caption for each beat, written from the measured JSON. */
function stepCaption(d: GipfelbuchPhotoData, id: FilmBeatId): ReactNode {
	const named = d.peaks.filter((p) => p.labelled && p.solved).length;
	const traced = d.skyline.rows.filter((r) => r != null).length;
	switch (id) {
		case "guess":
			return `The phone's guess: yaw ${d.prior.yaw.toFixed(1)}°, pitch ${d.prior.pitch.toFixed(1)}°. The terrain horizon (dashed) and the names sit where that pose puts them.`;
		case "measure":
			return `The real skyline, traced across ${traced} columns. Gap to the guess: ${d.residual.prior.median.toFixed(1)} px (median).`;
		case "correct":
			return (
				<>
					Turn{" "}
					<Struck
						correction={`${d.solved.yaw.toFixed(1)}°`}
						plain
						seed="story-yaw"
					>
						{`${d.prior.yaw.toFixed(1)}°`}
					</Struck>{" "}
					({signedDegrees(d.solved.delta.yaw)} yaw,{" "}
					{signedDegrees(d.solved.delta.pitch)} pitch): the horizon drops onto
					the skyline.
				</>
			);
		case "keep":
			return `The solve proposed ${signedDegrees(d.solved.delta.yaw)} yaw, but confidence ${d.solved.confidence.toFixed(2)} is under 0.5, so the app keeps the phone's pose and asks for a tap.`;
		default:
			return `Snapped: gap ${d.residual.solved.median.toFixed(1)} px (was ${d.residual.prior.median.toFixed(1)}); ${named} peaks named at their summits. Confidence ${d.solved.confidence.toFixed(2)}.`;
	}
}

export interface PhotoStoryProps {
	/** A demo photo; default: the one the reader picked anywhere in the Gipfelbuch. */
	photoId?: GipfelbuchPhotoId;
	number?: string;
	/** The hand Kroki title. */
	title?: string;
	/** Replaces the default caption. */
	caption?: ReactNode;
	/** Geo spill onto the margins (RealPhoto bleed); false for a plain photo. */
	bleed?: boolean | number;
	/** `crop` in working px, passed to RealPhoto. */
	crop?: [number, number, number, number];
	date?: string;
	className?: string;
	/** What the page is about: trace, gaps, snap, eye, prior, tap or search (see storyFilm.ts). */
	focus?: StoryFocus;
	/**
	 * "once" (default) plays to the result and holds; a finished film replays from 0 when the reader
	 * comes back to it, after a pointer rest on it, or on a tap. "loop" replays on its own while armed.
	 */
	playback?: "loop" | "once";
}

/**
 * "The story on the photo" as a film: guess, measure, correct, snap, written by hand on one real photo.
 * It arms when most of the figure is in view, pauses when it leaves, loops until the reader takes the
 * stepper, and shows the settled final frame under reduced motion, webdriver and print.
 */
export function PhotoStory(props: PhotoStoryProps) {
	return (
		<AlignmentStoryProvider initial={1}>
			<PhotoStoryInner {...props} />
		</AlignmentStoryProvider>
	);
}

function PhotoStoryInner({
	photoId,
	number,
	title = "From the phone's pose to the solved pose",
	caption,
	bleed = true,
	crop,
	date,
	className,
	focus,
	playback = "once",
}: PhotoStoryProps) {
	const [picked] = useNotebookPhoto();
	const id = photoId ?? picked;
	const loaded = useGipfelbuchPhoto(id);
	// keep the previous photo while the next one loads, so the figure does not collapse
	const [data, setData] = useState<GipfelbuchPhotoData | null>(null);
	useEffect(() => {
		if (loaded) setData(loaded);
	}, [loaded]);
	const bake = useTafelBake(data ? data.id : null);
	const story = useAlignmentStory();
	const storyRef = useRef(story);
	storyRef.current = story;

	// phone layout: fewer ticks
	const wrapRef = useRef<HTMLDivElement>(null);
	const [narrow, setNarrow] = useState(false);
	useEffect(() => {
		const el = wrapRef.current;
		if (!el) return;
		const measure = () =>
			setNarrow(el.getBoundingClientRect().width < NARROW_PX);
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// the script for this photo
	const geom = useMemo<Geom | null>(() => {
		if (!data) return null;
		const [x0, y0, x1, y1] = crop ?? [
			0,
			0,
			data.photo.width,
			data.photo.height,
		];
		return { x0, y0, x1, y1, k: (x1 - x0) / data.photo.width };
	}, [data, crop]);
	const guesses = useMemo(() => (data ? pickGuesses(data) : []), [data]);
	const riders = useMemo(() => guesses.filter((p) => p.solved), [guesses]);
	const anchor = useMemo(() => (data ? pickAnchor(data) : null), [data]);
	const tickCols = useMemo(
		() =>
			data && geom
				? pickTickColumns(
						data.skyline.rows,
						data.skyline.weight,
						data.priorRows,
						narrow ? TICKS_NARROW : TICKS_WIDE,
						Math.round(geom.x0),
						Math.round(geom.x1),
					)
				: [],
		[data, geom, narrow],
	);
	const layout = useMemo<GuessLayout[]>(() => {
		if (!data || !geom) return [];
		const { width: W, height: H } = data.photo;
		const size = LABEL * geom.k;
		return guesses.map((p) => {
			const [x, y] = p.prior as [number, number];
			const w = nameWidth(p.name, size);
			const tx = Math.min(W - w / 2 - 6, Math.max(w / 2 + 6, x));
			const ty = Math.min(y + 40 * geom.k, H - 10);
			return { p, x, y, tx, ty, w };
		});
	}, [data, geom, guesses]);
	const plan = useMemo(
		() =>
			filmPlan({
				accepted: data?.solved.accepted ?? true,
				focus,
				names: guesses.length,
				ticks: tickCols.length,
				pulses: riders.length,
			}),
		[data, focus, guesses, tickCols, riders],
	);
	const f0 = useMemo(() => filmFrame(plan, plan.total), [plan]);

	// the clock: a ref, no per-frame React state
	// TODO(grammar): swap to useBeatClock (viz/motion.ts) once it lands on master
	const nodes = useRef<FilmNodes>(newNodes());
	const msRef = useRef(plan.total);
	const mode = useRef({
		auto: true,
		playing: false,
		stopAt: null as number | null,
	});
	const armed = useRef(false);
	const motion = useRef(false);
	const raf = useRef(0);
	const lastNow = useRef(0);
	const committed = useRef({
		beat: plan.beats.length - 1,
		t: null as number | null,
		at: 0,
	});
	const [beat, setBeat] = useState(plan.beats.length - 1);
	const [spillT, setSpillT] = useState(1);
	const ctx = useRef<FilmCtx | null>(null);
	ctx.current =
		data && geom
			? { d: data, plan, bake, geom, layout, riders, anchor, tickCols }
			: null;
	const playbackRef = useRef(playback);
	playbackRef.current = playback;

	const frameAt = (c: FilmCtx, ms: number) =>
		mode.current.auto && playbackRef.current === "loop"
			? loopFrame(c.plan, ms)
			: filmFrame(c.plan, ms);
	const render = useRef((_force?: boolean) => {});
	render.current = (force = false) => {
		const c = ctx.current;
		if (!c) return;
		const f = frameAt(c, msRef.current);
		applyFrame(c, nodes.current, f);
		const st = committed.current;
		if (f.beat !== st.beat || force) {
			st.beat = f.beat;
			setBeat(f.beat);
		}
		const now = performance.now();
		if (force || shouldCommitT(st.t, f.t, st.at, now)) {
			st.t = f.t;
			st.at = now;
			setSpillT(f.t);
			storyRef.current?.setT(f.t, { instant: true });
		}
	};
	const start = useRef(() => {});
	start.current = () => {
		if (raf.current || !mode.current.playing || !armed.current) return;
		lastNow.current = performance.now();
		const tick = (now: number) => {
			raf.current = 0;
			const m = mode.current;
			const c = ctx.current;
			if (!m.playing || !armed.current || !c) return;
			msRef.current += Math.min(50, now - lastNow.current);
			lastNow.current = now;
			if (!m.auto || playbackRef.current === "once") {
				const stop = m.stopAt ?? c.plan.total;
				if (msRef.current >= stop) {
					msRef.current = stop;
					m.playing = false;
				}
			}
			render.current();
			if (m.playing) raf.current = requestAnimationFrame(tick);
		};
		raf.current = requestAnimationFrame(tick);
	};

	// new photo, new plan: frame 0 before paint where motion is fine, else the settled frame
	useIsomorphicLayoutEffect(() => {
		if (!ctx.current) return;
		motion.current = !revealsImmediately();
		mode.current = { auto: true, playing: motion.current, stopAt: null };
		msRef.current = motion.current ? 0 : plan.total;
		render.current(true);
		start.current();
		return () => {
			cancelAnimationFrame(raf.current);
			raf.current = 0;
		};
	}, [plan, data]);
	// the bake arriving changes how the moving line is drawn: redraw the current frame
	useIsomorphicLayoutEffect(() => {
		if (bake) render.current();
	}, [bake]);

	// a finished "once" film: auto mode, stopped on the result
	const replayOnArm = useRef(false);
	const isFinished = () => {
		const c = ctx.current;
		return (
			motion.current &&
			!!c &&
			mode.current.auto &&
			!mode.current.playing &&
			playbackRef.current === "once" &&
			msRef.current >= c.plan.total
		);
	};
	const replay = () => {
		mode.current = { auto: true, playing: true, stopAt: null };
		msRef.current = 0;
		render.current(true);
		start.current();
	};
	const clock = useRef({ isFinished, replay });
	clock.current = { isFinished, replay };
	// arm at 45 % in view (grammar ARM_SEQUENCE), pause below 20 %; a finished film replays on re-arm
	useEffect(() => {
		const el = wrapRef.current;
		if (!el || revealsImmediately()) return;
		const io = new IntersectionObserver(
			(entries) => {
				const e = entries[entries.length - 1];
				const share = viewShare(
					e.intersectionRect.height,
					e.boundingClientRect.height,
					window.innerHeight,
				);
				const was = armed.current;
				armed.current = nextArmed(was, share);
				if (was && !armed.current && clock.current.isFinished())
					replayOnArm.current = true;
				if (!armed.current) return;
				if (replayOnArm.current) {
					replayOnArm.current = false;
					clock.current.replay();
				} else start.current();
			},
			{ threshold: Array.from({ length: 21 }, (_, i) => i / 20) },
		);
		io.observe(el);
		return () => io.disconnect();
	}, []);
	// print: the settled frame, whatever was playing
	useEffect(() => {
		const before = () => {
			mode.current = { auto: false, playing: false, stopAt: null };
			msRef.current = ctx.current?.plan.total ?? 0;
			render.current(true);
		};
		const after = () => {
			if (!motion.current) return;
			mode.current = { auto: true, playing: true, stopAt: null };
			msRef.current = 0;
			render.current(true);
			start.current();
		};
		window.addEventListener("beforeprint", before);
		window.addEventListener("afterprint", after);
		return () => {
			window.removeEventListener("beforeprint", before);
			window.removeEventListener("afterprint", after);
		};
	}, []);

	// manual mode (grammar 1.6): any stepper touch ends autoplay for good
	const goBeat = (i: number) => {
		const c = ctx.current;
		if (!c) return;
		const [s, e] = beatSpan(c.plan, i);
		armed.current = true;
		if (!motion.current) {
			mode.current = { auto: false, playing: false, stopAt: null };
			msRef.current = e;
			render.current(true);
			return;
		}
		mode.current = { auto: false, playing: true, stopAt: e };
		msRef.current = s;
		render.current(true);
		start.current();
	};
	const again = () => {
		const c = ctx.current;
		if (!c) return;
		armed.current = true;
		if (!motion.current) {
			mode.current = { auto: false, playing: false, stopAt: null };
			msRef.current = c.plan.total;
			render.current(true);
			return;
		}
		replay();
	};
	// hoverReplay: a pointer at rest on the finished photo (350 ms), or a tap on it, plays it again
	const restTimer = useRef(0);
	const clearRest = () => window.clearTimeout(restTimer.current);
	const onPhotoMove = (e: PointerEvent) => {
		clearRest();
		if (e.pointerType !== "mouse" || !isFinished()) return;
		restTimer.current = window.setTimeout(() => {
			if (isFinished()) replay();
		}, HOVER_REPLAY_MS);
	};
	useEffect(() => () => window.clearTimeout(restTimer.current), []);
	const tabs = useRef<(HTMLButtonElement | null)[]>([]);
	const railRef = useRef<HTMLDivElement>(null);
	const scrubbing = useRef(false);
	const scrubTo = (clientX: number) => {
		const c = ctx.current;
		const rail = railRef.current;
		if (!c || !rail) return;
		const r = rail.getBoundingClientRect();
		mode.current = { auto: false, playing: false, stopAt: null };
		msRef.current = scrubMs(
			c.plan,
			r.width > 0 ? (clientX - r.left) / r.width : 0,
		);
		render.current();
	};

	const seed = `photo-story-${id}`;
	const defaultCaption = data
		? `${data.id}: the solved pose written on the photo. The phone's guess is struck in red.`
		: "The solved pose written on the photo.";
	const beatId = plan.beats[Math.min(beat, plan.beats.length - 1)].id;
	const lastBeat = plan.beats.length - 1;
	const cursor = data
		? spillCursorFor((t) => poseAt(data, t).yaw, beat, spillT)
		: null;
	const side = useMemo(() => ({ t: spillT }), [spillT]);
	const hair0 = hairlineScales(f0, plan.beats.length);
	return (
		<Figure
			number={number}
			caption={caption ?? defaultCaption}
			bleed
			className={className}
		>
			<div
				ref={(el) => {
					wrapRef.current = el;
					nodes.current.wrap = el;
				}}
				style={{ "--gb-spill-reveal": 1 } as CSSProperties}
			>
				<svg
					viewBox="0 0 640 56"
					className="mb-2 block h-auto w-full max-w-[640px] overflow-visible"
					aria-hidden="true"
				>
					<KrokiTitle
						x={4}
						y={26}
						title={title}
						size={22}
						date={date}
						seed={`${seed}-title`}
					/>
				</svg>
				<div className="mb-1 flex items-start gap-1.5">
					<div className="grid min-w-0 flex-1 grid-cols-2 gap-x-1.5 sm:grid-cols-4">
						{plan.beats.map((b, n) => {
							const label = beatLabel(b.id, focus);
							return (
								<button
									key={b.id}
									ref={(el) => {
										tabs.current[n] = el;
									}}
									type="button"
									onClick={() => goBeat(n)}
									onKeyDown={(e) => {
										if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
										e.preventDefault();
										const to = stepBeat(
											n,
											e.key === "ArrowLeft" ? -1 : 1,
											plan.beats.length,
										);
										goBeat(to);
										tabs.current[to]?.focus();
									}}
									aria-pressed={n === beat}
									className={cn(
										"gb-caps relative min-w-0 px-3 pt-1.5 pb-2 text-left text-[13px] leading-[16px] transition-colors motion-reduce:transition-none",
										n === beat
											? "text-[var(--gb-ink)]"
											: "text-[var(--gb-secondary,#4a545c)] hover:text-[var(--gb-ink)]",
									)}
								>
									<span className="nb-num mr-1.5 text-[var(--gb-contour,inherit)] normal-case">
										{n + 1}.
									</span>
									{label}
									{n === beat && (
										<HandLoop
											seed={`story-tab-${label}`}
											color="red"
											width={1.6}
											inset={-1}
										/>
									)}
								</button>
							);
						})}
					</div>
					<button
						type="button"
						onClick={again}
						className="nb-hand relative mt-0.5 mr-1 shrink-0 px-2 text-[18px] leading-[24px] text-[var(--gb-secondary,#4a545c)] hover:text-[var(--gb-ink)] print:hidden"
					>
						again
						<HandFrame
							seed="story-again"
							color="pencil"
							width={1.1}
							overshoot={4}
						/>
					</button>
				</div>
				{/* the hairlines: one per beat, filled by that beat's progress; drag along them to scrub */}
				<div
					ref={railRef}
					aria-hidden="true"
					className="mb-3 flex h-3 cursor-ew-resize items-center gap-x-1.5 px-3 print:hidden"
					style={{ touchAction: "pan-y" }}
					onPointerDown={(e) => {
						scrubbing.current = true;
						e.currentTarget.setPointerCapture?.(e.pointerId);
						scrubTo(e.clientX);
					}}
					onPointerMove={(e) => scrubbing.current && scrubTo(e.clientX)}
					onPointerUp={(e) => {
						scrubbing.current = false;
						e.currentTarget.releasePointerCapture?.(e.pointerId);
						render.current(true);
					}}
					onPointerCancel={() => {
						scrubbing.current = false;
					}}
				>
					{plan.beats.map((b, n) => (
						<span
							key={b.id}
							className="h-px flex-1 bg-[var(--gb-pencil,#8a8f94)]/30"
						>
							<span
								ref={(el) => {
									nodes.current.hairs[n] = el;
								}}
								className="block h-px origin-left bg-[var(--gb-red,#bf2233)]"
								style={{ transform: `scaleX(${hair0[n]})` }}
							/>
						</span>
					))}
				</div>
				{/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: a pointer nicety; the keyboard replays with the "again" button */}
				<div
					onPointerMove={onPhotoMove}
					onPointerLeave={clearRest}
					onClick={() => isFinished() && replay()}
				>
					<SpillSideContext.Provider value={side}>
						<RealPhoto
							data={data}
							layers={BEAT_LAYERS[beatId]}
							bleed={bleed}
							crop={crop}
							lines={false}
							labelInfo={beat >= lastBeat && plan.accepted}
							spillCursor={cursor}
						>
							{(d) =>
								geom && (
									<Film
										d={d}
										plan={plan}
										f0={f0}
										nodes={nodes}
										geom={geom}
										layout={layout}
										riders={riders}
										anchor={anchor}
										tickCols={tickCols}
										bake={bake}
									/>
								)
							}
						</RealPhoto>
					</SpillSideContext.Provider>
				</div>
				<p
					className="nb-hand mt-3 min-h-[2.8em] text-[19px] leading-[23px] text-[var(--gb-pencil,var(--gb-ink))]"
					aria-live="polite"
				>
					{data ? stepCaption(data, beatId) : "…"}
				</p>
			</div>
		</Figure>
	);
}
