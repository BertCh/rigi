// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// T0.9 Furniture for the photo views: a compass ribbon across the top (headings through the solved
// pose), a sun / time chip ("15:39 · 228° / 38°", the photo's own clock), and range ticks at the right
// edge (distance to the terrain at the image centre column). World mode: only the sun / time chip,
// since the photo camera is not the view camera there. Display-only.
import { useMemo } from "react";
import { projectPoint } from "#/lib/camera";
import { sunPosition } from "#/lib/look/sun";
import { clockHM, formatDist, parseTz } from "../viz/geo";
import { FONT, INK, PAPER, SUN } from "../viz/ink";
import type { TerroirCtx } from "./context";

const D = Math.PI / 180;
const LETTERS: Record<number, string> = {
	0: "N",
	45: "NE",
	90: "E",
	135: "SE",
	180: "S",
	225: "SW",
	270: "W",
	315: "NW",
};

function SunGlyph({ size = 12 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="-6 -6 12 12" aria-hidden="true">
			<circle r={2.6} fill={SUN} />
			{[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
				<line
					key={`ray${i * 45}`}
					x1={Math.cos((i * Math.PI) / 4) * 3.9}
					y1={Math.sin((i * Math.PI) / 4) * 3.9}
					x2={Math.cos((i * Math.PI) / 4) * 5.5}
					y2={Math.sin((i * Math.PI) / 4) * 5.5}
					stroke={SUN}
					strokeWidth={1}
					strokeLinecap="round"
				/>
			))}
		</svg>
	);
}

/** The ribbon starts below the photo header pills (Library / title / Save / Export, ~10-40 px). */
const RIBBON_Y = 46;
const RIBBON_H = 30;

export function Furniture({ ctx }: { ctx: TerroirCtx }) {
	const { engine, w, h, mode } = ctx;
	const photo = engine.photo;
	const world = mode === "world";
	const at = ctx.takenAt ?? photo.takenAt;
	const tz = parseTz(photo.tzOffset);

	const chip = useMemo(() => {
		if (!at) return null;
		const s = sunPosition(new Date(at), photo.lat, photo.lon);
		return { time: clockHM(new Date(at), tz), az: s.azimuth, el: s.elevation };
	}, [at, tz, photo.lat, photo.lon]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: ctx.frame is the pose / geometry tick
	const ribbon = useMemo(() => {
		if (world) return null;
		const e = engine.eye;
		const eye = [e.x, e.y, e.z];
		const pose = engine.pose;
		const ticks: { x: number; deg: number }[] = [];
		for (let deg = 0; deg < 360; deg += 10) {
			// a point on the horizon at the camera's pitch: x follows the heading along the centre row
			const q = projectPoint(pose, engine.aspect, eye, [
				e.x + Math.sin(deg * D) * Math.cos(pose.pitch * D) * 1e5,
				e.y + Math.cos(deg * D) * Math.cos(pose.pitch * D) * 1e5,
				e.z + Math.sin(pose.pitch * D) * 1e5,
			]);
			if (q && q.u > 0.02 && q.u < 0.98) ticks.push({ x: q.u * w, deg });
		}
		const ranges = [1 / 3, 1 / 2, 2 / 3].flatMap((v) => {
			const s = engine.sampleAt(0.5, v);
			return s ? [{ y: v * h, range: s.range }] : [];
		});
		return { ticks, ranges, heading: ((pose.yaw % 360) + 360) % 360 };
	}, [ctx.frame, engine, w, h, world]);

	const chipEl = chip && (
		<div
			className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-semibold leading-none text-white/90 ring-1 ring-white/10 backdrop-blur"
			style={{ top: world ? 8 : RIBBON_Y + RIBBON_H + 4, fontFamily: FONT }}
		>
			<SunGlyph />
			<span>
				{chip.time}
				{chip.el > 0
					? ` · ${Math.round(chip.az)}° / ${Math.round(chip.el)}°`
					: " · sun below horizon"}
			</span>
		</div>
	);
	if (world) return chipEl;
	if (!ribbon) return null;

	return (
		<>
			<svg
				width={w}
				height={h}
				viewBox={`0 0 ${w} ${h}`}
				className="pointer-events-none absolute inset-0 overflow-hidden"
				aria-hidden="true"
				fontFamily={FONT}
			>
				<defs>
					<linearGradient id="terroir-ribbon" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0" stopColor={INK} stopOpacity={0} />
						<stop offset="0.3" stopColor={INK} stopOpacity={0.26} />
						<stop offset="1" stopColor={INK} stopOpacity={0} />
					</linearGradient>
				</defs>
				<g transform={`translate(0 ${RIBBON_Y})`}>
					<rect
						x={0}
						y={0}
						width={w}
						height={RIBBON_H}
						fill="url(#terroir-ribbon)"
					/>
					{ribbon.ticks.map((t) => {
						const major = t.deg % 30 === 0;
						const letter = LETTERS[t.deg];
						return (
							<g key={t.deg}>
								<line
									x1={t.x}
									x2={t.x}
									y1={0}
									y2={letter ? 12 : major ? 9 : 5}
									stroke={PAPER}
									strokeOpacity={major || letter ? 0.9 : 0.55}
									strokeWidth={1}
								/>
								{(letter || major) && (
									<text
										x={t.x}
										y={letter ? 24 : 21}
										textAnchor="middle"
										fontSize={letter ? (t.deg % 90 === 0 ? 12 : 10) : 9}
										fontWeight={letter ? 700 : 500}
										fill={PAPER}
										fillOpacity={letter ? 0.95 : 0.7}
										stroke={INK}
										strokeOpacity={0.6}
										strokeWidth={2.4}
										paintOrder="stroke"
									>
										{letter ?? `${t.deg}°`}
									</text>
								)}
							</g>
						);
					})}
					<path
						d={`M${w / 2 - 4} 0L${w / 2 + 4} 0L${w / 2} 5Z`}
						fill={PAPER}
						fillOpacity={0.9}
					/>
				</g>
				{ribbon.ranges.map((r) => (
					<g key={r.y}>
						<line
							x1={w - 8}
							x2={w}
							y1={r.y}
							y2={r.y}
							stroke={PAPER}
							strokeOpacity={0.8}
							strokeWidth={1}
						/>
						<text
							x={w - 12}
							y={r.y + 3.5}
							textAnchor="end"
							fontSize={10}
							fontWeight={600}
							fill={PAPER}
							stroke={INK}
							strokeOpacity={0.65}
							strokeWidth={2.6}
							paintOrder="stroke"
						>
							{formatDist(r.range)}
						</text>
					</g>
				))}
			</svg>
			<div
				className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[10px] font-semibold leading-none text-white/80"
				style={{ top: RIBBON_Y + 3, marginLeft: 14, fontFamily: FONT }}
			>
				{Math.round(ribbon.heading)}°
			</div>
			{chipEl}
		</>
	);
}
