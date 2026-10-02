// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * The four-step FFT index algebra behind the GPU yaw correlation (fft-gpu.ts), pure and CPU-checkable.
 *
 * luma's GPUFFT1D does one radix-2 transform of at most 2048 complex values, so a length-M transform
 * (M = 8192 for the yaw grid) is split as M = N1·N2 with N2 = min(M, 2048) and N1 = M / N2, and the
 * sample index is n = n1 + N1·n2, the frequency k = N2·k1 + k2:
 *
 *   X[k] = Σ_n1 ω_N1^(n1·k1) · ω_M^(n1·k2) · Σ_n2 x[n1 + N1·n2] · ω_N2^(n2·k2),   ω_L = e^(-2πi/L)
 *
 * Forward: pack A[n1][n2] = x[n1 + N1·n2] (a strided gather, no transpose pass); FFT over n2 (length
 * N2, batch N1) giving A'[n1][k2]; multiply by ω_M^(n1·k2) while transposing to B[k2][n1]; FFT over n1
 * (length N1, batch N2) giving B'[k2][k1] = X[N2·k1 + k2]. The spectrum stays in that permuted
 * [k2][k1] order: the correlation product is elementwise, so it never needs the natural order.
 *
 * Inverse of a spectrum in the permuted order: inverse FFT over k1 (length N1, batch N2, divides by N1)
 * giving Q[k2][n1]; multiply by ω_M^(-n1·k2) while transposing to R[n1][k2]; inverse FFT over k2
 * (length N2, batch N1, divides by N2) giving y[n1][n2] = y[n1 + N1·n2], so the total scale is 1/M.
 * With M ≤ 2048, N1 = 1 and both twiddle / second-FFT stages vanish: a single FFT, natural order.
 */
import { fft } from "./fft";

export const FOUR_STEP_MAX_SUB = 2048;

export interface FourStepPlan {
	M: number;
	N1: number;
	N2: number;
}

/**
 * The split of a power-of-two M (2 ≤ M ≤ 2048²) into N1 × N2 with N2 = min(M, maxSub), or null when
 * it does not fit. `maxSub` < 2048 picks a finer split (fft-gpu.ts retries with 512 when a device
 * miscompiles luma's FFT pass for some transform lengths).
 */
export function planFourStep(
	M: number,
	maxSub = FOUR_STEP_MAX_SUB,
): FourStepPlan | null {
	if (!Number.isInteger(M) || M < 2 || (M & (M - 1)) !== 0) return null;
	const N2 = Math.min(M, maxSub);
	const N1 = M / N2;
	if (N1 > FOUR_STEP_MAX_SUB || N1 < 1) return null;
	return { M, N1, N2 };
}

/** ω_M^j = e^(-2πi j / M) for j in [0, M) as interleaved float32 (re, im), computed in f64. */
export function twiddleTable(M: number): Float32Array {
	const t = new Float32Array(2 * M);
	for (let j = 0; j < M; j++) {
		const a = (2 * Math.PI * j) / M;
		t[2 * j] = Math.cos(a);
		t[2 * j + 1] = -Math.sin(a);
	}
	return t;
}

/** CPU emulation of the forward pipeline (f64): returns the spectrum in the permuted [k2][k1] order. */
export function fourStepForward(x: ArrayLike<number>, plan: FourStepPlan) {
	const { M, N1, N2 } = plan;
	const a = { re: new Float64Array(M), im: new Float64Array(M) };
	for (let n1 = 0; n1 < N1; n1++)
		for (let n2 = 0; n2 < N2; n2++) a.re[n1 * N2 + n2] = x[n1 + N1 * n2];
	const row = (src: typeof a, len: number, count: number) => {
		const out = { re: new Float64Array(M), im: new Float64Array(M) };
		for (let b = 0; b < count; b++) {
			const re = src.re.slice(b * len, (b + 1) * len);
			const im = src.im.slice(b * len, (b + 1) * len);
			fft(re, im);
			out.re.set(re, b * len);
			out.im.set(im, b * len);
		}
		return out;
	};
	const s1 = row(a, N2, N1); // A'[n1][k2]
	if (N1 === 1) return s1;
	const b = { re: new Float64Array(M), im: new Float64Array(M) };
	for (let k2 = 0; k2 < N2; k2++)
		for (let n1 = 0; n1 < N1; n1++) {
			const ang = (-2 * Math.PI * ((n1 * k2) % M)) / M;
			const c = Math.cos(ang);
			const s = Math.sin(ang);
			const re = s1.re[n1 * N2 + k2];
			const im = s1.im[n1 * N2 + k2];
			b.re[k2 * N1 + n1] = re * c - im * s;
			b.im[k2 * N1 + n1] = re * s + im * c;
		}
	return row(b, N1, N2); // B'[k2][k1]
}

/** Spectrum index (in the permuted layout) of natural frequency k. */
export function permutedIndex(k: number, plan: FourStepPlan) {
	const { N1, N2 } = plan;
	return (k % N2) * N1 + Math.floor(k / N2);
}

/**
 * CPU emulation of the inverse pipeline (f64) for a permuted-order spectrum; returns y in natural
 * order, normalised by 1/M (as the two normalised GPU inverse FFTs together do).
 */
export function fourStepInverse(
	P: { re: Float64Array; im: Float64Array },
	plan: FourStepPlan,
) {
	const { M, N1, N2 } = plan;
	const inv = (src: typeof P, len: number, count: number) => {
		const out = { re: new Float64Array(M), im: new Float64Array(M) };
		for (let b = 0; b < count; b++) {
			const re = src.re.slice(b * len, (b + 1) * len);
			const im = src.im.slice(b * len, (b + 1) * len);
			fft(re, im, true);
			for (let i = 0; i < len; i++) {
				out.re[b * len + i] = re[i] / len;
				out.im[b * len + i] = im[i] / len;
			}
		}
		return out;
	};
	const q = inv(P, N1, N2); // Q[k2][n1]
	let r = q;
	if (N1 > 1) {
		r = { re: new Float64Array(M), im: new Float64Array(M) };
		for (let n1 = 0; n1 < N1; n1++)
			for (let k2 = 0; k2 < N2; k2++) {
				const ang = (2 * Math.PI * ((n1 * k2) % M)) / M;
				const c = Math.cos(ang);
				const s = Math.sin(ang);
				const re = q.re[k2 * N1 + n1];
				const im = q.im[k2 * N1 + n1];
				r.re[n1 * N2 + k2] = re * c - im * s;
				r.im[n1 * N2 + k2] = re * s + im * c;
			}
	}
	const y = N1 > 1 ? inv(r, N2, N1) : inv(P, M, 1);
	// y[n1][n2] → natural order
	const nat = { re: new Float64Array(M), im: new Float64Array(M) };
	for (let n1 = 0; n1 < N1; n1++)
		for (let n2 = 0; n2 < N2; n2++) {
			nat.re[n1 + N1 * n2] = y.re[n1 * N2 + n2];
			nat.im[n1 + N1 * n2] = y.im[n1 * N2 + n2];
		}
	return nat;
}
