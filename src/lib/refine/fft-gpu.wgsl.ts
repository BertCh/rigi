// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The elementwise stages around luma's GPUFFT1D in the four-step yaw correlation (fft-gpu.ts; index
// algebra in fourstep.ts). All kernels are one thread per output element, @workgroup_size(256).

import { defineUniformBlock } from "#/lib/gpu/core/uniform-block";

/** struct P below; shared by every kernel of the graph. */
export const FFT_U = defineUniformBlock({
	M: "u32",
	N1: "u32",
	N2: "u32",
	nSig: "u32",
	nPair: "u32",
	nShift: "u32",
	S: "u32",
});

const HEAD = /* wgsl */ `
struct P { M: u32, N1: u32, N2: u32, nSig: u32, nPair: u32, nShift: u32, S: u32 };
@group(0) @binding(0) var<uniform> p: P;
fn cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
`;

/** A[sig][n1][n2] = (x[sig][n1 + N1·n2], 0): the strided gather replaces a transpose. */
export const PACK_WGSL = `${HEAD}
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read_write> a: array<vec2f>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
	let i = gid.x;
	if (i >= p.nSig * p.M) { return; }
	let sig = i / p.M;
	let r = i % p.M;
	let n1 = r / p.N2;
	let n2 = r % p.N2;
	a[i] = vec2f(x[sig * p.M + n1 + p.N1 * n2], 0.0);
}
`;

/** B[sig][k2][n1] = A'[sig][n1][k2] · ω_M^(n1·k2) (forward twiddle + transpose). */
export const TWIDDLE_FWD_WGSL = `${HEAD}
@group(0) @binding(1) var<storage, read> a: array<vec2f>;
@group(0) @binding(2) var<storage, read> tw: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> b: array<vec2f>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
	let o = gid.x;
	if (o >= p.nSig * p.M) { return; }
	let sig = o / p.M;
	let r = o % p.M;
	let k2 = r / p.N1;
	let n1 = r % p.N1;
	b[o] = cmul(a[sig * p.M + n1 * p.N2 + k2], tw[(n1 * k2) % p.M]);
}
`;

/** R[pair][n1][k2] = Q[pair][k2][n1] · conj(ω_M^(n1·k2)) (inverse twiddle + transpose). */
export const TWIDDLE_INV_WGSL = `${HEAD}
@group(0) @binding(1) var<storage, read> a: array<vec2f>;
@group(0) @binding(2) var<storage, read> tw: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> b: array<vec2f>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
	let o = gid.x;
	if (o >= p.nPair * p.M) { return; }
	let pr = o / p.M;
	let r = o % p.M;
	let n1 = r / p.N2;
	let k2 = r % p.N2;
	let w = tw[(n1 * k2) % p.M];
	b[o] = cmul(a[pr * p.M + k2 * p.N1 + n1], vec2f(w.x, -w.y));
}
`;

/**
 * conj(Xa)·Xb per frequency for the 4 pairs of every focal scale, the pairs of init.ts: C1 = corr(WP, H),
 * C2 = corr(W, H), C3 = corr(W, H2), C4 = corr(WX, H). Signal order: H, H2, then (W, WP, WX) per scale.
 * Both operands share the permuted spectrum order, so the product is elementwise.
 */
export const PRODUCT_WGSL = `${HEAD}
@group(0) @binding(1) var<storage, read> spec: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> prod: array<vec2f>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
	let i = gid.x;
	if (i >= p.nPair * p.M) { return; }
	let pr = i / p.M;
	let r = i % p.M;
	let f = pr / 4u;
	let j = pr % 4u;
	let w = 2u + 3u * f;
	var sa = w + 1u;      // C1: WP
	var sb = 0u;          //     vs H
	if (j == 1u) { sa = w; }                    // C2: W vs H
	if (j == 2u) { sa = w; sb = 1u; }           // C3: W vs H2
	if (j == 3u) { sa = w + 2u; }               // C4: WX vs H
	let A = spec[sa * p.M + r];
	let B = spec[sb * p.M + r];
	prod[i] = vec2f(A.x * B.x + A.y * B.y, A.x * B.y - A.y * B.x);
}
`;

/** out[pair][q] = Re y[pair][(q - S) mod M] for the 2S+1 needed shifts, y in [n1][n2] layout. */
export const GATHER_WGSL = `${HEAD}
@group(0) @binding(1) var<storage, read> y: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> out: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
	let o = gid.x;
	if (o >= p.nPair * p.nShift) { return; }
	let pr = o / p.nShift;
	let q = o % p.nShift;
	let s = (q + p.M - p.S) % p.M;
	let n1 = s % p.N1;
	let n2 = s / p.N1;
	out[o] = y[pr * p.M + n1 * p.N2 + n2].x;
}
`;

/**
 * Direct DFT over the N1 contiguous values of each row (N1 <= 64): the stage-2 transform when luma's
 * GPUFFT1D is not trusted at that length (fft-gpu.ts). out[row][k] = Σ_n in[row][n]·ω_N1^(±n·k), with
 * ω_N1^j read from the M-point twiddle table (j·M/N1); the inverse also scales by 1/N1, like GPUFFT1D.
 * Forward runs over nSig·M values, inverse over nPair·M. One thread per output value.
 */
const DFT_BODY = (count: string, sign: string, scale: string) => `${HEAD}
@group(0) @binding(1) var<storage, read> a: array<vec2f>;
@group(0) @binding(2) var<storage, read> tw: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> b: array<vec2f>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
	let o = gid.x;
	if (o >= ${count}) { return; }
	let row = o / p.N1;
	let k = o % p.N1;
	let stride = p.M / p.N1;
	var acc = vec2f(0.0, 0.0);
	for (var n = 0u; n < p.N1; n++) {
		let w = tw[((n * k) % p.N1) * stride];
		acc += cmul(a[row * p.N1 + n], vec2f(w.x, ${sign} * w.y));
	}
	b[o] = acc * ${scale};
}
`;
export const DFT_FWD_WGSL = DFT_BODY("p.nSig * p.M", "1.0", "1.0");
export const DFT_INV_WGSL = DFT_BODY(
	"p.nPair * p.M",
	"-1.0",
	"(1.0 / f32(p.N1))",
);
