// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The per-pixel half of ./compose.ts as two graph kernels, run on the depth net's own output buffers
// (no readback, no upload); ./pipeline-gpu.ts puts them in the compose graph in front of the lift:
//   K_COMPOSE  depth = (z + shift) · metricScale where mask > 0.5 and the result is finite and > 0, else 0;
//              normals copied from the head where the pixel is valid and finite, else 0 (composeDepth's
//              loop, word for word). The shift and the metric scale are the CPU focal solve's / the net's.
//   K_NORMALS  for weights without the normal head (q8lite): normalsFromDepth on that depth, ported
//              exactly (NORMAL_STEP, NORMAL_EDGE, the better-side tangent per axis, ty × tx).
// Every word of `depth` and `normal` is written by its invocation (valid or not), so the transients they
// land in need no clear. "valid" is depth > 0 (what composeDepth's valid mask says).
import { defineKernel } from "#/lib/gpu/core/kernel";
import { defineUniformBlock } from "#/lib/gpu/core/uniform-block";
import { NORMAL_EDGE, NORMAL_STEP } from "./compose";

export const COMPOSE_GROUP = "nearfield-compose";

/** WGSL struct Prm order of K_COMPOSE. */
export const COMPOSE_PRM = defineUniformBlock({
	n: "u32",
	hasNormal: "u32",
	shift: "f32",
	scale: "f32",
});

/** WGSL struct Prm order of K_NORMALS. */
export const NORMALS_PRM = defineUniformBlock({
	width: "u32",
	height: "u32",
	step: "i32",
	edge: "f32",
	fx: "f32",
	fy: "f32",
	cx: "f32",
	cy: "f32",
});

export const COMPOSE_WGSL = /* wgsl */ `\
struct Prm { n: u32, hasNormal: u32, shift: f32, scale: f32 };
@group(0) @binding(0) var<uniform> prm: Prm;
@group(0) @binding(1) var<storage, read> z: array<f32>;
@group(0) @binding(2) var<storage, read> mask: array<f32>;
@group(0) @binding(3) var<storage, read> normalIn: array<f32>;
@group(0) @binding(4) var<storage, read_write> depth: array<f32>;
@group(0) @binding(5) var<storage, read_write> normalOut: array<f32>;

// NaN and infinity have all exponent bits set (Number.isFinite)
fn finite(x: f32) -> bool { return (bitcast<u32>(x) & 0x7f800000u) != 0x7f800000u; }

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let k = id.y * nwg.x * 256u + id.x;
  if (k >= prm.n) { return; }
  var d = 0.0;
  let m = mask[k];
  let zs = z[k] + prm.shift;
  if (finite(m) && m > 0.5 && finite(zs) && zs > 0.0) {
    let v = zs * prm.scale;
    if (finite(v) && v > 0.0) { d = v; }
  }
  depth[k] = d;
  if (prm.hasNormal == 1u) {
    var nx = 0.0;
    var ny = 0.0;
    var nz = 0.0;
    if (d > 0.0) {
      let ax = normalIn[3u * k];
      let ay = normalIn[3u * k + 1u];
      let az = normalIn[3u * k + 2u];
      if (finite(ax) && finite(ay) && finite(az)) {
        nx = ax;
        ny = ay;
        nz = az;
      }
    }
    normalOut[3u * k] = nx;
    normalOut[3u * k + 1u] = ny;
    normalOut[3u * k + 2u] = nz;
  }
}
`;

export const NORMALS_WGSL = /* wgsl */ `\
struct Prm { width: u32, height: u32, step: i32, edge: f32, fx: f32, fy: f32, cx: f32, cy: f32 };
@group(0) @binding(0) var<uniform> prm: Prm;
@group(0) @binding(1) var<storage, read> depth: array<f32>;
@group(0) @binding(2) var<storage, read_write> normalOut: array<f32>;

fn axAt(i: i32) -> f32 { return ((f32(i) + 0.5) / f32(prm.width) - prm.cx) / prm.fx; }
fn ayAt(j: i32) -> f32 { return ((f32(j) + 0.5) / f32(prm.height) - prm.cy) / prm.fy; }

// The tangent towards the better of k - d and k + d as (dx, dy, dz, 1), or w = 0 when neither side is usable.
fn tangent(z: f32, i: i32, j: i32, di: i32, dj: i32) -> vec4f {
  var best = vec4f(0.0);
  var bestDz = 3.4e38;
  for (var s = 0; s < 2; s++) {
    let sign = 1 - 2 * s;
    let ii = i + sign * di;
    let jj = j + sign * dj;
    if (ii < 0 || jj < 0 || ii >= i32(prm.width) || jj >= i32(prm.height)) { continue; }
    let zz = depth[u32(jj) * prm.width + u32(ii)];
    if (!(zz > 0.0)) { continue; }
    let dz = abs(zz - z);
    if (dz > prm.edge * z || dz >= bestDz) { continue; }
    bestDz = dz;
    let f = f32(sign);
    best = vec4f(f * (axAt(ii) * zz - axAt(i) * z), f * (ayAt(jj) * zz - ayAt(j) * z), f * (zz - z), 1.0);
  }
  return best;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= prm.width || id.y >= prm.height) { return; }
  let k = id.y * prm.width + id.x;
  var n = vec3f(0.0);
  let z = depth[k];
  if (z > 0.0) {
    let i = i32(id.x);
    let j = i32(id.y);
    let tx = tangent(z, i, j, prm.step, 0);
    let ty = tangent(z, i, j, 0, prm.step);
    if (tx.w > 0.0 && ty.w > 0.0) {
      // ty x tx faces the camera for a head-on surface (x right, y down)
      let c = vec3f(
        ty.y * tx.z - ty.z * tx.y,
        ty.z * tx.x - ty.x * tx.z,
        ty.x * tx.y - ty.y * tx.x);
      let l = length(c);
      if (l > 0.0 && l < 3.4e38) { n = c / l; }
    }
  }
  normalOut[3u * k] = n.x;
  normalOut[3u * k + 1u] = n.y;
  normalOut[3u * k + 2u] = n.z;
}
`;

export const K_COMPOSE = defineKernel(
	"nearfield-compose",
	COMPOSE_WGSL,
	[
		["prm", "uniform"],
		["z", "read-only-storage"],
		["mask", "read-only-storage"],
		["normalIn", "read-only-storage"],
		["depth", "storage"],
		["normalOut", "storage"],
	],
	{ group: COMPOSE_GROUP, label: "nearfield-compose" },
);

export const K_NORMALS = defineKernel(
	"nearfield-normals",
	NORMALS_WGSL,
	[
		["prm", "uniform"],
		["depth", "read-only-storage"],
		["normalOut", "storage"],
	],
	{ group: COMPOSE_GROUP, label: "nearfield-normals" },
);

/** K_COMPOSE workgroups for `n` pixels: a 2-D grid when n / 256 passes the 65535 limit. */
export function composeWorkgroups(n: number): [number, number] {
	const groups = Math.ceil(n / 256);
	const x = Math.min(groups, 4096);
	return [x, Math.ceil(groups / x)];
}

/** K_COMPOSE uniform words. */
export function composeParamWords(
	n: number,
	hasNormal: boolean,
	shift: number,
	metricScale: number,
): ArrayBuffer {
	return COMPOSE_PRM.pack({
		n,
		hasNormal: hasNormal ? 1 : 0,
		shift,
		scale: metricScale,
	});
}

/** K_NORMALS uniform words (K = the normalised intrinsics of the depth). */
export function normalsParamWords(
	width: number,
	height: number,
	K: { fx: number; fy: number; cx: number; cy: number },
): ArrayBuffer {
	return NORMALS_PRM.pack({
		width,
		height,
		step: NORMAL_STEP,
		edge: NORMAL_EDGE,
		fx: K.fx,
		fy: K.fy,
		cx: K.cx,
		cy: K.cy,
	});
}
