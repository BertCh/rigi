// WGSL: CERTIFIED interval of align.ts scorePose (stride 1, coarse or fine map) for many poses in one
// dispatch, for autoAlign's coordinate-descent refine (../../align.ts Descent). One workgroup per
// pose, the same projection and operation order as the CPU and as ./pose-grid.wgsl.ts, but every
// float32 step carries an explicit error bound against the CPU's float64 value, so the host can turn
// the outputs into a true upper bound of the CPU score (./pose-bound.ts certifiedUpper).
//
// Per direction (u = 2^-24 is the f32 unit roundoff; the code's U32 = 2^-23 = 2u is the unit of every
// bound below; a WGSL division is accurate to 2.5 ULP, and 1 ULP ≤ 2u·|x|, so ≤ 5u relative):
//  - dot products d·f, d·r, d·up: |GPU − CPU| ≤ Ed = 8·u32·|d|₁ (basis rounded to f32: ≤ u·|d|₁;
//    3-term f32 dot: ≤ 3u·|d|₁ in any order, FMA or not; so Ed has 4× slack).
//  - z: a direction whose z is within Ed (+ the f32-vs-f64 gap of the literal 0.1) of 0.1 is
//    "z-ambiguous" unless its u is certainly outside the frame either way (|u − 0.5| > 0.49 even with
//    the most favourable z and d·r); a z-ambiguous one (nAmbZ > 0) → the host gives no bound.
//  - u, v: q = (d·r)/z/(t·aspect)/2. First order: |Δq| ≤ |q|·(Ed/z + rel) + Ed/(z·t·aspect·2), with
//    rel = 16·U32 = 32u covering t and aspect rounded to f32 (u each), their product (u) and three
//    divisions (5u each): ≈ 18u, so ~1.8× slack (v: no aspect, ≈ 16u, 2×); all × 1.25 for the
//    second-order terms. Then 0.5 ± q adds ≤ u (charged 2·U32 = 4u).
//    A direction certainly outside one edge (beyond that bound) is out, as on the CPU. One within
//    the bound of an edge and certainly inside the others is "clip-ambiguous": the CPU may or may
//    not count it. It goes to nAmb and ambHi += max(0, its highest candidate term) instead of n /
//    sumHi, so the host can bound every count n..n+nAmb the CPU might have seen.
//  - pixel: X = u·w carries |ΔX| ≤ Eu·w + U32·|X| =: m. The CPU's floor lies in floor(X − m) ..
//    floor(X + m). If that span is one pixel the term is the CPU's; if two, the contribution is
//    evaluated at both (and both rows for y) and the low / high sums take the min / max; a span of
//    3+ pixels (m ≥ 0.5, which would skip the middle one) counts as z-ambiguous: no bound at all.
//    Bands, prefix-sum means and fg are evaluated at the candidate pixel exactly as on the CPU.
//  - contribution c = (0.5·m + (above − below))·(1 − fg) at a fixed pixel, A = 0.5|m| + |above| +
//    |below|: above = fl(fl(S1 − S0)/k) is off by ≤ u + 5u = 6u·|above| (same for below); the
//    difference adds u, so ≤ 7u(|above| + |below|); + 0.5m adds u·A → ≤ 8u·A; (1 − fg) rounded (u)
//    and the product (u) add 2u·|t| ≤ 2u·A (needs fg ∈ [0, 1], checked on the host) → ≤ 10u·A. The
//    kernel sums A (max over candidates) as `absA`; the host charges (24 + 2·depth)·U32·absA =
//    (48 + 4·depth)u·absA against the (10 + depth)u·ΣA needed (per-term error plus the f32 sum,
//    ≤ depth·u·Σ|c| in any order, depth = additions per term ≈ nDirs/256 + 8 = 40): ≈ 4.2× (≥ 4×
//    for any depth). The CPU's own f64 sum is charged separately (nDirs·2⁻⁵²).
// Outputs per pose (vec4<u32> × 3): (bits of sumLo, sumHi, absA, nonce), (n, nAmbZ, pose index,
// nAmb), (bits of ambHi, bits of the pose's tan(vfov/2) as read, 0, 0). The host accepts an entry
// only if nonce, index and the echoed tan match its call (a dispatch that silently failed, or read
// stale pose inputs, leaves bytes that must never pass for a bound).
// n counts the directions certainly in the frame.
//
// @workgroup_size(256), one pose per workgroup: as pose-grid (~8k stride-1 directions is ~32 per
// invocation, then a shared-memory tree reduction of depth 8).

export const POSE_BOUND_WGSL = /* wgsl */ `
struct U {
	w: u32,
	h: u32,
	nDirs: u32,
	nPoses: u32,
	band: i32,
	gapCoarse: i32,
	gapFine: i32,
	aspect: f32,
	nonce: u32,
	pad0: u32,
	pad1: u32,
	pad2: u32,
};

// per pose, 3 × vec4: (forward.xyz, tan(vfov/2)), (right.xyz, vfov°), (up.xyz, 1 = fine map / 0 = coarse)
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> poses: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> dirs: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> coarse: array<f32>;
@group(0) @binding(4) var<storage, read> fine: array<f32>;
@group(0) @binding(5) var<storage, read> fg: array<f32>;
@group(0) @binding(6) var<storage, read> skyCum: array<f32>;
@group(0) @binding(7) var<storage, read_write> out: array<vec4<u32>>;

const WG: u32 = 256u;
const U32: f32 = 1.1920929e-7;
var<workgroup> sLo: array<f32, 256>;
var<workgroup> sHi: array<f32, 256>;
var<workgroup> sA: array<f32, 256>;
var<workgroup> sN: array<u32, 256>;
var<workgroup> sAmb: array<u32, 256>;
var<workgroup> sAmbZ: array<u32, 256>;
var<workgroup> sAmbHi: array<f32, 256>;

struct C { c: f32, a: f32 };

// the CPU's per-direction term at pixel (x, y), and A = 0.5|m| + |above| + |below|
fn term(x: i32, y: i32, gap: i32, isFine: bool) -> C {
	let w = i32(u.w);
	let h = i32(u.h);
	let a0 = max(0, y - gap - u.band);
	let a1 = max(0, y - gap);
	let b0 = min(h, y + gap);
	let b1 = min(h, y + gap + u.band);
	var above = 0.5;
	if (a1 > a0) { above = (skyCum[a1 * w + x] - skyCum[a0 * w + x]) / f32(a1 - a0); }
	var below = 0.5;
	if (b1 > b0) { below = (skyCum[b1 * w + x] - skyCum[b0 * w + x]) / f32(b1 - b0); }
	let k = y * w + x;
	var m = coarse[k];
	if (isFine) { m = fine[k]; }
	return C((0.5 * m + (above - below)) * (1.0 - fg[k]), 0.5 * abs(m) + abs(above) + abs(below));
}

fn near(x: f32, thr: f32, e: f32) -> bool {
	return abs(x - thr) <= e;
}

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
	let pi = wid.x;
	var lo = 0.0;
	var hi = 0.0;
	var aSum = 0.0;
	var n = 0u;
	var amb = 0u;
	var ambZ = 0u;
	var ambHi = 0.0;
	if (pi < u.nPoses) {
		let f4 = poses[pi * 3u];
		let r4 = poses[pi * 3u + 1u];
		let u4 = poses[pi * 3u + 2u];
		let t = f4.w;
		let isFine = u4.w > 0.5;
		var gap = u.gapCoarse;
		if (isFine) { gap = u.gapFine; }
		let fw = f32(u.w);
		let fh = f32(u.h);
		let T = t * u.aspect;
		for (var i = lid; i < u.nDirs; i += WG) {
			let d = dirs[i].xyz;
			let ed = 8.0 * U32 * (abs(d.x) + abs(d.y) + abs(d.z)) * 1.01;
			let z = d.x * f4.x + d.y * f4.y + d.z * f4.z;
			let xr = d.x * r4.x + d.y * r4.y + d.z * r4.z;
			if (near(z, 0.1, ed + 1e-8)) {
				// whichever way the CPU's z test goes, |u − 0.5| ≥ (|d·r| − Ed)/(z + Ed)/(t·aspect)/2
				// puts it beyond the 0.01 / 0.99 edges if that exceeds 0.49 (with rounding slack)
				let qmin = (abs(xr) - ed) / (z + ed) / T / 2.0;
				if (qmin * (1.0 - 64.0 * U32) <= 0.49 + 1e-6) { ambZ += 1u; }
				continue;
			}
			if (z <= 0.1) { continue; }
			let xu = d.x * u4.x + d.y * u4.y + d.z * u4.z;
			let qu = xr / z / T / 2.0;
			let qv = xu / z / t / 2.0;
			let uu = 0.5 + qu;
			let vv = 0.5 - qv;
			let zl = z - ed;
			let eu = (abs(qu) * (ed / zl + 16.0 * U32) + ed / (zl * T * 2.0)) * 1.25 + 2.0 * U32;
			let ev = (abs(qv) * (ed / zl + 16.0 * U32) + ed / (zl * t * 2.0)) * 1.25 + 2.0 * U32;
			let eu1 = eu + 1e-9;
			let ev1 = ev + 1e-9;
			let nearU = near(uu, 0.01, eu1) || near(uu, 0.99, eu1);
			let nearV = near(vv, 0.01, ev1) || near(vv, 0.99, ev1);
			// certainly out: one test fails beyond its error bound (so it fails on the CPU too)
			if ((!nearU && (uu < 0.01 || uu > 0.99)) || (!nearV && (vv < 0.01 || vv > 0.99))) { continue; }
			let X = uu * fw;
			let Y = vv * fh;
			let mx = eu * fw + U32 * abs(X) + 1e-6;
			let my = ev * fh + U32 * abs(Y) + 1e-6;
			let fxa = i32(floor(X - mx));
			let fxb = i32(floor(X + mx));
			let fya = i32(floor(Y - my));
			let fyb = i32(floor(Y + my));
			// a 3+ pixel span would leave the middle (possibly the CPU's) pixel unevaluated
			if (fxb - fxa > 1 || fyb - fya > 1) { ambZ += 1u; continue; }
			let xa = clamp(fxa, 0, i32(u.w) - 1);
			let xb = clamp(fxb, 0, i32(u.w) - 1);
			let ya = clamp(fya, 0, i32(u.h) - 1);
			let yb = clamp(fyb, 0, i32(u.h) - 1);
			var c = term(xa, ya, gap, isFine);
			var cLo = c.c;
			var cHi = c.c;
			var cA = c.a;
			if (xb != xa) {
				c = term(xb, ya, gap, isFine);
				cLo = min(cLo, c.c); cHi = max(cHi, c.c); cA = max(cA, c.a);
			}
			if (yb != ya) {
				c = term(xa, yb, gap, isFine);
				cLo = min(cLo, c.c); cHi = max(cHi, c.c); cA = max(cA, c.a);
				if (xb != xa) {
					c = term(xb, yb, gap, isFine);
					cLo = min(cLo, c.c); cHi = max(cHi, c.c); cA = max(cA, c.a);
				}
			}
			aSum += cA;
			if (nearU || nearV) {
				amb += 1u;
				ambHi += max(0.0, cHi);
			} else {
				lo += cLo;
				hi += cHi;
				n += 1u;
			}
		}
	}
	sLo[lid] = lo;
	sHi[lid] = hi;
	sA[lid] = aSum;
	sN[lid] = n;
	sAmb[lid] = amb;
	sAmbZ[lid] = ambZ;
	sAmbHi[lid] = ambHi;
	workgroupBarrier();
	for (var s = WG / 2u; s > 0u; s = s / 2u) {
		if (lid < s) {
			sLo[lid] += sLo[lid + s];
			sHi[lid] += sHi[lid + s];
			sA[lid] += sA[lid + s];
			sN[lid] += sN[lid + s];
			sAmb[lid] += sAmb[lid + s];
			sAmbZ[lid] += sAmbZ[lid + s];
			sAmbHi[lid] += sAmbHi[lid + s];
		}
		workgroupBarrier();
	}
	if (lid == 0u && pi < u.nPoses) {
		out[pi * 3u] = vec4<u32>(bitcast<u32>(sLo[0]), bitcast<u32>(sHi[0]), bitcast<u32>(sA[0]), u.nonce);
		out[pi * 3u + 1u] = vec4<u32>(sN[0], sAmbZ[0], pi, sAmb[0]);
		out[pi * 3u + 2u] = vec4<u32>(bitcast<u32>(sAmbHi[0]), bitcast<u32>(poses[pi * 3u].w), 0u, 0u);
	}
}
`;
