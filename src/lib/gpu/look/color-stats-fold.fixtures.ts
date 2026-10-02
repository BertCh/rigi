// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared fixtures of the band-stats fold (./color-stats-fold.ts): the 12-scene synthetic generator and
// the CPU emulation of the GPU kernels (BAND_STATS / BAND_STATS_SG partials, luma's SpMV row sum,
// BAND_FINALIZE in f32). Used by color-stats-fold.check.ts (no GPU) and
// scripts/gpu/stats-fold-dawn.ts (the partials feed the real GPU fold on Dawn).
import {
	bandInputs,
	type ColorStats,
	N_BANDS,
	reduceBands,
} from "../../look/color-stats";
import { finalizeBands } from "./color-stats";
import { STATS_VALUES } from "./color-stats.wgsl";
import {
	foldSelectionCsr,
	STATS_WORDS,
	statsFromWords,
} from "./color-stats-fold";
import { STATS_LAYOUT } from "./color-stats-fold.wgsl";

export const GROUPS = 32;
export const WG = 64;
const f = Math.fround;

export function lcg(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

export type Pixels = {
	a: Float32Array;
	b: Float32Array;
	R: Float32Array;
	n: number;
};

/** BAND_STATS (sg = false) / BAND_STATS_SG (sg = subgroup size): GROUPS × 52 f32 partials. */
export function emulatePartials(px: Pixels, sg: number | false): Float32Array {
	const threads = GROUPS * WG;
	const out = new Float32Array(GROUPS * STATS_VALUES);
	const acc = Array.from({ length: WG }, () => new Float32Array(STATS_VALUES));
	for (let g = 0; g < GROUPS; g++) {
		for (let l = 0; l < WG; l++) {
			const A = acc[l];
			A.fill(0);
			for (let i = g * WG + l; i < px.n; i += threads) {
				const j = i * 4;
				if (px.b[j + 3] < 0.5) continue;
				const r = px.R[i];
				const band = r < 1000 ? 0 : r < 5000 ? 1 : r < 20000 ? 2 : 3;
				const o = band * 13;
				A[o] = f(A[o] + 1);
				for (let c = 0; c < 3; c++) {
					const av = px.a[j + c];
					const bv = px.b[j + c];
					A[o + 1 + c] = f(A[o + 1 + c] + av);
					A[o + 4 + c] = f(A[o + 4 + c] + f(av * av));
					A[o + 7 + c] = f(A[o + 7 + c] + bv);
					A[o + 10 + c] = f(A[o + 10 + c] + f(bv * bv));
				}
			}
		}
		for (let k = 0; k < STATS_VALUES; k++) {
			const v = Float32Array.from(acc, (A) => A[k]);
			let s: number;
			if (sg) {
				// subgroupAdd per subgroup (a tree), then invocation k sums the subgroups in order
				s = 0;
				for (let q = 0; q < WG; q += sg)
					s = f(s + treeSum(v.subarray(q, q + sg)));
			} else s = treeSum(v);
			out[g * STATS_VALUES + k] = s;
		}
	}
	return out;
}

/** f32 pairwise sum (workgroup tree / subgroupAdd model). */
export function treeSum(v: Float32Array): number {
	const t = Float32Array.from(v);
	for (let s = t.length >> 1; s > 0; s >>= 1)
		for (let i = 0; i < s; i++) t[i] = f(t[i] + t[i + s]);
	return t[0];
}

/** luma's SpMV row sum: one nonzero per lane (≤ 64 per row here), then a tree, f32. */
export function emulateSpmv(
	partial: Float32Array,
	csr: ReturnType<typeof foldSelectionCsr>,
): Float32Array {
	const folded = new Float32Array(STATS_VALUES);
	for (let j = 0; j < STATS_VALUES; j++) {
		const lanes = new Float32Array(64);
		for (let i = csr.rows[j]; i < csr.rows[j + 1]; i++)
			lanes[(i - csr.rows[j]) % 64] = f(
				lanes[(i - csr.rows[j]) % 64] + f(csr.vals[i] * partial[csr.cols[i]]),
			);
		folded[j] = treeSum(lanes);
	}
	return folded;
}

/** BAND_FINALIZE (color-stats-fold.wgsl.ts) in f32, one "invocation" per band: the STATS_WORDS words. */
export function emulateFinalize(
	folded: Float32Array,
	minCount: number,
): ArrayBuffer {
	const out = new Float32Array(STATS_WORDS);
	const trusted = (b: number) => folded[b * 13] >= minCount;
	let anyOk = false;
	let broken = false;
	for (let b = 0; b < N_BANDS; b++) {
		anyOk ||= trusted(b);
		broken ||= folded[b * 13] < 0;
	}
	const valid = anyOk && !broken;
	out[STATS_LAYOUT.valid] = broken ? -1 : valid ? 1 : 0;
	for (let k = 0; k < N_BANDS; k++) {
		out[STATS_LAYOUT.count + k] = broken ? 0 : folded[k * 13];
		let src = k;
		if (!trusted(k))
			for (let dk = 1; dk < N_BANDS; dk++) {
				if (k >= dk && trusted(k - dk)) {
					src = k - dk;
					break;
				}
				if (k + dk < N_BANDS && trusted(k + dk)) {
					src = k + dk;
					break;
				}
			}
		const o = src * 13;
		const n = folded[o];
		for (let c = 0; c < 3; c++) {
			const pm = f(folded[o + 1 + c] / n);
			const lm = f(folded[o + 7 + c] / n);
			const lo = c === 0 ? f(0.01) : f(0.004);
			const ps = Math.max(
				lo,
				f(Math.sqrt(Math.max(0, f(f(folded[o + 4 + c] / n) - f(pm * pm))))),
			);
			const ls = Math.max(
				lo,
				f(Math.sqrt(Math.max(0, f(f(folded[o + 10 + c] / n) - f(lm * lm))))),
			);
			const j = k * 3 + c;
			out[STATS_LAYOUT.photoMean + j] = valid ? pm : 0;
			out[STATS_LAYOUT.photoStd + j] = valid ? ps : 1;
			out[STATS_LAYOUT.layerMean + j] = valid ? lm : 0;
			out[STATS_LAYOUT.layerStd + j] = valid ? ls : 1;
		}
	}
	return out.buffer;
}

/** bandStatsGpu's f64 fold (fold "f64"). */
export function foldF64(p: Float32Array, minCount: number): ColorStats {
	const acc = new Float64Array(N_BANDS * 12);
	const cnt = new Uint32Array(N_BANDS);
	for (let g = 0; g < GROUPS; g++)
		for (let b = 0; b < N_BANDS; b++) {
			const s = g * STATS_VALUES + b * 13;
			cnt[b] += Math.round(p[s]);
			for (let v = 0; v < 12; v++) acc[b * 12 + v] += p[s + 1 + v];
		}
	return finalizeBands(acc, cnt, minCount);
}

export const gpuFold = (
	p: Float32Array,
	minCount: number,
	csr = foldSelectionCsr(GROUPS),
) => statsFromWords(emulateFinalize(emulateSpmv(p, csr), minCount));

export const KEYS = ["photoMean", "photoStd", "layerMean", "layerStd"] as const;
export function maxDelta(a: ColorStats, b: ColorStats) {
	let m = 0;
	for (const k of KEYS)
		for (let i = 0; i < a[k].length; i++)
			m = Math.max(m, Math.abs(a[k][i] - b[k][i]));
	return m;
}
export const sameCounts = (a: ColorStats, b: ColorStats) =>
	a.valid === b.valid && a.count.every((c, i) => c === b.count[i]);

export function makeScene(seed: number) {
	const rnd = lcg(seed);
	const w = [256, 192, 256, 144][seed % 4];
	const h = [192, 256, 144, 256][seed % 4];
	const n = w * h;
	const photo = new Uint8ClampedArray(n * 4);
	const layer = new Float32Array(n * 4);
	const range = new Float32Array(n);
	const fg = seed % 3 === 0 ? new Float32Array(n) : null;
	const skyline = h * (0.15 + 0.3 * rnd());
	// snowy / flat scenes stress the E[x²] − E[x]² cancellation of the f32 finalize
	const flat = seed % 5 === 0;
	const tint = [rnd(), rnd(), rnd()];
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const sky = y < skyline + 8 * Math.sin(x / 17 + seed);
			// metres: far (60 km) at the skyline down to near (300 m) at the bottom
			const t = (y - skyline) / (h - skyline);
			range[i] = sky ? 0 : 60000 * 200 ** -Math.max(0, t) * (0.9 + 0.2 * rnd());
			const base = flat ? 0.9 : 0.25 + 0.5 * t + 0.1 * Math.sin(x / 9);
			for (let c = 0; c < 3; c++) {
				const v = Math.min(
					1,
					Math.max(
						0,
						base * (0.8 + 0.3 * tint[c]) + (flat ? 0.01 : 0.08) * (rnd() - 0.5),
					),
				);
				photo[i * 4 + c] = Math.round(255 * v);
				// linear, premultiplied; a few partial-coverage pixels
				layer[i * 4 + c] =
					(0.6 * v ** 2.2 + 0.05 * rnd()) * (rnd() < 0.02 ? 0.5 : 1);
			}
			photo[i * 4 + 3] = 255;
			layer[i * 4 + 3] = rnd() < 0.02 ? 0.5 : 1;
			if (fg) fg[i] = x > w * 0.4 && x < w * 0.5 && y > h * 0.7 ? 1 : 0;
		}
	const minRange = [0, 300, 1500][seed % 3];
	const { a, b } = bandInputs(
		photo,
		layer,
		w,
		h,
		(x, y) => range[y * w + x],
		fg ? (x, y) => fg[y * w + x] : undefined,
		minRange,
	);
	// the GPU's own validity uses r > minRange from `range` directly: same as bandInputs' R
	return { px: { a, b, R: range, n } as Pixels, ref: reduceBands(a, b, n) };
}
