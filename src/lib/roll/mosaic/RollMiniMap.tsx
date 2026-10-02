// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// 2D plan view of a roll over OSM tiles: one FOV wedge per photo (heading ± hfov/2), coloured by
// viewpoint. Click a wedge to select its photo. Same tile maths as upload/SlippyMap (which only
// draws one pin), copied so both can evolve independently.

import { Crosshair } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BRAND } from "#/brand/khipu";
import { latToWorldY as lat2y, lonToWorldX as lon2x } from "#/lib/mercator";
import {
	isUncertainPose,
	mercatorLat,
	mercatorMPerPx,
	priorFanPath,
} from "../../terroir/roll/logic";
import { MapFurniture } from "../../terroir/roll/MapFurniture";
import { hfovOf } from "../roll";
import type { Roll, RollPhoto } from "../types";
import { aspectOf, vpColor } from "./style";

const TILE = 256;
const MAX_Z = 18;
const MIN_Z = 3;
/** Wedge radius, px. */
const R = 46;

type Props = {
	roll: Roll;
	photos: RollPhoto[];
	selectedId: string | null;
	onSelect: (id: string | null) => void;
	height?: number;
	className?: string;
};

/** Zoom and centre (world px) that fit all photo positions plus wedge room. */
function fitView(roll: Roll, w: number, h: number) {
	const ps = roll.photos.map((p) => p.meta);
	const lats = ps.map((p) => p.lat);
	const lons = ps.map((p) => p.lon);
	const [s, n, west, e] = [
		Math.min(...lats),
		Math.max(...lats),
		Math.min(...lons),
		Math.max(...lons),
	];
	const dx = lon2x(e, 0) - lon2x(west, 0);
	const dy = lat2y(s, 0) - lat2y(n, 0);
	const aw = Math.max(40, w - 2 * R - 16);
	const ah = Math.max(40, h - 2 * R - 16);
	const z =
		dx || dy
			? Math.floor(
					Math.log2(Math.min(dx ? aw / dx : Infinity, dy ? ah / dy : Infinity)),
				)
			: 14;
	const zc = Math.max(MIN_Z, Math.min(16, z));
	return { z: zc, x: lon2x((west + e) / 2, zc), y: lat2y((s + n) / 2, zc) };
}

export function RollMiniMap({
	roll,
	photos,
	selectedId,
	onSelect,
	height = 300,
	className = "",
}: Props) {
	const ref = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ w: 0, h: height });
	const [view, setView] = useState<{ z: number; x: number; y: number } | null>(
		null,
	);
	const drag = useRef<{
		x: number;
		y: number;
		vx: number;
		vy: number;
		moved: boolean;
		id: string | null;
	} | null>(null);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const ro = new ResizeObserver(([e]) =>
			setSize({ w: e.contentRect.width, h: e.contentRect.height }),
		);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const fit = useCallback(() => {
		if (size.w) setView(fitView(roll, size.w, size.h));
	}, [roll, size.w, size.h]);
	// fit once the size is known, and again for a new roll
	const fitted = useRef<string | null>(null);
	useEffect(() => {
		if (!size.w || fitted.current === roll.id) return;
		fitted.current = roll.id;
		fit();
	}, [size.w, roll.id, fit]);

	const zoomAt = useCallback((dz: number, px: number, py: number) => {
		setView((v) => {
			if (!v) return v;
			const z = Math.max(MIN_Z, Math.min(MAX_Z, v.z + dz));
			if (z === v.z) return v;
			const k = 2 ** (z - v.z);
			return { z, x: (v.x + px) * k - px, y: (v.y + py) * k - py };
		});
	}, []);

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

	const tiles: { key: string; url: string; x: number; y: number }[] = [];
	let left = 0;
	let top = 0;
	if (view && size.w) {
		left = view.x - size.w / 2;
		top = view.y - size.h / 2;
		const n = 2 ** view.z;
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
					key: `${view.z}/${tx}/${ty}`,
					url: `https://tile.openstreetmap.org/${view.z}/${wx}/${ty}.png`,
					x: tx * TILE - left,
					y: ty * TILE - top,
				});
			}
		}
	}

	const z = view?.z ?? 0;
	const at = (p: { lat: number; lon: number }) => ({
		x: lon2x(p.lon, z) - left,
		y: lat2y(p.lat, z) - top,
	});
	// selected photo last so its wedge is on top
	const ordered = [...photos].sort(
		(a, b) =>
			Number(a.meta.id === selectedId) - Number(b.meta.id === selectedId),
	);
	// photos arrive time-sorted (makeRoll); keep that order for the track
	const track = [...photos].sort((a, b) => a.t - b.t);

	const onPointerDown = (e: React.PointerEvent) => {
		if (!view) return;
		const id =
			(e.target as Element)
				.closest("[data-photo]")
				?.getAttribute("data-photo") ?? null;
		e.currentTarget.setPointerCapture(e.pointerId);
		drag.current = {
			x: e.clientX,
			y: e.clientY,
			vx: view.x,
			vy: view.y,
			moved: false,
			id,
		};
	};
	const onPointerMove = (e: React.PointerEvent) => {
		const d = drag.current;
		if (!d) return;
		const dx = e.clientX - d.x;
		const dy = e.clientY - d.y;
		if (Math.hypot(dx, dy) > 4) d.moved = true;
		if (d.moved) setView((v) => (v ? { ...v, x: d.vx - dx, y: d.vy - dy } : v));
	};
	const onPointerUp = () => {
		const d = drag.current;
		drag.current = null;
		if (d && !d.moved && d.id) onSelect(d.id === selectedId ? null : d.id);
	};

	return (
		<div
			ref={ref}
			role="application"
			aria-label="Plan view of the roll: click a wedge to select a photo"
			data-testid="roll-minimap"
			data-theme="dark"
			className={`relative touch-none overflow-hidden rounded-xl bg-[var(--rigi-slate)] ring-1 ring-white/8 select-none cursor-grab ${className}`}
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
					className="pointer-events-none absolute max-w-none brightness-[0.8] saturate-[0.7]"
					style={{ left: t.x, top: t.y, width: TILE, height: TILE }}
				/>
			))}
			{view && (
				<svg
					className="pointer-events-none absolute inset-0"
					width={size.w}
					height={size.h}
					aria-hidden="true"
				>
					{/* the day's path: photos in capture order, the Mapillary-style sequence line */}
					{track.length > 1 && (
						<polyline
							points={track
								.map((p) => `${at(p.meta).x},${at(p.meta).y}`)
								.join(" ")}
							fill="none"
							stroke={BRAND.paper}
							strokeOpacity={0.55}
							strokeWidth={1.5}
							strokeDasharray="4 4"
							strokeLinejoin="round"
						/>
					)}
					{ordered.map((p) => {
						const c = at(p.meta);
						const sel = p.meta.id === selectedId;
						const dim = selectedId != null && !sel;
						const hf = Math.min(179, hfovOf(p.pose, aspectOf(p)));
						const a0 = ((p.pose.yaw - hf / 2) * Math.PI) / 180;
						const a1 = ((p.pose.yaw + hf / 2) * Math.PI) / 180;
						const r = sel ? R * 1.35 : R;
						const pt = (a: number) =>
							`${c.x + r * Math.sin(a)},${c.y - r * Math.cos(a)}`;
						const col = vpColor(p.viewpoint);
						return (
							<g
								key={p.meta.id}
								data-photo={p.meta.id}
								className="pointer-events-auto cursor-pointer [&:hover>path]:fill-opacity-60"
							>
								<title>{p.meta.id}</title>
								{isUncertainPose(p.poseSource) && (
									<path
										d={priorFanPath(c.x, c.y, r * 1.12, p.pose.yaw, hf)}
										fill={col}
										fillOpacity={dim ? 0.03 : 0.09}
										stroke={col}
										strokeOpacity={dim ? 0.15 : 0.4}
										strokeDasharray="2 3"
										className="pointer-events-none"
									/>
								)}
								<path
									d={`M${c.x},${c.y} L${pt(a0)} A${r},${r} 0 0 1 ${pt(a1)} Z`}
									fill={col}
									fillOpacity={sel ? 0.55 : dim ? 0.12 : 0.28}
									stroke={sel ? "#fff" : col}
									strokeOpacity={dim ? 0.45 : 0.95}
									strokeWidth={sel ? 2 : 1.25}
									strokeDasharray={
										isUncertainPose(p.poseSource) ? "4 3" : undefined
									}
								/>
								<circle
									cx={c.x}
									cy={c.y}
									r={3.5}
									fill={col}
									stroke={BRAND.ink}
									strokeWidth={1.5}
								/>
							</g>
						);
					})}
				</svg>
			)}
			<button
				type="button"
				onClick={fit}
				onPointerDown={(e) => e.stopPropagation()}
				onPointerUp={(e) => e.stopPropagation()}
				title="Fit all photos"
				aria-label="Fit all photos"
				className="absolute top-2 right-2 flex size-8 items-center justify-center rounded-md bg-black/60 text-white ring-1 ring-white/15 hover:bg-black/80"
			>
				<Crosshair className="size-4" />
			</button>
			<div className="absolute top-12 right-2 flex flex-col overflow-hidden rounded-md bg-black/60 text-white ring-1 ring-white/15">
				{(
					[
						["+", 1],
						["−", -1],
					] as const
				).map(([label, dz]) => (
					<button
						key={label}
						type="button"
						className="size-8 text-lg leading-none hover:bg-white/10"
						aria-label={dz === 1 ? "Zoom in" : "Zoom out"}
						onPointerDown={(e) => e.stopPropagation()}
						onPointerUp={(e) => e.stopPropagation()}
						onClick={() => zoomAt(dz, 0, 0)}
					>
						{label}
					</button>
				))}
			</div>
			{view && (
				<MapFurniture
					mPerPx={mercatorMPerPx(mercatorLat(view.y, view.z), view.z)}
					note={
						photos.some((p) => isUncertainPose(p.poseSource))
							? "dashed + fan: EXIF-only heading, ±10° or more"
							: undefined
					}
				/>
			)}
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
