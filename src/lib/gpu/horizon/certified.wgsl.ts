// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL of the certified-f32 horizon stages (README.md "Certified f32"). Every function mirrors the one
// of the same name in ./certified-cpu.ts (the emulation the node check proves sound); keep the two in
// step. Constants come from certified-cpu.ts as exact f32 bits.
//
// The double-f32 library (DF32_WGSL, with its fast-math guard opq()) and its device probe live in
// src/lib/gpu/precision (df32.ts, ieee-probe.ts), shared with other certified-f32 stages.
//
// Kernels (one invocation per sample / column, workgroup 64):
//   STAGE_A_WGSL  tan(elevation) → elevation degrees (index.ts collect)          td → outA
//   STAGE_B_WGSL  per sample: great circle + WGS84 ENU + azimuth / elevation       prof → samp
//   STAGE_C_WGSL  per column: bracket search + interpolation + unit direction       samp → outC
import { bits32, DF32_WGSL } from "../precision/df32";
import { CI, F32C, TAB_K } from "./certified-cpu";

const f32 = (x: number) => `bitcast<f32>(${bits32(x)}u)`;
const constDecls = Object.entries(F32C)
	.map(([k, v]) => `const ${k}: f32 = ${f32(v)};`)
	.join("\n");
const ciDecls = Object.entries(CI)
	.map(([k, v]) => `const CI_${k}: u32 = ${v}u;`)
	.join("\n");

/** Uniform shared by all kernels (32 bytes). */
const UNIFORM = /* wgsl */ `
struct U {
	n: u32,
	nCols: u32,
	/** always 0 (opq) */
	zero: u32,
	/** largest f32 ≤ −3e38 (index.ts: t ≤ −3e38 → −90°) */
	noHit: f32,
	lumpEnu: f32,
	lumpEnuRel: f32,
	_a: u32,
	_b: u32,
};
`;

/** The horizon stages' constants and bound flag, then the shared df32 library. */
const DD = /* wgsl */ `
${constDecls}
var<private> BAD: bool;
${DF32_WGSL}`;

/** Tracked values (hi, lo, e) and the functions built on them (needs a `consts` binding). */
const TRACKED = /* wgsl */ `
${ciDecls}
const TAB_K: i32 = ${TAB_K};

fn clampE(e: f32) -> f32 { return select(BIG_E, e, e < BIG_E); }
fn tNeg(x: vec3<f32>) -> vec3<f32> { return vec3<f32>(-x.x, -x.y, x.z); }
fn tAdd(x: vec3<f32>, y: vec3<f32>) -> vec3<f32> {
	let z = ddAdd(x.xy, y.xy);
	return vec3<f32>(z, clampE(((x.z + y.z) + EPS_ADD * abs(z.x)) + TINY));
}
fn tSub(x: vec3<f32>, y: vec3<f32>) -> vec3<f32> { return tAdd(x, tNeg(y)); }
fn tAddF(x: vec3<f32>, c: f32) -> vec3<f32> {
	let z = ddAddF(x.xy, c);
	return vec3<f32>(z, clampE((x.z + EPS_ADD * abs(z.x)) + TINY));
}
fn tMul(x: vec3<f32>, y: vec3<f32>) -> vec3<f32> {
	let z = ddMul(x.xy, y.xy);
	let a = abs(x.x) * y.z + abs(y.x) * x.z;
	return vec3<f32>(z, clampE((a + x.z * y.z) + (EPS_MUL * abs(z.x) + TINY)));
}
fn tMulF(x: vec3<f32>, c: f32) -> vec3<f32> {
	let z = ddMulF(x.xy, c);
	return vec3<f32>(z, clampE(abs(c) * x.z + (EPS_MUL * abs(z.x) + TINY)));
}
fn tDiv(x: vec3<f32>, y: vec3<f32>) -> vec3<f32> {
	let den = (abs(y.x) - y.z) * K_DOWN;
	if (!(den > 0.0)) {
		BAD = true;
		return vec3<f32>(0.0, 0.0, BIG_E);
	}
	let z = ddDiv(x.xy, y.xy);
	let az = abs(z.x);
	let e = ((x.z + az * y.z) / den) * K_UP;
	return vec3<f32>(z, clampE(e + (EPS_DIV * az + TINY)));
}
fn tSqrt(x: vec3<f32>) -> vec3<f32> {
	if (!(x.x > 0.0)) {
		BAD = true;
		return vec3<f32>(0.0, 0.0, BIG_E);
	}
	let z = ddSqrt(x.xy);
	let e = (x.z / sqrt(x.x)) * K_UP;
	return vec3<f32>(z, clampE(e + (EPS_SQRT * abs(z.x) + TINY)));
}
fn tWiden(x: vec3<f32>, e: f32) -> vec3<f32> { return vec3<f32>(x.xy, clampE(x.z + e)); }

// loads of tracked values from f32 buffers: + FLUSH_E (a subnormal hi / lo may be flushed on load)
fn cst(i: u32) -> vec3<f32> { return vec3<f32>(consts[3u * i], consts[3u * i + 1u], consts[3u * i + 2u] + FLUSH_E); }

fn tSinSmall(r: vec3<f32>) -> vec3<f32> {
	if (!(abs(r.x) <= 0.03125)) { BAD = true; }
	let r2 = tMul(r, r);
	var p = cst(CI_SIN_C + 4u);
	for (var j: i32 = 3; j >= 0; j--) { p = tAdd(cst(CI_SIN_C + u32(j)), tMul(r2, p)); }
	let s = tAdd(r, tMul(r, tMul(r2, p)));
	return tWiden(s, ((abs(r.x) + r.z) * TRUNC_SIN) + TINY);
}
fn tOmcSmall(r: vec3<f32>) -> vec3<f32> {
	if (!(abs(r.x) <= 0.03125)) { BAD = true; }
	let r2 = tMul(r, r);
	var p = cst(CI_OMC_C + 5u);
	for (var j: i32 = 4; j >= 0; j--) { p = tAdd(cst(CI_OMC_C + u32(j)), tMul(r2, p)); }
	let ar = abs(r.x) + r.z;
	return tWiden(tMul(r2, p), ((ar * ar) * TRUNC_OMC) + TINY);
}
fn tAtanSmall(z: vec3<f32>) -> vec3<f32> {
	if (!(abs(z.x) <= ATAN_SMALL_MAX)) { BAD = true; }
	let z2 = tMul(z, z);
	var p = cst(CI_ATAN_C + 6u);
	for (var j: i32 = 5; j >= 0; j--) { p = tAdd(cst(CI_ATAN_C + u32(j)), tMul(z2, p)); }
	let a = tAdd(z, tMul(z, tMul(z2, p)));
	return tWiden(a, ((abs(z.x) + z.z) * TRUNC_ATAN) + TINY);
}
/** (sin x, cos x) for |x| ≤ 1.6: table at k/32 plus the small-argument series. */
fn tSinCos(x: vec3<f32>, cosOut: ptr<function, vec3<f32>>) -> vec3<f32> {
	let kf = floor(x.x * 32.0 + 0.5);
	if (!(abs(kf) <= f32(TAB_K))) {
		BAD = true;
		*cosOut = vec3<f32>(0.0, 0.0, BIG_E);
		return vec3<f32>(0.0, 0.0, BIG_E);
	}
	let k = i32(kf);
	let r = tAddF(x, -kf / 32.0);
	let S = cst(CI_SIN_TAB + u32(k + TAB_K));
	let K = cst(CI_COS_TAB + u32(k + TAB_K));
	let s = tSinSmall(r);
	let o = tOmcSmall(r);
	*cosOut = tSub(tSub(K, tMul(K, o)), tMul(S, s));
	return tAdd(tSub(S, tMul(S, o)), tMul(K, s));
}
/** atan x (radians), any finite x. */
fn tAtan(x: vec3<f32>) -> vec3<f32> {
	if (!(abs(x.x) <= ATAN_MAX_ARG)) {
		BAD = true;
		return vec3<f32>(0.0, 0.0, BIG_E);
	}
	let neg = x.x < 0.0;
	let ax = select(x, tNeg(x), neg);
	let inv = ax.x > 1.0;
	var y = ax;
	if (inv) { y = tDiv(cst(CI_ONE), ax); }
	let kf = floor(y.x * 32.0 + 0.5);
	if (!(kf >= 0.0 && kf <= 32.0)) {
		BAD = true;
		return vec3<f32>(0.0, 0.0, BIG_E);
	}
	let c = kf / 32.0;
	let num = tAddF(y, -c);
	let den = tAddF(tMulF(y, c), 1.0);
	let z = tDiv(num, den);
	var a = tAdd(cst(CI_ATAN_TAB + u32(kf)), tAtanSmall(z));
	if (inv) { a = tSub(cst(CI_PI_2), a); }
	return select(a, tNeg(a), neg);
}

/** (f32 bits of RN32(v) for every v within e of hi + lo, 1) or (0, 0). */
fn certify(x: vec3<f32>) -> vec2<u32> {
	let r = opq(x.x + x.y);
	let a = abs(r);
	if (!(a >= A_MIN && a <= A_MAX) || BAD) { return vec2<u32>(0u, 0u); }
	let delta = opq(opq(x.x - r) + x.y);
	let ab = bitcast<u32>(a);
	let up = opq(bitcast<f32>(ab + 1u) - a);
	let dn = opq(a - bitcast<f32>(ab - 1u));
	let half = 0.5 * min(up, dn);
	let margin = (x.z * K_CERT) + (half * ULP_FRAC);
	if ((abs(delta) + margin) < half) { return vec2<u32>(bitcast<u32>(r), 1u); }
	return vec2<u32>(0u, 0u);
}
/** +1 / −1 when hi + lo ± e is certainly > 0 / < 0, else 0. */
fn sgnT(x: vec3<f32>) -> i32 {
	let m = x.z * K_CERT;
	if (x.x > 0.0 && x.x * K_SGN > m) { return 1; }
	if (x.x < 0.0 && -x.x * K_SGN > m) { return -1; }
	return 0;
}
// data inputs are bound as u32 and classified on their bits (a subnormal is seen, never flushed)
fn isNanBits(b: u32) -> bool { return (b & 0x7fffffffu) > 0x7f800000u; }
fn finiteBits(b: u32) -> bool { return (b & 0x7f800000u) != 0x7f800000u; }
fn subnormalBits(b: u32) -> bool { return (b & 0x7f800000u) == 0u && (b & 0x7fffffffu) != 0u; }
`;

export const STAGE_A_WGSL = /* wgsl */ `
${UNIFORM}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> consts: array<f32>;
@group(0) @binding(2) var<storage, read> td: array<u32>;
@group(0) @binding(3) var<storage, read_write> outA: array<vec2<u32>>;
${DD}
${TRACKED}
@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	ZERO = u.zero;
	BAD = false;
	let i = gid.x;
	if (i >= u.n) { return; }
	let tb = td[2u * i];
	let t = bitcast<f32>(tb);
	var res = vec2<u32>(0u, 0u);
	if (!finiteBits(tb) || subnormalBits(tb)) {
		// NaN / ±inf / subnormal (a flushing machine would see 0): the f64 path decides
	} else if ((tb & 0x7fffffffu) == 0u) {
		res = vec2<u32>(tb, 1u); // atan(±0) / DEG = ±0
	} else if (t <= u.noHit) {
		res = vec2<u32>(bitcast<u32>(-90.0), 1u);
	} else {
		let v = tMul(tAtan(vec3<f32>(t, 0.0, 0.0)), cst(CI_INV_DEG));
		res = certify(tWiden(v, abs(v.x) * REL_49));
	}
	outA[i] = res;
}
`;

export const STAGE_B_WGSL = /* wgsl */ `
${UNIFORM}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> consts: array<f32>;
@group(0) @binding(2) var<storage, read> az: array<f32>;
@group(0) @binding(3) var<storage, read> prof: array<u32>;
@group(0) @binding(4) var<storage, read_write> samp: array<f32>;
${DD}
${TRACKED}
fn trigE32(h: f32) -> f32 { return (abs(h) * U2_17) + E53; }
fn ldTrig(i: u32) -> vec3<f32> { let h = az[i]; return vec3<f32>(h, az[i + 1u], trigE32(h) + FLUSH_E); }

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	ZERO = u.zero;
	BAD = false;
	let i = gid.x;
	if (i >= u.n) { return; }
	let o = 8u * i;
	let eb = prof[2u * i];
	let db = prof[2u * i + 1u];
	let e0 = bitcast<f32>(eb);
	let d = bitcast<f32>(db);
	// validity on the bits: e0 > −90 (a zero / subnormal e0 is > −90) and d > 0 (sign clear, nonzero)
	let e0Valid = !isNanBits(eb) && ((eb & 0x7f800000u) == 0u || e0 > -90.0);
	let dValid = !isNanBits(db) && (db & 0x80000000u) == 0u && db != 0u;
	if (!e0Valid || !dValid) {
		// no terrain: δ = 0, flags 0 (certain)
		for (var q = 0u; q < 8u; q++) { samp[o + q] = 0.0; }
		return;
	}
	BAD = !(finiteBits(eb) && finiteBits(db)) || subnormalBits(eb) || subnormalBits(db);
	let theta = tMulF(cst(CI_DEG), e0);
	var cs: vec3<f32>;
	let sn = tSinCos(theta, &cs);
	let tanE = tDiv(sn, cs);
	let hD = tMulF(tAdd(tanE, tMulF(cst(CI_INV2R), d)), d);
	let eyeH = cst(CI_EYEH);
	let h2 = tAdd(eyeH, hD);
	let D = tMulF(cst(CI_INV_R), d);
	let sD = tSinSmall(D);
	let omc = tOmcSmall(D);
	let sA = ldTrig(8u * i);
	let cA = ldTrig(8u * i + 2u);
	let sP = cst(CI_SP);
	let cP = cst(CI_CP);
	let ds = tSub(tMul(tMul(cP, sD), cA), tMul(sP, omc));
	let s2 = tAdd(sP, ds);
	let Y = tMul(tMul(sA, sD), cP);
	let X = tSub(tSub(tMul(cP, cP), omc), tMul(sP, ds));
	let rhoL = tSqrt(tAdd(tMul(X, X), tMul(Y, Y)));
	let sinDL = tDiv(Y, rhoL);
	let omcDL = tDiv(tMul(Y, Y), tMul(rhoL, tAdd(rhoL, X)));
	let c2 = tSqrt(tMul(tAddF(tNeg(s2), 1.0), tAddF(s2, 1.0)));
	let sPs2 = tAdd(s2, sP);
	let dc = tNeg(tDiv(tMul(ds, sPs2), tAdd(c2, cP)));
	let E2 = cst(CI_E2);
	let rwo = tSqrt(tAddF(tNeg(tMul(E2, tMul(sP, sP))), 1.0));
	let rw2 = tSqrt(tAddF(tNeg(tMul(E2, tMul(s2, s2))), 1.0));
	let A = cst(CI_A);
	let No = tDiv(A, rwo);
	let dN = tDiv(tMul(tMul(tMul(A, E2), ds), sPs2), tMul(tMul(rw2, rwo), tAdd(rwo, rw2)));
	let dNh = tAdd(dN, h2);
	let Q2c2 = tMul(tAdd(No, dNh), c2);
	let P = tSub(tAdd(tMul(dNh, c2), tMul(No, dc)), tMul(Q2c2, omcDL));
	let ome2 = cst(CI_OME2);
	let Zd = tAdd(tMul(tAdd(tMul(dN, ome2), h2), s2), tMul(tMul(No, ome2), ds));
	// Math.tan(fl(e0·DEG)): the argument's rounding (1 + tan²)|θ|·2^-53 and tan's ULP, times d
	let ta = abs(tanE.x);
	let tanLump = ((d * U64_32) * ((abs(theta.x) * (1.0 + ta * ta)) + 2.0 * ta)) * K_LUMP;
	let lump = (u.lumpEnu + (u.lumpEnuRel * ((abs(eyeH.x) + abs(hD.x)) + d))) + tanLump;
	let E = tWiden(tMul(Q2c2, sinDL), lump);
	let Nn = tWiden(tAdd(tNeg(tMul(sP, P)), tMul(cP, Zd)), lump);
	let Uu = tAdd(tMul(cP, P), tMul(sP, Zd));
	let d2 = tAdd(tMul(E, E), tMul(Nn, Nn));
	let z = tWiden(tSub(tAdd(Uu, tMul(cst(CI_KAPPA), d2)), eyeH), lump);
	let rho = tSqrt(d2);
	var el = tMul(tAtan(tDiv(z, rho)), cst(CI_INV_DEG));
	el = tWiden(el, (abs(el.x) * REL_49) + TINY);
	let eR = tSub(tMul(E, cA), tMul(Nn, sA));
	let nR = tAdd(tMul(Nn, cA), tMul(E, sA));
	if (!((nR.x - nR.z) > 0.0 && abs(eR.x) < nR.x)) { BAD = true; }
	var dl = tMul(tAtan(tDiv(eR, nR)), cst(CI_INV_DEG));
	dl = tWiden(dl, AZ_LUMP);
	samp[o] = dl.x;
	samp[o + 1u] = dl.y;
	samp[o + 2u] = dl.z;
	samp[o + 3u] = el.x;
	samp[o + 4u] = el.y;
	samp[o + 5u] = el.z;
	// flags as exact floats (1 valid, 3 valid + uncertain), never subnormal bit patterns
	samp[o + 6u] = select(1.0, 3.0, BAD);
	samp[o + 7u] = 0.0;
}
`;

export const STAGE_C_WGSL = /* wgsl */ `
${UNIFORM}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> consts: array<f32>;
@group(0) @binding(2) var<storage, read> az: array<f32>;
@group(0) @binding(3) var<storage, read> samp: array<f32>;
@group(0) @binding(4) var<storage, read> cols: array<f32>;
@group(0) @binding(5) var<storage, read_write> outC: array<vec4<u32>>;
${DD}
${TRACKED}
/** Samples-buffer flags (exact floats 0 / 1 / 3); anything else reads as valid + uncertain. */
fn sflags(m: i32) -> u32 {
	let f = samp[8u * u32(m) + 6u];
	if (f == 0.0) { return 0u; }
	if (f == 1.0) { return 1u; }
	return 3u;
}
fn floorDiv(m: i32, n: i32) -> i32 { return select(-((-m + n - 1) / n), m / n, m >= 0); }
/** at(m) − c: (a_m − c) + 360 k + δ_m, m wrapped to the profile. */
fn diffAt(m: i32, n: i32, negC: vec3<f32>) -> vec3<f32> {
	let k = floorDiv(m, n);
	let mm = m - k * n;
	if ((sflags(mm) & 2u) != 0u) { BAD = true; }
	let ah = az[8u * u32(mm) + 4u];
	let a = vec3<f32>(ah, az[8u * u32(mm) + 5u], abs(ah) * U2_17 + FLUSH_E);
	var base = tAdd(a, negC);
	if (k != 0) { base = tAddF(base, 360.0 * f32(k)); }
	let s = 8u * u32(mm);
	return tAdd(base, vec3<f32>(samp[s], samp[s + 1u], samp[s + 2u] + FLUSH_E));
}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	ZERO = u.zero;
	BAD = false;
	let j = gid.x;
	if (j >= u.nCols) { return; }
	let n = i32(u.n);
	let cb = 8u * j;
	let negC = tNeg(vec3<f32>(cols[cb], cols[cb + 1u], abs(cols[cb]) * U2_17 + FLUSH_E));
	var i = i32(cols[cb + 6u]); // an exact small float (never an integer bit pattern)
	var ok = false;
	for (var it = 0; it < 16; it++) {
		let s = sgnT(diffAt(i, n, negC));
		if (s > 0) { i--; } else { ok = s < 0; break; }
	}
	if (ok) {
		ok = false;
		for (var it = 0; it < 16; it++) {
			let s = sgnT(diffAt(i + 1, n, negC));
			if (s < 0) { i++; } else { ok = s > 0; break; }
		}
	}
	if (!ok || BAD) { outC[j] = vec4<u32>(0u, 0u, 0u, 0u); return; }
	let j0 = i - floorDiv(i, n) * n;
	let j1 = i + 1 - floorDiv(i + 1, n) * n;
	if ((sflags(j0) & 1u) == 0u || (sflags(j1) & 1u) == 0u) {
		outC[j] = vec4<u32>(0u, 0u, 0u, 3u);
		return;
	}
	let dA = diffAt(i, n, negC);
	let dB = diffAt(i + 1, n, negC);
	let den0 = tSub(dB, dA);
	let md = cst(CI_MIN_DEN);
	let m = den0.z * K_CERT;
	var den = den0;
	if ((den0.x - m) > (md.x * K_UP)) {
		den = den0;
	} else if ((den0.x + m) < (md.x * K_DOWN)) {
		den = md;
	} else {
		outC[j] = vec4<u32>(0u, 0u, 0u, 0u);
		return;
	}
	let tq = tDiv(tNeg(dA), den);
	var t = tq;
	if (tq.x < 0.0 || (tq.x == 0.0 && tq.y < 0.0)) {
		t = vec3<f32>(0.0, 0.0, tq.z);
	} else if (tq.x > 1.0 || (tq.x == 1.0 && tq.y > 0.0)) {
		t = vec3<f32>(1.0, 0.0, tq.z);
	}
	t = tWiden(t, REL_49);
	let s0 = 8u * u32(j0);
	let s1 = 8u * u32(j1);
	let E0 = vec3<f32>(samp[s0 + 3u], samp[s0 + 4u], samp[s0 + 5u] + FLUSH_E);
	let E1 = vec3<f32>(samp[s1 + 3u], samp[s1 + 4u], samp[s1 + 5u] + FLUSH_E);
	let eDeg = tAdd(E0, tMul(tSub(E1, E0), t));
	let eRad = tWiden(tMul(eDeg, cst(CI_DEG)), ((abs(E0.x) + abs(E1.x)) * DEG32_UP) * REL_49);
	var c: vec3<f32>;
	let s = tSinCos(eRad, &c);
	let Sc = vec3<f32>(cols[cb + 2u], cols[cb + 3u], abs(cols[cb + 2u]) * U2_17 + FLUSH_E);
	let Cc = vec3<f32>(cols[cb + 4u], cols[cb + 5u], abs(cols[cb + 4u]) * U2_17 + FLUSH_E);
	let o0 = tMul(Sc, c);
	let o1 = tMul(Cc, c);
	let r0 = certify(tWiden(o0, (abs(o0.x) * REL_50) + TINY));
	let r1 = certify(tWiden(o1, (abs(o1.x) * REL_50) + TINY));
	let r2 = certify(tWiden(s, (abs(s.x) * REL_50) + TINY));
	let okAll = r0.y & r1.y & r2.y;
	outC[j] = select(vec4<u32>(0u, 0u, 0u, 0u), vec4<u32>(r0.x, r1.x, r2.x, 1u), okAll == 1u);
}
`;
