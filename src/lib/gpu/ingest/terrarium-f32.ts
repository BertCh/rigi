// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The f32 arithmetic of the GPU Terrarium decode (terrarium.ts TERRARIUM_WGSL), step by step with
// Math.fround, and the exactness argument it rests on. No luma runtime: ingest.check.ts runs it over
// all 2^24 RGB triples against dem/decode.ts decodeTerrarium (the CPU twin and reference).
//
// Why the GPU result is bit-identical to decodeTerrarium (f64 arithmetic, then a Float32Array store):
// - The exact height is N/256 − 32768 with N = R·65536 + G·256 + B, a 24-bit integer. Every value
//   the WGSL forms (R·256, R·256 + G, B·(1/256), their sum, the sum − 32768) and every other partial
//   sum of those three terms with −32768 is a multiple of 1/256 with magnitude < 65536, i.e. at most
//   24 significant bits: exactly representable in f32. WGSL f32 + and × are correctly rounded, so
//   each step is exact whatever the association order or FMA contraction the compiler picks.
// - B/256 is written as B · 0.00390625 (an exact power of two) because WGSL f32 division is only
//   accurate to 2.5 ULP.
// - The f64 CPU path computes the same exact value, and the final f32 store does not round it.
// - The sea clamp (h < 0 && h > −12000 → 0) compares exact values with an exact constant, and both
//   paths produce +0 (x − 32768 = 0 is +0 under round-to-nearest; the clamp writes literal +0).
// - Input bytes: an rgba8unorm texel loads as f32(k/255); round(v · 255) recovers k as long as the
//   load is within 0.5/255 of k/255, which every conforming implementation meets by a wide margin
//   (checked over all 256 values with a ±4 ULP perturbation in ingest.check.ts).
// What this does NOT prove: that the bytes copyExternalImageToTexture puts in the texture equal the
// canvas getImageData bytes the CPU path decodes. scripts/gpu/terrarium-ingest-check.mjs measures that.

/** 1/256, an exact power of two (WGSL: multiply, never divide). */
export const INV_256 = 0.00390625;
/** Terrarium offset. */
export const OFFSET = 32768;
/** Lower bound of the sea clamp (decode.ts decodeTerrarium). */
export const SEA_FLOOR = -12000;

const f = Math.fround;

/** One texel, in exactly the order and precision of TERRARIUM_WGSL. */
export function terrariumF32(r: number, g: number, b: number): number {
	const h = f(f(f(f(r * 256) + g) + f(b * INV_256)) - OFFSET);
	return h < 0 && h > SEA_FLOOR ? 0 : h;
}

/** unorm8 load + round-to-byte, as the kernel does (`round(v * 255)` on an f32 load). */
export const unormToByte = (v: number) => Math.round(f(f(v) * 255));

/**
 * Every intermediate the WGSL (or a reassociated / FMA-contracted version of it) can form for
 * (r, g, b) is exactly representable in f32. Returns the first partial sum that is not, or null.
 */
export function inexactPartial(r: number, g: number, b: number): string | null {
	const r256 = r * 256;
	const b256 = b * INV_256;
	const parts: [string, number][] = [
		["r*256", r256],
		["b/256", b256],
		["r*256+g", r256 + g],
		["r*256+b/256", r256 + b256],
		["g+b/256", g + b256],
		["r*256-off", r256 - OFFSET],
		["g-off", g - OFFSET],
		["b/256-off", b256 - OFFSET],
		["r*256+g+b/256", r256 + g + b256],
		["r*256+g-off", r256 + g - OFFSET],
		["r*256+b/256-off", r256 + b256 - OFFSET],
		["g+b/256-off", g + b256 - OFFSET],
		["h", r256 + g + b256 - OFFSET],
	];
	for (const [name, v] of parts) if (f(v) !== v) return name;
	return null;
}

// ---------- the tile kernel (terrarium-tile.ts TERRARIUM_TILE_WGSL) ----------
//
// Decode + optional 2× box downsample + statistics, for tiles the CPU path would leave untouched by
// validateTile (no sample outside (MIN_VALID, 9000)): the kernel counts those samples and the caller
// falls back to the CPU path when there is one. Why the downsample is exact when the count is 0: every
// valid sample is a multiple of 1/256 in (−1000, 9000), so every partial sum of four of them (in any
// order, with or without FMA) is a multiple of 1/256 below 36000 < 2^16 in magnitude, i.e. at most 24
// significant bits, and × 0.25 is exact: the f32 GPU mean equals the f64 CPU mean (downsampleHeights2)
// stored to f32. Min / max are exact comparisons of f32 values (luma GPUReduction extent over the
// heights), so lo / hi / lo7 / hi7 equal the CPU's up to the sign of zero (min / max of -0 and +0 are
// order-dependent); the invalid count is an integer sum, exact.

/** validateTile's valid range (dem/decode.ts: MIN_VALID < h < 9000). */
export const VALID_MIN = -1000;
export const VALID_MAX = 9000;

/** The tile kernel's result: heights (out × out) and its statistics words, decoded. */
export type TerrariumTileResult = {
	heights: Float32Array;
	/** source samples outside (VALID_MIN, VALID_MAX) */
	invalid: number;
	lo: number;
	hi: number;
	lo7: number;
	hi7: number;
};

/**
 * The stats words the graph writes (u32 × 5, TILE_STATS_WORDS): [invalid (u32), lo, hi, lo7, hi7]
 * with the four extents as f32 bit patterns (GPUReduction sum over u32, extent over f32).
 */
export function decodeTileStats(
	words: Uint32Array,
): Omit<TerrariumTileResult, "heights"> {
	const f32 = new Float32Array(words.buffer, words.byteOffset, 5);
	return {
		invalid: words[0],
		lo: f32[1],
		hi: f32[2],
		lo7: f32[3],
		hi7: f32[4],
	};
}

/**
 * The tile kernel on the CPU, in f32 with the WGSL's operation order: `rgba` (S × S texels, the
 * texture's bytes) → (S/down)² heights + stats words (the layout decodeTileStats reads). The node check compares it with the CPU twin.
 */
export function terrariumTileF32(
	rgba: Uint8Array | Uint8ClampedArray,
	S: number,
	down: 1 | 2,
): { heights: Float32Array; words: Uint32Array } {
	const out = S / down;
	const heights = new Float32Array(out * out);
	const words = new Uint32Array(5);
	const wordsF32 = new Float32Array(words.buffer);
	wordsF32[1] = wordsF32[3] = Number.POSITIVE_INFINITY;
	wordsF32[2] = wordsF32[4] = Number.NEGATIVE_INFINITY;
	const texel = (x: number, y: number) => {
		const o = (y * S + x) * 4;
		return terrariumF32(rgba[o], rgba[o + 1], rgba[o + 2]);
	};
	const bad = (h: number) => (h > VALID_MIN && h < VALID_MAX ? 0 : 1);
	for (let y = 0; y < out; y++)
		for (let x = 0; x < out; x++) {
			let h: number;
			let n: number;
			if (down === 1) {
				h = texel(x, y);
				n = bad(h);
			} else {
				const a = texel(2 * x, 2 * y);
				const b = texel(2 * x + 1, 2 * y);
				const c = texel(2 * x, 2 * y + 1);
				const d = texel(2 * x + 1, 2 * y + 1);
				n = bad(a) + bad(b) + bad(c) + bad(d);
				h = f(f(f(f(a + b) + c) + d) * 0.25);
			}
			const i = y * out + x;
			heights[i] = h;
			words[0] += n;
			wordsF32[1] = Math.min(wordsF32[1], h);
			wordsF32[2] = Math.max(wordsF32[2], h);
			if (i % 7 === 0) {
				wordsF32[3] = Math.min(wordsF32[3], h);
				wordsF32[4] = Math.max(wordsF32[4], h);
			}
		}
	return { heights, words };
}
