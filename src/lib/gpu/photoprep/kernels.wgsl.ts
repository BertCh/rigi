// WGSL of the photo-prep kernels (./index.ts runs them; ./emulate.ts is the JS twin, kernel for kernel;
// src/lib/align.ts edgeMapFromPixels / scanLabels / fitSkyModel are the CPU reference). Every plane is
// an array<u32>: f32 planes hold binary32 bit patterns, doubles are vec2<u32> (./softf64.wgsl.ts). No
// float type is used, so every result is defined by integer semantics alone. Each kernel's comment
// names the CPU statement it reproduces and the order of the binary64 operations, which is the CPU's.

import { wgslF64 } from "./softf64";
import { SOFTF64_WGSL } from "./softf64.wgsl";

/**
 * Uniform words (u32): w, h, n = w·h, k = ⌊0.97 n⌋, round(0.12 h), round(0.06 h), round(0.8 h), and a
 * per-run nonce (≠ 0) that the last kernels echo into the read-back words, so a run whose dispatches
 * silently did not execute cannot pass off a previous run's planes (transients keep old bytes).
 */
export const DIMS_WORDS = 8;
const DIMS = /* wgsl */ `
struct Dims { w: u32, h: u32, n: u32, k: u32, t12: u32, band: u32, r80: u32, nonce: u32 }
`;

const CONSTS = /* wgsl */ `
const C299 = ${wgslF64(0.299)};
const C587 = ${wgslF64(0.587)};
const C114 = ${wgslF64(0.114)};
const C035 = ${wgslF64(0.35)};
const C05 = ${wgslF64(0.5)};
const C2 = ${wgslF64(2)};
const C1 = ${wgslF64(1)};
const C15 = ${wgslF64(1.5)};
const C03 = ${wgslF64(0.3)};
const C1E3 = ${wgslF64(1e-3)};
`;

const LIB = SOFTF64_WGSL + CONSTS;

/** Threads per workgroup of the per-pixel kernels (1-D grid of ⌈n / 64⌉ workgroups). */
export const WG = 64;
/** Workgroups of the grid-stride histogram kernels (each flushes its local bins once). */
export const HIST_WG = 64;
/** Threads per workgroup of the histogram kernels. */
export const HIST_THREADS = 256;
/** Colour bins of align.ts colorBin (12³) and the sky histogram's words (sky, terrain, ns, nt). */
export const NBINS = 1728;
export const SKY_HIST_WORDS = 2 * NBINS + 2;

// fg > 0.3 exactly as the CPU compares it: the binary32 value widened (exactly) to binary64 against
// the double 0.3; fg ≥ +0, so bit patterns order like values
const FG = /* wgsl */ `
fn fg_gt03(f: u32) -> bool { return f64_gt_pos(f64_from_f32(f), C03); }
`;
// align.ts colorBin: min(11, ⌊(v / 256) · 12⌋) = (3 v) >> 6 for a byte v (v·12/256 is exact in f64)
const BIN = /* wgsl */ `
fn color_bin(p: u32) -> u32 {
	let r = ((p & 0xffu) * 3u) >> 6u;
	let g = (((p >> 8u) & 0xffu) * 3u) >> 6u;
	let b = (((p >> 16u) & 0xffu) * 3u) >> 6u;
	return (r * 12u + g) * 12u + b;
}
`;

/**
 * L[i] = fround((0.299 r + 0.587 g + 0.114 b) / 255) and B[i] = fround(b / (r + g + b + 1)):
 * ((0.299·r ⊕ 0.587·g) ⊕ 0.114·b) ⊘ 255, then b ⊘ (r+g+b+1), each op rounded to binary64 as in JS.
 */
export const LUMAB_WGSL = /* wgsl */ `${DIMS}${LIB}
@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> rgba: array<u32>;
@group(0) @binding(2) var<storage, read_write> lum: array<u32>;
@group(0) @binding(3) var<storage, read_write> blu: array<u32>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= dims.n) { return; }
	let p = rgba[i];
	let r = p & 0xffu;
	let g = (p >> 8u) & 0xffu;
	let b = (p >> 16u) & 0xffu;
	let s = f64_add(f64_add(f64_mul(C299, f64_from_u32(r)), f64_mul(C587, f64_from_u32(g))), f64_mul(C114, f64_from_u32(b)));
	lum[i] = f64_to_f32(f64_div_small(s, 255u));
	blu[i] = f64_to_f32(f64_div_small(f64_from_u32(b), r + g + b + 1u));
}
`;

/**
 * E (align.ts buildEdgeMap's gradient loop): for 2 ≤ y < h−2, 1 ≤ x < w−1
 *   gy = L[i−2w] − L[i+2w], gx = L[i+1] − L[i−1], by = B[i−2w] − B[i+2w]   (binary32 widened, exact)
 *   E = fround(((max(gy,0) ⊕ 0.35 ⊗ max(−gy,0)) ⊕ 0.5 ⊗ |gx|) ⊕ 2 ⊗ max(by,0)), +0 elsewhere.
 */
export const EDGE_WGSL = /* wgsl */ `${DIMS}${LIB}
@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> lum: array<u32>;
@group(0) @binding(2) var<storage, read> blu: array<u32>;
@group(0) @binding(3) var<storage, read_write> edge: array<u32>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= dims.n) { return; }
	let w = dims.w;
	let x = i % w;
	let y = i / w;
	if (y < 2u || y + 2u >= dims.h || x < 1u || x + 1u >= w) {
		edge[i] = 0u;
		return;
	}
	let gy = f64_sub(f64_from_f32(lum[i - 2u * w]), f64_from_f32(lum[i + 2u * w]));
	let gx = f64_sub(f64_from_f32(lum[i + 1u]), f64_from_f32(lum[i - 1u]));
	let by = f64_sub(f64_from_f32(blu[i - 2u * w]), f64_from_f32(blu[i + 2u * w]));
	let oriented = f64_add(f64_max0(gy), f64_mul(C035, f64_max0(f64_neg(gy))));
	let e = f64_add(f64_add(oriented, f64_mul(C05, f64_abs(gx))), f64_mul(C2, f64_max0(by)));
	edge[i] = f64_to_f32(e);
}
`;

// Exact k-th smallest of E (math.ts kthSmallest(E, k) returns the k-th smallest VALUE): E ≥ +0 and
// never NaN, so the order of the values is the order of their u32 bit patterns, and a 3-pass radix
// select over the digits [31:21], [20:10], [9:0] finds that pattern from integer counts alone.
// sel = [prefix, rank left, p bits, nonce]; p = the value, or 1.0 when it is 0 (buildEdgeMap's `|| 1`).
const RADIX = [
	{ shift: 21, bits: 11 },
	{ shift: 10, bits: 11 },
	{ shift: 0, bits: 10 },
] as const;
/** Radix-select histogram bins (the widest digit). */
export const RADIX_BINS = 2048;

/** Histogram of digit `pass` over the elements whose higher digits equal sel's prefix. */
export const histWgsl = (pass: 0 | 1 | 2) => {
	const { shift, bits } = RADIX[pass];
	const match =
		pass === 0 ? "true" : `(v >> ${RADIX[pass - 1].shift}u) == sel[0]`;
	// pass 0 has no prefix, so no `sel` binding (layout: dims, edge, hist)
	const bindings =
		pass === 0
			? "@group(0) @binding(2) var<storage, read_write> hist: array<atomic<u32>>;"
			: "@group(0) @binding(2) var<storage, read> sel: array<u32>;\n@group(0) @binding(3) var<storage, read_write> hist: array<atomic<u32>>;";
	return /* wgsl */ `${DIMS}
@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> edge: array<u32>;
${bindings}
var<workgroup> wg_bins: array<atomic<u32>, ${1 << bits}>;
@compute @workgroup_size(${HIST_THREADS})
fn main(@builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3<u32>) {
	for (var j = li; j < ${1 << bits}u; j += ${HIST_THREADS}u) { atomicStore(&wg_bins[j], 0u); }
	workgroupBarrier();
	let stride = ${HIST_WG * HIST_THREADS}u;
	for (var i = wg.x * ${HIST_THREADS}u + li; i < dims.n; i += stride) {
		let v = edge[i];
		if (${match}) { atomicAdd(&wg_bins[(v >> ${shift}u) & ${(1 << bits) - 1}u], 1u); }
	}
	workgroupBarrier();
	for (var j = li; j < ${1 << bits}u; j += ${HIST_THREADS}u) {
		let c = atomicLoad(&wg_bins[j]);
		if (c != 0u) { atomicAdd(&hist[j], c); }
	}
}
`;
};

/** The bin of digit `pass` holding the remaining rank (one thread; integer prefix counts). */
export const selectWgsl = (pass: 0 | 1 | 2) => {
	const { bits } = RADIX[pass];
	const start =
		pass === 0
			? "let prefix = 0u;\n\tvar krem = dims.k;"
			: "let prefix = sel[0];\n\tvar krem = sel[1];";
	const finish =
		pass === 2
			? "let v = (prefix << 10u) | d;\n\tsel[0] = v;\n\tsel[1] = krem;\n\tsel[2] = select(v, 0x3f800000u, v == 0u);"
			: `sel[0] = (prefix << ${bits}u) | d;\n\tsel[1] = krem;\n\tsel[2] = 0u;`;
	return /* wgsl */ `${DIMS}
@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> hist: array<u32>;
@group(0) @binding(2) var<storage, read_write> sel: array<u32>;
@compute @workgroup_size(1)
fn main() {
	${start}
	var d = 0u;
	var acc = 0u;
	for (var j = 0u; j < ${1 << bits}u; j++) {
		let c = hist[j];
		if (krem < acc + c) {
			d = j;
			break;
		}
		acc += c;
	}
	krem -= acc;
	${finish}
	// every pass echoes the nonce (this also keeps dims statically used by every select: an auto-derived
	// pipeline layout drops unused bindings and then rejects the bind group)
	sel[3] = dims.nonce;
}
`;
};

/** En[i] = fround(min(E[i] ⊘ p, 1.5) ⊗ (1 ⊖ fg[i])) (buildEdgeMap's normalisation). */
export const NORM_WGSL = /* wgsl */ `${DIMS}${LIB}
@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> edge: array<u32>;
@group(0) @binding(2) var<storage, read> fg: array<u32>;
@group(0) @binding(3) var<storage, read> sel: array<u32>;
@group(0) @binding(4) var<storage, read_write> en: array<u32>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= dims.n) { return; }
	let q = f64_div(f64_from_f32(edge[i]), f64_from_f32(sel[2]));
	let qm = select(q, C15, f64_gt_pos(q, C15));
	en[i] = f64_to_f32(f64_mul(qm, f64_sub(C1, f64_from_f32(fg[i]))));
}
`;

/**
 * align.ts boxBlur's horizontal pass (radius R), one thread per row, the CPU's running binary64
 * accumulator op for op: acc = 0; acc ⊕= src[clamp(x)] for x = −R..R; then per x:
 * tmp[x] = fround(acc ⊘ (2R+1)); acc ⊕= (src[min(x+R+1, w−1)] ⊖ src[max(x−R, 0)]).
 */
export const blurRowWgsl = (r: number) => /* wgsl */ `${DIMS}${LIB}
@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let y = gid.x;
	if (y >= dims.h) { return; }
	let w = i32(dims.w);
	let row = y * dims.w;
	var acc = vec2<u32>(0u, 0u);
	for (var x = -${r}; x <= ${r}; x++) {
		acc = f64_add(acc, f64_from_f32(src[row + u32(clamp(x, 0, w - 1))]));
	}
	for (var x = 0; x < w; x++) {
		dst[row + u32(x)] = f64_to_f32(f64_div_small(acc, ${2 * r + 1}u));
		let a = f64_from_f32(src[row + u32(min(x + ${r + 1}, w - 1))]);
		let b = f64_from_f32(src[row + u32(max(x - ${r}, 0))]);
		acc = f64_add(acc, f64_sub(a, b));
	}
}
`;

/** align.ts boxBlur's vertical pass (radius R), one thread per column, same accumulator sequence. */
export const blurColWgsl = (r: number) => /* wgsl */ `${DIMS}${LIB}
@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let x = gid.x;
	if (x >= dims.w) { return; }
	let w = dims.w;
	let h = i32(dims.h);
	var acc = vec2<u32>(0u, 0u);
	for (var y = -${r}; y <= ${r}; y++) {
		acc = f64_add(acc, f64_from_f32(src[u32(clamp(y, 0, h - 1)) * w + x]));
	}
	for (var y = 0; y < h; y++) {
		dst[u32(y) * w + x] = f64_to_f32(f64_div_small(acc, ${2 * r + 1}u));
		let a = f64_from_f32(src[u32(min(y + ${r + 1}, h - 1)) * w + x]);
		let b = f64_from_f32(src[u32(max(y - ${r}, 0)) * w + x]);
		acc = f64_add(acc, f64_sub(a, b));
	}
}
`;

/**
 * align.ts scanLabels, one thread per column. Labels: 0 unknown, 1 sky, 2 terrain. `lim[2x], lim[2x+1]`
 * (i32) is the inclusive range of stops whose terrain band applies (align.ts stopHasBand evaluated on
 * the CPU for every candidate stop; empty when lo > hi), so the f64 tests of the prior row and the
 * 0.04 h / 0.85 h bounds are the CPU's own.
 */
export const SCAN_WGSL = /* wgsl */ `${DIMS}${LIB}${FG}
@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> rgba: array<u32>;
@group(0) @binding(2) var<storage, read> fg: array<u32>;
@group(0) @binding(3) var<storage, read> lim: array<i32>;
@group(0) @binding(4) var<storage, read_write> lbl: array<u32>;
fn channel_diff(i: u32, j: u32) -> i32 {
	let a = rgba[i];
	let b = rgba[j];
	return abs(i32(a & 0xffu) - i32(b & 0xffu)) + abs(i32((a >> 8u) & 0xffu) - i32((b >> 8u) & 0xffu)) + abs(i32((a >> 16u) & 0xffu) - i32((b >> 16u) & 0xffu));
}
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let x = gid.x;
	if (x >= dims.w) { return; }
	let w = dims.w;
	let h = i32(dims.h);
	var stop = -1;
	for (var y = 3; y < h - 1; y++) {
		if (fg_gt03(fg[u32(y) * w + x])) { break; }
		if (channel_diff(u32(y - 3) * w + x, u32(y + 1) * w + x) > 40) {
			stop = y;
			break;
		}
	}
	let top = select(stop, i32(dims.t12), stop < 0);
	let banded = stop >= 0 && stop >= lim[2u * x] && stop <= lim[2u * x + 1u];
	let band_end = min(h, stop + 3 + i32(dims.band));
	let r80 = i32(dims.r80);
	for (var y = 0; y < h; y++) {
		var l = 0u;
		if (y < top - 2) { l = 1u; }
		if (banded && y >= stop + 3 && y < band_end) { l = 2u; }
		if (y >= r80) { l = 2u; }
		lbl[u32(y) * w + x] = l;
	}
}
`;

/** align.ts fitSkyModel's counts: hs (words 0..1727), ht (1728..3455), ns (3456), nt (3457). */
export const SKY_HIST_WGSL = /* wgsl */ `${DIMS}${LIB}${FG}${BIN}
@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> rgba: array<u32>;
@group(0) @binding(2) var<storage, read> fg: array<u32>;
@group(0) @binding(3) var<storage, read> lbl: array<u32>;
@group(0) @binding(4) var<storage, read_write> sh: array<atomic<u32>>;
var<workgroup> wg_bins: array<atomic<u32>, ${SKY_HIST_WORDS}>;
@compute @workgroup_size(${HIST_THREADS})
fn main(@builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3<u32>) {
	for (var j = li; j < ${SKY_HIST_WORDS}u; j += ${HIST_THREADS}u) { atomicStore(&wg_bins[j], 0u); }
	workgroupBarrier();
	let stride = ${HIST_WG * HIST_THREADS}u;
	for (var i = wg.x * ${HIST_THREADS}u + li; i < dims.n; i += stride) {
		let l = lbl[i];
		if (l != 0u && !fg_gt03(fg[i])) {
			let b = color_bin(rgba[i]);
			if (l == 1u) {
				atomicAdd(&wg_bins[b], 1u);
				atomicAdd(&wg_bins[${2 * NBINS}u], 1u);
			} else {
				atomicAdd(&wg_bins[${NBINS}u + b], 1u);
				atomicAdd(&wg_bins[${2 * NBINS + 1}u], 1u);
			}
		}
	}
	workgroupBarrier();
	for (var j = li; j < ${SKY_HIST_WORDS}u; j += ${HIST_THREADS}u) {
		let c = atomicLoad(&wg_bins[j]);
		if (c != 0u) { atomicAdd(&sh[j], c); }
	}
}
`;

/**
 * P(sky) per colour bin, fitSkyModel's per-pixel expression evaluated once per bin (it depends on the
 * bin only): as = (ns ⊘ 1728) ⊗ 2 ⊕ 1e-3; ps = (hs[b] ⊕ as) ⊘ (ns ⊕ as ⊗ 1728); same for t;
 * table[b] = fround(ps ⊘ (ps ⊕ pt)). hs[b] is the CPU's Float32Array count: an integer < 2^24, exact.
 */
export const SKY_TABLE_WGSL = /* wgsl */ `${LIB}
@group(0) @binding(0) var<storage, read> sh: array<u32>;
@group(0) @binding(1) var<storage, read_write> table: array<u32>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let b = gid.x;
	if (b >= ${NBINS}u) { return; }
	let nb = f64_from_u32(${NBINS}u);
	let ns = f64_from_u32(sh[${2 * NBINS}u]);
	let nt = f64_from_u32(sh[${2 * NBINS + 1}u]);
	let a_s = f64_add(f64_mul(f64_div_small(ns, ${NBINS}u), C2), C1E3);
	let a_t = f64_add(f64_mul(f64_div_small(nt, ${NBINS}u), C2), C1E3);
	let ps = f64_div(f64_add(f64_from_u32(sh[b]), a_s), f64_add(ns, f64_mul(a_s, nb)));
	let pt = f64_div(f64_add(f64_from_u32(sh[${NBINS}u + b]), a_t), f64_add(nt, f64_mul(a_t, nb)));
	table[b] = f64_to_f32(f64_div(ps, f64_add(ps, pt)));
}
`;

/** S[i] = fg[i] > 0.3 ? 0.5 : table[colorBin(i)] (fitSkyModel's S plane, binary32). */
export const SKY_GATHER_WGSL = /* wgsl */ `${DIMS}${LIB}${FG}${BIN}
@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> rgba: array<u32>;
@group(0) @binding(2) var<storage, read> fg: array<u32>;
@group(0) @binding(3) var<storage, read> table: array<u32>;
@group(0) @binding(4) var<storage, read_write> sp: array<u32>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let i = gid.x;
	if (i >= dims.n) { return; }
	if (fg_gt03(fg[i])) {
		sp[i] = 0x3f000000u;
	} else {
		sp[i] = table[color_bin(rgba[i])];
	}
}
`;

/**
 * fitSkyModel's skyCum: per column, cum[0] = 0, acc ⊕= sky[y], cum[y+1] = fround(acc). Thread 0 also
 * writes echo = [nonce, 0, 0, 0].
 */
export const SKY_CUM_WGSL = /* wgsl */ `${DIMS}${LIB}
@group(0) @binding(0) var<uniform> dims: Dims;
@group(0) @binding(1) var<storage, read> sky: array<u32>;
@group(0) @binding(2) var<storage, read_write> cum: array<u32>;
@group(0) @binding(3) var<storage, read_write> echo: array<u32>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let x = gid.x;
	if (x == 0u) {
		echo[0] = dims.nonce;
		echo[1] = 0u;
		echo[2] = 0u;
		echo[3] = 0u;
	}
	if (x >= dims.w) { return; }
	let w = dims.w;
	cum[x] = 0u;
	var acc = vec2<u32>(0u, 0u);
	for (var y = 0u; y < dims.h; y++) {
		acc = f64_add(acc, f64_from_f32(sky[y * w + x]));
		cum[(y + 1u) * w + x] = f64_to_f32(acc);
	}
}
`;
