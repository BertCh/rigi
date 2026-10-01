// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU Terrarium decode (WAG W2.3): an rgba8unorm tile texture (uploadBitmap of an ImageBitmap) →
// f32 heights in a storage buffer, as a ComputeGraph node, plus an optional copy node into an
// r32float texture (layer). CPU twin and reference: dem/decode.ts decodeTerrarium. The arithmetic is
// f32-exact (terrarium-f32.ts has the argument; ingest.check.ts proves it over all 2^24 RGB values),
// so heights are bit-identical to decodeTerrarium OF THE SAME RGBA BYTES. Whether the texture holds
// the same bytes as the canvas getImageData path is measured by scripts/gpu/terrarium-ingest-check.mjs.
//
// The app's GPU decode path is terrarium-tile.ts (flag terrainGpuDecode: decode + 2× downsample +
// stats, written into the terrain height atlas with addHeightsToTexture); the node and the one-shot
// decodeTerrariumTileGpu here are the reference the browser gate compares it with. validateTile
// (NO_DATA fill, ±256 m R-channel repair) stays on the CPU: decodeTerrariumTileGpu returns heights the
// caller validates exactly as it validates decodeTerrarium's, and the tile path counts the samples
// validateTile would fill and leaves those tiles to the CPU.
//
//   const g = new ComputeGraph(device, "dem");
//   const rgba = importTextureResource(g, uploadBitmap(device, bmp, { id: "rgba" }));
//   const heights = g.transientBuffer("heights", w * h * 4);
//   addTerrariumDecode(g, { id: "decode", input: rgba, output: heights, width: w, height: h });
//   addHeightsToTexture(g, { id: "store", heights, target: atlasHandle, width: w, height: h, layer });
import type { Device } from "@luma.gl/core";
import { type ComputeGraph, cachedGraph } from "../core/graph";
import {
	defineKernel,
	encodeDispatch,
	type Kernel,
	kernel,
	kernelAsync,
} from "../core/kernel";
import type {
	GPUCommandGraphComputeExecutable,
	GraphBufferHandle,
	GraphTextureDescriptor,
	GraphTextureHandle,
} from "../core/luma";
import { withLease } from "../core/pool";
import {
	isCopyAligned,
	STORAGE_OFFSET_ALIGNMENT,
	texelWorkgroups,
} from "./layout";
import { INV_256, OFFSET, SEA_FLOOR } from "./terrarium-f32";
import { BITMAP_TEXTURE_USAGE, releaseResource, uploadBitmap } from "./upload";

const wgslF32 = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

/**
 * One texel per invocation: bytes = round(load · 255) (exact for unorm8), then
 * h = R·256 + G + B·(1/256) − 32768 in f32 (every step exact), sea clamp as decodeTerrarium.
 * Multiplying by 0.00390625 instead of dividing by 256: WGSL f32 division is only 2.5 ULP.
 */
export const TERRARIUM_WGSL = /* wgsl */ `\
@group(0) @binding(0) var rgba: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> heights: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(rgba);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let v = textureLoad(rgba, vec2i(id.xy), 0);
  let c = round(clamp(v, vec4f(0.0), vec4f(1.0)) * 255.0);
  let h = c.r * 256.0 + c.g + c.b * ${wgslF32(INV_256)} - ${wgslF32(OFFSET)};
  heights[id.y * size.x + id.x] = select(h, 0.0, h < 0.0 && h > ${wgslF32(SEA_FLOOR)});
}
`;

export const TERRARIUM_GROUP = "ingest";

export const K_TERRARIUM = defineKernel(
	"terrarium-decode",
	TERRARIUM_WGSL,
	[
		["rgba", "texture"],
		["heights", "storage"],
	],
	{ group: TERRARIUM_GROUP, label: "ingest-terrarium" },
);

/**
 * Add the decode node: `input` (an rgba8unorm texture handle of `width × height`) → `width × height`
 * f32 heights, row-major, row 0 = the image's top row, written in full at `output` + `byteOffset`
 * (a multiple of 256, e.g. a tile slot of a shared heights buffer).
 */
export function addTerrariumDecode<P>(
	g: ComputeGraph<P>,
	node: {
		id: string;
		input: GraphTextureHandle;
		output: GraphBufferHandle;
		width: number;
		height: number;
		byteOffset?: number;
		dependsOn?: string[];
	},
): ComputeGraph<P> {
	const { input, output, width, height } = node;
	const byteOffset = node.byteOffset ?? 0;
	const size = width * height * 4;
	if (byteOffset % STORAGE_OFFSET_ALIGNMENT)
		throw new Error(
			`${g.id}/${node.id}: heights offset ${byteOffset} is not ${STORAGE_OFFSET_ALIGNMENT}-aligned`,
		);
	if (byteOffset + size > output.byteLength)
		throw new Error(
			`${g.id}/${node.id}: ${size} B of heights at ${byteOffset} overflow "${output.id}" (${output.byteLength} B)`,
		);
	if (input.width !== width || input.height !== height)
		throw new Error(
			`${g.id}/${node.id}: input is ${input.width}×${input.height}, node is ${width}×${height}`,
		);
	const [x, y] = texelWorkgroups(width, height);
	g.addComputePass({
		id: node.id,
		dependsOn: node.dependsOn,
		resources: [
			{ texture: input, usage: "sampled" },
			{ buffer: output, usage: "storage-read-write" },
		],
		compile: ({ device }) => executable(kernel(device, K_TERRARIUM)),
		compileAsync: async ({ device }) =>
			executable(await kernelAsync(device, K_TERRARIUM)),
	});
	return g;

	function executable(k: Kernel): GPUCommandGraphComputeExecutable<P> {
		return {
			encode: ({ computePass, getBuffer, getTexture }) =>
				encodeDispatch(
					computePass,
					k,
					{
						rgba: getTexture(input),
						heights: { buffer: getBuffer(output), offset: byteOffset, size },
					},
					x,
					y,
				),
		};
	}
}

/**
 * Add a copy node: `width × height` f32 heights at `heights` + `byteOffset` → `layer` of the r32float
 * texture `target` (copyBufferToTexture; rows must be 256-byte aligned, true for 64·k px widths).
 * `layer` may be per run (a function of the run's parameters, e.g. an atlas slot).
 */
export function addHeightsToTexture<P>(
	g: ComputeGraph<P>,
	node: {
		id: string;
		heights: GraphBufferHandle;
		target: GraphTextureHandle;
		width: number;
		height: number;
		byteOffset?: number;
		layer?: number | ((parameters: P) => number);
		dependsOn?: string[];
	},
): ComputeGraph<P> {
	const { heights, target, width, height } = node;
	if (target.format !== "r32float")
		throw new Error(
			`${g.id}/${node.id}: target is ${target.format}, not r32float`,
		);
	if (!isCopyAligned(width, "r32float"))
		throw new Error(
			`${g.id}/${node.id}: ${width} px r32float rows are not 256-byte aligned`,
		);
	const byteOffset = node.byteOffset ?? 0;
	const layer = node.layer ?? 0;
	g.graph.addCopyPass({
		id: node.id,
		dependsOn: node.dependsOn,
		resources: [
			{ buffer: heights, usage: "copy-source" },
			{ texture: target, usage: "copy-destination" },
		],
		compile: () => ({
			encode: ({ commandEncoder, getBuffer, getTexture, parameters }) =>
				commandEncoder.copyBufferToTexture({
					sourceBuffer: getBuffer(heights),
					byteOffset,
					destinationTexture: getTexture(target),
					origin: [
						0,
						0,
						typeof layer === "function" ? layer(parameters) : layer,
					],
					bytesPerRow: width * 4,
					rowsPerImage: height,
					size: [width, height, 1],
				}),
		}),
	});
	return g;
}

/** The descriptor decodeTerrariumTileGpu imports its input under (an uploadBitmap texture). */
export const terrariumInputDescriptor = (
	width: number,
	height: number,
): GraphTextureDescriptor => ({
	id: "rgba",
	format: "rgba8unorm",
	width,
	height,
	usage: BITMAP_TEXTURE_USAGE,
	dimension: "2d",
	depth: 1,
	mipLevels: 1,
	samples: 1,
});

const GRAPH_GROUP = "ingest-terrarium";

/**
 * One tile, one submit: upload `bitmap` (decode it with colorSpaceConversion / premultiplyAlpha
 * "none"), decode on the GPU, read the heights back. The caller runs validateTile on the result as
 * it does on decodeTerrarium's. Graphs are cached per tile size (cachedGraph, 4 sizes).
 */
export function decodeTerrariumTileGpu(
	device: Device,
	bitmap: ImageBitmap,
): Promise<Float32Array> {
	const { width, height } = bitmap;
	const tex = uploadBitmap(device, bitmap, { id: "rgba" });
	const run = withLease(GRAPH_GROUP, () => {
		const { graph } = cachedGraph<void, null>(
			device,
			GRAPH_GROUP,
			`${width}x${height}`,
			(g) => {
				const input = g.importTexture(terrariumInputDescriptor(width, height));
				const heights = g.transientBuffer("heights", width * height * 4);
				addTerrariumDecode(g, {
					id: "decode",
					input,
					output: heights,
					width,
					height,
				});
				g.readNode("read", [heights]);
				return null;
			},
		);
		// queued synchronously inside the group lease (cachedGraph's eviction contract)
		return graph.run(undefined, { textures: { rgba: tex.texture } });
	});
	return run
		.then(({ reads }) => new Float32Array(reads.read[0]))
		.finally(() => releaseResource(tex));
}
