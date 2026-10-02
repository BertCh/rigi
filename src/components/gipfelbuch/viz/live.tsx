// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	type ComponentType,
	type CSSProperties,
	lazy,
	type MutableRefObject,
	type ReactNode,
	type Ref,
	type RefObject,
	Suspense,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { SurroundBake } from "#/components/site/Surround";
import demo01Bake from "#/components/site/surround/demo-01.json";
import demo09Bake from "#/components/site/surround/demo-09.json";
import mapBake from "#/components/site/surround/map.json";
import { useNearViewport } from "#/components/site/useNearViewport";
import { cn } from "#/lib/utils";
import { KrokiTitle, NorthArrow } from "../notebook/carto";
import { PenArrow } from "../notebook/Ink";
import { type RollData, signedDegrees, useStaticJson } from "../notebook/notes";
import { SWISS } from "../swiss/inks";
import { Figure } from "./Figure";
import {
	type GipfelbuchPhotoId,
	useGipfelbuchIndex,
	useGipfelbuchPhoto,
} from "./real";

// Live plates: the landing page's real-image engines (src/components/site) bound into the notebook.
// Each figure is a dark plate (a `data-theme="dark"` island, so the engines and WorldView keep their
// dark ground) on the wide figure track, with the notebook's furniture on the paper around it: a hand
// Kroki title, a hand "Fig." caption that states the measured claim, and hand notes whose leaders
// point into the plate. Where the landing carries the terrain past the frame (Surround, LiveLines),
// the sides stay, inked contour brown for paper instead of the landing's paper white.
//
// Mounting: the site component is lazily imported and mounted only near the viewport, behind its
// poster. Under webdriver and in print every plate shows its poster (deterministic, no GPU); under
// reduced motion the animated ones do too. No CSS is imported here.

/** Contour brown for line art spilled onto the paper (LiveLines reads `--rigi-paper`). */
const CONTOUR_INK = `var(--gb-contour, ${SWISS.contour})`;
const PAPER_HALO =
	"0 0 2px var(--gb-paper, #f6f4ef), 0 0 3px var(--gb-paper, #f6f4ef), 0 0 6px var(--gb-paper, #f6f4ef)";

// ---- lazy site components ---------------------------------------------------------------------

const RevealLoop = lazy(() =>
	import("#/components/site/RevealLoop").then((m) => ({
		default: m.RevealLoop,
	})),
);
const SiteCompare = lazy(() =>
	import("#/components/site/Compare").then((m) => ({ default: m.Compare })),
);
const LiveRollMap = lazy(() =>
	import("#/components/site/LiveRollMap").then((m) => ({
		default: m.LiveRollMap,
	})),
);
const StepInsideDemo = lazy(() =>
	import("#/components/site/StepInsideDemo").then((m) => ({
		default: m.StepInsideDemo,
	})),
);
const PanoramaSection = lazy(() =>
	import("#/components/site/DemoSections").then((m) => ({
		default: m.PanoramaSection,
	})),
);
const TopoSection = lazy(() =>
	import("#/components/site/DemoSections").then((m) => ({
		default: m.TopoSection,
	})),
);
const HowItWorksScene = lazy(() =>
	import("#/components/site/how/HowItWorksScene").then((m) => ({
		default: m.HowItWorksScene,
	})),
) as ComponentType<{ className?: string; at?: number }>;

// ---- mounting gate ----------------------------------------------------------------------------

/**
 * "animated": poster under webdriver, print and reduced motion (the engines that orbit, sway or
 * sweep). "still": poster under webdriver and print only (a board or a strip that rests until used).
 * "self": the component keeps its own static state (HowItWorksScene freezes on its last beat under
 * reduced motion and webdriver), so it mounts whenever it is near.
 */
export type LiveMotion = "animated" | "still" | "self";

function postersOnly(motion: LiveMotion): boolean {
	if (typeof window === "undefined") return true;
	if (motion === "self") return typeof IntersectionObserver === "undefined";
	return (
		typeof IntersectionObserver === "undefined" ||
		!!navigator.webdriver ||
		window.matchMedia("print").matches ||
		(motion === "animated" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches)
	);
}

/** True once the plate is near the viewport and live mounting is allowed (never on the server). */
function useLiveGate(motion: LiveMotion, margin: number) {
	const { ref, near } = useNearViewport(margin);
	const [allowed, setAllowed] = useState(false);
	useEffect(() => setAllowed(!postersOnly(motion)), [motion]);
	return { ref, live: near && allowed };
}

// ---- notes with leaders -----------------------------------------------------------------------

/** A hand note beside the plate, its leader ending at `at` (fractions of the frame; may lie outside it, in the spill). */
export interface LiveNote {
	text: ReactNode;
	at: [number, number];
	/** Which gutter the note sits in (default: the side nearer `at`). */
	side?: "left" | "right";
	/** Top of the note as a fraction of the frame's height (default spread down the gutter). */
	y?: number;
}

type Box = { fl: number; ft: number; fw: number; fh: number; sw: number };

// Layout effect so the notes sit beside the plate on first paint (plain effect on the server).
const useIsomorphicLayoutEffect =
	typeof window === "undefined" ? useEffect : useLayoutEffect;

function useFrameBox(
	stage: RefObject<HTMLDivElement | null>,
	frame: RefObject<HTMLDivElement | null>,
) {
	const [box, setBox] = useState<Box | null>(null);
	useIsomorphicLayoutEffect(() => {
		const s = stage.current;
		const f = frame.current;
		if (!s || !f) return;
		const measure = () => {
			const a = s.getBoundingClientRect();
			const b = f.getBoundingClientRect();
			if (!a.width || !b.width) return;
			setBox({
				fl: b.left - a.left,
				ft: b.top - a.top,
				fw: b.width,
				fh: b.height,
				sw: a.width,
			});
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(s);
		ro.observe(f);
		return () => ro.disconnect();
	}, []);
	return box;
}

/** Smallest gutter (px) that holds a note beside the plate; below it the notes go under the plate. */
const MIN_GUTTER = 112;
const NOTE_MAX = 220;

function sideOf(note: LiveNote): "left" | "right" {
	return note.side ?? (note.at[0] < 0.5 ? "left" : "right");
}

function NoteLeaders({
	notes,
	box,
	seed,
}: {
	notes: LiveNote[];
	box: Box;
	seed: string;
}) {
	const right = box.sw - box.fl - box.fw;
	const count = { left: 0, right: 0 };
	const placed = notes.map((note, i) => {
		const side = sideOf(note);
		const k = count[side]++;
		const y = note.y ?? 0.08 + k * 0.42;
		const gutter = side === "left" ? box.fl : right;
		const width = Math.min(NOTE_MAX, gutter - 24);
		const top = box.ft + y * box.fh;
		const from: [number, number] =
			side === "left"
				? [box.fl - 10, top + 12]
				: [box.fl + box.fw + 10, top + 12];
		const to: [number, number] = [
			box.fl + note.at[0] * box.fw,
			box.ft + note.at[1] * box.fh,
		];
		return { note, i, side, width, top, from, to };
	});
	return (
		<div className="pointer-events-none absolute inset-0">
			<svg
				className="absolute inset-0 size-full overflow-visible"
				aria-hidden="true"
			>
				{placed.map(({ i, from, to, side }) => (
					<g key={i}>
						{/* a paper halo under the pencil, so the leader reads on paper and on the plate */}
						<PenArrow
							seed={`${seed}-leader-${i}`}
							from={from}
							to={to}
							bend={side === "left" ? -0.16 : 0.16}
							color="var(--gb-paper, #f6f4ef)"
							width={4}
							opacity={0.85}
						/>
						<PenArrow
							seed={`${seed}-leader-${i}`}
							from={from}
							to={to}
							bend={side === "left" ? -0.16 : 0.16}
							color="pencil"
							width={1.3}
						/>
					</g>
				))}
			</svg>
			{placed.map(({ note, i, side, width, top }) => (
				<p
					key={i}
					className="nb-hand absolute text-[19px] leading-[22px] text-[var(--gb-pencil,var(--gb-ink))]"
					style={{
						top,
						width,
						textAlign: side === "left" ? "right" : "left",
						textShadow: PAPER_HALO,
						rotate: `${side === "left" ? -1.2 : 1.2}deg`,
						...(side === "left"
							? { left: box.fl - 18 - width }
							: { left: box.fl + box.fw + 18 }),
					}}
				>
					<span className="nb-num mr-1 text-[var(--gb-red)]">{i + 1}</span>
					{note.text}
				</p>
			))}
		</div>
	);
}

/** Circled numbers on the plate where the notes point, for the stacked (narrow) layout. */
function NoteMarkers({ notes }: { notes: LiveNote[] }) {
	return (
		<div className="pointer-events-none absolute inset-0" aria-hidden="true">
			{notes.map((note, i) =>
				note.at[0] < 0 ||
				note.at[0] > 1 ||
				note.at[1] < 0 ||
				note.at[1] > 1 ? null : (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: notes are a fixed, ordered list
						key={i}
						className="nb-num absolute -translate-x-1/2 -translate-y-1/2 bg-[var(--gb-paper)] px-1 text-[13px] leading-[16px] text-[var(--gb-red)]"
						style={{
							left: `${note.at[0] * 100}%`,
							top: `${note.at[1] * 100}%`,
						}}
					>
						{i + 1}
					</span>
				),
			)}
		</div>
	);
}

// ---- the plate --------------------------------------------------------------------------------

export interface LivePlateProps {
	/** The hand Kroki title over the plate. */
	title: string;
	/** "Fig. n" lettering (Figure `number`). */
	number?: string;
	/** The hand caption: the measured claim. */
	caption?: ReactNode;
	/** 1–3 hand notes with leaders into the plate. */
	notes?: LiveNote[];
	/** Frame width / height. */
	aspect?: number;
	/** Frame width as a fraction of the wide track from 768 px (the rest is paper for spill and notes). */
	frame?: number;
	/** Shown until the live view mounts, under webdriver and print, and as the Suspense fallback. */
	poster: ReactNode;
	/** The live view; called only once the plate is near the viewport and live mounting is allowed. */
	children: () => ReactNode;
	motion?: LiveMotion;
	/** Root margin (px) for the near-viewport mount. */
	margin?: number;
	/** Paper topography behind the frame (PaperSurround), shown with the poster and the live view. */
	surround?: ReactNode;
	/** Date written under the Kroki title ("01.10.2026"). */
	date?: string;
	/** A north arrow beside the title, for a north-up plate (the topo board). */
	north?: boolean;
	/** Let the frame keep its own height (aspect ignored), e.g. the panorama strip or the board. */
	freeHeight?: boolean;
	/** False: no paper surround and no live line art past the frame (a sheet that already spills one photo). */
	spill?: boolean;
	className?: string;
}

/**
 * The wrapper every live figure uses: Figure on the wide track, a Kroki title, the dark plate (the
 * frame; its sides stay paper), the notes, and the poster/live swap. Exported for one-off plates.
 */
export function LivePlate({
	title,
	number,
	caption,
	notes = [],
	aspect = 16 / 10,
	frame = 0.62,
	poster,
	children,
	motion = "animated",
	margin = 400,
	surround,
	date,
	north = false,
	freeHeight = false,
	spill = true,
	className,
}: LivePlateProps) {
	const { ref: gateRef, live } = useLiveGate(motion, margin);
	const stageRef = useRef<HTMLDivElement>(null);
	const frameRef = useRef<HTMLDivElement>(null);
	const box = useFrameBox(stageRef, frameRef);
	const seed = `live-${title.slice(0, 24)}`;
	const right = box ? box.sw - box.fl - box.fw : 0;
	const wide =
		!!box &&
		notes.every((n) => (sideOf(n) === "left" ? box.fl : right) >= MIN_GUTTER);
	const posterBox = (
		<div
			className="relative w-full overflow-hidden bg-[var(--gb-ink,#131313)]"
			style={freeHeight ? undefined : { aspectRatio: aspect }}
		>
			{poster}
		</div>
	);
	return (
		<Figure number={number} caption={caption} bleed className={className}>
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
				{north && (
					<NorthArrow x={600} y={50} length={30} seed={`${seed}-north`} />
				)}
			</svg>
			<div
				ref={stageRef}
				className="relative py-4 [overflow-x:clip] md:py-8"
				data-gb-live-stage
			>
				<div
					ref={(el) => {
						frameRef.current = el;
						(gateRef as MutableRefObject<HTMLDivElement | null>).current = el;
					}}
					data-theme="dark"
					className={`relative isolate mx-auto w-full md:w-[var(--gb-live-frame)]${spill ? "" : " [&_canvas.-z-10]:!hidden"}`}
					style={
						{
							"--gb-live-frame": `${(frame * 100).toFixed(2)}%`,
							"--gb-live-aspect": String(aspect),
							// LiveLines inks its spill with --rigi-paper: contour brown on the sheet. The engines'
							// own boxes are dark islands again and reset it to white inside the frame.
							"--rigi-paper": CONTOUR_INK,
						} as CSSProperties
					}
					data-gb-live-plate
				>
					{spill && surround}
					{live && motion === "self" ? (
						<Suspense fallback={posterBox}>{children()}</Suspense>
					) : live ? (
						<>
							<div className="print:hidden">
								<Suspense fallback={posterBox}>{children()}</Suspense>
							</div>
							<div className="hidden print:block">{posterBox}</div>
						</>
					) : (
						posterBox
					)}
					{!wide && notes.length > 0 && <NoteMarkers notes={notes} />}
				</div>
				{wide && box && <NoteLeaders notes={notes} box={box} seed={seed} />}
			</div>
			{!wide && notes.length > 0 && (
				<ol className="mt-3 space-y-1 px-0.5">
					{notes.map((note, i) => (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: notes are a fixed, ordered list
							key={i}
							className="nb-hand text-[19px] leading-[22px] text-[var(--gb-pencil,var(--gb-ink))]"
						>
							<span className="nb-num mr-1.5 text-[var(--gb-red)]">
								{i + 1}
							</span>
							{note.text}
						</li>
					))}
				</ol>
			)}
		</Figure>
	);
}

// ---- paper surround (the landing's Surround, inked for paper) ----------------------------------

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

/**
 * The landing's baked surround (site/Surround.tsx + scripts/demo/bake-surround.ts) redrawn on paper:
 * the baked ridge strokes as a contour-brown fill through the WebP's alpha (or luminance, for a mask
 * bake), the compass ruler in hand figures and the summits beyond the frame in hand capitals with
 * italic "height · km". Lays itself around its positioned parent (the frame), behind it; md and up.
 */
export function PaperSurround({
	bake,
	layerRef,
	className,
}: {
	bake: SurroundBake;
	/** The inner layer, for a frame that pans its content (the topo board). */
	layerRef?: Ref<HTMLDivElement>;
	className?: string;
}) {
	const { photo } = bake;
	const fl = pct(photo.x * 0.6);
	const fr = pct(1 - (1 - photo.x - photo.w) * 0.6);
	const bottom = photo.y + photo.h;
	const fb = pct(bottom > 0.98 ? 0.55 : bottom);
	const vertical = bake.fixed
		? `linear-gradient(to bottom, transparent ${pct(photo.y)}, #000 ${pct(photo.y + 0.06)}, #000 ${pct(1 - (1 - photo.y - photo.h) * 0.6)}, transparent)`
		: `linear-gradient(to bottom, #000 ${fb}, transparent)`;
	const mask = `linear-gradient(to right, transparent, #000 ${fl}, #000 ${fr}, transparent), ${vertical}`;
	const box: CSSProperties = bake.fixed
		? {
				left: `calc(50% - ${bake.fixed.w / 2}px)`,
				width: bake.fixed.w,
				top: `calc(50% - ${bake.fixed.h / 2}px)`,
				height: bake.fixed.h,
			}
		: {
				left: pct(-photo.x / photo.w),
				width: pct(1 / photo.w),
				top: pct(-photo.y / photo.h),
				height: pct(1 / photo.h),
			};
	const strokeMask: CSSProperties = {
		backgroundColor: CONTOUR_INK,
		maskImage: `url(${bake.src})`,
		WebkitMaskImage: `url(${bake.src})`,
		maskSize: "100% 100%",
		WebkitMaskSize: "100% 100%",
		maskMode: bake.mask ? "luminance" : "alpha",
	};
	return (
		<div
			aria-hidden
			className={cn(
				"pointer-events-none absolute -z-10 hidden select-none md:block",
				className,
			)}
			style={{
				...box,
				maskImage: mask,
				WebkitMaskImage: mask,
				maskComposite: "intersect",
				WebkitMaskComposite: "source-in",
			}}
			data-testid="paper-surround"
		>
			<div ref={layerRef} className="absolute inset-0">
				<div
					className={cn(
						"absolute inset-0 opacity-80",
						// a browser without luminance masks would paint the whole fill: it shows nothing instead
						bake.mask && "hidden supports-[mask-mode:luminance]:block",
					)}
					style={strokeMask}
				/>
				{bake.ticks.map((t) => (
					<span
						key={t.x}
						className="absolute top-0"
						style={{ left: pct(t.x), height: pct(bake.ruler) }}
					>
						<span
							className={`absolute bottom-0 w-px bg-[var(--gb-pencil,#49423d)] ${t.label ? "h-1.5" : "h-1 opacity-60"}`}
						/>
						{t.label && (
							<span
								className={cn(
									"absolute top-0.5 -translate-x-1/2 text-[11px] leading-[12px]",
									t.label.endsWith("°")
										? "nb-num text-[var(--gb-secondary,#4a545c)]"
										: "gb-caps text-[var(--gb-red)]",
								)}
							>
								{t.label}
							</span>
						)}
					</span>
				))}
				{bake.peaks.map((p) => (
					<span
						key={p.name}
						className="absolute inset-y-0"
						style={{ left: pct(p.x) }}
					>
						<span
							className="absolute h-3.5 w-px bg-[var(--gb-pencil,#49423d)]"
							style={{ top: `calc(${pct(p.y)} - 16px)` }}
						/>
						<span
							className="absolute -ml-[2px] size-[4px] bg-[var(--gb-ink,#131313)]"
							style={{ top: `calc(${pct(p.y)} - 2px)` }}
						/>
						<span
							className="absolute left-1 leading-none whitespace-nowrap"
							style={{
								top: `calc(${pct(p.y)} - 44px)`,
								textShadow: PAPER_HALO,
							}}
						>
							<span className="gb-caps block text-[13px] leading-[14px] text-[var(--gb-ink,#131313)]">
								{p.name}
							</span>
							<span className="nb-num mt-0.5 block text-[11px] leading-[12px] text-[var(--gb-secondary,#4a545c)] italic">
								{p.ele} m · {p.km < 10 ? p.km.toFixed(1) : Math.round(p.km)} km
							</span>
						</span>
					</span>
				))}
			</div>
		</div>
	);
}

// ---- shared posters ---------------------------------------------------------------------------

function PosterImage({
	src,
	srcSet,
	alt,
	fit = "cover",
}: {
	src: string;
	srcSet?: string;
	alt: string;
	fit?: "cover" | "contain";
}) {
	return (
		<img
			src={src}
			srcSet={srcSet}
			sizes={srcSet ? "(min-width: 1024px) 760px, 100vw" : undefined}
			alt={alt}
			loading="lazy"
			decoding="async"
			className={cn(
				"absolute inset-0 size-full",
				fit === "cover" ? "object-cover" : "object-contain",
			)}
		/>
	);
}

/** The demo roll's thumbnails in a row: the poster for views that have no baked still. */
function ContactStrip({ note }: { note: string }) {
	const index = useGipfelbuchIndex();
	return (
		<div className="flex h-full min-h-[180px] flex-col justify-center gap-3 p-3">
			<div className="grid grid-cols-6 gap-1 sm:grid-cols-12">
				{(index?.photos ?? []).map((p) => (
					<img
						key={p.id}
						src={p.thumb}
						alt={p.id}
						loading="lazy"
						decoding="async"
						className="aspect-[3/4] w-full object-cover"
					/>
				))}
			</div>
			<p className="nb-hand text-center text-[18px] leading-[22px] text-white/80">
				{note}
			</p>
		</div>
	);
}

// ---- measured captions ------------------------------------------------------------------------

const ROLL_JSON = "/demo/gipfelbuch/camera-roll/roll.json";

/** "demo-01: yaw +9.3° off the phone's guess; skyline gap median 5.2 → 2.7 px; 20 peaks named." */
function usePhotoClaim(id: GipfelbuchPhotoId, lead: string): ReactNode {
	const d = useGipfelbuchPhoto(id);
	if (!d) return `${lead} …`;
	const named = d.peaks.filter((p) => p.labelled && p.solved).length;
	return `${lead} ${id}: turned ${signedDegrees(d.solved.delta.yaw)} in yaw, ${signedDegrees(d.solved.delta.pitch)} in pitch; skyline gap ${d.residual.prior.median.toFixed(1)} → ${d.residual.solved.median.toFixed(1)} px; ${named} peaks named.`;
}

function useRollClaim(): RollData | null {
	return useStaticJson<RollData>(ROLL_JSON);
}

// ---- the figures ------------------------------------------------------------------------------

const variantSet = (name: string) =>
	[640, 1024, 1440].map((w) => `/demo/w/${name}-${w}.jpg ${w}w`).join(", ");
const PLATE_SIZES = "(min-width: 1024px) 760px, calc(100vw - 48px)";

/** The landing's two photo-plus-overlay pairs (scripts/demo/make-landing-variants.sh) and their surround bakes. */
export const LIVE_REVEAL_SETS = {
	"demo-01": {
		photo: "/demo/photos/demo-01.jpg",
		overlay: "/demo/shots/demo-01-overlay.jpg",
		photoSet: variantSet("demo-01"),
		overlaySet: variantSet("demo-01-overlay"),
		bake: demo01Bake as SurroundBake,
		alt: "Contours, ridgelines and peak names drawn into a photo over Lake Thun",
	},
	"demo-09": {
		photo: "/demo/photos/demo-09.jpg",
		overlay: "/demo/shots/hero.jpg",
		photoSet: variantSet("demo-09"),
		overlaySet: variantSet("hero"),
		bake: demo09Bake as SurroundBake,
		alt: "A photo from Niederhorn with the Bernese Alps' peaks named",
	},
} as const;
export type LiveRevealId = keyof typeof LIVE_REVEAL_SETS;

type FigureProps = {
	number?: string;
	title?: string;
	/** Replaces the measured default caption. */
	caption?: ReactNode;
	/** Replaces the default notes (1–3). */
	notes?: LiveNote[];
	aspect?: number;
	frame?: number;
	date?: string;
	/** False: no spill past the frame (see LivePlate). */
	spill?: boolean;
	className?: string;
};

/**
 * The overlay export blooming out over its photo (site/RevealLoop), with the baked surround on the
 * paper. `photoId` picks one of the landing's pairs (demo-01, demo-09).
 */
export function LiveReveal({
	photoId = "demo-01",
	number,
	title = "Map data, drawn into the photo",
	caption,
	notes,
	aspect = 4 / 3,
	frame = 0.56,
	date,
	spill,
	className,
}: FigureProps & { photoId?: LiveRevealId }) {
	const set = LIVE_REVEAL_SETS[photoId];
	const claim = usePhotoClaim(
		photoId,
		"Overlay grows from foreground to skyline.",
	);
	return (
		<LivePlate
			title={title}
			number={number}
			caption={caption ?? claim}
			aspect={aspect}
			frame={frame}
			date={date}
			spill={spill}
			className={className}
			surround={<PaperSurround bake={set.bake} />}
			notes={
				notes ?? [
					{
						text: "contours and ridges from the terrain model",
						at: [0.3, 0.72],
						side: "left",
					},
					{
						text: "names stand on their summits",
						at: [0.55, 0.2],
						side: "right",
						y: 0.05,
					},
					{
						text: "past the frame: the same ridges, from terrain data",
						at: [1.18, 0.34],
						side: "right",
						y: 0.55,
					},
				]
			}
			poster={
				<PosterImage src={set.overlay} srcSet={set.overlaySet} alt={set.alt} />
			}
		>
			{() => (
				<RevealLoop
					photo={set.photo}
					overlay={set.overlay}
					photoSet={set.photoSet}
					overlaySet={set.overlaySet}
					sizes={PLATE_SIZES}
					alt={set.alt}
					aspect={aspect}
				/>
			)}
		</LivePlate>
	);
}

/** The landing hero: before/after wipe (site/Compare) with the surround on the paper. */
export function LiveCompare({
	photoId = "demo-09",
	number,
	title = "Before and after",
	caption,
	notes,
	aspect = 4 / 3,
	frame = 0.56,
	date,
	className,
}: FigureProps & { photoId?: LiveRevealId }) {
	const set = LIVE_REVEAL_SETS[photoId];
	const claim = usePhotoClaim(photoId, "Drag to compare.");
	return (
		<LivePlate
			title={title}
			number={number}
			caption={caption ?? claim}
			aspect={aspect}
			frame={frame}
			date={date}
			motion="still"
			className={className}
			surround={<PaperSurround bake={set.bake} />}
			notes={
				notes ?? [
					{ text: "as taken", at: [0.2, 0.6], side: "left" },
					{
						text: "with the solved pose drawn in",
						at: [0.8, 0.35],
						side: "right",
					},
				]
			}
			poster={
				<PosterImage src={set.overlay} srcSet={set.overlaySet} alt={set.alt} />
			}
		>
			{() => (
				<SiteCompare
					before={set.photo}
					after={set.overlay}
					beforeSet={set.photoSet}
					afterSet={set.overlaySet}
					sizes={PLATE_SIZES}
					alt={set.alt}
					aspect={aspect}
				/>
			)}
		</LivePlate>
	);
}

/** The sample roll draped on live 3D terrain (site/LiveRollMap), its contour sides inked brown. */
export function LiveDrape({
	number,
	title = "Photos draped on the terrain",
	caption,
	notes,
	aspect = 16 / 10,
	frame = 0.6,
	date,
	spill,
	className,
}: FigureProps) {
	const roll = useRollClaim();
	const claim = roll
		? `${roll.rows.length} photos draped on the terrain, live in this tab. Drag to orbit; click a pin to enter its photo.`
		: "The photos draped on the terrain, live.";
	return (
		<LivePlate
			title={title}
			number={number}
			caption={caption ?? claim}
			aspect={aspect}
			frame={frame}
			date={date}
			spill={spill}
			className={className}
			notes={
				notes ?? [
					{
						text: "a pin is a solved camera; click to enter it",
						at: [0.5, 0.5],
						side: "left",
					},
					{
						text: "contours follow the same camera",
						at: [1.15, 0.5],
						side: "right",
					},
				]
			}
			poster={
				<PosterImage
					src="/demo/shots/drape.jpg"
					alt="Photos draped on the 3D terrain"
				/>
			}
		>
			{() => (
				<LiveRollMap
					poster="/demo/shots/drape.jpg"
					className="aspect-[var(--gb-live-aspect)] w-full"
				/>
			)}
		</LivePlate>
	);
}

/**
 * The baked near field of IMG_7086 (scripts/demo/bake-step.mjs, public/demo/step/scene.json):
 * counts are copied from that bake. Re-bake → update.
 */
const STEP_BAKE = { splats: 17835, anchorPoints: 3139, inliers: 0.61 };

/** Step inside one photo (site/StepInsideDemo): splats + Google 3D tiles, its ridgeline sides inked brown. */
export function LiveStepInside({
	number,
	title = "Walking into the photo",
	caption,
	notes,
	aspect = 16 / 9,
	frame = 0.6,
	date,
	className,
}: FigureProps) {
	return (
		<LivePlate
			title={title}
			number={number}
			caption={
				caption ??
				`Nearby ground rebuilt from the photo (${STEP_BAKE.splats.toLocaleString("en")} splats), anchored to the terrain; Google 3D tiles fill the distance.`
			}
			aspect={aspect}
			frame={frame}
			date={date}
			className={className}
			notes={
				notes ?? [
					{
						text: "hiker, hut and pylon rebuilt in 3D",
						at: [0.42, 0.62],
						side: "left",
					},
					{
						text: "the photo's ridgelines, same camera",
						at: [1.15, 0.3],
						side: "right",
					},
				]
			}
			poster={
				<PosterImage
					src="/demo/step/photo.jpg"
					alt="A hiker on Niederhorn above Lake Thun, the Bernese Alps behind"
					fit="contain"
				/>
			}
		>
			{() => (
				<StepInsideDemo className="aspect-[var(--gb-live-aspect)] w-full" />
			)}
		</LivePlate>
	);
}

/** The roll's panorama (site/DemoSections PanoramaSection): one viewpoint, photos at their solved azimuths. */
export function LivePanorama({
	number,
	title = "One viewpoint, all its photos",
	caption,
	notes,
	date,
	className,
}: Omit<FigureProps, "aspect" | "frame">) {
	const roll = useRollClaim();
	const claim = roll
		? `${roll.rows.length} photos from within ${roll.viewpointRadiusM} m, each placed at its solved direction; the gaps are rendered terrain.`
		: "The photos placed at their solved directions.";
	return (
		<LivePlate
			title={title}
			number={number}
			caption={caption ?? claim}
			frame={1}
			freeHeight
			motion="still"
			date={date}
			className={className}
			notes={
				notes ?? [
					{
						text: "grey between photos: the terrain's own horizon",
						at: [0.5, 0.5],
						side: "left",
					},
				]
			}
			poster={<ContactStrip note="the strip renders live in your browser" />}
		>
			{() => <PanoramaSection />}
		</LivePlate>
	);
}

/** The photos on swisstopo's map (site/TopoBoard), with the baked plan around the board on paper. */
export function LiveTopoBoard({
	number,
	title = "Where each photo was taken",
	caption,
	notes,
	date,
	className,
}: Omit<FigureProps, "aspect" | "frame">) {
	const roll = useRollClaim();
	const layer = useRef<HTMLDivElement>(null);
	const pan = (p: { x: number; y: number }) => {
		if (layer.current)
			layer.current.style.transform = `translate(${p.x}px, ${p.y}px)`;
	};
	const claim = roll
		? `${roll.rows.length} photos at their GPS positions on the swisstopo map; each wedge is the solved direction. Click to open.`
		: "Photo positions; each wedge is the solved direction.";
	return (
		<LivePlate
			title={title}
			number={number}
			caption={caption ?? claim}
			frame={0.72}
			freeHeight
			motion="still"
			north
			date={date}
			className={className}
			surround={
				<PaperSurround bake={mapBake as SurroundBake} layerRef={layer} />
			}
			notes={
				notes ?? [
					{
						text: "wedge = solved direction, not the compass",
						at: [0.45, 0.45],
						side: "left",
					},
				]
			}
			poster={<ContactStrip note="map loads when in view" />}
		>
			{() => <TopoSection onPan={pan} />}
		</LivePlate>
	);
}

/** The landing's six-beat method scene (site/how/HowItWorksScene) on a plate; static under reduced motion and webdriver. */
export function LiveHowItWorks({
	number,
	title = "Guess, measure, correct, snap",
	caption = "Six steps of one real solve. Drag the terrain line once it has snapped.",
	notes,
	date,
	className,
}: Omit<FigureProps, "aspect" | "frame">) {
	return (
		<LivePlate
			title={title}
			number={number}
			caption={caption}
			frame={0.82}
			freeHeight
			motion="self"
			margin={600}
			date={date}
			className={className}
			notes={notes ?? []}
			poster={<div className="aspect-[16/11] w-full" />}
		>
			{() => <HowItWorksScene className="p-2 sm:p-3" />}
		</LivePlate>
	);
}
