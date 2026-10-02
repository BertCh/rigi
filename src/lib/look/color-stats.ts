// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Per-distance-band colour statistics for harmonising a rendered layer to the photo
// (region-matched Reinhard transfer, Reinhard et al. 2001, stratified by range).
//
// Colour space: Oklab rather than Reinhard's lαβ. Both are near-decorrelated opponent spaces, so
// a per-channel mean/std transfer is valid. Oklab has two practical advantages here:
//  - lαβ takes log(LMS). Black or near-black pixels (deep satellite shadows, lake water,
//    clear-colour texels) send it to −∞ and dominate the std. Oklab uses a cube root, which is
//    finite at zero and cheap in GLSL.
//  - Oklab L is perceptually uniform lightness. Matching μ/σ of L matches perceived contrast and
//    haze veiling, and chroma (a, b) can then be scaled separately (the maps keep ~40 % of their
//    own chroma so the swap still reads as "map").
//
// All on the CPU (P4 amendment: no GPU passes): each engine renders its layer once at ≤ 256 px and
// reads it back at pose settle; bandInputs() pairs it with the photo and the range buffer (photo
// Oklab + log-range, layer Oklab + validity) and reduceBands() reduces them into 4 log-range bands.
// Sky, people, layer holes and a skyline margin are masked out.

import { srgbToLinear } from "#/lib/color/srgb";

export const BAND_EDGES_M = [1000, 5000, 20000] as const;
/** Band centres in log10(m): near 0.5 km, mid √5 km, far 10 km, very far 40 km. */
export const BAND_CENTERS_LOG10 = [
	Math.log10(500),
	Math.log10(Math.sqrt(5) * 1000),
	4,
	Math.log10(40000),
];
export const N_BANDS = 4;

export type ColorStats = {
	/** Oklab mean and std per band, 3 floats per band (L, a, b) */
	photoMean: Float32Array;
	photoStd: Float32Array;
	layerMean: Float32Array;
	layerStd: Float32Array;
	/** valid pixels per band (before back-filling empty bands from neighbours) */
	count: Uint32Array;
	/** at least one band had enough pixels */
	valid: boolean;
};

function bandOf(log10r: number) {
	const r = 10 ** log10r;
	if (r < BAND_EDGES_M[0]) return 0;
	if (r < BAND_EDGES_M[1]) return 1;
	if (r < BAND_EDGES_M[2]) return 2;
	return 3;
}

export function identityStats(): ColorStats {
	const z = () => new Float32Array(N_BANDS * 3);
	const one = () => new Float32Array(N_BANDS * 3).fill(1);
	return {
		photoMean: z(),
		photoStd: one(),
		layerMean: z(),
		layerStd: one(),
		count: new Uint32Array(N_BANDS),
		valid: false,
	};
}

/** Linear sRGB → Oklab (the GLSL OKLAB_GLSL linearToOklab), into `out` at `o`. */
function toOklab(
	r: number,
	g: number,
	b: number,
	out: Float32Array,
	o: number,
) {
	const l = Math.cbrt(
		Math.max(0, 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
	);
	const m = Math.cbrt(
		Math.max(0, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
	);
	const s = Math.cbrt(
		Math.max(0, 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b),
	);
	out[o] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	out[o + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

const SRGB_LUT = Float32Array.from({ length: 256 }, (_, i) => {
	return srgbToLinear(i / 255);
});

/**
 * reduceBands' inputs at w × h (row 0 = top): `photo` sRGB bytes, `layer` linear PREMULTIPLIED RGBA
 * floats (alpha = coverage; this function divides rgb by alpha, so never pass un-premultiplied data), `range(x, y)` metres (≤ 0 or non-finite = sky),
 * `fg(x, y)` people 0..1. A pixel counts when it is terrain beyond `minRange` (m; nearer terrain is
 * misplaced by the GPS error anyway, and the engines treat it differently) that the layer fully
 * covers, not people, and ≥ 3 px from the sky (misregistration mixes sky into terrain there).
 */
export function bandInputs(
	photo: Uint8ClampedArray,
	layer: Float32Array,
	w: number,
	h: number,
	range: (x: number, y: number) => number,
	fg?: (x: number, y: number) => number,
	minRange = 0,
) {
	const a = new Float32Array(w * h * 4);
	const b = new Float32Array(w * h * 4);
	const R = new Float32Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const r = range(x, y);
			R[y * w + x] = r > 0 && Number.isFinite(r) ? r : 0;
		}
	const sky = (x: number, y: number) =>
		x >= 0 && y >= 0 && x < w && y < h && R[y * w + x] === 0;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const j = i * 4;
			toOklab(
				SRGB_LUT[photo[j]],
				SRGB_LUT[photo[j + 1]],
				SRGB_LUT[photo[j + 2]],
				a,
				j,
			);
			const r = R[i];
			a[j + 3] = r > 0 ? Math.log10(r) : 0;
			const la = layer[j + 3];
			const k = la > 0 ? 1 / la : 0;
			toOklab(layer[j] * k, layer[j + 1] * k, layer[j + 2] * k, b, j);
			let edge = false;
			for (let d = 1; d <= 3 && !edge; d++)
				edge = sky(x, y - d) || sky(x - d, y) || sky(x + d, y);
			b[j + 3] =
				r > minRange && la > 0.98 && !edge && !((fg?.(x, y) ?? 0) >= 0.3)
					? 1
					: 0;
		}
	return { a, b };
}

/** CPU reduction of the readback (exported for tests / worker use). */
export function reduceBands(
	a: Float32Array,
	b: Float32Array,
	n: number,
	minCount = 60,
): ColorStats {
	const acc = new Float64Array(N_BANDS * 12); // per band: sum p(3), sum p²(3), sum l(3), sum l²(3)
	const cnt = new Uint32Array(N_BANDS);
	for (let i = 0; i < n; i++) {
		const j = i * 4;
		if (b[j + 3] < 0.5) continue;
		const k = bandOf(a[j + 3]);
		cnt[k]++;
		const o = k * 12;
		for (let c = 0; c < 3; c++) {
			const pv = a[j + c];
			const lv = b[j + c];
			acc[o + c] += pv;
			acc[o + 3 + c] += pv * pv;
			acc[o + 6 + c] += lv;
			acc[o + 9 + c] += lv * lv;
		}
	}
	const s = identityStats();
	s.count = cnt;
	const ok = Array.from(cnt, (c) => c >= minCount);
	s.valid = ok.some(Boolean);
	if (!s.valid) return s;
	for (let k = 0; k < N_BANDS; k++) {
		// empty bands borrow the nearest trusted band so interpolation stays continuous
		let src = k;
		if (!ok[k]) {
			for (let dk = 1; dk < N_BANDS; dk++) {
				if (k - dk >= 0 && ok[k - dk]) {
					src = k - dk;
					break;
				}
				if (k + dk < N_BANDS && ok[k + dk]) {
					src = k + dk;
					break;
				}
			}
		}
		const o = src * 12;
		const N = cnt[src];
		for (let c = 0; c < 3; c++) {
			const pm = acc[o + c] / N;
			const lm = acc[o + 6 + c] / N;
			s.photoMean[k * 3 + c] = pm;
			s.layerMean[k * 3 + c] = lm;
			// floor the std so flat bands (snow, water) don't explode the ratio
			const floor = c === 0 ? 0.01 : 0.004;
			s.photoStd[k * 3 + c] = Math.max(
				floor,
				Math.sqrt(Math.max(0, acc[o + 3 + c] / N - pm * pm)),
			);
			s.layerStd[k * 3 + c] = Math.max(
				floor,
				Math.sqrt(Math.max(0, acc[o + 9 + c] / N - lm * lm)),
			);
		}
	}
	return s;
}

/**
 * Photo noise σ (sRGB luma, 0..1 units, at the image's native resolution) from flat sky.
 * Immerkær's fast estimator (1996): σ = √(π/2)/6 · mean|I ∗ N| with the 3×3 Laplacian-difference
 * kernel N, restricted to flat sky pixels (away from the skyline, low Sobel gradient). Falls back to
 * the flattest 15 % of all pixels when there is little sky.
 * `isSky(u, v)` takes normalised coords (v down); pass one built from the geometry readback.
 */
export function estimateNoiseSigma(
	img: ImageData,
	isSky?: (u: number, v: number) => boolean,
): number {
	const { width: W, height: H, data } = img;
	const Y = new Float32Array(W * H);
	for (let i = 0; i < W * H; i++)
		Y[i] =
			(0.2126 * data[i * 4] +
				0.7152 * data[i * 4 + 1] +
				0.0722 * data[i * 4 + 2]) /
			255;
	const skyVals: number[] = [];
	const allVals: { n: number; g: number }[] = [];
	const step = Math.max(1, Math.floor(Math.sqrt((W * H) / 400000)));
	for (let y = 2; y < H - 2; y += step)
		for (let x = 2; x < W - 2; x += step) {
			const i = y * W + x;
			const a = Y[i - W - 1];
			const b = Y[i - W];
			const c = Y[i - W + 1];
			const d = Y[i - 1];
			const e = Y[i];
			const f = Y[i + 1];
			const g = Y[i + W - 1];
			const h = Y[i + W];
			const k = Y[i + W + 1];
			const n = Math.abs(a - 2 * b + c - 2 * d + 4 * e - 2 * f + g - 2 * h + k);
			const gx = c + 2 * f + k - a - 2 * d - g;
			const gy = g + 2 * h + k - a - 2 * b - c;
			const grad = Math.hypot(gx, gy);
			if (isSky) {
				if (grad < 0.04 && isSky(x / W, y / H)) skyVals.push(n);
			}
			if ((x + y) % 3 === 0) allVals.push({ n, g: grad });
		}
	const est = (v: number[]) =>
		(Math.sqrt(Math.PI / 2) / 6) *
		(v.reduce((s, x) => s + x, 0) / Math.max(1, v.length));
	if (skyVals.length > 2000) return est(skyVals);
	allVals.sort((p, q) => p.g - q.g);
	return est(
		allVals.slice(0, Math.floor(allVals.length * 0.15)).map((v) => v.n),
	);
}
