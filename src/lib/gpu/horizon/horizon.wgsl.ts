// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL twin of horizon-fast/march.ts marchRay: one invocation per (eye, azimuth). Layouts are written by
// ./index.ts (the per-chunk params packing in computeHorizonGpu: the "Rings", "Azimuths" and eye blocks); keep the two in sync.
//
// @workgroup_size(64, 1, 1): x = azimuth, y = eye. Neighbouring azimuths walk almost the same Mercator
// path, skip the same mip blocks and stop at similar distances, so a 64-wide group of adjacent rays
// diverges little. 64 is also a whole number of Apple (32) and AMD/NVIDIA (32/64) SIMD widths.
//
// Precision (f32 on the GPU vs f64 on the CPU):
// - The eye's absolute Mercator pixel position is computed on the CPU in f64 per ring (ue, ve). The GPU only
//   adds small offsets: the great-circle breakpoint's Δlon/2π and Δ(atanh sin φ)/2π, formed from
//   difference terms (sinφ2 − sinφ1, 1 − cos D) so nothing cancels, and scaled by the ring's worldPx.
// - atan / atanh of those small arguments use odd series (|z| < 0.2 → truncation < 1e-9 relative), not the
//   WGSL builtins, whose spec accuracy is only ~4096 ULP.
// - sin/cos of the azimuths come from the CPU (f64, rounded to f32).
// - The final atan(tBest) → degrees is done on the CPU in f64.
// - Sample positions are (integer pixel of the eye) + (f32 fraction + march offset), so the bounds test is
//   exact and near-eye samples keep sub-milli-pixel precision.
// - Heights are interpolated relative to the eye (eye height as an f32 hi/lo pair), so (h − h0)/d stays
//   accurate at d of a few metres.
// - The march distance is a Kahan sum (thousands of f32 adds per ray).

export const HORIZON_WGSL = /* wgsl */ `
struct U {
	nAz: u32,
	nEyes: u32,
	eyeStride: u32,
	azOff: u32,
	eyeOff: u32,
	ringOff: u32,
	nRings: u32,
	mipSkip: u32,
	stepFactor: f32,
	nearFactor: f32,
	inv2R: f32,
	maxIter: u32,
	/** Always 0: an opaque value the compiler can't fold (keeps the Kahan sum from being simplified away). */
	zero: u32,
	_p1: u32,
	_p2: u32,
	_p3: u32,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> params: array<u32>;
@group(0) @binding(2) var<storage, read> pg0: array<f32>;
@group(0) @binding(3) var<storage, read> pg1: array<f32>;
@group(0) @binding(4) var<storage, read> pg2: array<f32>;
@group(0) @binding(5) var<storage, read> pg3: array<f32>;
@group(0) @binding(6) var<storage, read_write> outTD: array<f32>;
@group(0) @binding(7) var<storage, read_write> stats: array<atomic<u32>>;

const RING_STRIDE: u32 = 40u;
const INV_2PI: f32 = 0.15915494309189535;
const MIN_VALID: f32 = -1000.0;
const BIG: f32 = 3.0e38;

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

// atan(z) for |z| < 0.2 (odd series to z^13), builtin otherwise.
fn atanS(y: f32, x: f32) -> f32 {
	if (x > 0.0 && abs(y) < 0.2 * x) {
		let z = y / x;
		let z2 = z * z;
		return z * (1.0 + z2 * (-1.0 / 3.0 + z2 * (1.0 / 5.0 + z2 * (-1.0 / 7.0 + z2 * (1.0 / 9.0 + z2 * (-1.0 / 11.0 + z2 * (1.0 / 13.0)))))));
	}
	return atan2(y, x);
}

// atanh(z) for |z| < 0.2 (odd series to z^13), log form otherwise.
fn atanhS(z: f32) -> f32 {
	if (abs(z) < 0.2) {
		let z2 = z * z;
		return z * (1.0 + z2 * (1.0 / 3.0 + z2 * (1.0 / 5.0 + z2 * (1.0 / 7.0 + z2 * (1.0 / 9.0 + z2 * (1.0 / 11.0 + z2 * (1.0 / 13.0)))))));
	}
	return 0.5 * log((1.0 + z) / (1.0 - z));
}

// Normalised Mercator offset (Δx, Δy) of the great-circle point at angular distance D (sinD, omc = 1 − cos D)
// along azimuth (sinA, cosA) from the eye (sinP1, cosP1, c2 = cosP1²).
fn bp(sinD: f32, omc: f32, sinA: f32, cosA: f32, sinP1: f32, cosP1: f32, c2: f32) -> vec2<f32> {
	let ds = cosP1 * sinD * cosA - sinP1 * omc; // sinφ2 − sinφ1
	let den = c2 - sinP1 * ds; // 1 − sinφ1·sinφ2
	let dl = atanS(sinA * sinD * cosP1, den - omc); // cos D − sinφ1·sinφ2
	let dy = atanhS(ds / den); // atanh(sinφ2) − atanh(sinφ1)
	return vec2<f32>(dl * INV_2PI, -dy * INV_2PI);
}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let ia = gid.x;
	let e = gid.y;
	if (ia >= u.nAz || e >= u.nEyes) { return; }
	let sinA = pf(u.azOff + 2u * ia);
	let cosA = pf(u.azOff + 2u * ia + 1u);
	let eb = u.eyeOff + e * u.eyeStride;
	let h0 = pf(eb);
	let h0lo = pf(eb + 4u); // eye height = h0 + h0lo (f32 pair)
	let sinP1 = pf(eb + 1u);
	let cosP1 = pf(eb + 2u);
	let nb = params[eb + 3u];
	let c2 = cosP1 * cosP1;
	let sb = eb + 8u + 4u * u.nRings;
	let inv2R = u.inv2R;
	let stepFactor = u.stepFactor;
	let nearFactor = u.nearFactor;

	var has = false;
	var tBest: f32 = 0.0;
	var dBest: f32 = 0.0;
	var samples: u32 = 0u;
	var skips: u32 = 0u;
	var iter: u32 = 0u;
	var d = pf(sb);
	// Kahan compensation of the march distance: the true distance is d − dc. Thousands of f32 adds
	// would otherwise drift the sample positions away from the CPU's f64 march.
	var dc: f32 = 0.0;
	var b0 = bp(pf(sb + 1u), pf(sb + 2u), sinA, cosA, sinP1, cosP1, c2);
	for (var k: u32 = 0u; k + 1u < nb; k++) {
		let s0 = sb + 4u * k;
		let r = params[s0 + 3u];
		let dA = pf(s0);
		let dB = pf(s0 + 4u);
		let b1 = bp(pf(s0 + 5u), pf(s0 + 6u), sinA, cosA, sinP1, cosP1, c2);
		let rb = u.ringOff + r * RING_STRIDE;
		let page = params[rb];
		let dataOff = params[rb + 1u];
		let W = params[rb + 2u];
		let nMips = select(0u, params[rb + 3u], u.mipSkip != 0u);
		let H = params[rb + 4u];
		let sx = pf(rb + 6u);
		let step = pf(rb + 7u);
		let S0 = params[rb + 8u];
		// Eye pixel position in this ring's window = integer part + f32 fraction (from f64 on the CPU); the
		// march offsets are added to the fraction only, so sample positions keep sub-milli-pixel precision
		// near the eye instead of the ~2e-4 px ULP of a 4-digit f32 pixel coordinate.
		let pe = eb + 8u + 4u * r;
		let ueI = bitcast<i32>(params[pe]);
		let veI = bitcast<i32>(params[pe + 2u]);
		let uA = pf(pe + 1u) + b0.x * sx;
		let vA = pf(pe + 3u) + b0.y * sx;
		let inv = 1.0 / (dB - dA);
		let du = (b1.x - b0.x) * sx * inv;
		let dv = (b1.y - b0.y) * sx * inv;
		var noTest: f32 = 0.0;
		while (d < dB) {
			iter++;
			if (iter > u.maxIter) { break; }
			let dt = d - dc; // the compensated march distance
			let f = dt - dA;
			let uf = uA + f * du;
			let vf = vA + f * dv;
			let flu = floor(uf);
			let flv = floor(vf);
			let xi = ueI + i32(flu);
			let yi = veI + i32(flv);
			let fx = uf - flu;
			let fy = vf - flv;
			// u = xi + fx with 0 <= fx < 1: (u >= 0 && u < W - 1) <=> (xi >= 0 && xi < W - 1), exactly.
			if (xi >= 0 && yi >= 0 && xi < i32(W) - 1 && yi < i32(H) - 1) {
				let x0 = u32(xi);
				let y0 = u32(yi);
				if (nMips > 0u && dt >= noTest && has) {
					// Bottom-up: finest level first, grow while the block is hidden.
					var S = S0;
					var skipTo: f32 = -1.0;
					for (var L: u32 = 0u; L < nMips; L++) {
						let icu = x0 / S; // = floor(u / S)
						let icv = y0 / S;
						let mw = params[rb + 24u + L];
						let mh = params[rb + 32u + L];
						if (icu >= mw || icv >= mh) { break; }
						let mo = params[rb + 16u + L];
						let o = mo + icv * mw + icu;
						let cu1 = icu + 1u < mw;
						let cv1 = icv + 1u < mh;
						var Hm = ld(page, o);
						if (cu1) { Hm = max(Hm, ld(page, o + 1u)); }
						if (cv1) {
							Hm = max(Hm, ld(page, o + mw));
							if (cu1) { Hm = max(Hm, ld(page, o + mw + 1u)); }
						}
						// Pixels from u to the block's edges (integer part exact).
						var ex = BIG;
						if (du > 0.0) { ex = (f32((icu + 1u) * S - x0) - fx) / du; } else if (du < 0.0) { ex = (f32(icu * S) - f32(x0) - fx) / du; }
						var ey = BIG;
						if (dv > 0.0) { ey = (f32((icv + 1u) * S - y0) - fy) / dv; } else if (dv < 0.0) { ey = (f32(icv * S) - f32(y0) - fy) / dv; }
						let far = dt + min(ex, ey);
						let a = Hm - h0;
						let bound = select(a / far, a / dt, a >= 0.0) - dt * inv2R;
						if (bound > tBest) {
							if (L == 0u) { noTest = far; }
							break;
						}
						skipTo = far;
						S = S * 2u;
					}
					if (skipTo >= 0.0) {
						if (skipTo > dB) { skipTo = dB; }
						// f32: d + 1e-3 == d beyond 16 km, so also step at least one ULP-ish.
						let minNext = max(dt + 1e-3, dt * (1.0 + 2.4e-7));
						d = select(minNext, skipTo, skipTo > minNext);
						dc = 0.0;
						skips++;
						continue;
					}
				}
				let i = dataOff + y0 * W + x0;
				// Bilinear on heights relative to the eye: near the camera (d of a few metres) an f32 h − h0 formed
				// after interpolation would carry the ~3e-5 m rounding of a 4-digit height, i.e. ~1e-3° at 2 m.
				// opaque(): Metal compiles WGSL with fast math, which would re-associate (x − h0) − h0lo into
				// x − (h0 + h0lo) and bring back the f32 rounding of the eye height (1.2e-5 m at 557.2 m).
				let a0 = opaque(ld(page, i) - h0) - h0lo;
				let a1 = opaque(ld(page, i + 1u) - h0) - h0lo;
				let c0 = opaque(ld(page, i + W) - h0) - h0lo;
				let c1 = opaque(ld(page, i + W + 1u) - h0) - h0lo;
				let hr = a0 + (a1 - a0) * fx + (c0 - a0 + (a0 - a1 - c0 + c1) * fx) * fy;
				samples++;
				if (hr + h0 > MIN_VALID) {
					let t = hr / dt - dt * inv2R;
					if (!has || t > tBest) {
						has = true;
						tBest = t;
						dBest = dt;
					}
				}
			}
			let s = stepFactor * d;
			var sc = nearFactor * d;
			if (sc > step) { sc = step; } else if (sc < 0.25) { sc = 0.25; }
			let y = max(s, sc) - dc;
			let dn = d + y;
			dc = (opaque(dn) - d) - y;
			d = dn;
		}
		b0 = b1;
	}
	let o = 2u * (e * u.nAz + ia);
	outTD[o] = select(-BIG, tBest, has);
	outTD[o + 1u] = dBest;
	atomicAdd(&stats[3u * e], samples);
	atomicAdd(&stats[3u * e + 1u], skips);
	if (iter > u.maxIter) { atomicAdd(&stats[3u * e + 2u], 1u); }
}
`;
