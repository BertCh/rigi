// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Waterline "level" cues and shoreline "shore" cues (WP-C).
//
// Lakes: polygons in the SCENE frame ([e, n] metres), levelM = ABSOLUTE lake level (m; by default the
// median DEM inside the polygon, see lakeLevel). Water pixels of the GeomBuffer are DEM hits inside a
// lake. In every stepPx column the far-shore waterline is a land → water transition going down the
// frame where the land continues the water surface (range ratio < 1.3; otherwise it is an occluding
// contour, not a shore). The predicted waterline is refined by bisection (GeomBuffer.cast), and the
// observed one is searched in the photo edges within ±searchPx along the vertical, horizontal edges only
// (±oriTolDeg), with one luminance polarity per photo ("auto" = majority of an unconstrained pass).
// An optional soft photo water mask (GeomBuffer resolution, 1 = water) replaces the edge search.
//
// Output (all with residualPx = f·(el(observed ray) − el(target)) in px @1600, as scripts/concord
// scorePins scores level pins, i.e. predicted − observed with v down):
//   "level" (shore distance > minLevelM, default 1 km): u, v = observed pixel; el = target elevation
//          angle (deg) of the lake-level shore point from the eye.
//   "shore" (0.3–3 km): u, v = observed pixel; lakeM; shoreDist(e, n) = signed distance (m) to the
//          lake outline (negative inside the water) of the observed ray's lake-plane intersection.
import { DEG } from "../../geodesy";
import type { LatLon } from "../../ontology/core/geometry";
import { type CameraX, type Cue, unprojectDirX, type Vec3 } from "../core";
import { focal1600 } from "./contours";
import { searchAlongNormal, thinEdgesMemo } from "./edge-dt";
import type { GeomBuffer, PhotoEdges } from "./types";

export type Lake = {
	polygon: [number, number][];
	levelM: number;
	/** Additive: inner rings (islands) and extra outer rings, even-odd with `polygon`. */
	holes?: [number, number][][];
	name?: string;
};

export type WaterCue = Cue & {
	residualPx: number;
	conf: number;
	/** Predicted waterline v at the same u, and the target lake-level point (scene frame). */
	predV: number;
	world: Vec3;
	lake: number;
};

// ---------------------------------------------------------------- OSM → rings

type LL = LatLon;
type OsmEl = {
	type: string;
	id?: number;
	tags?: Record<string, string>;
	geometry?: LL[];
	members?: { role?: string; geometry?: LL[] }[];
};

/** Stitch open ways into closed rings by matching endpoints. */
export function stitchRings(ways: LL[][]): LL[][] {
	const key = (p: LL) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
	const rest = ways.filter((w) => w.length >= 2).map((w) => [...w]);
	const rings: LL[][] = [];
	while (rest.length) {
		let cur = rest.pop() as LL[];
		let guard = 0;
		while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 100000) {
			const end = key(cur[cur.length - 1]);
			const i = rest.findIndex(
				(w) => key(w[0]) === end || key(w[w.length - 1]) === end,
			);
			if (i < 0) break;
			const w = rest.splice(i, 1)[0];
			cur = cur.concat(key(w[0]) === end ? w.slice(1) : w.reverse().slice(1));
		}
		if (key(cur[0]) === key(cur[cur.length - 1]) && cur.length >= 4)
			rings.push(cur);
	}
	return rings;
}

/**
 * Lake rings from Overpass "out geom" elements (natural=water ways and multipolygon relations, as
 * src/lib/upload/region.ts regionQueries().water returns them). Rings in the scene frame via toEN.
 * Returns lakes without a level (levelM NaN); use lakeLevel to fill it.
 */
export function lakesFromOverpass(
	elements: OsmEl[],
	toEN: (lat: number, lon: number) => [number, number],
	opts: { minAreaM2?: number } = {},
): Lake[] {
	const minArea = opts.minAreaM2 ?? 20_000;
	const seen = new Set<string>();
	const lakes: Lake[] = [];
	for (const e of elements) {
		const t = e.tags ?? {};
		if (t.natural !== "water") continue;
		const id = `${e.type}/${e.id}`;
		if (e.id !== undefined && seen.has(id)) continue;
		seen.add(id);
		let outer: LL[][] = [];
		let inner: LL[][] = [];
		if (e.type === "way" && e.geometry) outer = stitchRings([e.geometry]);
		else if (e.type === "relation" && e.members) {
			outer = stitchRings(
				e.members
					.filter((m) => m.role !== "inner")
					.map((m) => m.geometry ?? []),
			);
			inner = stitchRings(
				e.members
					.filter((m) => m.role === "inner")
					.map((m) => m.geometry ?? []),
			);
		}
		const conv = (r: LL[]) => r.map((p) => toEN(p.lat, p.lon));
		const rings = outer
			.map(conv)
			.filter((r) => Math.abs(ringArea(r)) >= minArea);
		if (!rings.length) continue;
		rings.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
		lakes.push({
			polygon: rings[0],
			levelM: Number.NaN,
			holes: [...rings.slice(1), ...inner.map(conv)],
			name: t.name,
		});
	}
	return lakes;
}

export function ringArea(r: [number, number][]): number {
	let a = 0;
	for (let i = 0, j = r.length - 1; i < r.length; j = i++)
		a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
	return a / 2;
}

// ---------------------------------------------------------------- raster + distance

/** Even-odd raster of lakes (cell size adaptive), for fast inside tests. */
export class LakeRaster {
	readonly e0: number;
	readonly n0: number;
	readonly cell: number;
	readonly W: number;
	readonly H: number;
	readonly id: Int16Array;
	constructor(
		readonly lakes: Lake[],
		opts: { cell?: number; maxCells?: number } = {},
	) {
		let eMin = Infinity;
		let eMax = -Infinity;
		let nMin = Infinity;
		let nMax = -Infinity;
		for (const l of lakes)
			for (const [e, n] of l.polygon) {
				eMin = Math.min(eMin, e);
				eMax = Math.max(eMax, e);
				nMin = Math.min(nMin, n);
				nMax = Math.max(nMax, n);
			}
		if (!lakes.length) eMin = eMax = nMin = nMax = 0;
		const ext = Math.max(eMax - eMin, nMax - nMin, 1);
		const maxCells = opts.maxCells ?? 4000;
		this.cell = opts.cell ?? Math.max(4, ext / maxCells);
		this.e0 = eMin - this.cell;
		this.n0 = nMin - this.cell;
		this.W = Math.ceil((eMax - eMin) / this.cell) + 3;
		this.H = Math.ceil((nMax - nMin) / this.cell) + 3;
		this.id = new Int16Array(this.W * this.H).fill(-1);
		lakes.forEach((l, li) => {
			const rings = [l.polygon, ...(l.holes ?? [])];
			for (let y = 0; y < this.H; y++) {
				const n = this.n0 + (y + 0.5) * this.cell;
				const xs: number[] = [];
				for (const r of rings)
					for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
						const [ei, ni] = r[i];
						const [ej, nj] = r[j];
						if (ni > n !== nj > n)
							xs.push(ei + ((n - ni) * (ej - ei)) / (nj - ni));
					}
				xs.sort((a, b) => a - b);
				for (let k = 0; k + 1 < xs.length; k += 2) {
					const x0 = Math.ceil((xs[k] - this.e0) / this.cell - 0.5);
					const x1 = Math.floor((xs[k + 1] - this.e0) / this.cell - 0.5);
					for (let x = Math.max(0, x0); x <= Math.min(this.W - 1, x1); x++)
						this.id[y * this.W + x] = li;
				}
			}
		});
	}
	/** Lake index at (e, n) or −1. */
	at(e: number, n: number): number {
		const x = Math.floor((e - this.e0) / this.cell);
		const y = Math.floor((n - this.n0) / this.cell);
		if (x < 0 || y < 0 || x >= this.W || y >= this.H) return -1;
		return this.id[y * this.W + x];
	}
}

/** Signed distance (m) to a lake outline: negative inside the water. Bucketed segments. */
export function shoreDistance(
	lake: Lake,
	raster?: LakeRaster,
	lakeIndex = 0,
): (e: number, n: number) => number {
	const segs: number[] = [];
	for (const r of [lake.polygon, ...(lake.holes ?? [])])
		for (let i = 0, j = r.length - 1; i < r.length; j = i++)
			segs.push(r[j][0], r[j][1], r[i][0], r[i][1]);
	const B = 200;
	const buckets = new Map<string, number[]>();
	for (let s = 0; s < segs.length; s += 4) {
		const x0 = Math.floor(Math.min(segs[s], segs[s + 2]) / B);
		const x1 = Math.floor(Math.max(segs[s], segs[s + 2]) / B);
		const y0 = Math.floor(Math.min(segs[s + 1], segs[s + 3]) / B);
		const y1 = Math.floor(Math.max(segs[s + 1], segs[s + 3]) / B);
		for (let x = x0; x <= x1; x++)
			for (let y = y0; y <= y1; y++) {
				const k = `${x},${y}`;
				let a = buckets.get(k);
				if (!a) {
					a = [];
					buckets.set(k, a);
				}
				a.push(s);
			}
	}
	const ras = raster ?? new LakeRaster([lake]);
	const li = raster ? lakeIndex : 0;
	return (e: number, n: number) => {
		const bx = Math.floor(e / B);
		const by = Math.floor(n / B);
		let best = Infinity;
		for (let rad = 0; rad < 200; rad++) {
			for (let x = bx - rad; x <= bx + rad; x++)
				for (let y = by - rad; y <= by + rad; y++) {
					if (Math.max(Math.abs(x - bx), Math.abs(y - by)) !== rad) continue;
					for (const s of buckets.get(`${x},${y}`) ?? []) {
						const ax = segs[s];
						const ay = segs[s + 1];
						const dx = segs[s + 2] - ax;
						const dy = segs[s + 3] - ay;
						const L2 = dx * dx + dy * dy || 1;
						const t = Math.max(
							0,
							Math.min(1, ((e - ax) * dx + (n - ay) * dy) / L2),
						);
						const d = Math.hypot(e - ax - t * dx, n - ay - t * dy);
						if (d < best) best = d;
					}
				}
			if (best <= rad * B) break;
		}
		return ras.at(e, n) === li ? -best : best;
	};
}

/**
 * Lake level = median of absHeight over a grid inside the polygon (at most ~maxSamples points).
 * absHeight(e, n) returns ABSOLUTE DEM altitude (m) or NaN.
 */
export function lakeLevel(
	lake: Lake,
	absHeight: (e: number, n: number) => number,
	opts: {
		maxSamples?: number;
		region?: (e: number, n: number) => boolean;
	} = {},
): { levelM: number; n: number; iqrM: number } {
	const ras = new LakeRaster([lake], { maxCells: 1500 });
	const inside: [number, number][] = [];
	for (let y = 0; y < ras.H; y++)
		for (let x = 0; x < ras.W; x++)
			if (ras.id[y * ras.W + x] === 0) {
				const e = ras.e0 + (x + 0.5) * ras.cell;
				const n = ras.n0 + (y + 0.5) * ras.cell;
				if (!opts.region || opts.region(e, n)) inside.push([e, n]);
			}
	const max = opts.maxSamples ?? 3000;
	const stride = Math.max(1, Math.floor(inside.length / max));
	const hs: number[] = [];
	for (let i = 0; i < inside.length; i += stride) {
		const v = absHeight(inside[i][0], inside[i][1]);
		if (Number.isFinite(v)) hs.push(v);
	}
	hs.sort((a, b) => a - b);
	const q = (p: number) =>
		hs.length
			? hs[Math.min(hs.length - 1, Math.floor(p * hs.length))]
			: Number.NaN;
	return { levelM: q(0.5), n: hs.length, iqrM: q(0.75) - q(0.25) };
}

// ---------------------------------------------------------------- cues

export type WaterOpts = {
	/** Photo edges for the observed waterline (required unless photoWater is given). */
	edges?: PhotoEdges;
	/** Column spacing, px @1600. Default 8. */
	stepPx?: number;
	/** Vertical search half-width around the predicted waterline, px @1600. Default 10. */
	searchPx?: number;
	oriTolDeg?: number;
	/** +1: brighter below the waterline; −1: darker below; 0: any; "auto" (default). */
	polarity?: number | "auto";
	/** Level cues need a shore distance above this (m). Default 1000. */
	minLevelM?: number;
	/** Shore cues are emitted for shore distances in this range (m). Default [300, 3000]. */
	shoreRangeM?: [number, number];
	/** Lake-level σ (m) for sigmaPx. Default 0.5. */
	levelSigmaM?: number;
	/** Thin-edge quantile. Default 0.8. */
	pct?: number;
	/**
	 * Calm-water reflections: the waterline is the mirror axis of the column luminance profile, while
	 * the strongest horizontal edge is often the lower rim of the reflection. With edges.lum present,
	 * the axis maximising the mirror NCC over ±mirrorHalfPx (@1600) is used when NCC ≥ mirrorMinNcc
	 * (default 0.8); otherwise the edge search. mirrorHalfPx default 0 = off: on the dev lakes the
	 * mirror axis was 3× rougher along the shore and worse against the 6971 hand pins than the edge
	 * search (tools/concord/cues/RESULT.txt), so it stays an option.
	 */
	mirrorHalfPx?: number;
	mirrorMinNcc?: number;
};

/** Best mirror axis (edge-grid rows, sub-pixel) of a column strip within [y0, y1]; NCC ∈ [−1, 1]. */
export function mirrorAxis(
	lum: Float32Array,
	w: number,
	h: number,
	x: number,
	y0: number,
	y1: number,
	K: number,
	halfWidth = 2,
): { y: number; ncc: number } | null {
	const xa = Math.max(0, Math.round(x) - halfWidth);
	const xb = Math.min(w - 1, Math.round(x) + halfWidth);
	const prof = (y: number) => {
		const yi = Math.floor(y);
		const f = y - yi;
		if (yi < 0 || yi + 1 >= h) return Number.NaN;
		let s = 0;
		for (let xx = xa; xx <= xb; xx++)
			s += lum[yi * w + xx] * (1 - f) + lum[(yi + 1) * w + xx] * f;
		return s / (xb - xa + 1);
	};
	let best: { y: number; ncc: number } | null = null;
	for (let ya = y0; ya <= y1; ya += 0.5) {
		let sa = 0;
		let sb = 0;
		let saa = 0;
		let sbb = 0;
		let sab = 0;
		let n = 0;
		for (let k = 1; k <= K; k++) {
			const a = prof(ya - k);
			const b = prof(ya + k);
			if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
			sa += a;
			sb += b;
			saa += a * a;
			sbb += b * b;
			sab += a * b;
			n++;
		}
		if (n < K / 2) continue;
		const va = saa / n - (sa / n) ** 2;
		const vb = sbb / n - (sb / n) ** 2;
		if (va < 1e-5 || vb < 1e-5) continue;
		const ncc = (sab / n - (sa / n) * (sb / n)) / Math.sqrt(va * vb);
		if (!best || ncc > best.ncc) best = { y: ya, ncc };
	}
	return best;
}

/** Predicted far-shore waterline points (no photo evidence). */
export function predictWaterline(
	g: GeomBuffer,
	raster: LakeRaster,
	stepBuf: number,
): { u: number; v: number; lake: number; d: number; world: Vec3 }[] {
	const { w, h, range, sky, xyz } = g;
	const eye = g.eye ?? [0, 0, 0];
	const lakeAt = (k: number) =>
		sky[k] ? -2 : raster.at(xyz[3 * k], xyz[3 * k + 1]);
	const out: { u: number; v: number; lake: number; d: number; world: Vec3 }[] =
		[];
	for (let x = Math.floor(stepBuf / 2); x < w; x += stepBuf) {
		let prev = lakeAt(x);
		for (let y = 1; y < h; y++) {
			const k = y * w + x;
			const cur = lakeAt(k);
			const kp = k - w;
			if (cur >= 0 && prev === -1) {
				const ratio = range[k] / range[kp];
				if (ratio < 1.3 && ratio > 1 / 1.3) {
					// bisection: land above, water below
					let va = (y - 0.5) / h;
					let vb = (y + 0.5) / h;
					const u = (x + 0.5) / w;
					let hitW = g.cast?.(u, vb) ?? null;
					if (g.cast)
						for (let it = 0; it < 10; it++) {
							const vm = (va + vb) / 2;
							const hm = g.cast(u, vm);
							if (hm && raster.at(hm.world[0], hm.world[1]) === cur) {
								vb = vm;
								hitW = hm;
							} else va = vm;
						}
					const world: Vec3 = hitW
						? hitW.world
						: [xyz[3 * k], xyz[3 * k + 1], xyz[3 * k + 2]];
					out.push({
						u,
						v: (va + vb) / 2,
						lake: cur,
						d: Math.hypot(world[0] - eye[0], world[1] - eye[1]),
						world,
					});
				}
			}
			prev = cur;
		}
	}
	return out;
}

export function waterCues(
	g: GeomBuffer,
	cam: CameraX,
	lakes: Lake[],
	photoWater: Float32Array | null,
	opts: WaterOpts = {},
): Cue[] {
	return waterCuesX(g, cam, lakes, photoWater, opts).cues;
}

/** As waterCues, plus the predicted waterline and the polarity used (for audits). */
export function waterCuesX(
	g: GeomBuffer,
	cam: CameraX,
	lakes: Lake[],
	photoWater: Float32Array | null,
	opts: WaterOpts = {},
): {
	cues: WaterCue[];
	predicted: { u: number; v: number; lake: number; d: number }[];
	polarity: number;
} {
	const good = lakes.filter((l) => Number.isFinite(l.levelM));
	if (!good.length) return { cues: [], predicted: [], polarity: 0 };
	const raster = new LakeRaster(good);
	const toBuf = Math.max(g.w, g.h) / 1600;
	const pred = predictWaterline(
		g,
		raster,
		Math.max(1, Math.round((opts.stepPx ?? 8) * toBuf)),
	);
	const eye = g.eye ?? cam.eye;
	const fr = g.frame ?? { alt0: 0, rEff: Infinity };
	const fPx = focal1600(cam);
	const minLevel = opts.minLevelM ?? 1000;
	const [s0, s1] = opts.shoreRangeM ?? [300, 3000];
	const lvlSig = opts.levelSigmaM ?? 0.5;
	const elOf = (u: number, v: number) => {
		const d = unprojectDirX(cam, u, v);
		return Math.asin(Math.max(-1, Math.min(1, d[2]))) / DEG;
	};

	// observed rows
	type Obs = { t: number; conf: number; pol: number; mirror?: boolean } | null;
	let search: (p: (typeof pred)[number], pol: number) => Obs;
	if (photoWater) {
		search = (p) => {
			const x = Math.min(g.w - 1, Math.floor(p.u * g.w));
			const yc = p.v * g.h;
			const S = (opts.searchPx ?? 10) * toBuf;
			let best: Obs = null;
			for (
				let y = Math.max(0, Math.floor(yc - S));
				y < Math.min(g.h - 1, yc + S);
				y++
			) {
				const a = photoWater[y * g.w + x];
				const b = photoWater[(y + 1) * g.w + x];
				if (a < 0.5 && b >= 0.5) {
					const t = (y + 0.5 + (0.5 - a) / (b - a) - yc) / g.h;
					if (!best || Math.abs(t) < Math.abs(best.t))
						best = { t, conf: Math.min(1, b - a), pol: 1 };
				}
			}
			// t in v units
			return best;
		};
	} else {
		if (!opts.edges)
			throw new Error("waterCues: need opts.edges or photoWater");
		const E = opts.edges;
		const te = thinEdgesMemo(E, opts.pct ?? 0.8);
		const toE = Math.max(E.w, E.h) / 1600;
		const base = {
			search: (opts.searchPx ?? 10) * toE,
			band: Math.max(1, 1.5 * toE),
			tolRad: (opts.oriTolDeg ?? 20) * DEG,
			sepPx: 2 * toE,
		};
		const K = (opts.mirrorHalfPx ?? 0) * toE;
		const minNcc = opts.mirrorMinNcc ?? 0.8;
		search = (p, pol) => {
			if (E.lum && K > 0) {
				const yc = p.v * E.h;
				const mr = mirrorAxis(
					E.lum,
					E.w,
					E.h,
					p.u * E.w,
					yc - base.search,
					yc + base.search,
					Math.round(K),
				);
				if (mr && mr.ncc >= minNcc)
					return {
						t: (mr.y - yc) / E.h,
						conf: (mr.ncc - minNcc) / (1 - minNcc),
						pol: 0,
						mirror: true,
					};
			}
			const m = searchAlongNormal(te, p.u * E.w, p.v * E.h, 0, 1, {
				...base,
				polarity: pol,
			});
			return m ? { t: m.t / E.h, conf: m.conf, pol: m.pol } : null;
		};
	}

	let polarity = 0;
	if (opts.polarity === undefined || opts.polarity === "auto") {
		if (!photoWater) {
			let s = 0;
			let n = 0;
			for (const p of pred) {
				const o = search(p, 0);
				if (o && !o.mirror) {
					s += o.pol * o.conf;
					n += o.conf;
				}
			}
			polarity = n > 0 && Math.abs(s) / n >= 0.3 ? Math.sign(s) : 0;
		}
	} else polarity = opts.polarity;

	const dist = new Map<number, (e: number, n: number) => number>();
	const distOf = (li: number) => {
		let f = dist.get(li);
		if (!f) {
			f = shoreDistance(good[li], raster, li);
			dist.set(li, f);
		}
		return f;
	};
	const cues: WaterCue[] = [];
	for (const p of pred) {
		const o = search(p, polarity);
		if (!o) continue;
		const vObs = p.v + o.t;
		const lake = good[p.lake];
		const [e, n] = [p.world[0], p.world[1]];
		const dO = Math.hypot(e, n);
		const lz = lake.levelM - fr.alt0 - (dO * dO) / (2 * fr.rEff);
		const elT = Math.atan2(lz - eye[2], p.d) / DEG;
		const residualPx = fPx * (elOf(p.u, vObs) - elT) * DEG;
		const sigmaPx = Math.hypot(1, (fPx * lvlSig) / Math.max(p.d, 1));
		const world: Vec3 = [e, n, lz];
		const common = {
			u: p.u,
			v: vObs,
			depthM: p.d,
			sigmaPx,
			residualPx,
			conf: o.conf,
			predV: p.v,
			world,
			lake: p.lake,
		};
		if (p.d > minLevel)
			cues.push({
				...common,
				kind: "level",
				el: elT,
				source: o.mirror ? "waterline:mirror" : "waterline",
			});
		if (p.d >= s0 && p.d <= s1)
			cues.push({
				...common,
				kind: "shore",
				lakeM: lake.levelM,
				shoreDist: distOf(p.lake),
				source: o.mirror ? "shore:mirror" : "shore",
			});
	}
	return { cues, predicted: pred, polarity };
}
