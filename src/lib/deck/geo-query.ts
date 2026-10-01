// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU-side decision logic for the geometry point queries that the WebGPU engine answers from the
// geometry target on the GPU instead of reading the whole 1024 px rgba32float target back
// (deck-webgpu/geo-query-gpu.ts has the kernels; scripts/gpu/geo-query-check.ts emulates them).
//
// 1. Peak-label occlusion (deck-webgpu/engine.ts peakLabels). The CPU test, per in-frame peak with
//    projection pr = (u, v, range) from the f64 camera:
//      visible = false
//      for dv of [0.004, 0.009]:
//        x = floor(u·w), y = floor((v + dv)·h)                                  (f64)
//        s = sampleAt: null when (x, y) is outside the buffer (NaN included) or the texel's range
//            r = (w channel > 0 ? w : +Inf) is not a finite positive number; else s.range = r
//        if s is null or r > pr.range·0.97 − 50: visible = true
//    Exactness argument. (a) x, y, the bounds test and the threshold T = pr.range·0.97 − 50 are
//    computed here, in f64, by the CPU's own expressions; the GPU only receives integers and one
//    f32. (b) The texel's range r is an f32, so r > T (T an f64) is equivalent to r > a with
//    a = the largest f32 ≤ T: r is an f32 > T ≥ a, so r > a; conversely r > a means r ≥ next(a) > T
//    because next(a) is the smallest f32 above a and a is the largest ≤ T. A single raw f32
//    compare is therefore exact (no margin needed), and `a` is clamped to ±f32max so no Inf / NaN
//    ever reaches the shader (r > f32max is false for every finite r, r > −f32max true for every
//    positive one, matching the unclamped answers). (c) The texel is classified from its raw bits:
//    sign set / zero / Inf / NaN → "not terrain" → visible (CPU: not > 0, or not finite);
//    positive denormal → UNDECIDED (a GPU may flush it to zero, which would change the answer);
//    positive normal → f32 compare against a. (d) UNDECIDED samples (practically never: the
//    geometry pass writes ranges ≥ the 1 m near plane, sky = 0) are resolved on the CPU from the
//    texel itself, read back by the gather kernel (bit copy), with the CPU's own f64 expression
//    `r > T`. A peak is visible when any sample is visible (OR), hidden when both are hidden, and
//    undecided only if no sample is visible and one is undecided: the same OR as the CPU loop.
//
// 2. Skyline per column (look/labels skylineAt over the range buffer, rows top-down): the first row t
//    whose range is finite and > 0, out[c] = t / h (stored to a Float32Array), 1 when none. The
//    kernel returns the integer t per column (h when none) from the raw bits; t / h is evaluated
//    here with the same expression and the same f32 store, so the output is identical. A column
//    containing a positive denormal before its first normal terrain texel is flagged, and then the
//    whole skyline is taken from the full readback (never happens with real geometry).

export const OCC_DVS = [0.004, 0.009] as const;
export const OCC_RANGE_K = 0.97;
export const OCC_RANGE_MIN = 50;
/** Words per peak in the verdict kernel's input: x0 y0 x1 y1 thr(f32 bits) pad. */
export const OCC_STRIDE = 6;
/** Per-sample states in a verdict word's low bits (2 bits each). */
export const OCC_HIDDEN = 0;
export const OCC_VISIBLE = 1;
export const OCC_UNDECIDED = 2;

const F32_MAX = 3.4028234663852886e38;
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function f32Bits(x: number): number {
	f32[0] = x;
	return u32[0];
}
export function bitsF32(b: number): number {
	u32[0] = b >>> 0;
	return f32[0];
}

/** The largest float32 ≤ x (x finite or ±Inf; NaN → NaN). */
export function f32Floor(x: number): number {
	if (Number.isNaN(x)) return x;
	const a = Math.fround(x);
	if (a <= x) return a;
	// a rounded up: step one float32 down
	if (a === Number.POSITIVE_INFINITY) return F32_MAX;
	if (a === 0) return bitsF32(0x80000001);
	const b = f32Bits(a);
	return bitsF32(a > 0 ? b - 1 : b + 1);
}

/** The CPU test's f64 threshold: r > T ⇒ the peak is in front of the terrain. */
export const occThreshold = (peakRange: number) =>
	peakRange * OCC_RANGE_K - OCC_RANGE_MIN;

/** T as the finite f32 `a` the shader compares against (see the header, point 1b). */
export function occThresholdF32(T: number): number {
	if (Number.isNaN(T)) return F32_MAX;
	const a = f32Floor(T);
	return Math.min(F32_MAX, Math.max(-F32_MAX, a));
}

/** Buffer index of normalised photo coords, as sampleAt computes it (null = outside, NaN included). */
export function texelOf(u: number, v: number, w: number, h: number) {
	const x = Math.floor(u * w);
	const y = Math.floor(v * h);
	if (!(x >= 0 && y >= 0 && x < w && y < h)) return null;
	return { x, y };
}

/**
 * The CPU reference of one sample: the visible flag of `range` (the buffer's w channel at the
 * texel, raw: 0 = sky) against the peak range. Mirrors sampleAt's null rules + the engine's compare.
 */
export function sampleVisible(wChannel: number, peakRange: number): boolean {
	const r = wChannel > 0 ? wChannel : Number.POSITIVE_INFINITY;
	if (!(r > 0) || !Number.isFinite(r)) return true;
	return r > occThreshold(peakRange);
}

/** The whole CPU test of one peak (the engine's original loop), for `texel(x, y)` = w channel. */
export function cpuOcclusion(
	pr: { u: number; v: number; range: number },
	w: number,
	h: number,
	texel: (x: number, y: number) => number,
): boolean {
	let visible = false;
	for (const dv of OCC_DVS) {
		const t = texelOf(pr.u, pr.v + dv, w, h);
		if (!t || sampleVisible(texel(t.x, t.y), pr.range)) visible = true;
	}
	return visible;
}

/** What the GPU pass decides about one sample, from the raw bits of the texel's w channel. */
export function sampleState(bits: number, a: number): number {
	const b = bits >>> 0;
	const e = (b >>> 23) & 0xff;
	const m = b & 0x7fffff;
	if (b & 0x80000000 || (e === 0 && m === 0) || e === 0xff) return OCC_VISIBLE;
	if (e === 0) return OCC_UNDECIDED;
	return Math.fround(bitsF32(b)) > a ? OCC_VISIBLE : OCC_HIDDEN;
}

export type OccPlan = {
	/** per input peak: true / false when the CPU decided it here (an outside sample), null = on the GPU */
	decided: (boolean | null)[];
	/** the verdict kernel's input (OCC_STRIDE words per GPU peak) */
	words: Uint32Array;
	/** GPU slot → input peak */
	slots: number[];
	/** per GPU slot: [x0, y0, x1, y1, T] for resolving undecided samples */
	detail: { xy: number[]; T: number }[];
};

/** Splits peaks into CPU-decided (outside the buffer) and GPU-tested. `null` entries are skipped. */
export function planOcclusion(
	peaks: ({ u: number; v: number; range: number } | null)[],
	w: number,
	h: number,
): OccPlan {
	const decided: (boolean | null)[] = [];
	const slots: number[] = [];
	const detail: OccPlan["detail"] = [];
	const rows: number[][] = [];
	peaks.forEach((pr, i) => {
		decided.push(null);
		if (!pr) return;
		const xy: number[] = [];
		for (const dv of OCC_DVS) {
			const t = texelOf(pr.u, pr.v + dv, w, h);
			if (!t) {
				decided[i] = true;
				return;
			}
			xy.push(t.x, t.y);
		}
		const T = occThreshold(pr.range);
		slots.push(i);
		detail.push({ xy, T });
		rows.push([...xy, f32Bits(occThresholdF32(T)), 0]);
	});
	const words = new Uint32Array(rows.length * OCC_STRIDE);
	rows.forEach((r, i) => {
		words.set(r, i * OCC_STRIDE);
	});
	return { decided, words, slots, detail };
}

/**
 * Combines the kernel's verdict words into per-peak booleans. `resolve(xy)` returns the raw w
 * channels of the requested texels (the gather kernel), null = failed (the caller falls back).
 */
export async function resolveOcclusion(
	plan: OccPlan,
	codes: ArrayLike<number>,
	resolve: (xy: number[]) => Promise<Float32Array | null>,
): Promise<(boolean | null)[] | null> {
	const out = plan.decided.slice();
	const need: { slot: number }[] = [];
	for (let s = 0; s < plan.slots.length; s++) {
		const c = codes[s];
		const st = [c & 3, (c >> 2) & 3];
		if (st.includes(OCC_VISIBLE)) out[plan.slots[s]] = true;
		else if (st.includes(OCC_UNDECIDED)) need.push({ slot: s });
		else out[plan.slots[s]] = false;
	}
	if (!need.length) return out;
	// both samples of an undecided peak are fetched (one may be visible)
	const xy: number[] = [];
	for (const n of need) xy.push(...plan.detail[n.slot].xy);
	const texels = await resolve(xy);
	if (!texels) return null;
	need.forEach((n, j) => {
		const d = plan.detail[n.slot];
		let visible = false;
		for (let k = 0; k < 2; k++) {
			const r = texels[(j * 2 + k) * 4 + 3];
			const r64 = r > 0 ? r : Number.POSITIVE_INFINITY;
			if (!(r64 > 0) || !Number.isFinite(r64) || r64 > d.T) visible = true;
		}
		out[plan.slots[n.slot]] = visible;
	});
	return out;
}

/** The skyline (fraction of the height from the top, 1 = no terrain) from the kernel's rows. */
export function skylineFromRows(
	rows: ArrayLike<number>,
	h: number,
): Float32Array {
	const out = new Float32Array(rows.length).fill(1);
	for (let c = 0; c < rows.length; c++) if (rows[c] < h) out[c] = rows[c] / h;
	return out;
}
