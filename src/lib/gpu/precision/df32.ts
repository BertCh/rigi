// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Double-f32 arithmetic for certified-f32 GPU stages (precision decision P1), shared by every stage
// that certifies f32 GPU results against an f64 CPU path (horizon today, align next). Two halves that
// must stay in step:
// - TypeScript: an emulation of the f32 machine the WGSL runs on (Math.fround; an exact fused
//   multiply-add; division / sqrt correctly rounded, or perturbed by up to ±k ULP for stress tests)
//   and the double-f32 ("df32": an unevaluated sum hi + lo of two f32) algorithms on top of it. Node
//   checks run a stage's emulation to prove its certificate never certifies a wrong answer.
// - DF32_WGSL: the same algorithms in WGSL. Every intermediate of an error-free transformation goes
//   through opq(), an xor with the private ZERO the kernel loads from a uniform that is always 0, so a
//   fast-math compiler (Metal) cannot re-associate the error terms away. A kernel declares nothing
//   extra; it sets `ZERO = u.zero;` first thing.
//
// Error budgets (EPS_*) are relative bounds per operation on exact df32 inputs, each at least the proven
// bound of its algorithm (Joldes, Muller, Popescu, "Tight and rigorous error bounds for basic building
// blocks of double-word arithmetic", ACM TOMS 44(2), 2017; ddDiv / ddSqrt: src/lib/gpu/horizon/README.md
// "Arithmetic"). They hold only on a device that passes the strict-IEEE probe (./ieee-probe.ts):
// correctly rounded add / sub / mul, fused fma, division and sqrt within 4 ULP, no re-association.

// ---------- the f32 machine ----------

const fround = Math.fround;
/** Smallest normal f32. */
export const MIN_NORMAL32 = 2 ** -126;
/** Flush-to-zero of an f32 value (keeps the sign of zero). */
export const ftz32 = (x: number) =>
	x !== 0 && Math.abs(x) < MIN_NORMAL32 ? (x < 0 ? -0 : 0) : x;
const fround_ftz = (x: number) => ftz32(fround(x));
/**
 * One f32 rounding of the emulated machine. With setFlushSubnormals(true) every result that would be
 * subnormal is flushed to ±0, as WGSL allows (a live binding: importers see the switch).
 */
export let fr: (x: number) => number = fround;
let flushing = false;
/** Stress mode: the emulated machine flushes subnormal results (and its callers flush their loads). */
export function setFlushSubnormals(on: boolean) {
	flushing = on;
	fr = on ? fround_ftz : fround;
}
export const flushSubnormals = () => flushing;
const view = new DataView(new ArrayBuffer(4));
export function bits32(x: number): number {
	view.setFloat32(0, x);
	return view.getUint32(0);
}
export function fromBits32(b: number): number {
	view.setUint32(0, b >>> 0);
	return view.getFloat32(0);
}
export function nextUp32(x: number): number {
	if (x === 0) return fromBits32(1);
	const b = bits32(x);
	return fromBits32(x > 0 ? b + 1 : b - 1);
}
export const nextDown32 = (x: number) => -nextUp32(-x);

/** RN32(a·b + c) for f32 a, b, c: the exact product is an f64, the f64 sum's error decides f32 ties. */
export function fma32(a: number, b: number, c: number): number {
	const r = fmaRN(a, b, c);
	return flushing ? ftz32(r) : r;
}
function fmaRN(a: number, b: number, c: number): number {
	const p = a * b; // 24 + 24 bits: exact in f64
	const s = p + c;
	if (!Number.isFinite(s)) return fround(s);
	const bb = s - p;
	const err = p - (s - bb) + (c - bb); // TwoSum: s + err === p + c exactly
	const r = fround(s);
	if (err === 0 || r === s) return r;
	// s + err rounds like s unless s sits exactly on an f32 midpoint (|err| < half an f64 ulp of s)
	const other = r > s ? nextDown32(r) : nextUp32(r);
	if ((r + other) / 2 !== s) return r;
	return err > 0 ? Math.max(r, other) : Math.min(r, other);
}

let perturbUlps = 0;
let perturbRandom: () => number = Math.random;
/**
 * Stress mode for the check: every emulated division and sqrt is moved by a random 0…±ulps ULP (WGSL
 * allows 2.5 ULP for division and ~4.5 for sqrt; the bounds assume ≤ 4). 0 = correctly rounded.
 */
export function setDivSqrtPerturbation(ulps: number, random = Math.random) {
	perturbUlps = ulps;
	perturbRandom = random;
}
/** Runs fn with correctly rounded division / sqrt (the probe verifier's reference). */
export function withExactDivSqrt<R>(fn: () => R): R {
	const saved = perturbUlps;
	perturbUlps = 0;
	try {
		return fn();
	} finally {
		perturbUlps = saved;
	}
}
function perturb(r: number): number {
	if (!perturbUlps || !Number.isFinite(r) || r === 0) return r;
	let k = Math.floor(perturbRandom() * (2 * perturbUlps + 1)) - perturbUlps;
	while (k > 0) {
		r = nextUp32(r);
		k--;
	}
	while (k < 0) {
		r = nextDown32(r);
		k++;
	}
	return r;
}
/** f32 division / sqrt of the emulated machine (correctly rounded unless perturbed). */
export const div32 = (a: number, b: number) => perturb(fr(a / b));
export const sqrt32 = (a: number) => perturb(fr(Math.sqrt(a)));

// ---------- double-f32 (Joldes, Muller, Popescu 2017 algorithms; u = 2^-24) ----------

export type DD = [number, number];

export function twoSum(a: number, b: number): DD {
	const s = fr(a + b);
	const bb = fr(s - a);
	return [s, fr(fr(a - fr(s - bb)) + fr(b - bb))];
}
export function fastTwoSum(a: number, b: number): DD {
	const s = fr(a + b);
	const z = fr(s - a);
	return [s, fr(b - z)];
}
export function twoProd(a: number, b: number): DD {
	const p = fr(a * b);
	return [p, fma32(a, b, -p)];
}
/** AccurateDWPlusDW (Alg. 6): relative error ≤ 3u² + 13u³. */
export function ddAdd(xh: number, xl: number, yh: number, yl: number): DD {
	const s = twoSum(xh, yh);
	const t = twoSum(xl, yl);
	const c = fr(s[1] + t[0]);
	const v = fastTwoSum(s[0], c);
	const w = fr(t[1] + v[1]);
	return fastTwoSum(v[0], w);
}
/** DWPlusFP (Alg. 4): relative error ≤ 2u². */
export function ddAddF(xh: number, xl: number, y: number): DD {
	const s = twoSum(xh, y);
	const v = fr(xl + s[1]);
	return fastTwoSum(s[0], v);
}
/** DWTimesDW3 (Alg. 12, FMA): relative error ≤ 4u². */
export function ddMul(xh: number, xl: number, yh: number, yl: number): DD {
	const c = twoProd(xh, yh);
	const tl0 = fr(xl * yl);
	const tl1 = fma32(xh, yl, tl0);
	const cl2 = fma32(xl, yh, tl1);
	const cl3 = fr(c[1] + cl2);
	return fastTwoSum(c[0], cl3);
}
/** DWTimesFP3 (Alg. 9, FMA): relative error ≤ 2u². */
export function ddMulF(xh: number, xl: number, y: number): DD {
	const c = twoProd(xh, y);
	const cl3 = fma32(xl, y, c[1]);
	return fastTwoSum(c[0], cl3);
}
/**
 * x / y: f32 reciprocal (any error ≤ 4 ULP), then two residual corrections in df32. Relative error
 * ≤ 8u² + O(u³) (README); budgeted as EPS_DIV = 9u².
 */
export function ddDiv(xh: number, xl: number, yh: number, yl: number): DD {
	const r = div32(1, yh);
	const q1 = fr(xh * r);
	const p = ddMulF(yh, yl, q1);
	const rem = ddAdd(xh, xl, -p[0], -p[1]);
	const q2 = fr(rem[0] * r);
	const q = fastTwoSum(q1, q2);
	const p2 = ddMul(yh, yl, q[0], q[1]);
	const rem2 = ddAdd(xh, xl, -p2[0], -p2[1]);
	const q3 = fr(rem2[0] * r);
	return ddAddF(q[0], q[1], q3);
}
/** √x (x > 0): f32 sqrt (≤ 4 ULP), then two Newton corrections in df32. Budgeted as EPS_SQRT = 7u². */
export function ddSqrt(xh: number, xl: number): DD {
	const s1 = sqrt32(xh);
	const r = div32(0.5, s1);
	const p = twoProd(s1, s1);
	const rem = ddAdd(xh, xl, -p[0], -p[1]);
	const c1 = fr(rem[0] * r);
	const s = fastTwoSum(s1, c1);
	const p2 = ddMul(s[0], s[1], s[0], s[1]);
	const rem2 = ddAdd(xh, xl, -p2[0], -p2[1]);
	const c2 = fr(rem2[0] * r);
	return ddAddF(s[0], s[1], c2);
}

/** f64 → normalised df32 (hi = RN(hi + lo)); |hi + lo − v| ≤ 2^-48·|v|. */
export function split(v: number): DD {
	// host-side packing (the bits a buffer holds): plain rounding, never the emulated machine's FTZ
	const hi = fround(v);
	const lo = fround(v - hi);
	const s = fround(hi + lo);
	return [s, fround(lo - fround(s - hi))];
}

/**
 * Per-operation relative error budgets (u² = 2^-48), each ≥ the bound of its algorithm: DWPlusDW
 * 3u² + 13u³, DWPlusFP 2u², DWTimesDW3 5u² (taken as 6u²), DWTimesFP3 2u², ddDiv 8u² + O(u³),
 * ddSqrt 5.5u² + O(u³) (README: the last two with a ≤ 4 ULP f32 division / sqrt).
 */
const U2 = 2 ** -48;
export const EPS_ADD = 3.125 * U2;
export const EPS_MUL = 6 * U2;
export const EPS_DIV = 9 * U2;
export const EPS_SQRT = 7 * U2;

/**
 * The WGSL twin of the df32 functions above (same names, vec2<f32> for a df32). The including kernel
 * runs `ZERO = <a uniform u32 that is always 0>;` before any of them.
 */
export const DF32_WGSL = /* wgsl */ `
var<private> ZERO: u32;

fn opq(x: f32) -> f32 { return bitcast<f32>(bitcast<u32>(x) ^ ZERO); }

fn twoSum(a: f32, b: f32) -> vec2<f32> {
	let s = opq(a + b);
	let bb = opq(s - a);
	return vec2<f32>(s, opq(opq(a - opq(s - bb)) + opq(b - bb)));
}
fn fastTwoSum(a: f32, b: f32) -> vec2<f32> {
	let s = opq(a + b);
	let z = opq(s - a);
	return vec2<f32>(s, opq(b - z));
}
fn twoProd(a: f32, b: f32) -> vec2<f32> {
	let p = opq(a * b);
	return vec2<f32>(p, opq(fma(a, b, -p)));
}
fn ddAdd(x: vec2<f32>, y: vec2<f32>) -> vec2<f32> {
	let s = twoSum(x.x, y.x);
	let t = twoSum(x.y, y.y);
	let c = opq(s.y + t.x);
	let v = fastTwoSum(s.x, c);
	let w = opq(t.y + v.y);
	return fastTwoSum(v.x, w);
}
fn ddAddF(x: vec2<f32>, y: f32) -> vec2<f32> {
	let s = twoSum(x.x, y);
	let v = opq(x.y + s.y);
	return fastTwoSum(s.x, v);
}
fn ddMul(x: vec2<f32>, y: vec2<f32>) -> vec2<f32> {
	let c = twoProd(x.x, y.x);
	let tl0 = opq(x.y * y.y);
	let tl1 = opq(fma(x.x, y.y, tl0));
	let cl2 = opq(fma(x.y, y.x, tl1));
	let cl3 = opq(c.y + cl2);
	return fastTwoSum(c.x, cl3);
}
fn ddMulF(x: vec2<f32>, y: f32) -> vec2<f32> {
	let c = twoProd(x.x, y);
	let cl3 = opq(fma(x.y, y, c.y));
	return fastTwoSum(c.x, cl3);
}
fn ddDiv(x: vec2<f32>, y: vec2<f32>) -> vec2<f32> {
	let r = opq(1.0 / y.x);
	let q1 = opq(x.x * r);
	let p = ddMulF(y, q1);
	let rem = ddAdd(x, -p);
	let q2 = opq(rem.x * r);
	let q = fastTwoSum(q1, q2);
	let p2 = ddMul(y, q);
	let rem2 = ddAdd(x, -p2);
	let q3 = opq(rem2.x * r);
	return ddAddF(q, q3);
}
fn ddSqrt(x: vec2<f32>) -> vec2<f32> {
	let s1 = opq(sqrt(x.x));
	let r = opq(0.5 / s1);
	let p = twoProd(s1, s1);
	let rem = ddAdd(x, -p);
	let c1 = opq(rem.x * r);
	let s = fastTwoSum(s1, c1);
	let p2 = ddMul(s, s);
	let rem2 = ddAdd(x, -p2);
	let c2 = opq(rem2.x * r);
	return ddAddF(s, c2);
}
`;
