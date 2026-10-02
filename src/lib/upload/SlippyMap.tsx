// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Minimal OSM raster slippy map: drag to pan, wheel/buttons to zoom, click to place a pin.
// No map dependency. Tiles © OpenStreetMap contributors (tile.openstreetmap.org usage policy:
// light interactive use with attribution, which is what a one-off pin placement is).
import { useCallback, useEffect, useRef, useState } from "react";
import type { LatLon } from "#/lib/ontology/core/geometry";

const TILE = 256;
const MAX_Z = 18;
const MIN_Z = 2;

const lon2x = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const lat2y = (lat: number, z: number) => {
	const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
	return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
};
const x2lon = (x: number, z: number) => (x / (TILE * 2 ** z)) * 360 - 180;
const y2lat = (y: number, z: number) => {
	const n = Math.PI - (2 * Math.PI * y) / (TILE * 2 ** z);
	return (180 / Math.PI) * Math.atan(Math.sinh(n));
};

export type { LatLon };

export function SlippyMap({
	center,
	zoom: initialZoom = 12,
	pin,
	onPick,
	accuracyM,
	headingDeg,
	hfovDeg,
	className,
	height = 320,
}: {
	center: LatLon;
	zoom?: number;
	pin?: LatLon | null;
	onPick?: (p: LatLon) => void;
	/** GPS horizontal accuracy, drawn as a circle around the pin. */
	accuracyM?: number | null;
	/** Camera heading (true north, clockwise) and horizontal FOV, drawn as a view wedge. */
	headingDeg?: number | null;
	hfovDeg?: number | null;
	className?: string;
	height?: number;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ w: 600, h: height });
	const [view, setView] = useState(() => ({
		z: initialZoom,
		x: lon2x(center.lon, initialZoom),
		y: lat2y(center.lat, initialZoom),
	}));
	const drag = useRef<{
		x: number;
		y: number;
		vx: number;
		vy: number;
		moved: boolean;
	} | null>(null);

	// recentre when the caller's centre changes (e.g. a typed coordinate)
	useEffect(() => {
		setView((v) => ({
			z: v.z,
			x: lon2x(center.lon, v.z),
			y: lat2y(center.lat, v.z),
		}));
	}, [center.lat, center.lon]);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const ro = new ResizeObserver(([e]) =>
			setSize({ w: e.contentRect.width, h: e.contentRect.height }),
		);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const zoomAt = useCallback((dz: number, px: number, py: number) => {
		setView((v) => {
			const z = Math.max(MIN_Z, Math.min(MAX_Z, v.z + dz));
			if (z === v.z) return v;
			const k = 2 ** (z - v.z);
			// keep the world point under (px, py) fixed
			const wx = v.x + px;
			const wy = v.y + py;
			return { z, x: wx * k - px, y: wy * k - py };
		});
	}, []);

	// non-passive wheel so the page doesn't scroll while zooming the map
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		let acc = 0;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			acc += e.deltaY;
			if (Math.abs(acc) < 60) return;
			const r = el.getBoundingClientRect();
			zoomAt(
				acc < 0 ? 1 : -1,
				e.clientX - r.left - r.width / 2,
				e.clientY - r.top - r.height / 2,
			);
			acc = 0;
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [zoomAt]);

	const { z, x: cx, y: cy } = view;
	const left = cx - size.w / 2;
	const top = cy - size.h / 2;
	const n = 2 ** z;
	const tiles: { key: string; url: string; x: number; y: number }[] = [];
	for (
		let ty = Math.floor(top / TILE);
		ty <= Math.floor((top + size.h) / TILE);
		ty++
	) {
		if (ty < 0 || ty >= n) continue;
		for (
			let tx = Math.floor(left / TILE);
			tx <= Math.floor((left + size.w) / TILE);
			tx++
		) {
			const wx = ((tx % n) + n) % n;
			tiles.push({
				key: `${z}/${tx}/${ty}`,
				url: `https://tile.openstreetmap.org/${z}/${wx}/${ty}.png`,
				x: tx * TILE - left,
				y: ty * TILE - top,
			});
		}
	}

	const toScreen = (p: LatLon) => ({
		x: lon2x(p.lon, z) - left,
		y: lat2y(p.lat, z) - top,
	});
	const pinPx = pin && Number.isFinite(pin.lat) ? toScreen(pin) : null;
	const mPerPx = pin
		? (40075016.686 * Math.cos((pin.lat * Math.PI) / 180)) / (TILE * n)
		: 1;
	const accPx = pinPx && accuracyM ? accuracyM / mPerPx : 0;

	const onPointerDown = (e: React.PointerEvent) => {
		(e.target as Element).setPointerCapture?.(e.pointerId);
		drag.current = {
			x: e.clientX,
			y: e.clientY,
			vx: view.x,
			vy: view.y,
			moved: false,
		};
	};
	const onPointerMove = (e: React.PointerEvent) => {
		const d = drag.current;
		if (!d) return;
		const dx = e.clientX - d.x;
		const dy = e.clientY - d.y;
		if (Math.hypot(dx, dy) > 4) d.moved = true;
		if (d.moved) setView((v) => ({ ...v, x: d.vx - dx, y: d.vy - dy }));
	};
	const onPointerUp = (e: React.PointerEvent) => {
		const d = drag.current;
		drag.current = null;
		if (!d || d.moved || !onPick || !ref.current) return;
		const r = ref.current.getBoundingClientRect();
		const px = left + (e.clientX - r.left);
		const py = top + (e.clientY - r.top);
		onPick({
			lat: y2lat(py, z),
			lon: ((((x2lon(px, z) + 180) % 360) + 360) % 360) - 180,
		});
	};

	let wedge: string | null = null;
	if (pinPx && headingDeg != null && hfovDeg) {
		const R = 90;
		const a0 = ((headingDeg - hfovDeg / 2) * Math.PI) / 180;
		const a1 = ((headingDeg + hfovDeg / 2) * Math.PI) / 180;
		const p = (a: number) =>
			`${pinPx.x + R * Math.sin(a)},${pinPx.y - R * Math.cos(a)}`;
		wedge = `M${pinPx.x},${pinPx.y} L${p(a0)} A${R},${R} 0 0 1 ${p(a1)} Z`;
	}

	return (
		<div
			ref={ref}
			role="application"
			aria-label="Map: click to place the camera position"
			data-testid="slippy-map"
			data-theme="dark"
			className={`relative touch-none overflow-hidden rounded-lg bg-[#1a2330] select-none ${onPick ? "cursor-crosshair" : "cursor-grab"} ${className ?? ""}`}
			style={{ height }}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={() => {
				drag.current = null;
			}}
			onDoubleClick={(e) => {
				const r = e.currentTarget.getBoundingClientRect();
				zoomAt(
					1,
					e.clientX - r.left - r.width / 2,
					e.clientY - r.top - r.height / 2,
				);
			}}
		>
			{tiles.map((t) => (
				<img
					key={t.key}
					src={t.url}
					alt=""
					draggable={false}
					className="pointer-events-none absolute max-w-none"
					style={{ left: t.x, top: t.y, width: TILE, height: TILE }}
				/>
			))}
			<svg
				className="pointer-events-none absolute inset-0"
				width={size.w}
				height={size.h}
				aria-hidden="true"
			>
				{wedge && (
					<path
						d={wedge}
						fill="rgba(34,211,238,0.22)"
						stroke="rgba(34,211,238,0.9)"
						strokeWidth={1.5}
					/>
				)}
				{accPx > 3 && (
					<circle
						cx={pinPx?.x}
						cy={pinPx?.y}
						r={accPx}
						fill="rgba(59,130,246,0.15)"
						stroke="rgba(59,130,246,0.7)"
					/>
				)}
				{pinPx && (
					<g transform={`translate(${pinPx.x},${pinPx.y})`}>
						<path
							d="M0,0 C-3,-10 -10,-14 -10,-22 A10,10 0 1 1 10,-22 C10,-14 3,-10 0,0 Z"
							fill="#ef4444"
							stroke="white"
							strokeWidth={1.5}
						/>
						<circle cy={-22} r={3.5} fill="white" />
					</g>
				)}
			</svg>
			<div className="absolute top-2 right-2 flex flex-col overflow-hidden rounded-md bg-black/60 text-white ring-1 ring-white/15">
				{[
					["+", 1],
					["−", -1],
				].map(([label, dz]) => (
					<button
						key={label}
						type="button"
						className="size-8 text-lg leading-none hover:bg-white/10"
						aria-label={dz === 1 ? "Zoom in" : "Zoom out"}
						onPointerDown={(e) => e.stopPropagation()}
						onPointerUp={(e) => e.stopPropagation()}
						onClick={() => zoomAt(dz as number, 0, 0)}
					>
						{label}
					</button>
				))}
			</div>
			<div className="absolute right-0 bottom-0 bg-white/80 px-1.5 py-0.5 text-[10px] text-black/80">
				©{" "}
				<a
					href="https://www.openstreetmap.org/copyright"
					target="_blank"
					rel="noreferrer"
					onPointerDown={(e) => e.stopPropagation()}
				>
					OpenStreetMap
				</a>{" "}
				contributors
			</div>
		</div>
	);
}
