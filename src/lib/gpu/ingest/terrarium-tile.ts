// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU Terrarium tile ingest (WAG W2.3 wiring, flag terrainGpuDecode): one kernel decodes a Terrarium
// tile texture, optionally halves it with the streamer's 2× box filter, and reduces the statistics the
// CPU needs without the heights (validateTile's out-of-range count, lo / hi, the stride-7 lo / hi).
// Three graphs use it:
//   - terrariumTileStatsGpu (load time without a height atlas, cachedGraph group
//     "ingest-terrarium-tile"): bitmap → stats (32 B read back). The caller keeps the CPU path when
//     `invalid` > 0 (validateTile would fill).
//   - TerrariumLayerWriter.writeWithStats (load time, the default on the WebGPU engine; ComputeGraphs
//     "ingest-terrarium-layer|…|stats"): bitmap → heights → one layer of a TextureArrayAtlas r32float
//     array (copyBufferToTexture) + the same stats, one upload of the bitmap. The tile keeps that
//     layer (a lease) for as long as the streamer keeps its mesh.
//   - TerrariumLayerWriter.write (residency fallback, "ingest-terrarium-layer|…"): bitmap → layer, for
//     a tile that has no resident layer in the atlas it enters (e.g. after a device loss).
// Every write is encoded and submitted synchronously, so the layer is ready for the frame that follows.
// GpuDecodedHeights is the lazy CPU view of such a tile (dem/cpu-heights.ts LazyCpuHeights): the CPU
// twin's own code (bitmapHeights = canvas + decodeTerrarium, validateTile, downsampleHeights2) on the
// same ImageBitmap, run only when a CPU consumer asks.
//
// Bit identity (heights in the layer == the CPU path's heights): terrarium-f32.ts has the arithmetic
// argument (ingest.check.ts proves the kernel twin over all 2^24 RGB and random tiles);
// scripts/gpu/terrarium-ingest-check.mjs measures the texel bytes (copyExternalImageToTexture vs canvas
// getImageData), the kernel, the stats and the layer writer in the browser.
import type { Device, Texture } from "@luma.gl/core";
import type { HeightStats, LazyCpuHeights } from "#/lib/dem/cpu-heights";
import { validateTile } from "#/lib/dem/decode";
import { downsampleHeights2 } from "#/lib/dem/grid";
import { bitmapHeights } from "#/lib/dem/image";
import { ComputeGraph, cachedGraph } from "../core/graph";
import { defineKernel } from "../core/kernel";
import type {
	GraphBufferHandle,
	GraphTextureDescriptor,
	GraphTextureHandle,
} from "../core/luma";
import { withLease } from "../core/pool";
import { submit } from "../core/queue";
import { isCopyAligned, texelWorkgroups } from "./layout";
import { addHeightsToTexture, terrariumInputDescriptor } from "./terrarium";
import {
	decodeTileStats,
	INV_256,
	OFFSET,
	SEA_FLOOR,
	VALID_MAX,
	VALID_MIN,
} from "./terrarium-f32";
import { releaseResource, textureDescriptor, uploadBitmap } from "./upload";

const wgslF32 = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

/** createImageBitmap options of a Terrarium tile (no colour conversion, no premultiply). */
export const TERRARIUM_BITMAP_OPTIONS: ImageBitmapOptions = {
	colorSpaceConversion: "none",
	premultiplyAlpha: "none",
};

/** u32 words of the stats buffer: invalid, ~key(lo), key(hi), ~key(lo7), key(hi7), 3 spare. */
export const TILE_STATS_WORDS = 8;

/**
 * One output texel per invocation (DOWN = 1: one source texel; 2: a 2×2 block, summed a + b + c + d
 * left to right, top row first, × 0.25, as downsampleHeights2). Every source texel decodes exactly as
 * TERRARIUM_WGSL. Stats reduce per workgroup in workgroup atomics (explicitly zeroed), then one global
 * atomic per word; min is kept as max of the inverted order key so an all-zero clear is the identity.
 */
export const TERRARIUM_TILE_WGSL = /* wgsl */ `\
override DOWN: u32 = 1u;

@group(0) @binding(0) var rgba: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> heights: array<f32>;
@group(0) @binding(2) var<storage, read_write> stats: array<atomic<u32>, ${TILE_STATS_WORDS}>;

var<workgroup> wInvalid: atomic<u32>;
var<workgroup> wLo: atomic<u32>;
var<workgroup> wHi: atomic<u32>;
var<workgroup> wLo7: atomic<u32>;
var<workgroup> wHi7: atomic<u32>;

fn decode(p: vec2i) -> f32 {
  let v = textureLoad(rgba, p, 0);
  let c = round(clamp(v, vec4f(0.0), vec4f(1.0)) * 255.0);
  let h = c.r * 256.0 + c.g + c.b * ${wgslF32(INV_256)} - ${wgslF32(OFFSET)};
  return select(h, 0.0, h < 0.0 && h > ${wgslF32(SEA_FLOOR)});
}

fn invalid(h: f32) -> u32 {
  return select(1u, 0u, h > ${wgslF32(VALID_MIN)} && h < ${wgslF32(VALID_MAX)});
}

fn orderKey(h: f32) -> u32 {
  let b = bitcast<u32>(h);
  return select(b | 0x80000000u, ~b, (b & 0x80000000u) != 0u);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) {
    atomicStore(&wInvalid, 0u);
    atomicStore(&wLo, 0u);
    atomicStore(&wHi, 0u);
    atomicStore(&wLo7, 0u);
    atomicStore(&wHi7, 0u);
  }
  workgroupBarrier();
  let out = textureDimensions(rgba) / DOWN;
  if (id.x < out.x && id.y < out.y) {
    var h: f32;
    var bad: u32;
    if (DOWN == 1u) {
      h = decode(vec2i(id.xy));
      bad = invalid(h);
    } else {
      let p = vec2i(id.xy) * 2;
      let a = decode(p);
      let b = decode(p + vec2i(1, 0));
      let c = decode(p + vec2i(0, 1));
      let d = decode(p + vec2i(1, 1));
      bad = invalid(a) + invalid(b) + invalid(c) + invalid(d);
      h = (((a + b) + c) + d) * 0.25;
    }
    let i = id.y * out.x + id.x;
    heights[i] = h;
    if (bad > 0u) { atomicAdd(&wInvalid, bad); }
    let k = orderKey(h);
    atomicMax(&wLo, ~k);
    atomicMax(&wHi, k);
    if (i % 7u == 0u) {
      atomicMax(&wLo7, ~k);
      atomicMax(&wHi7, k);
    }
  }
  workgroupBarrier();
  if (li == 0u) {
    let n = atomicLoad(&wInvalid);
    if (n > 0u) { atomicAdd(&stats[0], n); }
    atomicMax(&stats[1], atomicLoad(&wLo));
    atomicMax(&stats[2], atomicLoad(&wHi));
    atomicMax(&stats[3], atomicLoad(&wLo7));
    atomicMax(&stats[4], atomicLoad(&wHi7));
  }
}
`;

/** Load-time stats graphs and residency graphs share this lease / cache group. */
export const TERRARIUM_TILE_GROUP = "ingest-terrarium-tile";

const tileKernel = (down: 1 | 2) =>
	defineKernel(
		`terrarium-tile-${down}`,
		TERRARIUM_TILE_WGSL,
		[
			["rgba", "texture"],
			["heights", "storage"],
			["stats", "storage"],
		],
		{
			group: TERRARIUM_TILE_GROUP,
			label: `ingest-terrarium-tile-${down}`,
			constants: { DOWN: down },
		},
	);
export const K_TERRARIUM_TILE = { 1: tileKernel(1), 2: tileKernel(2) } as const;

/**
 * Add the tile node: `input` (rgba8unorm, `size`²) → (size/down)² f32 heights at `heights` (written
 * in full) and the stats words at `stats` (cleared here first: atomics).
 */
export function addTerrariumTile<P>(
	g: ComputeGraph<P>,
	node: {
		id: string;
		input: GraphTextureHandle;
		heights: GraphBufferHandle;
		stats: GraphBufferHandle;
		size: number;
		down: 1 | 2;
	},
): ComputeGraph<P> {
	const { input, heights, stats, size, down } = node;
	const out = size / down;
	// invariant: whole output texels, a heights buffer of out² f32 and the 8 stats words
	if (!Number.isInteger(out) || heights.byteLength < out * out * 4)
		throw new Error(
			`${g.id}/${node.id}: ${size} px / ${down} does not fit "${heights.id}"`,
		);
	if (stats.byteLength < TILE_STATS_WORDS * 4)
		throw new Error(`${g.id}/${node.id}: stats buffer too small`);
	const [x, y] = texelWorkgroups(out, out);
	g.clearNode(`${node.id}-clear`, stats);
	g.addKernel({
		id: node.id,
		spec: K_TERRARIUM_TILE[down],
		bindings: { rgba: input, heights, stats },
		workgroups: [x, y],
		writes: { stats: "atomic" },
	});
	return g;
}

export type TerrariumTileStats = HeightStats & {
	/** source samples validateTile would fill (out of (MIN_VALID, 9000)) */
	invalid: number;
};

/**
 * Load time: decode `bitmap` (a square Terrarium tile, decoded with TERRARIUM_BITMAP_OPTIONS) on the
 * GPU, halved when `down` = 2, and read back only its statistics. Concurrent callers overlap: the
 * group lease covers encode + submit, the read is awaited outside it.
 */
export async function terrariumTileStatsGpu(
	device: Device,
	bitmap: ImageBitmap,
	down: 1 | 2,
): Promise<TerrariumTileStats> {
	const size = bitmap.width;
	const tex = uploadBitmap(device, bitmap, { id: "rgba" });
	try {
		const reads = await withLease(TERRARIUM_TILE_GROUP, () => {
			const { graph } = cachedGraph<void, null>(
				device,
				TERRARIUM_TILE_GROUP,
				`${size}/${down}`,
				(g) => {
					const input = g.importTexture(terrariumInputDescriptor(size, size));
					const out = size / down;
					const heights = g.transientBuffer("heights", out * out * 4);
					const stats = g.transientBuffer("stats", TILE_STATS_WORDS * 4);
					addTerrariumTile(g, {
						id: "tile",
						input,
						heights,
						stats,
						size,
						down,
					});
					g.readNode("read", [stats]);
					return null;
				},
			);
			// queued synchronously inside the group lease (cachedGraph's eviction contract)
			return graph.lease(() => {
				graph.compile();
				const enc = device.createCommandEncoder({ id: graph.id });
				const { reads } = graph.encodeReads(enc, undefined, undefined, {
					rgba: tex.texture,
				});
				try {
					submit(device, enc);
				} catch (e) {
					reads.cancel();
					throw e;
				}
				return reads;
			});
		});
		const words = new Uint32Array((await reads.read()).read[0]);
		return decodeTileStats(words);
	} finally {
		releaseResource(tex);
	}
}

/**
 * Residency: Terrarium bitmaps → layers of one r32float 2d-array (a TextureArrayAtlas), on the GPU.
 * One ComputeGraph per (source size, down, stats read or not, target descriptor): the atlas
 * re-creates its texture on a grow, so a changed descriptor rebuilds the graph. A staging
 * rgba8unorm texture per source size is reused: copyExternalImageToTexture and the submit that reads
 * it are queue-ordered.
 *   write():          bitmap → layer (a tile re-entering the atlas without a resident layer)
 *   writeWithStats(): bitmap → layer AND the load-time stats (terrariumTileStatsGpu's 32 B), one
 *                     upload: the loader decodes a tile straight into the layer it keeps
 *                     (deck-webgpu/terrain-gpu-decode.ts), so the bitmap is uploaded once per load.
 */
export class TerrariumLayerWriter {
	private graphs = new Map<string, ComputeGraph<{ layer: number }>>();
	private staging = new Map<number, ReturnType<typeof uploadBitmap>>();
	stats = { writes: 0, rebuilds: 0 };

	constructor(
		readonly device: Device,
		readonly id: string,
	) {}

	/** Decode `src` into `layer` of `target` (r32float 2d-array, layers ≥ the output size). */
	write(
		target: Texture,
		layer: number,
		src: { bitmap: ImageBitmap; down: 1 | 2 },
	) {
		const g = this.graphFor(target, src, false);
		const stage = this.stage(src.bitmap);
		const enc = this.device.createCommandEncoder({ id: g.id });
		g.encode(enc, { layer }, undefined, {
			rgba: stage.texture,
			atlas: target,
		});
		submit(this.device, enc);
		this.stats.writes++;
	}

	/**
	 * write() plus the tile's statistics, read back (32 B). Encoded and submitted synchronously; the
	 * layer is written whatever the stats say (the caller releases it when `invalid` > 0).
	 */
	async writeWithStats(
		target: Texture,
		layer: number,
		src: { bitmap: ImageBitmap; down: 1 | 2 },
	): Promise<TerrariumTileStats> {
		const g = this.graphFor(target, src, true);
		const stage = this.stage(src.bitmap);
		const enc = this.device.createCommandEncoder({ id: g.id });
		const { reads } = g.encodeReads(enc, { layer }, undefined, {
			rgba: stage.texture,
			atlas: target,
		});
		try {
			submit(this.device, enc);
		} catch (e) {
			reads.cancel();
			throw e;
		}
		this.stats.writes++;
		const words = new Uint32Array((await reads.read()).read[0]);
		return decodeTileStats(words);
	}

	private stage(bitmap: ImageBitmap) {
		const size = bitmap.width;
		let stage = this.staging.get(size);
		if (!stage) {
			stage = uploadBitmap(this.device, bitmap, { id: "rgba" });
			this.staging.set(size, stage);
		} else
			uploadBitmap(this.device, bitmap, {
				id: "rgba",
				into: { texture: stage.texture },
			});
		return stage;
	}

	private graphFor(
		target: Texture,
		src: { bitmap: ImageBitmap; down: 1 | 2 },
		read: boolean,
	) {
		const size = src.bitmap.width;
		const out = size / src.down;
		// invariant: the atlas layer holds the tile's top-left out × out texels (batched-terrain TileStore)
		if (
			target.format !== "r32float" ||
			target.width < out ||
			target.height < out ||
			!isCopyAligned(out, "r32float")
		)
			throw new Error(
				`${this.id}: cannot write a ${out} px tile into ${target.format} ${target.width}²`,
			);
		const atlas = textureDescriptor("atlas", target);
		const head = `${size}/${src.down}/${read ? "r" : "w"}|`;
		const key = `${head}${atlas.width}x${atlas.height}x${atlas.depth}|${atlas.usage}|${atlas.mipLevels}`;
		let g = this.graphs.get(key);
		if (!g) {
			// a grown atlas: the old target's graph is dead
			for (const [k, old] of this.graphs)
				if (k.startsWith(head)) {
					old.destroy();
					this.graphs.delete(k);
					this.stats.rebuilds++;
				}
			g = this.build(size, src.down, atlas, read);
			this.graphs.set(key, g);
		}
		return g;
	}

	private build(
		size: number,
		down: 1 | 2,
		atlas: GraphTextureDescriptor,
		read: boolean,
	) {
		const out = size / down;
		const g = new ComputeGraph<{ layer: number }>(
			this.device,
			`ingest-terrarium-layer|${this.id}|${size}/${down}${read ? "|stats" : ""}`,
		);
		const input = g.importTexture(terrariumInputDescriptor(size, size));
		const target = g.importTexture(atlas);
		const heights = g.transientBuffer("heights", out * out * 4);
		const stats = g.transientBuffer("stats", TILE_STATS_WORDS * 4);
		addTerrariumTile(g, { id: "tile", input, heights, stats, size, down });
		addHeightsToTexture(g, {
			id: "store",
			heights,
			target,
			width: out,
			height: out,
			layer: (p) => p.layer,
		});
		if (read) g.readNode("read", [stats]);
		g.compile();
		return g;
	}

	destroy() {
		for (const g of this.graphs.values()) g.destroy();
		this.graphs.clear();
		for (const s of this.staging.values()) releaseResource(s);
		this.staging.clear();
	}
}

/** Diagnostics of the GPU-decoded tiles' CPU views (globalThis.__rigiTerrainGpuDecode). */
export const gpuDecodedCounters = {
	/** materialisations whose validateTile filled samples the GPU had certified valid (must stay 0) */
	certificateMisses: 0,
};

/**
 * The lazy CPU view of a GPU-decoded tile: the CPU path's exact steps (bitmapHeights, validateTile with
 * jump ∞, downsampleHeights2) on the retained bitmap, on first use. `bitmap` also feeds
 * TerrariumLayerWriter whenever the tile (re)enters the height atlas before that.
 */
export class GpuDecodedHeights implements LazyCpuHeights {
	constructor(
		readonly bitmap: ImageBitmap,
		readonly down: 1 | 2,
	) {}

	materialize() {
		const S = this.bitmap.width;
		const h = bitmapHeights(this.bitmap);
		// loadDemTile's no-data fill; a no-op here, since the GPU found no sample outside
		// (MIN_VALID, 9000) (a fill would mean the canvas bytes differ from the texture's)
		const v = validateTile(h, S, Number.POSITIVE_INFINITY);
		if (v.filled) gpuDecodedCounters.certificateMisses++;
		return this.down === 2 ? downsampleHeights2(h, S) : h;
	}

	release() {
		this.bitmap.close();
	}
}
