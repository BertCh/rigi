// solvePose coarse grid (geo/solve.ts solveOnce): one workgroup per (yaw row, block of 256 pitches)
// scores every cell and writes the block's minimum cost plus the first / last pitch whose cost is
// within `band` (≥ 2ε) of it. Everything is float32; the CPU turns each row minimum into an interval
// [g − ε, g + ε] (index.ts costBound) and re-scores exactly the rows the selection cannot decide from
// intervals, and only over that pitch band: a pitch outside it costs more than g + ε ≥ the exact row
// minimum, so the band holds the row's first minimum. The chosen seeds / winner / ambiguity are
// solveOnce's.
//
// Per cell: c = Σ_o w_o · min(|(el_o − H(az_o + dy)) + dp|, trunc) / Σw + prior(dy) + prior(dp).
// The azimuth is carried as (integer bin, fraction) pairs: obs (i_o, f_o) + yaw (i_y, f_y), so the
// interpolation weight keeps ~1e-7 bin of precision even at 360° (a plain f32 azimuth would lose
// ~3e-5°, and steep horizon profile steps turn that into cost error).
//
// @workgroup_size(64): the observations are streamed through workgroup memory 64 at a time (each
// thread interpolates the horizon for one observation, which every pitch of the row then shares),
// and each thread keeps 4 pitch accumulators, so one workgroup covers 256 pitches. Summation over
// observations is sequential in observation order, as on the CPU.
export const COARSE_WGSL = /* wgsl */ `
struct U {
	nObs: u32,
	nPitch: u32,
	nYaw: u32,
	nH: u32,
	trunc: f32,
	wSum: f32,
	nBlk: u32,
	band: f32,
};
struct Obs { i: u32, f: f32, el: f32, w: f32 };
struct Yaw { i: u32, f: f32, prior: f32, pad: f32 };

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> obs: array<Obs>;
@group(0) @binding(2) var<storage, read> yaws: array<Yaw>;
// (dp, prior(dp)) per pitch
@group(0) @binding(3) var<storage, read> pitch: array<vec2f>;
// horizon elevation per bin, nH + 1 entries (the last repeats bin 0)
@group(0) @binding(4) var<storage, read> hz: array<f32>;
// per (yaw row, pitch block) at [row * nBlk + blk]: (bitcast minimum cost, first, last pitch in band, 0)
@group(0) @binding(5) var<storage, read_write> rowMin: array<vec4u>;

const WG = 64u;
const PER = 4u;
const BIG = 3.0e38;

var<workgroup> dsh: array<f32, 64>;
var<workgroup> wsh: array<f32, 64>;
var<workgroup> red: array<f32, 64>;
var<workgroup> first: atomic<u32>;
var<workgroup> last: atomic<u32>;

@compute @workgroup_size(64)
fn main(
	@builtin(workgroup_id) wg: vec3u,
	@builtin(local_invocation_index) lid: u32,
) {
	let iy = wg.x;
	let blk = wg.y;
	let yw = yaws[iy];
	var dp: array<f32, 4>;
	var acc: array<f32, 4>;
	for (var k = 0u; k < PER; k++) {
		let p = blk * WG * PER + k * WG + lid;
		dp[k] = select(0.0, pitch[min(p, u.nPitch - 1u)].x, p < u.nPitch);
		acc[k] = 0.0;
	}
	for (var o0 = 0u; o0 < u.nObs; o0 += WG) {
		let o = o0 + lid;
		if (o < u.nObs) {
			let ob = obs[o];
			var i = ob.i + yw.i;
			if (i >= u.nH) { i -= u.nH; }
			var f = ob.f + yw.f;
			if (f >= 1.0) {
				f -= 1.0;
				i += 1u;
				if (i >= u.nH) { i -= u.nH; }
			}
			let h = hz[i] * (1.0 - f) + hz[i + 1u] * f;
			dsh[lid] = ob.el - h;
			wsh[lid] = ob.w;
		}
		workgroupBarrier();
		let m = min(WG, u.nObs - o0);
		for (var j = 0u; j < m; j++) {
			let d = dsh[j];
			let w = wsh[j];
			for (var k = 0u; k < PER; k++) {
				acc[k] += w * min(abs(d + dp[k]), u.trunc);
			}
		}
		workgroupBarrier();
	}
	var best = BIG;
	var cost: array<f32, 4>;
	for (var k = 0u; k < PER; k++) {
		let p = blk * WG * PER + k * WG + lid;
		cost[k] = BIG;
		if (p < u.nPitch) {
			cost[k] = acc[k] / u.wSum + (yw.prior + pitch[p].y);
			best = min(best, cost[k]);
		}
	}
	red[lid] = best;
	if (lid == 0u) {
		atomicStore(&first, 0xffffffffu);
		atomicStore(&last, 0u);
	}
	workgroupBarrier();
	for (var s = WG / 2u; s > 0u; s >>= 1u) {
		if (lid < s) { red[lid] = min(red[lid], red[lid + s]); }
		workgroupBarrier();
	}
	let lim = red[0] + u.band;
	for (var k = 0u; k < PER; k++) {
		let p = blk * WG * PER + k * WG + lid;
		if (p < u.nPitch && cost[k] <= lim) {
			atomicMin(&first, p);
			atomicMax(&last, p);
		}
	}
	workgroupBarrier();
	if (lid == 0u) {
		rowMin[iy * u.nBlk + blk] = vec4u(
			bitcast<u32>(red[0]),
			atomicLoad(&first),
			atomicLoad(&last),
			0u,
		);
	}
}
`;

/** Pitches covered by one workgroup (WG × PER). */
export const PITCH_BLOCK = 256;
