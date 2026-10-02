// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL twin of ./cpu.ts traceRay (the CPU f64 code is the reference). One invocation per pixel (mode 0:
// hit range + ENU xyz, range = -1 for sky) or per azimuth (mode 1: the top-most terrain slope, by
// bisection on q = s / (1 + |s|); the CPU does atan). Layouts are written by ./gpu.ts packScene.
//
// f32 notes (same recipes as src/lib/gpu/horizon/horizon.wgsl.ts, which solved them for the march):
// - the eye's Mercator position per ring is an integer pixel plus an f32 fraction (computed in f64 on the
//   CPU); the march offsets are added to the fraction only;
// - breakpoint offsets use sinφ2 − sinφ1 and 1 − cos D and atan / atanh odd series, never the builtins;
// - heights are interpolated relative to the eye, the eye height as an f32 hi/lo pair, behind opaque() so
//   Metal's fast math cannot re-associate it away;
// - the distance lattice is d = 2^k + j · (2^k / n_k): no accumulated sums, so no Kahan term.

export const RAYCAST_WGSL = /* wgsl */ `
struct U {
	mode: u32,
	W: u32,
	H: u32,
	stride: u32,
	fwd: vec4<f32>,
	right: vec4<f32>,
	up: vec4<f32>,
	tanX: f32,
	tanY: f32,
	azStep: f32,
	nAz: u32,
	zero: u32,
	mipSkip: u32,
	refineIters: u32,
	columnIters: u32,
	maxD: f32,
	minD: f32,
	c: f32,
	h0: f32,
	h0lo: f32,
	sinP1: f32,
	cosP1: f32,
	nSeg: u32,
	nOct: u32,
	nRings: u32,
	k0: u32,
	azOff: u32,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> params: array<u32>;
@group(0) @binding(2) var<storage, read> pg0: array<f32>;
@group(0) @binding(3) var<storage, read> pg1: array<f32>;
@group(0) @binding(4) var<storage, read> pg2: array<f32>;
@group(0) @binding(5) var<storage, read> pg3: array<f32>;
@group(0) @binding(6) var<storage, read_write> outBuf: array<f32>;

const OFF_SEG: u32 = 96u;
const OFF_RING: u32 = 1696u;
const RING_STRIDE: u32 = 48u;
const INV_2PI: f32 = 0.15915494309189535;
const MIN_VALID: f32 = -1000.0;
const BIG: f32 = 3.0e38;
const NEG: f32 = -1.0e30;
const EARTH_R: f32 = 6371008.8;
const MAX_SLOPE: f32 = 1.0e6;

fn pf(i: u32) -> f32 { return bitcast<f32>(params[i]); }
fn opaque(x: f32) -> f32 { return bitcast<f32>(bitcast<u32>(x) ^ u.zero); }

fn ld(page: u32, i: u32) -> f32 {
	switch page {
		case 0u: { return pg0[i]; }
		case 1u: { return pg1[i]; }
		case 2u: { return pg2[i]; }
		default: { return pg3[i]; }
	}
}

fn atanS(y: f32, x: f32) -> f32 {
	if (x > 0.0 && abs(y) < 0.2 * x) {
		let z = y / x;
		let z2 = z * z;
		return z * (1.0 + z2 * (-1.0 / 3.0 + z2 * (1.0 / 5.0 + z2 * (-1.0 / 7.0 + z2 * (1.0 / 9.0 + z2 * (-1.0 / 11.0 + z2 * (1.0 / 13.0)))))));
	}
	return atan2(y, x);
}

fn atanhS(z: f32) -> f32 {
	if (abs(z) < 0.2) {
		let z2 = z * z;
		return z * (1.0 + z2 * (1.0 / 3.0 + z2 * (1.0 / 5.0 + z2 * (1.0 / 7.0 + z2 * (1.0 / 9.0 + z2 * (1.0 / 11.0 + z2 * (1.0 / 13.0)))))));
	}
	return 0.5 * log((1.0 + z) / (1.0 - z));
}

// sin(a) for |a| < 0.05 (ground angles up to the 150 km cap are 0.024 rad): odd series, not the builtin
fn sinS(a: f32) -> f32 {
	let a2 = a * a;
	return a * (1.0 + a2 * (-1.0 / 6.0 + a2 * (1.0 / 120.0 + a2 * (-1.0 / 5040.0))));
}

// ---- distance lattice (params words 0..95: base, n, spacing per octave)
fn octBase(o: u32) -> f32 { return pf(o * 3u); }
fn octN(o: u32) -> u32 { return params[o * 3u + 1u]; }
fn octSp(o: u32) -> f32 { return pf(o * 3u + 2u); }
fn latticeD(o: u32, j: u32) -> f32 { return octBase(o) + f32(j) * octSp(o); }

// smallest lattice index with distance >= d, searching from octave o
fn latticeCeil(d: f32, o0: u32) -> vec2<u32> {
	var o = o0;
	while (o + 1u < u.nOct && d >= octBase(o + 1u)) { o++; }
	var j = u32(max(ceil((d - octBase(o)) / octSp(o)), 0.0));
	if (j >= octN(o)) { o++; j = 0u; }
	return vec2<u32>(o, j);
}

// ---- breakpoint offset (normalised Mercator, relative to the eye)
fn bp(i: u32, sinA: f32, cosA: f32) -> vec2<f32> {
	let b = OFF_SEG + 4u * i;
	let sinD = pf(b + 1u);
	let omc = pf(b + 2u);
	let sinP1 = u.sinP1;
	let cosP1 = u.cosP1;
	let ds = cosP1 * sinD * cosA - sinP1 * omc;
	let den = cosP1 * cosP1 - sinP1 * ds;
	let dl = atanS(sinA * sinD * cosP1, den - omc);
	let dy = atanhS(ds / den);
	return vec2<f32>(dl * INV_2PI, -dy * INV_2PI);
}

// ---- current ring state (private globals so the helpers need no long argument lists)
var<private> gPage: u32;
var<private> gDataOff: u32;
var<private> gW: u32;
var<private> gH: u32;
var<private> gUeI: i32;
var<private> gVeI: i32;
var<private> gUf: f32;
var<private> gVf: f32;

fn minRay(s: f32, c: f32, a: f32, b: f32) -> f32 {
	if (s < 0.0) {
		let xs = -s / (2.0 * c);
		if (xs > a && xs < b) { return -(s * s) / (4.0 * c); }
	}
	return min(s * a + c * a * a, s * b + c * b * b);
}

// terrain height relative to the eye at ring-local position (uf, vf); NEG outside the window or no data
fn sampleRel(uf: f32, vf: f32) -> f32 {
	let flu = floor(uf);
	let flv = floor(vf);
	let xi = gUeI + i32(flu);
	let yi = gVeI + i32(flv);
	if (xi < 0 || yi < 0 || xi >= i32(gW) - 1 || yi >= i32(gH) - 1) { return NEG; }
	let fx = uf - flu;
	let fy = vf - flv;
	let i = gDataOff + u32(yi) * gW + u32(xi);
	let h0 = u.h0;
	let h0lo = u.h0lo;
	let a0 = opaque(ld(gPage, i) - h0) - h0lo;
	let a1 = opaque(ld(gPage, i + 1u) - h0) - h0lo;
	let c0 = opaque(ld(gPage, i + gW) - h0) - h0lo;
	let c1 = opaque(ld(gPage, i + gW + 1u) - h0) - h0lo;
	let hr = a0 + (a1 - a0) * fx + (c0 - a0 + (a0 - a1 - c0 + c1) * fx) * fy;
	if (hr + h0 > MIN_VALID) { return hr; }
	return NEG;
}

// First hit of the ray: vec2(ground arc distance, terrain height above the eye); x < 0 = no hit.
fn trace(sinA: f32, cosA: f32, s: f32, refine: bool) -> vec2<f32> {
	let c = u.c;
	let maxD = u.maxD;
	let nSeg = u.nSeg;
	let nOct = u.nOct;
	let mipSkipOn = u.mipSkip != 0u;
	var idx = latticeCeil(u.minD, 0u);
	let idx0 = idx;
	var seg: i32 = -1;
	var dA: f32 = 0.0;
	var dB: f32 = -BIG;
	var uA: f32 = 0.0;
	var vA: f32 = 0.0;
	var du: f32 = 0.0;
	var dv: f32 = 0.0;
	var sx: f32 = 1.0;
	var rb: u32 = 0u;
	var nMips: u32 = 0u;
	var S0: u32 = 1u;
	var noTest: f32 = 0.0;
	var b0 = vec2<f32>(0.0, 0.0);
	var b1 = vec2<f32>(0.0, 0.0);
	var hitRel: f32 = 0.0;
	var hitIdx = vec2<u32>(0u, 0u);
	var found = false;
	loop {
		if (idx.x >= nOct) { break; }
		let d = latticeD(idx.x, idx.y);
		if (!(d < maxD)) { break; }
		if (d >= dB) {
			let prev = seg;
			var sg = max(seg, 0);
			loop {
				if (u32(sg) + 1u < nSeg && d >= pf(OFF_SEG + 4u * u32(sg + 1))) { sg++; } else { break; }
			}
			seg = sg;
			if (seg == prev + 1 && prev >= 0) { b0 = b1; } else { b0 = bp(u32(seg), sinA, cosA); }
			b1 = bp(u32(seg) + 1u, sinA, cosA);
			let sb = OFF_SEG + 4u * u32(seg);
			dA = pf(sb);
			dB = pf(sb + 4u);
			rb = OFF_RING + params[sb + 3u] * RING_STRIDE;
			gPage = params[rb];
			gDataOff = params[rb + 1u];
			gW = params[rb + 2u];
			nMips = select(0u, params[rb + 3u], mipSkipOn);
			gH = params[rb + 4u];
			gUeI = bitcast<i32>(params[rb + 5u]);
			gUf = pf(rb + 6u);
			gVeI = bitcast<i32>(params[rb + 7u]);
			gVf = pf(rb + 8u);
			sx = pf(rb + 9u);
			S0 = params[rb + 10u];
			let inv = 1.0 / (dB - dA);
			uA = gUf + b0.x * sx;
			vA = gVf + b0.y * sx;
			du = (b1.x - b0.x) * sx * inv;
			dv = (b1.y - b0.y) * sx * inv;
			noTest = 0.0;
		}
		let f = d - dA;
		let uf = uA + f * du;
		let vf = vA + f * dv;
		let flu = floor(uf);
		let flv = floor(vf);
		let xi = gUeI + i32(flu);
		let yi = gVeI + i32(flv);
		if (xi >= 0 && yi >= 0 && xi < i32(gW) - 1 && yi < i32(gH) - 1) {
			let x0 = u32(xi);
			let y0 = u32(yi);
			let fx = uf - flu;
			let fy = vf - flv;
			if (nMips > 0u && d >= noTest) {
				var S = S0;
				var skipTo: f32 = -1.0;
				for (var L: u32 = 0u; L < nMips; L++) {
					let icu = x0 / S;
					let icv = y0 / S;
					let mw = params[rb + 24u + L];
					let mh = params[rb + 32u + L];
					if (icu >= mw || icv >= mh) { break; }
					let o = params[rb + 16u + L] + icv * mw + icu;
					let cu1 = icu + 1u < mw;
					let cv1 = icv + 1u < mh;
					var Hm = ld(gPage, o);
					if (cu1) { Hm = max(Hm, ld(gPage, o + 1u)); }
					if (cv1) {
						Hm = max(Hm, ld(gPage, o + mw));
						if (cu1) { Hm = max(Hm, ld(gPage, o + mw + 1u)); }
					}
					var ex = BIG;
					if (du > 0.0) { ex = (f32((icu + 1u) * S - x0) - fx) / du; } else if (du < 0.0) { ex = (f32(icu * S) - f32(x0) - fx) / du; }
					var ey = BIG;
					if (dv > 0.0) { ey = (f32((icv + 1u) * S - y0) - fy) / dv; } else if (dv < 0.0) { ey = (f32(icv * S) - f32(y0) - fy) / dv; }
					let far = d + min(ex, ey);
					if (Hm - u.h0 < minRay(s, c, d, far)) {
						skipTo = far;
						S = S * 2u;
					} else {
						if (L == 0u) { noTest = far; }
						break;
					}
				}
				if (skipTo >= 0.0) {
					if (skipTo > dB) { skipTo = dB; }
					let nx = latticeCeil(skipTo, idx.x);
					if (nx.x > idx.x || (nx.x == idx.x && nx.y > idx.y)) {
						idx = nx;
					} else {
						idx = vec2<u32>(idx.x, idx.y + 1u);
						if (idx.y >= octN(idx.x)) { idx = vec2<u32>(idx.x + 1u, 0u); }
					}
					continue;
				}
			}
			let hr = sampleRel(uf, vf);
			if (hr > NEG && s * d + c * d * d <= hr) {
				found = true;
				hitIdx = idx;
				hitRel = hr;
				break;
			}
		}
		idx = vec2<u32>(idx.x, idx.y + 1u);
		if (idx.y >= octN(idx.x)) { idx = vec2<u32>(idx.x + 1u, 0u); }
	}
	if (!found) { return vec2<f32>(-1.0, 0.0); }
	let dHit = latticeD(hitIdx.x, hitIdx.y);
	if (!refine || (hitIdx.x == idx0.x && hitIdx.y == idx0.y)) { return vec2<f32>(dHit, hitRel); }
	var po = hitIdx.x;
	var pj = hitIdx.y;
	if (pj == 0u) { po = po - 1u; pj = octN(po) - 1u; } else { pj = pj - 1u; }
	var lo = max(latticeD(po, pj), dA);
	var hi = dHit;
	var hiRel = hitRel;
	for (var it: u32 = 0u; it < u.refineIters; it++) {
		let mid = 0.5 * (lo + hi);
		let fm = mid - dA;
		let hm = sampleRel(uA + fm * du, vA + fm * dv);
		if (hm > NEG && s * mid + c * mid * mid <= hm) { hi = mid; hiRel = hm; } else { lo = mid; }
	}
	return vec2<f32>(hi, hiRel);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	if (u.mode == 1u) {
		let ia = gid.y * u.W + gid.x;
		if (ia >= u.nAz) { return; }
		let sinA = pf(u.azOff + 2u * ia);
		let cosA = pf(u.azOff + 2u * ia + 1u);
		let lim = 0.99999;
		var lo = -lim;
		var hi = lim;
		if (!(trace(sinA, cosA, lo / (1.0 - abs(lo)), false).x >= 0.0)) {
			outBuf[ia] = NEG;
			return;
		}
		for (var it: u32 = 0u; it < u.columnIters; it++) {
			let mid = 0.5 * (lo + hi);
			if (trace(sinA, cosA, mid / (1.0 - abs(mid)), false).x >= 0.0) { lo = mid; } else { hi = mid; }
		}
		outBuf[ia] = lo / (1.0 - abs(lo));
		return;
	}
	if (gid.x >= u.W || gid.y >= u.H) { return; }
	let fullW = f32(u.W * u.stride);
	let fullH = f32(u.H * u.stride);
	let px = ((f32(gid.x * u.stride + (u.stride >> 1u)) + 0.5) / fullW * 2.0 - 1.0) * u.tanX;
	let py = (1.0 - (f32(gid.y * u.stride + (u.stride >> 1u)) + 0.5) / fullH * 2.0) * u.tanY;
	let dx = u.fwd.x + u.right.x * px + u.up.x * py;
	let dy = u.fwd.y + u.right.y * px + u.up.y * py;
	let dz = u.fwd.z + u.right.z * px + u.up.z * py;
	let rho = sqrt(dx * dx + dy * dy);
	var sinA: f32 = 0.0;
	var cosA: f32 = 1.0;
	var s: f32 = select(-MAX_SLOPE, MAX_SLOPE, dz > 0.0);
	if (rho > 1.0e-12) {
		sinA = dx / rho;
		cosA = dy / rho;
		s = clamp(dz / rho, -MAX_SLOPE, MAX_SLOPE);
	}
	let o = 4u * (gid.y * u.W + gid.x);
	let hit = trace(sinA, cosA, s, true);
	if (hit.x < 0.0) {
		outBuf[o] = 0.0;
		outBuf[o + 1u] = 0.0;
		outBuf[o + 2u] = 0.0;
		outBuf[o + 3u] = -1.0;
		return;
	}
	let ang = hit.x / EARTH_R;
	let sh = sinS(0.5 * ang);
	let hAbs = hit.y; // relative to the eye
	// true ENU in the eye tangent frame: rho = (R + h) sin(ang), up = (h - h0) cos(ang) - 2 (R + h0) sin^2(ang / 2)
	let sa = sinS(ang);
	let ca = 1.0 - 2.0 * sh * sh;
	let rg = (EARTH_R + u.h0 + hAbs) * sa;
	let e = rg * sinA;
	let n = rg * cosA;
	let z = hAbs * ca - 2.0 * (EARTH_R + u.h0) * sh * sh;
	outBuf[o] = e;
	outBuf[o + 1u] = n;
	outBuf[o + 2u] = z;
	outBuf[o + 3u] = sqrt(e * e + n * n + z * z);
}
`;
