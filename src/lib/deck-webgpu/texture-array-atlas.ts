// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// TextureArrayAtlas (WAG W2.2): one growable 2d-array texture of square layers with a free list,
// shared by the batched terrain's height arrays (layers/batched-terrain.ts HeightPool: r32float,
// 256² and 512²) and the draped imagery (imagery.ts ImageryArray: rgba8unorm-srgb 512², mips).
//
// - Layers are written through the gpu/ingest adapters with `into` (uploadRaster for typed-array
//   rasters, uploadBitmap for ImageBitmaps), so the bytes and calls are the ones those adapters
//   are tested for.
// - Growing re-creates the texture and copies every mip of the old layers with
//   copyTextureToTexture on a ComputeGraph copy node (one submit), so contents survive: before this, HeightPool re-created
//   its array empty and TileStore re-uploaded every resident tile from the CPU (≈ 35–40 ms of
//   main-thread writeTexture in one sync when a pan grew the 256² pool, measured 2026-10-01 by
//   scripts/deck-webgpu/atlas-cost.mjs). The texture object changes on a grow: consumers that
//   hold it (bind groups, relief-heights imports) ask for `texture` per use; `version` counts
//   re-creations.
// - compact() is the reverse (WAG perf-vram): the live layers move down to 0 … n−1 in a smaller
//   texture on the same kind of copy node, and the owners re-point their layers from the returned
//   map (ImageryArray on idle). Copies are exact, so frames do not change.
// - compactLeased() is compact() for an atlas whose layers are partly AtlasLeases (the height arrays
//   under terrainGpuDecode): the atlas knows every live lease, moves them with the owner's layers
//   and re-points them itself; it refuses (null) while a leased write is in flight or whenever the
//   live layers it can see are not exactly the layers the allocator has handed out. The old texture
//   is kept alive for a moment (consumers that planned against it finish on it, layers and all).
// - Pure allocation / growth / compaction math lives in atlas-layout.ts (node-checked).
import type { Device, Texture } from "@luma.gl/core";
import { ComputeGraph } from "../gpu/core/graph";
import { submit } from "../gpu/core/queue";
import {
	TerrariumLayerWriter,
	type TerrariumTileStats,
} from "../gpu/ingest/terrarium-tile";
import {
	textureDescriptor,
	uploadBitmap,
	uploadRaster,
} from "../gpu/ingest/upload";
import {
	compactLeasedPlan,
	compactPlan,
	type GrowPolicy,
	growCopies,
	grownCapacity,
	LayerAllocator,
	leaseFits,
} from "./atlas-layout";

/** How long a compaction keeps the replaced texture (in-flight relief / gather reads finish on it). */
const COMPACT_RETIRE_MS = 2000;

export type TextureArrayAtlasProps = {
	id: string;
	format: "r32float" | "rgba8unorm-srgb" | "rgba8unorm";
	/** layer width = height */
	size: number;
	mipLevels?: number;
	/** texture usage; must include COPY_SRC and COPY_DST (grow copies) */
	usage: number;
	sampler?: Parameters<Device["createTexture"]>[0]["sampler"];
	/** initial layer count */
	capacity: number;
	/** the most layers it may grow to (device maxTextureArrayLayers or less) */
	maxLayers: number;
	grow: GrowPolicy;
};

export class TextureArrayAtlas {
	texture: Texture;
	/** re-creations so far (a grow bumps it) */
	version = 0;
	readonly maxLayers: number;
	readonly size: number;
	readonly mipLevels: number;
	stats = {
		grows: 0,
		/** compact() calls that shrank the texture */
		compactions: 0,
		copiedLayers: 0,
		writes: 0,
		writeBytes: 0,
		/** writeTerrarium calls (writeBytes counts their rgba8 upload) */
		gpuDecodes: 0,
		/** writeTerrariumLeased calls: load-time decodes into a layer the tile keeps (rgba8 upload in writeBytes) */
		leasedDecodes: 0,
		/** leases live now */
		leases: 0,
	};
	/** destroy() ran: leases release nothing any more */
	destroyed = false;
	/** every live lease on this atlas (AtlasLease adds / removes itself) */
	readonly leaseSet = new Set<AtlasLease>();
	/** writeTerrariumLeased calls not finished: a layer is being written, so no compaction */
	private pendingLeased = 0;
	/** textures replaced by a compaction, destroyed after a delay */
	private retired = new Set<{
		texture: Texture;
		timer: ReturnType<typeof setTimeout>;
	}>();
	private layers: LayerAllocator;

	constructor(
		readonly device: Device,
		private props: TextureArrayAtlasProps,
	) {
		this.size = props.size;
		this.mipLevels = props.mipLevels ?? 1;
		this.maxLayers = props.maxLayers;
		this.layers = new LayerAllocator(props.capacity);
		this.texture = this.create(props.capacity);
	}

	get capacity() {
		return this.layers.capacity;
	}

	private create(depth: number) {
		const p = this.props;
		return this.device.createTexture({
			id: p.id,
			dimension: "2d-array",
			format: p.format,
			width: p.size,
			height: p.size,
			depth,
			...(this.mipLevels > 1 ? { mipLevels: this.mipLevels } : {}),
			usage: p.usage,
			...(p.sampler ? { sampler: p.sampler } : {}),
		});
	}

	/** A layer (may be ≥ capacity: reserve() then grows, or the caller drops it). */
	alloc() {
		return this.layers.alloc();
	}
	/** A layer below capacity, or undefined. */
	allocWithin() {
		return this.layers.allocWithin();
	}
	release(layer: number) {
		this.layers.release(layer);
	}
	/** Layers below capacity still free. */
	available() {
		return this.layers.available();
	}
	/** Layers handed out and not released. */
	used() {
		return this.layers.used();
	}

	/**
	 * Room for layer indices < need (capped at maxLayers); grows by copy, keeping every layer's
	 * contents. true = the texture was re-created (rebind it).
	 */
	reserve(need: number) {
		const cap = this.capacity;
		const next = grownCapacity(cap, need, this.maxLayers, this.props.grow);
		if (next === cap) return false;
		this.resize(next, cap ? [{ from: 0, to: 0, count: cap }] : []);
		this.layers.capacity = next;
		this.stats.grows++;
		this.stats.copiedLayers += cap;
		return true;
	}

	/**
	 * Shrink to the live layers `live`: they move to 0 … n−1 (relative order kept) in a texture of
	 * the smallest `quantum` multiple that holds them, by copy. Returns old → new layer for the owners
	 * to re-point (ImageryArray ids), or null when it would not free a quantum. The free list restarts
	 * packed: every layer not in `live` is gone. Not for an atlas with AtlasLeases (the height arrays
	 * under terrainGpuDecode): a lease's layer index is fixed.
	 */
	compact(live: readonly number[], quantum: number) {
		// a lease's layer index is fixed here: compactLeased moves leases with the owner's layers
		if (this.leaseSet.size) return null;
		const plan = compactPlan(live, quantum);
		const next = Math.max(plan.capacity, Math.min(quantum, this.maxLayers));
		if (next >= this.capacity) return null;
		this.resize(next, plan.runs);
		this.layers.capacity = next;
		this.layers.resetPacked(live.length);
		this.stats.compactions++;
		this.stats.copiedLayers += live.length;
		return plan.remap;
	}

	/**
	 * compact() for an atlas with leases: `ownerLive` = the layers the owner holds itself (TileStore's
	 * non-leased slots); the live leases' layers come from the atlas. They all move to 0 … n−1 in a
	 * texture of the smallest `quantum` multiple that holds them, never below `minCapacity`; every
	 * lease is re-pointed (AtlasLease.layer) and the old → new map is returned for the owner. Null
	 * (nothing moved) while a leased write is in flight, when the owner's and the leases' layers do not
	 * add up to the layers in use (atlas-layout.ts compactLeasedPlan), or when nothing would be freed.
	 */
	compactLeased(
		ownerLive: readonly number[],
		quantum: number,
		minCapacity: number,
	) {
		if (this.destroyed || this.pendingLeased) return null;
		const leases = [...this.leaseSet].filter((l) => l.live);
		const plan = compactLeasedPlan(
			ownerLive,
			leases.map((l) => l.layer),
			this.used(),
			quantum,
			Math.min(minCapacity, this.maxLayers),
			this.capacity,
			this.maxLayers,
		);
		if (!plan) return null;
		this.resize(plan.capacity, plan.runs, COMPACT_RETIRE_MS);
		this.layers.capacity = plan.capacity;
		this.layers.resetPacked(plan.live.length);
		for (const l of leases) l.relocate(plan.remap.get(l.layer) ?? l.layer);
		this.stats.compactions++;
		this.stats.copiedLayers += plan.live.length;
		return plan.remap;
	}

	/**
	 * Re-create the texture with `depth` layers and copy `runs` of layers (every mip) from the old one,
	 * on one ComputeGraph copy node (old and new texture imported), one submit. The texture object
	 * changes: consumers ask for `texture` per use; `version` counts re-creations.
	 */
	private resize(
		depth: number,
		runs: readonly { from: number; to: number; count: number }[],
		retireMs = 0,
	) {
		const old = this.texture;
		const tex = this.create(depth);
		if (runs.length) {
			const g = new ComputeGraph<void>(
				this.device,
				`atlas-resize|${this.props.id}`,
			);
			const src = g.importTexture(textureDescriptor("src", old));
			const dst = g.importTexture(textureDescriptor("dst", tex));
			const size = this.size;
			const mips = this.mipLevels;
			g.addCopyPass({
				id: "copy-layers",
				resources: [
					{ texture: src, usage: "copy-source" },
					{ texture: dst, usage: "copy-destination" },
				],
				compile: () => ({
					encode: ({ commandEncoder, getTexture }) => {
						const from = getTexture(src);
						const to = getTexture(dst);
						for (const c of growCopies(size, mips, 0))
							for (const r of runs)
								commandEncoder.copyTextureToTexture({
									sourceTexture: from,
									mipLevel: c.mipLevel,
									origin: [0, 0, r.from],
									destinationTexture: to,
									destinationMipLevel: c.mipLevel,
									destinationOrigin: [0, 0, r.to],
									width: c.width,
									height: c.height,
									depthOrArrayLayers: r.count,
								});
					},
				}),
			});
			// a copy-only graph: no pipeline to compile, so the synchronous compile() costs no WGSL
			// compile and the resize (called from reserve() / compact()) stays synchronous
			g.compile();
			const enc = this.device.createCommandEncoder({
				id: `atlas-resize|${this.props.id}`,
			});
			g.encode(enc, undefined, undefined, { src: old, dst: tex });
			submit(this.device, enc);
			g.destroy();
		}
		if (retireMs) this.retire(old, retireMs);
		else old.destroy();
		this.texture = tex;
		this.version++;
	}

	/** Keep a replaced texture alive for `ms` (readers that planned against it), then destroy it. */
	private retire(texture: Texture, ms: number) {
		const entry = {
			texture,
			timer: setTimeout(() => {
				this.retired.delete(entry);
				texture.destroy();
			}, ms),
		};
		this.retired.add(entry);
	}

	/** A w×w typed-array raster into mip 0 of `layer` (gpu/ingest uploadRaster `into`). */
	writeRaster(layer: number, data: Float32Array, w: number) {
		const r = uploadRaster(this.device, data, {
			width: w,
			height: w,
			id: this.props.id,
			format: this.props.format as "r32float",
			into: { texture: this.texture, layer },
		});
		this.stats.writes++;
		this.stats.writeBytes += r.byteLength;
	}

	/** An ImageBitmap into mip 0 of `layer` (gpu/ingest uploadBitmap `into`). */
	writeBitmap(layer: number, image: ImageBitmap) {
		const r = uploadBitmap(this.device, image, {
			id: this.props.id,
			format: this.props.format as "rgba8unorm-srgb",
			into: { texture: this.texture, layer },
		});
		this.stats.writes++;
		this.stats.writeBytes += r.byteLength;
	}

	private terrarium?: TerrariumLayerWriter;

	/**
	 * A Terrarium tile bitmap decoded on the GPU (halved when `down` = 2) into the top-left of `layer`
	 * (gpu/ingest TerrariumLayerWriter; r32float atlases only; flag terrainGpuDecode).
	 */
	writeTerrarium(layer: number, src: { bitmap: ImageBitmap; down: 1 | 2 }) {
		this.terrarium ??= new TerrariumLayerWriter(this.device, this.props.id);
		this.terrarium.write(this.texture, layer, src);
		const out = src.bitmap.width / src.down;
		this.stats.writes++;
		this.stats.writeBytes += src.bitmap.width * src.bitmap.height * 4;
		this.stats.gpuDecodes++;
		return out;
	}

	/**
	 * Load time (flag terrainGpuDecode): allocate a layer (growing the atlas by copy when needed),
	 * decode the Terrarium `src` into it and read back its statistics, with one upload of the bitmap.
	 * Returns the lease on the layer and the stats, or null when no layer fits (device limit, with
	 * leaseFits' headroom). The
	 * caller releases the lease when the stats send the tile to the CPU path.
	 */
	async writeTerrariumLeased(src: {
		bitmap: ImageBitmap;
		down: 1 | 2;
	}): Promise<{ lease: AtlasLease; stats: TerrariumTileStats } | null> {
		// pipelines first (async compile, off the main thread), before any state below is read
		this.terrarium ??= new TerrariumLayerWriter(this.device, this.props.id);
		await this.terrarium.ready;
		if (this.destroyed) return null;
		// near the device's layer limit: no lease (atlas-layout.ts leaseFits)
		if (!leaseFits(this.used(), this.maxLayers)) return null;
		const layer = this.alloc();
		if (layer >= this.capacity) this.reserve(layer + 1);
		if (layer >= this.capacity) {
			this.release(layer);
			return null;
		}
		const lease = new AtlasLease(this, layer);
		this.terrarium ??= new TerrariumLayerWriter(this.device, this.props.id);
		let stats: TerrariumTileStats;
		this.pendingLeased++;
		try {
			stats = await this.terrarium.writeWithStats(this.texture, layer, src);
		} catch (e) {
			lease.release();
			throw e;
		} finally {
			this.pendingLeased--;
		}
		this.stats.writes++;
		this.stats.writeBytes += src.bitmap.width * src.bitmap.height * 4;
		this.stats.leasedDecodes++;
		return { lease, stats };
	}

	destroy() {
		this.destroyed = true;
		this.terrarium?.destroy();
		this.texture.destroy();
		for (const r of this.retired) {
			clearTimeout(r.timer);
			r.texture.destroy();
		}
		this.retired.clear();
		this.leaseSet.clear();
	}
}

/**
 * A reference-counted hold on one atlas layer (flag terrainGpuDecode): the tile that was decoded
 * into it holds one reference for as long as the streamer keeps its mesh, and the batched terrain's
 * TileStore holds one while it draws the tile. The layer returns to the free list when the last
 * reference goes, so a tile that leaves the drawn set and comes back re-enters with no upload.
 */
export class AtlasLease {
	private refs = 1;
	private layerIndex: number;
	constructor(
		readonly atlas: TextureArrayAtlas,
		layer: number,
	) {
		this.layerIndex = layer;
		atlas.stats.leases++;
		atlas.leaseSet.add(this);
	}
	/** The layer held; it changes only when the atlas compacts (compactLeased), so read it per use. */
	get layer() {
		return this.layerIndex;
	}
	/** Atlas-only: compactLeased moved the layer. */
	relocate(layer: number) {
		this.layerIndex = layer;
	}
	/** Still holds its layer, in an atlas that is not destroyed. */
	get live() {
		return this.refs > 0 && !this.atlas.destroyed;
	}
	retain() {
		// invariant: only a live lease gains references (TileStore checks `live` first)
		if (this.refs <= 0) throw new Error("AtlasLease: retain after release");
		this.refs++;
	}
	release() {
		if (this.refs <= 0) return;
		if (--this.refs > 0) return;
		this.atlas.stats.leases--;
		this.atlas.leaseSet.delete(this);
		if (!this.atlas.destroyed) this.atlas.release(this.layerIndex);
	}
}

/**
 * A tile's own hold on its atlas layer (dem/cpu-heights.ts GpuLayerRef, set by the terrainGpuDecode
 * loader): released once, by whoever drops the tile for good; idempotent.
 */
export class TileLayerRef {
	private held = true;
	constructor(readonly lease: AtlasLease) {}
	release() {
		if (!this.held) return;
		this.held = false;
		this.lease.release();
	}
}
