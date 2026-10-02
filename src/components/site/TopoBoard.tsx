// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { BRAND, brandAlpha } from "#/brand/khipu";
import { latToTileY, lonToTileX } from "#/lib/dem/tiles";
import type { DemoManifest } from "#/lib/demo";
import { SWISSTOPO_CREDIT } from "#/lib/licences/attribution";
import { pixelkarteUrl } from "#/lib/licences/imagery";
import { storageKey } from "#/lib/ontology/core/storage";
import { MapFurniture } from "#/lib/terroir/roll/MapFurniture";
import {
	BLEED_BOTTOM,
	BLEED_TOP,
	clampCardPosition,
	normaliseCardPosition,
	restoreCardPosition,
} from "./topo-layout";

// Landing-page board: the sample trip's photos as cards on the swisstopo map, each tied to where
// it was taken by a line and a view wedge (its solved heading and field of view). Drag a card to
// move it, drag the map to pan, click a card to open the photo. The cards, their lines and the
// camera pins sit in a layer that reaches past the map (wide at the sides, a little above and
// below, never past the window), so cards near the edge cross onto the surrounding plan.

const SHARP_KEY = storageKey("topoSharp");
const BLEED_SIDE = 160;
const CARD_GAP = 10;

/** Card footprint in CSS px: the image plus its white frame (p-1.5 pb-5). */
const cardBox = (aspect: number) => {
	const w = aspect >= 1 ? 168 : 120;
	return { w, h: w / aspect + 26 };
};
const Z = 14;
const TILE = 256;
const WEDGE_M = 1100;

const worldPx = (lat: number, lon: number) => ({
	x: lonToTileX(lon, Z) * TILE,
	y: latToTileY(lat, Z) * TILE,
});
const metresPerPx = (lat: number) =>
	(156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** Z;

type Card = { id: string; x: number; y: number; r: number };

export function TopoBoard({
	demo,
	className,
	onPan,
}: {
	demo: DemoManifest;
	className?: string;
	/** Called on every map drag move with the pan offset (CSS px), for content that moves with it. */
	onPan?: (p: { x: number; y: number }) => void;
}) {
	const navigate = useNavigate();
	const ref = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ w: 1100, h: 620 });
	// how far the card layer may reach left and right of the board without leaving the window
	const [side, setSide] = useState(BLEED_SIDE);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const ro = new ResizeObserver(([e]) => {
			setSize({ w: e.contentRect.width, h: e.contentRect.height });
			const r = el.getBoundingClientRect();
			const room = Math.min(r.left, window.innerWidth - r.right) - 8;
			setSide(Math.max(0, Math.min(BLEED_SIDE, room)));
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// board coordinates: origin = the photos' centroid, x east, y south (screen), in z14 pixels
	const geo = useMemo(() => {
		const ps = demo.photos;
		const lat = ps.reduce((s, p) => s + p.lat, 0) / ps.length;
		const lon = ps.reduce((s, p) => s + p.lon, 0) / ps.length;
		const c = worldPx(lat, lon);
		const mpp = metresPerPx(lat);
		const cams = ps.map((p) => {
			const w = worldPx(p.lat, p.lon);
			const pose = demo.poses[p.id]?.pose;
			const yaw = pose?.yaw ?? p.heading ?? 0;
			const vfov = pose?.vfov ?? p.vfov;
			const aspect = p.width / p.height;
			const hfov =
				(2 * Math.atan(Math.tan((vfov * Math.PI) / 360) * aspect) * 180) /
				Math.PI;
			return { id: p.id, x: w.x - c.x, y: w.y - c.y, yaw, hfov, aspect };
		});
		return { c, mpp, cams };
	}, [demo]);

	// first layout: cards fanned out in the direction each photo looks, in two rings so neighbours
	// with near-equal headings don't stack; the outer ring straddles the map's edge. Overlapping
	// cards are then pushed apart and every card is kept inside the bleed area.
	const [cards, setCards] = useState<Card[]>([]);
	// cards the visitor has dragged, as fractions of the board size (CR-W6: a resize, e.g. a phone
	// rotating, re-runs the fan-out layout but keeps these where the user put them)
	const draggedNorm = useRef(new Map<string, { x: number; y: number }>());
	useEffect(() => {
		const R = Math.min(size.w, size.h * 1.6) * 0.36;
		const sorted = [...geo.cams].sort((a, b) => a.yaw - b.yaw);
		const placed = sorted.map((cam, i) => {
			const ring = i % 2 ? 0.72 : 1.18;
			const a = ((cam.yaw + (i % 3) * 6 - 6) * Math.PI) / 180;
			return {
				card: {
					id: cam.id,
					x: Math.sin(a) * R * ring * 1.25,
					y: -Math.cos(a) * R * ring * 0.8,
					r: ((i * 37) % 11) - 5,
				},
				box: cardBox(cam.aspect),
			};
		});
		const clamp = ({ card, box }: (typeof placed)[number]) => {
			const p = clampCardPosition(card, box, { w: size.w, h: size.h }, side);
			card.x = p.x;
			card.y = p.y;
		};
		for (let it = 0; it < 60; it++) {
			let moved = false;
			for (let i = 0; i < placed.length; i++)
				for (let j = i + 1; j < placed.length; j++) {
					const a = placed[i];
					const b = placed[j];
					const dx = b.card.x - a.card.x;
					const dy = b.card.y - a.card.y;
					const ox = (a.box.w + b.box.w) / 2 + CARD_GAP - Math.abs(dx);
					const oy = (a.box.h + b.box.h) / 2 + CARD_GAP - Math.abs(dy);
					if (ox <= 0 || oy <= 0) continue;
					moved = true;
					// separate along the axis that needs the smaller push
					if (ox < oy) {
						const s = (dx < 0 ? -ox : ox) / 2;
						a.card.x -= s;
						b.card.x += s;
					} else {
						const s = (dy < 0 ? -oy : oy) / 2;
						a.card.y -= s;
						b.card.y += s;
					}
				}
			for (const p of placed) clamp(p);
			if (!moved) break;
		}
		for (const { card, box } of placed) {
			const norm = draggedNorm.current.get(card.id);
			if (!norm) continue;
			const p = restoreCardPosition(norm, box, { w: size.w, h: size.h }, side);
			card.x = p.x;
			card.y = p.y;
		}
		setCards(placed.map((p) => p.card));
	}, [geo, size.w, size.h, side]);

	// Tiles load only once the board is near the viewport (it sits far down the landing page).
	const [near, setNear] = useState(false);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const io = new IntersectionObserver(
			([e]) => {
				if (e.isIntersecting) {
					setNear(true);
					io.disconnect();
				}
			},
			{ rootMargin: "300px 0px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, []);

	// Dragging mutates the DOM directly (pan layer transform, card position, its line) and commits
	// to state on release, so a pointer move never re-renders the tiles, wedges and cards.
	const panRef = useRef({ x: 0, y: 0 });
	const layerRef = useRef<HTMLDivElement>(null);
	const cardLayerRef = useRef<HTMLDivElement>(null);
	const cardEls = useRef(new Map<string, HTMLButtonElement>());
	const lineEls = useRef(new Map<string, SVGLineElement>());
	const [, setPan] = useState(panRef.current);
	// tile set follows the pan in whole-tile steps only
	const [tilePan, setTilePan] = useState({ x: 0, y: 0 });
	const [active, setActive] = useState<string | null>(null);
	const [order, setOrder] = useState<string[]>([]);
	const drag = useRef<{
		kind: "card" | "map";
		id?: string;
		sx: number;
		sy: number;
		ox: number;
		oy: number;
		moved: boolean;
	} | null>(null);

	const onDown = (e: React.PointerEvent, id?: string) => {
		e.stopPropagation();
		(e.currentTarget as Element).setPointerCapture(e.pointerId);
		const card = id ? cards.find((c) => c.id === id) : null;
		drag.current = {
			kind: id ? "card" : "map",
			id,
			sx: e.clientX,
			sy: e.clientY,
			ox: card ? card.x : panRef.current.x,
			oy: card ? card.y : panRef.current.y,
			moved: false,
		};
		if (ref.current) ref.current.style.cursor = "grabbing";
		if (id) raise(id);
		else setPanLayersPromoted(true);
	};
	// promote the moving layers only for the length of a pan (no permanent memory cost)
	const setPanLayersPromoted = (on: boolean) => {
		const v = on ? "transform" : "";
		if (layerRef.current) layerRef.current.style.willChange = v;
		if (cardLayerRef.current) cardLayerRef.current.style.willChange = v;
	};
	// hover or grab brings a card to the top of the stack (and it stays there)
	const raise = (id: string) => {
		setActive(id);
		setOrder((o) => (o.at(-1) === id ? o : [...o.filter((x) => x !== id), id]));
	};
	const onMove = (e: React.PointerEvent) => {
		const d = drag.current;
		if (!d) return;
		const dx = e.clientX - d.sx;
		const dy = e.clientY - d.sy;
		if (Math.hypot(dx, dy) > 4) d.moved = true;
		if (d.kind === "map") {
			const p = { x: d.ox + dx, y: d.oy + dy };
			panRef.current = p;
			onPan?.(p);
			if (layerRef.current)
				layerRef.current.style.transform = `translate(${size.w / 2 + p.x}px, ${size.h / 2 + p.y}px)`;
			if (cardLayerRef.current)
				cardLayerRef.current.style.transform = `translate(${side + size.w / 2 + p.x}px, ${BLEED_TOP + size.h / 2 + p.y}px)`;
			const qx = Math.round(p.x / S) * S;
			const qy = Math.round(p.y / S) * S;
			setTilePan((t) => (t.x === qx && t.y === qy ? t : { x: qx, y: qy }));
		} else if (d.id) {
			// mutate in place: the same objects are committed on release
			const c = cards.find((k) => k.id === d.id);
			if (!c) return;
			c.x = d.ox + dx;
			c.y = d.oy + dy;
			const m = cardEls.current.get(c.id);
			const cam = geo.cams.find((k) => k.id === c.id);
			if (m && cam) {
				const { w } = cardBox(cam.aspect);
				m.style.left = `${c.x - w / 2}px`;
				m.style.top = `${c.y - w / cam.aspect / 2 - 10}px`;
			}
			const ln = lineEls.current.get(c.id);
			if (ln) {
				ln.setAttribute("x2", String(c.x));
				ln.setAttribute("y2", String(c.y));
			}
		}
	};
	const endDrag = () => {
		const d = drag.current;
		drag.current = null;
		setPanLayersPromoted(false);
		if (ref.current) ref.current.style.cursor = "grab";
		if (d?.kind === "map") setPan({ ...panRef.current });
		else if (d?.moved) {
			const c = cards.find((k) => k.id === d.id);
			if (c) draggedNorm.current.set(c.id, normaliseCardPosition(c, size));
			setCards((cs) => [...cs]);
		}
		return d;
	};
	// a cancelled pointer (the browser took the touch over for scrolling) ends the drag but is not a click
	const onCancel = () => {
		endDrag();
	};
	const onUp = () => {
		const d = endDrag();
		if (d?.kind === "card" && d.id && !d.moved)
			navigate({ to: "/photo/$id", params: { id: d.id } });
	};

	// "Sharp map" (additive, off by default): on a hi-dpi screen request the z+1 swisstopo tiles
	// (same provider) and draw each at half size, so the linework is rendered at device resolution
	// instead of a 2x upscale; the price is map labels at half their CSS size.
	const [sharp, setSharp] = useState(false);
	const [hiDpi, setHiDpi] = useState(false);
	useEffect(() => {
		setHiDpi((window.devicePixelRatio || 1) >= 1.5);
		try {
			setSharp(localStorage.getItem(SHARP_KEY) === "1");
		} catch {}
	}, []);
	const sharpK = sharp && hiDpi ? 1 : 0;
	const S = TILE / 2 ** sharpK;

	// tiles covering the board (plus a margin for panning)
	const ox = size.w / 2 + panRef.current.x;
	const oy = size.h / 2 + panRef.current.y;
	const tiles = useMemo(() => {
		if (!near) return [];
		const out: { x: number; y: number; key: string; url: string }[] = [];
		const left = geo.c.x - size.w / 2 - tilePan.x - S;
		const top = geo.c.y - size.h / 2 - tilePan.y - S;
		const tx0 = Math.floor(left / S);
		const ty0 = Math.floor(top / S);
		const nx = Math.ceil((size.w + 2 * S) / S) + 1;
		const ny = Math.ceil((size.h + 2 * S) / S) + 1;
		for (let i = 0; i < nx; i++)
			for (let j = 0; j < ny; j++) {
				const tx = tx0 + i;
				const ty = ty0 + j;
				out.push({
					x: tx * S - geo.c.x,
					y: ty * S - geo.c.y,
					key: `${Z + sharpK}/${tx}/${ty}`,
					url: pixelkarteUrl(Z + sharpK, tx, ty),
				});
			}
		return out;
	}, [geo.c, size, tilePan, S, sharpK, near]);

	const wedgePx = WEDGE_M / geo.mpp;
	const camOf = (id: string) => geo.cams.find((c) => c.id === id);
	const metaOf = (id: string) => demo.photos.find((p) => p.id === id);
	const z = (id: string) => 10 + Math.max(0, order.indexOf(id));

	return (
		<div
			ref={ref}
			data-theme="dark"
			className={`relative touch-pan-y select-none ${className ?? ""}`}
			onPointerDown={(e) => onDown(e)}
			onPointerMove={onMove}
			onPointerUp={onUp}
			onPointerCancel={onCancel}
			style={{ cursor: "grab" }}
			data-testid="topo-board"
		>
			{/* the map, clipped to the board */}
			<div className="absolute inset-0 overflow-hidden rounded-[inherit] bg-[var(--rigi-paper)]">
				<div
					className="absolute"
					ref={layerRef}
					style={{ transform: `translate(${ox}px, ${oy}px)` }}
				>
					{/* one filter pass over the tile layer instead of one per tile */}
					<div style={{ filter: "saturate(0.8) contrast(0.95)" }}>
						{tiles.map((t) => (
							<img
								key={t.key}
								src={t.url}
								alt=""
								draggable={false}
								decoding="async"
								className="absolute max-w-none"
								style={{
									left: t.x,
									top: t.y,
									width: S,
									height: S,
								}}
							/>
						))}
					</div>
					<svg
						className="pointer-events-none absolute overflow-visible"
						style={{ left: 0, top: 0 }}
						width={1}
						height={1}
						aria-hidden="true"
					>
						{geo.cams.map((cam) => {
							const on = active === cam.id;
							const a0 = ((cam.yaw - cam.hfov / 2) * Math.PI) / 180;
							const a1 = ((cam.yaw + cam.hfov / 2) * Math.PI) / 180;
							const r = wedgePx;
							return (
								<path
									key={cam.id}
									d={`M${cam.x},${cam.y} L${cam.x + Math.sin(a0) * r},${cam.y - Math.cos(a0) * r} A${r},${r} 0 0 1 ${cam.x + Math.sin(a1) * r},${cam.y - Math.cos(a1) * r} Z`}
									fill={
										on ? brandAlpha("ember", 0.3) : brandAlpha("ember", 0.08)
									}
									stroke={
										on ? brandAlpha("ember", 0.9) : brandAlpha("ember", 0.25)
									}
									strokeWidth={on ? 1.5 : 1}
									style={{ transition: "fill .2s, stroke .2s" }}
								/>
							);
						})}
					</svg>
				</div>
			</div>
			{/* cards, lines and pins: clipped a little outside the board so they cross onto the plan */}
			<div
				className="pointer-events-none absolute overflow-hidden"
				style={{
					top: -BLEED_TOP,
					bottom: -BLEED_BOTTOM,
					left: -side,
					right: -side,
				}}
			>
				<div
					className="absolute"
					ref={cardLayerRef}
					style={{
						transform: `translate(${side + ox}px, ${BLEED_TOP + oy}px)`,
					}}
				>
					<svg
						className="absolute overflow-visible"
						style={{ left: 0, top: 0 }}
						width={1}
						height={1}
						aria-hidden="true"
					>
						{cards.map((c) => {
							const cam = camOf(c.id);
							if (!cam) return null;
							return (
								<line
									key={c.id}
									ref={(el) => {
										if (el) lineEls.current.set(c.id, el);
										else lineEls.current.delete(c.id);
									}}
									x1={cam.x}
									y1={cam.y}
									x2={c.x}
									y2={c.y}
									stroke={
										active === c.id
											? "var(--rigi-ember)"
											: brandAlpha("umber", 0.45)
									}
									strokeWidth={active === c.id ? 2 : 1}
									strokeDasharray={active === c.id ? undefined : "3 3"}
								/>
							);
						})}
						{geo.cams.map((cam) => (
							<circle
								key={cam.id}
								cx={cam.x}
								cy={cam.y}
								r={active === cam.id ? 6 : 4}
								fill={BRAND.glow}
								stroke={BRAND.umber}
								strokeWidth={1.5}
							/>
						))}
					</svg>
					{cards.map((c) => {
						const m = metaOf(c.id);
						const cam = camOf(c.id);
						if (!m || !cam) return null;
						const { w } = cardBox(cam.aspect);
						const on = active === c.id;
						return (
							<button
								key={c.id}
								ref={(el) => {
									if (el) cardEls.current.set(c.id, el);
									else cardEls.current.delete(c.id);
								}}
								type="button"
								aria-label={`Open ${c.id}`}
								onPointerDown={(e) => onDown(e, c.id)}
								onPointerEnter={() => !drag.current && raise(c.id)}
								onPointerLeave={() => !drag.current && setActive(null)}
								onKeyDown={(e) =>
									e.key === "Enter" &&
									navigate({ to: "/photo/$id", params: { id: c.id } })
								}
								className="pointer-events-auto absolute cursor-grab rounded-[3px] bg-white p-1.5 pb-5 shadow-[0_8px_24px_rgba(0,0,0,0.35)] transition-[box-shadow,scale] active:cursor-grabbing"
								style={{
									left: c.x - w / 2,
									top: c.y - w / cam.aspect / 2 - 10,
									width: w,
									zIndex: z(c.id),
									rotate: `${on ? 0 : c.r}deg`,
									scale: on ? "1.06" : "1",
								}}
							>
								<img
									src={m.thumb}
									alt=""
									loading="lazy"
									decoding="async"
									draggable={false}
									className="block w-full"
									style={{ aspectRatio: cam.aspect }}
								/>
								<span className="absolute inset-x-0 bottom-1 text-center font-mono text-[9px] text-black/55">
									{Math.round(cam.yaw)}° · {fmtTime(m.takenAt, m.tzOffset)}
								</span>
							</button>
						);
					})}
				</div>
			</div>
			<MapFurniture mPerPx={geo.mpp} className="m-2 rounded" />
			{hiDpi && (
				<button
					type="button"
					onPointerDown={(e) => e.stopPropagation()}
					onClick={() => {
						const v = !sharp;
						setSharp(v);
						try {
							localStorage.setItem(SHARP_KEY, v ? "1" : "0");
						} catch {}
					}}
					aria-pressed={sharp}
					title="Draw the swisstopo map at device resolution (sharper linework, smaller labels)"
					className={`absolute top-2 right-2 rounded bg-white/75 px-1.5 py-0.5 text-[10px] text-black/70 hover:bg-white ${sharp ? "ring-1 ring-black/40" : ""}`}
				>
					Sharp map
				</button>
			)}
			<span className="absolute right-2 bottom-2 rounded bg-white/75 px-1.5 py-0.5 text-[10px] text-black/60">
				Map ©{" "}
				<a
					href={SWISSTOPO_CREDIT.href}
					target="_blank"
					rel="noreferrer"
					title={SWISSTOPO_CREDIT.licence}
					onPointerDown={(e) => e.stopPropagation()}
				>
					{SWISSTOPO_CREDIT.label}
				</a>
			</span>
		</div>
	);
}

function fmtTime(iso: string, tz?: string | null) {
	const m = tz?.match(/([+-])(\d\d):(\d\d)/);
	const off = m
		? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
		: 0;
	const d = new Date(Date.parse(iso) + off * 60000);
	return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
