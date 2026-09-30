// T-junction measurement on the photo (GA3).
//
// For each predicted junction J the photo edges (concord/cues/edge-dt.ts thin edges) are searched along
// the near contour's normal at arc offsets ±4/8/12 px from J (both sides) and along the far contour's
// normal at 4/8/12 px on its visible side. e = predicted − observed along the normal, px @1600 (median
// over the samples). The orientation tolerance is min(20°, angle/2) so a sample cannot lock onto the
// other contour of the junction.
//
// Residuals:
//   pair:  (e_near, e_far) — both contours; a common image translation t (rotation) enters as
//          (t·n_near, t·n_far), so a single junction carries no eye information on its own; it does
//          once rotation is pinned by other junctions or the far skyline.
//   diff:  r = e_far − e_near / (n_near·n_far) (the plan's differential residual): cancels any image
//          translation along n_far (pitch-like) exactly; a translation along the far tangent leaks with
//          gain tan(angle). Undefined (NaN) when |n_near·n_far| < cos(maxDiffAngleDeg).

import { type CameraX, projectX } from "../../concord/core";
import { defaultDemSigmaM, focal1600 } from "../../concord/cues/contours";
import { searchAlongNormal, thinEdgesMemo } from "../../concord/cues/edge-dt";
import type { PhotoEdges } from "../../concord/cues/types";
import { DEG } from "../../geodesy";
import type { Junction } from "./junctions";

/** An observed contour point: photo uv and the predicted unit normal (px @1600, x right, y down). */
export type ContourObs = { u: number; v: number; nx: number; ny: number };

export type JunctionObs = {
	/** The junction as predicted at the measuring camera. */
	j: Junction;
	/** Observed contour points (mean of the matched samples); null ⇒ not found. */
	near: ContourObs | null;
	far: ContourObs | null;
	/** Predicted − observed along the normal (px @1600, median over samples); NaN ⇒ not found. */
	eNear: number;
	eFar: number;
	/** Differential residual (px @1600); NaN when undefined. */
	r: number;
	nNearSamples: number;
	nFarSamples: number;
	/** Mean searchAlongNormal confidence of the matched samples. */
	conf: number;
	/** Per-contour σ (px @1600): hypot(pxSigma, f·σ_DEM(d)/d). */
	sigmaNear: number;
	sigmaFar: number;
	/** σ of the differential residual (px @1600). */
	sigmaR: number;
};

export type MeasureOpts = {
	/** Search half-width along the normal (px @1600). Default 12. */
	searchPx?: number;
	/** Tangential band (px @1600). Default 1.5. */
	bandPx?: number;
	/** Thin-edge strength quantile. Default 0.8. */
	pct?: number;
	/** Minimum matched samples per contour. Default 2. */
	minSamples?: number;
	/** Measurement σ (px @1600) before the DEM term. Default 1.5. */
	pxSigma?: number;
	demSigmaM?: (d: number) => number;
	/** diff residual only for crossing angles ≤ this (deg). Default 70. */
	maxDiffAngleDeg?: number;
};

const px1600 = (cam: CameraX): [number, number] =>
	cam.aspect >= 1 ? [1600, 1600 / cam.aspect] : [1600 * cam.aspect, 1600];

const median = (a: number[]) => {
	const s = [...a].sort((x, y) => x - y);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Measure junctions (predicted at `cam`) on the photo edges. Junctions with a missing contour keep NaN residuals. */
export function measureJunctions(
	js: Junction[],
	edges: PhotoEdges,
	cam: CameraX,
	o: MeasureOpts = {},
): JunctionObs[] {
	const te = thinEdgesMemo(edges, o.pct ?? 0.8);
	const toE = Math.max(edges.w, edges.h) / 1600;
	const search = (o.searchPx ?? 12) * toE;
	const band = Math.max(1, (o.bandPx ?? 1.5) * toE);
	const minS = o.minSamples ?? 2;
	const pxS = o.pxSigma ?? 1.5;
	const demS = o.demSigmaM ?? defaultDemSigmaM;
	const cosMax = Math.cos((o.maxDiffAngleDeg ?? 70) * DEG);
	const f = focal1600(cam);
	const [W, H] = px1600(cam);
	const out: JunctionObs[] = [];
	for (const j of js) {
		const tol = Math.min(20, j.angleDeg / 2) * DEG;
		const run = (pts: typeof j.nearPts, n: [number, number]) => {
			const es: number[] = [];
			let su = 0;
			let sv = 0;
			let sc = 0;
			for (const w of pts) {
				const p = projectX(cam, w);
				if (!p) continue;
				const m = searchAlongNormal(
					te,
					p.u * edges.w,
					p.v * edges.h,
					n[0],
					n[1],
					{ search, band, tolRad: tol, polarity: 0, sepPx: 2 * toE },
				);
				if (!m) continue;
				es.push(-m.t / toE);
				// observed point: predicted + t along n (edge px → uv)
				su += p.u + (m.t * n[0]) / edges.w;
				sv += p.v + (m.t * n[1]) / edges.h;
				sc += m.conf;
			}
			if (es.length < minS) return null;
			return {
				e: median(es),
				obs: { u: su / es.length, v: sv / es.length, nx: n[0], ny: n[1] },
				n: es.length,
				conf: sc / es.length,
			};
		};
		const a = run(j.nearPts, j.nNear);
		const b = run(j.farPts, j.nFar);
		const sN = Math.hypot(pxS, (f * demS(j.nearD)) / j.nearD);
		const sF = Number.isFinite(j.farD)
			? Math.hypot(pxS, (f * demS(j.farD)) / j.farD)
			: pxS;
		const c = j.nNear[0] * j.nFar[0] + j.nNear[1] * j.nFar[1];
		const eN = a ? a.e : Number.NaN;
		const eF = b ? b.e : Number.NaN;
		const okDiff = Math.abs(c) >= cosMax;
		out.push({
			j,
			near: a ? a.obs : null,
			far: b ? b.obs : null,
			eNear: eN,
			eFar: eF,
			r: okDiff ? eF - eN / c : Number.NaN,
			nNearSamples: a ? a.n : 0,
			nFarSamples: b ? b.n : 0,
			conf: ((a?.conf ?? 0) + (b?.conf ?? 0)) / 2,
			sigmaNear: sN,
			sigmaFar: sF,
			sigmaR: okDiff ? Math.hypot(sF, sN / Math.abs(c)) : Number.NaN,
		});
		void W;
		void H;
	}
	return out;
}

/**
 * Synthetic photo edges from a boundary mask (e.g. both sides of every range jump and sky boundary of a
 * GeomBuffer, see boundaryMask): mag = the mask blurred with σ = 0.8 px (a ridge centred on the boundary, so
 * thinEdges' non-maximum suppression finds its centre line), orientation = the normal of the mask's local
 * structure tensor. For render-only tests.
 */
export function edgesFromMask(
	mask: Uint8Array,
	w: number,
	h: number,
): PhotoEdges {
	const r = 2;
	const kr = [0.1353, 0.4578, 1, 0.4578, 0.1353]; // exp(−x²/(2·0.8²)), x = −2..2
	const tmp = new Float32Array(w * h);
	const mag = new Float32Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			let a = 0;
			for (let i = -r; i <= r; i++) {
				const x2 = x + i;
				if (x2 >= 0 && x2 < w) a += kr[i + r] * mask[y * w + x2];
			}
			tmp[y * w + x] = a;
		}
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			let a = 0;
			for (let i = -r; i <= r; i++) {
				const y2 = y + i;
				if (y2 >= 0 && y2 < h) a += kr[i + r] * tmp[y2 * w + x];
			}
			mag[y * w + x] = a / 4.18; // (Σk)² normalisation
		}
	const ori = new Float32Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const k = y * w + x;
			if (mag[k] < 0.02) continue;
			let sx = 0;
			let sy = 0;
			let n = 0;
			for (let dy = -r; dy <= r; dy++)
				for (let dx = -r; dx <= r; dx++) {
					const x2 = x + dx;
					const y2 = y + dy;
					if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) continue;
					if (mask[y2 * w + x2]) {
						sx += x2;
						sy += y2;
						n++;
					}
				}
			if (n < 2) continue;
			sx /= n;
			sy /= n;
			let a = 0;
			let b = 0;
			let c = 0;
			for (let dy = -r; dy <= r; dy++)
				for (let dx = -r; dx <= r; dx++) {
					const x2 = x + dx;
					const y2 = y + dy;
					if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) continue;
					if (!mask[y2 * w + x2]) continue;
					a += (x2 - sx) ** 2;
					b += (x2 - sx) * (y2 - sy);
					c += (y2 - sy) ** 2;
				}
			// tangent = major axis; normal ⟂
			const th = 0.5 * Math.atan2(2 * b, a - c) + Math.PI / 2;
			ori[k] = th > Math.PI ? th - 2 * Math.PI : th;
		}
	return { w, h, mag, ori };
}

/**
 * Both-sided boundary mask of a GeomBuffer-like range image: pixels on either side of a range jump
 * (ratio ≥ `ratio`, 4-neighbours) or of a sky / terrain transition.
 */
export function boundaryMask(
	range: Float32Array,
	sky: Uint8Array,
	w: number,
	h: number,
	ratio = 1.3,
): Uint8Array {
	const m = new Uint8Array(w * h);
	const jump = (a: number, b: number) => {
		if (sky[a] !== sky[b]) return true;
		if (sky[a]) return false;
		const ra = range[a];
		const rb = range[b];
		return ra > rb * ratio || rb > ra * ratio;
	};
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const k = y * w + x;
			if (x + 1 < w && jump(k, k + 1)) m[k] = m[k + 1] = 1;
			if (y + 1 < h && jump(k, k + w)) m[k] = m[k + w] = 1;
		}
	return m;
}
