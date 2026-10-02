// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Engine-aware placement of the terroir pack's names for NamesSvg: project, drop the occluded and
// out-of-reach, drop peaks the engine already labels, rank, and declutter against each other and the
// peak labels' screen rects. Returns render items (anchor text, text-on-path, glyphs).
import { canvasMeasure } from "#/lib/look/labels/layout";
import type { NameClass, TerroirName } from "../types";
import type { TerroirCtx } from "../ui/context";
import { projectGeo } from "../ui/project";
import { groundAt } from "./ground";
import {
	bounds,
	CAPS_MAX,
	type DeclutterItem,
	declutterNames,
	displayText,
	dupOfPeak,
	MASSIF_MAX,
	type NameType,
	nameScore,
	nameType,
	PEAK_CLASSES,
	padRect,
	type Rect,
	rangeOpacity,
	reachOk,
	textPath,
	textWidth,
	uncertainOpacity,
} from "./names";

export type GlyphKind = "pass" | "hut" | "lift";
const GLYPH: Partial<Record<NameClass, GlyphKind>> = {
	pass: "pass",
	hut: "hut",
	lift: "lift",
};
/** line features that may run their text along a projected path */
const PATH_CLASSES: ReadonlySet<NameClass> = new Set([
	"river",
	"valley",
	"ridge",
	"massif",
	"glacier",
]);

export type NameItem = {
	id: string;
	text: string;
	alt?: string;
	type: NameType;
	/** baseline anchor (middle), px */
	x: number;
	y: number;
	altY: number;
	/** text along a path (path d + text start at the middle) */
	path?: string;
	glyph?: { kind: GlyphKind; x: number; y: number };
	opacity: number;
	distKm: number;
	rect: Rect;
};

/** Visible-surface cluster of one lake / glacier: centroid snapped onto the water / ice, mean range. */
type Surface = { x: number; y: number; dist: number; n: number };
const SURF_NX = 30;
const SURF_NY = 26;
const SURF_MIN_KM2 = 1;
let surfCache: { key: unknown[]; map: Map<number, Surface> } | null = null;

/**
 * Lakes and glaciers are named on what shows of them: sample the geometry buffer on a coarse grid, keep
 * the points whose cover is water (12) / ice (1, 2), assign each to the nearest pack lake / glacier
 * whose anchor is within ~2.2 equivalent radii (the pack has anchor + area only), and take each
 * cluster's centroid (snapped to its nearest sample so a curved lake is labelled on water).
 * Keyed by pack index. Cached per frame.
 */
function surfaceClusters(ctx: TerroirCtx): Map<number, Surface> | null {
	const { engine: eng, pack, cover, w, h } = ctx;
	if (!pack || !cover) return null;
	const key = [pack, cover, eng, ctx.frame, w, h];
	if (surfCache?.key.every((k, i) => k === key[i])) return surfCache.map;
	type Cand = {
		i: number;
		lat: number;
		lon: number;
		r: number;
		water: boolean;
	};
	const cands: Cand[] = [];
	pack.names.forEach((n, i) => {
		if (
			(n.cls !== "lake" && n.cls !== "glacier") ||
			(n.areaKm2 ?? 0) < SURF_MIN_KM2
		)
			return;
		const r = Math.max(700, 2.2 * Math.sqrt((n.areaKm2 ?? 0) / Math.PI) * 1000);
		cands.push({ i, lat: n.lat, lon: n.lon, r, water: n.cls === "lake" });
	});
	const pts = new Map<number, { x: number; y: number; d: number }[]>();
	const cosLat = Math.cos(((pack.bbox[1] + pack.bbox[3]) * Math.PI) / 360);
	for (let j = 0; j < SURF_NY; j++)
		for (let k = 0; k < SURF_NX; k++) {
			const u = (k + 0.5) / SURF_NX;
			const v = (j + 0.5) / SURF_NY;
			const s = eng.sampleAt(u, v);
			if (!s || eng.isForeground(u, v)) continue;
			const c = cover.at(s.lat, s.lon);
			const isWater = c === 12;
			if (!isWater && c !== 1 && c !== 2) continue;
			let best = -1;
			let bestF = 1;
			for (const cd of cands) {
				if (cd.water !== isWater) continue;
				const dm = Math.hypot(
					(s.lat - cd.lat) * 111320,
					(s.lon - cd.lon) * 111320 * cosLat,
				);
				const f = dm / cd.r;
				if (f < bestF) {
					bestF = f;
					best = cd.i;
				}
			}
			if (best < 0) continue;
			let a = pts.get(best);
			if (!a) {
				a = [];
				pts.set(best, a);
			}
			a.push({ x: u * w, y: v * h, d: s.range });
		}
	const map = new Map<number, Surface>();
	for (const [i, a] of pts) {
		if (a.length < 2) continue;
		let cx = 0;
		let cy = 0;
		let d = 0;
		for (const p of a) {
			cx += p.x;
			cy += p.y;
			d += p.d;
		}
		cx /= a.length;
		cy /= a.length;
		let q = a[0];
		for (const p of a)
			if (Math.hypot(p.x - cx, p.y - cy) < Math.hypot(q.x - cx, q.y - cy))
				q = p;
		// keep the centroid x (a lake is wide) but sit on the nearest water row
		map.set(i, {
			x: cx,
			// the mean is fine unless the cluster curves away from it: then use the nearest row
			y: Math.hypot(q.x - cx, q.y - cy) < h / 12 ? cy : q.y,
			dist: d / a.length,
			n: a.length,
		});
	}
	surfCache = { key, map };
	return map;
}

export type PlaceState = { prev: Set<string> };

const MAX_SCANS = 60;

/** Screen rects (relative to `origin`) of the peak labels already in the DOM (data-peak-label). */
export function peakLabelRects(
	root: ParentNode | null,
	origin: DOMRect | null,
): Rect[] {
	if (!root || !origin) return [];
	const out: Rect[] = [];
	for (const el of root.querySelectorAll("[data-peak-label]")) {
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) continue;
		out.push({
			x0: r.left - origin.left,
			y0: r.top - origin.top,
			x1: r.right - origin.left,
			y1: r.bottom - origin.top,
		});
	}
	return out;
}

export function placeNames(
	ctx: TerroirCtx,
	state: PlaceState,
	obstacles: Rect[],
	idPrefix: string,
): NameItem[] {
	const { engine: eng, pack, w, h } = ctx;
	if (!pack || !eng.geometryReady()) return [];
	const names = ctx.style.terroir.names;
	const ls = ctx.style.labels;
	const family = ls.fontFamily;
	const basePx = ls.name.px;
	const usual = names.language === "local+usual";
	const peaks = eng.peakLabels(100, { declutter: false });
	const measure = canvasMeasure;
	let scans = 0;
	const hOf = (n: { ele: number | null }, lat: number, lon: number) => {
		if (n.ele != null) return n.ele;
		if (scans >= MAX_SCANS) return null;
		scans++;
		return groundAt(eng, lat, lon, w, h);
	};
	const near = names.reach === "near";
	const items: DeclutterItem<NameItem[]>[] = [];
	const surf = surfaceClusters(ctx);

	pack.names.forEach((n: TerroirName, i: number) => {
		const cls = n.cls;
		const id = `${i}:${n.name}`;
		const isPeak = PEAK_CLASSES.has(cls);
		const typ = nameType(cls, basePx, names.typography);
		const alt = usual && n.alt && n.alt !== n.name ? n.alt : undefined;
		const altType = alt
			? { ...typ, px: typ.px * 0.82, weight: 400, upper: false, trackPx: 0 }
			: null;
		const lift = cls === "lake" || cls === "glacier" ? 0 : 25;
		const glyph = GLYPH[cls];
		const gap = glyph ? 8 : 5;
		const lineH = typ.px * 1.15;
		const altH = altType ? altType.px * 1.15 : 0;
		const boxH = lineH + altH;
		const pad = typ.px * 0.25;

		// a big lake / glacier is named on its visible surface
		const onSurface =
			surf != null &&
			(cls === "lake" || cls === "glacier") &&
			(n.areaKm2 ?? 0) >= SURF_MIN_KM2;
		const sc = onSurface ? surf.get(i) : undefined;
		if (onSurface && !sc && cls === "glacier") return;

		// anchor
		const hh = sc ? 0 : hOf(n, n.lat, n.lon);
		if (hh == null && !(PATH_CLASSES.has(cls) && n.line)) return;
		let p: { x: number; y: number; dist: number; visible: boolean } | null = sc
			? { x: sc.x, y: sc.y, dist: sc.dist, visible: true }
			: hh == null
				? null
				: projectGeo(eng, n.lat, n.lon, hh, w, h, { margin: 0, liftM: lift });
		let line: { x: number; y: number }[] | null = null;
		let lineDist = 0;
		if (!sc && PATH_CLASSES.has(cls) && n.line && n.line.length >= 2) {
			// the longest run of visible projected vertices
			const step = Math.max(1, Math.floor(n.line.length / 14));
			let run: { x: number; y: number; d: number }[] = [];
			let best: typeof run = [];
			const len = (r: typeof run) =>
				r.length < 2
					? 0
					: Math.hypot(r[r.length - 1].x - r[0].x, r[r.length - 1].y - r[0].y);
			for (let k = 0; k < n.line.length; k += step) {
				const [lo, la] = n.line[k];
				const z = hOf({ ele: null }, la, lo);
				const q =
					z == null
						? null
						: projectGeo(eng, la, lo, z, w, h, { margin: 0, liftM: 15 });
				if (q?.visible) run.push({ x: q.x, y: q.y, d: q.dist });
				else {
					if (len(run) > len(best)) best = run;
					run = [];
				}
			}
			if (len(run) > len(best)) best = run;
			if (best.length >= 2) {
				line = best;
				lineDist = best.reduce((a, b) => a + b.d, 0) / best.length;
			}
		}
		const lakeAlt = cls === "lake" && n.line && n.line.length > 0;
		if (!line && (!p || !p.visible)) {
			if (lakeAlt && n.ele != null) {
				// a lake is named if any sample of it is visible
				for (const [lo, la] of n.line ?? []) {
					const q = projectGeo(eng, la, lo, n.ele, w, h, { margin: 0 });
					if (q?.visible) {
						p = q;
						break;
					}
				}
			}
			if (!p || !p.visible) return;
		}
		const distM = line ? lineDist : (p as { dist: number }).dist;
		if (!reachOk(cls, distM, names.reach)) return;
		const distKm = distM / 1000;

		// peaks the engine already labels are theirs; any other class with an engine peak's name
		// nearby (swissNAMES3D also carries a summit as a field / region name) is a duplicate too
		{
			const e = eng.frame.fromGeo(n.lat, n.lon, n.ele ?? hh ?? 0);
			if (dupOfPeak(n.name, e, peaks, isPeak ? 300 : 0)) return;
		}

		const text = displayText(n.name, typ);
		const wTxt = textWidth(n.name, typ, family, measure);
		const wAlt = alt && altType ? textWidth(alt, altType, family, measure) : 0;
		const wBox = Math.max(wTxt, wAlt);
		const centre = p ? 1 - Math.abs(p.x / w - 0.5) * 2 : 0.5;
		const base: Omit<NameItem, "x" | "y" | "altY" | "rect" | "path" | "glyph"> =
			{
				id,
				text,
				alt,
				type: typ,
				opacity: Math.min(
					rangeOpacity(distKm),
					ctx.uncertain && ctx.style.terroir.uncertainty
						? uncertainOpacity(distKm)
						: 1,
				),
				distKm,
			};
		const score =
			nameScore(n, distKm, centre, state.prev.has(id)) +
			(sc && cls === "lake" ? 25 : 0);
		const rects: Rect[] = [];
		const datas: NameItem[] = [];
		const add = (it: NameItem) => {
			rects.push(it.rect);
			datas.push(it);
		};
		if (line) {
			const path = PATH_CLASSES.has(cls)
				? textPath(line, wTxt * 1.1, 60)
				: null;
			if (path) {
				const r = padRect(bounds(path), typ.px * 0.7);
				const d = path
					.map((q, k) => `${k ? "L" : "M"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`)
					.join(" ");
				add({
					...base,
					alt: undefined,
					x: 0,
					y: 0,
					altY: 0,
					path: `${idPrefix}-${i}|${d}`,
					rect: r,
				});
			}
		}
		// point placements: above, then below
		const pt = p ?? (line ? line[Math.floor(line.length / 2)] : null);
		if (pt) {
			const x = pt.x;
			if (sc) {
				// on the surface: centred on the cluster first
				const yC = pt.y - boxH / 2;
				add({
					...base,
					x,
					y: yC + lineH * 0.78 - 0,
					altY: yC + lineH * 0.78 + altH,
					rect: {
						x0: x - wBox / 2 - pad,
						y0: yC,
						x1: x + wBox / 2 + pad,
						y1: yC + boxH,
					},
				});
			}
			const yA = pt.y - gap;
			add({
				...base,
				x,
				y: yA - altH - lineH * 0.22,
				altY: yA - altH * 0.22,
				glyph: glyph ? { kind: glyph, x, y: pt.y } : undefined,
				rect: {
					x0: x - wBox / 2 - pad,
					y0: yA - boxH,
					x1: x + wBox / 2 + pad,
					y1: yA,
				},
			});
			const yB = pt.y + gap;
			add({
				...base,
				x,
				y: yB + lineH * 0.8,
				altY: yB + lineH * 0.8 + altH,
				glyph: glyph ? { kind: glyph, x, y: pt.y } : undefined,
				rect: {
					x0: x - wBox / 2 - pad,
					y0: yB,
					x1: x + wBox / 2 + pad,
					y1: yB + boxH,
				},
			});
		}
		if (!rects.length) return;
		const tags: string[] = [];
		if (typ.upper) tags.push("caps");
		if (cls === "massif") tags.push("massif");
		items.push({
			id,
			score,
			rects,
			data: datas,
			tags,
			obsPadY: isPeak ? 0 : lineH * 1.6,
		});
	});

	const placed = declutterNames(items, obstacles, {
		width: w,
		height: h,
		max: Math.max(0, names.maxLabels),
		limits: near ? { caps: CAPS_MAX, massif: MASSIF_MAX } : undefined,
	});
	state.prev = new Set(placed.map((q) => q.item.id));
	return placed.map((q) => q.item.data[q.alt]);
}
