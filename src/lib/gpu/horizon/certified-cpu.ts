// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Certified-f32 horizon stages: the pure half (no GPU). See README.md "Certified f32" for the error
// analysis. This file holds:
// - tracked values (hi, lo, e) on the shared double-f32 emulation (../precision/df32.ts: the f32
//   machine with an exact FMA, the df32 algorithms and their budgets), whose e bounds
//   |hi + lo − F| + |f64 path − F|, F being the exact-real value of the f64 path's formula on the f64
//   path's inputs and constants;
// - the packed buffer layouts shared with the GPU (constants, per-azimuth, per-column);
// - the three stages, line for line as in the WGSL: A (tan → elevation degrees, index.ts collect),
//   B (per sample: great circle + WGS84 ENU + azimuth / elevation, the worker's D8 first half),
//   C (per column: bracket search + interpolation + unit direction, D8's second half);
// - the CPU finish: certified outputs as they are, the rest recomputed by the f64 path (the tie path).
//   The finished arrays are bit-identical to the f64 path whenever every certificate is sound.
//
// The emulation is what certified.check.ts runs over synthetic and DEM-derived cases (0 false
// certifications required). The GPU runs the same algorithm; its division and sqrt are not correctly
// rounded (WGSL: division 2.5 ULP, sqrt inherited from 1/inverseSqrt), which the bounds allow for up to
// 4 ULP (checked by ../precision/ieee-probe.ts). The f64 path's Math functions are ASSUMED to be within
// 1 ULP (ECMAScript leaves their accuracy to the implementation; V8 uses fdlibm ports).
import { DEG, EARTH_R, REFRACTION_K, WGS84 } from "#/lib/geodesy";
import {
	bits32,
	ddAdd,
	ddAddF,
	ddDiv,
	ddMul,
	ddMulF,
	ddSqrt,
	div32,
	EPS_ADD,
	EPS_DIV,
	EPS_MUL,
	EPS_SQRT,
	fastTwoSum,
	flushSubnormals,
	fr,
	fromBits32,
	ftz32,
	MIN_NORMAL32,
	nextDown32,
	nextUp32,
	split,
	sqrt32,
} from "../precision/df32";
import {
	GPU_COLUMNS,
	SkylineF64,
	type SkylineJob,
	type SkylineProfile,
} from "./dirs-cpu";

export type HorizonPrecision = "f64" | "certified-f32";

// ---------- tracked values: [hi, lo, e] ----------

/** Added to every bound: covers underflow / flush-to-zero of tiny error terms. */
export const TINY = fr(1e-36);
/** Bounds are clamped here (no inf / NaN arithmetic on the GPU, where fast math may assume none). */
export const BIG_E = fr(1e30);
const K_UP = fr(1 + 2 ** -20);
const K_DOWN = fr(1 - 2 ** -20);

export type T = [number, number, number];

/** Set when a tracked op could not bound its result (non-positive denominator / sqrt argument, guard). */
let BAD = false;

const clampE = (e: number) => (e < BIG_E ? e : BIG_E); // NaN → BIG_E too
const tNeg = (x: T): T => [-x[0], -x[1], x[2]];
function tAdd(x: T, y: T): T {
	const z = ddAdd(x[0], x[1], y[0], y[1]);
	return [
		z[0],
		z[1],
		clampE(fr(fr(fr(x[2] + y[2]) + fr(EPS_ADD * Math.abs(z[0]))) + TINY)),
	];
}
const tSub = (x: T, y: T) => tAdd(x, tNeg(y));
function tAddF(x: T, c: number): T {
	const z = ddAddF(x[0], x[1], c);
	return [
		z[0],
		z[1],
		clampE(fr(fr(x[2] + fr(EPS_ADD * Math.abs(z[0]))) + TINY)),
	];
}
function tMul(x: T, y: T): T {
	const z = ddMul(x[0], x[1], y[0], y[1]);
	const a = fr(fr(Math.abs(x[0]) * y[2]) + fr(Math.abs(y[0]) * x[2]));
	return [
		z[0],
		z[1],
		clampE(
			fr(fr(a + fr(x[2] * y[2])) + fr(fr(EPS_MUL * Math.abs(z[0])) + TINY)),
		),
	];
}
function tMulF(x: T, c: number): T {
	const z = ddMulF(x[0], x[1], c);
	return [
		z[0],
		z[1],
		clampE(
			fr(fr(Math.abs(c) * x[2]) + fr(fr(EPS_MUL * Math.abs(z[0])) + TINY)),
		),
	];
}
function tDiv(x: T, y: T): T {
	const den = fr(fr(Math.abs(y[0]) - y[2]) * K_DOWN);
	if (!(den > 0)) {
		BAD = true;
		return [0, 0, BIG_E];
	}
	const z = ddDiv(x[0], x[1], y[0], y[1]);
	const az = Math.abs(z[0]);
	const e = fr(div32(fr(x[2] + fr(az * y[2])), den) * K_UP);
	return [z[0], z[1], clampE(fr(e + fr(fr(EPS_DIV * az) + TINY)))];
}
function tSqrt(x: T): T {
	if (!(x[0] > 0)) {
		BAD = true;
		return [0, 0, BIG_E];
	}
	const z = ddSqrt(x[0], x[1]);
	const e = fr(div32(x[2], sqrt32(x[0])) * K_UP);
	return [z[0], z[1], clampE(fr(e + fr(fr(EPS_SQRT * Math.abs(z[0])) + TINY)))];
}
const tWiden = (x: T, e: number): T => [x[0], x[1], clampE(fr(x[2] + e))];

// ---------- constants (consts buffer: f32 triples hi, lo, e) ----------

/** Index of each constant triple in the consts buffer (shared with the WGSL). */
export const CI = {
	SIN_C: 0, // 5: −1/6, 1/120, −1/5040, 1/362880, −1/39916800
	OMC_C: 5, // 6: 1/2, −1/24, 1/720, −1/40320, 1/3628800, −1/479001600
	ATAN_C: 11, // 7: −1/3, 1/5, −1/7, 1/9, −1/11, 1/13, −1/15
	PI_2: 18,
	INV_DEG: 19,
	DEG: 20,
	INV_R: 21,
	A: 22,
	E2: 23,
	OME2: 24,
	ONE: 25,
	MIN_DEN: 26,
	SIN_TAB: 27, // k = −52 … 52: sin(k/32)
	COS_TAB: 132, // cos(k/32)
	ATAN_TAB: 237, // k = 0 … 32: atan(k/32)
	INV2R: 270,
	KAPPA: 271,
	SP: 272,
	CP: 273,
	EYEH: 274,
	COUNT: 275,
} as const;
export const TAB_K = 52;

/**
 * Relative bound for a constant computed in f64 (≤ 1 ULP = 2^-52 relative) and split (≤ 2^-48):
 * 17/16 u².
 */
const REL_C = 1.0625 * 2 ** -48;
/** Absolute bound for sin / cos of an f64 angle (|v| ≤ 1): 1 ULP ≤ 2^-53 plus the split. */
const trigE = (v: number) => Math.abs(v) * 2 ** -48 + 2 ** -53;

/** The fixed part of the consts buffer (series, tables, geodesy constants). */
function fixedConsts(c: Float32Array) {
	const put = (i: number, v: number, e: number) => {
		const [h, l] = split(v);
		c[3 * i] = h;
		c[3 * i + 1] = l;
		c[3 * i + 2] = fr(e);
	};
	const rel = (i: number, v: number) => put(i, v, Math.abs(v) * REL_C);
	const series: [number, number[]][] = [
		[CI.SIN_C, [-1 / 6, 1 / 120, -1 / 5040, 1 / 362880, -1 / 39916800]],
		[
			CI.OMC_C,
			[1 / 2, -1 / 24, 1 / 720, -1 / 40320, 1 / 3628800, -1 / 479001600],
		],
		[CI.ATAN_C, [-1 / 3, 1 / 5, -1 / 7, 1 / 9, -1 / 11, 1 / 13, -1 / 15]],
	];
	for (const [at, coefs] of series)
		for (let j = 0; j < coefs.length; j++) rel(at + j, coefs[j]);
	// exact π/2 (Math.PI is within 2^-53 relative)
	rel(CI.PI_2, Math.PI / 2);
	// F divides by the f64 DEG: 1/DEG in f64 is within 2^-53 relative of it
	rel(CI.INV_DEG, 1 / DEG);
	put(CI.DEG, DEG, DEG * 2 ** -48);
	rel(CI.INV_R, 1 / EARTH_R);
	put(CI.A, WGS84.A, 0); // 6378137 is an f32
	put(CI.E2, WGS84.E2, WGS84.E2 * 2 ** -48);
	// toEcef's (1 − E2) is an f64 constant of the f64 path
	put(CI.OME2, 1 - WGS84.E2, 2 ** -48);
	put(CI.ONE, 1, 0);
	put(CI.MIN_DEN, 1e-9, 1e-9 * 2 ** -48);
	for (let k = -TAB_K; k <= TAB_K; k++) {
		const s = Math.sin(k / 32);
		const c = Math.cos(k / 32);
		put(CI.SIN_TAB + k + TAB_K, s, trigE(s));
		put(CI.COS_TAB + k + TAB_K, c, trigE(c));
	}
	for (let k = 0; k <= 32; k++) rel(CI.ATAN_TAB + k, Math.atan(k / 32));
}

/** Per-call geometry for stages B / C. */
export type CertGeometry = {
	lat: number;
	lon: number;
	k: number;
	eyeH: number;
};

/** The consts buffer for one call (stage A only needs the fixed part: pass geometry null). */
export function packConsts(g: CertGeometry | null): Float32Array {
	const c = new Float32Array(CI.COUNT * 3);
	fixedConsts(c);
	if (!g) return c;
	const put = (i: number, v: number, e: number) => {
		const [h, l] = split(v);
		c[3 * i] = h;
		c[3 * i + 1] = l;
		c[3 * i + 2] = fr(e);
	};
	const inv2R = (1 - g.k) / (2 * EARTH_R); // the worker's f64 constant
	put(CI.INV2R, inv2R, Math.abs(inv2R) * 2 ** -48);
	const kappa = REFRACTION_K / (2 * EARTH_R); // F: K / (2R) exactly; f64 within 2^-52
	put(CI.KAPPA, kappa, kappa * REL_C);
	// F takes φ1 = fl(lat·DEG), the one f64 value the frame and destination() both use
	const phi = g.lat * DEG;
	put(CI.SP, Math.sin(phi), trigE(Math.sin(phi)));
	put(CI.CP, Math.cos(phi), trigE(Math.cos(phi)));
	put(CI.EYEH, g.eyeH, Math.abs(g.eyeH) * 2 ** -48);
	return c;
}

/**
 * Per azimuth (8 f32): sin a, cos a of the f64 angle destination() forms (df32, |error| ≤ trigE), a in
 * degrees (df32, |error| ≤ 2^-48·|a|).
 */
export function packAzimuths(i0: number, n: number, step: number) {
	const out = new Float32Array(n * 8);
	for (let i = 0; i < n; i++) {
		const az = (i0 + i) * step; // as the f64 path forms it
		const a = az * DEG; // destination(): azimuth * DEG
		const s = split(Math.sin(a));
		const c = split(Math.cos(a));
		const d = split(az);
		out.set([s[0], s[1], c[0], c[1], d[0], d[1]], 8 * i);
	}
	return out;
}

/**
 * Per column (8 f32): c (df32 degrees), sin(c·DEG), cos(c·DEG) (df32), floor(c / step) as an exact
 * float (a small integer; never an integer bit pattern, which would be a subnormal f32 that WGSL may
 * flush).
 */
export function packColumns(step: number, columns: readonly number[]) {
	const out = new Float32Array(columns.length * 8);
	const D = Math.PI / 180;
	for (let j = 0; j < columns.length; j++) {
		const c = columns[j];
		const cc = split(c);
		const s = split(Math.sin(c * D));
		const k = split(Math.cos(c * D));
		out.set([cc[0], cc[1], s[0], s[1], k[0], k[1]], 8 * j);
		out[8 * j + 6] = Math.floor(c / step);
	}
	return out;
}

/** Largest f32 ≤ −3e38: index.ts maps t ≤ −3e38 (no terrain) to −90°. */
export const NO_HIT_T = (() => {
	const f = fr(-3e38);
	return f <= -3e38 ? f : nextDown32(f);
})();

// ---------- f64-path lumps (README: "What the f64 path adds") ----------

const U64 = 2 ** -53;
/**
 * ENU components: absolute bound (metres) of the f64 path's own rounding (destination() + the ECEF
 * round trip of EnuFrame.fromGeo) for a frame at (lat, lon) and N ≤ 6.4e6 m, excluding the per-sample
 * height part (enuLumpRel · (|eyeH| + |h2 − eyeH| + d)) and the tan-argument part (stage B). README
 * "What the f64 path adds" derives the terms; the result carries a 1.25 safety factor.
 */
export function enuLump(lat: number, lon: number) {
	return Math.fround(ENU_Q * enuLumpCoef(lat, lon) * 1.25 * (1 + 2 ** -20));
}
/**
 * The per-metre coefficient of the ECEF / latitude / longitude terms: they scale with N + h, so the
 * per-sample part (h above the ellipsoid: |eyeH| + |h2 − eyeH| + d) uses it too, on top of the
 * 16-ULP height terms (enuLumpRel(lat, lon)).
 */
function enuLumpCoef(lat: number, lon: number) {
	const ecef = 18 * U64; // ≤ 9 ULP-equivalents per frame point (point and origin), rotated
	// φ2 is within D ≤ 1/32 rad (1.8°) of the eye's latitude (tSinSmall's guard; |lat| > 85° is refused)
	const cosLat = Math.cos(Math.min(90, Math.abs(lat) + 1.8) * DEG);
	const latE = U64 * (4.3 / cosLat + 3.6); // asin of sin φ2 (+1 ULP), /DEG, ·DEG, and 1 ULP of slack
	const lonE = U64 * (3 * Math.abs(lon * DEG) + 0.5); // the λ sum, /DEG, ·DEG
	return ecef + latE + lonE;
}
/** N + h ≥ this for the ECEF terms' base (max prime-vertical radius A²/b = 6 399 593.6 m). */
const ENU_Q = 6.4e6;
/** Certified-f32 is refused here (the latitude term grows like 1/cos φ). */
export const CERT_MAX_LAT = 85;
/** Per-metre-of-height lump coefficient (uniform lumpEnuRel). */
export function enuLumpRel(lat: number, lon: number) {
	return Math.fround(
		(16 * U64 + enuLumpCoef(lat, lon)) * 1.25 * (1 + 2 ** -20),
	);
}
/** Azimuth (degrees): atan2, /DEG, the unwrap and at()'s + 360k. */
export const AZ_LUMP = fr(1e-12);
const REL_49 = fr(2 ** -49);
const U2_17 = fr(1.0625 * 2 ** -48);
const E53 = fr(2 ** -53);
/** trigE in f32 arithmetic (rounded up), from the f32 hi part. */
const trigE32 = (h: number) => fr(fr(fr(Math.abs(h) * U2_17) + E53));
/** sin / cos of an azimuth from the az buffer: hi, lo, trigE32(hi) + FLUSH_E. */
const ldTrig = (b: Float32Array, i: number): T => {
	const h = ld(b[i]);
	return [h, ld(b[i + 1]), fr(trigE32(h) + FLUSH_E)];
};
const REL_50 = fr(2 ** -50);
const DEG32_UP = fr(DEG * (1 + 2 ** -20));
/**
 * Added to the bound of every tracked value loaded from an f32 buffer: a WGSL implementation may flush a
 * subnormal hi or lo to zero on load, moving the value by < 2^-125.
 */
const FLUSH_E = fr(2 ** -125);
/** 2^-53 and the tan-argument lump factor (README: "the e0·DEG rounding before Math.tan"). */
const U64_32 = fr(2 ** -53);
const K_LUMP = fr(1.25 * (1 + 2 ** -20));
/** A load from an f32 buffer on the emulated machine (flushed in the FTZ stress mode). */
const ld = (x: number) => (flushSubnormals() ? ftz32(x) : x);
/** A tracked value loaded from an f32 buffer: hi, lo, e (+ FLUSH_E). */
const ldT = (b: Float32Array, i: number): T => [
	ld(b[i]),
	ld(b[i + 1]),
	fr(ld(b[i + 2]) + FLUSH_E),
];
/** A df32 constant of the cols buffer (split error only): hi, lo, |hi|·17/16 u² + FLUSH_E. */
const ldCol = (b: Float32Array, i: number): T => {
	const h = ld(b[i]);
	return [h, ld(b[i + 1]), fr(fr(Math.abs(h) * U2_17) + FLUSH_E)];
};
/** Samples-buffer flags, as exact floats (never subnormal bit patterns): 0, 1 = valid, 3 = valid + uncertain. */
const sampFlags = (v: number) => (v === 0 ? 0 : v === 1 ? 1 : 3);
/** Data inputs (td, prof) are bound as u32 on the GPU: a subnormal is seen, never flushed. */
const subnormal = (x: number) => x !== 0 && Math.abs(x) < MIN_NORMAL32;

// ---------- tracked functions ----------

const TRUNC_SIN = fr(2e-28);
const TRUNC_OMC = fr(2e-29);
const TRUNC_ATAN = fr(1e-30);
/**
 * |z| guard of the atan series: |y − k/32| ≤ 1/64 exactly, plus the rounding of y·32 + 0.5 that
 * picks k (≤ 66 ULP of 1/64 at y ≤ 1), so 1/64·(1 + 2^-16).
 */
const ATAN_SMALL_MAX = fr((1 / 64) * (1 + 2 ** -16));
/** tAtan refuses |x| above this: WGSL leaves 1/x unspecified for |x| > 2^126. */
const ATAN_MAX_ARG = fr(2 ** 100);

let C: Float32Array = new Float32Array(0);
const cst = (i: number): T => ldT(C, 3 * i);

function tSinSmall(r: T): T {
	if (!(Math.abs(r[0]) <= 1 / 32)) BAD = true;
	const r2 = tMul(r, r);
	let p = cst(CI.SIN_C + 4);
	for (let j = 3; j >= 0; j--) p = tAdd(cst(CI.SIN_C + j), tMul(r2, p));
	const s = tAdd(r, tMul(r, tMul(r2, p)));
	// truncation |r|^13 / 13! ≤ |r|·(1/32)^12 / 13! < |r|·2e-28 (|r| ≤ |hi| + e)
	return tWiden(s, fr(fr(fr(Math.abs(r[0]) + r[2]) * TRUNC_SIN) + TINY));
}
function tOmcSmall(r: T): T {
	if (!(Math.abs(r[0]) <= 1 / 32)) BAD = true;
	const r2 = tMul(r, r);
	let p = cst(CI.OMC_C + 5);
	for (let j = 4; j >= 0; j--) p = tAdd(cst(CI.OMC_C + j), tMul(r2, p));
	// truncation r^14 / 14! ≤ r²·(1/32)^12 / 14! < r²·2e-29
	const ar = fr(Math.abs(r[0]) + r[2]);
	return tWiden(tMul(r2, p), fr(fr(fr(ar * ar) * TRUNC_OMC) + TINY));
}
function tAtanSmall(z: T): T {
	if (!(Math.abs(z[0]) <= ATAN_SMALL_MAX)) BAD = true;
	const z2 = tMul(z, z);
	let p = cst(CI.ATAN_C + 6);
	for (let j = 5; j >= 0; j--) p = tAdd(cst(CI.ATAN_C + j), tMul(z2, p));
	const a = tAdd(z, tMul(z, tMul(z2, p)));
	// truncation |z|^17 / 17 ≤ |z|·(1/64·(1 + 2^-16))^16 / 17 < |z|·7.5e-31 ≤ |z|·TRUNC_ATAN
	return tWiden(a, fr(fr(fr(Math.abs(z[0]) + z[2]) * TRUNC_ATAN) + TINY));
}
/** [sin x, cos x] for |x| ≤ 1.6: table at k/32 plus the small-argument series. */
function tSinCos(x: T): [T, T] {
	const k = Math.floor(fr(fr(x[0] * 32) + 0.5));
	if (!(Math.abs(k) <= TAB_K)) {
		BAD = true;
		return [
			[0, 0, BIG_E],
			[0, 0, BIG_E],
		];
	}
	const r = tAddF(x, fr(-k / 32));
	const S = cst(CI.SIN_TAB + k + TAB_K);
	const K = cst(CI.COS_TAB + k + TAB_K);
	const s = tSinSmall(r);
	const o = tOmcSmall(r);
	const sin = tAdd(tSub(S, tMul(S, o)), tMul(K, s));
	const cos = tSub(tSub(K, tMul(K, o)), tMul(S, s));
	return [sin, cos];
}
/** atan x (radians), any finite x. */
function tAtan(x: T): T {
	if (!(Math.abs(x[0]) <= ATAN_MAX_ARG)) {
		BAD = true;
		return [0, 0, BIG_E];
	}
	const neg = x[0] < 0;
	const ax = neg ? tNeg(x) : x;
	const inv = ax[0] > 1;
	const y = inv ? tDiv(cst(CI.ONE), ax) : ax;
	const k = Math.floor(fr(fr(y[0] * 32) + 0.5));
	if (!(k >= 0 && k <= 32)) {
		BAD = true;
		return [0, 0, BIG_E];
	}
	const c = fr(k / 32);
	const num = tAddF(y, -c);
	const den = tAddF(tMulF(y, c), 1);
	const z = tDiv(num, den);
	let a = tAdd(cst(CI.ATAN_TAB + k), tAtanSmall(z));
	if (inv) a = tSub(cst(CI.PI_2), a);
	return neg ? tNeg(a) : a;
}

// ---------- certification ----------

/** Bound inflation for the rounding of the bound arithmetic itself (README). */
const K_CERT = fr(1 + 2 ** -10);
const K_SGN = fr(1 - 2 ** -22);
const A_MIN = fr(1e-30);
const A_MAX = fr(1e37);
const ULP_FRAC = 2 ** -20;

/**
 * f32 bits of RN32(v) for every v within e of hi + lo, or −1 when that is not one value (or the
 * neighbourhood is too close to 0 / not finite to argue about).
 */
export function certify(x: T, scale = 1): number {
	if (fault) {
		const f = fastTwoSum(x[0], fr(x[1] + fr(x[0] * fault)));
		x = [f[0], f[1], x[2]];
	}
	const r = fr(x[0] + x[1]);
	const a = Math.abs(r);
	if (!(a >= A_MIN && a <= A_MAX) || BAD) return -1;
	const delta = fr(fr(x[0] - r) + x[1]);
	const up = fr(nextUp32(a) - a);
	const dn = fr(a - nextDown32(a));
	const half = fr(0.5 * Math.min(up, dn));
	const margin = fr(fr(fr(x[2] * K_CERT) * scale) + fr(half * ULP_FRAC));
	return fr(Math.abs(delta) + margin) < half ? bits32(r) : -1;
}
/** +1 / −1 when hi + lo ± e is certainly > 0 / < 0, else 0. */
function sgn(x: T, scale = 1): number {
	const m = fr(fr(x[2] * K_CERT) * scale);
	if (x[0] > 0 && fr(x[0] * K_SGN) > m) return 1;
	if (x[0] < 0 && fr(-x[0] * K_SGN) > m) return -1;
	return 0;
}

/** Test hook: scales every bound at decision time. */
let boundScale = 1;
export function setBoundScale(s: number) {
	boundScale = s;
}
/**
 * Test hook: every certified value is moved by this relative error that its bound does not cover (a
 * broken GPU). The check must then see false certifications.
 */
let fault = 0;
export function setFaultInjection(rel: number) {
	fault = rel;
}

/** Why stage C sent columns to the tie path (diagnostics; reset with resetTieStats). */
export const tieStats = { bracket: 0, minDen: 0, out: [0, 0, 0], sampleBad: 0 };
export function resetTieStats() {
	tieStats.bracket = 0;
	tieStats.minDen = 0;
	tieStats.out = [0, 0, 0];
	tieStats.sampleBad = 0;
}

// ---------- stage A: t → elevation degrees ----------

export const FLAG_CERT = 1;
export const FLAG_SKIP = 2;

/** out[2i] = f32 bits of the elevation, out[2i+1] = FLAG_CERT when certified. */
export function emuStageA(td: Float32Array, n: number): Uint32Array {
	C = packConsts(null);
	const out = new Uint32Array(n * 2);
	const m90 = bits32(-90);
	for (let i = 0; i < n; i++) {
		const t = td[2 * i]; // bound as u32 on the GPU: exact bits
		if (!Number.isFinite(t)) continue; // NaN / ±inf: the f64 path decides
		if (subnormal(t)) continue; // a flushing machine would see 0: the f64 path decides
		if (t <= NO_HIT_T) {
			out[2 * i] = m90;
			out[2 * i + 1] = FLAG_CERT;
			continue;
		}
		if (t === 0) {
			// atan(±0) / DEG = ±0 exactly
			out[2 * i] = bits32(t);
			out[2 * i + 1] = FLAG_CERT;
			continue;
		}
		BAD = false;
		const v = tMul(tAtan([t, 0, 0]), cst(CI.INV_DEG));
		const b = certify(tWiden(v, fr(Math.abs(v[0]) * REL_49)), boundScale);
		if (b >= 0) {
			out[2 * i] = b;
			out[2 * i + 1] = FLAG_CERT;
		}
	}
	return out;
}

/** The f64 path of stage A (index.ts collect), for one sample. */
export const elevationF64 = (t: number) =>
	t <= -3e38 ? -90 : Math.atan(t) / DEG;

/** Certified bits as they are, the rest by the f64 path. */
export function finishStageA(td: Float32Array, outA: Uint32Array, n: number) {
	const el = new Float32Array(n);
	let ties = 0;
	for (let i = 0; i < n; i++) {
		if (outA[2 * i + 1] & FLAG_CERT) el[i] = fromBits32(outA[2 * i]);
		else {
			el[i] = elevationF64(td[2 * i]);
			ties++;
		}
	}
	return { elevation: el, ties };
}

// ---------- stage B: per sample ENU azimuth / elevation ----------

/** Samples buffer: 8 words per sample: δaz (df32 deg + e), el (df32 deg + e), flags, 0. */
export const SAMP_VALID = 1;
export const SAMP_UNCERTAIN = 2;

/** Lump constants for stage B, in the uniform. */
export function stageBUniform(g: CertGeometry) {
	return {
		lumpEnu: enuLump(g.lat, g.lon),
		lumpEnuRel: enuLumpRel(g.lat, g.lon),
	};
}

/** prof: (e0, d) f32 pairs; az: packAzimuths; consts: packConsts(g). */
export function emuStageB(
	prof: Float32Array,
	az: Float32Array,
	consts: Float32Array,
	n: number,
	lumpEnu: number,
	lumpEnuRel: number,
): Float32Array {
	const samp = new Float32Array(n * 8);
	for (let i = 0; i < n; i++)
		emuSampleB(samp, i, prof, az, consts, lumpEnu, lumpEnuRel);
	return samp;
}

/** Stage B for one sample, into samp[8i…8i+7] (the per-call spot check computes only what it needs). */
export function emuSampleB(
	samp: Float32Array,
	i: number,
	prof: Float32Array,
	az: Float32Array,
	consts: Float32Array,
	lumpEnu: number,
	lumpEnuRel: number,
) {
	C = consts;
	// prof is bound as u32 on the GPU: e0, d are exact bits (validity decided on them, never flushed)
	const e0 = prof[2 * i];
	const d = prof[2 * i + 1];
	samp.fill(0, 8 * i, 8 * i + 8);
	if (!(e0 > -90) || !(d > 0)) return; // invalid: δ = 0, flags 0 (certain)
	BAD =
		!(Number.isFinite(e0) && Number.isFinite(d)) ||
		subnormal(e0) ||
		subnormal(d);
	const r = sampleB(e0, d, az, i, lumpEnu, lumpEnuRel);
	samp.set(r, 8 * i);
	samp[8 * i + 6] = BAD ? 3 : 1;
}

function sampleB(
	e0: number,
	d: number,
	az: Float32Array,
	i: number,
	lumpEnu: number,
	lumpEnuRel: number,
): number[] {
	const theta = tMulF(cst(CI.DEG), e0);
	const [sn, cs] = tSinCos(theta);
	const tanE = tDiv(sn, cs);
	const hD = tMulF(tAdd(tanE, tMulF(cst(CI.INV2R), d)), d);
	const eyeH = cst(CI.EYEH);
	const h2 = tAdd(eyeH, hD);
	const D = tMulF(cst(CI.INV_R), d);
	const sD = tSinSmall(D);
	const omc = tOmcSmall(D);
	const sA = ldTrig(az, 8 * i);
	const cA = ldTrig(az, 8 * i + 2);
	const sP = cst(CI.SP);
	const cP = cst(CI.CP);
	// sinφ2 − sinφ1 and the great circle's Δλ, in difference form (no cancellation)
	const ds = tSub(tMul(tMul(cP, sD), cA), tMul(sP, omc));
	const s2 = tAdd(sP, ds);
	const Y = tMul(tMul(sA, sD), cP);
	const X = tSub(tSub(tMul(cP, cP), omc), tMul(sP, ds));
	const rhoL = tSqrt(tAdd(tMul(X, X), tMul(Y, Y)));
	const sinDL = tDiv(Y, rhoL);
	const omcDL = tDiv(tMul(Y, Y), tMul(rhoL, tAdd(rhoL, X)));
	// cos φ2 and cos φ2 − cos φ1
	const c2 = tSqrt(tMul(tAddF(tNeg(s2), 1), tAddF(s2, 1)));
	const sPs2 = tAdd(s2, sP);
	const dc = tNeg(tDiv(tMul(ds, sPs2), tAdd(c2, cP)));
	// prime-vertical radii N = A / √(1 − E2 sin²φ) and N2 − N1
	const E2 = cst(CI.E2);
	const rwo = tSqrt(tAddF(tNeg(tMul(E2, tMul(sP, sP))), 1));
	const rw2 = tSqrt(tAddF(tNeg(tMul(E2, tMul(s2, s2))), 1));
	const A = cst(CI.A);
	const No = tDiv(A, rwo);
	const dN = tDiv(
		tMul(tMul(tMul(A, E2), ds), sPs2),
		tMul(tMul(rw2, rwo), tAdd(rwo, rw2)),
	);
	// ECEF difference rotated into the eye's ENU frame (λ cancels)
	const dNh = tAdd(dN, h2);
	const Q2c2 = tMul(tAdd(No, dNh), c2); // (N2 + h2)·cos φ2
	const P = tSub(tAdd(tMul(dNh, c2), tMul(No, dc)), tMul(Q2c2, omcDL));
	const ome2 = cst(CI.OME2);
	const Zd = tAdd(tMul(tAdd(tMul(dN, ome2), h2), s2), tMul(tMul(No, ome2), ds));
	// Math.tan(fl(e0·DEG)): the argument's rounding (1 + tan²)|θ|·2^-53 and tan's ULP, times d
	const ta = Math.abs(tanE[0]);
	const tanLump = fr(
		fr(
			fr(d * U64_32) *
				fr(fr(Math.abs(theta[0]) * fr(1 + fr(ta * ta))) + fr(2 * ta)),
		) * K_LUMP,
	);
	const lump = fr(
		fr(
			lumpEnu +
				fr(lumpEnuRel * fr(fr(Math.abs(eyeH[0]) + Math.abs(hD[0])) + d)),
		) + tanLump,
	);
	const E = tWiden(tMul(Q2c2, sinDL), lump);
	const Nn = tWiden(tAdd(tNeg(tMul(sP, P)), tMul(cP, Zd)), lump);
	const Uu = tAdd(tMul(cP, P), tMul(sP, Zd));
	const d2 = tAdd(tMul(E, E), tMul(Nn, Nn));
	const z = tWiden(tSub(tAdd(Uu, tMul(cst(CI.KAPPA), d2)), eyeH), lump);
	const rho = tSqrt(d2);
	let el = tMul(tAtan(tDiv(z, rho)), cst(CI.INV_DEG));
	el = tWiden(el, fr(fr(Math.abs(el[0]) * REL_49) + TINY));
	// azimuth relative to the march azimuth: (e, n) rotated by −a
	const eR = tSub(tMul(E, cA), tMul(Nn, sA));
	const nR = tAdd(tMul(Nn, cA), tMul(E, sA));
	if (!(fr(nR[0] - nR[2]) > 0 && Math.abs(eR[0]) < nR[0])) BAD = true;
	let dl = tMul(tAtan(tDiv(eR, nR)), cst(CI.INV_DEG));
	dl = tWiden(dl, AZ_LUMP);
	return [dl[0], dl[1], dl[2], el[0], el[1], el[2]];
}

// ---------- stage C: per column ----------

/**
 * outC[4j..4j+2] = f32 bits of the column's direction, outC[4j+3] = FLAG_CERT (| FLAG_SKIP when the
 * f64 path skips the column), 0 when uncertain.
 */
export function emuStageC(
	samp: Float32Array,
	az: Float32Array,
	cols: Float32Array,
	consts: Float32Array,
	n: number,
	nCols: number,
	/** spot check: only these columns, computing samples on demand (ensure(m) before samp[m] is read) */
	only?: { columns: number[]; ensure: (m: number) => void },
): Uint32Array {
	C = consts;
	const out = new Uint32Array(nCols * 4);
	const sflag = (m: number) => {
		only?.ensure(m);
		return sampFlags(ld(samp[8 * m + 6]));
	};
	for (const j of only?.columns ?? Array.from({ length: nCols }, (_, q) => q)) {
		C = consts;
		BAD = false;
		const cv = ldT(cols, 8 * j);
		cv[2] = fr(fr(Math.abs(cv[0]) * U2_17) + FLUSH_E);
		const negC = tNeg(cv);
		const diffAt = (m: number): T => {
			const k = Math.floor(m / n);
			const mm = m - k * n;
			if (sflag(mm) & SAMP_UNCERTAIN) BAD = true;
			C = consts;
			const ah = ld(az[8 * mm + 4]);
			const a: T = [
				ah,
				ld(az[8 * mm + 5]),
				fr(fr(Math.abs(ah) * U2_17) + FLUSH_E),
			];
			let base = tAdd(a, negC);
			if (k !== 0) base = tAddF(base, 360 * k);
			return tAdd(base, ldT(samp, 8 * mm));
		};
		let i = ld(cols[8 * j + 6]);
		let ok = false;
		for (let it = 0; it < 16; it++) {
			const s = sgn(diffAt(i), boundScale);
			if (s > 0) i--;
			else {
				ok = s < 0;
				break;
			}
		}
		if (ok) {
			ok = false;
			for (let it = 0; it < 16; it++) {
				const s = sgn(diffAt(i + 1), boundScale);
				if (s < 0) i++;
				else {
					ok = s > 0;
					break;
				}
			}
		}
		if (!ok || BAD) {
			if (BAD) tieStats.sampleBad++;
			else tieStats.bracket++;
			continue;
		}
		const j0 = i - Math.floor(i / n) * n;
		const j1 = i + 1 - Math.floor((i + 1) / n) * n;
		if (!(sflag(j0) & SAMP_VALID) || !(sflag(j1) & SAMP_VALID)) {
			out[4 * j + 3] = FLAG_CERT | FLAG_SKIP;
			continue;
		}
		const r = columnC(diffAt(i), diffAt(i + 1), samp, j0, j1, cols, j);
		if (r && !BAD) {
			out.set(r, 4 * j);
			out[4 * j + 3] = FLAG_CERT;
		}
	}
	return out;
}

function columnC(
	dA: T,
	dB: T,
	samp: Float32Array,
	j0: number,
	j1: number,
	cols: Float32Array,
	j: number,
): number[] | null {
	const den0 = tSub(dB, dA);
	const md = cst(CI.MIN_DEN);
	let den: T;
	const m = fr(den0[2] * K_CERT);
	if (fr(den0[0] - m) > fr(md[0] * K_UP)) den = den0;
	else if (fr(den0[0] + m) < fr(md[0] * K_DOWN)) den = md;
	else {
		tieStats.minDen++;
		return null;
	}
	const tq = tDiv(tNeg(dA), den);
	let t: T = tq;
	if (tq[0] < 0 || (tq[0] === 0 && tq[1] < 0)) t = [0, 0, tq[2]];
	else if (tq[0] > 1 || (tq[0] === 1 && tq[1] > 0)) t = [1, 0, tq[2]];
	t = tWiden(t, REL_49);
	const E0 = ldT(samp, 8 * j0 + 3);
	const E1 = ldT(samp, 8 * j1 + 3);
	const eDeg = tAdd(E0, tMul(tSub(E1, E0), t));
	const eRad = tWiden(
		tMul(eDeg, cst(CI.DEG)),
		fr(fr(fr(Math.abs(E0[0]) + Math.abs(E1[0])) * DEG32_UP) * REL_49),
	);
	const [s, c] = tSinCos(eRad);
	const Sc = ldCol(cols, 8 * j + 2);
	const Cc = ldCol(cols, 8 * j + 4);
	const outs = [tMul(Sc, c), tMul(Cc, c), s];
	const r: number[] = [];
	for (let q = 0; q < 3; q++) {
		const o = outs[q];
		const b = certify(
			tWiden(o, fr(fr(Math.abs(o[0]) * REL_50) + TINY)),
			boundScale,
		);
		if (b < 0) {
			tieStats.out[q]++;
			return null;
		}
		r.push(b);
	}
	return r;
}

/** Certified columns as they are, the rest (and their skip decision) by the f64 path. */
export function finishStageC(
	prof: SkylineProfile,
	job: SkylineJob,
	eyeH: number,
	outC: Uint32Array,
	columns: readonly number[] = GPU_COLUMNS,
) {
	const out = new Float32Array(columns.length * 3);
	let k = 0;
	let ties = 0;
	let sky: SkylineF64 | null = null;
	for (let j = 0; j < columns.length; j++) {
		const f = outC[4 * j + 3];
		if (f & FLAG_CERT) {
			if (f & FLAG_SKIP) continue;
			out[k] = fromBits32(outC[4 * j]);
			out[k + 1] = fromBits32(outC[4 * j + 1]);
			out[k + 2] = fromBits32(outC[4 * j + 2]);
			k += 3;
		} else {
			ties++;
			sky ??= new SkylineF64(prof, job, eyeH);
			if (sky.column(columns[j], out, k)) k += 3;
		}
	}
	return { dirs: out.slice(0, k), ties };
}

/** (e0, d) pairs of a profile, the stage-B input. */
export function packProfile(prof: SkylineProfile) {
	const n = prof.elevation.length;
	const out = new Float32Array(n * 2);
	for (let i = 0; i < n; i++) {
		out[2 * i] = prof.elevation[i];
		out[2 * i + 1] = prof.distance[i];
	}
	return out;
}

/** The whole certified D8 stage on the CPU emulation (the node check's subject). */
export function emuSkylineDirs(
	prof: SkylineProfile,
	job: SkylineJob,
	eyeH: number,
) {
	const n = prof.elevation.length;
	const g = { lat: job.lat, lon: job.lon, k: job.k, eyeH };
	const consts = packConsts(g);
	const az = packAzimuths(prof.i0, n, prof.step);
	const samp = emuStageB(
		packProfile(prof),
		az,
		consts,
		n,
		enuLump(job.lat, job.lon),
		enuLumpRel(job.lat, job.lon),
	);
	const cols = packColumns(prof.step, GPU_COLUMNS);
	const outC = emuStageC(samp, az, cols, consts, n, GPU_COLUMNS.length);
	return { outC, samp, ...finishStageC(prof, job, eyeH, outC) };
}

/** Every f32 constant the WGSL uses, by name (certified.wgsl.ts embeds their exact bits). */
export const F32C: Record<string, number> = {
	EPS_ADD: fr(EPS_ADD),
	EPS_MUL: fr(EPS_MUL),
	EPS_DIV: fr(EPS_DIV),
	EPS_SQRT: fr(EPS_SQRT),
	TINY,
	BIG_E,
	K_UP,
	K_DOWN,
	K_CERT,
	K_SGN,
	A_MIN,
	A_MAX,
	ULP_FRAC: fr(ULP_FRAC),
	REL_49,
	REL_50,
	U2_17,
	E53,
	DEG32_UP,
	TRUNC_SIN,
	TRUNC_OMC,
	TRUNC_ATAN,
	AZ_LUMP,
	FLUSH_E,
	U64_32,
	K_LUMP,
	ATAN_SMALL_MAX,
	ATAN_MAX_ARG,
	MIN_NORMAL: fr(MIN_NORMAL32),
};
