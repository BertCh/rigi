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
//   copyTextureToTexture (one submit), so contents survive: before this, HeightPool re-created
//   its array empty and TileStore re-uploaded every resident tile from the CPU (≈ 35–40 ms of
//   main-thread writeTexture in one sync when a pan grew the 256² pool, measured 2026-10-01 by
//   scripts/deck-webgpu/atlas-cost.mjs). The texture object changes on a grow: consumers that
//   hold it (bind groups, relief-heights imports) ask for `texture` per use; `version` counts
//   re-creations.
// - Pure allocation / growth math lives in atlas-layout.ts (node-checked).
import type { Device, Texture } from "@luma.gl/core";
import { uploadBitmap, uploadRaster } from "../gpu/ingest/upload";
import {
	type GrowPolicy,
	growCopies,
	grownCapacity,
	LayerAllocator,
} from "./atlas-layout";

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
	stats = { grows: 0, copiedLayers: 0, writes: 0, writeBytes: 0 };
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

	/**
	 * Room for layer indices < need (capped at maxLayers); grows by copy, keeping every layer's
	 * contents. true = the texture was re-created (rebind it).
	 */
	reserve(need: number) {
		const cap = this.capacity;
		const next = grownCapacity(cap, need, this.maxLayers, this.props.grow);
		if (next === cap) return false;
		const old = this.texture;
		const tex = this.create(next);
		const enc = this.device.createCommandEncoder({
			id: `${this.props.id}-grow`,
		});
		for (const c of growCopies(this.size, this.mipLevels, cap))
			enc.copyTextureToTexture({
				sourceTexture: old,
				mipLevel: c.mipLevel,
				destinationTexture: tex,
				destinationMipLevel: c.mipLevel,
				width: c.width,
				height: c.height,
				depthOrArrayLayers: c.depthOrArrayLayers,
			});
		this.device.submit(enc.finish());
		old.destroy();
		this.layers.capacity = next;
		this.texture = tex;
		this.version++;
		this.stats.grows++;
		this.stats.copiedLayers += cap;
		return true;
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

	destroy() {
		this.texture.destroy();
	}
}
