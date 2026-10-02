// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Fast paths for the CPU backend's cheap ops (same arithmetic as the reference loops in cpu.ts, so the
// results are bit-identical; each returns null/false when the case is not covered and the caller falls
// back to the generic loop): same-shape binary add/sub/mul/max/min, relu, bilinear/nearest resize with
// per-row/column tables, and unpadded undilated pooling.

import type { InterpParams } from "./base";
import type { PoolParams } from "./shape";
import type { BinaryOp } from "./types";

/** out = a op b for equal-length inputs; false when `op` has no specialised loop. */
export function binarySameShape(
	op: BinaryOp,
	A: Float32Array,
	B: Float32Array,
	O: Float32Array,
): boolean {
	const n = O.length;
	switch (op) {
		case "add":
			for (let i = 0; i < n; i++) O[i] = A[i] + B[i];
			return true;
		case "sub":
			for (let i = 0; i < n; i++) O[i] = A[i] - B[i];
			return true;
		case "mul":
			for (let i = 0; i < n; i++) O[i] = A[i] * B[i];
			return true;
		default:
			return false;
	}
}

export function reluInto(X: Float32Array, O: Float32Array) {
	for (let i = 0; i < O.length; i++) {
		const v = X[i];
		O[i] = v > 0 ? v : 0;
	}
}

/** Bilinear (half-pixel or align-corners) and nearest resize; false for bicubic. */
export function resizeFast(
	X: Float32Array,
	O: Float32Array,
	p: InterpParams,
): boolean {
	const { N, C, H, W, Ho, Wo, mode, alignCorners, scaleH, scaleW } = p;
	if (mode === "bicubic") return false;
	const bilinear = mode === "bilinear";
	const coord = (d: number, s: number) =>
		alignCorners ? d * s : bilinear ? (d + 0.5) * s - 0.5 : d * s;
	const xi0 = new Int32Array(Wo);
	const xi1 = new Int32Array(Wo);
	const xl = new Float64Array(Wo);
	for (let ox = 0; ox < Wo; ox++) {
		if (!bilinear) {
			xi0[ox] = Math.min(W - 1, Math.floor(ox * scaleW));
			continue;
		}
		const fx = Math.max(0, coord(ox, scaleW));
		const x0 = Math.min(W - 1, Math.floor(fx));
		xi0[ox] = x0;
		xi1[ox] = Math.min(W - 1, x0 + 1);
		xl[ox] = fx - x0;
	}
	for (let nc = 0; nc < N * C; nc++) {
		const base = nc * H * W;
		for (let oy = 0; oy < Ho; oy++) {
			const orow = (nc * Ho + oy) * Wo;
			if (!bilinear) {
				const row = base + Math.min(H - 1, Math.floor(oy * scaleH)) * W;
				for (let ox = 0; ox < Wo; ox++) O[orow + ox] = X[row + xi0[ox]];
				continue;
			}
			const fy = Math.max(0, coord(oy, scaleH));
			const y0 = Math.min(H - 1, Math.floor(fy));
			const y1 = Math.min(H - 1, y0 + 1);
			const ly = fy - y0;
			const r0 = base + y0 * W;
			const r1 = base + y1 * W;
			for (let ox = 0; ox < Wo; ox++) {
				const a = xi0[ox];
				const b = xi1[ox];
				const lx = xl[ox];
				O[orow + ox] =
					(1 - ly) * ((1 - lx) * X[r0 + a] + lx * X[r0 + b]) +
					ly * ((1 - lx) * X[r1 + a] + lx * X[r1 + b]);
			}
		}
	}
	return true;
}

/** Max / average pooling whose windows all lie inside the input (no padding, no dilation). */
export function poolInside(
	kind: "max" | "avg",
	X: Float32Array,
	O: Float32Array,
	p: PoolParams,
): boolean {
	const { N, C, H, W, kh, kw, sh, sw, ph, pw, dh, dw, Ho, Wo } = p;
	if (
		ph !== 0 ||
		pw !== 0 ||
		dh !== 1 ||
		dw !== 1 ||
		(Ho - 1) * sh + kh > H ||
		(Wo - 1) * sw + kw > W
	)
		return false;
	const area = kh * kw;
	for (let nc = 0; nc < N * C; nc++)
		for (let oy = 0; oy < Ho; oy++)
			for (let ox = 0; ox < Wo; ox++) {
				const origin = (nc * H + oy * sh) * W + ox * sw;
				let m = Number.NEGATIVE_INFINITY;
				let s = 0;
				for (let ky = 0; ky < kh; ky++) {
					const row = origin + ky * W;
					for (let kx = 0; kx < kw; kx++) {
						const v = X[row + kx];
						if (v > m || Number.isNaN(v)) m = v;
						s += v;
					}
				}
				O[(nc * Ho + oy) * Wo + ox] = kind === "max" ? m : s / area;
			}
	return true;
}

/**
 * C[M,N] (+ bias) = A[M,K] * B for one batch entry, 4x4 register tiles over K. B(k, n) is read at
 * bo + k * bk + n * bn (transB: bk = 1, bn = K; else bk = N, bn = 1). Same f64 accumulation as the reference.
 */
export function matmulTiled(
	A: Float32Array,
	ao: number,
	B: Float32Array,
	bo: number,
	bk: number,
	bn: number,
	bias: Float32Array | null,
	O: Float32Array,
	oo: number,
	M: number,
	N: number,
	K: number,
) {
	for (let m = 0; m < M; m += 4) {
		const mm = Math.min(4, M - m);
		for (let n = 0; n < N; n += 4) {
			const nn = Math.min(4, N - n);
			if (mm < 4 || nn < 4) {
				// edge tile: plain dot products
				for (let i = 0; i < mm; i++)
					for (let j = 0; j < nn; j++) {
						let s = bias ? bias[n + j] : 0;
						const ar = ao + (m + i) * K;
						const bb = bo + (n + j) * bn;
						for (let k = 0; k < K; k++) s += A[ar + k] * B[bb + k * bk];
						O[oo + (m + i) * N + n + j] = s;
					}
				continue;
			}
			const r0 = ao + m * K;
			const r1 = r0 + K;
			const r2 = r1 + K;
			const r3 = r2 + K;
			const c0 = bo + n * bn;
			const c1 = c0 + bn;
			const c2 = c1 + bn;
			const c3 = c2 + bn;
			let a00 = 0;
			let a01 = 0;
			let a02 = 0;
			let a03 = 0;
			let a10 = 0;
			let a11 = 0;
			let a12 = 0;
			let a13 = 0;
			let a20 = 0;
			let a21 = 0;
			let a22 = 0;
			let a23 = 0;
			let a30 = 0;
			let a31 = 0;
			let a32 = 0;
			let a33 = 0;
			for (let k = 0; k < K; k++) {
				const x0 = A[r0 + k];
				const x1 = A[r1 + k];
				const x2 = A[r2 + k];
				const x3 = A[r3 + k];
				const kb = k * bk;
				const y0 = B[c0 + kb];
				const y1 = B[c1 + kb];
				const y2 = B[c2 + kb];
				const y3 = B[c3 + kb];
				a00 += x0 * y0;
				a01 += x0 * y1;
				a02 += x0 * y2;
				a03 += x0 * y3;
				a10 += x1 * y0;
				a11 += x1 * y1;
				a12 += x1 * y2;
				a13 += x1 * y3;
				a20 += x2 * y0;
				a21 += x2 * y1;
				a22 += x2 * y2;
				a23 += x2 * y3;
				a30 += x3 * y0;
				a31 += x3 * y1;
				a32 += x3 * y2;
				a33 += x3 * y3;
			}
			const b0 = bias ? bias[n] : 0;
			const b1 = bias ? bias[n + 1] : 0;
			const b2 = bias ? bias[n + 2] : 0;
			const b3 = bias ? bias[n + 3] : 0;
			let q = oo + m * N + n;
			O[q] = a00 + b0;
			O[q + 1] = a01 + b1;
			O[q + 2] = a02 + b2;
			O[q + 3] = a03 + b3;
			q += N;
			O[q] = a10 + b0;
			O[q + 1] = a11 + b1;
			O[q + 2] = a12 + b2;
			O[q + 3] = a13 + b3;
			q += N;
			O[q] = a20 + b0;
			O[q + 1] = a21 + b1;
			O[q + 2] = a22 + b2;
			O[q + 3] = a23 + b3;
			q += N;
			O[q] = a30 + b0;
			O[q + 1] = a31 + b1;
			O[q + 2] = a32 + b2;
			O[q + 3] = a33 + b3;
		}
	}
}

/** Constant-value padding by rows: fills the output with `value`, then copies each input row. */
export function padConstantRows(
	X: Float32Array,
	O: Float32Array,
	inShape: readonly number[],
	outShape: readonly number[],
	pads: readonly (readonly [number, number])[],
	value: number,
) {
	O.fill(value);
	const r = outShape.length;
	const rowLen = inShape[r - 1];
	const rowOff = pads[r - 1][0];
	const outer = inShape.slice(0, r - 1);
	const rows = outer.reduce((a, b) => a * b, 1);
	const idx = new Array<number>(Math.max(0, r - 1)).fill(0);
	for (let row = 0; row < rows; row++) {
		let dst = 0;
		for (let d = 0; d < r - 1; d++)
			dst = dst * outShape[d] + idx[d] + pads[d][0];
		O.set(
			X.subarray(row * rowLen, (row + 1) * rowLen),
			dst * outShape[r - 1] + rowOff,
		);
		for (let d = r - 2; d >= 0; d--) {
			if (++idx[d] < outer[d]) break;
			idx[d] = 0;
		}
	}
}
