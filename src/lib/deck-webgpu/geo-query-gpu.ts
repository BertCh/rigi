// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Point queries on the geometry target (rgba32float: xyz = ENU m, w = range, 0 = sky, row 0 = top)
// without a full CPU readback (~12 MB at 1024 px): three small kernels on the render device, each
// one dispatch + one staged read of a few bytes (core/readback), the same pattern as
// silhouette-gpu.ts. The decision logic and its exactness argument live in deck/geo-query.ts; the
// node check scripts/gpu/geo-query-check.ts emulates these kernels and reflects the layouts.
//   verdicts(tex, plan)   per peak: 2 bits per sample (hidden / visible / undecided), 4 B per peak
//   gather(tex, xy)       raw texels (bit copies) at the requested pixels, 16 B per pixel
//   skyline(tex, w, h)    per column the first terrain row (u32), 4 B per column
// Every output word carries a per-call nonce: a dispatch that failed validation silently leaves
// the buffer untouched (zeros), so a missing nonce rejects the result and the caller takes the
// full-readback path. null = not run (lost device, compile / submit failure, bad nonce).
import { Buffer, type Device, type Texture } from "@luma.gl/core";
import { OCC_STRIDE } from "#/lib/deck/geo-query";
import { defineKernel, dispatch, kernelAsync } from "#/lib/gpu/core/kernel";
import { submit } from "#/lib/gpu/core/queue";
import { stageReads } from "#/lib/gpu/core/readback";

const WG = 64;

/** Shared header of every kernel: params + the geometry texture. */
const HEAD = /* wgsl */ `
struct P { n: u32, nonce: u32, w: i32, h: i32 };
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var geo: texture_2d<f32>;
fn rangeBits(x: i32, y: i32) -> u32 {
	return bitcast<u32>(textureLoad(geo, vec2<i32>(x, y), 0).w);
}
`;

// per sample: 1 = visible, 0 = hidden, 2 = undecided (deck/geo-query.ts sampleState, bit for bit)
export const VERDICT_WGSL = /* wgsl */ `${HEAD}
@group(0) @binding(2) var<storage, read> q: array<u32>;
@group(0) @binding(3) var<storage, read_write> outp: array<u32>;

fn sampleState(b: u32, a: f32) -> u32 {
	let e = (b >> 23u) & 0xffu;
	let m = b & 0x7fffffu;
	if ((b & 0x80000000u) != 0u || (e == 0u && m == 0u) || e == 0xffu) { return 1u; }
	if (e == 0u) { return 2u; }
	if (bitcast<f32>(b) > a) { return 1u; }
	return 0u;
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
	if (id.x >= prm.n) { return; }
	let o = id.x * ${OCC_STRIDE}u;
	let a = bitcast<f32>(q[o + 4u]);
	let s0 = sampleState(rangeBits(i32(q[o]), i32(q[o + 1u])), a);
	let s1 = sampleState(rangeBits(i32(q[o + 2u]), i32(q[o + 3u])), a);
	outp[id.x] = (prm.nonce << 16u) | s0 | (s1 << 2u);
}
`;

// out: 5 words per pixel: nonce, then the raw bits of x y z w
export const GATHER_WGSL = /* wgsl */ `${HEAD}
@group(0) @binding(2) var<storage, read> q: array<u32>;
@group(0) @binding(3) var<storage, read_write> outp: array<u32>;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
	if (id.x >= prm.n) { return; }
	let t = textureLoad(geo, vec2<i32>(i32(q[id.x * 2u]), i32(q[id.x * 2u + 1u])), 0);
	let o = id.x * 5u;
	outp[o] = prm.nonce;
	outp[o + 1u] = bitcast<u32>(t.x);
	outp[o + 2u] = bitcast<u32>(t.y);
	outp[o + 3u] = bitcast<u32>(t.z);
	outp[o + 4u] = bitcast<u32>(t.w);
}
`;

// out per column: first terrain row (h = none) | nonce15 << 16 | 1 << 31 when a positive denormal was met
export const SKYLINE_WGSL = /* wgsl */ `${HEAD}
@group(0) @binding(2) var<storage, read_write> outp: array<u32>;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
	let c = i32(id.x);
	if (c >= prm.w) { return; }
	var row = u32(prm.h);
	var odd = 0u;
	for (var t = 0; t < prm.h; t++) {
		let b = rangeBits(c, t);
		let e = (b >> 23u) & 0xffu;
		let m = b & 0x7fffffu;
		if ((b & 0x80000000u) != 0u || e == 0xffu || (e == 0u && m == 0u)) { continue; }
		if (e == 0u) { odd = 1u; }
		row = u32(t);
		break;
	}
	outp[id.x] = row | ((prm.nonce & 0x7fffu) << 16u) | (odd << 31u);
}
`;

const GROUP = "geo-query";
const SPECS = {
	verdict: defineKernel(
		"geo-verdict",
		VERDICT_WGSL,
		[
			["prm", "uniform"],
			["geo", "texture"],
			["q", "read-only-storage"],
			["outp", "storage"],
		],
		{ group: GROUP },
	),
	gather: defineKernel(
		"geo-gather",
		GATHER_WGSL,
		[
			["prm", "uniform"],
			["geo", "texture"],
			["q", "read-only-storage"],
			["outp", "storage"],
		],
		{ group: GROUP },
	),
	skyline: defineKernel(
		"geo-skyline",
		SKYLINE_WGSL,
		[
			["prm", "uniform"],
			["geo", "texture"],
			["outp", "storage"],
		],
		{ group: GROUP },
	),
};
type Which = keyof typeof SPECS;

/** One per WebGpuEngine (one render device). */
export class GeoQueryGpu {
	private destroyed = false;
	private nonce = 0;
	/** Bytes the last successful call read back (the evidence number). */
	lastBytes = 0;
	/** Total bytes read back by this instance. */
	totalBytes = 0;

	constructor(readonly device: Device) {}

	private nextNonce() {
		this.nonce = (this.nonce % 0x7ffe) + 1;
		return this.nonce;
	}

	/**
	 * Runs `which` over `tex`: `input` (u32 words, or none) and `outWords` output words, `n` threads.
	 * Resolves the output words, null on any failure.
	 */
	private async run(
		which: Which,
		tex: Texture,
		input: Uint32Array | null,
		n: number,
		outWords: number,
		w: number,
		h: number,
		nonce: number,
	): Promise<Uint32Array | null> {
		const device = this.device;
		if (this.destroyed || device.isLost || !n) return null;
		const bufs: Buffer[] = [];
		try {
			const k = await kernelAsync(device, SPECS[which]);
			const words = new ArrayBuffer(16);
			new Uint32Array(words).set([n, nonce]);
			new Int32Array(words).set([w, h], 2);
			const prm = device.createBuffer({
				id: "geo-query-prm",
				usage: Buffer.UNIFORM | Buffer.COPY_DST,
				data: new Uint8Array(words),
			});
			bufs.push(prm);
			const out = device.createBuffer({
				id: "geo-query-out",
				byteLength: Math.max(16, outWords * 4),
				usage: Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST,
			});
			bufs.push(out);
			const bind: Record<string, Buffer | Texture> = {
				prm,
				geo: tex,
				outp: out,
			};
			if (input) {
				const q = device.createBuffer({
					id: "geo-query-in",
					usage: Buffer.STORAGE | Buffer.COPY_DST,
					data: input,
				});
				bufs.push(q);
				bind.q = q;
			}
			const enc = device.createCommandEncoder({ id: `geo-query-${which}` });
			dispatch(enc, k, bind, Math.ceil(n / WG));
			const bytes = outWords * 4;
			const st = stageReads(device, enc, [{ buffer: out, size: bytes }]);
			submit(device, enc);
			const [ab] = await st.read();
			if (this.destroyed) return null;
			this.lastBytes = bytes;
			this.totalBytes += bytes;
			return new Uint32Array(ab.slice(0, bytes));
		} catch (e) {
			console.warn(`[geo-query] ${which} failed, full readback`, e);
			return null;
		} finally {
			for (const b of bufs) b.destroy();
		}
	}

	/** Verdict words (nonce << 16 | s0 | s1 << 2) per slot of an occlusion plan's input, or null. */
	async verdicts(
		tex: Texture,
		words: Uint32Array,
	): Promise<Uint32Array | null> {
		const n = words.length / OCC_STRIDE;
		if (!n) return new Uint32Array(0);
		const nonce = this.nextNonce();
		const r = await this.run(
			"verdict",
			tex,
			words,
			n,
			n,
			tex.width,
			tex.height,
			nonce,
		);
		if (!r) return null;
		for (let i = 0; i < n; i++)
			if (r[i] >>> 16 !== nonce) {
				console.warn("[geo-query] verdict nonce mismatch, full readback");
				return null;
			}
		return r.map((x) => x & 0xffff);
	}

	/** Raw texels (x y z w as float32, 4 per pixel) at `xy` (x0 y0 x1 y1 ...), or null. */
	async gather(
		tex: Texture,
		xy: ArrayLike<number>,
	): Promise<Float32Array | null> {
		const n = xy.length / 2;
		if (!n) return new Float32Array(0);
		const nonce = this.nextNonce();
		const r = await this.run(
			"gather",
			tex,
			Uint32Array.from(xy as ArrayLike<number>),
			n,
			n * 5,
			tex.width,
			tex.height,
			nonce,
		);
		if (!r) return null;
		const out = new Float32Array(n * 4);
		const view = new Uint32Array(out.buffer);
		for (let i = 0; i < n; i++) {
			if (r[i * 5] !== nonce) {
				console.warn("[geo-query] gather nonce mismatch, full readback");
				return null;
			}
			view.set(r.subarray(i * 5 + 1, i * 5 + 5), i * 4);
		}
		return out;
	}

	/**
	 * First terrain row per column (h = none), or null (failed, or a column met a denormal: the caller
	 * then derives the skyline from the full readback; see deck/geo-query.ts).
	 */
	async skylineRows(tex: Texture): Promise<Uint32Array | null> {
		const w = tex.width;
		const nonce = this.nextNonce();
		const r = await this.run("skyline", tex, null, w, w, w, tex.height, nonce);
		if (!r) return null;
		const rows = new Uint32Array(w);
		for (let c = 0; c < w; c++) {
			const x = r[c];
			if (((x >>> 16) & 0x7fff) !== nonce || x >>> 31) {
				if (x >>> 31)
					console.warn("[geo-query] skyline denormal, full readback");
				else console.warn("[geo-query] skyline nonce mismatch, full readback");
				return null;
			}
			rows[c] = x & 0xffff;
		}
		return rows;
	}

	destroy() {
		this.destroyed = true;
	}
}
