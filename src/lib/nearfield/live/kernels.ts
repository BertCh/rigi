// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WGSL of the live Step Inside depth run (./session.ts): four kernels over the depth net's GPU outputs,
// ending in the splat storage buffer the WebGPU splat layer draws (no readback, no CPU compaction).
//
//   live-depth     W·H   z, mask, metric scale → metric depth (0 = invalid)          (compose.ts composeDepth)
//   live-lift      cells depth → anchored, classified, ENU Gaussians, compacted by an atomic counter
//                        (local/lift.ts liftCell + normals.ts normalsFromDepth + anchor.ts curveRange +
//                         split.ts classifyRange + scene.ts anchorAndFilterCloud + lift.ts toEnu +
//                         deck-webgpu/layers/splats.ts packSplats), no grounding and no masks
//   live-finalize  capacity  slots at or past the count become dead splats (NaN position, alpha 0)
//   live-colour    capacity  live slots take their colour from the video texture at the stored cell
//
// Splat record (SPLAT_WORDS = 12 u32 per slot, the splat layer's layout): pos xyz + provenance (f32 bits),
// Σ xx xy xz yy yz zz (f32 bits), rgba (u32), word 11 = the cell id the slot came from (the layer ignores
// it; the colour refresh and the tests read it).
import { defineKernel } from "#/lib/gpu/core/kernel";
import { defineUniformBlock } from "#/lib/gpu/core/uniform-block";
import { LIFT_RECORD_WORDS } from "../local/lift";

export const LIVE_GROUP = "nearfield-live";
/** Knots the curve uniform holds (anchor.ts CURVE_DEFAULTS.knots is 6). */
export const LIVE_MAX_KNOTS = 16;

/** WGSL struct Prm order (all scalars). */
export const LIVE_PRM = defineUniformBlock({
	width: "u32",
	height: "u32",
	gw: "u32",
	gh: "u32",
	stride: "u32",
	hasNormal: "u32",
	useBufScale: "u32",
	curveN: "u32",
	edgeRatio: "f32",
	sigmaFrac: "f32",
	flatFrac: "f32",
	maxStretch: "f32",
	kdFx: "f32",
	kdFy: "f32",
	kdCx: "f32",
	kdCy: "f32",
	kpFx: "f32",
	kpFy: "f32",
	kpCx: "f32",
	kpCy: "f32",
	shift: "f32",
	metricScale: "f32",
	affScale: "f32",
	affShift: "f32",
	nearRadius: "f32",
	objectMargin: "f32",
	minGapM: "f32",
	normalEdge: "f32",
	normalStep: "u32",
	writeCloud: "u32",
	capacity: "u32",
	demW: "u32",
	demH: "u32",
	r00: "f32",
	r01: "f32",
	r02: "f32",
	r10: "f32",
	r11: "f32",
	r12: "f32",
	r20: "f32",
	r21: "f32",
	r22: "f32",
	ex: "f32",
	ey: "f32",
	ez: "f32",
	qw: "f32",
	qx: "f32",
	qy: "f32",
	qz: "f32",
});

const PRM_STRUCT = /* wgsl */ `\
struct Prm {
  width: u32, height: u32, gw: u32, gh: u32,
  stride: u32, hasNormal: u32, useBufScale: u32, curveN: u32,
  edgeRatio: f32, sigmaFrac: f32, flatFrac: f32, maxStretch: f32,
  kdFx: f32, kdFy: f32, kdCx: f32, kdCy: f32,
  kpFx: f32, kpFy: f32, kpCx: f32, kpCy: f32,
  shift: f32, metricScale: f32, affScale: f32, affShift: f32,
  nearRadius: f32, objectMargin: f32, minGapM: f32, normalEdge: f32,
  normalStep: u32, writeCloud: u32, capacity: u32, demW: u32,
  demH: u32,
  r00: f32, r01: f32, r02: f32, r10: f32, r11: f32, r12: f32, r20: f32, r21: f32, r22: f32,
  ex: f32, ey: f32, ez: f32,
  qw: f32, qx: f32, qy: f32, qz: f32,
};
`;

export const DEPTH_WGSL = /* wgsl */ `\
${PRM_STRUCT}
@group(0) @binding(0) var<uniform> prm: Prm;
@group(0) @binding(1) var<storage, read> zIn: array<f32>;
@group(0) @binding(2) var<storage, read> maskIn: array<f32>;
@group(0) @binding(3) var<storage, read> scaleIn: array<f32>;
@group(0) @binding(4) var<storage, read_write> depth: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= prm.width || id.y >= prm.height) { return; }
  let k = id.y * prm.width + id.x;
  let zs = zIn[k] + prm.shift;
  var scale = prm.metricScale;
  if (prm.useBufScale == 1u) { scale = scaleIn[0]; }
  let d = zs * scale;
  // NaN fails every comparison: invalid
  let ok = maskIn[k] > 0.5 && zs > 0.0 && d > 0.0 && d < 3.4e38;
  depth[k] = select(0.0, d, ok);
}
`;

export const LIFT_WGSL = /* wgsl */ `\
${PRM_STRUCT}
struct Crv { k: array<vec4f, ${LIVE_MAX_KNOTS / 2}> };
@group(0) @binding(0) var<uniform> prm: Prm;
@group(0) @binding(1) var<uniform> crv: Crv;
@group(0) @binding(2) var<storage, read> depth: array<f32>;
@group(0) @binding(3) var<storage, read> normalIn: array<f32>;
@group(0) @binding(4) var<storage, read> dem: array<f32>;
@group(0) @binding(5) var<storage, read_write> counter: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> splats: array<u32>;
@group(0) @binding(7) var<storage, read_write> cloud: array<u32>;

const NEAR_M: f32 = 15.0;

fn crvX(k: u32) -> f32 {
  let v = crv.k[k >> 1u];
  if ((k & 1u) == 0u) { return v.x; }
  return v.z;
}
fn crvY(k: u32) -> f32 {
  let v = crv.k[k >> 1u];
  if ((k & 1u) == 0u) { return v.y; }
  return v.w;
}

// anchor.ts curveRange / anchoredRange: -1 for m <= 0
fn anchored(m: f32) -> f32 {
  if (!(m > 0.0)) { return -1.0; }
  let n = prm.curveN;
  if (n == 0u) { return prm.affScale * m + prm.affShift; }
  let lx = log(m);
  let x0 = crvX(0u);
  let y0 = crvY(0u);
  if (n == 1u || lx <= x0) {
    let ln = log(NEAR_M);
    let lr0 = y0 - x0;
    if (x0 <= ln || lr0 <= 0.0) { return exp(y0 + lx - x0); }
    let w = clamp((lx - ln) / (x0 - ln), 0.0, 1.0);
    return exp(lx + w * lr0);
  }
  let xl = crvX(n - 1u);
  if (lx >= xl) { return exp(crvY(n - 1u) + lx - xl); }
  var k = 0u;
  for (var guard = 0u; guard < ${LIVE_MAX_KNOTS}u; guard++) {
    if (k < n - 2u && lx > crvX(k + 1u)) { k++; } else { break; }
  }
  let t = (lx - crvX(k)) / (crvX(k + 1u) - crvX(k));
  return exp(crvY(k) + t * (crvY(k + 1u) - crvY(k)));
}

fn zAt(x: i32, y: i32) -> f32 {
  if (x < 0 || y < 0 || x >= i32(prm.width) || y >= i32(prm.height)) { return 0.0; }
  return depth[u32(y) * prm.width + u32(x)];
}

// centre depth of a cell, -1 when invalid
fn zCell(gi: u32, gj: u32) -> f32 {
  let c0 = prm.stride / 2u;
  let z = depth[(gj * prm.stride + c0) * prm.width + gi * prm.stride + c0];
  if (z > 0.0 && z < 3.4e38) { return z; }
  return -1.0;
}

fn rayX(i: i32) -> f32 { return ((f32(i) + 0.5) / f32(prm.width) - prm.kdCx) / prm.kdFx; }
fn rayY(j: i32) -> f32 { return ((f32(j) + 0.5) / f32(prm.height) - prm.kdCy) / prm.kdFy; }

// normals.ts tangent(): the better side of +-step as (dx, dy, dz); w = 1 when found
fn tangent(z: f32, i: i32, j: i32, di: i32, dj: i32) -> vec4f {
  var best = vec4f(0.0);
  var bestDz = 3.4e38;
  for (var s = 0; s < 2; s++) {
    var sgn = 1;
    if (s == 1) { sgn = -1; }
    let ii = i + sgn * di;
    let jj = j + sgn * dj;
    if (ii < 0 || jj < 0 || ii >= i32(prm.width) || jj >= i32(prm.height)) { continue; }
    let zz = zAt(ii, jj);
    if (!(zz > 0.0)) { continue; }
    let dz = abs(zz - z);
    if (dz > prm.normalEdge * z || dz >= bestDz) { continue; }
    bestDz = dz;
    let sf = f32(sgn);
    best = vec4f(sf * (rayX(ii) * zz - rayX(i) * z), sf * (rayY(jj) * zz - rayY(j) * z), sf * (zz - z), 1.0);
  }
  return best;
}

// normals.ts normalsFromDepth for one pixel (zero = no normal)
fn normalFromDepth(px: u32, py: u32, z: f32) -> vec3f {
  let i = i32(px);
  let j = i32(py);
  let st = i32(prm.normalStep);
  let tx = tangent(z, i, j, st, 0);
  let ty = tangent(z, i, j, 0, st);
  if (tx.w == 0.0 || ty.w == 0.0) { return vec3f(0.0); }
  let n = vec3f(
    ty.y * tx.z - ty.z * tx.y,
    ty.z * tx.x - ty.x * tx.z,
    ty.x * tx.y - ty.y * tx.x,
  );
  let l = length(n);
  if (!(l > 0.0)) { return vec3f(0.0); }
  return n / l;
}

fn quatFromMatrix(m00: f32, m01: f32, m02: f32, m10: f32, m11: f32, m12: f32,
                  m20: f32, m21: f32, m22: f32) -> vec4f {
  let tr = m00 + m11 + m22;
  var q: vec4f;
  if (tr > 0.0) {
    let s = sqrt(tr + 1.0) * 2.0;
    q = vec4f(0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s);
  } else if (m00 > m11 && m00 > m22) {
    let s = sqrt(1.0 + m00 - m11 - m22) * 2.0;
    q = vec4f((m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s);
  } else if (m11 > m22) {
    let s = sqrt(1.0 + m11 - m00 - m22) * 2.0;
    q = vec4f((m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s);
  } else {
    let s = sqrt(1.0 + m22 - m00 - m11) * 2.0;
    q = vec4f((m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s);
  }
  return normalize(q);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let gi = id.x;
  let gj = id.y;
  if (gi >= prm.gw || gj >= prm.gh) { return; }
  let z = zCell(gi, gj);
  if (z < 0.0) { return; }
  if (prm.edgeRatio > 0.0) {
    var lo = 3.4e38;
    var hi = 0.0;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let ii = u32(clamp(i32(gi) + dx, 0, i32(prm.gw) - 1));
        let jj = u32(clamp(i32(gj) + dy, 0, i32(prm.gh) - 1));
        let zz = zCell(ii, jj);
        if (zz < 0.0) { continue; }
        lo = min(lo, zz);
        hi = max(hi, zz);
      }
    }
    if (hi / lo > prm.edgeRatio) { return; }
  }
  let s = prm.stride;
  let px = gi * s + s / 2u;
  let py = gj * s + s / 2u;
  let u = (f32(px) + 0.5) / f32(prm.width);
  let v = (f32(py) + 0.5) / f32(prm.height);

  // the cell on the photo ray (scene.ts anchorAndFilterCloud step 1) and its anchored range
  let pp = vec3f((u - prm.kpCx) / prm.kpFx * z, (v - prm.kpCy) / prm.kpFy * z, z);
  let len = length(pp);
  let range = anchored(len);
  if (!(range > 0.0) || !(range <= prm.nearRadius)) { return; }
  // split.ts classifyRange: Object only (no people mask, no grounding here)
  var demR = -1.0;
  if (prm.demW > 0u) {
    let dx = min(prm.demW - 1u, u32(max(floor(u * f32(prm.demW)), 0.0)));
    let dy = min(prm.demH - 1u, u32(max(floor(v * f32(prm.demH)), 0.0)));
    demR = dem[dy * prm.demW + dx];
  }
  if (demR > 0.0) {
    if (!(range < demR * (1.0 - prm.objectMargin) && demR - range >= prm.minGapM)) { return; }
  }

  // the Gaussian in the depth camera frame (local/lift.ts liftCell)
  let fxd = prm.kdFx * f32(prm.width);
  let fyd = prm.kdFy * f32(prm.height);
  let xc = (f32(px) + 0.5 - prm.kdCx * f32(prm.width)) / fxd * z;
  let yc = (f32(py) + 0.5 - prm.kdCy * f32(prm.height)) / fyd * z;
  let sig = prm.sigmaFrac * f32(s) * z / (0.5 * (fxd + fyd));
  var scl = vec3f(sig);
  var q = vec4f(1.0, 0.0, 0.0, 0.0);
  var n = vec3f(0.0);
  if (prm.hasNormal == 1u) {
    let k = 3u * (py * prm.width + px);
    n = vec3f(normalIn[k], normalIn[k + 1u], normalIn[k + 2u]);
  } else {
    n = normalFromDepth(px, py, z);
  }
  let nl = length(n);
  if (nl > 0.5 && nl < 3.4e38) {
    n = n / nl;
    let vd = normalize(vec3f(xc, yc, z));
    var d = dot(n, vd);
    if (d > 0.0) { n = -n; d = -d; }
    let cosA = abs(d);
    var t1 = vd - d * n;
    let t1l = length(t1);
    if (t1l > 1e-4) {
      t1 = t1 / t1l;
    } else {
      var a = vec3f(0.0, n.z, -n.y);
      if (length(a) < 1e-3) { a = vec3f(-n.z, 0.0, n.x); }
      t1 = a / max(length(a), 1e-6);
    }
    let t2 = cross(n, t1);
    q = quatFromMatrix(t1.x, t2.x, n.x, t1.y, t2.y, n.y, t1.z, t2.z, n.z);
    let stretch = min(1.0 / max(cosA, 1e-3), prm.maxStretch);
    scl = vec3f(sig * stretch, sig, sig * prm.flatFrac);
  }

  // anchor: rescale about the camera, then camera -> ENU (lift.ts toEnu)
  let f = range / len;
  let pc = pp * f;
  scl = scl * f;
  let pe = vec3f(
    prm.ex + prm.r00 * pc.x + prm.r01 * pc.y + prm.r02 * pc.z,
    prm.ey + prm.r10 * pc.x + prm.r11 * pc.y + prm.r12 * pc.z,
    prm.ez + prm.r20 * pc.x + prm.r21 * pc.y + prm.r22 * pc.z,
  );
  let bw = q.x; let bx = q.y; let by = q.z; let bz = q.w;
  var qe = vec4f(
    prm.qw * bw - prm.qx * bx - prm.qy * by - prm.qz * bz,
    prm.qw * bx + prm.qx * bw + prm.qy * bz - prm.qz * by,
    prm.qw * by - prm.qx * bz + prm.qy * bw + prm.qz * bx,
    prm.qw * bz + prm.qx * by - prm.qy * bx + prm.qz * bw,
  );
  qe = normalize(qe);
  // Sigma = R diag(s^2) R^T (splats.ts packSplats)
  let w = qe.x; let x = qe.y; let y = qe.z; let zq = qe.w;
  let r00 = 1.0 - 2.0 * (y * y + zq * zq);
  let r01 = 2.0 * (x * y - w * zq);
  let r02 = 2.0 * (x * zq + w * y);
  let r10 = 2.0 * (x * y + w * zq);
  let r11 = 1.0 - 2.0 * (x * x + zq * zq);
  let r12 = 2.0 * (y * zq - w * x);
  let r20 = 2.0 * (x * zq - w * y);
  let r21 = 2.0 * (y * zq + w * x);
  let r22 = 1.0 - 2.0 * (x * x + y * y);
  let m00 = r00 * scl.x; let m01 = r01 * scl.y; let m02 = r02 * scl.z;
  let m10 = r10 * scl.x; let m11 = r11 * scl.y; let m12 = r12 * scl.z;
  let m20 = r20 * scl.x; let m21 = r21 * scl.y; let m22 = r22 * scl.z;

  let slot = atomicAdd(&counter[0], 1u);
  if (slot >= prm.capacity) { return; }
  let cell = gj * prm.gw + gi;
  let o = slot * 12u;
  splats[o] = bitcast<u32>(pe.x);
  splats[o + 1u] = bitcast<u32>(pe.y);
  splats[o + 2u] = bitcast<u32>(pe.z);
  // reconstructed (nearfield/types.ts PROVENANCE_CODE)
  splats[o + 3u] = bitcast<u32>(1.0);
  splats[o + 4u] = bitcast<u32>(m00 * m00 + m01 * m01 + m02 * m02);
  splats[o + 5u] = bitcast<u32>(m00 * m10 + m01 * m11 + m02 * m12);
  splats[o + 6u] = bitcast<u32>(m00 * m20 + m01 * m21 + m02 * m22);
  splats[o + 7u] = bitcast<u32>(m10 * m10 + m11 * m11 + m12 * m12);
  splats[o + 8u] = bitcast<u32>(m10 * m20 + m11 * m21 + m12 * m22);
  splats[o + 9u] = bitcast<u32>(m20 * m20 + m21 * m21 + m22 * m22);
  // grey until the colour kernel runs
  splats[o + 10u] = 0xff808080u;
  splats[o + 11u] = cell;
  if (prm.writeCloud == 1u) {
    let c = slot * ${LIFT_RECORD_WORDS}u;
    cloud[c] = bitcast<u32>(pe.x);
    cloud[c + 1u] = bitcast<u32>(pe.y);
    cloud[c + 2u] = bitcast<u32>(pe.z);
    cloud[c + 3u] = bitcast<u32>(scl.x);
    cloud[c + 4u] = bitcast<u32>(scl.y);
    cloud[c + 5u] = bitcast<u32>(scl.z);
    cloud[c + 6u] = bitcast<u32>(qe.x);
    cloud[c + 7u] = bitcast<u32>(qe.y);
    cloud[c + 8u] = bitcast<u32>(qe.z);
    cloud[c + 9u] = bitcast<u32>(qe.w);
    cloud[c + 10u] = 0xff808080u;
    cloud[c + 11u] = 1u;
  }
}
`;

export const FINALIZE_WGSL = /* wgsl */ `\
${PRM_STRUCT}
@group(0) @binding(0) var<uniform> prm: Prm;
@group(0) @binding(1) var<storage, read> counter: array<u32>;
@group(0) @binding(2) var<storage, read_write> splats: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= prm.capacity) { return; }
  if (i < min(counter[0], prm.capacity)) { return; }
  let o = i * 12u;
  // a NaN position is dropped by the sorter (key 65536) and alpha 0 is culled by the vertex stage
  splats[o] = 0x7fc00000u;
  splats[o + 1u] = 0x7fc00000u;
  splats[o + 2u] = 0x7fc00000u;
  splats[o + 10u] = 0u;
  splats[o + 11u] = 0xffffffffu;
}
`;

export const COLOUR_WGSL = /* wgsl */ `\
${PRM_STRUCT}
@group(0) @binding(0) var<uniform> prm: Prm;
@group(0) @binding(1) var<storage, read> counter: array<u32>;
@group(0) @binding(2) var<storage, read_write> splats: array<u32>;
@group(0) @binding(3) var tex: texture_2d<f32>;

// ./schedule.ts tapsPerAxis
fn taps(stride: u32, grid: u32, size: u32) -> u32 {
  let px = f32(stride) * f32(size) / f32(grid);
  return u32(clamp(ceil(px), 1.0, 4.0));
}
// ./schedule.ts blockTapPixels
fn tapPixel(g: u32, t: u32, n: u32, stride: u32, grid: u32, size: u32) -> i32 {
  let lo = f32(g) * f32(stride) * f32(size) / f32(grid);
  let span = f32(stride) * f32(size) / f32(grid);
  let x = lo + (f32(t) + 0.5) * span / f32(n);
  return i32(clamp(floor(x), 0.0, f32(size) - 1.0));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= min(counter[0], prm.capacity)) { return; }
  let o = i * 12u;
  let cell = splats[o + 11u];
  let gi = cell % prm.gw;
  let gj = cell / prm.gw;
  let size = textureDimensions(tex);
  let nx = taps(prm.stride, prm.width, size.x);
  let ny = taps(prm.stride, prm.height, size.y);
  var sum = vec3f(0.0);
  for (var ty = 0u; ty < ny; ty++) {
    let y = tapPixel(gj, ty, ny, prm.stride, prm.height, size.y);
    for (var tx = 0u; tx < nx; tx++) {
      let x = tapPixel(gi, tx, nx, prm.stride, prm.width, size.x);
      sum += round(clamp(textureLoad(tex, vec2i(x, y), 0).rgb, vec3f(0.0), vec3f(1.0)) * 255.0);
    }
  }
  let m = vec3u(floor(sum / f32(nx * ny) + 0.5));
  splats[o + 10u] = m.x | (m.y << 8u) | (m.z << 16u) | (255u << 24u);
}
`;

export const K_LIVE_DEPTH = defineKernel(
	"nearfield-live-depth",
	DEPTH_WGSL,
	[
		["prm", "uniform"],
		["zIn", "read-only-storage"],
		["maskIn", "read-only-storage"],
		["scaleIn", "read-only-storage"],
		["depth", "storage"],
	],
	{ group: LIVE_GROUP, label: "nearfield-live-depth" },
);

export const K_LIVE_LIFT = defineKernel(
	"nearfield-live-lift",
	LIFT_WGSL,
	[
		["prm", "uniform"],
		["crv", "uniform"],
		["depth", "read-only-storage"],
		["normalIn", "read-only-storage"],
		["dem", "read-only-storage"],
		["counter", "storage"],
		["splats", "storage"],
		["cloud", "storage"],
	],
	{ group: LIVE_GROUP, label: "nearfield-live-lift" },
);

export const K_LIVE_FINALIZE = defineKernel(
	"nearfield-live-finalize",
	FINALIZE_WGSL,
	[
		["prm", "uniform"],
		["counter", "read-only-storage"],
		["splats", "storage"],
	],
	{ group: LIVE_GROUP, label: "nearfield-live-finalize" },
);

export const K_LIVE_COLOUR = defineKernel(
	"nearfield-live-colour",
	COLOUR_WGSL,
	[
		["prm", "uniform"],
		["counter", "read-only-storage"],
		["splats", "storage"],
		["tex", "texture"],
	],
	{ group: LIVE_GROUP, label: "nearfield-live-colour" },
);

/** The curve uniform (LIVE_MAX_KNOTS knots as vec4 (x0, y0, x1, y1) pairs); knots past the cap are thinned evenly. */
export function packLiveCurve(
	curve: { x: readonly number[]; y: readonly number[] } | undefined,
): { words: Float32Array; n: number } {
	const words = new Float32Array(LIVE_MAX_KNOTS * 2);
	if (!curve || !curve.x.length) return { words, n: 0 };
	const total = curve.x.length;
	const n = Math.min(total, LIVE_MAX_KNOTS);
	for (let k = 0; k < n; k++) {
		// evenly spaced picks keep both end knots
		const src = n === total ? k : Math.round((k * (total - 1)) / (n - 1));
		words[2 * k] = curve.x[src];
		words[2 * k + 1] = curve.y[src];
	}
	return { words, n };
}
