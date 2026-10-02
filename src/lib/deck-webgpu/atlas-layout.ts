// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure math of the TextureArrayAtlas (texture-array-atlas.ts, WAG W2.2): layer allocation, capacity
// growth, the per-mip copy extents of a grow, and the uv window of an ancestor tile. No luma
// runtime; node-checked by atlas-layout.check.ts.
import type { TileKey } from "../dem/tiles";

/**
 * Array layers with a free list: alloc() = the most recently released layer, else the next unused
 * one (0, 1, 2, …). The same order as the old HeightPool (`free.pop() ?? next++`) and as the old
 * ImageryArray's pre-filled descending free list (layers handed out lowest first, a released layer
 * reused first). Layers may run past `capacity` (unbounded use); `allocWithin` refuses that.
 */
export class LayerAllocator {
	private free: number[] = [];
	private next = 0;
	constructor(public capacity: number) {}
	/** A layer index (may be ≥ capacity: the caller grows or drops it). */
	alloc() {
		return this.free.pop() ?? this.next++;
	}
	/** A layer below capacity, or undefined when none is left. */
	allocWithin() {
		const layer = this.free.pop();
		if (layer !== undefined) return layer;
		return this.next < this.capacity ? this.next++ : undefined;
	}
	release(layer: number) {
		this.free.push(layer);
	}
	/** Layers handed out and not released. */
	used() {
		return this.next - this.free.length;
	}
	/** After a compaction: layers 0 … used-1 are taken, nothing is free (see compactPlan). */
	resetPacked(used: number) {
		this.free = [];
		this.next = used;
	}
	/** Layers below capacity that allocWithin can still hand out. */
	available() {
		return this.free.length + Math.max(0, this.capacity - this.next);
	}
}

/** How an atlas grows: by a factor of its capacity (at least to `need`) or in fixed chunks. */
export type GrowPolicy = { factor: number } | { chunk: number };

/**
 * The capacity after growing `capacity` to hold `need` layers under `max` (the device's
 * maxTextureArrayLayers). Returns `capacity` when it can't or needn't grow.
 *   factor: min(max, max(need, ceil(capacity · factor)))   (the old HeightPool.reserve)
 *   chunk:  min(max, capacity + chunk · k), the smallest k ≥ 1 reaching need   (ImageryArray.grow
 *           adds one chunk per call, and calls it only when need = capacity + 1)
 */
export function grownCapacity(
	capacity: number,
	need: number,
	max: number,
	policy: GrowPolicy,
) {
	if (need <= capacity || capacity >= max) return capacity;
	if ("factor" in policy)
		return Math.min(max, Math.max(need, Math.ceil(capacity * policy.factor)));
	const k = Math.max(1, Math.ceil((need - capacity) / policy.chunk));
	return Math.min(max, capacity + k * policy.chunk);
}

/** The copyTextureToTexture regions of a grow: every mip of the old `layers` layers. */
export function growCopies(size: number, mipLevels: number, layers: number) {
	const out: {
		mipLevel: number;
		width: number;
		height: number;
		depthOrArrayLayers: number;
	}[] = [];
	for (let mip = 0; mip < mipLevels; mip++) {
		const s = Math.max(1, size >> mip);
		out.push({
			mipLevel: mip,
			width: s,
			height: s,
			depthOrArrayLayers: layers,
		});
	}
	return out;
}

/**
 * A compaction of an atlas: the live layers `live` (any order, distinct) move to 0 … n−1, keeping
 * their relative order (a layer already in place stays), as runs of consecutive source layers that
 * land on consecutive targets (one copyTextureToTexture per run and mip). `capacity` is the smallest
 * multiple of `quantum` holding them (0 when none are live).
 */
export function compactPlan(live: readonly number[], quantum: number) {
	const sorted = [...live].sort((a, b) => a - b);
	const remap = new Map<number, number>();
	const runs: { from: number; to: number; count: number }[] = [];
	sorted.forEach((from, to) => {
		remap.set(from, to);
		const r = runs[runs.length - 1];
		if (r && r.from + r.count === from && r.to + r.count === to) r.count++;
		else runs.push({ from, to, count: 1 });
	});
	const capacity = Math.ceil(sorted.length / quantum) * quantum;
	return { remap, runs, capacity };
}

/**
 * Lease-aware compaction (texture-array-atlas.ts compactLeased, the height arrays under
 * terrainGpuDecode): `owner` = the layers the atlas's owner holds itself, `lease` = the layers of
 * live AtlasLeases. Their union is what moves to 0 … n−1. Null (never compact) when the two
 * overlap, when their count is not what the allocator says is in use (`used`: a layer is held by
 * someone this plan does not know), when a layer lies past `capacity`, or when it would not shrink
 * the atlas. The new capacity is the `quantum`-rounded live count, at least `minCapacity`, at most
 * `maxLayers`.
 */
export function compactLeasedPlan(
	owner: readonly number[],
	lease: readonly number[],
	used: number,
	quantum: number,
	minCapacity: number,
	capacity: number,
	maxLayers: number,
) {
	const live = [...owner, ...lease];
	if (live.length !== used || new Set(live).size !== live.length) return null;
	if (live.some((l) => !Number.isInteger(l) || l < 0 || l >= capacity))
		return null;
	const plan = compactPlan(live, quantum);
	const next = Math.min(maxLayers, Math.max(plan.capacity, minCapacity));
	if (next >= capacity) return null;
	return { remap: plan.remap, runs: plan.runs, capacity: next, live };
}

/**
 * Near-first overflow (batched-terrain.ts TileStore.sync on a device with few array layers): the
 * `budget` nearest of `tiles` by (distance, id), returned in their input order; all of them when
 * they fit. Deterministic: ties on distance break by id.
 */
export function nearestWithin<T extends { id: string; distance: number }>(
	tiles: readonly T[],
	budget: number,
): T[] {
	if (tiles.length <= budget) return [...tiles];
	if (budget <= 0) return [];
	const ranked = [...tiles].sort(
		(a, b) =>
			a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	const keep = new Set(ranked.slice(0, budget));
	return tiles.filter((t) => keep.has(t));
}

/**
 * Imagery overflow (imagery.ts ImageryArray.sync when a tier's array is at maxTextureArrayLayers):
 * per tier, the `maxLayers` nearest of the `wanted` tiles keep or get a layer. Rank = (distance,
 * resident first, id): a missing distance is +Infinity, and among exact ties a tile that already
 * holds a layer wins, so the same input never churns and nothing re-uploads needlessly.
 * `resident` maps tile id → the tier its layer is in; a resident tile wanted in another tier (its
 * source changed size) does not rank as resident in this one. `evict` lists the resident tiles that lose their
 * layer to a nearer tile (resident ids that are not wanted are the caller's to drop); `overflow`
 * lists the wanted tiles left without a layer. Near-first like nearestWithin, per tier.
 */
export function planImageryOverflow(
	wanted: readonly { id: string; tier: ImageryTier; distance?: number }[],
	resident: ReadonlyMap<string, ImageryTier>,
	maxLayers: number,
) {
	const admit = new Set<string>();
	const evict: string[] = [];
	const overflow: string[] = [];
	for (const tier of [256, 512] as const) {
		const inTier = wanted.filter((w) => w.tier === tier);
		const holds = (id: string) => resident.get(id) === tier;
		const dist = (w: { distance?: number }) =>
			w.distance ?? Number.POSITIVE_INFINITY;
		const ranked = [...inTier].sort((a, b) => {
			const da = dist(a);
			const db = dist(b);
			if (da !== db) return da < db ? -1 : 1;
			const ha = holds(a.id);
			if (ha !== holds(b.id)) return ha ? -1 : 1;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
		const budget = Math.max(0, maxLayers);
		ranked.forEach((w, i) => {
			if (i < budget) admit.add(w.id);
			else {
				overflow.push(w.id);
				if (resident.has(w.id)) evict.push(w.id);
			}
		});
	}
	return { admit, evict, overflow };
}

/**
 * Load-time leases (texture-array-atlas.ts writeTerrariumLeased) take a layer only while the atlas
 * keeps this many layers free below maxLayers. Leased spare tiles (deck/terrain-stream.ts
 * spareGpuLayers, 48) and in-flight loads (concurrency 10) must never take the layer a drawn tile
 * needs on a device with few array layers (256 on 'core' limits): near the limit the loader falls
 * back to the stats-only graph and the TileStore decodes at draw time, as before the leases.
 */
export function leaseFits(used: number, maxLayers: number) {
	const headroom = Math.min(64, Math.floor(maxLayers / 4));
	return used + headroom < maxLayers;
}

/**
 * Imagery tiers (imagery.ts ImageryArray): a source of at most 256² keeps its size in the 256²
 * array; anything larger is resized to 512². A tile's layer, as the terrain rows carry it (f32), is
 * the 512² layer itself or IMAGERY_SMALL_TIER_BASE + the 256² layer (−1: none); terrain.ts's WGSL
 * decodes it with the same constant. The base is above any device's maxTextureArrayLayers (2048)
 * and every encoded value is an exact f32 integer.
 */
export const IMAGERY_SMALL_TIER_BASE = 4096;
export type ImageryTier = 256 | 512;
export function imageryTierOf(width: number, height: number): ImageryTier {
	return width <= 256 && height <= 256 ? 256 : 512;
}
export function encodeImageryLayer(tier: ImageryTier, layer: number) {
	return tier === 512 ? layer : IMAGERY_SMALL_TIER_BASE + layer;
}
/** The WGSL's decode (terrain.ts terrain_sample), on the CPU: which array, which layer. */
export function decodeImageryLayer(encoded: number): {
	tier: ImageryTier;
	layer: number;
} | null {
	if (encoded < 0) return null;
	return encoded >= IMAGERY_SMALL_TIER_BASE
		? {
				tier: 256,
				layer: Math.trunc(Math.max(encoded - IMAGERY_SMALL_TIER_BASE, 0)),
			}
		: { tier: 512, layer: Math.trunc(Math.max(encoded, 0)) };
}

/** Texel bytes of `layers` layers of a size² array with `mipLevels` mips. */
export function atlasBytes(
	size: number,
	mipLevels: number,
	layers: number,
	bytesPerTexel: number,
) {
	let n = 0;
	for (let mip = 0; mip < mipLevels; mip++) {
		const s = Math.max(1, size >> mip);
		n += s * s;
	}
	return n * layers * bytesPerTexel;
}

/**
 * The window of ancestor tile `source` that tile `key` covers, as uv = offset + scale · uv_key (uv
 * in [0, 1] across a tile, row 0 = north). In S-pixel terms the key's texel i (centre i + 0.5 of
 * `size`) sits at ancestor pixel coordinate S · (offset + scale · (i + 0.5) / size), which is
 * exactly the position dem/grid.ts ancestorCrop samples (ox + (i + 0.5) · f, plus its −0.5
 * centre shift). Identity (offset 0, scale 1) when key = source. The scale is a power of two and
 * the offsets are multiples of it, so both are exact in f32 for z gaps < 24.
 *
 * Not wired into rendering: replacing the CPU ancestorCrop with this window needs the CPU height
 * consumers (heightAt, buildBatchGrid, relief rasters) off the cropped arrays first (WAG W2.4), and
 * a shader bilinear over the ancestor is not the bits of ancestorCrop + downsample2 + bilinear.
 */
export function ancestorWindow(source: TileKey, key: TileKey) {
	const n = 2 ** (key.z - source.z);
	const scale = 1 / n;
	return {
		offsetX: (key.x - source.x * n) * scale,
		offsetY: (key.y - source.y * n) * scale,
		scale,
	};
}
