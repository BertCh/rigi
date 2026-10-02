// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { cn } from "#/lib/utils";
import { HandDot, SketchPath } from "../notebook/Ink";
import { sketchify } from "../notebook/sketchify";
import { IMHOF_SHADING_STOPS, ImhofRampFilter } from "../swiss/imhof";
import { TYPE } from "../swiss/type";
import { useTafelBake } from "../tafel/useTafelBake";
import type { FigureImprint } from "./Figure";
import { FigureSkeleton } from "./FigureSkeleton";
import { GeoSpill, RULER_BAND, type SpillCursor } from "./GeoSpill";
import { HandStrike } from "./hand";
import { dashFor, inkFor, LAYER_STYLE, type PhotoLayer } from "./inks";
import { HandLabel } from "./labels";
import { SpillSideContext, useAlignmentStory } from "./story";

// Measured data for gipfelbuch pages: the real CPU pipeline run on the bundled Niederhorn demo photos by
// scripts/gipfelbuch/build-data.ts → public/demo/gipfelbuch/*. Pages render these instead of synthetic stand-ins.

export const GIPFELBUCH_PHOTO_IDS = [
	"demo-01",
	"demo-02",
	"demo-03",
	"demo-04",
	"demo-05",
	"demo-06",
	"demo-07",
	"demo-08",
	"demo-09",
	"demo-10",
	"demo-11",
	"demo-12",
] as const;
export type GipfelbuchPhotoId = (typeof GIPFELBUCH_PHOTO_IDS)[number];

type Rows = (number | null)[];
type Cam = {
	yaw: number;
	pitch: number;
	roll: number;
	f: number;
	hfov: number;
	vfov: number;
};
type Residual = { n: number; median: number; p90: number; within5: number };

export interface GipfelbuchPeak {
	name: string;
	ele: number | null;
	/** Height used: max(DEM local max, OSM ele), m. */
	dem: number;
	az: number;
	/** Apparent elevation angle incl. curvature + refraction, deg. */
	el: number;
	distance: number;
	/** Not hidden by nearer terrain (viewPeaks). */
	visible: boolean;
	/** Picked by layoutPeakLabels at the solved pose. */
	labelled: boolean;
	/** [x, y] in working px at the solved / prior pose, null when out of frame. */
	solved: [number, number] | null;
	prior: [number, number] | null;
}

export interface GipfelbuchPhotoData {
	id: GipfelbuchPhotoId;
	generated: string;
	script: string;
	dem: string;
	/** `width`/`height` are the working size (800 px wide) every px value below refers to. */
	photo: {
		src: string;
		thumb: string;
		width: number;
		height: number;
		fullWidth: number;
		fullHeight: number;
		takenAt: string;
		holding: string;
	};
	gps: {
		lat: number;
		lon: number;
		alt: number;
		hAccuracy: number;
		ground: number;
		eye: number;
	};
	/** Raw phone sensors: compass heading, gravity pitch/roll, 35 mm focal. */
	sensor: {
		heading: number;
		pitch: number;
		roll: number;
		f35: number;
		vfov: number;
	};
	prior: Cam;
	solved: Cam & {
		stage: "solve" | "refine";
		accepted: boolean;
		confidence: number;
		rejectReason: string | null;
		residualPx: number;
		inlierFraction: number;
		coverage: number;
		ambiguity: number;
		horizonRelief: number;
		search: "local" | "full";
		delta: { yaw: number; pitch: number; roll: number; focal: number };
	};
	/** The pose the live app saved for this photo (manifest.json). */
	app: {
		yaw: number;
		pitch: number;
		roll: number;
		vfov: number;
		source: string;
		confidence: number;
	} | null;
	/** detectSkyline: boundary row per column (null = no boundary) and 0..1 confidence. */
	skyline: { rows: Rows; weight: number[] };
	/** DEM skyline projected at the prior / solved camera, row per column. */
	priorRows: Rows;
	solvedRows: Rows;
	/** |detected − DEM| px over confident columns. */
	residual: { prior: Residual; solved: Residual };
	/** 360° horizon across the view: azimuth, skyline elevation angle (deg), distance (m), ridge crests [el, d]. */
	horizon: {
		step: number;
		profile: {
			az: number;
			el: number;
			d: number;
			ridges: [number, number][];
		}[];
	};
	peaks: GipfelbuchPeak[];
	/** Ground height along the solved view axis: [distance m, height m]. */
	terrainProfile: { azimuth: number; points: [number, number][] };
	/** Hillshade centred on the camera, north up, ±halfKm. */
	demPatch: {
		src: string;
		halfKm: number;
		px: number;
		min: number;
		max: number;
	};
	/** Grey sky-probability image at half the working size. */
	skyImage: string | null;
	ms: { terrain: number; horizon: number; skyline: number; solve: number };
}

export interface GipfelbuchIndex {
	generated: string;
	script: string;
	place: string;
	photos: {
		id: GipfelbuchPhotoId;
		thumb: string;
		accepted: boolean;
		stage: string;
		confidence: number;
		delta: GipfelbuchPhotoData["solved"]["delta"];
		residual: GipfelbuchPhotoData["residual"];
		peaks: number;
		labelled: string[];
		ms: GipfelbuchPhotoData["ms"];
	}[];
	/** out/eval*\/report.json rows (19 IMG_xxxx photos; 14 have a ground-truth error in data/ground-truth.json). */
	groundTruthEval: { solve: unknown[] | null; cascade: unknown[] | null };
}

const cache = new Map<string, Promise<unknown>>();
/** Values already fetched, so a revisit renders at once instead of through a loading frame. */
const loaded = new Map<string, unknown>();
/** URLs whose last fetch failed: the figure shows a hand note instead of a skeleton forever. */
const failed = new Set<string>();
const failedListeners = new Set<() => void>();
let failedVersion = 0;
const markFailed = (url: string, isFailed: boolean) => {
	if (failed.has(url) === isFailed) return;
	if (isFailed) failed.add(url);
	else failed.delete(url);
	failedVersion++;
	for (const listener of failedListeners) listener();
};
function load<T>(url: string): Promise<T> {
	let p = cache.get(url);
	if (!p) {
		markFailed(url, false);
		p = fetch(url).then((r) => {
			if (!r.ok) throw new Error(`${url}: ${r.status}`);
			return r.json();
		});
		p.then(
			(v) => loaded.set(url, v),
			() => {
				cache.delete(url);
				markFailed(url, true);
			},
		);
		cache.set(url, p);
	}
	return p as Promise<T>;
}

/** Marks a data object that is the previous photo's, kept on screen while the next one loads. */
const STALE = Symbol("gipfelbuch.stale");
/** True while `data` is the previous photo's, shown dimmed until the requested one arrives. */
export const isStaleData = (data: object | null | undefined): boolean =>
	!!data && (data as { [STALE]?: boolean })[STALE] === true;

/**
 * Fetches `url`. While a new url loads, the previous value stays (marked stale, see `isStaleData`) so a
 * picker does not blank the figure and jump the page's height; null only before the first load.
 */
function useJson<T extends object>(url: string | null): T | null {
	const [state, setState] = useState<{ url: string | null; data: T | null }>({
		url: null,
		data: null,
	});
	useEffect(() => {
		if (!url) return;
		let live = true;
		load<T>(url).then(
			(v) => live && setState({ url, data: v }),
			(e) => console.warn("[gipfelbuch]", e),
		);
		return () => {
			live = false;
		};
	}, [url]);
	const previous = state.data;
	const stale = useMemo(
		() =>
			previous
				? (Object.defineProperty({ ...previous }, STALE, {
						value: true,
					}) as T)
				: null,
		[previous],
	);
	if (!url) return null;
	const ready = loaded.get(url) as T | undefined;
	if (ready) return ready;
	return state.url === url ? state.data : stale;
}

const subscribeFailed = (listener: () => void) => {
	failedListeners.add(listener);
	return () => {
		failedListeners.delete(listener);
	};
};
/** The photo id whose data failed to load (the one named by `id`, else any), or null. */
export function useLoadFailure(id?: string): string | null {
	useSyncExternalStore(
		subscribeFailed,
		() => failedVersion,
		() => 0,
	);
	const prefix = "/demo/gipfelbuch/";
	if (id) return failed.has(`${prefix}${id}.json`) ? id : null;
	for (const url of failed)
		if (url.startsWith(prefix))
			return url.slice(prefix.length).replace(/\.json$/, "");
	return null;
}

/** Measured pipeline data for one demo photo (null while loading). */
export const useGipfelbuchPhoto = (id: GipfelbuchPhotoId | null) =>
	useJson<GipfelbuchPhotoData>(id && `/demo/gipfelbuch/${id}.json`);
/** Per-photo summary of all 12 + ground-truth eval rows. */
export const useGipfelbuchIndex = () =>
	useJson<GipfelbuchIndex>("/demo/gipfelbuch/index.json");

/** SVG path through a row-per-column array; breaks at nulls and at jumps larger than `maxJump` px. */
export function rowsPath(rows: Rows, maxJump = 12, sx = 1, sy = 1) {
	let d = "";
	let prev: number | null = null;
	for (let x = 0; x < rows.length; x++) {
		const y = rows[x];
		if (y == null) {
			prev = null;
			continue;
		}
		d += `${prev == null || Math.abs(y - prev) > maxJump ? "M" : "L"}${((x + 0.5) * sx).toFixed(1)} ${(y * sy).toFixed(1)}`;
		prev = y;
	}
	return d;
}

export { LAYER_STYLE, type PhotoLayer };

/** Hand block capitals (peak and place names) and hand figures (values), per the hand pass. */
const CAPS_STACK = "var(--gb-font-caps), var(--gb-font-hand), cursive";
const FIGURE_STACK = "var(--gb-font-figure), var(--gb-font-hand), cursive";
/** A measured line on a photo: one pen pass whose sideways jitter stays within this many px (Ink DATA_TOLERANCE). */
const PHOTO_PEN_TOLERANCE = 0.5;
/** Halo behind labels and strokes drawn on photos (Heim/Imfeld panorama style: dark name, paper halo). */
const HALO = "var(--gb-paper, #ece6da)";
/** Dark under-stroke for anything drawn on a photograph. */
const PHOTO_DARK = "rgba(12, 14, 18, 0.85)";
/** Lettering ink on a photo (over the paper halo). */
const PHOTO_INK = "var(--gb-ink, #131313)";

/**
 * KR6 + hand pass: a measured line drawn over a photograph, in the triple (paper halo at 0.55, a thin dark
 * under-stroke on the exact path, then the colour as one hand pen pass within 0.5 px of the data, so it
 * stays on the measured pixels and inside the dark under-stroke). `d` in the photo's own px.
 */
export function CrispLine({
	d,
	color,
	width = 2.2,
	dash,
	opacity,
	seed = "crisp",
}: {
	d: string;
	color: string;
	width?: number;
	dash?: string;
	opacity?: number;
	/** Stable key for the pen's jitter (default shared); give animated lines a fixed seed. */
	seed?: string;
}) {
	return (
		<PhotoLine
			d={d}
			seed={seed}
			color={color}
			width={width}
			halo={width + 4}
			dash={dash}
			opacity={opacity}
			crisp
		/>
	);
}

/**
 * A measured line over a photo or raster: a plain paper halo under a hand-drawn stroke. The stroke stays
 * within PHOTO_PEN_TOLERANCE px of the data, so it still sits on the measured pixels.
 */
function PhotoLine({
	d,
	seed,
	color,
	width,
	halo,
	dash,
	opacity,
	crisp = false,
}: {
	d: string;
	seed: string;
	color: string;
	width: number;
	halo: number;
	dash?: string;
	opacity?: number;
	/** On a photograph: a paper halo and a thin dark under-stroke on the exact path, the pen pass on top. */
	crisp?: boolean;
}) {
	// The colour stroke is a single hand pen pass within PHOTO_PEN_TOLERANCE (memoised: a story only
	// changes the opacity, so a long skyline is not redrawn per frame).
	const pen = useMemo(
		() =>
			crisp
				? sketchify(d, seed, {
						tolerance: PHOTO_PEN_TOLERANCE,
						passes: 1,
						// no overshoot: the pen ends where the measurement ends, inside the dark under-stroke
						overshoot: 0,
					})[0] || d
				: d,
		[crisp, d, seed],
	);
	if (crisp)
		return (
			<g fill="none" strokeLinecap="round" strokeLinejoin="round">
				<path
					d={d}
					style={{ stroke: HALO }}
					strokeOpacity={0.55}
					strokeWidth={Math.max(halo, width + 4)}
				/>
				<path
					d={d}
					style={{ stroke: PHOTO_DARK }}
					strokeWidth={width + 1.4}
					strokeDasharray={dash}
				/>
				<path
					d={pen}
					style={{ stroke: color }}
					strokeWidth={width}
					strokeDasharray={dash}
					opacity={opacity}
				/>
			</g>
		);
	return (
		<g>
			<path
				d={d}
				fill="none"
				stroke={HALO}
				strokeOpacity={0.7}
				strokeWidth={halo}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<SketchPath
				d={d}
				seed={seed}
				color={color}
				width={width}
				dash={dash}
				opacity={opacity}
				tolerance={PHOTO_PEN_TOLERANCE}
				passes={1}
			/>
		</g>
	);
}

/**
 * A real demo photo with measured overlays in its own pixel frame (working size, 800 px wide). `layers` are
 * drawn in order; `toggles` adds chips that switch layers on/off. `crop` = [x0, y0, x1, y1] in working px
 * zooms to a region (e.g. the skyline band, or to keep people out of frame). `children(d)` draws extra SVG
 * in the same pixel frame. Peak labels are staggered on up to three rows so they don't collide.
 */
/** Siegfried imprint (F2) of a figure drawn from one demo photo's measured data. */
export function imprintFor(
	data: GipfelbuchPhotoData,
	kind: "photo" | "dem",
): FigureImprint {
	return kind === "photo"
		? {
				aufnahme: `${data.id}${data.photo.takenAt ? `, ${data.photo.takenAt.slice(0, 10)}` : ""}`,
			}
		: {
				aufnahme: `${data.dem} terrain, ${2 * data.demPatch.halfKm} km`,
			};
}

function ImprintLine({ imprint }: { imprint: FigureImprint }) {
	return (
		<p className={`${TYPE.micro} gb-secondary mt-1.5`}>
			{imprint.aufnahme && `Aufnahme ${imprint.aufnahme}`}
		</p>
	);
}

// KR9: off by default; the figure caption carries provenance once (Measured / Figure imprint).
const ImprintContext = createContext(false);

/** Galleries, Trios, Stages and Compare wrap their tiles in this: tiles drop the Aufnahme line (R6). */
export function NoImprint({ children }: { children: ReactNode }) {
	return (
		<ImprintContext.Provider value={false}>{children}</ImprintContext.Provider>
	);
}

export function RealPhoto({
	data,
	layers,
	toggles,
	crop,
	maxLabels = 10,
	labelInfo = false,
	imprint: imprintProp,
	bleed,
	spillCursor,
	spillT,
	aspect,
	id,
	alsoNames = true,
	lines = true,
	className,
	children,
}: {
	data: GipfelbuchPhotoData | null;
	layers: PhotoLayer[];
	toggles?: PhotoLayer[];
	crop?: [number, number, number, number];
	maxLabels?: number;
	/** Show "height · distance" under each solved peak name. */
	labelInfo?: boolean;
	/** One micro provenance line under the photo (Aufnahme / Revision / Stich); false hides it. */
	imprint?: boolean;
	/**
	 * Geo bleed, as on the landing page: the photo keeps its full width and its measured world runs
	 * out past the figure onto the sheet's margins (the Tafel bake's ridge strokes, a hand compass
	 * ruler over the top and the summits beyond the frame), fading out towards the sheet's edge. A
	 * number caps the spill per side as a fraction of the photo's width (true = 0.5, the bake's
	 * extent). Use on one big photo per figure, never inside a Trio or Gallery. In a Compare give both
	 * sides the same `bleed`: the bottom side draws the spill at the wipe's position, the top side none.
	 */
	bleed?: boolean | number;
	/**
	 * Where the figure points (a sweep's column, a ray's azimuth): marked on the spill's compass ruler
	 * and, past the frame, dropped to the horizon. Needs `bleed`.
	 */
	spillCursor?: SpillCursor | null;
	/**
	 * The spill's pose, 0 = the phone's guess .. 1 = solved, for a figure that steps through poses
	 * without an alignment story; by default it follows the story, a Compare or the layers shown.
	 */
	spillT?: number;
	/** Width / height of the loading skeleton (default 4/3), so the figure does not jump when the photo arrives. */
	aspect?: number;
	/** The photo id being loaded, so a failed fetch names it (otherwise any failed gipfelbuch photo counts). */
	id?: string;
	/** Under the photo, list the summits whose names fit no row ("also: 1 Name · 2 Name"); default on. */
	alsoNames?: boolean;
	/**
	 * Draw the in-photo prior / solved / skyline / weight strokes (default). false leaves them to the
	 * caller's `children` (a story that wipes its own `CrispLine`s in), while `layers` still drive the
	 * spill's echo and its pose; peak marks are drawn either way.
	 */
	lines?: boolean;
	className?: string;
	children?: (d: GipfelbuchPhotoData) => ReactNode;
}) {
	const imprintDefault = useContext(ImprintContext);
	const imprint = imprintProp ?? imprintDefault;
	const story = useAlignmentStory();
	const [off, setOff] = useState<Set<PhotoLayer>>(new Set());
	const clipId = `gipfelbuch-clip-${useId().replace(/:/g, "")}`;
	const side = useContext(SpillSideContext);
	const hostRef = useRef<HTMLDivElement>(null);
	const bleedFraction = bleed === true ? 0.5 : bleed || 0;
	const bake = useTafelBake(
		bleedFraction > 0 && data && !side?.off ? data.id : null,
	);
	const failedId = useLoadFailure(id);
	if (!data)
		return (
			<FigureSkeleton
				aspect={aspect ?? 4 / 3}
				failedId={failedId}
				className={className}
			/>
		);
	const { width: W, height: H } = data.photo;
	const [x0, y0, x1, y1] = crop ?? [0, 0, W, H];
	const k = (x1 - x0) / W; // < 1 when zoomed: keeps strokes and text a constant on-screen size
	const on = (l: PhotoLayer) => layers.includes(l) && !off.has(l);
	const drawLine = (l: PhotoLayer) => lines && on(l);
	// the pose the bleed is drawn at: the guess when only the guess is shown, else the story's or solved
	const showsPrior = on("prior") || on("priorPeaks");
	const showsSolved = on("solved") || on("peaks");
	const bleedT =
		side?.t ??
		spillT ??
		(showsPrior && !showsSolved
			? 0
			: showsSolved && !showsPrior
				? 1
				: (story?.t ?? 1));
	// with both lines on in a story, the story's end of the correction is the one inked
	const lineOpacity = (l: "prior" | "solved" | "skyline") =>
		!story || l === "skyline" || !(on("prior") && on("solved"))
			? undefined
			: 0.3 + 0.7 * (l === "solved" ? story.t : 1 - story.t);
	const inCrop = (q: [number, number] | null) =>
		!!q && q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1;
	const solvedLabels = data.peaks
		.filter((p) => p.labelled && inCrop(p.solved))
		.slice(0, maxLabels);
	const priorLabels = data.peaks
		.filter((p) => p.labelled && inCrop(p.prior))
		.slice(0, maxLabels);
	const ws = data.skyline.weight;
	const view = [x0, y0, x1 - x0, y1 - y0];
	const stale = isStaleData(data);
	// KR8 label layout, shared with the footnote under the photo: dropped summits are numbered
	const layoutBox = { k, left: x0, right: x1 };
	const solvedLayout = layoutPeakLabels(
		solvedLabels.map((p) => ({
			name: p.name,
			at: p.solved as [number, number],
			sub: labelInfo
				? `${p.dem} m · ${(p.distance / 1000).toFixed(0)} km`
				: undefined,
		})),
		layoutBox,
	);
	const priorLayout = layoutPeakLabels(
		priorLabels.map((p) => ({
			name: p.name,
			at: p.prior as [number, number],
		})),
		layoutBox,
		// the solved layer owns the footnote when both show
		on("peaks") ? 0 : 1,
	);
	const droppedNames = [
		...(on("peaks") ? solvedLayout : []),
		...(on("priorPeaks") && !on("peaks") ? priorLayout : []),
	].filter((l) => l.note != null);
	return (
		<div
			className={cn(
				"transition-opacity duration-300 motion-reduce:transition-none",
				stale && "opacity-[0.55]",
				className,
			)}
			aria-busy={stale || undefined}
		>
			<div
				ref={hostRef}
				className="relative isolate"
				style={bleedFraction > 0 ? { marginTop: RULER_BAND } : undefined}
			>
				{bleedFraction > 0 && !side?.off && (
					<GeoSpill
						hostRef={hostRef}
						data={data}
						bake={bake}
						frame={[x0, y0, x1, y1]}
						maxSpill={bleedFraction}
						t={bleedT}
						immediate={side?.t != null}
						echo={{
							layers: layers.filter((l) => !off.has(l)),
							opacity: {
								prior: lineOpacity("prior"),
								solved: lineOpacity("solved"),
							},
						}}
						cursor={spillCursor}
					/>
				)}
				<svg
					viewBox={view.join(" ")}
					className="block h-auto w-full overflow-hidden"
					role="img"
					aria-label={`${data.id} with measured overlays`}
				>
					<defs>
						<clipPath id={clipId}>
							<rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} />
						</clipPath>
					</defs>
					<g clipPath={`url(#${clipId})`}>
						<image
							href={data.photo.src}
							width={W}
							height={H}
							preserveAspectRatio="none"
						/>
						{on("sky") && data.skyImage && (
							<image
								href={data.skyImage}
								width={W}
								height={H}
								preserveAspectRatio="none"
								opacity={0.7}
								style={{ mixBlendMode: "screen" }}
							/>
						)}
						<g fill="none" strokeLinecap="round" strokeLinejoin="round">
							{(["prior", "solved", "skyline"] as const).map(
								(l) =>
									drawLine(l) && (
										<PhotoLine
											key={l}
											d={rowsPath(
												l === "skyline"
													? data.skyline.rows
													: l === "prior"
														? data.priorRows
														: data.solvedRows,
												l === "skyline" ? 8 : 12,
											)}
											seed={`${data.id}-${l}`}
											color={inkFor(l, "photo")}
											width={(l === "skyline" ? 1.7 : 2.2) * k}
											halo={(l === "skyline" ? 4 : 4.6) * k}
											dash={dashFor(l, k)}
											opacity={lineOpacity(l)}
											crisp
										/>
									),
							)}
							{drawLine("weight") &&
								data.skyline.rows.map((y, x) =>
									y == null || x % Math.max(1, Math.round(4 * k)) ? null : (
										<line
											// biome-ignore lint/suspicious/noArrayIndexKey: the index is the image column
											key={x}
											x1={x + 0.5}
											x2={x + 0.5}
											y1={y}
											y2={y - (4 + 26 * ws[x]) * k}
											stroke={LAYER_STYLE.weight.color}
											strokeWidth={2.4 * k}
											opacity={0.25 + 0.75 * ws[x]}
										/>
									),
								)}
						</g>
						{on("priorPeaks") && (
							<PeakLabels
								placed={priorLayout}
								color={inkFor("priorPeaks", "photo")}
								k={k}
								top={y0}
							/>
						)}
						{on("peaks") && (
							<PeakLabels
								placed={solvedLayout}
								color={inkFor("peaks", "photo")}
								k={k}
								top={y0}
							/>
						)}
						{children?.(data)}
					</g>
				</svg>
			</div>
			{alsoNames && droppedNames.length > 0 && (
				<p className="nb-hand mt-1.5 text-[17px] leading-[21px] text-[var(--gb-secondary,#4a545c)]">
					also:{" "}
					{droppedNames.map((l, i) => (
						<span key={l.item.name}>
							{i > 0 && " · "}
							<span className="nb-num">{l.note}</span> {l.item.name}
						</span>
					))}
				</p>
			)}
			{imprint && <ImprintLine imprint={imprintFor(data, "photo")} />}
			{toggles && toggles.length > 0 && (
				<div className="mt-3 flex flex-wrap gap-1.5">
					{toggles.map((l) => (
						<button
							key={l}
							type="button"
							onClick={() =>
								setOff((s) => {
									const n = new Set(s);
									n.has(l) ? n.delete(l) : n.add(l);
									return n;
								})
							}
							aria-pressed={!off.has(l)}
							className={cn(
								"gb-caps inline-flex items-center gap-1.5 px-2 py-1 text-[13px] leading-[16px] transition-colors motion-reduce:transition-none",
								off.has(l)
									? "text-[var(--gb-secondary,#4a545c)]"
									: "text-[var(--gb-ink)]",
							)}
						>
							<svg
								viewBox="0 0 10 10"
								className="size-2.5 shrink-0"
								aria-hidden="true"
							>
								<HandDot
									x={5}
									y={5}
									r={3.8}
									seed={`toggle-${l}`}
									color={inkFor(l, "photo")}
									opacity={off.has(l) ? 0.3 : 1}
								/>
							</svg>
							<span className="relative">
								{LAYER_STYLE[l].label}
								{off.has(l) && (
									<HandStrike seed={`toggle-${l}`} color="red" width={1.3} />
								)}
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

export interface PeakLabelItem {
	name: string;
	at: [number, number];
	sub?: string;
}
export interface PlacedPeakLabel {
	item: PeakLabelItem;
	anchor: "start" | "middle" | "end";
	/** Row 0-2 the name sits on, or -1 when it fitted none (dot only). */
	row: number;
	/** Footnote number of a dropped summit (1-based, in priority order); undefined when named. */
	note?: number;
}

/**
 * KR8: place names in priority order (the data's ranking) on up to three rows. A label's box is its real
 * extent for its anchor plus the leader stub; a summit whose name fits no row keeps its dot, loses the
 * name and gets the next footnote number (from `firstNote`; 0 gives no numbers), so two close summits
 * never overprint and the name is still on the sheet. Pure; `k` scales px to the photo's crop.
 */
export function layoutPeakLabels(
	items: PeakLabelItem[],
	box: { k: number; left: number; right: number },
	firstNote = 1,
): PlacedPeakLabel[] {
	const { k, left, right } = box;
	const fs = 14 * k;
	const rows: [number, number][][] = [[], [], []];
	let next = firstNote;
	return items.map((it) => {
		// hand block capitals with 0.08 em tracking run wider than the old condensed face
		const w = it.name.length * fs * 0.7 + 8 * k;
		const anchor: "start" | "middle" | "end" =
			it.at[0] + w / 2 > right
				? "end"
				: it.at[0] - w / 2 < left
					? "start"
					: "middle";
		const x0 =
			anchor === "start"
				? it.at[0] - 4 * k
				: anchor === "end"
					? it.at[0] - w
					: it.at[0] - w / 2;
		const span: [number, number] = [x0, x0 + w];
		const row = rows.findIndex((r) =>
			r.every(([a0, a1]) => span[1] < a0 || span[0] > a1),
		);
		if (row >= 0) rows[row].push(span);
		return {
			item: it,
			anchor,
			row,
			note: row < 0 && firstNote > 0 ? next++ : undefined,
		};
	});
}

/** Peak marks with leaders; names staggered over three rows by x so neighbours don't overlap. */
function PeakLabels({
	placed,
	color,
	k,
	top,
}: {
	placed: PlacedPeakLabel[];
	color: string;
	k: number;
	top: number;
}) {
	const fs = 14 * k;
	const rowH = (placed.some((p) => p.item.sub) ? 26 : 15) * k;
	return (
		<g>
			{placed.map(({ item: it, anchor, row, note }) => {
				if (row < 0)
					return (
						<g key={it.name}>
							<title>{it.name}</title>
							<HandDot
								x={it.at[0]}
								y={it.at[1]}
								r={3.9 * k}
								seed={`peak-halo-${it.name}`}
								color={HALO}
								opacity={0.85}
							/>
							<HandDot
								x={it.at[0]}
								y={it.at[1]}
								r={2.8 * k}
								seed={`peak-dot-${it.name}`}
								color={color}
								opacity={1}
								data
							/>
							{note != null && (
								<HandLabel
									x={it.at[0]}
									y={it.at[1] - 7 * k}
									anchor="middle"
									size={11 * k}
									color={PHOTO_INK}
									halo={3 * k}
									haloColor={HALO}
								>
									{note}
								</HandLabel>
							)}
						</g>
					);
				const ty = Math.max(
					top + fs + 2 * k + (it.sub ? 11 * k : 0),
					it.at[1] - (24 + row * 1) * k - row * rowH,
				);
				return (
					<g key={it.name}>
						<title>{it.sub ? `${it.name}, ${it.sub}` : it.name}</title>
						{/* hairline leader from the summit up to the name: paper under, pen over */}
						<PhotoLine
							d={`M${it.at[0]} ${it.at[1] - 3 * k}L${it.at[0]} ${ty + 3 * k}`}
							seed={`peak-leader-${it.name}`}
							color={color}
							width={0.8 * k}
							halo={2.4 * k}
							opacity={0.95}
							crisp
						/>
						<HandDot
							x={it.at[0]}
							y={it.at[1]}
							r={3.9 * k}
							seed={`peak-halo-${it.name}`}
							color={HALO}
							opacity={0.85}
						/>
						<HandDot
							x={it.at[0]}
							y={it.at[1]}
							r={2.8 * k}
							seed={`peak-dot-${it.name}`}
							color={color}
							opacity={1}
							data
						/>
						{/* Heim/Imfeld panorama lettering: a dark hand name on a paper halo */}
						<text
							x={it.at[0]}
							y={ty}
							textAnchor={anchor}
							fontSize={fs}
							className="nb-label"
							stroke={HALO}
							strokeWidth={3.6 * k}
							strokeLinejoin="round"
							paintOrder="stroke"
							style={{ fill: PHOTO_INK, fontFamily: CAPS_STACK }}
						>
							{it.name}
						</text>
						{it.sub && (
							<text
								x={it.at[0]}
								y={ty - 14 * k}
								textAnchor={anchor}
								fontSize={10.5 * k}
								className="nb-num"
								stroke={HALO}
								strokeWidth={3 * k}
								strokeLinejoin="round"
								paintOrder="stroke"
								style={{
									fill: PHOTO_INK,
									fontFamily: FIGURE_STACK,
									fontStyle: "italic",
									fontVariantNumeric: "tabular-nums",
								}}
							>
								{it.sub}
							</text>
						)}
					</g>
				);
			})}
		</g>
	);
}

/** DemPatch's square viewBox side. */
const DEM_VIEW = 400;

/** Pixel of a bearing and distance (m) from the camera on the north-up patch (the camera is at the centre). */
export function demToPx(
	halfKm: number,
	azDeg: number,
	distM: number,
	size = DEM_VIEW,
): [number, number] {
	const r = (azDeg * Math.PI) / 180;
	const half = halfKm * 1000;
	return [
		size / 2 + (Math.sin(r) * distM * size) / (2 * half),
		size / 2 - (Math.cos(r) * distM * size) / (2 * half),
	];
}

/**
 * The view cone as a closed SVG path on the DEM patch: from the camera along yaw ± hfov/2 out to `reach`
 * (metres, default 1.6 times the patch's half width) and round the arc. Shared by DemPatch, the story
 * map and anything drawing a cone on `demPatch` pixels.
 */
export function coneWedge(
	data: { demPatch: { halfKm: number } },
	yaw: number,
	hfov: number,
	reach = data.demPatch.halfKm * 1600,
	size = DEM_VIEW,
): string {
	const halfKm = data.demPatch.halfKm;
	const a = demToPx(halfKm, yaw - hfov / 2, reach, size);
	const b = demToPx(halfKm, yaw + hfov / 2, reach, size);
	const radius = (reach * size) / (2 * halfKm * 1000);
	return `M${size / 2} ${size / 2}L${a[0]} ${a[1]}A${radius} ${radius} 0 0 1 ${b[0]} ${b[1]}Z`;
}

/**
 * The hillshaded DEM patch around a demo photo's camera, north up, with the view cone at the prior
 * (dashed, magenta) and solved (cyan) yaw, and optionally the labelled peaks inside the patch.
 */
export function DemPatch({
	data,
	cone = ["prior", "solved"],
	peaks = true,
	coneFill = 0.1,
	aspect = 1,
	id,
	imprint: imprintProp,
	furniture = true,
	className,
	children,
}: {
	data: GipfelbuchPhotoData | null;
	cone?: ("prior" | "solved")[];
	peaks?: boolean;
	/** Tint inside each cone, as a fill opacity (the solved cone takes 1.4 times it); 0 for outlines only. */
	coneFill?: number;
	/** Width / height of the loading skeleton (default square). */
	aspect?: number;
	/** The photo id being loaded, so a failed fetch names it. */
	id?: string;
	/** One micro provenance line under the patch; false hides it. */
	imprint?: boolean;
	/** The "N↑ · km · min–max m" scale line; false leaves it out (default true). */
	furniture?: boolean;
	className?: string;
	children?: (
		d: GipfelbuchPhotoData,
		toPx: (azDeg: number, distM: number) => [number, number],
	) => ReactNode;
}) {
	const imprintDefault = useContext(ImprintContext);
	const imprint = imprintProp ?? imprintDefault;
	const failedId = useLoadFailure(id);
	if (!data)
		return (
			<FigureSkeleton
				aspect={aspect}
				failedId={failedId}
				className={className}
			/>
		);
	const S = DEM_VIEW;
	const half = data.demPatch.halfKm * 1000;
	const toPx = (az: number, d: number): [number, number] =>
		demToPx(data.demPatch.halfKm, az, d, S);
	return (
		<div
			className={cn(
				"relative overflow-hidden transition-opacity duration-300 motion-reduce:transition-none",
				isStaleData(data) && "opacity-[0.55]",
				className,
			)}
		>
			<svg
				viewBox={`0 0 ${S} ${S}`}
				className="block h-auto w-full"
				role="img"
				aria-label={`Relief map around ${data.id} with the camera's view cone`}
			>
				<rect
					width={S}
					height={S}
					fill="var(--fig-wash, var(--gb-paper, #ece6da))"
				/>
				<defs>
					<ImhofRampFilter
						id={`${data.id}-imhof`}
						stops={IMHOF_SHADING_STOPS}
					/>
				</defs>
				{/* hillshade through an Imhof ramp (warm lit, cool shade), multiplied onto paper (wave5 D2) */}
				<image
					href={data.demPatch.src}
					filter={`url(#${data.id}-imhof)`}
					width={S}
					height={S}
					preserveAspectRatio="none"
					opacity={0.92}
					style={{ mixBlendMode: "multiply" }}
				/>
				{(["prior", "solved"] as const).map(
					(l) =>
						cone.includes(l) && (
							<g key={l}>
								{coneFill > 0 && (
									<path
										d={coneWedge(data, data[l].yaw, data[l].hfov)}
										fill={inkFor(l, "paper")}
										fillOpacity={l === "solved" ? coneFill * 1.4 : coneFill}
									/>
								)}
								<PhotoLine
									d={coneWedge(data, data[l].yaw, data[l].hfov)}
									seed={`${data.id}-cone-${l}`}
									color={inkFor(l, "paper")}
									width={l === "solved" ? 1.9 : 1.5}
									halo={l === "solved" ? 4.4 : 4}
									dash={l === "prior" ? dashFor("prior", 5 / 6) : undefined}
								/>
							</g>
						),
				)}
				{peaks &&
					data.peaks
						.filter((p) => p.labelled && p.distance < half * 1.35)
						.map((p) => {
							const [x, y] = toPx(p.az, p.distance);
							if (x < 4 || y < 4 || x > S - 4 || y > S - 4) return null;
							const flip = x > S - 90;
							return (
								<g key={p.name}>
									<HandDot
										x={x}
										y={y}
										r={3.6}
										seed={`dem-halo-${p.name}`}
										color={HALO}
										opacity={0.85}
									/>
									<HandDot
										x={x}
										y={y}
										r={2.5}
										seed={`dem-peak-${p.name}`}
										color="var(--gb-ink, #131313)"
										opacity={1}
									/>
									<HandLabel
										x={flip ? x - 6 : x + 6}
										y={y + 2}
										anchor={flip ? "end" : "start"}
										size={11.5}
										caps
										condensed
										color={PHOTO_INK}
										haloColor={HALO}
										halo={2.8}
									>
										{p.name}
									</HandLabel>
								</g>
							);
						})}
				<HandDot
					x={S / 2}
					y={S / 2}
					r={6.5}
					seed={`${data.id}-camera-halo`}
					color={HALO}
					opacity={0.85}
				/>
				<HandDot
					x={S / 2}
					y={S / 2}
					r={4.6}
					seed={`${data.id}-camera`}
					color="var(--gb-ink, #131313)"
					opacity={1}
				/>
				{children?.(data, toPx)}
				{furniture && (
					<HandLabel
						x={S - 8}
						y={17}
						anchor="end"
						size={12}
						italic
						color={PHOTO_INK}
						haloColor={HALO}
						halo={2.6}
					>
						N↑ · {2 * data.demPatch.halfKm} km · {data.demPatch.min}–
						{data.demPatch.max} m
					</HandLabel>
				)}
			</svg>
			{imprint && <ImprintLine imprint={imprintFor(data, "dem")} />}
		</div>
	);
}

/** Small "measured" provenance line for a figure built from real data. */
export function Measured({
	data,
	children,
}: {
	data?: {
		id?: string;
		script: string;
		generated: string;
		dem?: string;
	} | null;
	children?: ReactNode;
}) {
	return (
		<span className="inline-flex flex-wrap items-center gap-1.5">
			{/* a pen tick: the figure is drawn from a measurement */}
			<svg
				viewBox="0 0 14 12"
				className="size-3.5 shrink-0 overflow-visible"
				aria-hidden="true"
			>
				<SketchPath
					d="M2 6.5L5.5 10L12 2"
					seed="measured-tick"
					color="forest"
					width={1.6}
					passes={1}
					tolerance={0.6}
				/>
			</svg>
			<span
				title={`Measured by ${data?.script ?? "scripts/gipfelbuch/build-data.ts"}${data?.generated ? `, ${data.generated}` : ""}${data?.dem ? ` (${data.dem} terrain)` : ""}`}
			>
				Measured{data?.id ? ` on ${data.id.replace(/^demo-/, "photo ")}` : ""}.
			</span>
			{children}
		</span>
	);
}

/** Thumbnail picker over the demo photos; `mark(id)` adds a small badge (e.g. accepted / rejected). */
export function PhotoPicker({
	value,
	onChange,
	ids = GIPFELBUCH_PHOTO_IDS,
	mark,
}: {
	value: GipfelbuchPhotoId;
	onChange: (id: GipfelbuchPhotoId) => void;
	ids?: readonly GipfelbuchPhotoId[];
	mark?: (id: GipfelbuchPhotoId) => ReactNode;
}) {
	return (
		<div className="mb-3 flex gap-2 overflow-x-auto pb-1">
			{ids.map((id) => (
				<button
					key={id}
					type="button"
					onClick={() => onChange(id)}
					className={cn(
						"flex shrink-0 flex-col items-center gap-0.5 transition",
						id !== value && "opacity-60 hover:opacity-100",
					)}
					aria-label={id}
					aria-pressed={id === value}
				>
					<span className="relative block h-12 w-16 overflow-hidden">
						<img
							src={`/demo/thumbs/${id}.jpg`}
							alt=""
							className="size-full object-cover"
						/>
						{mark && (
							<span className="absolute right-0.5 bottom-0.5">{mark(id)}</span>
						)}
					</span>
					<svg
						viewBox="0 0 64 5"
						className="block h-[5px] w-16 overflow-visible"
						aria-hidden="true"
					>
						{id === value && (
							<SketchPath
								d="M2 2.5L62 2.5"
								seed={`picker-${id}`}
								color="red"
								width={1.8}
							/>
						)}
					</svg>
				</button>
			))}
		</div>
	);
}
