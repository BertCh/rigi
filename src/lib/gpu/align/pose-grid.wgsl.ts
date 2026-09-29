// WGSL twin of align.ts scorePose (with forEachProjected): one workgroup per pose, the whole
// autoAlign coarse grid (101 yaw × 25 pitch) in one dispatch. Layouts are written by ./pose-grid.ts.
//
// @workgroup_size(256): one pose per workgroup; its 256 invocations stride over the (stride-3
// subsampled) horizon directions, then tree-reduce (sum, n) in workgroup memory. ~2.7k directions
// per pose is ~11 iterations per invocation; 256 is a whole number of Apple (32) and AMD/NVIDIA
// (32/64) SIMD widths, and 2525 workgroups fill every core.
//
// Same operation order as the CPU (z, then u/v, bounds, floor, band limits, prefix-sum band means,
// fg weighting). Differences are f32 rounding only: a direction whose u·w or v·h lands within
// ~1e-6 of a pixel boundary can fall in the neighbouring pixel, and the sum order differs. The
// caller (align.ts autoAlign's `grid` option) therefore re-scores on the CPU every cell within a
// tolerance of each yaw column's GPU maximum, so the chosen cells and their scores are exactly
// the CPU's.

export const POSE_GRID_WGSL = /* wgsl */ `
struct U {
	w: u32,
	h: u32,
	nDirs: u32,
	nPoses: u32,
	band: i32,
	gap: i32,
	aspect: f32,
	total: f32,
};

// per pose, 3 × vec4: (forward.xyz, tan(vfov/2)), (right.xyz, vfov°), (up.xyz, 0)
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> poses: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> dirs: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> coarse: array<f32>;
@group(0) @binding(4) var<storage, read> fg: array<f32>;
@group(0) @binding(5) var<storage, read> skyCum: array<f32>;
@group(0) @binding(6) var<storage, read_write> scores: array<f32>;

const WG: u32 = 256u;
var<workgroup> sSum: array<f32, 256>;
var<workgroup> sN: array<u32, 256>;

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
	let pi = wid.x;
	let f4 = poses[pi * 3u];
	let r4 = poses[pi * 3u + 1u];
	let u4 = poses[pi * 3u + 2u];
	let t = f4.w;
	let w = i32(u.w);
	let h = i32(u.h);
	var sum = 0.0;
	var n = 0u;
	if (pi < u.nPoses) {
		for (var i = lid; i < u.nDirs; i += WG) {
			let d = dirs[i].xyz;
			let z = d.x * f4.x + d.y * f4.y + d.z * f4.z;
			if (z <= 0.1) { continue; }
			let uu = 0.5 + (d.x * r4.x + d.y * r4.y + d.z * r4.z) / z / (t * u.aspect) / 2.0;
			let vv = 0.5 - (d.x * u4.x + d.y * u4.y + d.z * u4.z) / z / t / 2.0;
			if (uu < 0.01 || uu > 0.99 || vv < 0.01 || vv > 0.99) { continue; }
			let x = i32(floor(uu * f32(w)));
			let y = i32(floor(vv * f32(h)));
			let a0 = max(0, y - u.gap - u.band);
			let a1 = max(0, y - u.gap);
			let b0 = min(h, y + u.gap);
			let b1 = min(h, y + u.gap + u.band);
			var above = 0.5;
			if (a1 > a0) { above = (skyCum[a1 * w + x] - skyCum[a0 * w + x]) / f32(a1 - a0); }
			var below = 0.5;
			if (b1 > b0) { below = (skyCum[b1 * w + x] - skyCum[b0 * w + x]) / f32(b1 - b0); }
			let k = y * w + x;
			sum += (0.5 * coarse[k] + (above - below)) * (1.0 - fg[k]);
			n += 1u;
		}
	}
	sSum[lid] = sum;
	sN[lid] = n;
	workgroupBarrier();
	for (var s = WG / 2u; s > 0u; s = s / 2u) {
		if (lid < s) {
			sSum[lid] += sSum[lid + s];
			sN[lid] += sN[lid + s];
		}
		workgroupBarrier();
	}
	if (lid == 0u && pi < u.nPoses) {
		let nn = f32(sN[0]);
		let coverage = min(nn / u.total / (((r4.w * u.aspect) / 360.0) * 0.6), 1.0);
		var sc = 0.0;
		if (sN[0] > 20u) { sc = (sSum[0] / nn) * coverage; }
		scores[pi] = sc;
	}
}
`;
