// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// IEEE-754 binary64 arithmetic in u32 integer operations: the JS twin of ./softf64.wgsl.ts, line for
// line (same function names, same statements, `>>> 0` where WGSL's u32 arithmetic wraps). It exists so
// node can run exactly what the kernels compute (./emulate.ts, ./photoprep.check.ts); the app never
// calls it on the hot path.
//
// A double is a V2 = [lo, hi] pair of its bit pattern's u32 words (WGSL: vec2<u32>(lo, hi)).
// Every operation rounds to nearest, ties to even, exactly like V8's hardware doubles (no extended
// precision, no FMA: ECMAScript fixes both), including subnormal results. Not handled (never produced
// by the photo-prep data, which is finite and bounded): NaN and infinite operands, division by zero.
//
// Rounding with three extra bits (guard, round, sticky). `round` takes a magnitude `m` whose value is
// m · 2^(e − 1078) (the 53-bit significand shifted left by 3), normalises it to its leading bit at 55,
// denormalises below exponent 1, and rounds the low 3 bits to nearest-even. The only left shifts it
// does follow exact operations, or a subtraction with an alignment shift ≥ 2 (a 1-bit shift, where
// the sticky bit is still below the rounding bits: the standard guard/round/sticky argument). Every
// other producer (mul, div, divSmall) hands it a value whose leading bit is already ≥ 55, so its
// sticky bit is only ever shifted right.

export type V2 = [number, number];

// ---- u64 as [lo, hi] ----
export const u64Add = (a: V2, b: V2): V2 => {
	const lo = (a[0] + b[0]) >>> 0;
	const c = lo < a[0] ? 1 : 0;
	return [lo, (a[1] + b[1] + c) >>> 0];
};
export const u64Sub = (a: V2, b: V2): V2 => {
	const br = a[0] < b[0] ? 1 : 0;
	return [(a[0] - b[0]) >>> 0, (a[1] - b[1] - br) >>> 0];
};
export const u64Lt = (a: V2, b: V2) =>
	a[1] < b[1] || (a[1] === b[1] && a[0] < b[0]);
export const u64Is0 = (a: V2) => (a[0] | a[1]) === 0;
export const u64Shl = (a: V2, n: number): V2 => {
	if (n === 0) return a;
	if (n >= 64) return [0, 0];
	if (n >= 32) return [0, (a[0] << (n - 32)) >>> 0];
	return [(a[0] << n) >>> 0, ((a[1] << n) | (a[0] >>> (32 - n))) >>> 0];
};
export const u64Shr = (a: V2, n: number): V2 => {
	if (n === 0) return a;
	if (n >= 64) return [0, 0];
	if (n >= 32) return [a[1] >>> (n - 32), 0];
	return [((a[0] >>> n) | (a[1] << (32 - n))) >>> 0, a[1] >>> n];
};
/** a >> n with every shifted-out bit OR'ed into bit 0 (n any u32). */
export const u64ShrSticky = (a: V2, n: number): V2 => {
	const r = u64Shr(a, n);
	const back = u64Shl(r, n);
	const lost = back[0] !== a[0] || back[1] !== a[1] ? 1 : 0;
	return [(r[0] | lost) >>> 0, r[1]];
};
export const u64Clz = (a: V2) =>
	a[1] !== 0 ? Math.clz32(a[1]) : 32 + Math.clz32(a[0]);

/** 32 × 32 → 64-bit product from 16-bit halves (WGSL has no mulhi). */
export const mul32 = (a: number, b: number): V2 => {
	const al = a & 0xffff;
	const ah = a >>> 16;
	const bl = b & 0xffff;
	const bh = b >>> 16;
	const ll = al * bl;
	const lh = al * bh;
	const hl = ah * bl;
	const hh = ah * bh;
	const mid = (lh + hl) >>> 0;
	const midc = mid < lh ? 0x10000 : 0;
	const lo = (ll + ((mid << 16) >>> 0)) >>> 0;
	const loc = lo < ll ? 1 : 0;
	return [lo, (hh + (mid >>> 16) + midc + loc) >>> 0];
};

// ---- binary64 fields ----
export const f64Sign = (a: V2) => a[1] >>> 31;
export const f64Expf = (a: V2) => (a[1] >>> 20) & 0x7ff;
/** Significand with the hidden bit (none for zero / subnormals). */
export const f64Mant = (a: V2): V2 => {
	const e = f64Expf(a);
	const f: V2 = [a[0], a[1] & 0xfffff];
	if (e === 0) return f;
	return [f[0], (f[1] | 0x100000) >>> 0];
};
/** Exponent field, 1 for subnormals (their significand has no hidden bit). */
export const f64Exp1 = (a: V2) => Math.max(f64Expf(a), 1);
export const f64Is0 = (a: V2) => a[0] === 0 && (a[1] & 0x7fffffff) === 0;
export const f64Neg = (a: V2): V2 => [a[0], (a[1] ^ 0x80000000) >>> 0];
export const f64Abs = (a: V2): V2 => [a[0], a[1] & 0x7fffffff];
/** Math.max(a, 0) for a non-NaN double (+0 for ±0 and negatives). */
export const f64Max0 = (a: V2): V2 => {
	if (a[1] >>> 31 !== 0 || f64Is0(a)) return [0, 0];
	return a;
};
/** a > b for doubles with clear sign bits (bit patterns order like values). */
export const f64GtPos = (a: V2, b: V2) => u64Lt(b, a);

/** Round m · 2^(e − 1078) (m ≠ 0, see the header) to the nearest double, ties to even. */
export const f64Round = (sign: number, eIn: number, mIn: V2): V2 => {
	let e = eIn;
	let m = mIn;
	const lz = u64Clz(m);
	if (lz > 8) {
		m = u64Shl(m, lz - 8);
		e = e - (lz - 8);
	} else if (lz < 8) {
		m = u64ShrSticky(m, 8 - lz);
		e = e + (8 - lz);
	}
	if (e < 1) {
		m = u64ShrSticky(m, 1 - e);
		e = 1;
	}
	const g = m[0] & 7;
	let q = u64Shr(m, 3);
	if (g > 4 || (g === 4 && (q[0] & 1) === 1)) q = u64Add(q, [1, 0]);
	if (q[1] >= 0x200000) {
		q = u64Shr(q, 1);
		e = e + 1;
	}
	if (e >= 2047) return [0, ((sign << 31) | 0x7ff00000) >>> 0];
	let ef = 0;
	if ((q[1] & 0x100000) !== 0) ef = e;
	return [q[0], ((sign << 31) | (ef << 20) | (q[1] & 0xfffff)) >>> 0];
};

export const f64Add = (a0: V2, b0: V2): V2 => {
	if (f64Is0(a0)) {
		if (f64Is0(b0)) return [0, (a0[1] & b0[1] & 0x80000000) >>> 0];
		return b0;
	}
	if (f64Is0(b0)) return a0;
	let a = a0;
	let b = b0;
	let ea = f64Exp1(a);
	let eb = f64Exp1(b);
	let ma = u64Shl(f64Mant(a), 3);
	let mb = u64Shl(f64Mant(b), 3);
	if (eb > ea || (eb === ea && u64Lt(ma, mb))) {
		const t = a;
		a = b;
		b = t;
		const te = ea;
		ea = eb;
		eb = te;
		const tm = ma;
		ma = mb;
		mb = tm;
	}
	mb = u64ShrSticky(mb, ea - eb);
	let m: V2;
	if (f64Sign(a) === f64Sign(b)) m = u64Add(ma, mb);
	else {
		m = u64Sub(ma, mb);
		// x − x is +0 under round-to-nearest
		if (u64Is0(m)) return [0, 0];
	}
	return f64Round(f64Sign(a), ea, m);
};

export const f64Sub = (a: V2, b: V2): V2 => f64Add(a, f64Neg(b));

/** Normalised significand (leading bit 52) and exponent of a nonzero double. */
const norm52 = (a: V2): [V2, number] => {
	let m = f64Mant(a);
	let e = f64Exp1(a);
	const lz = u64Clz(m);
	if (lz > 11) {
		m = u64Shl(m, lz - 11);
		e = e - (lz - 11);
	}
	return [m, e];
};

export const f64Mul = (a: V2, b: V2): V2 => {
	const s = f64Sign(a) ^ f64Sign(b);
	if (f64Is0(a) || f64Is0(b)) return [0, (s << 31) >>> 0];
	const [ma, ea] = norm52(a);
	const [mb, eb] = norm52(b);
	// P = ma · mb ∈ [2^104, 2^106) as words (hi.y, hi.x, m2.x, p00.x)
	const p00 = mul32(ma[0], mb[0]);
	const p01 = mul32(ma[0], mb[1]);
	const p10 = mul32(ma[1], mb[0]);
	const p11 = mul32(ma[1], mb[1]);
	const m1 = u64Add(p01, p10);
	const c1 = u64Lt(m1, p01) ? 1 : 0;
	const m2 = u64Add(m1, [p00[1], 0]);
	const c2 = u64Lt(m2, m1) ? 1 : 0;
	const hi = u64Add(u64Add(p11, [m2[1], 0]), [0, c1 + c2]);
	// P >> 49 (leading bit 55 or 56) with the 49 dropped bits as sticky
	const top: V2 = [
		((hi[0] << 15) | (m2[0] >>> 17)) >>> 0,
		((hi[1] << 15) | (hi[0] >>> 17)) >>> 0,
	];
	const lost = (m2[0] & 0x1ffff) !== 0 || p00[0] !== 0 ? 1 : 0;
	return f64Round(s, ea + eb + 49 - 1072, [(top[0] | lost) >>> 0, top[1]]);
};

/** a / b, b ≠ 0: 56 quotient bits by restoring division, the remainder as sticky. */
export const f64Div = (a: V2, b: V2): V2 => {
	const s = f64Sign(a) ^ f64Sign(b);
	if (f64Is0(a)) return [0, (s << 31) >>> 0];
	let [ma, ea] = norm52(a);
	const [mb, eb] = norm52(b);
	if (u64Lt(ma, mb)) {
		ma = u64Shl(ma, 1);
		ea = ea - 1;
	}
	let rem = ma;
	let q: V2 = [0, 0];
	for (let i = 0; i < 56; i++) {
		q = u64Shl(q, 1);
		if (!u64Lt(rem, mb)) {
			rem = u64Sub(rem, mb);
			q = [(q[0] | 1) >>> 0, q[1]];
		}
		rem = u64Shl(rem, 1);
	}
	q = [(q[0] | (u64Is0(rem) ? 0 : 1)) >>> 0, q[1]];
	return f64Round(s, ea - eb + 1023, q);
};

/**
 * a / k for an integer 1 ≤ k < 2^16 (exactly the double division by the double k): long division of
 * the significand by 16-bit chunks with u32 `/` (exact), 8 more quotient bits when the quotient is
 * under 2^56 (so its leading bit is ≥ 55 before the remainder becomes the sticky bit).
 */
export const f64DivSmall = (a: V2, k: number): V2 => {
	const s = f64Sign(a);
	if (f64Is0(a)) return [0, (s << 31) >>> 0];
	const e = f64Exp1(a);
	const m = f64Mant(a);
	const lz = u64Clz(m);
	const n = u64Shl(m, lz);
	let ex = e + 3 - lz;
	let rem = 0;
	let cur = ((rem << 16) | (n[1] >>> 16)) >>> 0;
	let d = Math.floor(cur / k);
	rem = (cur - d * k) >>> 0;
	let qh = (d << 16) >>> 0;
	cur = ((rem << 16) | (n[1] & 0xffff)) >>> 0;
	d = Math.floor(cur / k);
	rem = (cur - d * k) >>> 0;
	qh = (qh | d) >>> 0;
	cur = ((rem << 16) | (n[0] >>> 16)) >>> 0;
	d = Math.floor(cur / k);
	rem = (cur - d * k) >>> 0;
	let ql = (d << 16) >>> 0;
	cur = ((rem << 16) | (n[0] & 0xffff)) >>> 0;
	d = Math.floor(cur / k);
	rem = (cur - d * k) >>> 0;
	ql = (ql | d) >>> 0;
	if (qh < 0x01000000) {
		const c = (rem << 8) >>> 0;
		const d8 = Math.floor(c / k);
		rem = (c - d8 * k) >>> 0;
		qh = ((qh << 8) | (ql >>> 24)) >>> 0;
		ql = ((ql << 8) | d8) >>> 0;
		ex = ex - 8;
	}
	ql = (ql | (rem !== 0 ? 1 : 0)) >>> 0;
	return f64Round(s, ex, [ql, qh]);
};

/** Math.fround as bits: binary64 → binary32, nearest-even, subnormals included. */
export const f64ToF32 = (a: V2): number => {
	const s = (f64Sign(a) << 31) >>> 0;
	const e = f64Expf(a);
	// zero, or a binary64 subnormal (< 2^-1022: ±0 in binary32)
	if (e === 0) return s;
	const m: V2 = [a[0], ((a[1] & 0xfffff) | 0x100000) >>> 0];
	const e32 = e - 896;
	if (e32 >= 255) return (s | 0x7f800000) >>> 0;
	if (e32 >= 1) {
		let q = ((m[1] << 3) | (m[0] >>> 29)) >>> 0;
		const r = m[0] & 0x1fffffff;
		if (r > 0x10000000 || (r === 0x10000000 && (q & 1) === 1)) q = q + 1;
		return (s | ((((e32 - 1) << 23) >>> 0) + q)) >>> 0;
	}
	const sh = 926 - e;
	if (sh >= 54) return s;
	const q0 = u64Shr(m, sh);
	const r = u64Sub(m, u64Shl(q0, sh));
	const half = u64Shl([1, 0], sh - 1);
	let q = q0[0];
	if (u64Lt(half, r) || (r[0] === half[0] && r[1] === half[1] && (q & 1) === 1))
		q = q + 1;
	return (s | q) >>> 0;
};

/** binary32 bits → binary64 (exact). */
export const f64FromF32 = (b: number): V2 => {
	const s = (b & 0x80000000) >>> 0;
	const e = (b >>> 23) & 0xff;
	let f = b & 0x7fffff;
	if (e === 0) {
		if (f === 0) return [0, s];
		const k = Math.clz32(f) - 8;
		f = (f << k) & 0x7fffff;
		return [(f << 29) >>> 0, (s | ((897 - k) << 20) | (f >>> 3)) >>> 0];
	}
	return [(f << 29) >>> 0, (s | ((e + 896) << 20) | (f >>> 3)) >>> 0];
};

/** u32 → binary64 (exact). */
export const f64FromU32 = (n: number): V2 => {
	if (n === 0) return [0, 0];
	const k = Math.clz32(n);
	const m = u64Shl([n, 0], 21 + k);
	return [m[0], (((1054 - k) << 20) | (m[1] & 0xfffff)) >>> 0];
};

// ---- host-side conversions (not part of the kernel twin) ----
const cf64 = new Float64Array(1);
const cu32 = new Uint32Array(cf64.buffer);
const cf32 = new Float32Array(1);
const cu32f = new Uint32Array(cf32.buffer);
/** A JS double's bit pattern. */
export const bitsOf = (x: number): V2 => {
	cf64[0] = x;
	return [cu32[0], cu32[1]];
};
/** The JS double with bit pattern v. */
export const doubleOf = (v: V2): number => {
	cu32[0] = v[0];
	cu32[1] = v[1];
	return cf64[0];
};
/** A binary32 bit pattern (u32) as a JS number. */
export const f32Value = (b: number): number => {
	cu32f[0] = b;
	return cf32[0];
};
/** Math.fround(x)'s bit pattern. */
export const f32Bits = (x: number): number => {
	cf32[0] = x;
	return cu32f[0];
};
/** WGSL literal of the double x: `vec2<u32>(0x…u, 0x…u)`. */
export const wgslF64 = (x: number) => {
	const [lo, hi] = bitsOf(x);
	return `vec2<u32>(0x${lo.toString(16)}u, 0x${hi.toString(16)}u)`;
};
