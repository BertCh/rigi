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
