// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Draped imagery for the WebGPU terrain: two 2D texture ARRAYS (rgba8unorm-srgb, mipmapped), one
// layer per tile. Hardware sRGB decode = linear samples with correct filtering. Tiles arrive as
// ImageBitmaps from deck/terrain-data.ts loadImagery (256·2^k px mosaics).
//
// Tiers (WAG perf-vram, 2026-10-01): a 256 px source keeps its own size in the 256² array (as deck.gl's
// per-tile texture does); 512 and 1024 px sources are resized to 512² (off the main thread,
// createImageBitmap resize) for the 512² array, as before. Before the tiers every tile took a 512²
// layer, so the ~78 % of the matcher drape's tiles that are 256 px used 4× the memory they carry
// (matcher drape ≈ 1 GiB vs deck 0.73–0.78). layerOf encodes the tier: 512² layers are 0 … 2047,
// 256² layers IMAGERY_SMALL_TIER_BASE + i (atlas-layout.ts); the terrain shader (terrain.ts terrain_sample) samples both
// arrays in uniform control flow and selects, so 512² tiles render exactly as before.
//
// The layers live in TextureArrayAtlases (texture-array-atlas.ts, shared with the terrain's height
// arrays): capacity grows in chunks (copies keep every mip of the existing layers) up to the
// device's maxTextureArrayLayers (256 on 'core' devices, 2048 on Apple with featureLevel 'max').
// Tiles that don't fit draw without imagery (hillshade) and are counted in stats.overflow; which
// ones is near-first (planImageryOverflow): given tile distances, a resident far tile yields its
// layer to a nearer wanted one (stats.evictions), and a resident tile inside the budget keeps its.
// On idle (COMPACT_IDLE_MS without a release or upload) an array whose free layers make up a whole
// chunk is compacted by copy (TextureArrayAtlas.compact); an array with no live layer is dropped.
// release() (the look no longer drapes) releases every layer, so the arrays go at the next idle.
//
// An array is created on the first tile of its tier (WAG W1.6): the photo view's default look
// drapes none, and a 64-layer mipmapped 512² array is 85 MiB. Until then its `texture` is null and
// the terrain binds its 1×1 empty array (every row's layer is −1, so the drape is never shown).
import type { Device, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import {
	encodeImageryLayer,
	type ImageryTier,
	imageryTierOf,
	planImageryOverflow,
} from "./atlas-layout";
import { USAGE } from "./targets";
import { TextureArrayAtlas } from "./texture-array-atlas";
import { fullscreenWGSL } from "./wgsl";

// per-layer mip chain: each level = a linear 2×2 box of the level above (render, sRGB-correct:
// the -srgb view decodes on sample and encodes on write)
export const MIP_WGSL = /* wgsl */ `\
${fullscreenWGSL}
@group(0) @binding(auto) var src: texture_2d<f32>;
@group(0) @binding(auto) var srcSampler: sampler;
@fragment fn fragmentMain(v: FullscreenOut) -> @location(0) vec4<f32> {
  return textureSampleLevel(src, srcSampler, v.uv, 0.0);
}
`;

/** Layers per grow / compaction quantum, per tier (85 MiB of 512², 43 MiB of 256²). */
const CHUNK = { 512: 64, 256: 128 } as const;
/** Quiet time (no release, no upload) before an array is compacted or dropped. */
const COMPACT_IDLE_MS = 4000;
/**
 * releaseWhenIdle's grace: a look without imagery keeps the layers this long, so the matcher's
 * pose views (satellite look, then the photo look again) do not re-upload the drape each time.
 */
export const IMAGERY_RELEASE_IDLE_MS = 10_000;

/**
 * A matcher run's pose views are spaced by seconds to minutes: renderPoseView holds the layers this
 * long after each view (ImageryArray.hold), so a later view finds the drape still resident.
 */
export const IMAGERY_POSE_VIEW_HOLD_MS = 120_000;

export type ReleaseTimerHost = {
	now: () => number;
	setTimeout: (fn: () => void, ms: number) => unknown;
	clearTimeout: (handle: unknown) => void;
};
const realTimers: ReleaseTimerHost = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * The deferred release: arm(ms) keeps the first deadline while armed, cancel() disarms, holdUntil(t)
 * pushes the release past a deadline (a firing timer before it re-arms for the remainder).
 */
export class ReleaseTimer {
	private handle: unknown = null;
	private heldUntil = 0;
	/** Firings deferred by a hold. */
	deferrals = 0;
	constructor(
		private readonly onFire: () => void,
		private readonly host: ReleaseTimerHost = realTimers,
	) {}
	get armed() {
		return this.handle !== null;
	}
	arm(ms: number) {
		if (this.handle !== null) return;
		this.handle = this.host.setTimeout(() => this.fire(), ms);
	}
	cancel() {
		if (this.handle === null) return;
		this.host.clearTimeout(this.handle);
		this.handle = null;
	}
	holdUntil(t: number) {
		this.heldUntil = Math.max(this.heldUntil, t);
	}
	private fire() {
		this.handle = null;
		const left = this.heldUntil - this.host.now();
		if (left > 0) {
			this.deferrals++;
			this.arm(left);
			return;
		}
		this.onFire();
	}
}

type Tier = ImageryTier;
const tierOf = (bmp: ImageBitmap): Tier => imageryTierOf(bmp.width, bmp.height);
const mipLevels = (size: number) => Math.log2(size) + 1;

export class ImageryArray {
	/** per tier, null until the first tile of that tier (see the header) */
	atlases: Record<Tier, TextureArrayAtlas | null> = { 256: null, 512: null };
	/** tile id → tier and layer in that tier's array */
	private layers = new Map<string, { tier: Tier; layer: number }>();
	/** tile id → the bitmap the layer holds (identity: a new bitmap re-uploads) */
	private sources = new Map<string, ImageBitmap>();
	private pending = new Map<string, ImageBitmap>();
	private mipModel?: Model;
	private mipSampler?: ReturnType<Device["createSampler"]>;
	private destroyed = false;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private releaseTimer: ReleaseTimer;
	private readonly timers: ReleaseTimerHost = realTimers;
	readonly maxLayers: number;
	stats = {
		layers: 0,
		capacity: 0,
		uploads: 0,
		overflow: 0,
		/** resident layers given up to nearer wanted tiles (cumulative) */
		evictions: 0,
		mipGens: 0,
		/** idle compactions / arrays dropped */
		compactions: 0,
		drops: 0,
		/** live layers per tier */
		small: 0,
		big: 0,
		/** release firings pushed back by hold() */
		holdDeferrals: 0,
	};
	/** Called when uploads land or layers move (the host re-points rows and redraws). */
	onChange?: () => void;

	constructor(
		readonly device: Device,
		timers?: ReleaseTimerHost,
	) {
		this.releaseTimer = new ReleaseTimer(() => this.release(), timers);
		this.timers = timers ?? realTimers;
		this.maxLayers = Math.min(
			2048,
			(device.limits as { maxTextureArrayLayers?: number })
				.maxTextureArrayLayers ?? 256,
		);
	}

	private createAtlas(tier: Tier) {
		return new TextureArrayAtlas(this.device, {
			id: tier === 512 ? "imagery-array" : "imagery-array-256",
			format: "rgba8unorm-srgb",
			size: tier,
			mipLevels: mipLevels(tier),
			usage: USAGE.SAMPLE | USAGE.COPY_DST | USAGE.COPY_SRC | USAGE.RENDER,
			sampler: {
				minFilter: "linear",
				magFilter: "linear",
				mipmapFilter: "linear",
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
				maxAnisotropy: 8,
			},
			capacity: Math.min(CHUNK[tier], this.maxLayers),
			maxLayers: this.maxLayers,
			grow: { chunk: CHUNK[tier] },
		});
	}

	/** The 512² array (re-created when it grows or compacts: read it per use); null = none yet. */
	get texture() {
		return this.atlases[512]?.texture ?? null;
	}
	/** The 256² array (as `texture`). */
	get textureSmall() {
		return this.atlases[256]?.texture ?? null;
	}
	/** The 512² array's atlas (diagnostics; kept for the harnesses that read `imagery.atlas`). */
	get atlas() {
		return this.atlases[512];
	}

	/** Bitmaps sync() started uploading that have not landed yet (renderPoseView waits for 0). */
	get pendingUploads() {
		return this.pending.size;
	}

	/** Encoded layer of a tile's imagery (atlas-layout.ts encodeImageryLayer), or -1. */
	layerOf(id: string) {
		const l = this.layers.get(id);
		return l ? encodeImageryLayer(l.tier, l.layer) : -1;
	}

	private drop(id: string) {
		const l = this.layers.get(id);
		if (!l) return;
		this.layers.delete(id);
		this.atlases[l.tier]?.release(l.layer);
	}

	/**
	 * Match the arrays to `images` (tile id → bitmap) restricted to `keep` (the rendered tiles):
	 * releases layers of dropped tiles, uploads new / changed bitmaps asynchronously. `keep` entries
	 * are ids or { id, distance } (the camera distance, nearer first): when a tier's array is full
	 * the nearest tiles get the layers and a farther resident tile is evicted for a nearer one
	 * (planImageryOverflow); a plain id has distance +Infinity.
	 */
	sync(
		images: ReadonlyMap<string, ImageBitmap>,
		keep: Iterable<string | { id: string; distance?: number }>,
	) {
		if (this.destroyed) return;
		this.cancelRelease();
		const want = new Map<string, number | undefined>();
		for (const k of keep)
			if (typeof k === "string") want.set(k, undefined);
			else want.set(k.id, k.distance);
		let released = 0;
		for (const id of [...this.layers.keys()])
			if (!want.has(id) || !images.has(id)) {
				this.drop(id);
				this.sources.delete(id);
				released++;
			}
		const plan = planImageryOverflow(
			[...want]
				.filter(([id]) => images.has(id))
				.map(([id, distance]) => ({
					id,
					tier: tierOf(images.get(id) as ImageBitmap),
					distance,
				})),
			new Map([...this.layers].map(([id, l]) => [id, l.tier])),
			this.maxLayers,
		);
		for (const id of plan.evict) {
			this.drop(id);
			this.sources.delete(id);
			this.pending.delete(id); // an upload in flight for it must not land (upload() checks)
			released++;
			this.stats.evictions++;
		}
		let overflow = plan.overflow.length;
		for (const id of plan.overflow) this.pending.delete(id);
		for (const id of plan.admit) {
			const bmp = images.get(id);
			if (!bmp || this.sources.get(id) === bmp || this.pending.get(id) === bmp)
				continue;
			const tier = tierOf(bmp);
			const have = this.layers.get(id);
			this.atlases[tier] ??= this.createAtlas(tier);
			const atlas = this.atlases[tier];
			if (
				have?.tier !== tier &&
				!atlas.available() &&
				!atlas.reserve(atlas.capacity + 1)
			) {
				overflow++;
				continue;
			}
			this.pending.set(id, bmp);
			this.upload(id, bmp, tier);
		}
		this.stats.overflow = overflow;
		this.updateStats();
		if (released) this.scheduleIdle();
		// evicted rows must point at no layer now (the caller also re-points after sync)
		if (plan.evict.length) this.onChange?.();
	}

	/**
	 * The look drapes no imagery: release() after IMAGERY_RELEASE_IDLE_MS unless sync() comes first.
	 * Repeated calls keep the first deadline (the engine calls this on every sync of such a look).
	 */
	releaseWhenIdle(ms = IMAGERY_RELEASE_IDLE_MS) {
		if (this.destroyed || this.releaseTimer.armed) return;
		if (!this.layers.size && !this.pending.size) return;
		this.releaseTimer.arm(ms);
	}

	/**
	 * Keep the layers at least `ms` more even if a releaseWhenIdle deadline falls earlier (a timer that
	 * fires inside the hold re-arms for the rest). Only a deferred release; release() is immediate.
	 */
	hold(ms: number) {
		this.releaseTimer.holdUntil(this.timers.now() + ms);
	}

	private cancelRelease() {
		this.releaseTimer.cancel();
	}

	/** The look drapes no imagery any more: every layer goes, the arrays at the next idle. */
	release() {
		this.cancelRelease();
		if (this.destroyed || (!this.layers.size && !this.pending.size)) return;
		for (const id of [...this.layers.keys()]) this.drop(id);
		this.sources.clear();
		this.pending.clear();
		this.updateStats();
		this.scheduleIdle();
		// rows point at no layer now (the arrays themselves go at the next idle)
		this.onChange?.();
	}

	private updateStats() {
		let small = 0;
		for (const l of this.layers.values()) if (l.tier === 256) small++;
		this.stats.holdDeferrals = this.releaseTimer.deferrals;
		this.stats.layers = this.layers.size;
		this.stats.small = small;
		this.stats.big = this.layers.size - small;
		this.stats.capacity =
			(this.atlases[256]?.capacity ?? 0) + (this.atlases[512]?.capacity ?? 0);
	}

	private scheduleIdle() {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			this.compactIdle();
		}, COMPACT_IDLE_MS);
	}

	/**
	 * Idle: an array with no live layer is dropped; one with at least a chunk of free layers moves its
	 * live layers down to 0 … n−1 (graph copy node, every mip) in a smaller texture, and the tiles
	 * are re-pointed (onChange → the terrain's row table). Waits while uploads are in flight.
	 */
	compactIdle() {
		if (this.destroyed) return;
		if (this.pending.size) {
			this.scheduleIdle();
			return;
		}
		let changed = false;
		for (const tier of [256, 512] as const) {
			const atlas = this.atlases[tier];
			if (!atlas) continue;
			const live = [...this.layers.values()]
				.filter((l) => l.tier === tier)
				.map((l) => l.layer);
			if (!live.length) {
				atlas.destroy();
				this.atlases[tier] = null;
				this.stats.drops++;
				changed = true;
				continue;
			}
			if (atlas.capacity - live.length < CHUNK[tier]) continue;
			const remap = atlas.compact(live, CHUNK[tier]);
			if (!remap) continue;
			for (const l of this.layers.values())
				if (l.tier === tier) l.layer = remap.get(l.layer) ?? l.layer;
			this.stats.compactions++;
			changed = true;
		}
		if (!changed) return;
		this.updateStats();
		this.onChange?.();
	}

	private async upload(id: string, bmp: ImageBitmap, tier: Tier) {
		let img: ImageBitmap;
		try {
			img =
				bmp.width === tier && bmp.height === tier
					? bmp
					: await createImageBitmap(bmp, {
							resizeWidth: tier,
							resizeHeight: tier,
							resizeQuality: "high",
						});
		} catch {
			this.pending.delete(id);
			return; // bitmap closed underneath us (superseded)
		}
		if (this.destroyed || this.pending.get(id) !== bmp) {
			if (img !== bmp) img.close();
			return;
		}
		this.pending.delete(id);
		// only sync() starts uploads, after creating this tier's array (an idle drop waits for pending)
		const atlas = this.atlases[tier];
		if (!atlas) {
			if (img !== bmp) img.close();
			return;
		}
		let l = this.layers.get(id);
		if (l && l.tier !== tier) {
			// the tile's source changed tier (another mosaic size): leave the old array
			this.drop(id);
			l = undefined;
		}
		if (!l) {
			const layer = atlas.allocWithin();
			if (layer === undefined) {
				if (img !== bmp) img.close();
				return;
			}
			l = { tier, layer };
			this.layers.set(id, l);
		}
		atlas.writeBitmap(l.layer, img);
		if (img !== bmp) img.close();
		this.sources.set(id, bmp);
		this.stats.uploads++;
		this.updateStats();
		this.layerMips(atlas.texture, l.layer, tier);
		this.onChange?.();
	}

	/** Build mip levels 1..n of one array layer (the rest of the array is untouched). */
	private layerMips(texture: Texture, layer: number, size: number) {
		const d = this.device;
		this.mipSampler ??= d.createSampler({
			minFilter: "linear",
			magFilter: "linear",
		});
		this.mipModel ??= new Model(d, {
			id: "imagery-mips",
			source: MIP_WGSL,
			vs: null,
			fs: null,
			vertexEntryPoint: "fullscreenVertex",
			fragmentEntryPoint: "fragmentMain",
			vertexCount: 3,
			colorAttachmentFormats: ["rgba8unorm-srgb"],
			// no depth parameters at all: luma would add a depth-stencil state (see pass.ts)
			parameters: {},
		} as never);
		const views = [];
		for (let mip = 1; mip < mipLevels(size); mip++) {
			const src = texture.createView({
				dimension: "2d",
				baseMipLevel: mip - 1,
				mipLevelCount: 1,
				baseArrayLayer: layer,
				arrayLayerCount: 1,
			});
			const dst = texture.createView({
				dimension: "2d",
				baseMipLevel: mip,
				mipLevelCount: 1,
				baseArrayLayer: layer,
				arrayLayerCount: 1,
			});
			const s = Math.max(1, size >> mip);
			const fbo = d.createFramebuffer({
				width: s,
				height: s,
				colorAttachments: [dst],
			});
			this.mipModel.setBindings({
				src: src as never,
				srcSampler: this.mipSampler,
			});
			const pass = d.beginRenderPass({
				framebuffer: fbo,
				clearColor: [0, 0, 0, 0],
			});
			this.mipModel.draw(pass);
			pass.end();
			views.push(src, dst, fbo);
		}
		d.submit();
		for (const v of views) v.destroy();
		this.stats.mipGens++;
	}

	destroy() {
		this.destroyed = true;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.cancelRelease();
		this.mipModel?.destroy();
		this.mipSampler?.destroy();
		for (const tier of [256, 512] as const) {
			this.atlases[tier]?.destroy();
			this.atlases[tier] = null;
		}
		this.layers.clear();
		this.sources.clear();
		this.pending.clear();
	}
}
