// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// T3.5 Sun path on the photo: the capture date's sun arc (every 10 min, sunrise to sunset) projected
// through the solved pose, hour ticks, the sun disc at the capture time, and sunrise / sunset azimuth
// markers on the horizon. Parts over terrain (sky only is the honest place for the sun) are fainter.
import { useMemo } from "react";
import { projectPoint } from "#/lib/camera";
import { sunPosition } from "#/lib/look/sun";
import { clockHM, parseTz } from "../viz/geo";
import { FONT, INK, SUN } from "../viz/ink";
import { sunArc } from "../viz/sunarc";
import type { TerroirCtx } from "./context";

const FAR = 50000;

type P = {
	x: number;
	y: number;
	terrain: boolean;
	ok: boolean;
	hour: number | null;
};

export function SunPath({ ctx }: { ctx: TerroirCtx }) {
	const { engine, w, h, takenAt } = ctx;
	const photo = engine.photo;
	const soft = ctx.uncertain && ctx.style.terroir.uncertainty;
	const at = takenAt ?? photo.takenAt;
	const tz = parseTz(photo.tzOffset);
	const arc = useMemo(
		() => (at ? sunArc(new Date(at), photo.lat, photo.lon, tz ?? 0) : null),
		[at, photo.lat, photo.lon, tz],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: ctx.frame is the pose / geometry tick
	const geo = useMemo(() => {
		if (!arc || !at) return null;
		const e = engine.eye;
		const eye = [e.x, e.y, e.z];
		const proj = (dir: number[]) => {
			const q = projectPoint(engine.pose, engine.aspect, eye, [
				e.x + dir[0] * FAR,
				e.y + dir[1] * FAR,
				e.z + dir[2] * FAR,
			]);
			if (!q) return null;
			return { u: q.u, v: q.v };
		};
		const pts: P[] = arc.pts.map((p) => {
			const q = proj(p.dir);
			if (!q || Math.abs(q.u) > 20 || Math.abs(q.v) > 20)
				return { x: 0, y: 0, terrain: false, ok: false, hour: p.hour };
			const inFrame = q.u >= 0 && q.u <= 1 && q.v >= 0 && q.v <= 1;
			const terrain = inFrame ? engine.sampleAt(q.u, q.v) != null : false;
			return { x: q.u * w, y: q.v * h, terrain, ok: true, hour: p.hour };
		});
		const now = sunPosition(new Date(at), photo.lat, photo.lon);
		const nq = proj(now.dir);
		const sun =
			nq && now.elevation > -1
				? { x: nq.u * w, y: nq.v * h, up: now.elevation > 0 }
				: null;
		const horizon = (az: number | undefined) => {
			if (az == null) return null;
			const r = Math.PI / 180;
			const q = proj([Math.sin(az * r), Math.cos(az * r), 0]);
			if (!q || q.u < 0.01 || q.u > 0.99) return null;
			return { x: q.u * w, y: q.v * h };
		};
		return { pts, sun, rise: horizon(arc.rise?.az), set: horizon(arc.set?.az) };
	}, [arc, at, ctx.frame, engine, w, h, photo.lat, photo.lon]);

	if (!arc || !geo) return null;

	// runs of the same terrain state, so sky parts draw stronger than parts over terrain
	const runs: { d: string; terrain: boolean }[] = [];
	let cur: P[] = [];
	const flush = () => {
		if (cur.length > 1)
			runs.push({
				d: cur
					.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
					.join(""),
				terrain: cur[0].terrain,
			});
		cur = [];
	};
	for (const p of geo.pts) {
		if (!p.ok) {
			flush();
			continue;
		}
		if (cur.length && cur[cur.length - 1].terrain !== p.terrain) {
			const last = cur[cur.length - 1];
			flush();
			cur = [last]; // share the joint so runs touch
		}
		cur.push(p);
	}
	flush();

	const k = soft ? 0.6 : 1;
	const dash = soft ? "1 6" : "1.5 4.5";
	const hours = geo.pts.filter(
		(p) =>
			p.ok &&
			p.hour != null &&
			p.x > 8 &&
			p.x < w - 8 &&
			p.y > 8 &&
			p.y < h - 8,
	);
	const fmt = (t: number) => clockHM(t, tz);

	return (
		<svg
			width={w}
			height={h}
			viewBox={`0 0 ${w} ${h}`}
			className="pointer-events-none absolute inset-0 overflow-hidden"
			aria-hidden="true"
			fontFamily={FONT}
		>
			<g opacity={k}>
				{runs.map((r) => (
					<g key={r.d} opacity={r.terrain ? 0.3 : 0.95}>
						<path
							d={r.d}
							fill="none"
							stroke={INK}
							strokeOpacity={0.5}
							strokeWidth={3.2}
							strokeLinecap="round"
						/>
						<path
							d={r.d}
							fill="none"
							stroke={SUN}
							strokeWidth={1.6}
							strokeLinecap="round"
							strokeDasharray={dash}
						/>
					</g>
				))}
				{hours.map((p) => (
					<g key={p.hour} opacity={p.terrain ? 0.35 : 1}>
						<circle
							cx={p.x}
							cy={p.y}
							r={2.6}
							fill={SUN}
							stroke={INK}
							strokeOpacity={0.6}
							strokeWidth={1}
						/>
						<text
							x={p.x}
							y={p.y - 7}
							textAnchor="middle"
							fontSize={10}
							fontWeight={600}
							fill={SUN}
							stroke={INK}
							strokeOpacity={0.7}
							strokeWidth={2.6}
							paintOrder="stroke"
						>
							{p.hour}h
						</text>
					</g>
				))}
				{[
					{ m: geo.rise, label: arc.rise ? `sunrise ${fmt(arc.rise.t)}` : "" },
					{ m: geo.set, label: arc.set ? `sunset ${fmt(arc.set.t)}` : "" },
				].map(
					({ m, label }) =>
						m && (
							<g key={label}>
								<path
									d={`M${m.x} ${m.y - 7}L${m.x} ${m.y + 7}M${m.x - 7} ${m.y}L${m.x + 7} ${m.y}`}
									stroke={SUN}
									strokeWidth={1.4}
									opacity={0.9}
								/>
								<text
									x={m.x}
									y={m.y + 20}
									textAnchor="middle"
									fontSize={10}
									fontWeight={600}
									fill={SUN}
									stroke={INK}
									strokeOpacity={0.7}
									strokeWidth={2.6}
									paintOrder="stroke"
								>
									{label}
								</text>
							</g>
						),
				)}
				{geo.sun && (
					<g opacity={geo.sun.up ? 1 : 0.4}>
						<circle
							cx={geo.sun.x}
							cy={geo.sun.y}
							r={11}
							fill="none"
							stroke={SUN}
							strokeOpacity={0.5}
							strokeWidth={1}
						/>
						<circle
							cx={geo.sun.x}
							cy={geo.sun.y}
							r={5.5}
							fill={SUN}
							stroke={INK}
							strokeOpacity={0.7}
							strokeWidth={1.2}
						/>
					</g>
				)}
			</g>
		</svg>
	);
}
