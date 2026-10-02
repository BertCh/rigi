// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Database } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useId,
	useMemo,
	useState,
} from "react";
import { cn } from "#/lib/utils";
import { HandDot, SketchPath } from "../notebook/Ink";
import { sketchify } from "../notebook/sketchify";
import { IMHOF_SHADING_STOPS, ImhofRampFilter } from "../swiss/imhof";
import { SWISS } from "../swiss/inks";
import { TYPE } from "../swiss/type";
import { type TafelBake, useTafelBake } from "../tafel/useTafelBake";
import type { FigureImprint } from "./Figure";
import { HandStrike } from "./hand";
import { poseAt, useAlignmentStory } from "./story";

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
function load<T>(url: string): Promise<T> {
	let p = cache.get(url);
	if (!p) {
		p = fetch(url).then((r) => {
			if (!r.ok) throw new Error(`${url}: ${r.status}`);
			return r.json();
		});
		p.catch(() => cache.delete(url));
		cache.set(url, p);
	}
	return p as Promise<T>;
}
function useJson<T>(url: string | null): T | null {
	const [d, setD] = useState<T | null>(null);
	useEffect(() => {
		if (!url) return;
		let live = true;
		setD(null);
		load<T>(url).then(
			(v) => live && setD(v),
			(e) => console.warn("[gipfelbuch]", e),
		);
		return () => {
			live = false;
		};
	}, [url]);
	return d;
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

export type PhotoLayer =
	| "skyline"
	| "weight"
	| "prior"
	| "solved"
	| "peaks"
	| "priorPeaks"
	| "sky";
export const LAYER_STYLE: Record<PhotoLayer, { label: string; color: string }> =
	{
		skyline: { label: "detected skyline", color: "#f0a30a" },
		weight: { label: "column confidence", color: "#f0a30a" },
		prior: { label: "DEM at sensor prior", color: "#e0207f" },
		solved: { label: "DEM at solved pose", color: "#0aa5bd" },
		peaks: { label: "peaks (solved)", color: "var(--gb-ink, #131313)" },
		priorPeaks: { label: "peaks (prior)", color: "#e0207f" },
		sky: { label: "sky probability", color: "#7aa7ff" },
	};

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
				revision: data.solved.stage,
				stich: "SVG",
			}
		: {
				aufnahme: `${data.dem} DEM, ${2 * data.demPatch.halfKm} km patch`,
				revision: "hillshade",
				stich: "SVG",
			};
}

function ImprintLine({ imprint }: { imprint: FigureImprint }) {
	return (
		<p className={`${TYPE.micro} gb-secondary mt-1.5`}>
			{[
				imprint.aufnahme && `Aufnahme ${imprint.aufnahme}`,
				imprint.revision && `Revision ${imprint.revision}`,
				imprint.stich && `Stich ${imprint.stich}`,
			]
				.filter(Boolean)
				.join(" · ")}
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
	 * Geo bleed: the measured terrain carries on past the photo's frame, as on the Tafel. The baked
	 * ridge strokes, the compass ruler and the summits outside the frame are drawn on the paper around
	 * the photo, fading out. The svg keeps the container's width and the photo sits inside it, with this
	 * fraction of the frame width of paper on each side (true = 0.14). Use on one big photo per wide
	 * figure, never inside a Trio or Gallery. In a Compare, give both sides the same `bleed` so the wipe
	 * stays registered.
	 */
	bleed?: boolean | number;
	className?: string;
	children?: (d: GipfelbuchPhotoData) => ReactNode;
}) {
	const imprintDefault = useContext(ImprintContext);
	const imprint = imprintProp ?? imprintDefault;
	const story = useAlignmentStory();
	const [off, setOff] = useState<Set<PhotoLayer>>(new Set());
	const clipId = `gipfelbuch-clip-${useId().replace(/:/g, "")}`;
	const bleedFraction = bleed === true ? 0.14 : bleed || 0;
	const bake = useTafelBake(bleedFraction > 0 && data ? data.id : null);
	if (!data)
		return (
			<div
				className={cn(
					"aspect-[4/3] w-full animate-pulse bg-white/[0.06] motion-reduce:animate-none",
					className,
				)}
			/>
		);
	const { width: W, height: H } = data.photo;
	const [x0, y0, x1, y1] = crop ?? [0, 0, W, H];
	const k = (x1 - x0) / W; // < 1 when zoomed: keeps strokes and text a constant on-screen size
	const on = (l: PhotoLayer) => layers.includes(l) && !off.has(l);
	// the pose the bleed is drawn at: the guess when only the guess is shown, else the story's or solved
	const showsPrior = on("prior") || on("priorPeaks");
	const showsSolved = on("solved") || on("peaks");
	const bleedT =
		showsPrior && !showsSolved
			? 0
			: showsSolved && !showsPrior
				? 1
				: (story?.t ?? 1);
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
	const frameW = x1 - x0;
	const spill =
		bleedFraction > 0
			? {
					mx: bleedFraction * frameW,
					top: 34 * k,
					bottom: 10 * k,
				}
			: null;
	const view = spill
		? [
				x0 - spill.mx,
				y0 - spill.top,
				frameW + 2 * spill.mx,
				y1 - y0 + spill.top + spill.bottom,
			]
		: [x0, y0, frameW, y1 - y0];
	return (
		<div className={className}>
			<svg
				viewBox={view.join(" ")}
				className="block h-auto w-full overflow-hidden"
				role="img"
				aria-label={`${data.id} with measured overlays`}
			>
				{spill && (
					<GeoBleed
						data={data}
						bake={bake}
						frame={[x0, y0, x1, y1]}
						view={view as [number, number, number, number]}
						k={k}
						id={clipId}
						t={bleedT}
					/>
				)}
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
								on(l) && (
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
										color={LAYER_STYLE[l].color}
										width={(l === "skyline" ? 1.7 : 2.2) * k}
										halo={(l === "skyline" ? 4 : 4.6) * k}
										dash={l === "prior" ? `${6 * k} ${5 * k}` : undefined}
										opacity={lineOpacity(l)}
										crisp
									/>
								),
						)}
						{on("weight") &&
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
							items={priorLabels.map((p) => ({
								name: p.name,
								at: p.prior as [number, number],
							}))}
							color={LAYER_STYLE.priorPeaks.color}
							k={k}
							top={y0}
							left={x0}
							right={x1}
						/>
					)}
					{on("peaks") && (
						<PeakLabels
							items={solvedLabels.map((p) => ({
								name: p.name,
								at: p.solved as [number, number],
								sub: labelInfo
									? `${p.dem} m · ${(p.distance / 1000).toFixed(0)} km`
									: undefined,
							}))}
							color={LAYER_STYLE.peaks.color}
							k={k}
							top={y0}
							left={x0}
							right={x1}
						/>
					)}
					{children?.(data)}
				</g>
			</svg>
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
									color={LAYER_STYLE[l].color}
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

/** Peak marks with leaders; names staggered over three rows by x so neighbours don't overlap. */
function PeakLabels({
	items,
	color,
	k,
	top,
	left,
	right,
}: {
	items: { name: string; at: [number, number]; sub?: string }[];
	color: string;
	k: number;
	top: number;
	left: number;
	right: number;
}) {
	const fs = 14 * k;
	const rowH = (items.some((i) => i.sub) ? 26 : 15) * k;
	// KR8: place in priority order (the data's ranking), on up to three rows. A label's box is its
	// real extent for its anchor plus the leader stub; a summit whose name fits no row keeps its dot
	// and loses the name, so two close summits never overprint.
	const rows: [number, number][][] = [[], [], []];
	const placed = items.map((it) => {
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
		const box: [number, number] = [x0, x0 + w];
		const row = rows.findIndex((r) =>
			r.every(([a0, a1]) => box[1] < a0 || box[0] > a1),
		);
		if (row >= 0) rows[row].push(box);
		return { it, anchor, row };
	});
	return (
		<g>
			{placed.map(({ it, anchor, row }) => {
				if (row < 0)
					return (
						<g key={it.name}>
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
						</g>
					);
				const ty = Math.max(
					top + fs + 2 * k + (it.sub ? 11 * k : 0),
					it.at[1] - (24 + row * 1) * k - row * rowH,
				);
				return (
					<g key={it.name}>
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

/** Cone inks on paper: chart kin of the photo overlay magenta / cyan (RM, GL). */
const DEM_PRIOR = "#ab343a";
const DEM_SOLVED = "#30626b";

/**
 * The hillshaded DEM patch around a demo photo's camera, north up, with the view cone at the prior
 * (dashed, magenta) and solved (cyan) yaw, and optionally the labelled peaks inside the patch.
 */
export function DemPatch({
	data,
	cone = ["prior", "solved"],
	peaks = true,
	imprint: imprintProp,
	className,
	children,
}: {
	data: GipfelbuchPhotoData | null;
	cone?: ("prior" | "solved")[];
	peaks?: boolean;
	/** One micro provenance line under the patch; false hides it. */
	imprint?: boolean;
	className?: string;
	children?: (
		d: GipfelbuchPhotoData,
		toPx: (azDeg: number, distM: number) => [number, number],
	) => ReactNode;
}) {
	const imprintDefault = useContext(ImprintContext);
	const imprint = imprintProp ?? imprintDefault;
	if (!data)
		return (
			<div
				className={cn(
					"aspect-square w-full animate-pulse bg-white/[0.06] motion-reduce:animate-none",
					className,
				)}
			/>
		);
	const S = 400;
	const half = data.demPatch.halfKm * 1000;
	const toPx = (az: number, d: number): [number, number] => {
		const r = (az * Math.PI) / 180;
		return [
			S / 2 + (Math.sin(r) * d * S) / (2 * half),
			S / 2 - (Math.cos(r) * d * S) / (2 * half),
		];
	};
	const wedge = (yaw: number, hfov: number, reach: number) => {
		const a = toPx(yaw - hfov / 2, reach);
		const b = toPx(yaw + hfov / 2, reach);
		const rr = (reach * S) / (2 * half);
		return `M${S / 2} ${S / 2}L${a[0]} ${a[1]}A${rr} ${rr} 0 0 1 ${b[0]} ${b[1]}Z`;
	};
	const reach = half * 1.6;
	return (
		<div className={cn("relative overflow-hidden", className)}>
			<svg
				viewBox={`0 0 ${S} ${S}`}
				className="block h-auto w-full"
				role="img"
				aria-label={`Relief map around ${data.id} with the camera's view cone`}
			>
				<rect width={S} height={S} fill="var(--gb-paper, #ece6da)" />
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
				{cone.includes("prior") && (
					<PhotoLine
						d={wedge(data.prior.yaw, data.prior.hfov, reach)}
						seed={`${data.id}-cone-prior`}
						color={DEM_PRIOR}
						width={1.5}
						halo={4}
						dash="5 4"
					/>
				)}
				{cone.includes("solved") && (
					<PhotoLine
						d={wedge(data.solved.yaw, data.solved.hfov, reach)}
						seed={`${data.id}-cone-solved`}
						color={DEM_SOLVED}
						width={1.9}
						halo={4.4}
					/>
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
									<text
										x={flip ? x - 6 : x + 6}
										y={y + 2}
										textAnchor={flip ? "end" : "start"}
										fontSize={11.5}
										className="nb-label"
										stroke={HALO}
										strokeWidth={2.8}
										strokeLinejoin="round"
										paintOrder="stroke"
										style={{ fill: PHOTO_INK, fontFamily: CAPS_STACK }}
									>
										{p.name}
									</text>
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
					color="var(--gb-red, var(--accent))"
					opacity={1}
				/>
				{children?.(data, toPx)}
				<text
					x={S - 8}
					y={17}
					textAnchor="end"
					fontSize={12}
					className="nb-num"
					stroke={HALO}
					strokeWidth={2.6}
					strokeLinejoin="round"
					paintOrder="stroke"
					style={{ fill: PHOTO_INK, fontFamily: FIGURE_STACK }}
				>
					N↑ · {2 * data.demPatch.halfKm} km · {data.demPatch.min}–
					{data.demPatch.max} m
				</text>
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
			<Database
				className="size-3 text-[var(--gb-contour,var(--accent))]"
				strokeWidth={1.6}
			/>
			<span>
				Measured{data?.id ? ` on ${data.id}` : ""}
				{data?.dem ? ` (${data.dem} DEM)` : ""} by{" "}
				{data?.script ?? "scripts/gipfelbuch/build-data.ts"}
				{data?.generated ? `, ${data.generated}` : ""}.
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

/** RGB of a #rrggbb hex as 0..1, for an feColorMatrix (SVG attributes take no var()). */
const rgb01 = (hex: string) =>
	[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);

const CARDINAL: Record<number, string> = {
	0: "N",
	90: "E",
	180: "S",
	270: "W",
};

/**
 * The paper around a photo, carrying its measured world past the frame: the Tafel bake's ridge
 * strokes re-inked in contour brown, a compass ruler over the top, and the summits outside the
 * frame. Everything fades towards the outer edges. Drawn in working-frame px, under the photo.
 */
function GeoBleed({
	data,
	bake,
	frame,
	view,
	k,
	id,
	t = 1,
}: {
	data: GipfelbuchPhotoData;
	bake: TafelBake | null;
	frame: [number, number, number, number];
	view: [number, number, number, number];
	k: number;
	id: string;
	/** Alignment story position: 0 draws the world where the phone's guess puts it, 1 at the solved pose. */
	t?: number;
}) {
	if (!bake) return null;
	const [x0, y0, x1, y1] = frame;
	const [vx, vy, vw, vh] = view;
	// canvas px per working px, and the canvas box in working px
	const scale = (bake.width * bake.photo.w) / data.photo.width;
	const cw = bake.width / scale;
	const ch = bake.height / scale;
	const cx = -(bake.photo.x * bake.width) / scale;
	const cy = -(bake.photo.y * bake.height) / scale;
	const [r, g, b] = rgb01(SWISS.contour);
	const fadeL = (x0 - vx) / vw;
	const fadeR = (x1 - vx) / vw;
	const rulerY = y0 - 14 * k;
	const norm = (a: number) => ((a % 360) + 360) % 360;
	// the bake is drawn at its own camera; at another pose the world slides by f·tan(Δyaw) across and
	// f·tan(pitch) down (roll and the focal change are small here and left out)
	const pose = poseAt(data, t);
	const RAD = Math.PI / 180;
	const dYaw = ((((bake.camera.yaw - pose.yaw + 180) % 360) + 360) % 360) - 180;
	const dx = pose.f * Math.tan(dYaw * RAD);
	const dy =
		pose.f * Math.tan(pose.pitch * RAD) -
		bake.camera.f * Math.tan(bake.camera.pitch * RAD);
	const ticks = bake.ticks
		.map((t) => ({ ...t, wx: cx + t.x * cw + dx, a: norm(t.az) }))
		.filter((t) => t.wx >= vx && t.wx <= vx + vw);
	const outside = bake.peaks
		.map((p) => ({ ...p, wx: cx + p.x * cw + dx, wy: cy + p.y * ch + dy }))
		.filter(
			(p) =>
				(p.wx < x0 - 6 * k || p.wx > x1 + 6 * k) &&
				p.wx > vx + 8 * k &&
				p.wx < vx + vw - 8 * k &&
				p.wy > y0 + 4 * k &&
				p.wy < y1,
		)
		.sort((p, q) => q.ele - p.ele)
		.slice(0, 4);
	return (
		<g>
			<defs>
				<filter id={`${id}-ink`} colorInterpolationFilters="sRGB">
					<feColorMatrix
						type="matrix"
						values={`0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${b} 0 0 0 1 0`}
					/>
				</filter>
				<linearGradient id={`${id}-fade`} x1="0" x2="1" y1="0" y2="0">
					<stop offset="0" stopColor="#fff" stopOpacity="0" />
					<stop offset={fadeL * 0.55} stopColor="#fff" stopOpacity="0.35" />
					<stop offset={fadeL} stopColor="#fff" stopOpacity="1" />
					<stop offset={fadeR} stopColor="#fff" stopOpacity="1" />
					<stop
						offset={1 - (1 - fadeR) * 0.55}
						stopColor="#fff"
						stopOpacity="0.35"
					/>
					<stop offset="1" stopColor="#fff" stopOpacity="0" />
				</linearGradient>
				<mask id={`${id}-mask`} maskUnits="userSpaceOnUse">
					<rect
						x={vx}
						y={vy}
						width={vw}
						height={vh}
						fill={`url(#${id}-fade)`}
					/>
				</mask>
			</defs>
			<g mask={`url(#${id}-mask)`}>
				<image
					href={bake.src}
					x={cx + dx}
					y={cy + dy}
					width={cw}
					height={ch}
					preserveAspectRatio="none"
					filter={`url(#${id}-ink)`}
					opacity={0.9}
				/>
				{/* compass ruler drawn by hand: every 5°, lettered every 15° and at the cardinals */}
				<SketchPath
					d={`M${vx.toFixed(1)} ${rulerY.toFixed(1)}L${(vx + vw).toFixed(1)} ${rulerY.toFixed(1)}`}
					seed={`${data.id}-ruler`}
					color={SWISS.ink}
					width={0.9 * k}
					opacity={0.6}
					passes={2}
					tolerance={0.9 * k}
				/>
				<SketchPath
					d={ticks
						.map((t) => {
							const major = t.a % 15 === 0 || !!CARDINAL[t.a];
							return `M${t.wx.toFixed(1)} ${rulerY.toFixed(1)}L${t.wx.toFixed(1)} ${(rulerY + (major ? 7 : 4) * k).toFixed(1)}`;
						})
						.join("")}
					seed={`${data.id}-ruler-ticks`}
					color={SWISS.ink}
					width={0.9 * k}
					opacity={0.7}
					passes={1}
					tolerance={0.4 * k}
				/>
				{ticks.map((t) => {
					const cardinal = CARDINAL[t.a];
					const major = t.a % 15 === 0 || !!cardinal;
					return (
						major && (
							<text
								key={t.az}
								x={t.wx}
								y={rulerY - 4 * k}
								textAnchor="middle"
								fontSize={(cardinal ? 12 : 10.5) * k}
								className={cardinal ? "nb-label" : "nb-num"}
								style={{
									fill: cardinal ? SWISS.red : SWISS.secondary,
									fontFamily: cardinal ? CAPS_STACK : FIGURE_STACK,
								}}
							>
								{cardinal ?? `${t.a}°`}
							</text>
						)
					);
				})}
			</g>
			{/* summits beyond the frame, named in the margin like a Panoramatafel */}
			{outside.map((p) => (
				<g key={p.name}>
					{/* a summit triangle by hand: a pen outline over a light fill */}
					<path
						d={`M${p.wx} ${p.wy - 1 * k}l${-3.2 * k} ${5.5 * k}h${6.4 * k}z`}
						fill={SWISS.navy}
						fillOpacity={0.35}
					/>
					<SketchPath
						d={`M${p.wx} ${p.wy - 1 * k}l${-3.2 * k} ${5.5 * k}h${6.4 * k}z`}
						seed={`bleed-peak-${p.name}`}
						color={SWISS.navy}
						width={1.1 * k}
						passes={2}
						tolerance={0.5 * k}
					/>
					<text
						x={p.wx}
						y={p.wy - 5 * k}
						textAnchor="middle"
						fontSize={11.5 * k}
						className="nb-label"
						stroke={SWISS.paper}
						strokeWidth={2.8 * k}
						paintOrder="stroke"
						strokeLinejoin="round"
						style={{ fill: SWISS.navy, fontFamily: CAPS_STACK }}
					>
						{p.name}
						<tspan
							x={p.wx}
							dy={-12 * k}
							fontSize={10 * k}
							className="nb-num"
							style={{
								fill: SWISS.secondary,
								fontFamily: FIGURE_STACK,
								fontStyle: "italic",
								textTransform: "none",
								letterSpacing: 0,
							}}
						>
							{p.ele} m · {p.km.toFixed(0)} km
						</tspan>
					</text>
				</g>
			))}
		</g>
	);
}
