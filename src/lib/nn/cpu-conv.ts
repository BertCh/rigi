// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU conv2d for the nn CPU backend. `conv2dReference` is the naive loop (the oracle for the specs);
// `conv2dFast` is a register-tiled direct convolution: the input plane is copied once into a zero-padded
// Float64Array (no bounds checks in the hot loop), the weights are packed once per tensor into 4-wide
// output-channel panels (Float64Array, [group][cout tile][k][4]) and a 4 (cout) x 4 (output x) micro-kernel
// walks the K = Cin/groups * kh * kw taps through a precomputed offset table. JS numbers are f64, so
// accumulation is as accurate as the reference's. Scratch buffers are reused across calls.

import type { ConvParams } from "./shape";

/** The naive conv (f64 accumulation, bounds hoisted per tap). Returns N*Cout*Ho*Wo f32. */
export function conv2dReference(
	X: Float32Array,
	Wt: Float32Array,
	bias: Float32Array | null,
	p: ConvParams,
): Float32Array {
	const { N, Cin, H, W, Cout, kh, kw, sh, sw, ph, pw, dh, dw, groups, Ho, Wo } =
		p;
	const O = new Float32Array(N * Cout * Ho * Wo);
	const cig = Cin / groups;
	const cog = Cout / groups;
	const col = new Float64Array(Ho * Wo);
	for (let n = 0; n < N; n++)
		for (let co = 0; co < Cout; co++) {
			const g = Math.floor(co / cog);
			col.fill(bias ? bias[co] : 0);
			for (let ci = 0; ci < cig; ci++) {
				const xc = (n * Cin + g * cig + ci) * H * W;
				for (let ky = 0; ky < kh; ky++)
					for (let kx = 0; kx < kw; kx++) {
						const wv = Wt[((co * cig + ci) * kh + ky) * kw + kx];
						if (wv === 0) continue;
						// valid output columns for this tap (0 <= ox·sw − pw + kx·dw < W), hoisted
						const off = kx * dw - pw;
						const ox0 = Math.max(0, Math.ceil(-off / sw));
						const ox1 = Math.min(Wo, Math.ceil((W - off) / sw));
						for (let oy = 0; oy < Ho; oy++) {
							const iy = oy * sh - ph + ky * dh;
							if (iy < 0 || iy >= H) continue;
							const row = xc + iy * W + off;
							const orow = oy * Wo;
							for (let ox = ox0; ox < ox1; ox++)
								col[orow + ox] += wv * X[row + ox * sw];
						}
					}
			}
			O.set(col, (n * Cout + co) * Ho * Wo);
		}
	return O;
}

const packedWeights = new WeakMap<Float32Array, Map<string, Float64Array>>();

/** [group][cout tile of 4][k][4] with zero-filled tile tails. */
function packWeights(
	Wt: Float32Array,
	cog: number,
	K: number,
	groups: number,
): Float64Array {
	let byKey = packedWeights.get(Wt);
	if (!byKey) {
		byKey = new Map();
		packedWeights.set(Wt, byKey);
	}
	const key = `${groups}:${cog}:${K}`;
	let packed = byKey.get(key);
	if (packed) return packed;
	const tiles = Math.ceil(cog / 4);
	packed = new Float64Array(groups * tiles * K * 4);
	for (let g = 0; g < groups; g++)
		for (let c = 0; c < cog; c++) {
			const tile = c >> 2;
			const lane = c & 3;
			const src = (g * cog + c) * K;
			const dst = (g * tiles + tile) * K * 4 + lane;
			for (let k = 0; k < K; k++) packed[dst + k * 4] = Wt[src + k];
		}
	byKey.set(key, packed);
	return packed;
}

let padScratch = new Float64Array(0);
let offsetScratch = new Int32Array(0);

export function conv2dFast(
	X: Float32Array,
	Wt: Float32Array,
	bias: Float32Array | null,
	p: ConvParams,
): Float32Array {
	const { N, Cin, H, W, Cout, kh, kw, sh, sw, ph, pw, dh, dw, groups, Ho, Wo } =
		p;
	const O = new Float32Array(N * Cout * Ho * Wo);
	const cig = Cin / groups;
	const cog = Cout / groups;
	const K = cig * kh * kw;
	const Hp = H + 2 * ph;
	const Wp = W + 2 * pw;
	const plane = Hp * Wp;
	const HW = H * W;
	const HoWo = Ho * Wo;
	if (padScratch.length < cig * plane)
		padScratch = new Float64Array(cig * plane);
	const Xp = padScratch;
	if (cog === 1 && cig === 1) {
		convDepthwise(X, Wt, bias, p, Xp, O);
		return O;
	}
	if (offsetScratch.length < K) offsetScratch = new Int32Array(K);
	const koff = offsetScratch;
	{
		let k = 0;
		for (let ci = 0; ci < cig; ci++)
			for (let ky = 0; ky < kh; ky++)
				for (let kx = 0; kx < kw; kx++)
					koff[k++] = ci * plane + ky * dh * Wp + kx * dw;
	}
	const Wk = packWeights(Wt, cog, K, groups);
	const tiles = Math.ceil(cog / 4);
	const rowStep = sh * Wp;
	const xw1 = sw;
	const xw2 = 2 * sw;
	const xw3 = 3 * sw;
	const wFull = Wo & ~3;
	const share3 = kw === 3 && dw === 1 && sw === 1;
	for (let n = 0; n < N; n++)
		for (let g = 0; g < groups; g++) {
			// zero-padded f64 copy of this group's input channels
			if (ph > 0 || pw > 0) Xp.fill(0, 0, cig * plane);
			for (let ci = 0; ci < cig; ci++) {
				const src = (n * Cin + g * cig + ci) * HW;
				const dst = ci * plane + ph * Wp + pw;
				for (let y = 0; y < H; y++) {
					const s = src + y * W;
					const d = dst + y * Wp;
					for (let x = 0; x < W; x++) Xp[d + x] = X[s + x];
				}
			}
			if (cog === 1) {
				convOneOutput(
					Xp,
					koff,
					Wk,
					g * K * 4,
					K,
					bias ? bias[g] : 0,
					p,
					O,
					(n * Cout + g) * HoWo,
				);
				continue;
			}
			for (let oy = 0; oy < Ho; oy++) {
				const rowBase = oy * rowStep;
				for (let ox = 0; ox < Wo; ox += 4) {
					const base = rowBase + ox * sw;
					const full = ox < wFull;
					for (let ct = 0; ct < tiles; ct++) {
						let wi = (g * tiles + ct) * K * 4;
						const c0 = ct * 4;
						const nc = Math.min(4, cog - c0);
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
						if (full && share3) {
							// kx = 0, 1, 2 of one kernel row read six neighbouring input samples: load them once
							for (let k = 0; k < K; k += 3) {
								const o = base + koff[k];
								const x0 = Xp[o];
								const x1 = Xp[o + 1];
								const x2 = Xp[o + 2];
								const x3 = Xp[o + 3];
								const x4 = Xp[o + 4];
								const x5 = Xp[o + 5];
								let w0 = Wk[wi];
								let w1 = Wk[wi + 1];
								let w2 = Wk[wi + 2];
								let w3 = Wk[wi + 3];
								a00 += w0 * x0;
								a01 += w0 * x1;
								a02 += w0 * x2;
								a03 += w0 * x3;
								a10 += w1 * x0;
								a11 += w1 * x1;
								a12 += w1 * x2;
								a13 += w1 * x3;
								a20 += w2 * x0;
								a21 += w2 * x1;
								a22 += w2 * x2;
								a23 += w2 * x3;
								a30 += w3 * x0;
								a31 += w3 * x1;
								a32 += w3 * x2;
								a33 += w3 * x3;
								w0 = Wk[wi + 4];
								w1 = Wk[wi + 5];
								w2 = Wk[wi + 6];
								w3 = Wk[wi + 7];
								a00 += w0 * x1;
								a01 += w0 * x2;
								a02 += w0 * x3;
								a03 += w0 * x4;
								a10 += w1 * x1;
								a11 += w1 * x2;
								a12 += w1 * x3;
								a13 += w1 * x4;
								a20 += w2 * x1;
								a21 += w2 * x2;
								a22 += w2 * x3;
								a23 += w2 * x4;
								a30 += w3 * x1;
								a31 += w3 * x2;
								a32 += w3 * x3;
								a33 += w3 * x4;
								w0 = Wk[wi + 8];
								w1 = Wk[wi + 9];
								w2 = Wk[wi + 10];
								w3 = Wk[wi + 11];
								wi += 12;
								a00 += w0 * x2;
								a01 += w0 * x3;
								a02 += w0 * x4;
								a03 += w0 * x5;
								a10 += w1 * x2;
								a11 += w1 * x3;
								a12 += w1 * x4;
								a13 += w1 * x5;
								a20 += w2 * x2;
								a21 += w2 * x3;
								a22 += w2 * x4;
								a23 += w2 * x5;
								a30 += w3 * x2;
								a31 += w3 * x3;
								a32 += w3 * x4;
								a33 += w3 * x5;
							}
						} else if (full) {
							for (let k = 0; k < K; k++) {
								const o = base + koff[k];
								const x0 = Xp[o];
								const x1 = Xp[o + xw1];
								const x2 = Xp[o + xw2];
								const x3 = Xp[o + xw3];
								const w0 = Wk[wi];
								const w1 = Wk[wi + 1];
								const w2 = Wk[wi + 2];
								const w3 = Wk[wi + 3];
								wi += 4;
								a00 += w0 * x0;
								a01 += w0 * x1;
								a02 += w0 * x2;
								a03 += w0 * x3;
								a10 += w1 * x0;
								a11 += w1 * x1;
								a12 += w1 * x2;
								a13 += w1 * x3;
								a20 += w2 * x0;
								a21 += w2 * x1;
								a22 += w2 * x2;
								a23 += w2 * x3;
								a30 += w3 * x0;
								a31 += w3 * x1;
								a32 += w3 * x2;
								a33 += w3 * x3;
							}
						} else {
							// width tail (1..3 columns): the x1..x3 loads would run off the row, so skip them
							const nx = Wo - ox;
							for (let k = 0; k < K; k++) {
								const o = base + koff[k];
								const x0 = Xp[o];
								const x1 = nx > 1 ? Xp[o + xw1] : 0;
								const x2 = nx > 2 ? Xp[o + xw2] : 0;
								const w0 = Wk[wi];
								const w1 = Wk[wi + 1];
								const w2 = Wk[wi + 2];
								const w3 = Wk[wi + 3];
								wi += 4;
								a00 += w0 * x0;
								a01 += w0 * x1;
								a02 += w0 * x2;
								a10 += w1 * x0;
								a11 += w1 * x1;
								a12 += w1 * x2;
								a20 += w2 * x0;
								a21 += w2 * x1;
								a22 += w2 * x2;
								a30 += w3 * x0;
								a31 += w3 * x1;
								a32 += w3 * x2;
							}
						}
						const co = g * cog + c0;
						const q = (n * Cout + co) * HoWo + oy * Wo + ox;
						const b0 = bias ? bias[co] : 0;
						if (full && nc === 4) {
							const b1 = bias ? bias[co + 1] : 0;
							const b2 = bias ? bias[co + 2] : 0;
							const b3 = bias ? bias[co + 3] : 0;
							O[q] = a00 + b0;
							O[q + 1] = a01 + b0;
							O[q + 2] = a02 + b0;
							O[q + 3] = a03 + b0;
							O[q + HoWo] = a10 + b1;
							O[q + HoWo + 1] = a11 + b1;
							O[q + HoWo + 2] = a12 + b1;
							O[q + HoWo + 3] = a13 + b1;
							O[q + 2 * HoWo] = a20 + b2;
							O[q + 2 * HoWo + 1] = a21 + b2;
							O[q + 2 * HoWo + 2] = a22 + b2;
							O[q + 2 * HoWo + 3] = a23 + b2;
							O[q + 3 * HoWo] = a30 + b3;
							O[q + 3 * HoWo + 1] = a31 + b3;
							O[q + 3 * HoWo + 2] = a32 + b3;
							O[q + 3 * HoWo + 3] = a33 + b3;
							continue;
						}
						// partial tile (cout or width tail)
						const nx = full ? 4 : Wo - ox;
						const acc = [
							[a00, a01, a02, a03],
							[a10, a11, a12, a13],
							[a20, a21, a22, a23],
							[a30, a31, a32, a33],
						];
						for (let c = 0; c < nc; c++) {
							const bc = bias ? bias[co + c] : 0;
							for (let x = 0; x < nx; x++) O[q + c * HoWo + x] = acc[c][x] + bc;
						}
					}
				}
			}
		}
	return O;
}

/** groups === Cin === Cout: one channel at a time, taps unrolled over the padded plane. */
function convDepthwise(
	X: Float32Array,
	Wt: Float32Array,
	bias: Float32Array | null,
	p: ConvParams,
	Xp: Float64Array,
	O: Float32Array,
) {
	const { N, Cin, H, W, kh, kw, sh, sw, ph, pw, dh, dw, Ho, Wo } = p;
	const Wp = W + 2 * pw;
	const Hp = H + 2 * ph;
	for (let n = 0; n < N; n++)
		for (let c = 0; c < Cin; c++) {
			Xp.fill(0, 0, Hp * Wp);
			const src = (n * Cin + c) * H * W;
			for (let y = 0; y < H; y++)
				for (let x = 0; x < W; x++)
					Xp[(y + ph) * Wp + pw + x] = X[src + y * W + x];
			const b = bias ? bias[c] : 0;
			const wb = c * kh * kw;
			const ob = (n * Cin + c) * Ho * Wo;
			for (let oy = 0; oy < Ho; oy++)
				for (let ox = 0; ox < Wo; ox++) {
					let a = b;
					for (let ky = 0; ky < kh; ky++) {
						const row = (oy * sh + ky * dh) * Wp + ox * sw;
						for (let kx = 0; kx < kw; kx++)
							a += Wt[wb + ky * kw + kx] * Xp[row + kx * dw];
					}
					O[ob + oy * Wo + ox] = a;
				}
		}
}

/** One output channel per group (side maps, fuse convs): 8 output columns per pass over the taps. */
function convOneOutput(
	Xp: Float64Array,
	koff: Int32Array,
	Wk: Float64Array,
	w0: number,
	K: number,
	b: number,
	p: ConvParams,
	O: Float32Array,
	outBase: number,
) {
	const { W, sh, sw, pw, Ho, Wo } = p;
	const Wp = W + 2 * pw;
	const wFull = Wo & ~7;
	for (let oy = 0; oy < Ho; oy++)
		for (let ox = 0; ox < Wo; ox += 8) {
			const base = oy * sh * Wp + ox * sw;
			const q = outBase + oy * Wo + ox;
			if (ox < wFull) {
				let a0 = 0;
				let a1 = 0;
				let a2 = 0;
				let a3 = 0;
				let a4 = 0;
				let a5 = 0;
				let a6 = 0;
				let a7 = 0;
				let wi = w0;
				for (let k = 0; k < K; k++) {
					const o = base + koff[k];
					const w = Wk[wi];
					wi += 4;
					a0 += w * Xp[o];
					a1 += w * Xp[o + sw];
					a2 += w * Xp[o + 2 * sw];
					a3 += w * Xp[o + 3 * sw];
					a4 += w * Xp[o + 4 * sw];
					a5 += w * Xp[o + 5 * sw];
					a6 += w * Xp[o + 6 * sw];
					a7 += w * Xp[o + 7 * sw];
				}
				O[q] = a0 + b;
				O[q + 1] = a1 + b;
				O[q + 2] = a2 + b;
				O[q + 3] = a3 + b;
				O[q + 4] = a4 + b;
				O[q + 5] = a5 + b;
				O[q + 6] = a6 + b;
				O[q + 7] = a7 + b;
			} else {
				for (let x = ox; x < Wo; x++) {
					let a = 0;
					let wi = w0;
					const o0 = oy * sh * Wp + x * sw;
					for (let k = 0; k < K; k++) {
						a += Wk[wi] * Xp[o0 + koff[k]];
						wi += 4;
					}
					O[outBase + oy * Wo + x] = a + b;
				}
			}
		}
}
