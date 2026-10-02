// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The elementwise stages around luma's GPUFFT1D in the yaw correlation (fft-gpu.ts). All kernels are one
// thread per output element, @workgroup_size(256).

import { defineUniformBlock } from "#/lib/gpu/core/uniform-block";

/** struct P below; shared by every kernel of the graph. */
export const FFT_U = defineUniformBlock({
	M: "u32",
	nSig: "u32",
	nPair: "u32",
	nShift: "u32",
	S: "u32",
});

const HEAD = /* wgsl */ `
struct P { M: u32, nSig: u32, nPair: u32, nShift: u32, S: u32 };
@group(0) @binding(0) var<uniform> p: P;
`;

/** a[i] = (x[i], 0): real signals to complex. */
export const PACK_WGSL = `${HEAD}
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read_write> a: array<vec2f>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
	let i = gid.x;
	if (i >= p.nSig * p.M) { return; }
	a[i] = vec2f(x[i], 0.0);
}
`;

/**
 * conj(Xa)·Xb per frequency for the 4 pairs of every focal scale, the pairs of init.ts: C1 = corr(WP, H),
 * C2 = corr(W, H), C3 = corr(W, H2), C4 = corr(WX, H). Signal order: H, H2, then (W, WP, WX) per scale.
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

/** out[pair][q] = Re y[pair][(q - S) mod M] for the 2S+1 needed shifts. */
export const GATHER_WGSL = `${HEAD}
@group(0) @binding(1) var<storage, read> y: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> out: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
	let o = gid.x;
	if (o >= p.nPair * p.nShift) { return; }
	let pr = o / p.nShift;
	let q = o % p.nShift;
	out[o] = y[pr * p.M + (q + p.M - p.S) % p.M].x;
}
`;
