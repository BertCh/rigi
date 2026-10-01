// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The silhouette pass mask on WebGPU (WebGpuEngine's autoAlign re-rank): the WGSL twin of
// deck/silhouette-gl.ts. deck/silhouette-mask.ts has the predicate, the layout and the identity
// argument. The range lives in each re-rank source's `targets.geometry` (rgba32float, w = range,
// 0 = sky, row 0 = top) on the render device, so the kernel runs there (no compute-device gate is
// needed: nothing crosses devices). One invocation per 96-pixel group writes 3 words of pass bits
// + a header (nonce << 16 | positive texels << 8 | undecided); every pose of one re-rank is one kernel
// node of ONE core ComputeGraph (cachedGraph group "silhouette-mask", keyed by pose count and target
// shape), run as one encoder and one submit after the geometry passes (same queue → they see the
// finished targets), and read back by ONE read node (one staged copy, core/readback): 18 KB per
// 384 × 288 pose instead of the 1.77 MB rgba32float range readback. The graph only imports: the
// per-pose uniforms and the output buffer stay owned by this class, the targets are bound per run.
// A dispatch that fails validation silently leaves the output untouched: the per-call nonce in
// every header makes scoreFromMask reject such a mask (that pose is then scored on the CPU).
import { Buffer, type Device, type Texture } from "@luma.gl/core";
import {
	SIL_GROUP,
	silGroups,
	silhouetteThresholds,
	silMaskWords,
} from "#/lib/deck/silhouette-mask";
import { type ComputeGraph, cachedGraph } from "#/lib/gpu/core/graph";
import { defineKernel } from "#/lib/gpu/core/kernel";
import { importSampledTexture, textureShapeKey } from "./graph-texture";

const WG = 64;

const WGSL = /* wgsl */ `
struct P {
	w: i32, h: i32, groups: i32, base: u32,
	nonce: u32, rmax: f32, khi: f32, klo: f32,
	zlo: f32, zhi: f32, flo: f32, fhi: f32,
};
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var geo: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> outp: array<u32>;

// 0 = surely fail, 1 = surely pass, 2 = undecided
const F = 0u;
const T = 1u;
const U = 2u;

fn odd(v: f32) -> bool {
	let b = bitcast<u32>(v) & 0x7fffffffu;
	return (b != 0u && b < 0x00800000u) || b >= 0x7f800000u; // denormal, Inf, NaN
}
fn rangeAt(x: i32, y: i32) -> f32 {
	return textureLoad(geo, vec2<i32>(x, y), 0).w;
}
fn nb(rn: f32, rc: f32, z: u32) -> u32 {
	if (odd(rn)) { return U; }
	if (!(rn > 0.0)) { return z; }
	var lt = U;
	if (rn <= prm.flo) { lt = T; } else if (rn >= prm.fhi) { lt = F; }
	var r = U;
	if (rn >= rc * prm.khi) { r = T; } else if (rn <= rc * prm.klo) { r = F; }
	if (lt == T) { return r; }
	if (lt == F) { return z; }
	if (r == z && r != U) { return r; }
	return U;
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
	let j = i32(id.x);
	if (j >= prm.groups * prm.h) { return; }
	let y = j / prm.groups;
	let g = j - y * prm.groups;
	var bits = array<u32, 3>(0u, 0u, 0u);
	var und = 0u;
	// positive-range texels of the group's row (all rows / columns): the zero-texture guard
	var pos = 0u;
	for (var k = 0; k < ${SIL_GROUP}; k++) {
		let x = g * ${SIL_GROUP} + k;
		if (x >= prm.w) { break; }
		let r = rangeAt(x, y);
		if (!odd(r) && r > 0.0) { pos++; }
	}
	if (y >= 1 && y <= prm.h - 2) {
		for (var k = 0; k < ${SIL_GROUP}; k++) {
			let x = g * ${SIL_GROUP} + k;
			if (x < 1 || x > prm.w - 2) { continue; }
			let rc = rangeAt(x, y);
			if (odd(rc)) { und++; continue; }
			if (!(rc > 0.0) || rc > prm.rmax) { continue; }
			var z = U;
			if (rc <= prm.zlo) { z = T; } else if (rc >= prm.zhi) { z = F; }
			let a = nb(rangeAt(x, y - 1), rc, z);
			let b = nb(rangeAt(x + 1, y), rc, z);
			let c = nb(rangeAt(x - 1, y), rc, z);
			if (a == T || b == T || c == T) {
				bits[k >> 5u] |= 1u << u32(k & 31);
			} else if (a == U || b == U || c == U) {
				und++;
			}
		}
	}
	let o = prm.base + u32(j) * 4u;
	outp[o] = bits[0];
	outp[o + 1u] = bits[1];
	outp[o + 2u] = bits[2];
	outp[o + 3u] = (prm.nonce << 16u) | (pos << 8u) | min(und, 255u);
}
`;

// gpu/core owns the pipeline: cached per device, compiled with createComputePipelineAsync (the graph's
// compileAsync: no render-thread stall), dropped when the device is lost, and checked by
// scripts/gpu/kernel-layout-check.
const SPEC = defineKernel(
	"silhouette-mask",
	WGSL,
	[
		["prm", "uniform"],
		["geo", "texture"],
		["outp", "storage"],
	],
	{ group: "silhouette" },
);

/** core cachedGraph group (src/lib/gpu/app-graph/manifest.ts "silhouette-gpu"). */
const GRAPH_GROUP = "silhouette-mask";
const PRM_BYTES = 48;

type MaskRun = {
	/** the output buffer's byteLength: each dispatch binds all of it, as the raw dispatch did */
	outBufferBytes: number;
};

/**
 * One kernel node per pose (node i: uniform `prm<i>`, target `geo<i>`, writing its own block of the
 * shared output from word i · per), then one read node of the `bytes` the masks fill.
 */
function buildMaskGraph(
	g: ComputeGraph<MaskRun>,
	targets: Texture[],
	W: number,
	H: number,
	bytes: number,
) {
	const out = g.importBuffer("out", bytes);
	const outp = { buffer: out, size: (p: MaskRun) => p.outBufferBytes };
	const x = Math.ceil((silGroups(W) * H) / WG);
	targets.forEach((tex, i) => {
		g.addKernel({
			id: `mask${i}`,
			spec: SPEC,
			bindings: {
				prm: g.importBuffer(`prm${i}`, PRM_BYTES, undefined, Buffer.UNIFORM),
				geo: importSampledTexture(g, `geo${i}`, tex),
				outp,
			},
			workgroups: [x],
		});
	});
	g.readNode("mask-read", [{ buffer: out, size: bytes }]);
}

/** One per WebGpuEngine (one render device). */
export class SilhouetteMaskGpu {
	private prms: Buffer[] = [];
	private out: Buffer | null = null;
	private busy = false;
	private destroyed = false;
	/** Bytes the last run() read back. */
	lastBytes = 0;

	constructor(readonly device: Device) {}

	/**
	 * Masks of the poses drawn into `ranges` (rgba32float geometry targets, `W` × `H`, top-first),
	 * in one submit and one readback: pose k's words at k · silMaskWords(W, H). null = not run
	 * (busy / lost / compile or submit failure): the caller scores on the CPU.
	 */
	async run(
		ranges: Texture[],
		W: number,
		H: number,
		nonce: number,
	): Promise<Uint32Array | null> {
		const device = this.device;
		if (this.destroyed || this.busy || device.isLost || !ranges.length)
			return null;
		this.busy = true;
		try {
			const per = silMaskWords(W, H);
			const bytes = per * ranges.length * 4;
			// gpu-core validates each geo<i> import exactly, so the key fixes the shape of EVERY pose (one
			// shape when they all agree, the normal case; else the per-pose list in pose order)
			const poseShapes = ranges.map(textureShapeKey);
			const shapes = poseShapes.every((s) => s === poseShapes[0])
				? poseShapes[0]
				: poseShapes.join(",");
			// the lookup right before run() queues the graph's lease in the same tick (core cachedGraph's
			// rule); an eviction between the two lookups only rebuilds the graph, compiled by run() from
			// the per-device pipeline cache
			const graphOf = () =>
				cachedGraph<MaskRun, void>(
					device,
					GRAPH_GROUP,
					`${ranges.length}:${W}x${H}:${shapes}`,
					(g) => buildMaskGraph(g, ranges, W, H, bytes),
					2,
				).graph;
			await graphOf().compileAsync();
			// destroyed or lost while the pipeline compiled: nothing to allocate or submit
			if (this.destroyed || device.isLost) return null;
			if (!this.out || this.out.byteLength < bytes) {
				this.out?.destroy();
				this.out = device.createBuffer({
					id: "silhouette-mask-out",
					byteLength: bytes,
					usage: Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST,
				});
			}
			const t = silhouetteThresholds();
			const G = silGroups(W);
			const buffers: Record<string, Buffer> = { out: this.out };
			const textures: Record<string, Texture> = {};
			ranges.forEach((tex, i) => {
				const words = new ArrayBuffer(PRM_BYTES);
				const iv = new Int32Array(words);
				const uv = new Uint32Array(words);
				const fv = new Float32Array(words);
				iv[0] = W;
				iv[1] = H;
				iv[2] = G;
				uv[3] = i * per;
				uv[4] = nonce;
				fv.set([t.rmax, t.khi, t.klo, t.zlo, t.zhi, t.flo, t.fhi], 5);
				// one uniform buffer per pose: writes land at write time, before this one submit
				this.prms[i] ??= device.createBuffer({
					id: `silhouette-mask-prm-${i}`,
					byteLength: PRM_BYTES,
					usage: Buffer.UNIFORM | Buffer.COPY_DST,
				});
				this.prms[i].write(new Uint8Array(words));
				buffers[`prm${i}`] = this.prms[i];
				textures[`geo${i}`] = tex;
			});
			const { reads } = await graphOf().run(
				{ outBufferBytes: this.out.byteLength },
				{ buffers, textures },
			);
			const ab = reads["mask-read"][0];
			if (!ab || this.destroyed) return null;
			this.lastBytes = bytes;
			return new Uint32Array(ab.slice(0, bytes));
		} catch (e) {
			console.warn("[silhouette-gpu] mask pass failed, CPU re-rank", e);
			return null;
		} finally {
			this.busy = false;
		}
	}

	destroy() {
		this.destroyed = true;
		for (const b of this.prms) b.destroy();
		this.prms = [];
		this.out?.destroy();
		this.out = null;
	}
}
