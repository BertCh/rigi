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
