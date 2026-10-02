// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The depth → Gaussians lift (./lift.ts, a port of the service's splat.py lift_gaussians) as one kernel
// on a core ComputeGraph. One invocation per stride cell writes its LIFT_RECORD_WORDS record (position,
// scales, quaternion, packed RGBA, kept flag); the records are read back in one slot and compacted on
// the CPU (cloudFromRecords). The CPU twin is liftRecordsCpu: same arithmetic in f64 instead of f32.
//
// Two users share the one kernel (K_LIFT) and its uniform (liftParamWords):
//   - liftGaussiansGpu(device, inp): CPU arrays in (a photo whose depth only exists on the CPU, e.g. a
//     cached depth); cachedGraph group "nearfield-lift", keyed on the power-of-two capacities:
//     imports prm (uniform), depth (W·H f32, ≤ 0 = invalid), normal (3·W·H f32, or 4 B when absent),
//     rgba (W·H u32) → LIFT kernel → records (transient, written in full for every cell < cells) → read.
//   - Step Inside's depth pipeline (./pipeline-gpu.ts graph 2): the kernel is bound to the compose
//     kernel's depth / normal and the photo prep's RGBA words, all GPU-resident, with no upload.
// Clear audit: every record word of every cell < cells is written by its invocation; the read covers
// exactly those cells, so the transient needs no clear.
import { Buffer, type Device } from "@luma.gl/core";
import { cachedGraph } from "#/lib/gpu/core/graph";
import { defineKernel } from "#/lib/gpu/core/kernel";
import {
	capacityFor,
	pooledStorage,
	pooledUniform,
	withLease,
} from "#/lib/gpu/core/pool";
import { submit } from "#/lib/gpu/core/queue";
import { defineUniformBlock } from "#/lib/gpu/core/uniform-block";
import type { GaussianCloud } from "../types";
import {
	cloudFromRecords,
	type IntrinsicsNorm,
	LIFT_DEFAULTS,
	LIFT_RECORD_WORDS,
	type LiftGrid,
	type LiftInput,
	type LiftParams,
	liftGrid,
} from "./lift";

export const LIFT_GROUP = "nearfield-lift";

/** WGSL struct Prm order. */
export const LIFT_PRM = defineUniformBlock({
	width: "u32",
	height: "u32",
	gw: "u32",
	gh: "u32",
	stride: "u32",
	hasNormal: "u32",
	edgeRatio: "f32",
	sigmaFrac: "f32",
	flatFrac: "f32",
	maxStretch: "f32",
	fx: "f32",
	fy: "f32",
	cx: "f32",
	cy: "f32",
});

export const LIFT_WGSL = /* wgsl */ `\
struct Prm {
  width: u32, height: u32, gw: u32, gh: u32,
  stride: u32, hasNormal: u32, edgeRatio: f32, sigmaFrac: f32,
  flatFrac: f32, maxStretch: f32, fx: f32, fy: f32,
  cx: f32, cy: f32,
};
@group(0) @binding(0) var<uniform> prm: Prm;
@group(0) @binding(1) var<storage, read> depth: array<f32>;
@group(0) @binding(2) var<storage, read> normal: array<f32>;
@group(0) @binding(3) var<storage, read> rgba: array<u32>;
@group(0) @binding(4) var<storage, read_write> records: array<u32>;

const NAN_Z: f32 = -1.0;

// centre depth of a cell, NAN_Z (< 0) when invalid
fn zCell(gi: u32, gj: u32) -> f32 {
  let c0 = prm.stride / 2u;
  let k = (gj * prm.stride + c0) * prm.width + gi * prm.stride + c0;
  let z = depth[k];
  // z > 0 also rejects NaN; an infinity is not finite
  if (z > 0.0 && z < 3.4e38) { return z; }
  return NAN_Z;
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
  let o = (gj * prm.gw + gi) * ${LIFT_RECORD_WORDS}u;
  records[o + 11u] = 0u;
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
  let fx = prm.fx * f32(prm.width);
  let fy = prm.fy * f32(prm.height);
  let x = (f32(px) + 0.5 - prm.cx * f32(prm.width)) / fx * z;
  let y = (f32(py) + 0.5 - prm.cy * f32(prm.height)) / fy * z;
  let sig = prm.sigmaFrac * f32(s) * z / (0.5 * (fx + fy));
  var scl = vec3f(sig);
  var q = vec4f(1.0, 0.0, 0.0, 0.0);
  if (prm.hasNormal == 1u) {
    let k = 3u * (py * prm.width + px);
    var n = vec3f(normal[k], normal[k + 1u], normal[k + 2u]);
    let nl = length(n);
    if (nl > 0.5 && nl < 3.4e38) {
      n = n / nl;
      let v = normalize(vec3f(x, y, z));
      var d = dot(n, v);
      if (d > 0.0) { n = -n; d = -d; }
      let cosA = abs(d);
      var t1 = v - d * n;
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
  }
  records[o] = bitcast<u32>(x);
  records[o + 1u] = bitcast<u32>(y);
  records[o + 2u] = bitcast<u32>(z);
  records[o + 3u] = bitcast<u32>(scl.x);
  records[o + 4u] = bitcast<u32>(scl.y);
  records[o + 5u] = bitcast<u32>(scl.z);
  records[o + 6u] = bitcast<u32>(q.x);
  records[o + 7u] = bitcast<u32>(q.y);
  records[o + 8u] = bitcast<u32>(q.z);
  records[o + 9u] = bitcast<u32>(q.w);
  var sum = vec3u(0u);
  for (var yy = gj * s; yy < gj * s + s; yy++) {
    for (var xx = gi * s; xx < gi * s + s; xx++) {
      let c = rgba[yy * prm.width + xx];
      sum += vec3u(c & 255u, (c >> 8u) & 255u, (c >> 16u) & 255u);
    }
  }
  // round half up, like Math.round on the non-negative mean
  let nn = s * s;
  let m = (sum * 2u + vec3u(nn)) / (2u * nn);
  records[o + 10u] = m.x | (m.y << 8u) | (m.z << 16u) | (255u << 24u);
  records[o + 11u] = 1u;
}
`;

export const K_LIFT = defineKernel(
	"nearfield-lift",
	LIFT_WGSL,
	[
		["prm", "uniform"],
		["depth", "read-only-storage"],
		["normal", "read-only-storage"],
		["rgba", "read-only-storage"],
		["records", "storage"],
	],
	{ group: LIFT_GROUP, label: "nearfield-lift" },
);

type Run = { cells: number; gw: number; gh: number };

/** LIFT_PRM words of one lift (`hasNormal`: the normal binding holds 3·W·H floats). */
export function liftParamWords(
	width: number,
	height: number,
	grid: LiftGrid,
	params: LiftParams,
	hasNormal: boolean,
	K: IntrinsicsNorm,
): ArrayBuffer {
	return LIFT_PRM.pack({
		width,
		height,
		gw: grid.gw,
		gh: grid.gh,
		stride: Math.max(1, Math.floor(params.stride)),
		hasNormal: hasNormal ? 1 : 0,
		edgeRatio: params.edgeRatio,
		sigmaFrac: params.sigmaFrac,
		flatFrac: params.flatFrac,
		maxStretch: params.maxStretch,
		fx: K.fx,
		fy: K.fy,
		cx: K.cx,
		cy: K.cy,
	});
}

/** RGBA bytes → one u32 per pixel (little-endian: r in the low byte). */
export function packRgba(rgba: Uint8Array | Uint8ClampedArray): Uint32Array {
	return new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >> 2);
}

/**
 * The lift on `device` from CPU arrays (LIFT_WGSL on a cached ComputeGraph). Depth is folded with `valid`
 * (invalid → 0) before upload. For callers that only have CPU depth (a cached depth); the depth pipeline
 * (./pipeline-gpu.ts) lifts straight from its GPU-resident depth instead.
 */
export async function liftGaussiansGpu(
	device: Device,
	inp: LiftInput,
	params: Partial<LiftParams> = {},
	signal?: AbortSignal,
): Promise<GaussianCloud> {
	const p = { ...LIFT_DEFAULTS, ...params };
	const s = Math.max(1, Math.floor(p.stride));
	const grid = liftGrid(inp.width, inp.height, s);
	if (!grid.cells) return cloudFromRecords(new Float32Array(0), 0);
	const n = inp.width * inp.height;
	const depth = new Float32Array(n);
	for (let i = 0; i < n; i++) depth[i] = inp.valid[i] ? inp.depth[i] : 0;
	const hasNormal = !!inp.normal && inp.normal.length >= 3 * n;
	const prmWords = liftParamWords(
		inp.width,
		inp.height,
		grid,
		p,
		hasNormal,
		inp.K,
	);
	const recBytes = grid.cells * LIFT_RECORD_WORDS * 4;
	const capPix = capacityFor(n * 4);
	const capNrm = hasNormal ? capacityFor(n * 12) : 16;
	const capRec = capacityFor(recBytes);
	const reads = await withLease(
		LIFT_GROUP,
		() => {
			const bufs = {
				prm: pooledUniform(device, `${LIFT_GROUP}/prm`, prmWords),
				depth: pooledStorage(device, `${LIFT_GROUP}/depth`, depth),
				normal: hasNormal
					? pooledStorage(
							device,
							`${LIFT_GROUP}/normal`,
							inp.normal as Float32Array,
						)
					: pooledStorage(device, `${LIFT_GROUP}/normal0`, 16),
				rgba: pooledStorage(device, `${LIFT_GROUP}/rgba`, packRgba(inp.rgba)),
			};
			const { graph } = cachedGraph<Run, null>(
				device,
				LIFT_GROUP,
				`${capPix}/${capNrm}/${capRec}`,
				(g) => {
					const STORAGE = Buffer.STORAGE | Buffer.COPY_DST;
					const prm = g.importBuffer(
						"prm",
						LIFT_PRM.byteLength,
						undefined,
						Buffer.UNIFORM | Buffer.COPY_DST,
					);
					const dep = g.importBuffer("depth", capPix, undefined, STORAGE);
					const nrm = g.importBuffer("normal", capNrm, undefined, STORAGE);
					const col = g.importBuffer("rgba", capPix, undefined, STORAGE);
					const records = g.transientBuffer("records", capRec);
					g.addKernel({
						id: "lift",
						spec: K_LIFT,
						bindings: { prm, depth: dep, normal: nrm, rgba: col, records },
						workgroups: (r) => [Math.ceil(r.gw / 8), Math.ceil(r.gh / 8)],
					});
					g.readNode("read", [
						{
							buffer: records,
							size: (r) => r.cells * LIFT_RECORD_WORDS * 4,
						},
					]);
					return null;
				},
			);
			return graph.lease(async () => {
				await graph.compileAsync();
				const enc = device.createCommandEncoder({ id: graph.id });
				const { reads } = graph.encodeReads(
					enc,
					{ cells: grid.cells, gw: grid.gw, gh: grid.gh },
					bufs,
				);
				try {
					submit(device, enc);
				} catch (e) {
					reads.cancel();
					throw e;
				}
				return reads;
			});
		},
		{ signal },
	);
	// cancelled while the kernel ran: give the readback slot back instead of reading
	if (signal?.aborted) {
		reads.cancel();
		signal.throwIfAborted();
	}
	const data = (await reads.read()).read[0];
	return cloudFromRecords(new Float32Array(data), grid.cells);
}
