// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { BRAND, brandAlpha } from "#/brand/khipu";
import type { DemoManifest } from "#/lib/demo";
import { pixelkarteUrl } from "#/lib/licences/imagery";
import { storageKey } from "#/lib/ontology/core/storage";
import { MapFurniture } from "#/lib/terroir/roll/MapFurniture";

// Landing-page board: the sample trip's photos as cards on the swisstopo map, each tied to where
// it was taken by a line and a view wedge (its solved heading and field of view). Drag a card to
// move it, drag the map to pan, click a card to open the photo.

const SHARP_KEY = storageKey("topoSharp");
const Z = 14;
const TILE = 256;
const WEDGE_M = 1100;

const worldPx = (lat: number, lon: number) => {
	const n = TILE * 2 ** Z;
	const s = Math.sin((lat * Math.PI) / 180);
	return {
		x: ((lon + 180) / 360) * n,
		y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
	};
};
const metresPerPx = (lat: number) =>
	(156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** Z;

type Card = { id: string; x: number; y: number; r: number };

export function TopoBoard({
	demo,
	className,
}: {
	demo: DemoManifest;
	className?: string;
}) {
	const navigate = useNavigate();
	const ref = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ w: 1100, h: 620 });
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const ro = new ResizeObserver(([e]) =>
			setSize({ w: e.contentRect.width, h: e.contentRect.height }),
		);
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
	// with near-equal headings don't stack
	const [cards, setCards] = useState<Card[]>([]);
	useEffect(() => {
		const R = Math.min(size.w, size.h * 1.6) * 0.36;
		const sorted = [...geo.cams].sort((a, b) => a.yaw - b.yaw);
		setCards(
			sorted.map((cam, i) => {
				const ring = i % 2 ? 0.72 : 1;
				const a = ((cam.yaw + (i % 3) * 6 - 6) * Math.PI) / 180;
				return {
					id: cam.id,
					x: Math.sin(a) * R * ring * 1.25,
					y: -Math.cos(a) * R * ring * 0.8,
					r: ((i * 37) % 11) - 5,
				};
			}),
		);
	}, [geo, size.w, size.h]);

	const [pan, setPan] = useState({ x: 0, y: 0 });
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
			ox: card ? card.x : pan.x,
			oy: card ? card.y : pan.y,
			moved: false,
		};
		if (id) {
			setActive(id);
			setOrder((o) => [...o.filter((x) => x !== id), id]);
		}
	};
	const onMove = (e: React.PointerEvent) => {
		const d = drag.current;
		if (!d) return;
		const dx = e.clientX - d.sx;
		const dy = e.clientY - d.sy;
		if (Math.hypot(dx, dy) > 4) d.moved = true;
		if (d.kind === "map") setPan({ x: d.ox + dx, y: d.oy + dy });
		else
			setCards((cs) =>
				cs.map((c) =>
					c.id === d.id ? { ...c, x: d.ox + dx, y: d.oy + dy } : c,
				),
			);
	};
	const onUp = () => {
		const d = drag.current;
		drag.current = null;
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
	const ox = size.w / 2 + pan.x;
	const oy = size.h / 2 + pan.y;
	const tiles = useMemo(() => {
		const out: { x: number; y: number; key: string; url: string }[] = [];
		const left = geo.c.x - size.w / 2 - pan.x - S;
		const top = geo.c.y - size.h / 2 - pan.y - S;
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
	}, [geo.c, size, pan, S, sharpK]);

	const wedgePx = WEDGE_M / geo.mpp;
	const camOf = (id: string) => geo.cams.find((c) => c.id === id);
	const metaOf = (id: string) => demo.photos.find((p) => p.id === id);
	const z = (id: string) => 10 + Math.max(0, order.indexOf(id));

	return (
		<div
			ref={ref}
			className={`relative touch-pan-y overflow-hidden bg-[var(--rigi-paper)] select-none ${className ?? ""}`}
			onPointerDown={(e) => onDown(e)}
			onPointerMove={onMove}
			onPointerUp={onUp}
			onPointerCancel={onUp}
			style={{ cursor: drag.current?.kind === "map" ? "grabbing" : "grab" }}
			data-testid="topo-board"
		>
			<div
				className="absolute"
				style={{ transform: `translate(${ox}px, ${oy}px)` }}
			>
				{tiles.map((t) => (
					<img
						key={t.key}
						src={t.url}
						alt=""
						draggable={false}
						className="absolute max-w-none"
						style={{
							left: t.x,
							top: t.y,
							width: S,
							height: S,
							filter: "saturate(0.8) contrast(0.95)",
						}}
					/>
				))}
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
								fill={on ? brandAlpha("ember", 0.3) : brandAlpha("ember", 0.08)}
								stroke={
									on ? brandAlpha("ember", 0.9) : brandAlpha("ember", 0.25)
								}
								strokeWidth={on ? 1.5 : 1}
								style={{ transition: "fill .2s, stroke .2s" }}
							/>
						);
					})}
					{cards.map((c) => {
						const cam = camOf(c.id);
						if (!cam) return null;
						return (
							<line
								key={c.id}
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
					const w = cam.aspect >= 1 ? 168 : 120;
					const on = active === c.id;
					return (
						<button
							key={c.id}
							type="button"
							aria-label={`Open ${c.id}`}
							onPointerDown={(e) => onDown(e, c.id)}
							onPointerEnter={() => !drag.current && setActive(c.id)}
							onPointerLeave={() => !drag.current && setActive(null)}
							onKeyDown={(e) =>
								e.key === "Enter" &&
								navigate({ to: "/photo/$id", params: { id: c.id } })
							}
							className="absolute cursor-grab rounded-[3px] bg-white p-1.5 pb-5 shadow-[0_8px_24px_rgba(0,0,0,0.35)] transition-[box-shadow,scale] active:cursor-grabbing"
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
			<span className="pointer-events-none absolute right-2 bottom-2 rounded bg-white/75 px-1.5 py-0.5 text-[10px] text-black/60">
				Map © swisstopo
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
