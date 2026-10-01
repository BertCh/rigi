// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// T3.2 Glacier then and now: a former glacier extent (pack.glaciers, GLAMOS / swisstopo) registered on
// the photo through the solved pose. Honest default: the ring is draped at TODAY's terrain height (the
// per-vertex DEM heights in the pack) + a 5 m lift. The 1850 ice surface was higher than today's
// ground (tens to hundreds of metres), so the outline marks where the ice reached, not the old
// surface; vertices hidden by nearer terrain are not drawn. Display-only.
import { useMemo } from "react";
import { projectPoint } from "#/lib/camera";
import type { GlacierExtent } from "../types";
import { FONT, ICE, INK } from "../viz/ink";
import { pathD, type RunPt, splitRuns } from "../viz/runs";
import type { TerroirCtx } from "./context";

const LIFT_M = 5;
const FAR_M = 40000;
/** polygons whose nearest vertex is beyond this are skipped (dashed squiggles on the skyline) */
const MAX_M = 25000;
/** 12 km out to MAX_M: a soft fill instead of a dashed outline */
const SOFT_M = 12000;
const MIN_AREA_PX2 = 400;
const MIN_GAP_PX = 2;

type Pt = RunPt;
type Drawn = {
	runs: Pt[][];
	/** polygon index and a (screen) visible-point centroid, for the tag */
	cx: number;
	cy: number;
	n: number;
	/** projected (viewport-clamped) screen area, px² */
	area: number;
	/** nearest vertex, m */
	near: number;
};

function projectExtent(
	ctx: TerroirCtx,
	ext: GlacierExtent,
): {
	drawn: Drawn[];
	anchor: {
		x: number;
		y: number;
		n: number;
		area: number;
		bottom: number;
	} | null;
} {
	const eng = ctx.engine;
	const e = eng.eye;
	const eye = [e.x, e.y, e.z];
	const drawn: Drawn[] = [];
	let anchor: {
		x: number;
		y: number;
		n: number;
		area: number;
		bottom: number;
	} | null = null;
	ext.polygons.forEach((poly, pi) => {
		poly.forEach((ring, ri) => {
			const hs = ext.heights?.[pi]?.[ri];
			if (!hs || ring.length < 3) return; // no heights = no honest drape
			let lastX = Number.NaN;
			let lastY = Number.NaN;
			let lastOk = false;
			const pts: Pt[] = ring.map(([lon, lat], i) => {
				const p = eng.frame.fromGeo(lat, lon, hs[i] + LIFT_M);
				const q = projectPoint(eng.pose, eng.aspect, eye, p);
				if (!q) return { x: 0, y: 0, dist: 0, ok: false };
				const x = q.u * ctx.w;
				const y = q.v * ctx.h;
				const dist = Math.hypot(p[0] - e.x, p[1] - e.y, p[2] - e.z);
				if (Math.abs(x) > 1e5 || Math.abs(y) > 1e5)
					return { x, y, dist, ok: false };
				let ok = true;
				if (q.u >= 0 && q.u <= 1 && q.v >= 0 && q.v <= 1) {
					// skip the (costly) buffer read for vertices a pixel from the last tested one
					if (!(lastOk && Math.abs(x - lastX) < 1 && Math.abs(y - lastY) < 1)) {
						const s = eng.sampleAt(q.u, Math.min(1, q.v + 0.002));
						const tol = Math.max(60, dist * 0.02);
						ok = !(s && s.range < dist - tol);
					} else ok = lastOk;
					lastX = x;
					lastY = y;
					lastOk = ok;
				}
				return { x, y, dist, ok };
			});
			// screen-space area (clamped to the stage) and the nearest vertex
			let area = 0;
			let near = Number.POSITIVE_INFINITY;
			for (let i = 0; i < pts.length; i++) {
				const a = pts[i];
				const b = pts[(i + 1) % pts.length];
				if (a.dist > 0) near = Math.min(near, a.dist);
				const cl = (p: Pt) => ({
					x: Math.min(ctx.w, Math.max(0, p.x)),
					y: Math.min(ctx.h, Math.max(0, p.y)),
				});
				const ca = cl(a);
				const cb = cl(b);
				area += ca.x * cb.y - cb.x * ca.y;
			}
			area = Math.abs(area) / 2;
			if (near > MAX_M || area < MIN_AREA_PX2) return;
			// drop vertices closer than 2 px to the last kept one (same visibility)
			const simp: Pt[] = [];
			for (const p of pts) {
				const l = simp[simp.length - 1];
				if (l && l.ok === p.ok && Math.hypot(p.x - l.x, p.y - l.y) < MIN_GAP_PX)
					continue;
				simp.push(p);
			}
			const runs = splitRuns(simp, true).filter((r) => r.length > 1);
			if (!runs.length) return;
			// visible-point centroid, weighted to the polygon with most visible points
			let sx = 0;
			let sy = 0;
			let n = 0;
			for (const r of runs)
				for (const p of r)
					if (p.x >= 0 && p.x <= ctx.w && p.y >= 0 && p.y <= ctx.h) {
						sx += p.x;
						sy += p.y;
						n++;
					}
			drawn.push({
				runs,
				cx: n ? sx / n : 0,
				cy: n ? sy / n : 0,
				n,
				area,
				near,
			});
			if (ri === 0 && n && (!anchor || area > anchor.area))
				anchor = {
					x: sx / n,
					y: sy / n,
					n,
					area,
					bottom: Math.max(
						...runs.flatMap((r) => r.map((p) => Math.min(ctx.h, p.y))),
					),
				};
		});
	});
	return { drawn, anchor };
}

const fade = (dist: number) => 1 - 0.6 * Math.min(1, dist / FAR_M);

export function GlacierGhost({ ctx }: { ctx: TerroirCtx }) {
	const { pack, style, engine, w, h } = ctx;
	const g = style.terroir.glacier;
	const soft = ctx.uncertain && style.terroir.uncertainty;
	// biome-ignore lint/correctness/useExhaustiveDependencies: ctx.frame is the pose / geometry tick
	const view = useMemo(() => {
		const exts =
			pack?.glaciers.filter((x) => x.heights?.length && x.polygons.length) ??
			[];
		if (!exts.length) return null;
		const target = exts.reduce((a, b) =>
			Math.abs(b.year - g.year) < Math.abs(a.year - g.year) ? b : a,
		);
		const recent = exts.reduce((a, b) => (b.year > a.year ? b : a));
		const main = projectExtent(ctx, target);
		const now = recent !== target ? projectExtent(ctx, recent) : null;
		if (!main.drawn.length && !now?.drawn.length) return null;
		return { target, recent, main, now };
	}, [pack, g.year, ctx.frame, engine, w, h]);
	if (!view) return null;
	const k = soft ? 0.6 : 1;
	const dash = soft ? "2 4" : "6 4";

	const draw = (
		d: Drawn[],
		key: string,
		o: { dashed: boolean; width: number; alpha: number; fill: boolean },
	) =>
		d.flatMap((poly) =>
			poly.runs.map((run) => {
				const mean = run.reduce((s, p) => s + p.dist, 0) / run.length;
				const a = o.alpha * fade(mean) * k;
				const dd = pathD(run);
				if (poly.near > SOFT_M) {
					// mid-distance: a soft translucent patch, no dashes (the recent outline is dropped)
					if (!o.dashed) return null;
					return (
						<g key={`${key}${dd}`} opacity={a}>
							<path d={`${dd}Z`} fill={ICE} fillOpacity={0.2} stroke="none" />
							<path
								d={`${dd}Z`}
								fill="none"
								stroke={ICE}
								strokeOpacity={0.35}
								strokeWidth={0.8}
								strokeLinejoin="round"
							/>
						</g>
					);
				}
				return (
					<g key={`${key}${dd}`} opacity={a}>
						{o.fill && (
							<path d={`${dd}Z`} fill={ICE} fillOpacity={0.25} stroke="none" />
						)}
						<path
							d={dd}
							fill="none"
							stroke={INK}
							strokeOpacity={0.55}
							strokeWidth={o.width + 1.6}
							strokeLinejoin="round"
						/>
						<path
							d={dd}
							fill="none"
							stroke={ICE}
							strokeWidth={o.width}
							strokeLinejoin="round"
							strokeDasharray={o.dashed ? dash : undefined}
						/>
					</g>
				);
			}),
		);

	// ONE combined tag, at the largest visible polygon
	const a = view.main.anchor;
	const tagText = view.now
		? `Glacier ${view.target.year} \u2192 ${view.recent.year}`
		: `Glacier ${view.target.year}`;
	const tag = a && (
		<text
			x={Math.min(w - 70, Math.max(70, a.x))}
			y={Math.min(h - 14, Math.max(14, a.bottom + 20))}
			textAnchor="middle"
			fontFamily={FONT}
			fontSize={11}
			fontWeight={600}
			letterSpacing="0.04em"
			fill={ICE}
			stroke={INK}
			strokeOpacity={0.7}
			strokeWidth={3}
			paintOrder="stroke"
			opacity={k}
		>
			{tagText}
		</text>
	);

	const fill = g.style === "fill";
	return (
		<svg
			width={w}
			height={h}
			viewBox={`0 0 ${w} ${h}`}
			className="pointer-events-none absolute inset-0 overflow-hidden"
			aria-hidden="true"
		>
			{view.now &&
				draw(view.now.drawn, "now", {
					dashed: false,
					width: 1,
					alpha: 0.7,
					fill: false,
				})}
			{draw(view.main.drawn, "main", {
				dashed: true,
				width: 1.8,
				alpha: 1,
				fill,
			})}
			{tag}
		</svg>
	);
}
