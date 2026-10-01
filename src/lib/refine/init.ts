// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Global initialisation: 1-D circular correlation of the photo's skyline
 * elevation profile against the 360° DEM horizon, done with FFTs.
 *
 * The photo columns are back-projected through the prior camera to
 * (azimuth, elevation) and binned on a 2^13-sample azimuth grid (0.044°).
 * For every yaw shift Δ (±30° by default) the cost is the weighted SSD
 *
 *   C(Δ) = min_{a,b}  α·Σ_i w_i (P_i + a + b·x_i − H(az_i + Δ))²  + a²/σa² + b²/σb²
 *
 * with a free pitch offset a and a free roll tilt b (x_i = azimuth relative
 * to the prior yaw), both regularised by the gravity prior. Expanding the
 * square, C(Δ) needs only four circular correlations — Σw·P·H, Σw·H, Σw·H²
 * and Σw·x·H — which are computed for all Δ at once by FFT. A small sweep
 * over focal-length scale is done by re-binning. With the per-shift
 * nuisance fit in hand, a robust match score (weighted fraction of columns
 * within τ = 0.25° of the DEM, Epanechnikov kernel) is evaluated for every
 * shift; its top K local maxima more than 1° apart are the modes, and its
 * peak-to-sidelobe ratio is the correlation confidence.
 */

import type { HorizonProfile } from "../geo/horizon";
import { wrap180 } from "../geodesy";
import { correlateSpectra, rfft } from "./fft";
import {
	type Column,
	DEG,
	evalColumn,
	type Geometry,
	horizonTable,
	LOGF,
	newEval,
	YAW,
} from "./model";

export interface InitOptions {
	/** Yaw search half-width around the prior, degrees. */
	yawRange: number;
	/** Focal-length scales to sweep. */
	fScales: number[];
	/** Azimuth grid size (power of two). */
	gridSize: number;
	/** Number of modes to return. */
	modes: number;
	/** Minimum separation between modes, degrees. */
	minSeparation: number;
	/** Regularisation of the free pitch offset / roll tilt, degrees. */
	pitchSigmaDeg: number;
	rollSigmaDeg: number;
	/** Yaw prior σ, degrees (a weak penalty on the shift). */
	yawSigmaDeg: number;
	/** Per-column noise (degrees) and assumed correlation length (columns) for α. */
	noiseDeg: number;
	corrLength: number;
	/** Shrinking Tukey windows (deg) for the robust per-shift pitch/roll fit. */
	irlsWindows: number[];
	/** Max columns used for the robust score curve. */
	scoreColumns: number;
	/** Match tolerance τ of the robust score curve, degrees. */
	truncDeg: number;
	/** PSR exclusion half-window, degrees. */
	psrExclusion: number;
}

export const DEFAULT_INIT: InitOptions = {
	yawRange: 30,
	fScales: [0.96, 0.98, 1, 1.02, 1.04],
	gridSize: 8192,
	modes: 5,
	minSeparation: 1,
	pitchSigmaDeg: 1.5,
	rollSigmaDeg: 1.5,
	yawSigmaDeg: 10,
	noiseDeg: 0.1,
	corrLength: 10,
	irlsWindows: [1.5, 0.8, 0.4],
	scoreColumns: 400,
	truncDeg: 0.25,
	psrExclusion: 1,
};

export interface InitMode {
	/** Yaw offset from the prior, degrees. */
	dYaw: number;
	/** Pitch offset from the prior, degrees. */
	dPitch: number;
	/** Roll offset from the prior, degrees. */
	dRoll: number;
	fScale: number;
	/** SSD cost from the correlation. */
	cost: number;
	/** −(robust match score): lower is better. */
	robustCost: number;
}

export interface InitResult {
	modes: InitMode[];
	/** Peak-to-sidelobe ratio of the score curve −C(Δ). */
	psr: number;
	/** Yaw offsets (deg) and best score per offset. */
	shifts: Float64Array;
	score: Float64Array;
	ms: number;
}

interface Binned {
	W: Float64Array;
	WP: Float64Array;
	WX: Float64Array;
	/** Per column: grid bin, elevation (deg), x (deg), weight. */
	bin: Int32Array;
	el: Float64Array;
	x: Float64Array;
	w: Float64Array;
	S_w: number;
	S_x: number;
	S_xx: number;
	S_P: number;
	S_PP: number;
	S_XP: number;
	/** Column stride for the direct (robust) passes. */
	stride: number;
}

function binColumns(
	p: Float64Array,
	geom: Geometry,
	cols: Column[],
	M: number,
	flat: ReturnType<typeof horizonTable>,
): Binned {
	const step = 360 / M;
	const W = new Float64Array(M);
	const WP = new Float64Array(M);
	const WX = new Float64Array(M);
	const n = cols.length;
	const bin = new Int32Array(n);
	const el = new Float64Array(n);
	const x = new Float64Array(n);
	const w = new Float64Array(n);
	const e = newEval();
	let S_w = 0;
	let S_x = 0;
	let S_xx = 0;
	let S_P = 0;
	let S_PP = 0;
	let S_XP = 0;
	const yaw0 = p[YAW] / DEG;
	for (let i = 0; i < n; i++) {
		evalColumn(p, geom, flat, cols[i], e);
		const b = ((Math.round(e.az / step) % M) + M) % M;
		const P = e.el / DEG;
		const xr = wrap180(e.az - yaw0);
		const wi = cols[i].w;
		bin[i] = b;
		el[i] = P;
		x[i] = xr;
		w[i] = wi;
		W[b] += wi;
		WP[b] += wi * P;
		WX[b] += wi * xr;
		S_w += wi;
		S_x += wi * xr;
		S_xx += wi * xr * xr;
		S_P += wi * P;
		S_PP += wi * P * P;
		S_XP += wi * xr * P;
	}
	return {
		W,
		WP,
		WX,
		bin,
		el,
		x,
		w,
		S_w,
		S_x,
		S_xx,
		S_P,
		S_PP,
		S_XP,
		stride: 1,
	};
}

/**
 * Finds the top yaw modes. `p` is the prior state (model.ts layout) at the
 * working geometry; `cols` the observed skyline columns.
 */
export function globalInit(
	p: Float64Array,
	geom: Geometry,
	cols: Column[],
	horizon: HorizonProfile,
	o: InitOptions = DEFAULT_INIT,
): InitResult {
	const t0 = performance.now();
	const M = o.gridSize;
	const step = 360 / M;
	// Horizon resampled onto the power-of-two grid (degrees).
	const t = horizonTable(horizon, 0);
	const H = new Float64Array(M);
	for (let j = 0; j < M; j++) {
		const u = (j * step) / t.step;
		const i0 = Math.floor(u) % t.n;
		const f = u - Math.floor(u);
		H[j] = (t.el[i0] * (1 - f) + t.el[(i0 + 1) % t.n] * f) / DEG;
	}
	const H2 = H.map((v) => v * v);
	const FH = rfft(H);
	const FH2 = rfft(H2);

	const S = Math.round(o.yawRange / step);
	const nShift = 2 * S + 1;
	const bestCost = new Float64Array(nShift).fill(Number.POSITIVE_INFINITY);
	const bestArg = new Int32Array(nShift);
	const bestAB: [number, number][] = new Array(nShift);
	const alpha = 1 / (o.noiseDeg * o.noiseDeg * o.corrLength);
	const la = 1 / (o.pitchSigmaDeg * o.pitchSigmaDeg);
	const sb = o.rollSigmaDeg * DEG; // roll tilt b ≈ −Δroll (rad) per degree of azimuth
	const lb = 1 / (sb * sb);
	// The azimuth grid of the photo is fixed by the flat (unsmoothed) profile;
	// the horizon table passed to evalColumn only matters for residuals, which
	// aren't used here.
	const binned: Binned[] = [];
	for (let fi = 0; fi < o.fScales.length; fi++) {
		const q = Float64Array.from(p);
		q[LOGF] = p[LOGF] + Math.log(o.fScales[fi]);
		const B = binColumns(q, geom, cols, M, t);
		B.stride = Math.max(1, Math.floor(cols.length / o.scoreColumns));
		binned.push(B);
		const FW = rfft(B.W);
		const FWP = rfft(B.WP);
		const FWX = rfft(B.WX);
		const C1 = correlateSpectra(FWP, FH); // Σ w P H(+Δ)
		const C2 = correlateSpectra(FW, FH); // Σ w H
		const C3 = correlateSpectra(FW, FH2); // Σ w H²
		const C4 = correlateSpectra(FWX, FH); // Σ w x H
		// (αM + Λ) is the same for every shift.
		const m00 = alpha * B.S_w + la;
		const m01 = alpha * B.S_x;
		const m11 = alpha * B.S_xx + lb;
		const det = m00 * m11 - m01 * m01;
		for (let k = -S; k <= S; k++) {
			const s = (k + M) % M;
			const sumR2 = C3[s] - 2 * C1[s] + B.S_PP;
			const g0 = alpha * (C2[s] - B.S_P);
			const g1 = alpha * (C4[s] - B.S_XP);
			// v = (αM+Λ)⁻¹ α g ; min = αΣwR² − gᵀ v (g already scaled by α)
			const a = (m11 * g0 - m01 * g1) / det;
			const b = (-m01 * g0 + m00 * g1) / det;
			const dy = k * step;
			const cost =
				alpha * sumR2 - (g0 * a + g1 * b) + 0.5 * (dy / o.yawSigmaDeg) ** 2;
			const idx = k + S;
			if (cost < bestCost[idx]) {
				bestCost[idx] = cost;
				bestArg[idx] = fi;
				bestAB[idx] = [a, b];
			}
		}
	}

	// Robust match score per shift: weighted fraction of columns within τ of
	// the DEM after the per-shift pitch/roll/f nuisance fit (a matched-filter
	// "inlier count" curve; the SSD itself is too flat-bottomed for a PSR).
	const shifts = new Float64Array(nShift);
	const score = new Float64Array(nShift);
	const tau2 = o.truncDeg * o.truncDeg;
	for (let i = 0; i < nShift; i++) {
		shifts[i] = (i - S) * step;
		const B = binned[bestArg[i]];
		// Robust re-fit of the nuisance (a, b) at this shift: a few IRLS steps
		// with a shrinking Tukey window, starting from the SSD solution, so
		// occluders don't drag the pitch offset away from the true ridge.
		let [a, b] = bestAB[i];
		for (const win of o.irlsWindows) {
			const w2 = win * win;
			let s0 = la / alpha;
			let s1 = 0;
			let s2 = lb / alpha;
			let r0 = 0;
			let r1 = 0;
			for (let c = 0; c < B.el.length; c += B.stride) {
				const u = (B.bin[c] + i - S + M) % M;
				const R = H[u] - B.el[c];
				const r = a + b * B.x[c] - R;
				const q = 1 - (r * r) / w2;
				if (q <= 0) continue;
				const ww = B.w[c] * q * q;
				const x = B.x[c];
				s0 += ww;
				s1 += ww * x;
				s2 += ww * x * x;
				r0 += ww * R;
				r1 += ww * x * R;
			}
			const det2 = s0 * s2 - s1 * s1;
			if (!(det2 > 0)) break;
			a = (s2 * r0 - s1 * r1) / det2;
			b = (-s1 * r0 + s0 * r1) / det2;
		}
		bestAB[i] = [a, b];
		let g = 0;
		let wsum = 0;
		for (let c = 0; c < B.el.length; c += B.stride) {
			const u = (B.bin[c] + i - S + M) % M;
			const r = B.el[c] + a + b * B.x[c] - H[u];
			const q = 1 - (r * r) / tau2;
			wsum += B.w[c];
			if (q > 0) g += B.w[c] * q;
		}
		score[i] =
			g / Math.max(1e-9, wsum) - 1e-3 * 0.5 * (shifts[i] / o.yawSigmaDeg) ** 2;
	}

	// Local maxima of the score, best first, at least minSeparation apart.
	const maxima: number[] = [];
	for (let i = 0; i < nShift; i++) {
		const g = score[i];
		if (
			(i === 0 || g >= score[i - 1]) &&
			(i === nShift - 1 || g >= score[i + 1])
		)
			maxima.push(i);
	}
	maxima.sort((a, b) => score[b] - score[a]);
	const modes: InitMode[] = [];
	for (const i of maxima) {
		if (modes.some((m) => Math.abs(m.dYaw - shifts[i]) <= o.minSeparation))
			continue;
		const [a, b] = bestAB[i];
		modes.push({
			dYaw: shifts[i],
			dPitch: a,
			dRoll: -b / DEG,
			fScale: o.fScales[bestArg[i]],
			cost: bestCost[i],
			robustCost: -score[i],
		});
		if (modes.length >= o.modes) break;
	}

	// Peak-to-sidelobe ratio of the score curve around the best mode.
	let psr = 0;
	if (modes.length) {
		const k0 = Math.round(modes[0].dYaw / step) + S;
		const ex = Math.round(o.psrExclusion / step);
		let s1 = 0;
		let s2 = 0;
		let n = 0;
		for (let i = 0; i < nShift; i++) {
			if (Math.abs(i - k0) <= ex) continue;
			s1 += score[i];
			s2 += score[i] * score[i];
			n++;
		}
		const mean = s1 / Math.max(1, n);
		const sd = Math.sqrt(Math.max(1e-12, s2 / Math.max(1, n) - mean * mean));
		psr = (score[k0] - mean) / sd;
	}
	return { modes, psr, shifts, score, ms: performance.now() - t0 };
}
