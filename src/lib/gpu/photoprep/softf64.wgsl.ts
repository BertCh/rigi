// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// IEEE-754 binary64 arithmetic in WGSL u32 integer operations (no float instruction anywhere: the
// result cannot depend on the device's float precision, FMA contraction, flush-to-zero or fast-math;
// WGSL defines u32 +, −, *, /, shifts and comparisons exactly). A double is vec2<u32>(lo, hi) of its
// bit pattern. ./softf64.ts is the JS twin, statement for statement, and its header has the rounding
// argument; ./photoprep.check.ts fuzzes the twin against V8's hardware doubles.
//
// Shifts: every `<<` / `>>` below has an amount < 32 (WGSL takes runtime shift amounts modulo 32, so
// the `n == 0` / `n >= 32` cases are separate branches, as in the twin).
export const SOFTF64_WGSL = /* wgsl */ `
fn u64_add(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
	let lo = a.x + b.x;
	let c = select(0u, 1u, lo < a.x);
	return vec2<u32>(lo, a.y + b.y + c);
}
fn u64_sub(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
	let br = select(0u, 1u, a.x < b.x);
	return vec2<u32>(a.x - b.x, a.y - b.y - br);
}
fn u64_lt(a: vec2<u32>, b: vec2<u32>) -> bool {
	return a.y < b.y || (a.y == b.y && a.x < b.x);
}
fn u64_is0(a: vec2<u32>) -> bool {
	return (a.x | a.y) == 0u;
}
fn u64_shl(a: vec2<u32>, n: u32) -> vec2<u32> {
	if (n == 0u) { return a; }
	if (n >= 64u) { return vec2<u32>(0u, 0u); }
	if (n >= 32u) { return vec2<u32>(0u, a.x << (n - 32u)); }
	return vec2<u32>(a.x << n, (a.y << n) | (a.x >> (32u - n)));
}
fn u64_shr(a: vec2<u32>, n: u32) -> vec2<u32> {
	if (n == 0u) { return a; }
	if (n >= 64u) { return vec2<u32>(0u, 0u); }
	if (n >= 32u) { return vec2<u32>(a.y >> (n - 32u), 0u); }
	return vec2<u32>((a.x >> n) | (a.y << (32u - n)), a.y >> n);
}
fn u64_shr_sticky(a: vec2<u32>, n: u32) -> vec2<u32> {
	let r = u64_shr(a, n);
	let back = u64_shl(r, n);
	let lost = select(0u, 1u, back.x != a.x || back.y != a.y);
	return vec2<u32>(r.x | lost, r.y);
}
fn u64_clz(a: vec2<u32>) -> u32 {
	if (a.y != 0u) { return countLeadingZeros(a.y); }
	return 32u + countLeadingZeros(a.x);
}
fn mul32(a: u32, b: u32) -> vec2<u32> {
	let al = a & 0xffffu;
	let ah = a >> 16u;
	let bl = b & 0xffffu;
	let bh = b >> 16u;
	let ll = al * bl;
	let lh = al * bh;
	let hl = ah * bl;
	let hh = ah * bh;
	let mid = lh + hl;
	let midc = select(0u, 0x10000u, mid < lh);
	let lo = ll + (mid << 16u);
	let loc = select(0u, 1u, lo < ll);
	return vec2<u32>(lo, hh + (mid >> 16u) + midc + loc);
}

fn f64_sign(a: vec2<u32>) -> u32 { return a.y >> 31u; }
fn f64_expf(a: vec2<u32>) -> u32 { return (a.y >> 20u) & 0x7ffu; }
fn f64_mant(a: vec2<u32>) -> vec2<u32> {
	let e = f64_expf(a);
	let f = vec2<u32>(a.x, a.y & 0xfffffu);
	if (e == 0u) { return f; }
	return vec2<u32>(f.x, f.y | 0x100000u);
}
fn f64_exp1(a: vec2<u32>) -> i32 { return max(i32(f64_expf(a)), 1); }
fn f64_is0(a: vec2<u32>) -> bool { return a.x == 0u && (a.y & 0x7fffffffu) == 0u; }
fn f64_neg(a: vec2<u32>) -> vec2<u32> { return vec2<u32>(a.x, a.y ^ 0x80000000u); }
fn f64_abs(a: vec2<u32>) -> vec2<u32> { return vec2<u32>(a.x, a.y & 0x7fffffffu); }
fn f64_max0(a: vec2<u32>) -> vec2<u32> {
	if ((a.y >> 31u) != 0u || f64_is0(a)) { return vec2<u32>(0u, 0u); }
	return a;
}
fn f64_gt_pos(a: vec2<u32>, b: vec2<u32>) -> bool { return u64_lt(b, a); }

fn f64_round(sign: u32, e_in: i32, m_in: vec2<u32>) -> vec2<u32> {
	var e = e_in;
	var m = m_in;
	let lz = u64_clz(m);
	if (lz > 8u) {
		m = u64_shl(m, lz - 8u);
		e = e - i32(lz - 8u);
	} else if (lz < 8u) {
		m = u64_shr_sticky(m, 8u - lz);
		e = e + i32(8u - lz);
	}
	if (e < 1) {
		m = u64_shr_sticky(m, u32(1 - e));
		e = 1;
	}
	let g = m.x & 7u;
	var q = u64_shr(m, 3u);
	if (g > 4u || (g == 4u && (q.x & 1u) == 1u)) { q = u64_add(q, vec2<u32>(1u, 0u)); }
	if (q.y >= 0x200000u) {
		q = u64_shr(q, 1u);
		e = e + 1;
	}
	if (e >= 2047) { return vec2<u32>(0u, (sign << 31u) | 0x7ff00000u); }
	var ef = 0u;
	if ((q.y & 0x100000u) != 0u) { ef = u32(e); }
	return vec2<u32>(q.x, (sign << 31u) | (ef << 20u) | (q.y & 0xfffffu));
}

fn f64_add(a0: vec2<u32>, b0: vec2<u32>) -> vec2<u32> {
	if (f64_is0(a0)) {
		if (f64_is0(b0)) { return vec2<u32>(0u, a0.y & b0.y & 0x80000000u); }
		return b0;
	}
	if (f64_is0(b0)) { return a0; }
	var a = a0;
	var b = b0;
	var ea = f64_exp1(a);
	var eb = f64_exp1(b);
	var ma = u64_shl(f64_mant(a), 3u);
	var mb = u64_shl(f64_mant(b), 3u);
	if (eb > ea || (eb == ea && u64_lt(ma, mb))) {
		let t = a;
		a = b;
		b = t;
		let te = ea;
		ea = eb;
		eb = te;
		let tm = ma;
		ma = mb;
		mb = tm;
	}
	mb = u64_shr_sticky(mb, u32(ea - eb));
	var m: vec2<u32>;
	if (f64_sign(a) == f64_sign(b)) {
		m = u64_add(ma, mb);
	} else {
		m = u64_sub(ma, mb);
		if (u64_is0(m)) { return vec2<u32>(0u, 0u); }
	}
	return f64_round(f64_sign(a), ea, m);
}

fn f64_sub(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> { return f64_add(a, f64_neg(b)); }

struct F64N { m: vec2<u32>, e: i32 }
fn f64_norm52(a: vec2<u32>) -> F64N {
	var m = f64_mant(a);
	var e = f64_exp1(a);
	let lz = u64_clz(m);
	if (lz > 11u) {
		m = u64_shl(m, lz - 11u);
		e = e - i32(lz - 11u);
	}
	return F64N(m, e);
}

fn f64_mul(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
	let s = f64_sign(a) ^ f64_sign(b);
	if (f64_is0(a) || f64_is0(b)) { return vec2<u32>(0u, s << 31u); }
	let na = f64_norm52(a);
	let nb = f64_norm52(b);
	let ma = na.m;
	let mb = nb.m;
	let p00 = mul32(ma.x, mb.x);
	let p01 = mul32(ma.x, mb.y);
	let p10 = mul32(ma.y, mb.x);
	let p11 = mul32(ma.y, mb.y);
	let m1 = u64_add(p01, p10);
	let c1 = select(0u, 1u, u64_lt(m1, p01));
	let m2 = u64_add(m1, vec2<u32>(p00.y, 0u));
	let c2 = select(0u, 1u, u64_lt(m2, m1));
	let hi = u64_add(u64_add(p11, vec2<u32>(m2.y, 0u)), vec2<u32>(0u, c1 + c2));
	let top = vec2<u32>((hi.x << 15u) | (m2.x >> 17u), (hi.y << 15u) | (hi.x >> 17u));
	let lost = select(0u, 1u, (m2.x & 0x1ffffu) != 0u || p00.x != 0u);
	return f64_round(s, na.e + nb.e + 49 - 1072, vec2<u32>(top.x | lost, top.y));
}

fn f64_div(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
	let s = f64_sign(a) ^ f64_sign(b);
	if (f64_is0(a)) { return vec2<u32>(0u, s << 31u); }
	let na = f64_norm52(a);
	let nb = f64_norm52(b);
	var ma = na.m;
	var ea = na.e;
	let mb = nb.m;
	if (u64_lt(ma, mb)) {
		ma = u64_shl(ma, 1u);
		ea = ea - 1;
	}
	var rem = ma;
	var q = vec2<u32>(0u, 0u);
	for (var i = 0u; i < 56u; i++) {
		q = u64_shl(q, 1u);
		if (!u64_lt(rem, mb)) {
			rem = u64_sub(rem, mb);
			q = vec2<u32>(q.x | 1u, q.y);
		}
		rem = u64_shl(rem, 1u);
	}
	q = vec2<u32>(q.x | select(1u, 0u, u64_is0(rem)), q.y);
	return f64_round(s, ea - nb.e + 1023, q);
}

fn f64_div_small(a: vec2<u32>, k: u32) -> vec2<u32> {
	let s = f64_sign(a);
	if (f64_is0(a)) { return vec2<u32>(0u, s << 31u); }
	let e = f64_exp1(a);
	let m = f64_mant(a);
	let lz = u64_clz(m);
	let n = u64_shl(m, lz);
	var ex = e + 3 - i32(lz);
	var rem = 0u;
	var cur = (rem << 16u) | (n.y >> 16u);
	var d = cur / k;
	rem = cur - d * k;
	var qh = d << 16u;
	cur = (rem << 16u) | (n.y & 0xffffu);
	d = cur / k;
	rem = cur - d * k;
	qh = qh | d;
	cur = (rem << 16u) | (n.x >> 16u);
	d = cur / k;
	rem = cur - d * k;
	var ql = d << 16u;
	cur = (rem << 16u) | (n.x & 0xffffu);
	d = cur / k;
	rem = cur - d * k;
	ql = ql | d;
	if (qh < 0x01000000u) {
		let c = rem << 8u;
		let d8 = c / k;
		rem = c - d8 * k;
		qh = (qh << 8u) | (ql >> 24u);
		ql = (ql << 8u) | d8;
		ex = ex - 8;
	}
	ql = ql | select(0u, 1u, rem != 0u);
	return f64_round(s, ex, vec2<u32>(ql, qh));
}

fn f64_to_f32(a: vec2<u32>) -> u32 {
	let s = f64_sign(a) << 31u;
	let e = i32(f64_expf(a));
	if (e == 0) { return s; }
	let m = vec2<u32>(a.x, (a.y & 0xfffffu) | 0x100000u);
	let e32 = e - 896;
	if (e32 >= 255) { return s | 0x7f800000u; }
	if (e32 >= 1) {
		var q = (m.y << 3u) | (m.x >> 29u);
		let r = m.x & 0x1fffffffu;
		if (r > 0x10000000u || (r == 0x10000000u && (q & 1u) == 1u)) { q = q + 1u; }
		return s | ((u32(e32 - 1) << 23u) + q);
	}
	let sh = u32(926 - e);
	if (sh >= 54u) { return s; }
	let q0 = u64_shr(m, sh);
	let r = u64_sub(m, u64_shl(q0, sh));
	let half = u64_shl(vec2<u32>(1u, 0u), sh - 1u);
	var q = q0.x;
	if (u64_lt(half, r) || (r.x == half.x && r.y == half.y && (q & 1u) == 1u)) { q = q + 1u; }
	return s | q;
}

fn f64_from_f32(b: u32) -> vec2<u32> {
	let s = b & 0x80000000u;
	let e = (b >> 23u) & 0xffu;
	var f = b & 0x7fffffu;
	if (e == 0u) {
		if (f == 0u) { return vec2<u32>(0u, s); }
		let k = countLeadingZeros(f) - 8u;
		f = (f << k) & 0x7fffffu;
		return vec2<u32>(f << 29u, s | ((897u - k) << 20u) | (f >> 3u));
	}
	return vec2<u32>(f << 29u, s | ((e + 896u) << 20u) | (f >> 3u));
}

fn f64_from_u32(n: u32) -> vec2<u32> {
	if (n == 0u) { return vec2<u32>(0u, 0u); }
	let k = countLeadingZeros(n);
	let m = u64_shl(vec2<u32>(n, 0u), 21u + k);
	return vec2<u32>(m.x, ((1054u - k) << 20u) | (m.y & 0xfffffu));
}
`;
