// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Database } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { cn } from "#/lib/utils";

// Measured data for atlas pages: the real CPU pipeline run on the bundled Niederhorn demo photos by
// scripts/atlas/build-data.ts → public/demo/atlas/*. Pages render these instead of synthetic stand-ins.

export const ATLAS_PHOTO_IDS = [
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
export type AtlasPhotoId = (typeof ATLAS_PHOTO_IDS)[number];

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

export interface AtlasPeak {
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

export interface AtlasPhotoData {
	id: AtlasPhotoId;
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
	peaks: AtlasPeak[];
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

export interface AtlasIndex {
	generated: string;
	script: string;
	place: string;
	photos: {
		id: AtlasPhotoId;
		thumb: string;
		accepted: boolean;
		stage: string;
		confidence: number;
		delta: AtlasPhotoData["solved"]["delta"];
		residual: AtlasPhotoData["residual"];
		peaks: number;
		labelled: string[];
		ms: AtlasPhotoData["ms"];
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
			(e) => console.warn("[atlas]", e),
		);
		return () => {
			live = false;
		};
	}, [url]);
	return d;
}

/** Measured pipeline data for one demo photo (null while loading). */
export const useAtlasPhoto = (id: AtlasPhotoId | null) =>
	useJson<AtlasPhotoData>(id && `/demo/atlas/${id}.json`);
/** Per-photo summary of all 12 + ground-truth eval rows. */
export const useAtlasIndex = () =>
	useJson<AtlasIndex>("/demo/atlas/index.json");

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
		skyline: { label: "detected skyline", color: "#f4d35e" },
		weight: { label: "column confidence", color: "#f4d35e" },
		prior: { label: "DEM at sensor prior", color: "#ff5fa2" },
		solved: { label: "DEM at solved pose", color: "#5ee0f4" },
		peaks: { label: "peaks (solved)", color: "#ece6da" },
		priorPeaks: { label: "peaks (prior)", color: "#ff5fa2" },
		sky: { label: "sky probability", color: "#7aa7ff" },
	};

/**
 * A real demo photo with measured overlays in its own pixel frame (working size, 800 px wide). `layers` are
 * drawn in order; `toggles` adds chips that switch layers on/off. `crop` = [x0, y0, x1, y1] in working px
 * zooms to a region (e.g. the skyline band, or to keep people out of frame). `children(d)` draws extra SVG
 * in the same pixel frame. Peak labels are staggered on up to three rows so they don't collide.
 */
export function RealPhoto({
	data,
	layers,
	toggles,
	crop,
	maxLabels = 10,
	labelInfo = false,
	className,
	children,
}: {
	data: AtlasPhotoData | null;
	layers: PhotoLayer[];
	toggles?: PhotoLayer[];
	crop?: [number, number, number, number];
	maxLabels?: number;
	/** Show "height · distance" under each solved peak name. */
	labelInfo?: boolean;
	className?: string;
	children?: (d: AtlasPhotoData) => ReactNode;
}) {
	const [off, setOff] = useState<Set<PhotoLayer>>(new Set());
	const clipId = `atlas-clip-${useId().replace(/:/g, "")}`;
	if (!data)
		return (
			<div
				className={cn(
					"aspect-[4/3] w-full animate-pulse rounded-xl bg-white/[0.04]",
					className,
				)}
			/>
		);
	const { width: W, height: H } = data.photo;
	const [x0, y0, x1, y1] = crop ?? [0, 0, W, H];
	const k = (x1 - x0) / W; // < 1 when zoomed: keeps strokes and text a constant on-screen size
	const on = (l: PhotoLayer) => layers.includes(l) && !off.has(l);
	const inCrop = (q: [number, number] | null) =>
		!!q && q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1;
	const solvedLabels = data.peaks
		.filter((p) => p.labelled && inCrop(p.solved))
		.slice(0, maxLabels);
	const priorLabels = data.peaks
		.filter((p) => p.labelled && inCrop(p.prior))
		.slice(0, maxLabels);
	const ws = data.skyline.weight;
	return (
		<div className={className}>
			<svg
				viewBox={`${x0} ${y0} ${x1 - x0} ${y1 - y0}`}
				className="block h-auto w-full overflow-hidden rounded-xl"
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
								on(l) && (
									<g key={l}>
										<path
											d={rowsPath(
												l === "skyline"
													? data.skyline.rows
													: l === "prior"
														? data.priorRows
														: data.solvedRows,
												l === "skyline" ? 8 : 12,
											)}
											stroke="#0e1012"
											strokeOpacity={0.55}
											strokeWidth={(l === "skyline" ? 3.6 : 4.4) * k}
										/>
										<path
											d={rowsPath(
												l === "skyline"
													? data.skyline.rows
													: l === "prior"
														? data.priorRows
														: data.solvedRows,
												l === "skyline" ? 8 : 12,
											)}
											stroke={LAYER_STYLE[l].color}
											strokeWidth={(l === "skyline" ? 1.6 : 2.2) * k}
											strokeDasharray={
												l === "prior" ? `${6 * k} ${5 * k}` : undefined
											}
										/>
									</g>
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
							className={cn(
								"inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10.5px] ring-1 transition",
								off.has(l)
									? "text-white/35 ring-white/10"
									: "text-white/80 ring-white/20",
							)}
						>
							<span
								className="size-2 rounded-full"
								style={{
									background: LAYER_STYLE[l].color,
									opacity: off.has(l) ? 0.3 : 1,
								}}
							/>
							{LAYER_STYLE[l].label}
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
	const sorted = [...items].sort((a, b) => a.at[0] - b.at[0]);
	const fs = 12 * k;
	const rowH = (sorted.some((i) => i.sub) ? 26 : 15) * k;
	const lastEnd = [-Infinity, -Infinity, -Infinity];
	return (
		<g fontFamily="ui-sans-serif, system-ui">
			{sorted.map((it) => {
				const halfW = it.name.length * fs * 0.29 + 4 * k;
				let row = lastEnd.findIndex((e) => it.at[0] - halfW > e);
				if (row < 0) row = lastEnd.indexOf(Math.min(...lastEnd));
				lastEnd[row] = it.at[0] + halfW;
				const anchor =
					it.at[0] + halfW > right
						? "end"
						: it.at[0] - halfW < left
							? "start"
							: "middle";
				const ty = Math.max(
					top + fs + 2 * k + (it.sub ? 11 * k : 0),
					it.at[1] - (24 + row * 1) * k - row * rowH,
				);
				return (
					<g key={it.name}>
						<line
							x1={it.at[0]}
							x2={it.at[0]}
							y1={it.at[1] - 3 * k}
							y2={ty + 3 * k}
							stroke={color}
							strokeOpacity={0.55}
							strokeWidth={k}
						/>
						<circle
							cx={it.at[0]}
							cy={it.at[1]}
							r={2.6 * k}
							fill={color}
							stroke="#0e1012"
							strokeWidth={k}
						/>
						<text
							x={it.at[0]}
							y={ty}
							textAnchor={anchor}
							fontSize={fs}
							fill={color}
							stroke="#0e1012"
							strokeWidth={3 * k}
							paintOrder="stroke"
						>
							{it.name}
						</text>
						{it.sub && (
							<text
								x={it.at[0]}
								y={ty - 13 * k}
								textAnchor={anchor}
								fontSize={9 * k}
								fill={color}
								fillOpacity={0.65}
								stroke="#0e1012"
								strokeWidth={2.5 * k}
								paintOrder="stroke"
								fontFamily="ui-monospace, monospace"
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

/**
 * The hillshaded DEM patch around a demo photo's camera, north up, with the view cone at the prior
 * (dashed, magenta) and solved (cyan) yaw, and optionally the labelled peaks inside the patch.
 */
export function DemPatch({
	data,
	cone = ["prior", "solved"],
	peaks = true,
	className,
	children,
}: {
	data: AtlasPhotoData | null;
	cone?: ("prior" | "solved")[];
	peaks?: boolean;
	className?: string;
	children?: (
		d: AtlasPhotoData,
		toPx: (azDeg: number, distM: number) => [number, number],
	) => ReactNode;
}) {
	if (!data)
		return (
			<div
				className={cn(
					"aspect-square w-full animate-pulse rounded-xl bg-white/[0.04]",
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
		<div className={cn("relative overflow-hidden rounded-xl", className)}>
			<svg
				viewBox={`0 0 ${S} ${S}`}
				className="block h-auto w-full"
				role="img"
				aria-label={`Relief map around ${data.id} with the camera's view cone`}
			>
				<image
					href={data.demPatch.src}
					width={S}
					height={S}
					preserveAspectRatio="none"
				/>
				{cone.includes("prior") && (
					<path
						d={wedge(data.prior.yaw, data.prior.hfov, reach)}
						fill="#ff5fa2"
						fillOpacity={0.1}
						stroke="#ff5fa2"
						strokeDasharray="5 4"
						strokeWidth={1.4}
					/>
				)}
				{cone.includes("solved") && (
					<path
						d={wedge(data.solved.yaw, data.solved.hfov, reach)}
						fill="#5ee0f4"
						fillOpacity={0.14}
						stroke="#5ee0f4"
						strokeWidth={1.6}
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
									<path
										d={`M${x} ${y - 4}l3.5 6h-7z`}
										fill="#ece6da"
										stroke="#0e1012"
										strokeWidth={0.8}
									/>
									<text
										x={flip ? x - 6 : x + 6}
										y={y + 2}
										textAnchor={flip ? "end" : "start"}
										fontSize={9.5}
										fill="#ece6da"
										stroke="#0e1012"
										strokeWidth={2.5}
										paintOrder="stroke"
									>
										{p.name}
									</text>
								</g>
							);
						})}
				<circle
					cx={S / 2}
					cy={S / 2}
					r={4.5}
					fill="var(--accent)"
					stroke="#0e1012"
					strokeWidth={1.5}
				/>
				{children?.(data, toPx)}
				<text
					x={S - 8}
					y={16}
					textAnchor="end"
					fontSize={10}
					fill="#ece6da"
					fillOpacity={0.7}
					fontFamily="ui-monospace, monospace"
				>
					N↑ · {2 * data.demPatch.halfKm} km · {data.demPatch.min}–
					{data.demPatch.max} m
				</text>
			</svg>
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
			<Database className="size-3 text-[var(--accent)]" strokeWidth={1.6} />
			<span>
				Measured{data?.id ? ` on ${data.id}` : ""}
				{data?.dem ? ` (${data.dem} DEM)` : ""} by{" "}
				{data?.script ?? "scripts/atlas/build-data.ts"}
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
	ids = ATLAS_PHOTO_IDS,
	mark,
}: {
	value: AtlasPhotoId;
	onChange: (id: AtlasPhotoId) => void;
	ids?: readonly AtlasPhotoId[];
	mark?: (id: AtlasPhotoId) => ReactNode;
}) {
	return (
		<div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
			{ids.map((id) => (
				<button
					key={id}
					type="button"
					onClick={() => onChange(id)}
					className={cn(
						"relative h-12 w-16 shrink-0 overflow-hidden rounded-md ring-2 transition",
						id === value
							? "ring-[var(--accent)]"
							: "opacity-60 ring-transparent hover:opacity-100",
					)}
					aria-label={id}
				>
					<img
						src={`/demo/thumbs/${id}.jpg`}
						alt=""
						className="size-full object-cover"
					/>
					{mark && (
						<span className="absolute right-0.5 bottom-0.5">{mark(id)}</span>
					)}
				</button>
			))}
		</div>
	);
}
