// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Draped imagery for the WebGPU terrain: one 2D texture ARRAY (rgba8unorm-srgb, 512² layers,
// mipmapped), one layer per tile. Hardware sRGB decode = linear samples with correct filtering.
// Tiles arrive as ImageBitmaps from deck/terrain-data.ts loadImagery (256·2^k px mosaics); each is
// resized to the layer size off the main thread (createImageBitmap resize) and copied in.
//
// The layers live in a TextureArrayAtlas (texture-array-atlas.ts, shared with the terrain's height
// arrays): capacity grows in chunks (copyTextureToTexture keeps every mip of the existing layers) up
// to the device's maxTextureArrayLayers (256 on 'core' devices, 2048 on Apple with featureLevel
// 'max'). Tiles that don't fit draw without imagery (hillshade) and are counted in stats.overflow.
import type { Device } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { USAGE } from "./targets";
import { TextureArrayAtlas } from "./texture-array-atlas";
import { fullscreenWGSL } from "./wgsl";

// per-layer mip chain: each level = a linear 2×2 box of the level above (render, sRGB-correct:
// the -srgb view decodes on sample and encodes on write)
const MIP_WGSL = /* wgsl */ `\
${fullscreenWGSL}
@group(0) @binding(auto) var src: texture_2d<f32>;
@group(0) @binding(auto) var srcSampler: sampler;
@fragment fn fragmentMain(v: FullscreenOut) -> @location(0) vec4<f32> {
  return textureSampleLevel(src, srcSampler, v.uv, 0.0);
}
`;

export const IMAGERY_LAYER_SIZE = 512;
const MIP_LEVELS = Math.log2(IMAGERY_LAYER_SIZE) + 1;
const GROW = 64;

export class ImageryArray {
	readonly atlas: TextureArrayAtlas;
	/** tile id → array layer */
	private layers = new Map<string, number>();
	/** tile id → the bitmap the layer holds (identity: a new bitmap re-uploads) */
	private sources = new Map<string, ImageBitmap>();
	private pending = new Map<string, ImageBitmap>();
	private mipModel?: Model;
	private mipSampler?: ReturnType<Device["createSampler"]>;
	private destroyed = false;
	readonly maxLayers: number;
	stats = { layers: 0, capacity: 0, uploads: 0, overflow: 0, mipGens: 0 };
	/** Called when uploads land (the host should redraw). */
	onChange?: () => void;

	constructor(readonly device: Device) {
		this.maxLayers = Math.min(
			2048,
			(device.limits as { maxTextureArrayLayers?: number })
				.maxTextureArrayLayers ?? 256,
		);
		this.atlas = new TextureArrayAtlas(device, {
			id: "imagery-array",
			format: "rgba8unorm-srgb",
			size: IMAGERY_LAYER_SIZE,
			mipLevels: MIP_LEVELS,
			usage: USAGE.SAMPLE | USAGE.COPY_DST | USAGE.COPY_SRC | USAGE.RENDER,
			sampler: {
				minFilter: "linear",
				magFilter: "linear",
				mipmapFilter: "linear",
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
				maxAnisotropy: 8,
			},
			capacity: Math.min(GROW, this.maxLayers),
			maxLayers: this.maxLayers,
			grow: { chunk: GROW },
		});
	}

	/** The array texture (re-created when the atlas grows: read it per use). */
	get texture() {
		return this.atlas.texture;
	}

	/** Layer of a tile's imagery, or -1 (none yet / overflow). */
	layerOf(id: string) {
		return this.layers.get(id) ?? -1;
	}

	/**
	 * Match the array to `images` (tile id → bitmap) restricted to `keep` (the rendered tiles):
	 * releases layers of dropped tiles, uploads new / changed bitmaps asynchronously.
	 */
	sync(images: ReadonlyMap<string, ImageBitmap>, keep: Iterable<string>) {
		const want = new Set(keep);
		for (const [id, layer] of this.layers)
			if (!want.has(id) || !images.has(id)) {
				this.layers.delete(id);
				this.sources.delete(id);
				this.atlas.release(layer);
			}
		let overflow = 0;
		for (const id of want) {
			const bmp = images.get(id);
			if (!bmp || this.sources.get(id) === bmp || this.pending.get(id) === bmp)
				continue;
			if (
				!this.layers.has(id) &&
				!this.atlas.available() &&
				!this.atlas.reserve(this.atlas.capacity + 1)
			) {
				overflow++;
				continue;
			}
			this.pending.set(id, bmp);
			this.upload(id, bmp);
		}
		this.stats.overflow = overflow;
		this.stats.layers = this.layers.size;
		this.stats.capacity = this.atlas.capacity;
	}

	private async upload(id: string, bmp: ImageBitmap) {
		let img: ImageBitmap;
		try {
			img =
				bmp.width === IMAGERY_LAYER_SIZE && bmp.height === IMAGERY_LAYER_SIZE
					? bmp
					: await createImageBitmap(bmp, {
							resizeWidth: IMAGERY_LAYER_SIZE,
							resizeHeight: IMAGERY_LAYER_SIZE,
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
		let layer = this.layers.get(id);
		if (layer === undefined) {
			layer = this.atlas.allocWithin();
			if (layer === undefined) {
				if (img !== bmp) img.close();
				return;
			}
			this.layers.set(id, layer);
		}
		this.atlas.writeBitmap(layer, img);
		if (img !== bmp) img.close();
		this.sources.set(id, bmp);
		this.stats.uploads++;
		this.stats.layers = this.layers.size;
		this.layerMips(layer);
		this.onChange?.();
	}

	/** Build mip levels 1..n of one array layer (the rest of the array is untouched). */
	private layerMips(layer: number) {
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
		for (let mip = 1; mip < MIP_LEVELS; mip++) {
			const src = this.texture.createView({
				dimension: "2d",
				baseMipLevel: mip - 1,
				mipLevelCount: 1,
				baseArrayLayer: layer,
				arrayLayerCount: 1,
			});
			const dst = this.texture.createView({
				dimension: "2d",
				baseMipLevel: mip,
				mipLevelCount: 1,
				baseArrayLayer: layer,
				arrayLayerCount: 1,
			});
			const s = Math.max(1, IMAGERY_LAYER_SIZE >> mip);
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
		this.mipModel?.destroy();
		this.mipSampler?.destroy();
		this.atlas.destroy();
		this.layers.clear();
		this.sources.clear();
		this.pending.clear();
	}
}
