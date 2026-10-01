// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Per-photo exposure / white-balance gains for the roll drape, solved from the overlaps.
//
// Two photos of the same ground differ by their camera's exposure and white balance (and by the
// haze between each camera and the ground, which clear air removes first: look/clear-air.ts). With
// the haze out, a photo's linear colour of a ground point is the ground's albedo times a per-channel
// scale, so log c_i(p) - log c_j(p) = log s_i - log s_j for every ground point p both see. The
// gains g_i = exp(x_i) that make the overlaps agree minimise, per colour channel,
//
//   E(x) = Σ_{pairs ab} w_ab (x_a - x_b + d_ab)² + λ Σ_a x_a²,   d_ab = median_p (log c_a - log c_b)
//
// (x_a + log c_a = x_b + log c_b at the optimum). d_ab is the median over the mutually visible
// samples of the pair (robust to people, moving water, shadows that differ between the shots);
// w_ab = min(1, n_ab / 150) trusts pairs with more samples; λ = 0.1 × the mean node degree
// (Σ w · 2 / N) ties the gauge (all gains scale together: the overall brightness stays the
// photos') and shrinks photos with a single weak overlap toward 1. The normal equations
// (L + λI) x = ∓Σ w d are solved densely (Cholesky, N ≤ ~200) inside an IRLS loop with Huber
// weights (δ = 0.1 in log units: an overlap that disagrees by more than 10 % after the fit counts
// less). Gains are clamped to [0.5, 2].
//
// Samples: each photo contributes a ≤ 64 × 48 grid of ground points (its range map decimated: the
// cell centre's ray × range, skipped at depth discontinuities where one texel straddles a ridge and
// the far ground) with the box-averaged linear colour of its cell. For each such point the photo's
// ≤ MAX_PARTNERS nearest neighbours (by eye distance) project it with their view-projection and
// keep it when it lies inside their frame, within reach and not occluded by their own range map
// (the shader's test with a looser bias: the grid is coarse), then compare the clear-air-corrected
// colours (clearAirPixel, the CPU mirror of the shader's inversion) at that point, dropping
// saturated or near-black samples whose log is noise. CPU on purpose: ≤ 12 × 3 k projections per
// photo, a few ms each, yielded to the event loop between photos; the heavy per-pixel work
// (the fit, the blend) is on the GPU.
import { unprojectDir } from "#/lib/camera";
import { photoViewProjection } from "#/lib/deck/photo-view";
import { type ClearAirValues, clearAirPixel } from "#/lib/look/clear-air";
import { srgbToLinear } from "#/lib/style/color";

type Vec3 = [number, number, number];
type Cam = {
	pose: Parameters<typeof photoViewProjection>[0];
	eye: [number, number, number];
	aspect: number;
};

/** Long side (cells) of a photo's sample grid. */
const GRID_LONG = 64;
/** Neighbours each photo is compared with (nearest eyes first). */
const MAX_PARTNERS = 12;
/** Fewest mutually visible samples for a pair to count. */
const MIN_PAIR_N = 24;
/** Samples at which a pair is fully trusted. */
const FULL_PAIR_N = 150;
/** Ground nearer / farther than this (m) from either camera is not compared (GPS error / haze). */
const NEAR_M = 100;
const FAR_M = 8000;
/** Huber knee (log units) and IRLS rounds. */
const HUBER = 0.1;
const IRLS = 5;
const GAIN_MIN = 0.5;
const GAIN_MAX = 2;
/** Linear values outside this are saturated / noise-dominated in log space. */
const LO = 0.02;
const HI = 0.95;

const LUT = (() => {
	const t = new Float32Array(256);
	for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255);
	return t;
})();

/** A photo's decimated range map (row 0 = top, 0 = sky). */
export type RangeGrid = { w: number; h: number; data: Float32Array };

/** One photo's samples: ground points (ENU, roll frame) and the raw linear colour of their cells. */
export type GainSamples = {
	/** Sample grid size. */
	gw: number;
	gh: number;
	/** 3 per cell; NaN = no sample (sky, depth edge, out of reach). */
	pos: Float32Array;
	/** 3 per cell, linear, box-averaged over the cell. */
	col: Float32Array;
};

/**
 * The photo's sample grid. `px` is the photo at any size (sRGB, row 0 = top), `range` its
 * decimated range map for `cam`.
 */
export function sampleGrid(
	cam: Cam,
	range: RangeGrid,
	px: { width: number; height: number; data: Uint8ClampedArray | Uint8Array },
): GainSamples {
	const gw =
		cam.aspect >= 1
			? GRID_LONG
			: Math.max(1, Math.round(GRID_LONG * cam.aspect));
	const gh =
		cam.aspect >= 1
			? Math.max(1, Math.round(GRID_LONG / cam.aspect))
			: GRID_LONG;
	const pos = new Float32Array(gw * gh * 3).fill(Number.NaN);
	const col = new Float32Array(gw * gh * 3);
	const rangeAt = (gx: number, gy: number) => {
		const x = Math.min(
			range.w - 1,
			Math.max(0, Math.floor(((gx + 0.5) / gw) * range.w)),
		);
		const y = Math.min(
			range.h - 1,
			Math.max(0, Math.floor(((gy + 0.5) / gh) * range.h)),
		);
		return range.data[y * range.w + x];
	};
	for (let gy = 0; gy < gh; gy++)
		for (let gx = 0; gx < gw; gx++) {
			const i = gy * gw + gx;
			// colour: box average over the cell (every 2nd pixel), in linear light
			const x0 = Math.floor((gx / gw) * px.width);
			const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) / gw) * px.width));
			const y0 = Math.floor((gy / gh) * px.height);
			const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) / gh) * px.height));
			let r = 0;
			let g = 0;
			let b = 0;
			let n = 0;
			for (let y = y0; y < y1; y += 2)
				for (let x = x0; x < x1; x += 2) {
					const o = (y * px.width + x) * 4;
					r += LUT[px.data[o]];
					g += LUT[px.data[o + 1]];
					b += LUT[px.data[o + 2]];
					n++;
				}
			col[i * 3] = r / n;
			col[i * 3 + 1] = g / n;
			col[i * 3 + 2] = b / n;
			// position: the cell centre's ray × range, unless a depth edge runs through the cell
			const rr = rangeAt(gx, gy);
			if (!(rr > NEAR_M && rr < FAR_M)) continue;
			let edge = false;
			for (const [dx, dy] of [
				[-1, 0],
				[1, 0],
				[0, -1],
				[0, 1],
			]) {
				const q = rangeAt(
					Math.min(gw - 1, Math.max(0, gx + dx)),
					Math.min(gh - 1, Math.max(0, gy + dy)),
				);
				if (!(q > 0) || Math.max(q, rr) / Math.min(q, rr) > 1.15) edge = true;
			}
			if (edge) continue;
			const d = unprojectDir(
				cam.pose,
				cam.aspect,
				(gx + 0.5) / gw,
				(gy + 0.5) / gh,
			);
			pos[i * 3] = cam.eye[0] + d[0] * rr;
			pos[i * 3 + 1] = cam.eye[1] + d[1] * rr;
			pos[i * 3 + 2] = cam.eye[2] + d[2] * rr;
		}
	return { gw, gh, pos, col };
}

export type GainPhoto = {
	cam: Cam;
	range: RangeGrid;
	samples: GainSamples;
	/** The photo's clear-air values (CLEAR_AIR_OFF when unfitted). */
	values: ClearAirValues;
};

const median = (a: number[]) => {
	const s = Float64Array.from(a).sort();
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
};

/** Cholesky solve of the SPD system A x = b (A is n × n, row-major; overwritten). */
function cholSolve(A: Float64Array, b: Float64Array, n: number) {
	for (let j = 0; j < n; j++) {
		let s = A[j * n + j];
		for (let k = 0; k < j; k++) s -= A[j * n + k] * A[j * n + k];
		const d = Math.sqrt(Math.max(s, 1e-12));
		A[j * n + j] = d;
		for (let i = j + 1; i < n; i++) {
			let t = A[i * n + j];
			for (let k = 0; k < j; k++) t -= A[i * n + k] * A[j * n + k];
			A[i * n + j] = t / d;
		}
	}
	const y = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		let t = b[i];
		for (let k = 0; k < i; k++) t -= A[i * n + k] * y[k];
		y[i] = t / A[i * n + i];
	}
	const x = new Float64Array(n);
	for (let i = n - 1; i >= 0; i--) {
		let t = y[i];
		for (let k = i + 1; k < n; k++) t -= A[k * n + i] * x[k];
		x[i] = t / A[i * n + i];
	}
	return x;
}

export type PairStat = { a: number; b: number; w: number; d: Vec3 };

/**
 * The per-photo linear gains (null = no overlap evidence: leave the photos alone). `stale` is polled
 * between photos (a newer request supersedes this one).
 */
export async function solveGains(
	photos: readonly GainPhoto[],
	stale: () => boolean = () => false,
): Promise<Vec3[] | null> {
	const N = photos.length;
	if (N < 2) return null;
	const vp = photos.map((p) =>
		photoViewProjection(p.cam.pose, p.cam.eye, p.cam.aspect),
	);
	// per unordered pair (a < b): log c_a - log c_b per channel, per mutually visible sample
	const diffs = new Map<number, number[][]>();
	for (let i = 0; i < N; i++) {
		if (stale()) return null;
		const P = photos[i];
		const partners = photos
			.map((q, j) => ({
				j,
				d: Math.hypot(
					q.cam.eye[0] - P.cam.eye[0],
					q.cam.eye[1] - P.cam.eye[1],
					q.cam.eye[2] - P.cam.eye[2],
				),
			}))
			.filter((e) => e.j !== i && e.d < 2 * FAR_M)
			.sort((x, y) => x.d - y.d)
			.slice(0, MAX_PARTNERS);
		const S = P.samples;
		for (const { j } of partners) {
			const Q = photos[j];
			const M = vp[j];
			const T = Q.samples;
			const key = i < j ? i * N + j : j * N + i;
			const sign = i < j ? 1 : -1;
			for (let s = 0; s < S.gw * S.gh; s++) {
				const X = S.pos[s * 3];
				if (Number.isNaN(X)) continue;
				const Y = S.pos[s * 3 + 1];
				const Z = S.pos[s * 3 + 2];
				const w = M[3] * X + M[7] * Y + M[11] * Z + M[15];
				if (w <= 0) continue;
				const u = ((M[0] * X + M[4] * Y + M[8] * Z + M[12]) / w) * 0.5 + 0.5;
				const v = 0.5 - ((M[1] * X + M[5] * Y + M[9] * Z + M[13]) / w) * 0.5;
				if (u < 0.03 || u > 0.97 || v < 0.03 || v > 0.97) continue;
				const rj = Math.hypot(
					X - Q.cam.eye[0],
					Y - Q.cam.eye[1],
					Z - Q.cam.eye[2],
				);
				if (rj < NEAR_M || rj > FAR_M) continue;
				// occluded from j? (the shader's range test, looser for the coarse map)
				const seen =
					Q.range.data[
						Math.min(Q.range.h - 1, Math.floor(v * Q.range.h)) * Q.range.w +
							Math.min(Q.range.w - 1, Math.floor(u * Q.range.w))
					];
				if (!(seen > 0 && rj < seen * 1.03 + 25)) continue;
				// j's colour: bilinear over its cell centres
				const fx = Math.min(Math.max(u * T.gw - 0.5, 0), T.gw - 1);
				const fy = Math.min(Math.max(v * T.gh - 0.5, 0), T.gh - 1);
				const x0 = Math.floor(fx);
				const y0 = Math.floor(fy);
				const x1 = Math.min(x0 + 1, T.gw - 1);
				const y1 = Math.min(y0 + 1, T.gh - 1);
				const tx = fx - x0;
				const ty = fy - y0;
				const cj: Vec3 = [0, 0, 0];
				for (let c = 0; c < 3; c++) {
					const at = (x: number, y: number) => T.col[(y * T.gw + x) * 3 + c];
					cj[c] =
						(at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) +
						(at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
				}
				const p: Vec3 = [X, Y, Z];
				const ci = clearAirPixel(
					P.values,
					[S.col[s * 3], S.col[s * 3 + 1], S.col[s * 3 + 2]],
					p,
					P.cam.eye,
				);
				const cjc = clearAirPixel(Q.values, cj, p, Q.cam.eye);
				if (
					ci.some((c) => c < LO || c > HI) ||
					cjc.some((c) => c < LO || c > HI)
				)
					continue;
				let l = diffs.get(key);
				if (!l) {
					l = [[], [], []];
					diffs.set(key, l);
				}
				for (let c = 0; c < 3; c++)
					l[c].push(sign * (Math.log(ci[c]) - Math.log(cjc[c])));
			}
		}
		await new Promise((r) => setTimeout(r, 0));
	}
	const pairs: PairStat[] = [];
	for (const [key, l] of diffs) {
		if (l[0].length < MIN_PAIR_N) continue;
		pairs.push({
			a: Math.floor(key / N),
			b: key % N,
			w: Math.min(1, l[0].length / FULL_PAIR_N),
			d: [median(l[0]), median(l[1]), median(l[2])],
		});
	}
	if (!pairs.length) return null;
	return solveLogGains(N, pairs).map((x) => [
		clampGain(Math.exp(x[0])),
		clampGain(Math.exp(x[1])),
		clampGain(Math.exp(x[2])),
	]);
}

const clampGain = (g: number) => Math.min(GAIN_MAX, Math.max(GAIN_MIN, g));

/** The regularised, Huber-reweighted least squares of the header: log gains per photo (3 channels). */
export function solveLogGains(N: number, pairs: readonly PairStat[]): Vec3[] {
	const degree = (2 * pairs.reduce((s, p) => s + p.w, 0)) / N;
	const lambda = Math.max(0.1 * degree, 1e-3);
	const out: Vec3[] = Array.from({ length: N }, () => [0, 0, 0]);
	for (let c = 0; c < 3; c++) {
		let x = new Float64Array(N);
		const hw = pairs.map(() => 1);
		for (let it = 0; it < IRLS; it++) {
			const A = new Float64Array(N * N);
			const b = new Float64Array(N);
			for (let i = 0; i < N; i++) A[i * N + i] = lambda;
			for (const [q, p] of pairs.entries()) {
				const w = p.w * hw[q];
				A[p.a * N + p.a] += w;
				A[p.b * N + p.b] += w;
				A[p.a * N + p.b] -= w;
				A[p.b * N + p.a] -= w;
				b[p.a] -= w * p.d[c];
				b[p.b] += w * p.d[c];
			}
			x = cholSolve(A, b, N);
			for (const [q, p] of pairs.entries()) {
				const e = Math.abs(x[p.a] - x[p.b] + p.d[c]);
				hw[q] = e > HUBER ? HUBER / e : 1;
			}
		}
		for (let i = 0; i < N; i++) out[i][c] = x[i];
	}
	return out;
}
