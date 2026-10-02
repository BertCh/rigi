// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * DOM-free building blocks of the sky segmenter, shared by the Web Worker and
 * the node evaluation script: resampling, the fast guided filter, model
 * pre/post-processing and the classical fallback.
 */
import { detectSkyline } from "../geo/skyline";

export interface RGBA {
	width: number;
	height: number;
	data: Uint8ClampedArray | Uint8Array;
}

/** Single-channel float image. */
export interface Plane {
	width: number;
	height: number;
	data: Float32Array;
}

/** Working-resolution size for a photo, long side `longSide` (never upscales). */
export function workingSize(w: number, h: number, longSide: number) {
	const s = Math.min(1, longSide / Math.max(w, h));
	return {
		width: Math.max(1, Math.round(w * s)),
		height: Math.max(1, Math.round(h * s)),
	};
}

/** Model input size: long side `longSide`, both sides multiples of 32 (U²-Net needs /32). */
export function modelSize(w: number, h: number, longSide: number) {
	const s = longSide / Math.max(w, h);
	const r = (v: number) => Math.max(64, Math.round((v * s) / 32) * 32);
	return { width: r(w), height: r(h) };
}

/**
 * Area-average resample of `c` interleaved float channels (downsampling),
 * bilinear when upsampling. Separable; exact for fractional ratios.
 */
function resampleAxis(
	src: Float32Array,
	n: number,
	stride: number,
	count: number,
	cstride: number,
	m: number,
	out: Float32Array,
	ostride: number,
	ocstride: number,
) {
	// Precompute weights for each output index.
	const scale = n / m;
	for (let j = 0; j < m; j++) {
		if (scale > 1) {
			const a = j * scale;
			const b = a + scale;
			const i0 = Math.floor(a);
			const i1 = Math.min(n, Math.ceil(b));
			for (let k = 0; k < count; k++) {
				let acc = 0;
				for (let i = i0; i < i1; i++) {
					const w = Math.min(b, i + 1) - Math.max(a, i);
					acc += w * src[k * cstride + i * stride];
				}
				out[k * ocstride + j * ostride] = acc / scale;
			}
		} else {
			const t = (j + 0.5) * scale - 0.5;
			const i0 = Math.max(0, Math.min(n - 1, Math.floor(t)));
			const i1 = Math.min(n - 1, i0 + 1);
			const f = Math.max(0, Math.min(1, t - i0));
			for (let k = 0; k < count; k++)
				out[k * ocstride + j * ostride] =
					src[k * cstride + i0 * stride] * (1 - f) +
					src[k * cstride + i1 * stride] * f;
		}
	}
}

/** Resamples a planar float image (`ch` planes of w×h) to W×H. */
export function resamplePlanes(
	src: Float32Array,
	w: number,
	h: number,
	ch: number,
	W: number,
	H: number,
): Float32Array {
	if (w === W && h === H) return src;
	// Horizontal: each (plane,row) is a line of length w → W.
	const tmp = new Float32Array(ch * h * W);
	for (let c = 0; c < ch; c++)
		resampleAxis(
			src.subarray(c * w * h),
			w,
			1,
			h,
			w,
			W,
			tmp.subarray(c * W * h),
			1,
			W,
		);
	const out = new Float32Array(ch * H * W);
	for (let c = 0; c < ch; c++)
		resampleAxis(
			tmp.subarray(c * W * h),
			h,
			W,
			W,
			1,
			H,
			out.subarray(c * W * H),
			W,
			1,
		);
	return out;
}

/** RGBA bytes → planar RGB floats in 0..1. */
export function rgbPlanes(img: RGBA): Float32Array {
	const n = img.width * img.height;
	const out = new Float32Array(3 * n);
	const d = img.data;
	for (let i = 0; i < n; i++) {
		out[i] = d[4 * i] / 255;
		out[n + i] = d[4 * i + 1] / 255;
		out[2 * n + i] = d[4 * i + 2] / 255;
	}
	return out;
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** Planar RGB 0..1 at model size → ImageNet-normalised NCHW float32. */
export function normalise(rgb: Float32Array, n: number): Float32Array {
	const out = new Float32Array(3 * n);
	for (let c = 0; c < 3; c++) {
		const m = MEAN[c];
		const s = 1 / STD[c];
		for (let i = 0; i < n; i++) out[c * n + i] = (rgb[c * n + i] - m) * s;
	}
	return out;
}

/** O(n) box mean with radius r and clamped borders (divides by true window size). */
export function boxMean(
	src: Float32Array,
	w: number,
	h: number,
	r: number,
	out = new Float32Array(w * h),
): Float32Array {
	const tmp = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		const o = y * w;
		let acc = 0;
		let cnt = 0;
		for (let x = 0; x <= Math.min(r, w - 1); x++) {
			acc += src[o + x];
			cnt++;
		}
		for (let x = 0; x < w; x++) {
			tmp[o + x] = acc / cnt;
			const add = x + r + 1;
			const sub = x - r;
			if (add < w) {
				acc += src[o + add];
				cnt++;
			}
			if (sub >= 0) {
				acc -= src[o + sub];
				cnt--;
			}
		}
	}
	for (let x = 0; x < w; x++) {
		let acc = 0;
		let cnt = 0;
		for (let y = 0; y <= Math.min(r, h - 1); y++) {
			acc += tmp[y * w + x];
			cnt++;
		}
		for (let y = 0; y < h; y++) {
			out[y * w + x] = acc / cnt;
			const add = y + r + 1;
			const sub = y - r;
			if (add < h) {
				acc += tmp[add * w + x];
				cnt++;
			}
			if (sub >= 0) {
				acc -= tmp[sub * w + x];
				cnt--;
			}
		}
	}
	return out;
}

export interface GuidedFilterOptions {
	/** Window radius at the LOW (coefficient) resolution. */
	radius?: number;
	/** Regularisation (guide in 0..1 units). */
	eps?: number;
}

/**
 * Fast colour guided filter (He, Sun & Tang 2013; He & Sun 2015 "Fast Guided
 * Filter"). Coefficients are solved at low resolution with a low-res colour
 * guide, averaged, bilinearly upsampled, then applied to the full-res guide:
 *     q = a · I_hi + b
 * so the output follows photo edges at full resolution.
 *
 * @param guideLo planar RGB 0..1 at (lw, lh)
 * @param p       input (probabilities) at (lw, lh)
 * @param guideHi planar RGB 0..1 at (W, H)
 */
export function fastGuidedFilter(
	guideLo: Float32Array,
	p: Float32Array,
	lw: number,
	lh: number,
	guideHi: Float32Array,
	W: number,
	H: number,
	opts: GuidedFilterOptions = {},
): Float32Array {
	const r = opts.radius ?? 4;
	const eps = opts.eps ?? 1e-3;
	const n = lw * lh;
	const I = [0, 1, 2].map((c) => guideLo.subarray(c * n, (c + 1) * n));
	const mI = I.map((c) => boxMean(c, lw, lh, r));
	const mp = boxMean(p, lw, lh, r);
	const prod = new Float32Array(n);
	const covIp = I.map((c, k) => {
		for (let i = 0; i < n; i++) prod[i] = c[i] * p[i];
		const m = boxMean(prod, lw, lh, r);
		for (let i = 0; i < n; i++) m[i] -= mI[k][i] * mp[i];
		return m;
	});
	const pairs: [number, number][] = [
		[0, 0],
		[0, 1],
		[0, 2],
		[1, 1],
		[1, 2],
		[2, 2],
	];
	const vars = pairs.map(([a, b]) => {
		for (let i = 0; i < n; i++) prod[i] = I[a][i] * I[b][i];
		const m = boxMean(prod, lw, lh, r);
		for (let i = 0; i < n; i++) m[i] -= mI[a][i] * mI[b][i];
		return m;
	});
	const [vrr, vrg, vrb, vgg, vgb, vbb] = vars;
	// a is 3 planes, b one plane → 4-plane buffer for joint smoothing/upsampling.
	const ab = new Float32Array(4 * n);
	for (let i = 0; i < n; i++) {
		const s00 = vrr[i] + eps;
		const s01 = vrg[i];
		const s02 = vrb[i];
		const s11 = vgg[i] + eps;
		const s12 = vgb[i];
		const s22 = vbb[i] + eps;
		// Inverse of symmetric 3×3 via cofactors.
		const c00 = s11 * s22 - s12 * s12;
		const c01 = s02 * s12 - s01 * s22;
		const c02 = s01 * s12 - s02 * s11;
		const c11 = s00 * s22 - s02 * s02;
		const c12 = s01 * s02 - s00 * s12;
		const c22 = s00 * s11 - s01 * s01;
		const det = s00 * c00 + s01 * c01 + s02 * c02;
		const id = 1 / det;
		const x0 = covIp[0][i];
		const x1 = covIp[1][i];
		const x2 = covIp[2][i];
		const a0 = (c00 * x0 + c01 * x1 + c02 * x2) * id;
		const a1 = (c01 * x0 + c11 * x1 + c12 * x2) * id;
		const a2 = (c02 * x0 + c12 * x1 + c22 * x2) * id;
		ab[i] = a0;
		ab[n + i] = a1;
		ab[2 * n + i] = a2;
		ab[3 * n + i] = mp[i] - a0 * mI[0][i] - a1 * mI[1][i] - a2 * mI[2][i];
	}
	for (let c = 0; c < 4; c++) {
		const plane = ab.subarray(c * n, (c + 1) * n);
		plane.set(boxMean(plane, lw, lh, r));
	}
	const up = resamplePlanes(ab, lw, lh, 4, W, H);
	const N = W * H;
	const q = new Float32Array(N);
	for (let i = 0; i < N; i++) {
		const v =
			up[i] * guideHi[i] +
			up[N + i] * guideHi[N + i] +
			up[2 * N + i] * guideHi[2 * N + i] +
			up[3 * N + i];
		q[i] = v < 0 ? 0 : v > 1 ? 1 : v;
	}
	return q;
}

/** Float 0..1 → Uint8 0..255. */
export function toBytes(p: Float32Array): Uint8Array {
	const out = new Uint8Array(p.length);
	for (let i = 0; i < p.length; i++) {
		const v = p[i];
		out[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
	}
	return out;
}

/** The model's output side of the pipeline, independent of the nn runtime. */
export interface ModelRun {
	/** P(sky) at model resolution. */
	prob: Float32Array;
	width: number;
	height: number;
}

/** Running max (or min) filter, radius r, separable. */
function extremum(
	src: Float32Array,
	w: number,
	h: number,
	r: number,
	max: boolean,
) {
	const pick = max ? Math.max : Math.min;
	const tmp = new Float32Array(w * h);
	const out = new Float32Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			let v = src[y * w + x];
			for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++)
				v = pick(v, src[y * w + k]);
			tmp[y * w + x] = v;
		}
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			let v = tmp[y * w + x];
			for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++)
				v = pick(v, tmp[k * w + x]);
			out[y * w + x] = v;
		}
	return out;
}

export interface RefineOptions extends GuidedFilterOptions {
	/**
	 * Half-width (low-res px) of the band around the model's sky boundary in
	 * which the guided filter's output is used; elsewhere the model's
	 * (upsampled) probability is kept, so photo texture (snow, cloud shading,
	 * wires) far from the boundary can't leak into the mask. Default 3.
	 */
	band?: number;
}

/**
 * Assembles the final mask at working resolution from a low-res P(sky) —
 * guided-filter refined (default) or plainly bilinear-upsampled.
 */
export function refineToWorking(
	rgbWork: Float32Array,
	W: number,
	H: number,
	low: ModelRun,
	refine: boolean,
	opts: RefineOptions = {},
): Float32Array {
	const { width: lw, height: lh, prob } = low;
	const up = resamplePlanes(prob, lw, lh, 1, W, H);
	if (!refine) return up;
	const guideLo = resamplePlanes(rgbWork, W, H, 3, lw, lh);
	const q = fastGuidedFilter(guideLo, prob, lw, lh, rgbWork, W, H, {
		radius: opts.radius ?? 3,
		eps: opts.eps ?? 2e-3,
	});
	// Band: where the neighbourhood straddles 0.5 or the model is unsure.
	const r = opts.band ?? 3;
	const mx = extremum(prob, lw, lh, r, true);
	const mn = extremum(prob, lw, lh, r, false);
	const band = new Float32Array(lw * lh);
	for (let i = 0; i < band.length; i++) {
		const straddle = mx[i] > 0.5 && mn[i] < 0.5 ? 1 : 0;
		const unsure = prob[i] > 0.05 && prob[i] < 0.95 ? 1 : 0;
		band[i] = Math.max(straddle, unsure);
	}
	const bandUp = resamplePlanes(boxMean(band, lw, lh, 1), lw, lh, 1, W, H);
	for (let i = 0; i < q.length; i++) {
		const b = bandUp[i];
		q[i] = b * q[i] + (1 - b) * up[i];
	}
	return q;
}

/**
 * Classical fallback when no model is available: the colour/texture sky
 * model + Viterbi boundary from geo/skyline.ts, run at ~640 px wide. Above a
 * confident boundary the column is sky (or the sky model where it says so);
 * below it, non-sky. Returns a low-res P(sky) to be guided-filter refined.
 */
export function classicalSky(
	rgbWork: Float32Array,
	W: number,
	H: number,
): ModelRun {
	const s = Math.min(1, 640 / Math.max(W, H));
	const w = Math.max(32, Math.round(W * s));
	const h = Math.max(32, Math.round(H * s));
	const rgb = resamplePlanes(rgbWork, W, H, 3, w, h);
	const n = w * h;
	const rgba = new Uint8ClampedArray(4 * n);
	for (let i = 0; i < n; i++) {
		rgba[4 * i] = rgb[i] * 255;
		rgba[4 * i + 1] = rgb[n + i] * 255;
		rgba[4 * i + 2] = rgb[2 * n + i] * 255;
		rgba[4 * i + 3] = 255;
	}
	const obs = detectSkyline({ width: w, height: h, data: rgba });
	const sky = obs.sky ?? new Uint8Array(n);
	const prob = new Float32Array(n);
	for (let x = 0; x < w; x++) {
		const yb = obs.rows[x];
		for (let y = 0; y < h; y++) {
			const i = y * w + x;
			const m = sky[i] / 255;
			if (Number.isFinite(yb)) {
				// Soft step at the boundary; sky model only relaxes the sky side.
				const t = 1 / (1 + Math.exp((y + 0.5 - yb) / 0.75));
				prob[i] = t * Math.max(m, 0.75);
			} else prob[i] = m;
		}
	}
	return { prob, width: w, height: h };
}
