// Ridgeline tops: the fixed-distance sampling of src/lib/roll/mosaic/ridgelines.ts (traceViewpoint's
// 3600 columns x ~1200 distances), as one WGSL invocation per (column, slab). The horizon march
// (./horizon.wgsl.ts) walks an adaptive, mip-skipping schedule; the ridge trace samples EVERY distance of a
// fixed log-ish schedule, so this is a sibling kernel over the same uploaded mosaic pages (index.ts
// uploadMosaics), with the horizon kernel's f32 position scheme (see its header): the eye's Mercator
// pixel position is split into integer + fraction in f64 on the CPU, the great-circle offsets come from
// difference terms (bp), heights are interpolated relative to the eye (hi/lo pair), the bilinear weights
// and the bounds test match mosaicHeight. The output is the slab maximum of
//   t = (h - eyeH) / d - d * inv2R      (angle = atan(t), monotone, so the max of t is the max angle)
// and the distance it occurs at (first of equal values, like the CPU's strict >); the CPU applies atan
// in f64. No atomics, no clears: every in-range invocation writes both words.
//
// @workgroup_size(64, 1, 1): x = column, y = slab. Adjacent columns walk near-identical paths.

export const RIDGES_WGSL = /* wgsl */ `
struct U {
	nCols: u32,
	nSlabs: u32,
	nDist: u32,
	nRings: u32,
	azOff: u32,
	distOff: u32,
	ringOff: u32,
	slabOff: u32,
	inv2R: f32,
	/** Always 0: an opaque value the compiler can't fold. */
	zero: u32,
	h0: f32,
	h0lo: f32,
	sinP1: f32,
	cosP1: f32,
	_p0: u32,
	_p1: u32,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> params: array<u32>;
@group(0) @binding(2) var<storage, read> pg0: array<f32>;
@group(0) @binding(3) var<storage, read> pg1: array<f32>;
@group(0) @binding(4) var<storage, read> pg2: array<f32>;
@group(0) @binding(5) var<storage, read> pg3: array<f32>;
@group(0) @binding(6) var<storage, read_write> outTD: array<f32>;

const RING_WORDS: u32 = 12u;
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
	let ic = gid.x;
	let s = gid.y;
	if (ic >= u.nCols || s >= u.nSlabs) { return; }
	let sinA = pf(u.azOff + 2u * ic);
	let cosA = pf(u.azOff + 2u * ic + 1u);
	let lo = params[u.slabOff + 2u * s];
	let hi = params[u.slabOff + 2u * s + 1u];
	let h0 = u.h0;
	let h0lo = u.h0lo;
	let sinP1 = u.sinP1;
	let cosP1 = u.cosP1;
	let c2 = cosP1 * cosP1;
	let inv2R = u.inv2R;
	var has = false;
	var tBest: f32 = 0.0;
	var dBest: f32 = 0.0;
	for (var i: u32 = lo; i < hi; i++) {
		let rec = u.distOff + 4u * i;
		let dd = pf(rec);
		let b = bp(pf(rec + 1u), pf(rec + 2u), sinA, cosA, sinP1, cosP1, c2);
		let rb = u.ringOff + params[rec + 3u] * RING_WORDS;
		let page = params[rb];
		let dataOff = params[rb + 1u];
		let W = params[rb + 2u];
		let H = params[rb + 3u];
		let sx = pf(rb + 4u);
		let uf = pf(rb + 6u) + b.x * sx;
		let vf = pf(rb + 8u) + b.y * sx;
		let flu = floor(uf);
		let flv = floor(vf);
		let xi = bitcast<i32>(params[rb + 5u]) + i32(flu);
		let yi = bitcast<i32>(params[rb + 7u]) + i32(flv);
		// u = xi + fx with 0 <= fx < 1: (u >= 0 && u < W - 1) <=> (xi >= 0 && xi < W - 1), exactly.
		if (xi < 0 || yi < 0 || xi >= i32(W) - 1 || yi >= i32(H) - 1) { continue; }
		let fx = uf - flu;
		let fy = vf - flv;
		let k = dataOff + u32(yi) * W + u32(xi);
		let a0 = opaque(ld(page, k) - h0) - h0lo;
		let a1 = opaque(ld(page, k + 1u) - h0) - h0lo;
		let c0 = opaque(ld(page, k + W) - h0) - h0lo;
		let c1 = opaque(ld(page, k + W + 1u) - h0) - h0lo;
		let hr = a0 + (a1 - a0) * fx + (c0 - a0 + (a0 - a1 - c0 + c1) * fx) * fy;
		if (hr + h0 > MIN_VALID) {
			let t = hr / dd - dd * inv2R;
			if (!has || t > tBest) {
				has = true;
				tBest = t;
				dBest = dd;
			}
		}
	}
	let o = 2u * (s * u.nCols + ic);
	outTD[o] = select(-BIG, tBest, has);
	outTD[o + 1u] = dBest;
}
`;
