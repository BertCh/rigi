// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Batched DEM height lookups from the resident height atlas (WAG W2.4, flag terrainGpuDecode): the
// WebGPU photo view's load-time and per-view CPU height readers (camera DEM height, trails, peak
// snapping) ask for TerrainSet.heightAt at many points; a tile decoded straight into the atlas
// (terrain-gpu-decode.ts) has no CPU heights, and heightAt would materialise the whole tile on the
// main thread (getCpuHeights) for a handful of samples. HeightGather answers such samples from the
// atlas instead, with heightAt's exact value:
//   plan (CPU, f64): TerrainSet.locate (heightAt's own tile lookup) and dem/grid.ts gridCorners
//     (sampleGrid's sample positions and weights) per point;
//     - a tile with CPU heights: sampleGrid right here (nothing to gather);
//     - a lazy tile resident in the atlas: its four corner texels go into the gather;
//     - anything else (not resident, layer past the packing): heightAt (the CPU twin, materialises);
//   gather (GPU, one graph run per tick): textureLoad of each requested texel, raw bits + a nonce
//     (core cachedGraph group "height-gather", one read node; no arithmetic on the GPU);
//   blend (CPU, f64): dem/grid.ts blendCorners on the gathered float32 values = sampleGrid bit for bit.
// So a gathered height equals heightAt's whenever the atlas layer holds the tile's CPU heights, which
// is the terrainGpuDecode premise itself (texel bytes == canvas bytes; terrarium-tile.ts). Requests of
// one tick share one dispatch. Every result is certified before use: each word carries the call's
// nonce (a failed dispatch leaves zeros), and each tile must hold the slot the plan read at the moment
// the gather is submitted (taken inside the graph's lease, synchronously with the submit: a tile
// evicted, or its layer re-used, between plan and submit fails it) — else that sample takes heightAt.
// The gather is skipped (all heightAt) when the atlas arrays were re-created (grown) since the plan.
import { Buffer, type Device, type Texture } from "@luma.gl/core";
import type {
	TerrainSet,
	TileLocation,
	TileMesh,
} from "#/lib/deck/terrain-data";
import {
	blendCorners,
	getCpuHeights,
	gridCorners,
	sampleGrid,
} from "#/lib/dem";
import { type ComputeGraph, cachedGraph } from "#/lib/gpu/core/graph";
import { defineKernel, submit } from "#/lib/gpu/core/kernel";
import { importSampledTexture, textureShapeKey } from "./graph-texture";
import type { ResidentHeights } from "./layers/batched-terrain";

const WG = 64;
/** texel word: x (9 bits) | y (9) << 9 | layer (12) << 18 | big << 30 (texelWord) */
const MAX_LAYER = 4096;
/** the most texels one dispatch takes (1-D workgroup count limit, 65535 · 64) */
const MAX_TEXELS = 65535 * WG;

export const HEIGHT_GATHER_WGSL = /* wgsl */ `
struct P { n: u32, nonce: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var small: texture_2d_array<f32>;
@group(0) @binding(2) var big: texture_2d_array<f32>;
@group(0) @binding(3) var<storage, read> q: array<u32>;
@group(0) @binding(4) var<storage, read_write> outp: array<u32>;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
	if (id.x >= prm.n) { return; }
	let w = q[id.x];
	let xy = vec2<i32>(i32(w & 511u), i32((w >> 9u) & 511u));
	let layer = i32((w >> 18u) & 4095u);
	var v: f32;
	if ((w >> 30u) != 0u) { v = textureLoad(big, xy, layer, 0).r; }
	else { v = textureLoad(small, xy, layer, 0).r; }
	outp[id.x * 2u] = prm.nonce;
	outp[id.x * 2u + 1u] = bitcast<u32>(v);
}
`;

const GROUP = "height-gather";
const SPEC = defineKernel(
	"height-gather",
	HEIGHT_GATHER_WGSL,
	[
		["prm", "uniform"],
		["small", "texture-array"],
		["big", "texture-array"],
		["q", "read-only-storage"],
		["outp", "storage"],
	],
	{ group: GROUP },
);
const PRM_BYTES = 16;
const MIN_BYTES = 16;
const READ_NODE = "height-read";

type GatherRun = { n: number; inBytes: number; outBytes: number };

function buildGatherGraph(
	g: ComputeGraph<GatherRun>,
	small: Texture,
	big: Texture,
) {
	const out = g.importBuffer("out", MIN_BYTES);
	g.addKernel({
		id: "gather",
		spec: SPEC,
		bindings: {
			prm: g.importBuffer("prm", PRM_BYTES, undefined, Buffer.UNIFORM),
			small: importSampledTexture(g, "small", small),
			big: importSampledTexture(g, "big", big),
			q: {
				buffer: g.importBuffer("q", 4, undefined, Buffer.STORAGE),
				size: (p) => p.inBytes,
			},
			outp: { buffer: out, size: (p) => p.outBytes },
		},
		workgroups: (p) => [Math.ceil(p.n / WG)],
	});
	g.readNode(READ_NODE, [{ buffer: out, size: (p: GatherRun) => p.outBytes }]);
}

/** Per-realm counters (globalThis.__rigiHeightGathers). */
export const heightGatherCounters = {
	/** heightsAt calls */
	requests: 0,
	/** graph runs (one per tick with GPU samples) */
	dispatches: 0,
	samples: 0,
	/** answered from the atlas */
	gpuSamples: 0,
	/** answered from a tile's CPU heights (no gather needed) */
	cpuSamples: 0,
	/** outside coverage (heightAt null) */
	nullSamples: 0,
	/** sent to heightAt: not resident, layer past the packing, or a failed certificate */
	fallbackSamples: 0,
	/** samples whose certificate failed after the gather (nonce or slot) */
	certificateMisses: 0,
	/** graph runs that failed (lost device, compile / submit error) */
	failures: 0,
	bytesRead: 0,
	/** main-thread ms in plan + blend */
	ms: 0,
};
(
	globalThis as { __rigiHeightGathers?: typeof heightGatherCounters }
).__rigiHeightGathers = heightGatherCounters;

/** A tile's place in the atlas (ResidentHeights.slotOf). */
type Slot = { layer: number; big: boolean };
/** ResidentHeights.slotOf, or null when nothing is resident (no device). */
export type SlotOf = ((tile: object) => Slot | null) | null;

/** One heightsAt call: the values known now, and what its gathered samples need. */
export type HeightPlan = {
	set: TerrainSet;
	lats: ArrayLike<number>;
	lons: ArrayLike<number>;
	/** heightAt per point (NaN = null); the gathered samples are filled by finishHeights */
	out: Float64Array;
	/** sample index, tile, slot and weights per gathered sample */
	idx: number[];
	tiles: TileMesh[];
	slots: Slot[];
	fx: number[];
	fy: number[];
	/** 4 texel words per gathered sample (h00, h01, h10, h11), packed as the kernel unpacks them */
	words: number[];
};

/** Pack one texel request (see HEIGHT_GATHER_WGSL). */
export const texelWord = (slot: Slot, x: number, y: number) =>
	(slot.layer << 18) | (slot.big ? 1 << 30 : 0) | (y << 9) | x;

/**
 * The CPU half before the gather: heightAt's lookup per point; tiles with CPU heights are sampled
 * here, lazy tiles resident in the atlas (slotOf) are planned as four texels, the rest go to heightAt.
 */
export function planHeights(
	set: TerrainSet,
	lats: ArrayLike<number>,
	lons: ArrayLike<number>,
	slotOf: SlotOf,
): HeightPlan {
	const c = heightGatherCounters;
	const n = lats.length;
	c.samples += n;
	const p: HeightPlan = {
		set,
		lats,
		lons,
		out: new Float64Array(n),
		idx: [],
		tiles: [],
		slots: [],
		fx: [],
		fy: [],
		words: [],
	};
	const out = p.out;
	const loc = { px: 0, py: 0 } as TileLocation;
	const k = [0, 0, 0, 0, 0, 0];
	let lastTile: TileMesh | null = null;
	let lastSlot: Slot | null = null;
	for (let i = 0; i < n; i++) {
		const at = set.locate(lats[i], lons[i], loc);
		if (!at) {
			out[i] = Number.NaN;
			c.nullSamples++;
			continue;
		}
		const t = at.tile;
		if (t.heights) {
			out[i] = sampleGrid(t.heights, t.size, at.px, at.py);
			c.cpuSamples++;
			continue;
		}
		if (t !== lastTile) {
			lastSlot = slotOf?.(t) ?? null;
			lastTile = t;
		}
		const slot = lastSlot;
		if (!slot || slot.layer >= MAX_LAYER || t.size > 512) {
			out[i] = sampleGrid(getCpuHeights(t), t.size, at.px, at.py);
			c.fallbackSamples++;
			continue;
		}
		gridCorners(t.size, at.px, at.py, k);
		p.idx.push(i);
		p.tiles.push(t);
		p.slots.push(slot);
		p.fx.push(k[4]);
		p.fy.push(k[5]);
		p.words.push(
			texelWord(slot, k[0], k[1]),
			texelWord(slot, k[2], k[1]),
			texelWord(slot, k[0], k[3]),
			texelWord(slot, k[2], k[3]),
		);
	}
	return p;
}

/**
 * The CPU half after the gather: `bits` holds (nonce, texel bits) word pairs for every plan of the
 * batch, this plan's from texel `first`; null = the gather failed. A gathered sample whose words carry
 * the nonce and whose tile held the planned slot when the gather was submitted (`slotOf`: that
 * snapshot) is blended (blendCorners = sampleGrid); any other goes to heightAt.
 */
export function finishHeights(
	p: HeightPlan,
	bits: Uint32Array | null,
	first: number,
	nonce: number,
	slotOf: SlotOf,
) {
	const c = heightGatherCounters;
	const { out, set, lats, lons } = p;
	const f = bits && new Float32Array(bits.buffer, bits.byteOffset, bits.length);
	// certificate: every slot the plan read is still the tile's (no eviction / re-use since)
	const ok = new Map<TileMesh, boolean>();
	const slotOk = (j: number) => {
		const t = p.tiles[j];
		let v = ok.get(t);
		if (v === undefined) {
			const s = slotOf?.(t);
			v = !!s && s.layer === p.slots[j].layer && s.big === p.slots[j].big;
			ok.set(t, v);
		}
		return v;
	};
	for (let j = 0, o = first; j < p.idx.length; j++, o += 4) {
		const i = p.idx[j];
		const w = o * 2;
		if (
			bits &&
			f &&
			bits[w] === nonce &&
			bits[w + 2] === nonce &&
			bits[w + 4] === nonce &&
			bits[w + 6] === nonce &&
			slotOk(j)
		) {
			out[i] = blendCorners(
				f[w + 1],
				f[w + 3],
				f[w + 5],
				f[w + 7],
				p.fx[j],
				p.fy[j],
			);
			c.gpuSamples++;
		} else {
			if (bits) c.certificateMisses++;
			out[i] = set.heightAt(lats[i], lons[i]) ?? Number.NaN;
			c.fallbackSamples++;
		}
	}
	return out;
}

type Pending = { plan: HeightPlan; resolve: (v: Float64Array) => void };
/** A gather's texel words and its certificate: each tile's slot when the gather was submitted. */
type Gathered = { bits: Uint32Array; slotOf: NonNullable<SlotOf> };

/**
 * Heights of `points` on a TerrainSet, equal to TerrainSet.heightAt bit for bit (NaN where heightAt
 * is null), gathered from the WebGPU engine's resident height atlas where a tile has no CPU heights.
 * One per WebGpuEngine render device.
 */
export class HeightGather {
	private destroyed = false;
	private nonce = 0;
	private queue: Pending[] = [];
	private flushQueued = false;

	constructor(
		readonly device: Device,
		private resident: () => ResidentHeights | null,
	) {}

	private slotOf(): SlotOf {
		if (this.destroyed || this.device.isLost) return null;
		return this.resident()?.slotOf ?? null;
	}

	/**
	 * heightAt at (lats[i], lons[i]) as a Float64Array (NaN = null). Synchronous when no point needs
	 * the atlas (every tile involved has CPU heights, or none is resident), else a promise that resolves
	 * after this tick's gather.
	 */
	heightsAt(
		set: TerrainSet,
		lats: ArrayLike<number>,
		lons: ArrayLike<number>,
	): Float64Array | Promise<Float64Array> {
		const t0 = performance.now();
		heightGatherCounters.requests++;
		const plan = planHeights(set, lats, lons, this.slotOf());
		heightGatherCounters.ms += performance.now() - t0;
		if (!plan.idx.length) return plan.out;
		return new Promise<Float64Array>((resolve) => {
			this.queue.push({ plan, resolve });
			if (!this.flushQueued) {
				this.flushQueued = true;
				queueMicrotask(() => void this.flush());
			}
		});
	}

	private async flush() {
		this.flushQueued = false;
		const batch = this.queue;
		this.queue = [];
		let total = 0;
		for (const { plan } of batch) total += plan.words.length;
		let gathered: Gathered | null = null;
		this.nonce = (this.nonce % 0x7ffffffe) + 1;
		const nonce = this.nonce;
		if (total <= MAX_TEXELS) {
			const words = new Uint32Array(total);
			let o = 0;
			for (const { plan } of batch) {
				words.set(plan.words, o);
				o += plan.words.length;
			}
			gathered = await this.run(words, nonce, batch);
		}
		const t0 = performance.now();
		let first = 0;
		for (const { plan, resolve } of batch) {
			resolve(
				finishHeights(
					plan,
					gathered?.bits ?? null,
					first,
					nonce,
					gathered?.slotOf ?? null,
				),
			);
			first += plan.words.length;
		}
		heightGatherCounters.ms += performance.now() - t0;
	}

	/**
	 * One graph run over `words` texels: 2 words (nonce, bits) per texel and the slots of `batch`'s
	 * tiles as they were when the gather was submitted, or null on failure (or when the atlas arrays
	 * were re-created since the plan).
	 */
	private async run(
		words: Uint32Array,
		nonce: number,
		batch: Pending[],
	): Promise<Gathered | null> {
		const device = this.device;
		const planned = this.destroyed || device.isLost ? null : this.resident();
		if (!planned) return null;
		const { small, big } = planned;
		const graphOf = () =>
			cachedGraph<GatherRun, void>(
				device,
				GROUP,
				`${textureShapeKey(small)}|${textureShapeKey(big)}`,
				(g) => buildGatherGraph(g, small, big),
				4,
			).graph;
		const bufs: Buffer[] = [];
		try {
			await graphOf().compileAsync();
			const n = words.length;
			const prm = device.createBuffer({
				id: "height-gather-prm",
				usage: Buffer.UNIFORM | Buffer.COPY_DST,
				data: new Uint32Array([n, nonce, 0, 0]),
			});
			const q = device.createBuffer({
				id: "height-gather-in",
				usage: Buffer.STORAGE | Buffer.COPY_DST,
				data: words,
			});
			const outBytes = n * 8;
			const out = device.createBuffer({
				id: "height-gather-out",
				byteLength: Math.max(MIN_BYTES, outBytes),
				usage: Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST,
			});
			bufs.push(prm, q, out);
			// core cachedGraph's rule: the lookup right before the graph's lease, in the same tick
			const graph = graphOf();
			const submitted = await graph.lease(() => {
				// the certificate is taken here, synchronously with the submit: every atlas write is a
				// synchronous queue submit (TileStore.sync), so a tile holding its planned slot NOW has its
				// heights in that layer ahead of this gather in queue order; a later eviction or re-use of
				// the layer is queued after it (a check after the readback would miss an evict / re-add
				// of the same tile to the same layer in between)
				const res = this.destroyed || device.isLost ? null : this.resident();
				// the atlas grew (arrays re-created, the old ones destroyed) since the plan: heightAt
				if (!res || res.small !== small || res.big !== big) return null;
				const slots = new Map<object, Slot | null>();
				for (const { plan } of batch)
					for (const t of plan.tiles)
						if (!slots.has(t)) slots.set(t, res.slotOf(t));
				graph.compile();
				const enc = device.createCommandEncoder({ id: graph.id });
				const { reads } = graph.encodeReads(
					enc,
					{ n, inBytes: q.byteLength, outBytes },
					{ prm, q, out },
					{ small, big },
				);
				try {
					submit(device, enc);
				} catch (e) {
					reads.cancel();
					throw e;
				}
				return { reads, slots };
			});
			if (!submitted) return null;
			const r = await submitted.reads.read();
			heightGatherCounters.dispatches++;
			heightGatherCounters.bytesRead += outBytes;
			const { slots } = submitted;
			return {
				bits: new Uint32Array(r[READ_NODE][0].slice(0, outBytes)),
				slotOf: (t) => slots.get(t) ?? null,
			};
		} catch (e) {
			heightGatherCounters.failures++;
			console.warn("[height-gather] gather failed, CPU heights", e);
			return null;
		} finally {
			for (const b of bufs) b.destroy();
		}
	}

	destroy() {
		this.destroyed = true;
	}
}

export { replayHeights } from "../dem/replay-heights";
