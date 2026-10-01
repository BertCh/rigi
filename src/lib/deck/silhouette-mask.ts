// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// autoAlign's silhouette re-rank on the GPU, bit-identical to the CPU scorer.
//
// The CPU score (deck/engine.ts and deck-webgpu/engine.ts scoreSilhouette, engine.ts
// silhouetteFromRange) is, for one 384 px range render of a pose:
//   for every inner pixel (1 ≤ x ≤ W−2, 1 ≤ y ≤ H−2, raster order, row 0 = top):
//     pass ⇔ 0 < r ≤ 25000  ∧  max(f(up), f(right), f(left)) − log r ≥ 0.5
//            with f(n) = logRange(n) if logRange(n) < 13 else 0   (sky: logRange = 13.5 → 0)
//     if pass and edge.fg[cell] ≤ 0.3: sum += edge.coarse[cell]; n++        (doubles)
//   score = n > 30 ? sum / n : 0
// `sum` is a double sum of float32 values in raster order. Its rounding depends on that order and
// on which pixels take part, so no GPU reduction (f32, or any other order) can reproduce it in
// general: the box-blurred coarse map holds values across many binades. What the GPU CAN do
// exactly is the per-pixel predicate. So the GPU writes one bit per pixel (the pass mask, plus a
// per-96-pixel count of pixels it could not decide), and the CPU walks the set bits in raster order
// with the CPU scorer's own expressions (scoreFromMask). 1 bit/px + one u32 per 96 px = 18 KB per
// 384 × 288 pose, instead of the 442 KB (WebGL r32float) / 1.77 MB (WebGPU rgba32float) range read.
//
// Why the GPU predicate equals the CPU predicate (certified bounds, no float log on the GPU):
// 1. The GPU reads the very texels the CPU path reads back (same texture, same bits: readPixels and
//    the WebGPU copy are bit copies; texelFetch / textureLoad return the stored f32).
// 2. Every test on the GPU is a compare of the raw f32 value against an f32 constant made here
//    (exact on any GPU), or against one f32 product rc·K (see 4). Values whose bits are denormal,
//    Inf or NaN (never produced by the geometry pass: range ≥ the 1 m near plane, sky = 0) are
//    "undecided", so flush-to-zero or NaN handling cannot make the two sides differ.
// 3. JS side: c = Math.log(rc), l = Math.log(rn) (|error| ≤ 1 ulp, < 4e-15 for |ln x| < 16) and
//    d = fl(f − c). fl(·) is monotone, so max(f) − c ≥ 0.5 ⇔ ∃ neighbour with fl(f_n − c) ≥ 0.5.
//    Per neighbour:
//      sky (texel ≤ 0)          → f = 0: pass ⇔ −c ≥ 0.5 ⇔ fl(log rc) ≤ −0.5                [Z]
//      rn > 0, fl(log rn) ≥ 13  → f = 0: same as sky                                         [Z]
//      rn > 0, fl(log rn) < 13  → pass ⇔ fl(l − c) ≥ 0.5                                      [R]
//    Each condition is decided with a relative margin M = 1e-5 around its exact threshold:
//      lt13: rn ≤ fround(e^13·(1−M)) → surely < 13;  rn ≥ fround(e^13·(1+M)) → surely ≥ 13
//      Z:    rc ≤ fround(e^−0.5·(1−M)) → surely pass; rc ≥ fround(e^−0.5·(1+M)) → surely fail
//      R:    rn ≥ fl32(rc·KHI) → surely pass, rn ≤ fl32(rc·KLO) → surely fail,
//            KHI = fround(e^0.5·(1+M)), KLO = fround(e^0.5·(1−M))
// 4. R's bound: even if the GPU's product is off by up to 2^-20 relative (correct rounding is 2^-24;
//    GLSL ES 3.00 and WGSL both specify correctly rounded multiplication), rn ≥ fl32(rc·KHI) gives
//    rn/rc ≥ e^0.5·(1 + M − 1.1e-6), so ln(rn/rc) ≥ 0.5 + 8e-6, and the JS difference is within
//    1e-14 of that: it passes. Symmetrically for KLO. The other bounds are pure compares. Inside a
//    band the pixel is "undecided"; a pixel is decided when one neighbour surely passes or all
//    three surely fail (three-valued OR), exactly the CPU's max().
// 5. Any undecided pixel in a pose (or a header whose nonce isn't this call's: a dispatch that did
//    not run) sends THAT pose to the exact CPU path (its range is read back and scored by the CPU
//    scorer). The bands are ~2e-5 wide in log range, so in practice this never happens; the A/B
//    harness counts it.
// 6. A mask that is valid but read the wrong data, e.g. an all-zero texture (destroyed, not yet
//    written, wrong binding), would decide every pixel "surely fail" and score 0 silently. So each
//    header also counts the group's positive-range texels (every row, every column), and a pose
//    whose mask counts none (all sky, so nothing could pass anyway) is re-scored on the CPU from its
//    read-back range. A real all-sky finalist only costs that one readback.
// So a pose's mask equals the CPU's pass set bit for bit, scoreFromMask adds the same doubles in
// the same order, and the scores, the re-rank and every autoAlign output are identical.
//
// Engines: DeckEngine (WebGL2, deck/silhouette-gl.ts) and WebGpuEngine (WGSL, deck-webgpu/
// silhouette-gpu.ts), both behind their `silhouetteGpu` option (default true; false = the CPU
// scorer). (The three.js PhotoEngine, which kept the CPU scorer, was removed on 2026-10-01.)
// Checks: scripts/gpu/silhouette-mask-check.ts (node: packing, decoder, bounds) and
// scripts/gpu/silhouette-ab.mjs (browser: GPU vs CPU autoAlign with Object.is).
import type { EdgeMap } from "../align";

/**
 * Pixels per mask group: 3 u32 of pass bits + 1 u32 header
 * (nonce << 16 | positive-range texel count << 8 | undecided count; both counts ≤ 96).
 */
export const SIL_GROUP = 96;
/** Relative margin of every certified bound (see the header). */
export const SIL_MARGIN = 1e-5;

/** The certified f32 thresholds, in the order the shaders take them. */
export function silhouetteThresholds() {
	const m = SIL_MARGIN;
	const f = Math.fround;
	return {
		/** centre range limit (exact: 25000 is an f32) */
		rmax: 25000,
		khi: f(Math.exp(0.5) * (1 + m)),
		klo: f(Math.exp(0.5) * (1 - m)),
		/** −log rc ≥ 0.5: surely below / surely above */
		zlo: f(Math.exp(-0.5) * (1 - m)),
		zhi: f(Math.exp(-0.5) * (1 + m)),
		/** log rn < 13: surely below / surely above */
		flo: f(Math.exp(13) * (1 - m)),
		fhi: f(Math.exp(13) * (1 + m)),
	};
}

/** Mask groups per row. */
export const silGroups = (width: number) => Math.ceil(width / SIL_GROUP);
/** u32 words per pose mask (top-down rows × groups × 4). */
export const silMaskWords = (width: number, height: number) =>
	silGroups(width) * height * 4;

let nonceSeq = 0;
/** A fresh 16-bit header nonce (never 0, so a zeroed buffer never matches; a stale buffer holds
 * an earlier call's nonce, so it can't match either). */
export function silNonce() {
	nonceSeq = (nonceSeq % 0xfffe) + 1;
	return nonceSeq;
}

/**
 * The CPU scorer's sum over a GPU pass mask: null when the mask can't be trusted (a header without
 * `nonce`: the pass didn't run; no positive-range texel at all: it read zeros, see 6 above) or
 * holds an undecided pixel; the caller then scores that pose on the CPU. Same expressions, same order as scoreSilhouette (rows top-down, x ascending).
 */
export function scoreFromMask(
	words: Uint32Array,
	base: number,
	W: number,
	H: number,
	edge: EdgeMap,
	nonce: number,
): number | null {
	const G = silGroups(W);
	let positive = 0;
	for (let j = 0; j < G * H; j++) {
		const hd = words[base + j * 4 + 3];
		if (hd >>> 16 !== nonce || (hd & 0xff) !== 0) return null;
		positive += (hd >>> 8) & 0xff;
	}
	if (positive === 0) return null;
	let sum = 0;
	let n = 0;
	for (let y = 1; y < H - 1; y++)
		for (let g = 0; g < G; g++)
			for (let k = 0; k < 3; k++) {
				let m = words[base + (y * G + g) * 4 + k] | 0;
				while (m !== 0) {
					const low = m & -m;
					m ^= low;
					const x = g * SIL_GROUP + k * 32 + (31 - Math.clz32(low));
					const u = x / W;
					const v = (y + 1) / H;
					const ex = Math.min(edge.w - 1, Math.floor(u * edge.w));
					const ey = Math.min(edge.h - 1, Math.floor(v * edge.h));
					const i = ey * edge.w + ex;
					if (edge.fg[i] > 0.3) continue;
					sum += edge.coarse[i];
					n++;
				}
			}
	return n > 30 ? sum / n : 0;
}

/** One re-rank's scores and what it cost (DeckEngine / WebGpuEngine autoAlign). */
export type SilScores = {
	/** silhouette score of alternatives[i] */
	sils: number[];
	/** when scoring started (performance.now) */
	tScore: number;
	/** bytes read back from the GPU (masks + any fallback range reads) */
	bytes: number;
	/** GPU path: poses re-scored on the CPU (undecided pixel / bad header) */
	fallbacks: number;
	path: "gpu" | "cpu";
};
