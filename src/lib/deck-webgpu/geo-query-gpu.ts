// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Point queries on the geometry target (rgba32float: xyz = ENU m, w = range, 0 = sky, row 0 = top)
// without a full CPU readback (~12 MB at 1024 px): three small kernels on the render device, run as
// core ComputeGraphs (cachedGraph group "geo-query", keyed by the kernels and the target's shape):
// one kernel node per query, every query of one call in ONE encoder and ONE submit, and one read
// node (one staged copy of a few bytes, core/readback). The occlusion verdicts and the skyline of a
// settle share one graph run (they were two submits); the gather follows on its own (it needs the
// verdicts). The decision logic and its exactness argument live in deck/geo-query.ts; the node check
// scripts/gpu/geo-query-check.ts emulates these kernels and reflects the layouts.
//   verdicts             per peak: 2 bits per sample (hidden / visible / undecided), 4 B per peak
//   gather(tex, xy)      raw texels (bit copies) at the requested pixels, 16 B per pixel
//   skyline              per column the first terrain row (u32), 4 B per column
// The graphs only import: the uniform, input and output buffers are created per call (and
// destroyed after its read), as the raw dispatches did, and each kernel binds them whole.
// Every output word carries a per-call nonce: a dispatch that failed validation silently leaves
// the buffer untouched (zeros), so a missing nonce rejects the result and the caller takes the
// full-readback path. null = not run (lost device, compile / submit failure, bad nonce).
import { Buffer, type Device, type Texture } from "@luma.gl/core";
import { OCC_STRIDE } from "#/lib/deck/geo-query";
import { type ComputeGraph, cachedGraph } from "#/lib/gpu/core/graph";
import { defineKernel } from "#/lib/gpu/core/kernel";
import { importSampledTexture, textureShapeKey } from "./graph-texture";

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

/** core cachedGraph group (src/lib/gpu/app-graph/manifest.ts "geo-query-gpu"). */
const GRAPH_GROUP = "geo-query";
const PRM_BYTES = 16;
/** the smallest output buffer a call creates (Math.max(16, …)): the graph's import capacity */
const MIN_OUT_BYTES = 16;
const READ_NODE = "query-read";

/** One kernel of a call: `n` threads over `input` (u32 words, or none) into `outWords` words. */
type QueryJob = {
	which: Which;
	n: number;
	input: Uint32Array | null;
	outWords: number;
	nonce: number;
};

/** Per-run sizes of each job's buffers (bound whole, as the raw dispatches bound them). */
type QueryRun = {
	jobs: {
		n: number;
		inputBytes: number;
		outBufferBytes: number;
		readBytes: number;
	}[];
};

/**
 * Job j: uniform `prm<j>`, output `out<j>` and (verdict / gather) input `q<j>`, all imports bound per
 * run, over the one target `geo`; then one read node of every job's output words, in job order.
 */
function buildQueryGraph(
	g: ComputeGraph<QueryRun>,
	kinds: Which[],
	tex: Texture,
) {
	const geo = importSampledTexture(g, "geo", tex);
	const reads = kinds.map((which, j) => {
		const out = g.importBuffer(`out${j}`, MIN_OUT_BYTES);
		const bindings: Parameters<typeof g.addKernel>[0]["bindings"] = {
			prm: g.importBuffer(`prm${j}`, PRM_BYTES, undefined, Buffer.UNIFORM),
			geo,
			outp: { buffer: out, size: (p) => p.jobs[j].outBufferBytes },
		};
		if (which !== "skyline")
			bindings.q = {
				buffer: g.importBuffer(`q${j}`, 4, undefined, Buffer.STORAGE),
				size: (p) => p.jobs[j].inputBytes,
			};
		g.addKernel({
			id: `${which}${j}`,
			spec: SPECS[which],
			bindings,
			workgroups: (p) => [Math.ceil(p.jobs[j].n / WG)],
		});
		return { buffer: out, size: (p: QueryRun) => p.jobs[j].readBytes };
	});
	g.readNode(READ_NODE, reads);
}

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
	 * Runs `jobs` over `tex` in one graph run (one submit, one read). Resolves each job's output
	 * words, null on any failure.
	 */
	private async run(
		tex: Texture,
		jobs: QueryJob[],
	): Promise<Uint32Array[] | null> {
		const device = this.device;
		const label = jobs.map((j) => j.which).join("+");
		if (this.destroyed || device.isLost || !jobs.every((j) => j.n > 0))
			return null;
		const bufs: Buffer[] = [];
		try {
			// no group lease: the lookup right before run() queues the graph's lease in the same tick
			// (core cachedGraph's rule), so a concurrent call of another key (the hover gather during a
			// settle's verdicts + skyline) is not serialised behind this one; an eviction between the
			// two lookups only rebuilds the graph, compiled by run() from the per-device pipeline cache
			const graphOf = () =>
				cachedGraph<QueryRun, void>(
					device,
					GRAPH_GROUP,
					`${label}:${textureShapeKey(tex)}`,
					(g) =>
						buildQueryGraph(
							g,
							jobs.map((j) => j.which),
							tex,
						),
					6,
				).graph;
			await graphOf().compileAsync();
			const w = tex.width;
			const h = tex.height;
			const buffers: Record<string, Buffer> = {};
			const run: QueryRun = { jobs: [] };
			jobs.forEach(({ n, input, outWords, nonce }, j) => {
				const words = new ArrayBuffer(PRM_BYTES);
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
					byteLength: Math.max(MIN_OUT_BYTES, outWords * 4),
					usage: Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST,
				});
				bufs.push(out);
				buffers[`prm${j}`] = prm;
				buffers[`out${j}`] = out;
				let inputBytes = 0;
				if (input) {
					const q = device.createBuffer({
						id: "geo-query-in",
						usage: Buffer.STORAGE | Buffer.COPY_DST,
						data: input,
					});
					bufs.push(q);
					buffers[`q${j}`] = q;
					inputBytes = q.byteLength;
				}
				run.jobs.push({
					n,
					inputBytes,
					outBufferBytes: out.byteLength,
					readBytes: outWords * 4,
				});
			});
			const { reads } = await graphOf().run(run, {
				buffers,
				textures: { geo: tex },
			});
			if (this.destroyed) return null;
			const bytes = run.jobs.reduce((a, j) => a + j.readBytes, 0);
			this.lastBytes = bytes;
			this.totalBytes += bytes;
			return reads[READ_NODE].map(
				(ab, j) => new Uint32Array(ab.slice(0, run.jobs[j].readBytes)),
			);
		} catch (e) {
			console.warn(`[geo-query] ${label} failed, full readback`, e);
			return null;
		} finally {
			for (const b of bufs) b.destroy();
		}
	}

	/** Verdict words (nonce << 16 | s0 | s1 << 2) per slot, or null on a nonce mismatch. */
	private static decodeVerdicts(r: Uint32Array, nonce: number) {
		for (let i = 0; i < r.length; i++)
			if (r[i] >>> 16 !== nonce) {
				console.warn("[geo-query] verdict nonce mismatch, full readback");
				return null;
			}
		return r.map((x) => x & 0xffff);
	}

	/** First terrain row per column, or null on a nonce mismatch or a denormal. */
	private static decodeSkyline(r: Uint32Array, nonce: number) {
		const rows = new Uint32Array(r.length);
		for (let c = 0; c < r.length; c++) {
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

	/**
	 * The verdict words of an occlusion plan's input (`words`; nonce << 16 | s0 | s1 << 2 per slot;
	 * empty input → an empty array, no verdict kernel) and the skyline rows (first terrain row per
	 * column, h = none), in ONE graph run. Each is null when it failed: the run, its nonce, or (rows)
	 * a column that met a denormal; the caller then derives it from the full readback (see
	 * deck/geo-query.ts).
	 */
	async verdictsAndSkyline(
		tex: Texture,
		words: Uint32Array,
	): Promise<{ codes: Uint32Array | null; rows: Uint32Array | null }> {
		const n = words.length / OCC_STRIDE;
		const w = tex.width;
		// nonces in the order of the former separate calls: verdicts first, then the skyline
		const jobs: QueryJob[] = [];
		if (n)
			jobs.push({
				which: "verdict",
				n,
				input: words,
				outWords: n,
				nonce: this.nextNonce(),
			});
		jobs.push({
			which: "skyline",
			n: w,
			input: null,
			outWords: w,
			nonce: this.nextNonce(),
		});
		const r = await this.run(tex, jobs);
		if (!r) return { codes: null, rows: null };
		const sky = jobs.length - 1;
		return {
			codes: n
				? GeoQueryGpu.decodeVerdicts(r[0], jobs[0].nonce)
				: new Uint32Array(0),
			rows: GeoQueryGpu.decodeSkyline(r[sky], jobs[sky].nonce),
		};
	}

	/** Raw texels (x y z w as float32, 4 per pixel) at `xy` (x0 y0 x1 y1 ...), or null. */
	async gather(
		tex: Texture,
		xy: ArrayLike<number>,
	): Promise<Float32Array | null> {
		const n = xy.length / 2;
		if (!n) return new Float32Array(0);
		const nonce = this.nextNonce();
		const r = await this.run(tex, [
			{
				which: "gather",
				n,
				input: Uint32Array.from(xy as ArrayLike<number>),
				outWords: n * 5,
				nonce,
			},
		]);
		if (!r) return null;
		const words = r[0];
		const out = new Float32Array(n * 4);
		const view = new Uint32Array(out.buffer);
		for (let i = 0; i < n; i++) {
			if (words[i * 5] !== nonce) {
				console.warn("[geo-query] gather nonce mismatch, full readback");
				return null;
			}
			view.set(words.subarray(i * 5 + 1, i * 5 + 5), i * 4);
		}
		return out;
	}

	destroy() {
		this.destroyed = true;
	}
}
