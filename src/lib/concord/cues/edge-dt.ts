// Photo edges, oriented truncated distance transform and edge-cue matching (WP-C).
//
// Edge strength follows src/lib/align.ts buildEdgeMap (luminance + 2× "blueness" gradients) but as a
// Di Zenzo structure tensor so each pixel also gets an orientation. align.ts builds its map with a DOM
// canvas, so the CPU path here re-implements the per-pixel maths; photoEdgesFromEdgeMap reuses an
// existing EdgeMap (its `fine` magnitude, orientation recomputed from its rgb) read-only.
//
// Matching: for each predicted edge cue (u, v, normal n) the thin (non-maximum-suppressed) photo edge
// points in a band along the normal (|tangential| ≤ bandPx, |normal| ≤ searchPx) whose orientation is
// within oriTolDeg of n (mod 180°) are scored by strength × a Gaussian in the normal offset; the best
// gives the signed offset t (sub-pixel) and residualPx = −t (predicted − observed along n, px @1600).
// conf = uniqueness (1 − second/best among distinct offsets) × strength saturation.

import type { EdgeMap } from "../../align";
import { DEG } from "../../geodesy";
import type { Cue } from "../core";
import type { MatchedCue, PhotoEdges } from "./types";

function gaussBlur(src: Float32Array, w: number, h: number, sigma: number) {
	if (sigma <= 0) return src;
	const r = Math.max(1, Math.ceil(3 * sigma));
	const k = new Float32Array(2 * r + 1);
	let s = 0;
	for (let i = -r; i <= r; i++) {
		k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
		s += k[i + r];
	}
	for (let i = 0; i < k.length; i++) k[i] /= s;
	const tmp = new Float32Array(src.length);
	const out = new Float32Array(src.length);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			let a = 0;
			for (let i = -r; i <= r; i++)
				a += k[i + r] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
			tmp[y * w + x] = a;
		}
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			let a = 0;
			for (let i = -r; i <= r; i++)
				a += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
			out[y * w + x] = a;
		}
	return out;
}

/** Photo edges from RGBA pixels (any resolution; use long side 1600 for px @1600 matching). */
export function photoEdgesFromRGBA(
	data: ArrayLike<number>,
	w: number,
	h: number,
	opts: { sigma?: number; blueWeight?: number } = {},
): PhotoEdges {
	const N = w * h;
	const L0 = new Float32Array(N);
	const B0 = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		const r = data[i * 4];
		const g = data[i * 4 + 1];
		const b = data[i * 4 + 2];
		L0[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
		B0[i] = b / (r + g + b + 1);
	}
	const sig = opts.sigma ?? 1;
	const L = gaussBlur(L0, w, h, sig);
	const B = gaussBlur(B0, w, h, sig);
	const kb = opts.blueWeight ?? 2;
	const mag = new Float32Array(N);
	const ori = new Float32Array(N);
	for (let y = 1; y < h - 1; y++)
		for (let x = 1; x < w - 1; x++) {
			const i = y * w + x;
			const sob = (A: Float32Array) => [
				(A[i - w + 1] +
					2 * A[i + 1] +
					A[i + w + 1] -
					A[i - w - 1] -
					2 * A[i - 1] -
					A[i + w - 1]) /
					8,
				(A[i + w - 1] +
					2 * A[i + w] +
					A[i + w + 1] -
					A[i - w - 1] -
					2 * A[i - w] -
					A[i - w + 1]) /
					8,
			];
			const [lx, ly] = sob(L);
			const [bx0, by0] = sob(B);
			const bx = kb * bx0;
			const by = kb * by0;
			const gxx = lx * lx + bx * bx;
			const gyy = ly * ly + by * by;
			const gxy = lx * ly + bx * by;
			const tr = (gxx + gyy) / 2;
			const lam = tr + Math.sqrt(((gxx - gyy) / 2) ** 2 + gxy * gxy);
			mag[i] = Math.sqrt(Math.max(0, lam));
			let th = 0.5 * Math.atan2(2 * gxy, gxx - gyy);
			// polarity from luminance (dark → bright), else from blueness
			const pl = lx * Math.cos(th) + ly * Math.sin(th);
			const pb = bx * Math.cos(th) + by * Math.sin(th);
			if ((Math.abs(pl) > 1e-6 ? pl : pb) < 0) th += Math.PI;
			ori[i] = th > Math.PI ? th - 2 * Math.PI : th;
		}
	return { w, h, mag, ori, lum: L };
}

/** Reuse an app EdgeMap (align.ts): magnitude = map.fine, orientation from map.rgb. Read-only. */
export function photoEdgesFromEdgeMap(map: EdgeMap): PhotoEdges {
	const o = photoEdgesFromRGBA(map.rgb, map.w, map.h);
	return { w: map.w, h: map.h, mag: Float32Array.from(map.fine), ori: o.ori };
}

/**
 * Suppress edges under a foreground mask (people, boats, near objects; 0..1 at any resolution, 1 =
 * foreground), as align.ts does with its fgMask. Returns a new PhotoEdges.
 */
export function maskEdges(
	e: PhotoEdges,
	fg: { width: number; height: number; data: ArrayLike<number> },
	scale = 1,
): PhotoEdges {
	const mag = new Float32Array(e.mag.length);
	for (let y = 0; y < e.h; y++) {
		const my = Math.min(fg.height - 1, Math.floor((y / e.h) * fg.height));
		for (let x = 0; x < e.w; x++) {
			const mx = Math.min(fg.width - 1, Math.floor((x / e.w) * fg.width));
			const f = Math.min(1, fg.data[my * fg.width + mx] / scale);
			mag[y * e.w + x] = e.mag[y * e.w + x] * (1 - f);
		}
	}
	return { ...e, mag };
}

export type ThinEdges = {
	w: number;
	h: number;
	x: Float32Array;
	y: Float32Array;
	mag: Float32Array;
	ori: Float32Array;
	thresh: number;
	/** Grid index: cell → [start, end) into the arrays (points sorted by cell). */
	cell: number;
	cw: number;
	start: Int32Array;
};

/** Non-maximum suppression along the gradient + threshold at the `pct` quantile of edge strength. */
export function thinEdges(
	e: PhotoEdges,
	opts: { pct?: number; thresh?: number; cell?: number } = {},
): ThinEdges {
	const { w, h, mag, ori } = e;
	let thresh = opts.thresh;
	if (thresh === undefined) {
		const s = Float32Array.from(mag).sort();
		thresh = s[Math.floor(s.length * (opts.pct ?? 0.8))] || 1e-6;
	}
	const pts: { x: number; y: number; m: number; o: number }[] = [];
	const at = (x: number, y: number) => {
		const x0 = Math.floor(x);
		const y0 = Math.floor(y);
		if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) return 0;
		const fx = x - x0;
		const fy = y - y0;
		const i = y0 * w + x0;
		return (
			(mag[i] * (1 - fx) + mag[i + 1] * fx) * (1 - fy) +
			(mag[i + w] * (1 - fx) + mag[i + w + 1] * fx) * fy
		);
	};
	for (let y = 2; y < h - 2; y++)
		for (let x = 2; x < w - 2; x++) {
			const i = y * w + x;
			const m = mag[i];
			if (m < thresh) continue;
			const c = Math.cos(ori[i]);
			const s = Math.sin(ori[i]);
			const a = at(x - c, y - s);
			const b = at(x + c, y + s);
			if (m < a || m <= b) continue;
			// parabolic sub-pixel peak along the gradient
			const den = a - 2 * m + b;
			const off =
				den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - b)) / den)) : 0;
			pts.push({ x: x + 0.5 + off * c, y: y + 0.5 + off * s, m, o: ori[i] });
		}
	const cell = opts.cell ?? 8;
	const cw = Math.ceil(w / cell);
	const ch = Math.ceil(h / cell);
	const cid = (p: { x: number; y: number }) =>
		Math.min(ch - 1, Math.floor(p.y / cell)) * cw +
		Math.min(cw - 1, Math.floor(p.x / cell));
	pts.sort((p, q) => cid(p) - cid(q));
	const start = new Int32Array(cw * ch + 1);
	for (const p of pts) start[cid(p) + 1]++;
	for (let i = 0; i < cw * ch; i++) start[i + 1] += start[i];
	return {
		w,
		h,
		x: Float32Array.from(pts, (p) => p.x),
		y: Float32Array.from(pts, (p) => p.y),
		mag: Float32Array.from(pts, (p) => p.m),
		ori: Float32Array.from(pts, (p) => p.o),
		thresh,
		cell,
		cw,
		start,
	};
}

export type OrientedDT = {
	w: number;
	h: number;
	bins: number;
	truncPx: number;
	/** Per orientation bin (undirected, [0, π)): distance × scale to the nearest edge pixel, 255 = ≥ trunc. */
	dist: Uint8Array[];
	/** Quantisation: stored = round(distance · scale), scale = min(8, 254 / truncPx). */
	scale: number;
};

/** Exact 1-D squared EDT (Felzenszwalb–Huttenlocher); "no edge" = BIG (finite). */
const BIG = 1e20;
function edt1d(
	f: Float64Array,
	n: number,
	v: Int32Array,
	z: Float64Array,
	d: Float64Array,
) {
	let k = 0;
	v[0] = 0;
	z[0] = -Infinity;
	z[1] = Infinity;
	for (let q = 1; q < n; q++) {
		let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
		while (s <= z[k]) {
			k--;
			s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
		}
		k++;
		v[k] = q;
		z[k] = s;
		z[k + 1] = Infinity;
	}
	k = 0;
	for (let q = 0; q < n; q++) {
		while (z[k + 1] < q) k++;
		d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
	}
}

/** Oriented truncated distance transform of the thin photo edges (one EDT per orientation bin). */
export function orientedDT(
	t: ThinEdges,
	opts: { bins?: number; truncPx?: number } = {},
): OrientedDT {
	const { w, h } = t;
	const bins = opts.bins ?? 12;
	const trunc = opts.truncPx ?? 16;
	const n = Math.max(w, h);
	const f = new Float64Array(n);
	const d = new Float64Array(n);
	const v = new Int32Array(n);
	const z = new Float64Array(n + 1);
	const out: Uint8Array[] = [];
	const scale = Math.min(8, 254 / trunc);
	for (let b = 0; b < bins; b++) {
		const g = new Float64Array(w * h).fill(BIG);
		for (let i = 0; i < t.x.length; i++) {
			let o = t.ori[i] % Math.PI;
			if (o < 0) o += Math.PI;
			if (Math.min(bins - 1, Math.floor((o / Math.PI) * bins)) !== b) continue;
			const x = Math.min(w - 1, Math.floor(t.x[i]));
			const y = Math.min(h - 1, Math.floor(t.y[i]));
			g[y * w + x] = 0;
		}
		for (let x = 0; x < w; x++) {
			for (let y = 0; y < h; y++) f[y] = g[y * w + x];
			edt1d(f, h, v, z, d);
			for (let y = 0; y < h; y++) g[y * w + x] = d[y];
		}
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) f[x] = g[y * w + x];
			edt1d(f, w, v, z, d);
			for (let x = 0; x < w; x++) g[y * w + x] = d[x];
		}
		const q = new Uint8Array(w * h);
		for (let i = 0; i < w * h; i++) {
			const dd = Math.sqrt(g[i]);
			q[i] = dd >= trunc ? 255 : Math.min(254, Math.round(dd * scale));
		}
		out.push(q);
	}
	return { w, h, bins, truncPx: trunc, dist: out, scale };
}

/**
 * Truncated chamfer distance (px of the DT grid) at (x, y) to the nearest edge whose normal is within
 * tolDeg of theta (mod 180°). Returns truncPx when none is closer.
 */
export function chamferAt(
	dt: OrientedDT,
	x: number,
	y: number,
	theta: number,
	tolDeg = 20,
): number {
	const xi = Math.floor(x);
	const yi = Math.floor(y);
	if (xi < 0 || yi < 0 || xi >= dt.w || yi >= dt.h) return dt.truncPx;
	let o = theta % Math.PI;
	if (o < 0) o += Math.PI;
	const bw = Math.PI / dt.bins;
	let best = 255;
	for (let b = 0; b < dt.bins; b++) {
		const c = (b + 0.5) * bw;
		let da = Math.abs(c - o) % Math.PI;
		if (da > Math.PI / 2) da = Math.PI - da;
		if (da > tolDeg * DEG + bw / 2) continue;
		const q = dt.dist[b][yi * dt.w + xi];
		if (q < best) best = q;
	}
	return best === 255 ? dt.truncPx : best / dt.scale;
}

export type MatchOpts = {
	/** Search half-width along the normal, px @1600. Default 12. */
	searchPx?: number;
	oriTolDeg?: number;
	/** Candidates farther than this (px @1600) along the normal are ignored. Default = searchPx. */
	truncPx?: number;
	/** Tangential half-width of the search band, px @1600. Default 1.5. */
	bandPx?: number;
	/** Required polarity of the luminance gradient relative to the cue normal (+1, −1), 0 = any, or "auto". */
	polarity?: number | "auto";
	/** Quantile of edge strength for the thin-edge threshold. Default 0.8. */
	pct?: number;
};

const thinMemo = new WeakMap<PhotoEdges, Map<number, ThinEdges>>();
export function thinEdgesMemo(e: PhotoEdges, pct = 0.8): ThinEdges {
	let m = thinMemo.get(e);
	if (!m) {
		m = new Map();
		thinMemo.set(e, m);
	}
	let t = m.get(pct);
	if (!t) {
		t = thinEdges(e, { pct });
		m.set(pct, t);
	}
	return t;
}

export type NormalMatch = {
	/** Signed offset of the photo edge along n (edge px). */
	t: number;
	mag: number;
	conf: number;
	nCand: number;
	/** Thin edges of any orientation in the search band (clutter). */
	nBand: number;
	/** Sign of the best edge's luminance gradient along n (+1 dark→bright along n). */
	pol: number;
};

/** Search thin edges along the normal (nx, ny) at edge-grid point (px, py). Lengths in edge px. */
export function searchAlongNormal(
	te: ThinEdges,
	px: number,
	py: number,
	nx: number,
	ny: number,
	o: {
		search: number;
		band: number;
		tolRad: number;
		polarity: number;
		sepPx: number;
	},
): NormalMatch | null {
	const r = o.search + o.band + 1;
	const c0x = Math.max(0, Math.floor((px - r) / te.cell));
	const c1x = Math.min(te.cw - 1, Math.floor((px + r) / te.cell));
	const ch = te.start.length - 1;
	const rows = Math.ceil(ch / te.cw);
	const c0y = Math.max(0, Math.floor((py - r) / te.cell));
	const c1y = Math.min(rows - 1, Math.floor((py + r) / te.cell));
	const thN = Math.atan2(ny, nx);
	const sig = o.search / 2;
	const cand: { t: number; s: number; m: number; p: number }[] = [];
	let nBand = 0;
	for (let cy = c0y; cy <= c1y; cy++)
		for (let cx = c0x; cx <= c1x; cx++) {
			const c = cy * te.cw + cx;
			for (let i = te.start[c]; i < te.start[c + 1]; i++) {
				const ox = te.x[i] - px;
				const oy = te.y[i] - py;
				const t = ox * nx + oy * ny;
				if (Math.abs(t) > o.search) continue;
				if (Math.abs(ox * ny - oy * nx) > o.band) continue;
				nBand++;
				const cd = Math.cos(te.ori[i] - thN);
				if (Math.abs(cd) < Math.cos(o.tolRad)) continue;
				if (o.polarity !== 0 && Math.sign(cd) !== Math.sign(o.polarity))
					continue;
				cand.push({
					t,
					s: te.mag[i] * Math.exp(-(t * t) / (2 * sig * sig)),
					m: te.mag[i],
					p: Math.sign(cd),
				});
			}
		}
	if (!cand.length) return null;
	cand.sort((a, b) => b.s - a.s);
	const b = cand[0];
	let sw = 0;
	let st = 0;
	let second = 0;
	let nBest = 0;
	for (const c of cand) {
		if (Math.abs(c.t - b.t) <= 1) {
			nBest++;
			sw += c.s;
			st += c.s * c.t;
		} else if (Math.abs(c.t - b.t) > o.sepPx && c.s > second) second = c.s;
	}
	const uniq = 1 - second / b.s;
	const strength = Math.min(1, b.m / (2 * te.thresh));
	// clutter: share of all thin edges in the band (any orientation) that belong to the chosen edge
	const clean = nBest / Math.max(1, nBand);
	return {
		t: st / sw,
		mag: b.m,
		conf: uniq * strength * clean,
		nCand: cand.length,
		nBand,
		pol: b.p,
	};
}

/**
 * Match predicted edge cues to the photo edges. Non-"edge" cues and cues without a compatible photo
 * edge within truncPx are dropped. residualPx = (predicted − observed) along n, px @1600.
 * polarity "auto": one luminance polarity per call (majority of an unconstrained pass, if ≥ 30%
 * net agreement), e.g. hazier/brighter farther terrain beyond occluding contours.
 */
export function matchEdgeCues(
	cues: Cue[],
	edges: PhotoEdges,
	opts: MatchOpts = {},
): (Cue & { residualPx: number; conf: number; pol: number })[] {
	const te = thinEdgesMemo(edges, opts.pct ?? 0.8);
	const toE = Math.max(edges.w, edges.h) / 1600;
	const search = (opts.searchPx ?? 12) * toE;
	const trunc = (opts.truncPx ?? opts.searchPx ?? 12) * toE;
	const base = {
		search: Math.min(search, trunc),
		band: Math.max(1, (opts.bandPx ?? 1.5) * toE),
		tolRad: (opts.oriTolDeg ?? 20) * DEG,
		sepPx: 2 * toE,
	};
	const run = (polarity: number) => {
		const out: (MatchedCue & { pol: number })[] = [];
		for (const c of cues) {
			if (c.kind !== "edge") continue;
			const nn = Math.hypot(c.nu, c.nv) || 1;
			const m = searchAlongNormal(
				te,
				c.u * edges.w,
				c.v * edges.h,
				c.nu / nn,
				c.nv / nn,
				{ ...base, polarity },
			);
			if (!m) continue;
			out.push({ ...c, residualPx: -m.t / toE, conf: m.conf, pol: m.pol });
		}
		return out;
	};
	const p = opts.polarity ?? 0;
	if (p !== "auto") return run(p);
	const free = run(0);
	let sp = 0;
	let sw = 0;
	for (const c of free) {
		sp += c.pol * c.conf;
		sw += c.conf;
	}
	const pol = sw > 0 && Math.abs(sp) / sw >= 0.3 ? Math.sign(sp) : 0;
	return pol === 0 ? free : run(pol);
}
