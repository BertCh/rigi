// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU Terrarium tile ingest (WAG W2.3 wiring): one kernel decodes a Terrarium
// tile texture, optionally halves it with the streamer's 2× box filter, and reduces the statistics the
// CPU needs without the heights (validateTile's out-of-range count, lo / hi, the stride-7 lo / hi).
// The kernel only decodes: besides the heights it writes a per-output-texel invalid count and a
// stride-7 selector plane, and three luma GPUReduction nodes (sum, extent, masked extent) fold them
// into the 5-word stats buffer [invalid u32, lo, hi, lo7, hi7 f32] that decodeTileStats reads.
// Three graphs use it:
//   - terrariumTileStatsGpu (load time without a height atlas, cachedGraph group
//     "ingest-terrarium-tile"): bitmap → stats (20 B read back). The caller keeps the CPU path when
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
// Heights are bit-identical to the CPU path's; the stats are exact too (an integer sum, f32 min / max
// compare exactly), except that lo / hi / lo7 / hi7 may differ from the CPU in the sign of a zero.
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
import { defineKernel, warmKernelsAsync } from "../core/kernel";
import {
	GPUReduction,
	type GraphBufferHandle,
	type GraphTextureDescriptor,
	type GraphTextureHandle,
} from "../core/luma";
import { registerDeviceBytes } from "../core/memory";
import { withLease } from "../core/pool";
import { submit } from "../core/queue";
import { isCopyAligned, texelWorkgroups } from "./layout";
import { addHeightsToTexture, terrariumInputDescriptor } from "./terrarium";
import { TERRARIUM_DECODE_WGSL, wgslF32 } from "./terrarium.wgsl";
import { decodeTileStats, VALID_MAX, VALID_MIN } from "./terrarium-f32";
import { releaseResource, textureDescriptor, uploadBitmap } from "./upload";

/** createImageBitmap options of a Terrarium tile (no colour conversion, no premultiply). */
export const TERRARIUM_BITMAP_OPTIONS: ImageBitmapOptions = {
	colorSpaceConversion: "none",
	premultiplyAlpha: "none",
};

/** 32-bit words of the stats buffer: invalid (u32), lo, hi, lo7, hi7 (f32 bit patterns). */
export const TILE_STATS_WORDS = 5;

/**
 * One output texel per invocation (DOWN = 1: one source texel; 2: a 2×2 block, summed a + b + c + d
 * left to right, top row first, × 0.25, as downsampleHeights2). Every source texel decodes exactly as
 * TERRARIUM_WGSL. Besides `heights` it writes two u32 planes the statistics reductions fold: `bad`
 * (invalid source samples behind the texel, 0..4) and `mask7` (1 where the row-major index is a
 * multiple of 7: the stride-7 sample of localElevRange). Every element of all three is written, so
 * the planes need no clear. One 8×8 workgroup per 64 output texels.
 */
export const TERRARIUM_TILE_WGSL = /* wgsl */ `\
override DOWN: u32 = 1u;

@group(0) @binding(0) var rgba: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> heights: array<f32>;
@group(0) @binding(2) var<storage, read_write> bad: array<u32>;
@group(0) @binding(3) var<storage, read_write> mask7: array<u32>;

${TERRARIUM_DECODE_WGSL}
fn decode(p: vec2i) -> f32 {
  return decodeTerrariumTexel(textureLoad(rgba, p, 0));
}

fn invalid(h: f32) -> u32 {
  return select(1u, 0u, h > ${wgslF32(VALID_MIN)} && h < ${wgslF32(VALID_MAX)});
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let out = textureDimensions(rgba) / DOWN;
  if (id.x < out.x && id.y < out.y) {
    var h: f32;
    var n: u32;
    if (DOWN == 1u) {
      h = decode(vec2i(id.xy));
      n = invalid(h);
    } else {
      let p = vec2i(id.xy) * 2;
      let a = decode(p);
      let b = decode(p + vec2i(1, 0));
      let c = decode(p + vec2i(0, 1));
      let d = decode(p + vec2i(1, 1));
      n = invalid(a) + invalid(b) + invalid(c) + invalid(d);
      h = (((a + b) + c) + d) * 0.25;
    }
    let i = id.y * out.x + id.x;
    heights[i] = h;
    bad[i] = n;
    mask7[i] = select(0u, 1u, i % 7u == 0u);
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
			["bad", "storage"],
			["mask7", "storage"],
		],
		{
			group: TERRARIUM_TILE_GROUP,
			label: `ingest-terrarium-tile-${down}`,
			constants: { DOWN: down },
		},
	);
export const K_TERRARIUM_TILE = { 1: tileKernel(1), 2: tileKernel(2) } as const;

/**
 * Create both tile pipelines through createComputePipelineAsync (core kernelAsync, same cache as the
 * graphs' own kernel() lookups), so the first decode does not compile WGSL on the main thread. A graph
 * compile() after this resolves finds the pipelines cached; before it, it compiles them itself.
 */
export function warmTerrariumTileKernels(device: Device): Promise<number> {
	return warmKernelsAsync(device, TERRARIUM_TILE_GROUP);
}

/**
 * Add the tile node and its three statistics reductions: `input` (rgba8unorm, `size`²) → (size/down)²
 * f32 heights at `heights` (written in full) and the TILE_STATS_WORDS stats words at `stats`
 * ([invalid, lo, hi, lo7, hi7]; only those 20 bytes are written, each by one GPUReduction, none
 * needs a clear). `bad` / `mask7` are graph transients.
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
	// invariant: whole output texels, a heights buffer of out² f32 and the 5 stats words
	if (!Number.isInteger(out) || heights.byteLength < out * out * 4)
		throw new Error(
			`${g.id}/${node.id}: ${size} px / ${down} does not fit "${heights.id}"`,
		);
	if (stats.byteLength < TILE_STATS_WORDS * 4)
		throw new Error(`${g.id}/${node.id}: stats buffer too small`);
	const n = out * out;
	const bad = g.transientBuffer(`${node.id}-bad`, n * 4);
	const mask7 = g.transientBuffer(`${node.id}-mask7`, n * 4);
	const [x, y] = texelWorkgroups(out, out);
	g.addKernel({
		id: node.id,
		spec: K_TERRARIUM_TILE[down],
		bindings: { rgba: input, heights, bad, mask7 },
		workgroups: [x, y],
	});
	const heightView = g.view(heights, "float32", n);
	g.add(
		new GPUReduction({
			id: `${node.id}-invalid`,
			input: g.view(bad, "uint32", n),
			output: g.view(stats, "uint32", 1, 0),
			operation: "sum",
		}),
	);
	g.add(
		new GPUReduction({
			id: `${node.id}-extent`,
			input: heightView,
			output: g.view(stats, "float32", 2, 4),
			operation: "extent",
		}),
	);
	g.add(
		new GPUReduction({
			id: `${node.id}-extent7`,
			input: heightView,
			mask: g.view(mask7, "uint32", n),
			output: g.view(stats, "float32", 2, 12),
			operation: "extent",
		}),
	);
	return g;
}

export type TerrariumTileStats = HeightStats & {
	/** source samples validateTile would fill (out of (MIN_VALID, 9000)) */
	invalid: number;
};

/**
 * Load time: decode `bitmap` (a square Terrarium tile, decoded with TERRARIUM_BITMAP_OPTIONS) on the
 * GPU, halved when `down` = 2, and read back only its statistics (20 B). Concurrent callers overlap: the
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
					g.readNode("read", [{ buffer: stats, size: TILE_STATS_WORDS * 4 }]);
					return null;
				},
			);
			// queued synchronously inside the group lease (cachedGraph's eviction contract)
			return graph.lease(async () => {
				await graph.compileAsync();
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
 *   writeWithStats(): bitmap → layer AND the load-time stats (terrariumTileStatsGpu's 20 B), one
 *                     upload: the loader decodes a tile straight into the layer it keeps
 *                     (deck-webgpu/terrain-gpu-decode.ts), so the bitmap is uploaded once per load.
 */
export class TerrariumLayerWriter {
	private graphs = new Map<string, ComputeGraph<{ layer: number }>>();
	private staging = new Map<number, ReturnType<typeof uploadBitmap>>();
	stats = { writes: 0, rebuilds: 0 };
	/**
	 * The tile pipelines are created (async, started at construction). write() is synchronous and
	 * compiles its graph on the spot (cheap once the pipelines exist, otherwise as before); async
	 * callers await this first, before they read any state they encode with (a grown atlas replaces
	 * its texture while they wait).
	 */
	readonly ready: Promise<number>;

	private unregisterBytes: () => void;

	constructor(
		readonly device: Device,
		readonly id: string,
	) {
		this.ready = warmTerrariumTileKernels(device);
		// the writer's rgba8unorm staging textures (the atlas itself belongs to its caller)
		this.unregisterBytes = registerDeviceBytes(
			device,
			`dem-staging:${id}`,
			() => {
				let n = 0;
				for (const s of this.staging.values())
					n += s.texture.width * s.texture.height * 4;
				return n;
			},
		);
	}

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
	 * write() plus the tile's statistics, read back (20 B). Encoded and submitted synchronously; the
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
		if (read)
			g.readNode("read", [{ buffer: stats, size: TILE_STATS_WORDS * 4 }]);
		g.compile();
		return g;
	}

	destroy() {
		this.unregisterBytes();
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
