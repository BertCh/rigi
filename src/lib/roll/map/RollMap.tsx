// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// 3D map of a roll: every photo draped on the terrain at once (RollMapEngine), with a small
// control strip: overview / fly into the selected photo, walk between photos from inside one,
// basemap, drape opacity, reach and blend sharpness, and a hover card on the camera pins.
//
// Walking (Mapillary-style): inside a photo, previous / next step through the photos in capture
// order (the same list the page's ← → keys walk), "ahead" goes to the nearest photo in the view
// direction. Every step goes through onSelect, and the map flies to whatever gets selected while
// it is inside a photo, so the page's own ← → handler, the detail strip's buttons and this strip
// all drive one selection. The map only adds ↑ / ↓ (ahead / behind) and Esc (back to the
// overview), and only while it is hovered or focused.
import {
	ArrowUp,
	ChevronLeft,
	ChevronRight,
	Eye,
	Frame,
	Loader2,
	Maximize,
	Shapes,
	Tag,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { storageKey } from "../../ontology/core/storage";
import { RollMapTerroir } from "../../terroir/roll/RollMapTerroir";
import { HeadingChip } from "../mosaic/badges";
import { aspectOf, fmtDay, fmtTime } from "../mosaic/style";
import type { Roll } from "../types";
import { ROLL_BASEMAPS, type RollBasemap } from "./basemap";
import type { RollMapEngine, RollMapHover, RollMapStatus } from "./roll-map";

export type RollMapProps = {
	roll: Roll;
	/** Highlighted photo (its drape wins overlaps, others dim); null = all equal. */
	selectedId: string | null;
	onSelect: (id: string | null) => void;
	/** Photos to drape (all when undefined), e.g. from the mosaic's time filter. */
	visibleIds?: ReadonlySet<string>;
	className?: string;
};

export function RollMap({
	roll,
	selectedId,
	onSelect,
	visibleIds,
	className,
}: RollMapProps) {
	const rootRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [engine, setEngine] = useState<RollMapEngine | null>(null);
	const onSelectRef = useRef(onSelect);
	onSelectRef.current = onSelect;
	const rollRef = useRef(roll);
	rollRef.current = roll;
	const [status, setStatus] = useState<RollMapStatus>({
		stage: "terrain",
		frac: 0,
	});
	const [opacity, setOpacity] = useState(1);
	const [sharp, setSharp] = useState(3);
	const [gizmos, setGizmos] = useState(true);
	/** Place names on the map (terroir pack + the roll region's peaks). */
	const [names, setNames] = useState(true);
	const [reachKm, setReachKm] = useState(8);
	const [basemap, setBasemap] = useState<RollBasemap>(loadBasemap);
	/** The photo whose viewpoint the camera is at (or flying into); null = orbit view. */
	const [viewId, setViewId] = useState<string | null>(null);
	const [hover, setHover] = useState<RollMapHover | null>(null);
	const hovered = useRef(false);
	/** Step Inside roll spot (src/lib/nearfield/roll): off by default, needs the near-field service. */
	const [spot3d, setSpot3d] = useState(false);
	const [spotNote, setSpotNote] = useState("");

	// the engine (terrain, atlases) lives as long as the roll's photo set: a reloaded roll with new
	// poses for the same photos (the aligner) only moves the cameras (updateRoll, below)
	const rollKey = `${roll.id}|${roll.photos.map((p) => p.meta.id).join(",")}`;
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !rollKey) return;
		let eng: RollMapEngine | null = null;
		let live = true;
		// deck + three stay out of the SSR / mosaic bundle until the map is shown
		import("./roll-map").then(({ RollMapEngine }) => {
			if (!live) return;
			eng = new RollMapEngine(canvas, rollRef.current, {
				onSelect: (id) => onSelectRef.current(id),
				onStatus: (s) => live && setStatus(s),
				onHover: (h) => live && setHover(h),
				onView: (id) => live && setViewId(id),
			});
			window.__roll = eng;
			setEngine(eng);
			void eng.init();
		});
		const ro = new ResizeObserver(() => eng?.resize());
		ro.observe(canvas);
		return () => {
			live = false;
			ro.disconnect();
			eng?.dispose();
			setEngine(null);
			setViewId(null);
			setHover(null);
		};
	}, [rollKey]);

	useEffect(() => {
		if (engine && engine.roll !== roll) engine.updateRoll(roll);
	}, [engine, roll]);
	useEffect(() => engine?.setSelected(selectedId), [engine, selectedId]);
	useEffect(() => engine?.setVisible(visibleIds ?? null), [engine, visibleIds]);
	useEffect(
		() =>
			engine?.setSettings({
				drapeOpacity: opacity,
				sharpness: sharp,
				gizmos,
				reachM: reachKm * 1000,
				basemap,
			}),
		[engine, opacity, sharp, gizmos, reachKm, basemap],
	);
	// inside a photo, the camera follows the selection (page ← →, detail strip, pins, this strip)
	useEffect(() => {
		if (engine && viewId && selectedId && selectedId !== engine.photoId)
			engine.flyTo(selectedId);
	}, [engine, viewId, selectedId]);

	// Spot 3D: the fused near-field splats of the selected photo's viewpoint (opt-in, additive layer)
	const spotVp = roll.photos.find(
		(p) => p.meta.id === (viewId ?? selectedId),
	)?.viewpoint;
	useEffect(() => {
		if (!engine || !spot3d || spotVp === undefined) {
			engine?.setExtraLayers("spot3d", null);
			setSpotNote("");
			return;
		}
		const ac = new AbortController();
		void import("#/lib/nearfield/roll/roll-spot").then(async (m) => {
			const ids = m.spotPhotos(engine.roll, spotVp).map((p) => p.meta.id);
			if (!ids.length) return setSpotNote("no posed photos here");
			const s = await m
				.buildRollSpot(engine, ids, {
					signal: ac.signal,
					onStatus: (t) => !ac.signal.aborted && setSpotNote(t),
				})
				.catch((e) => {
					console.warn("[roll-map] spot 3D", e);
					return null;
				});
			if (ac.signal.aborted) return;
			if (!s) return setSpotNote((n) => n || "unavailable");
			window.__rollSpotLast = s;
			engine.setExtraLayers("spot3d", [m.spotLayer(s.cloud)]);
			setSpotNote(
				`${s.views.filter((v) => v.splats > 0).length}/${ids.length} photos · ${s.cloud.count} splats`,
			);
		});
		return () => {
			ac.abort();
			engine.setExtraLayers("spot3d", null);
		};
	}, [engine, spot3d, spotVp]);

	// capture order, filtered like the page's ← → list
	const order = useMemo(
		() =>
			visibleIds
				? roll.photos.filter((p) => visibleIds.has(p.meta.id))
				: roll.photos,
		[roll, visibleIds],
	);
	const at = order.findIndex((p) => p.meta.id === viewId);

	const go = (id: string | null) => {
		if (!engine || !id) return;
		engine.flyTo(id);
		onSelectRef.current(id);
	};
	const step = (d: 1 | -1) => {
		if (!order.length) return;
		const i =
			at < 0
				? d > 0
					? 0
					: order.length - 1
				: (at + d + order.length) % order.length;
		go(order[i].meta.id);
	};
	const fly = () => go(selectedId);
	const overview = () => engine?.frameOverview();

	// ↑ / ↓ walk ahead / behind, Esc leaves the photo: only while the map is hovered or focused
	const keys = useRef({ engine, viewId, go, overview });
	keys.current = { engine, viewId, go, overview };
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const root = rootRef.current;
			if (!root || !(hovered.current || root.contains(document.activeElement)))
				return;
			if (
				e.target instanceof HTMLElement &&
				e.target.closest('input, textarea, [role="slider"]')
			)
				return;
			const {
				engine: eng,
				viewId: vid,
				go: goTo,
				overview: exit,
			} = keys.current;
			if (!eng || !vid) return;
			if (e.key === "ArrowUp" || e.key === "ArrowDown") {
				goTo(eng.photoAhead(e.key === "ArrowUp" ? 1 : -1));
				e.preventDefault();
			} else if (e.key === "Escape") exit();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const hoverPhoto = hover
		? roll.photos.find((p) => p.meta.id === hover.id)
		: null;
	const box = rootRef.current?.getBoundingClientRect();
	const card = {
		w: 196,
		h: 64 + 196 / Math.max(0.5, hoverPhoto ? aspectOf(hoverPhoto) : 1.33),
	};

	return (
		<div
			ref={rootRef}
			// focusable so the map's keys work after a click on it
			tabIndex={-1}
			onPointerEnter={() => {
				hovered.current = true;
			}}
			onPointerLeave={() => {
				hovered.current = false;
			}}
			className={`relative overflow-hidden bg-[#a9c2da] outline-none ${className ?? ""}`}
			data-testid="roll-map"
			data-stage={status.stage}
			data-view={viewId ?? undefined}
		>
			<canvas
				ref={canvasRef}
				className="absolute inset-0 size-full touch-none"
			/>
			<RollMapTerroir
				engine={engine}
				roll={roll}
				basemap={basemap}
				names={names}
				inView={!!viewId}
				visibleIds={visibleIds}
			/>
			{status.stage !== "ready" && (
				<div className="pointer-events-none absolute top-3 left-3 flex items-center gap-2 rounded-md bg-black/55 px-2.5 py-1.5 text-[11px] text-white/85 backdrop-blur">
					<Loader2 className="size-3.5 animate-spin" />
					{STAGE[status.stage]} {Math.round(status.frac * 100)}%
					{status.note ? ` · ${status.note}` : ""}
				</div>
			)}
			{hover && hoverPhoto && (
				<div
					className="pointer-events-none absolute z-10 overflow-hidden rounded-lg bg-[#15181c]/95 shadow-xl ring-1 ring-white/15"
					style={{
						width: card.w,
						left: Math.min(hover.x + 14, (box?.width ?? 1e4) - card.w - 8),
						top:
							hover.y + 14 + card.h > (box?.height ?? 1e4)
								? Math.max(8, hover.y - 14 - card.h)
								: hover.y + 14,
					}}
					data-testid="roll-map-hover"
				>
					<img
						src={hoverPhoto.meta.src}
						alt=""
						className="block w-full bg-black object-cover"
						style={{ aspectRatio: aspectOf(hoverPhoto) }}
					/>
					<div className="space-y-1 px-2 py-1.5">
						<div className="flex items-center justify-between gap-2">
							<span className="truncate font-mono text-[11px] font-semibold text-white/90">
								{hoverPhoto.meta.id}
							</span>
							<HeadingChip photo={hoverPhoto} />
						</div>
						<div className="font-mono text-[10px] text-white/55">
							{fmtDay(hoverPhoto.meta)} {fmtTime(hoverPhoto.meta)}
						</div>
					</div>
				</div>
			)}
			<div className="absolute right-3 bottom-3 flex flex-wrap items-center gap-2 rounded-lg bg-black/60 px-3 py-2 text-[11px] text-white/80 backdrop-blur">
				<button
					type="button"
					onClick={overview}
					className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10"
					title={
						viewId
							? "Leave the photo for the overview (Esc)"
							: "Overview of the whole roll"
					}
					data-testid="roll-map-overview"
				>
					<Maximize className="size-3.5" />{" "}
					{viewId ? "Exit to overview" : "Overview"}
				</button>
				{viewId ? (
					<div
						className="flex items-center gap-0.5"
						data-testid="roll-map-walk"
					>
						<button
							type="button"
							onClick={() => step(-1)}
							className="rounded p-1 hover:bg-white/10"
							title="Previous photo by capture time (←)"
							aria-label="Previous photo"
						>
							<ChevronLeft className="size-3.5" />
						</button>
						<span className="w-9 text-center font-mono text-[10.5px] text-white/55">
							{at + 1}/{order.length}
						</span>
						<button
							type="button"
							onClick={() => step(1)}
							className="rounded p-1 hover:bg-white/10"
							title="Next photo by capture time (→)"
							aria-label="Next photo"
						>
							<ChevronRight className="size-3.5" />
						</button>
						<button
							type="button"
							onClick={() => go(engine?.photoAhead(1) ?? null)}
							className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10"
							title="Walk to the nearest photo in the direction you are looking (↑; ↓ behind)"
						>
							<ArrowUp className="size-3.5" /> Ahead
						</button>
					</div>
				) : (
					<button
						type="button"
						onClick={fly}
						disabled={!selectedId}
						className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10 disabled:opacity-40"
						title="Fly into the selected photographer's viewpoint"
					>
						<Eye className="size-3.5" /> Fly in
					</button>
				)}
				<button
					type="button"
					onClick={() => setGizmos((g) => !g)}
					className={`flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10 ${gizmos ? "" : "opacity-50"}`}
					title="Camera frustums"
				>
					<Frame className="size-3.5" /> Cameras
				</button>
				<button
					type="button"
					onClick={() => setNames((v) => !v)}
					className={`flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10 ${names ? "" : "opacity-50"}`}
					title="Place names"
					aria-pressed={names}
					data-testid="roll-names"
				>
					<Tag className="size-3.5" /> Names
				</button>
				<button
					type="button"
					onClick={() => setSpot3d((v) => !v)}
					disabled={spotVp === undefined}
					className={`flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10 disabled:opacity-40 ${spot3d ? "bg-white/15 text-white" : ""}`}
					title="Spot 3D: fuse the near field of this viewpoint's photos into 3D splats (needs the near-field service)"
					data-testid="roll-spot3d"
					data-on={spot3d ? "1" : undefined}
				>
					<Shapes className="size-3.5" /> Spot 3D
					{spot3d && spotNote && (
						<span
							className="font-mono text-[10px] text-white/55"
							data-testid="roll-spot3d-note"
						>
							{spotNote}
						</span>
					)}
				</button>
				<label
					className="flex items-center gap-1.5"
					title="The map under the photos (Muted / Dark let the photos stand out)"
				>
					Map
					<select
						value={basemap}
						onChange={(e) => {
							const b = e.target.value as RollBasemap;
							setBasemap(b);
							try {
								localStorage.setItem(BASEMAP_KEY, b);
							} catch {}
						}}
						className="rounded bg-white/10 px-1 py-0.5 text-inherit"
						data-testid="roll-basemap"
					>
						{ROLL_BASEMAPS.map((b) => (
							<option key={b.value} value={b.value} className="text-black">
								{b.label}
							</option>
						))}
					</select>
				</label>
				<label className="flex items-center gap-1.5">
					Drape
					<input
						type="range"
						min={0}
						max={1}
						step={0.05}
						value={opacity}
						onChange={(e) => setOpacity(+e.target.value)}
						className="w-16"
					/>
				</label>
				<label
					className="flex items-center gap-1.5"
					title="How far from each camera its photo is draped"
				>
					Reach {reachKm} km
					<input
						type="range"
						min={1}
						max={30}
						step={1}
						value={reachKm}
						onChange={(e) => setReachKm(+e.target.value)}
						className="w-16"
					/>
				</label>
				<label
					className="flex items-center gap-1.5"
					title="Soft blend ↔ best photo wins"
				>
					Blend
					<input
						type="range"
						min={1}
						max={8}
						step={0.5}
						value={sharp}
						onChange={(e) => setSharp(+e.target.value)}
						className="w-16"
					/>
				</label>
			</div>
		</div>
	);
}

const BASEMAP_KEY = storageKey("rollBasemap");

function loadBasemap(): RollBasemap {
	try {
		const v = localStorage.getItem(BASEMAP_KEY);
		if (ROLL_BASEMAPS.some((b) => b.value === v)) return v as RollBasemap;
	} catch {}
	return "satellite";
}

const STAGE: Record<RollMapStatus["stage"], string> = {
	terrain: "Loading terrain",
	photos: "Loading photos",
	ranges: "Computing occlusion",
	people: "Finding people",
	ready: "Ready",
};
