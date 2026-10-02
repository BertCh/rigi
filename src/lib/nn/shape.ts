// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shape arithmetic shared by both nn backends (pure, no tensors).

import type { Pair } from "./types";

export const numel = (shape: readonly number[]) =>
	shape.reduce((a, b) => a * b, 1);

/** Row-major strides of a contiguous tensor. */
export function stridesOf(shape: readonly number[]): number[] {
	const s = new Array<number>(shape.length);
	let acc = 1;
	for (let i = shape.length - 1; i >= 0; i--) {
		s[i] = acc;
		acc *= shape[i];
	}
	return s;
}

export function normAxis(axis: number, rank: number): number {
	const a = axis < 0 ? axis + rank : axis;
	if (a < 0 || a >= rank)
		throw new Error(`nn: axis ${axis} out of range for rank ${rank}`);
	return a;
}

export const pair = (p: Pair | undefined, d: number): [number, number] =>
	p === undefined ? [d, d] : typeof p === "number" ? [p, p] : [p[0], p[1]];

/** NumPy broadcast of two shapes. */
export function broadcastShapes(
	a: readonly number[],
	b: readonly number[],
): number[] {
	const r = Math.max(a.length, b.length);
	const out = new Array<number>(r);
	for (let i = 0; i < r; i++) {
		const x = a[a.length - r + i] ?? 1;
		const y = b[b.length - r + i] ?? 1;
		if (x !== y && x !== 1 && y !== 1)
			throw new Error(
				`nn: cannot broadcast [${a.join(",")}] with [${b.join(",")}]`,
			);
		out[i] = x === 1 ? y : x;
	}
	return out;
}

/** Strides of `shape` read as broadcast to `out` (0 on broadcast dims), length out.length. */
export function broadcastStrides(
	shape: readonly number[],
	out: readonly number[],
): number[] {
	const s = stridesOf(shape);
	const r = out.length;
	const res = new Array<number>(r).fill(0);
	for (let i = 0; i < shape.length; i++) {
		const o = r - shape.length + i;
		res[o] = shape[i] === 1 && out[o] !== 1 ? 0 : s[i];
	}
	return res;
}

export const sameShape = (a: readonly number[], b: readonly number[]) =>
	a.length === b.length && a.every((v, i) => v === b[i]);

/** Resolves one -1 in a reshape target. */
export function resolveShape(
	from: readonly number[],
	to: readonly number[],
): number[] {
	const n = numel(from);
	const out = [...to];
	const neg = out.indexOf(-1);
	if (neg >= 0) {
		const rest = out.reduce((a, v, i) => (i === neg ? a : a * v), 1);
		out[neg] = rest === 0 ? 0 : n / rest;
	}
	if (numel(out) !== n || !out.every((v) => Number.isInteger(v) && v >= 0))
		throw new Error(
			`nn: cannot reshape [${from.join(",")}] to [${to.join(",")}]`,
		);
	return out;
}

/** outer × len × inner around `axis`. */
export function aroundAxis(shape: readonly number[], axis: number) {
	const a = normAxis(axis, shape.length);
	let outer = 1;
	let inner = 1;
	for (let i = 0; i < a; i++) outer *= shape[i];
	for (let i = a + 1; i < shape.length; i++) inner *= shape[i];
	return { axis: a, outer, len: shape[a], inner };
}

export type ConvParams = {
	N: number;
	Cin: number;
	H: number;
	W: number;
	Cout: number;
	kh: number;
	kw: number;
	sh: number;
	sw: number;
	ph: number;
	pw: number;
	dh: number;
	dw: number;
	groups: number;
	Ho: number;
	Wo: number;
	/** convTranspose output padding */
	oph: number;
	opw: number;
	/** deformConv offset groups */
	dg: number;
};

export function convParams(
	x: readonly number[],
	w: readonly number[],
	o: {
		stride?: Pair;
		padding?: Pair;
		dilation?: Pair;
		groups?: number;
		outputPadding?: Pair;
		offsetGroups?: number;
	},
	transpose = false,
): ConvParams {
	if (x.length !== 4 || w.length !== 4)
		throw new Error("nn: conv expects NCHW input and 4-D weights");
	const [N, Cin, H, W] = x;
	const groups = o.groups ?? 1;
	const [sh, sw] = pair(o.stride, 1);
	const [ph, pw] = pair(o.padding, 0);
	const [dh, dw] = pair(o.dilation, 1);
	const [oph, opw] = pair(o.outputPadding, 0);
	const kh = w[2];
	const kw = w[3];
	let Cout: number;
	let Ho: number;
	let Wo: number;
	if (transpose) {
		if (w[0] !== Cin) throw new Error("nn: convTranspose2d weight Cin");
		Cout = w[1] * groups;
		Ho = (H - 1) * sh - 2 * ph + dh * (kh - 1) + oph + 1;
		Wo = (W - 1) * sw - 2 * pw + dw * (kw - 1) + opw + 1;
	} else {
		if (w[1] * groups !== Cin)
			throw new Error(
				`nn: conv2d weight [${w.join(",")}] vs Cin ${Cin}, groups ${groups}`,
			);
		Cout = w[0];
		Ho = Math.floor((H + 2 * ph - dh * (kh - 1) - 1) / sh) + 1;
		Wo = Math.floor((W + 2 * pw - dw * (kw - 1) - 1) / sw) + 1;
	}
	if (Cout % groups) throw new Error("nn: Cout not divisible by groups");
	return {
		N,
		Cin,
		H,
		W,
		Cout,
		kh,
		kw,
		sh,
		sw,
		ph,
		pw,
		dh,
		dw,
		groups,
		Ho,
		Wo,
		oph,
		opw,
		dg: o.offsetGroups ?? 1,
	};
}

export type PoolParams = {
	N: number;
	C: number;
	H: number;
	W: number;
	kh: number;
	kw: number;
	sh: number;
	sw: number;
	ph: number;
	pw: number;
	dh: number;
	dw: number;
	Ho: number;
	Wo: number;
	countIncludePad: boolean;
};

export function poolParams(
	x: readonly number[],
	o: {
		kernel: Pair;
		stride?: Pair;
		padding?: Pair;
		dilation?: Pair;
		countIncludePad?: boolean;
		ceilMode?: boolean;
	},
): PoolParams {
	if (x.length !== 4) throw new Error("nn: pool expects NCHW");
	const [N, C, H, W] = x;
	const [kh, kw] = pair(o.kernel, 1);
	const [sh, sw] = pair(o.stride ?? o.kernel, 1);
	const [ph, pw] = pair(o.padding, 0);
	const [dh, dw] = pair(o.dilation, 1);
	const size = (n: number, k: number, s: number, p: number, d: number) => {
		const span = n + 2 * p - d * (k - 1) - 1;
		let out = (o.ceilMode ? Math.ceil(span / s) : Math.floor(span / s)) + 1;
		// PyTorch: the last window must start inside the input or left padding
		if (o.ceilMode && (out - 1) * s >= n + p) out--;
		return out;
	};
	return {
		N,
		C,
		H,
		W,
		kh,
		kw,
		sh,
		sw,
		ph,
		pw,
		dh,
		dw,
		Ho: size(H, kh, sh, ph, dh),
		Wo: size(W, kw, sw, pw, dw),
		countIncludePad: o.countIncludePad ?? true,
	};
}

/**
 * PyTorch's source-coordinate scale for interpolate: in/out when `size` is given (or
 * recompute_scale_factor), 1/scale_factor otherwise; align_corners uses (in-1)/(out-1).
 */
export function interpScale(
	inSize: number,
	outSize: number,
	alignCorners: boolean,
	scaleFactor?: number,
): number {
	if (alignCorners) return outSize > 1 ? (inSize - 1) / (outSize - 1) : 0;
	return scaleFactor ? 1 / scaleFactor : inSize / outSize;
}

/** Bicubic convolution weights (A = -0.75, PyTorch) for fractional offset t. */
export function cubicWeights(t: number): [number, number, number, number] {
	const A = -0.75;
	const c1 = (x: number) => ((A + 2) * x - (A + 3)) * x * x + 1;
	const c2 = (x: number) => ((A * x - 5 * A) * x + 8 * A) * x - 4 * A;
	return [c2(t + 1), c1(t), c1(1 - t), c2(2 - t)];
}
