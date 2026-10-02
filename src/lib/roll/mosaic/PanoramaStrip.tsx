// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Panorama strip: photos of one viewpoint (or all) warped onto a cylindrical azimuth × elevation
// canvas at their poses, so overlapping frames stitch. WebGL for the photos, a 2D overlay for the
// compass ruler, elevation ticks and outlines. Behind the photos, a 2D canvas draws the viewpoint's terrain
// (DEM ridgelines traced from its eye, ridgelines.ts) in the same frame, so the view continues between
// frames and the photos can be checked against the real skyline; peak names ride on the overlay.
// Drag pans (wraps at 0/360), wheel zooms (unless zoom={false}), click selects. With `resizable`, a
// grip under the strip sets its height, remembered per browser.

import { Loader2, Maximize2, Mountain } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BRAND } from "#/brand/khipu";
import { storageKey } from "#/lib/ontology/core/storage";
import type { Roll, RollPhoto } from "../types";
import { PanoGL } from "./panoGL";
import {
	azExtent,
	buildMesh,
	hitsPhoto,
	type PanoMesh,
	wrapOffsets,
} from "./panorama";
import { aspectOf, compassPoint, fmtTime, vpColor } from "./style";
import {
	drawPeakLabels,
	drawTerrain,
	drawTerrainOnPhotos,
	type PreparedTerrain,
	prepareTerrain,
} from "./terrainLayer";
import { viewpointEye, viewpointTerrain } from "./viewpointTerrain";

type Props = {
	roll: Roll;
	/** Photos that pass the time filter. */
	photos: RollPhoto[];
	selectedId: string | null;
	onSelect: (id: string | null) => void;
	className?: string;
	height?: number;
	/** Size the strip's height to the photos at the fitted zoom, so the default view crops none of them. */
	fitHeight?: boolean;
	/** Wheel zoom. Off (landing page) the wheel and vertical swipes scroll the page; drag still pans. */
	zoom?: boolean;
	/** A grip under the strip resizes it vertically; the height is remembered per browser. */
	resizable?: boolean;
};

type Mode = number | "all";
type View = { az0: number; elc: number; ppd: number };

const RULER = 22;
const TERRAIN_FADE_MS = 700;
const TERRAIN_KEY = storageKey("panoTerrain");
const HEIGHT_KEY = storageKey("panoHeight");
const HEIGHT_MIN = 160;
const HEIGHT_MAX = 1200;
const HEIGHT_STEP = 20;

const clampHeight = (h: number) =>
	Math.round(Math.max(HEIGHT_MIN, Math.min(HEIGHT_MAX, h)));

type PeakLabel = ReturnType<typeof drawPeakLabels>[number];
const MAX_PPD = 80;

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 45, 90];
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

export function PanoramaStrip({
	roll,
	photos,
	selectedId,
	onSelect,
	className = "",
	height = 300,
	fitHeight = false,
	zoom = true,
	resizable = false,
}: Props) {
	const [autoH, setAutoH] = useState<number | null>(null);
	// user-chosen height (resizable); read after mount so the server render and hydration agree
	const [userH, setUserH] = useState<number | null>(null);
	useEffect(() => {
		if (!resizable) return;
		try {
			const h = Number(localStorage.getItem(HEIGHT_KEY));
			if (h) setUserH(clampHeight(h));
		} catch {}
	}, [resizable]);
	const resize = (h: number | null) => {
		const next = h == null ? null : clampHeight(h);
		setUserH(next);
		try {
			if (next == null) localStorage.removeItem(HEIGHT_KEY);
			else localStorage.setItem(HEIGHT_KEY, String(next));
		} catch {}
	};
	const resizeDrag = useRef<{ y: number; h: number } | null>(null);
	const wrapRef = useRef<HTMLDivElement>(null);
	const bgRef = useRef<HTMLCanvasElement>(null);
	const glRef = useRef<HTMLCanvasElement>(null);
	const ovRef = useRef<HTMLCanvasElement>(null);
	const renderer = useRef<PanoGL | null>(null);
	const [glError, setGlError] = useState<string | null>(null);
	const [hover, setHover] = useState<{
		id: string;
		x: number;
		y: number;
	} | null>(null);

	// viewpoints worth stitching (≥2 visible photos)
	const groups = useMemo(() => {
		const counts = new Map<number, number>();
		for (const p of photos)
			counts.set(p.viewpoint, (counts.get(p.viewpoint) ?? 0) + 1);
		return [...counts.entries()]
			.filter(([, n]) => n >= 2)
			.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
	}, [photos]);
	const [mode, setMode] = useState<Mode>(() => groups[0]?.[0] ?? "all");
	const effMode: Mode =
		mode === "all" || groups.some(([v]) => v === mode)
			? mode
			: (groups[0]?.[0] ?? "all");
	const shown = useMemo(
		() =>
			effMode === "all"
				? photos
				: photos.filter((p) => p.viewpoint === effMode),
		[photos, effMode],
	);

	// the viewpoint's terrain, traced once per eye (all-photos mode mixes eyes, so it has none)
	const [terrainOn, setTerrainOn] = useState(() => {
		try {
			return localStorage.getItem(TERRAIN_KEY) !== "off";
		} catch {
			return true;
		}
	});
	const toggleTerrain = () =>
		setTerrainOn((on) => {
			try {
				localStorage.setItem(TERRAIN_KEY, on ? "off" : "on");
			} catch {}
			return !on;
		});
	const [terrain, setTerrain] = useState<{
		vp: number;
		prepared: PreparedTerrain | null;
		error?: string;
		at: number;
	} | null>(null);
	const vpIndex = typeof effMode === "number" ? effMode : null;
	const eye = useMemo(
		() =>
			vpIndex != null && roll.viewpoints[vpIndex]
				? viewpointEye(roll, roll.viewpoints[vpIndex])
				: null,
		[roll, vpIndex],
	);
	useEffect(() => {
		if (!eye || vpIndex == null || !terrainOn) return;
		let live = true;
		viewpointTerrain(eye).then(
			(t) => {
				// debug handle, like window.__roll
				window.__rollPanoTerrain = t;
				if (live)
					setTerrain({
						vp: vpIndex,
						prepared: prepareTerrain(t),
						at: performance.now(),
					});
			},
			(e) =>
				live &&
				setTerrain({
					vp: vpIndex,
					prepared: null,
					error: (e as Error).message,
					at: 0,
				}),
		);
		return () => {
			live = false;
		};
	}, [eye, vpIndex, terrainOn]);
	const shownTerrain =
		terrainOn && terrain && terrain.vp === vpIndex ? terrain : null;
	const terrainStatus: "off" | "none" | "loading" | "ready" | "error" =
		!terrainOn
			? "off"
			: vpIndex == null
				? "none"
				: !shownTerrain
					? "loading"
					: shownTerrain.prepared
						? "ready"
						: "error";
	const [hoverPeak, setHoverPeak] = useState<string | null>(null);
	const peakLabels = useRef<PeakLabel[]>([]);

	// meshes for every roll photo, keyed by pose so a re-pose rebuilds
	const meshCache = useRef(new Map<string, { key: string; mesh: PanoMesh }>());
	const meshes = useMemo(() => {
		const out = new Map<string, PanoMesh>();
		for (const p of roll.photos) {
			const key = `${p.pose.yaw},${p.pose.pitch},${p.pose.roll},${p.pose.vfov},${aspectOf(p)}`;
			let c = meshCache.current.get(p.meta.id);
			if (!c || c.key !== key) {
				c = { key, mesh: buildMesh(p.pose, aspectOf(p)) };
				meshCache.current.set(p.meta.id, c);
			}
			out.set(p.meta.id, c.mesh);
		}
		return out;
	}, [roll]);

	const view = useRef<View>({ az0: 0, elc: 0, ppd: 4 });
	const size = useRef({ w: 0, h: 0 });
	const state = useRef({
		shown,
		selectedId,
		hoverId: null as string | null,
		meshes,
		terrain: null as PreparedTerrain | null,
		terrainAt: 0,
		hoverPeak: null as string | null,
	});
	state.current.shown = shown;
	state.current.terrain = shownTerrain?.prepared ?? null;
	state.current.terrainAt = shownTerrain?.at ?? 0;
	state.current.hoverPeak = hoverPeak;
	state.current.selectedId = selectedId;
	state.current.meshes = meshes;
	state.current.hoverId = hover?.id ?? null;

	const frame = useRef(0);
	// offscreen: skip draws (the strip is event-driven, so this only saves resize/terrain-load redraws);
	// a redraw is requested when it scrolls back in
	const onScreen = useRef(true);
	const draw = useCallback(() => {
		frame.current = 0;
		if (!onScreen.current) return;
		const bg = bgRef.current;
		const gl = glRef.current;
		const ov = ovRef.current;
		const { w, h } = size.current;
		if (!bg || !gl || !ov || !w || !h) return;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		for (const c of [bg, gl, ov]) {
			const W = Math.round(w * dpr);
			const H = Math.round(h * dpr);
			if (c.width !== W || c.height !== H) {
				c.width = W;
				c.height = H;
			}
		}
		const { shown, selectedId, hoverId, meshes, terrain, terrainAt } =
			state.current;
		const v = view.current;
		const bgc = bg.getContext("2d");
		if (bgc) {
			bgc.setTransform(1, 0, 0, 1, 0, 0);
			bgc.clearRect(0, 0, bg.width, bg.height);
			if (terrain) {
				const fade = Math.min(
					1,
					(performance.now() - terrainAt) / TERRAIN_FADE_MS,
				);
				drawTerrain(bgc, dpr, w, h, v, terrain, fade);
				if (fade < 1) requestAnimationFrame(() => requestDrawRef.current());
			}
		}
		// capture order, then the selected photo, then the hovered one on top
		const order = [...shown].sort(
			(a, b) => rank(a.meta.id) - rank(b.meta.id) || a.t - b.t,
		);
		function rank(id: string) {
			return id === hoverId ? 2 : id === selectedId ? 1 : 0;
		}
		renderer.current?.draw(
			order.map((p) => ({ id: p.meta.id })),
			{ ...v, w, h, dpr },
		);
		peakLabels.current = drawOverlay(
			ov,
			dpr,
			w,
			h,
			v,
			order,
			meshes,
			selectedId,
			hoverId,
			terrain,
			terrain
				? Math.min(1, (performance.now() - terrainAt) / TERRAIN_FADE_MS)
				: 0,
			state.current.hoverPeak,
		);
	}, []);
	const requestDraw = useCallback(() => {
		if (!frame.current) frame.current = requestAnimationFrame(draw);
	}, [draw]);
	const requestDrawRef = useRef(requestDraw);
	requestDrawRef.current = requestDraw;

	useEffect(() => {
		const el = wrapRef.current;
		if (!el || typeof IntersectionObserver === "undefined") return;
		const io = new IntersectionObserver(
			([e]) => {
				onScreen.current = e.isIntersecting;
				if (e.isIntersecting) requestDraw();
			},
			{ rootMargin: "100px 0px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [requestDraw]);

	// WebGL lifetime
	useEffect(() => {
		const c = glRef.current;
		if (!c) return;
		try {
			renderer.current = new PanoGL(c, requestDraw);
		} catch (e) {
			setGlError((e as Error).message);
			return;
		}
		return () => {
			renderer.current?.dispose();
			renderer.current = null;
			cancelAnimationFrame(frame.current);
			frame.current = 0;
		};
	}, [requestDraw]);

	// register every roll photo (textures stay loaded when the group changes)
	useEffect(() => {
		const r = renderer.current;
		if (!r) return;
		for (const p of roll.photos) {
			const m = meshes.get(p.meta.id);
			if (m) r.set(p.meta.id, p.meta.src, m);
		}
		r.prune(new Set(roll.photos.map((p) => p.meta.id)));
		requestDraw();
	}, [roll, meshes, requestDraw]);

	const fit = useCallback(() => {
		const { w, h } = size.current;
		const ms = state.current.shown
			.map((p) => state.current.meshes.get(p.meta.id))
			.filter((m): m is PanoMesh => !!m);
		if (!w || !h) return;
		if (!ms.length) {
			view.current = { az0: 0, elc: 0, ppd: w / 360 };
			return requestDraw();
		}
		const [start, span] = azExtent(ms);
		const elMin = Math.min(...ms.map((m) => m.elMin));
		const elMax = Math.max(...ms.map((m) => m.elMax));
		const pad = 1.06;
		// never wider than one turn, so nothing shows twice
		const wFit = Math.max(w / 360, Math.min(MAX_PPD, w / (span * pad)));
		const ppd = fitHeight
			? wFit
			: Math.max(
					w / 360,
					Math.min(
						MAX_PPD,
						w / (span * pad),
						(h - RULER) / ((elMax - elMin) * pad),
					),
				);
		if (fitHeight) setAutoH(Math.round(RULER + (elMax - elMin) * pad * ppd));
		view.current = {
			az0: start + span / 2 - w / ppd / 2,
			elc: (elMin + elMax) / 2 + RULER / 2 / ppd,
			ppd,
		};
		requestDraw();
	}, [requestDraw, fitHeight]);

	// refit on a group switch (or when the strip goes from empty to shown); NOT on every time-filter
	// step, which made the view jump while dragging the scrubber
	const shownKey = `${effMode}|${shown.length > 0}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: refit keyed on the shown ids
	useEffect(() => {
		fit();
	}, [shownKey, fit]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: draw() reads these through state refs
	useEffect(() => {
		requestDraw();
	}, [selectedId, hover?.id, hoverPeak, shownTerrain, requestDraw]);

	// bring a selected photo into view (and into the strip's group); only reacts to selection changes
	const latest = useRef({ photos, effMode, groups, meshes });
	latest.current = { photos, effMode, groups, meshes };
	useEffect(() => {
		if (!selectedId) return;
		const { photos, effMode, groups, meshes } = latest.current;
		const p = photos.find((q) => q.meta.id === selectedId);
		if (!p) return;
		if (effMode !== "all" && p.viewpoint !== effMode) {
			setMode(groups.some(([v]) => v === p.viewpoint) ? p.viewpoint : "all");
			return;
		}
		const m = meshes.get(selectedId);
		const { w } = size.current;
		if (!m || !w) return;
		const v = view.current;
		const a1 = v.az0 + w / v.ppd;
		const inView = wrapOffsets(m.azMin, m.azMax, v.az0, a1).some(
			(o) => m.azMin + o >= v.az0 && m.azMax + o <= a1,
		);
		if (!inView) {
			v.az0 = (m.azMin + m.azMax) / 2 - w / v.ppd / 2;
			requestDraw();
		}
	}, [selectedId, requestDraw]);

	// size
	useEffect(() => {
		const el = wrapRef.current;
		if (!el) return;
		let first = true;
		const ro = new ResizeObserver(([e]) => {
			const wChanged = e.contentRect.width !== size.current.w;
			size.current = { w: e.contentRect.width, h: e.contentRect.height };
			// fitHeight: the height follows the width, so a new width refits
			if (first || (fitHeight && wChanged)) {
				first = false;
				fit();
			} else requestDraw();
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [fit, requestDraw, fitHeight]);

	// pointer → (az, el) and hit test (top-most first)
	const pick = useCallback((x: number, y: number) => {
		const v = view.current;
		const az = v.az0 + x / v.ppd;
		const el = v.elc + (size.current.h / 2 - y) / v.ppd;
		const { shown, selectedId, hoverId } = state.current;
		const order = [...shown].sort((a, b) => {
			const r = (id: string) =>
				id === hoverId ? 2 : id === selectedId ? 1 : 0;
			return r(b.meta.id) - r(a.meta.id) || b.t - a.t;
		});
		return (
			order.find((p) => hitsPhoto(p.pose, aspectOf(p), az, el))?.meta.id ?? null
		);
	}, []);

	const drag = useRef<{
		x: number;
		y: number;
		az0: number;
		elc: number;
		moved: boolean;
	} | null>(null);
	const local = (e: { clientX: number; clientY: number }) => {
		const r = wrapRef.current?.getBoundingClientRect();
		return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 0, y: 0 };
	};
	const onPointerDown = (e: React.PointerEvent) => {
		e.currentTarget.setPointerCapture(e.pointerId);
		drag.current = {
			x: e.clientX,
			y: e.clientY,
			az0: view.current.az0,
			elc: view.current.elc,
			moved: false,
		};
	};
	const onPointerMove = (e: React.PointerEvent) => {
		const d = drag.current;
		if (d) {
			const dx = e.clientX - d.x;
			const dy = e.clientY - d.y;
			if (Math.hypot(dx, dy) > 4) d.moved = true;
			if (d.moved) {
				const v = view.current;
				v.az0 = (((d.az0 - dx / v.ppd) % 360) + 360) % 360;
				v.elc = Math.max(-90, Math.min(90, d.elc + dy / v.ppd));
				requestDraw();
				return;
			}
		}
		const { x, y } = local(e);
		const id = y > RULER ? pick(x, y) : null;
		setHover((h) => (id ? { id, x, y } : h ? null : h));
		// a peak's label, leader or summit
		const peak = peakLabels.current.find(
			(q) =>
				y > RULER &&
				y < q.y + 8 &&
				(Math.abs(q.x - x) < 7 || (x >= q.x && x <= q.x1 && y < RULER + 28)),
		);
		setHoverPeak(peak?.peak.name ?? null);
	};
	const onPointerUp = (e: React.PointerEvent) => {
		const d = drag.current;
		drag.current = null;
		if (!d || d.moved) return;
		const { x, y } = local(e);
		onSelect(y > RULER ? pick(x, y) : selectedId);
	};

	// non-passive wheel: zoom about the cursor
	useEffect(() => {
		const el = wrapRef.current;
		if (!el || !zoom) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const r = el.getBoundingClientRect();
			const x = e.clientX - r.left;
			const y = e.clientY - r.top;
			const v = view.current;
			const { w, h } = size.current;
			const minPpd = w / 360;
			const ppd = Math.max(
				minPpd,
				Math.min(MAX_PPD, v.ppd * Math.exp(-e.deltaY * 0.0015)),
			);
			const az = v.az0 + x / v.ppd;
			const elAt = v.elc + (h / 2 - y) / v.ppd;
			view.current = {
				ppd,
				az0: az - x / ppd,
				elc: Math.max(-90, Math.min(90, elAt - (h / 2 - y) / ppd)),
			};
			requestDraw();
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [requestDraw, zoom]);

	const hovered = hover
		? roll.photos.find((p) => p.meta.id === hover.id)
		: null;

	const stripHeight = (resizable && userH) || (fitHeight && autoH) || height;

	return (
		<section
			className={`overflow-hidden rounded-xl bg-white/[0.03] ring-1 ring-white/8 ${className}`}
			data-testid="roll-panorama"
		>
			<div className="flex flex-wrap items-center gap-1.5 border-b border-white/8 px-3 py-2">
				<span className="mr-1 text-xs font-semibold text-white/70">
					Panorama
				</span>
				{groups.map(([vi, n]) => (
					<ModeChip
						key={vi}
						active={effMode === vi}
						onClick={() => setMode(vi)}
						color={vpColor(vi)}
					>
						Viewpoint {vi + 1} · {n}
					</ModeChip>
				))}
				<ModeChip active={effMode === "all"} onClick={() => setMode("all")}>
					All photos · {photos.length}
				</ModeChip>
				<button
					type="button"
					onClick={toggleTerrain}
					aria-pressed={terrainOn}
					data-testid="pano-terrain"
					data-status={terrainStatus}
					title={
						terrainStatus === "none"
							? "Terrain is traced per viewpoint: pick one"
							: terrainStatus === "error"
								? `Terrain failed: ${shownTerrain?.error ?? ""}`
								: terrainStatus === "loading"
									? "Tracing the ridgelines seen from this viewpoint…"
									: "Ridgelines and peaks traced from this viewpoint's eye over the DEM"
					}
					className={`ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition ${
						terrainOn
							? "text-[var(--rigi-glow)] hover:bg-white/8"
							: "text-white/45 hover:bg-white/8 hover:text-white"
					} ${terrainStatus === "none" ? "opacity-50" : ""}`}
				>
					{terrainStatus === "loading" ? (
						<Loader2 className="size-3 animate-spin" />
					) : (
						<Mountain className="size-3" />
					)}
					Terrain
					{terrainStatus === "error" && " !"}
				</button>
				<button
					type="button"
					onClick={fit}
					className=" inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-white/55 hover:bg-white/8 hover:text-white"
					title="Fit the photos (or double-click the panorama)"
				>
					<Maximize2 className="size-3" /> Fit
				</button>
			</div>
			<div
				ref={wrapRef}
				data-theme="dark"
				role="application"
				aria-label={`Panorama: drag to pan${zoom ? ", wheel to zoom" : ""}, click a photo to select it`}
				className={`relative cursor-grab select-none active:cursor-grabbing ${zoom ? "touch-none" : "touch-pan-y"}`}
				style={{ height: stripHeight }}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={() => {
					drag.current = null;
				}}
				onPointerLeave={() => {
					setHover(null);
					setHoverPeak(null);
				}}
				onDoubleClick={fit}
			>
				<canvas
					ref={bgRef}
					className="pointer-events-none absolute inset-0 size-full bg-[#0b0d10]"
				/>
				<canvas ref={glRef} className="absolute inset-0 size-full" />
				<canvas
					ref={ovRef}
					className="pointer-events-none absolute inset-0 size-full"
				/>
				{glError && (
					<p className="absolute inset-0 flex items-center justify-center text-xs text-white/50">
						Panorama needs WebGL2 ({glError})
					</p>
				)}
				{!shown.length && !glError && (
					<p className="absolute inset-0 flex items-center justify-center text-xs text-white/40">
						No photos in the selected time range.
					</p>
				)}
				{hovered && hover && !drag.current?.moved && (
					<div
						className="pointer-events-none absolute z-10 rounded-md bg-black/80 px-2 py-1 font-mono text-[10.5px] whitespace-nowrap text-white/85 ring-1 ring-white/10"
						style={{
							left: Math.min(hover.x + 14, (size.current.w || 0) - 190),
							top: Math.max(RULER + 4, hover.y - 34),
						}}
					>
						{hovered.meta.id} · {fmtTime(hovered.meta)} ·{" "}
						{Math.round(((hovered.pose.yaw % 360) + 360) % 360)}°{" "}
						{compassPoint(hovered.pose.yaw)}
					</div>
				)}
			</div>
			{resizable && (
				// biome-ignore lint/a11y/useSemanticElements: a focusable window splitter, which <hr> cannot be
				<div
					role="separator"
					tabIndex={0}
					aria-orientation="horizontal"
					aria-label="Resize panorama"
					aria-valuemin={HEIGHT_MIN}
					aria-valuemax={HEIGHT_MAX}
					aria-valuenow={stripHeight}
					title="Drag to resize · double-click to reset"
					data-testid="pano-resize"
					className="group flex h-3 cursor-ns-resize touch-none items-center justify-center border-t border-white/8 outline-none"
					onPointerDown={(e) => {
						resizeDrag.current = { y: e.clientY, h: stripHeight };
						e.currentTarget.setPointerCapture(e.pointerId);
					}}
					onPointerMove={(e) => {
						const d = resizeDrag.current;
						if (d) resize(d.h + e.clientY - d.y);
					}}
					onPointerUp={() => {
						resizeDrag.current = null;
					}}
					onPointerCancel={() => {
						resizeDrag.current = null;
					}}
					onDoubleClick={() => resize(null)}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown") resize(stripHeight + HEIGHT_STEP);
						else if (e.key === "ArrowUp") resize(stripHeight - HEIGHT_STEP);
						else return;
						e.preventDefault();
					}}
				>
					<span className="h-[3px] w-10 rounded-full bg-white/15 transition group-hover:bg-white/40 group-focus-visible:bg-white/70" />
				</div>
			)}
		</section>
	);
}

function ModeChip({
	active,
	onClick,
	color,
	children,
}: {
	active: boolean;
	onClick: () => void;
	color?: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] ring-1 transition ${
				active
					? "bg-white/12 text-white ring-white/25"
					: "text-white/55 ring-white/10 hover:text-white/85"
			}`}
		>
			{color && (
				<span className="size-2 rounded-full" style={{ background: color }} />
			)}
			{children}
		</button>
	);
}

/** Ruler, elevation ticks and photo outlines, in CSS px on a dpr-scaled canvas. */
function drawOverlay(
	c: HTMLCanvasElement,
	dpr: number,
	w: number,
	h: number,
	v: View,
	order: RollPhoto[],
	meshes: Map<string, PanoMesh>,
	selectedId: string | null,
	hoverId: string | null,
	terrain: PreparedTerrain | null,
	terrainFade: number,
	hoverPeak: string | null,
): PeakLabel[] {
	const g = c.getContext("2d");
	if (!g) return [];
	g.setTransform(dpr, 0, 0, dpr, 0, 0);
	g.clearRect(0, 0, w, h);
	const X = (az: number) => (az - v.az0) * v.ppd;
	const Y = (el: number) => h / 2 - (el - v.elc) * v.ppd;
	const a1 = v.az0 + w / v.ppd;

	// match cue: the DEM ridgelines over every aligned photo (a prior pose is a guess, so none there)
	if (terrain) {
		const clips: { path: Path2D; strength: number }[] = [];
		for (const p of order) {
			const m = meshes.get(p.meta.id);
			if (!m || p.poseSource === "prior") continue;
			const path = new Path2D();
			for (const off of wrapOffsets(m.azMin, m.azMax, v.az0, a1)) {
				for (let i = 0; i < m.outline.length; i += 2) {
					const x = X(m.outline[i] + off);
					const y = Y(m.outline[i + 1]);
					if (i) path.lineTo(x, y);
					else path.moveTo(x, y);
				}
				path.closePath();
			}
			const focus = p.meta.id === hoverId || p.meta.id === selectedId;
			clips.push({ path, strength: focus ? 1.45 : 1 });
		}
		drawTerrainOnPhotos(g, dpr, w, h, v, terrain, clips, terrainFade);
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	// outlines: faint per viewpoint, then selected and hovered
	const outline = (
		p: RollPhoto,
		stroke: string,
		width: number,
		dash: number[] = [],
	) => {
		const m = meshes.get(p.meta.id);
		if (!m) return;
		g.strokeStyle = stroke;
		g.lineWidth = width;
		g.setLineDash(dash);
		for (const off of wrapOffsets(m.azMin, m.azMax, v.az0, a1)) {
			g.beginPath();
			for (let i = 0; i < m.outline.length; i += 2) {
				const x = X(m.outline[i] + off);
				const y = Y(m.outline[i + 1]);
				if (i) g.lineTo(x, y);
				else g.moveTo(x, y);
			}
			g.closePath();
			g.stroke();
		}
		g.setLineDash([]);
	};
	g.globalAlpha = 0.45;
	for (const p of order)
		if (p.meta.id !== selectedId && p.meta.id !== hoverId)
			outline(p, vpColor(p.viewpoint), 1);
	g.globalAlpha = 1;
	const sel = order.find((p) => p.meta.id === selectedId);
	if (sel) outline(sel, BRAND.glow, 2.5);
	const hov = order.find((p) => p.meta.id === hoverId);
	if (hov) outline(hov, "#ffffff", 2);

	// peak names from the viewpoint's terrain, above the photos (they name what the photos show)
	const labels = terrain
		? drawPeakLabels(g, w, h, v, terrain, RULER, hoverPeak)
		: [];

	// elevation ticks on the left
	const eStep = TICK_STEPS.find((s) => s * v.ppd >= 40) ?? 90;
	g.font = "9.5px ui-monospace, monospace";
	g.textAlign = "left";
	g.fillStyle = "rgba(255,255,255,0.45)";
	for (
		let e = Math.ceil((v.elc - h / 2 / v.ppd) / eStep) * eStep;
		e <= v.elc + h / 2 / v.ppd;
		e += eStep
	) {
		const y = Y(e);
		if (y < RULER + 8) continue;
		g.fillRect(0, y, 5, 1);
		g.fillText(`${e > 0 ? "+" : ""}${e}°`, 7, y + 3);
	}

	// compass ruler along the top
	g.fillStyle = "rgba(8,10,12,0.78)";
	g.fillRect(0, 0, w, RULER);
	g.fillStyle = "rgba(255,255,255,0.12)";
	g.fillRect(0, RULER - 1, w, 1);
	const step = TICK_STEPS.find((s) => s * v.ppd >= 64) ?? 90;
	const minor = step >= 10 ? step / 5 : step / 2;
	g.fillStyle = "rgba(255,255,255,0.35)";
	for (let a = Math.ceil(v.az0 / minor) * minor; a <= a1; a += minor)
		g.fillRect(Math.round(X(a)), RULER - 4, 1, 3);
	g.font = "600 10.5px ui-sans-serif, system-ui, sans-serif";
	g.textAlign = "center";
	for (let a = Math.ceil(v.az0 / step) * step; a <= a1; a += step) {
		const x = Math.round(X(a));
		const deg = ((Math.round(a) % 360) + 360) % 360;
		const card = CARDINAL[deg];
		// cardinals in bright paper, not the brand orange (orange = selection only)
		g.fillStyle = card ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.55)";
		g.fillRect(x, RULER - 7, 1, 6);
		g.fillText(card ?? `${deg}°`, x, 12);
	}
	return labels;
}
