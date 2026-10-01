// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Browser side of scripts/gpu/terrarium-ingest-check.mjs (the WAG W2.3 gate). Per Terrarium tile:
//  a. RGBA bytes: createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" })
//     → uploadBitmap (copyExternalImageToTexture, rgba8unorm, premultipliedAlpha false) → copied back
//     to a buffer, against the same bitmap drawn to a 2D canvas and read with getImageData (the
//     dem/image.ts path);
//  b. heights: the GPU decode node, bit for bit, against bitmapHeights (dem/image.ts: the app's
//     canvas + decodeTerrarium), and against decodeTerrarium of the GPU's own texel bytes (kernel
//     exactness separately from the input bytes);
//  c. the r32float copy node round trip, and decodeTerrariumTileGpu (the one-shot API) against the
//     graph's heights;
//  d. validateTile on the CPU heights: how often the repair / fill fires (info for keeping it on CPU).
import { Texture } from "@luma.gl/core";
import { decodeTerrarium, validateTile } from "#/lib/dem/decode";
import { bitmapHeights } from "#/lib/dem/image";
import { getComputeDevice } from "../core/device";
import { ComputeGraph } from "../core/graph";
import {
	addHeightsToTexture,
	addTerrariumDecode,
	decodeTerrariumTileGpu,
	terrariumInputDescriptor,
} from "./terrarium";
import { releaseResource, uploadBitmap } from "./upload";

export type TileResult = {
	url: string;
	width: number;
	height: number;
	/** texel bytes that differ between the GPU texture and getImageData */
	rgbaDiff: number;
	/** canvas pixels with alpha != 255 */
	alphaNot255: number;
	/** heights whose bits differ from bitmapHeights (the app's CPU path) */
	heightDiff: number;
	/** heights whose bits differ from decodeTerrarium(GPU texel bytes) */
	kernelDiff: number;
	/** r32float round-trip bits differ */
	textureDiff: number;
	/** decodeTerrariumTileGpu bits differ from the graph */
	apiDiff: number;
	/** bitmapHeights twice (the canvas path is deterministic) */
	cpuRepeatDiff: number;
	validate: { repaired: number; filled: number; remaining: number };
	first?: string;
	error?: string;
};

const NONE: ImageBitmapOptions = {
	colorSpaceConversion: "none",
	premultiplyAlpha: "none",
};

function canvasBytes(bmp: ImageBitmap) {
	const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d", {
		willReadFrequently: true,
	}) as OffscreenCanvasRenderingContext2D;
	ctx.drawImage(bmp, 0, 0);
	return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
}

const countDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
	let n = a.length === b.length ? 0 : Math.max(a.length, b.length);
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
	return n;
};
const bitsOf = (f: Float32Array) =>
	new Uint32Array(f.buffer, f.byteOffset, f.length);

const graphs = new Map<string, ComputeGraph>();

/** The check graph of one tile size: decode, texel readback, r32float round trip. */
function checkGraph(
	device: Awaited<ReturnType<typeof getComputeDevice>> & object,
	w: number,
	h: number,
) {
	const key = `${w}x${h}`;
	let g = graphs.get(key);
	if (g) return g;
	g = new ComputeGraph(device, `ingest-check|${key}`);
	const input = g.importTexture(terrariumInputDescriptor(w, h));
	const heights = g.transientBuffer("heights", w * h * 4);
	const texels = g.transientBuffer("texels", w * h * 4);
	const back = g.transientBuffer("back", w * h * 4);
	const r32 = g.graph.createTransientTexture({
		id: "r32",
		format: "r32float",
		width: w,
		height: h,
		usage: Texture.COPY_DST | Texture.COPY_SRC | Texture.SAMPLE,
	});
	g.graph.addCopyPass({
		id: "texels",
		resources: [
			{ texture: input, usage: "copy-source" },
			{ buffer: texels, usage: "copy-destination" },
		],
		compile: () => ({
			encode: ({ commandEncoder, getBuffer, getTexture }) =>
				commandEncoder.copyTextureToBuffer({
					sourceTexture: getTexture(input),
					destinationBuffer: getBuffer(texels),
					width: w,
					height: h,
					depthOrArrayLayers: 1,
					bytesPerRow: w * 4,
					rowsPerImage: h,
				}),
		}),
	});
	addTerrariumDecode(g, {
		id: "decode",
		input,
		output: heights,
		width: w,
		height: h,
	});
	addHeightsToTexture(g, {
		id: "store",
		heights,
		target: r32,
		width: w,
		height: h,
	});
	g.graph.addCopyPass({
		id: "back",
		resources: [
			{ texture: r32, usage: "copy-source" },
			{ buffer: back, usage: "copy-destination" },
		],
		compile: () => ({
			encode: ({ commandEncoder, getBuffer, getTexture }) =>
				commandEncoder.copyTextureToBuffer({
					sourceTexture: getTexture(r32),
					destinationBuffer: getBuffer(back),
					width: w,
					height: h,
					depthOrArrayLayers: 1,
					bytesPerRow: w * 4,
					rowsPerImage: h,
				}),
		}),
	});
	g.readNode("read", [heights, texels, back]);
	g.compile();
	graphs.set(key, g);
	return g;
}

/** Run the checks over `urls` (Terrarium PNG / WebP tiles). */
export async function terrariumIngestSelftest(
	urls: string[],
): Promise<{ device: string | null; tiles: TileResult[] }> {
	const device = await getComputeDevice();
	if (!device) return { device: null, tiles: [] };
	const tiles: TileResult[] = [];
	for (const url of urls) {
		let bmp: ImageBitmap | null = null;
		const r: TileResult = {
			url,
			width: 0,
			height: 0,
			rgbaDiff: -1,
			alphaNot255: -1,
			heightDiff: -1,
			kernelDiff: -1,
			textureDiff: -1,
			apiDiff: -1,
			cpuRepeatDiff: -1,
			validate: { repaired: 0, filled: 0, remaining: 0 },
		};
		try {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			bmp = await createImageBitmap(await res.blob(), NONE);
			const { width: w, height: h } = bmp;
			r.width = w;
			r.height = h;
			// CPU: the app's path (bitmapHeights = canvas + decodeTerrarium) and its bytes
			const cpu = bitmapHeights(bmp);
			r.cpuRepeatDiff = countDiff(bitsOf(cpu), bitsOf(bitmapHeights(bmp)));
			const bytes = canvasBytes(bmp);
			let a = 0;
			for (let i = 3; i < bytes.length; i += 4) if (bytes[i] !== 255) a++;
			r.alphaNot255 = a;
			// GPU
			const tex = uploadBitmap(device, bmp, { id: "rgba" });
			let read: ArrayBuffer[];
			try {
				const g = checkGraph(device, w, h);
				read = (await g.run(undefined, { textures: { rgba: tex.texture } }))
					.reads.read;
			} finally {
				releaseResource(tex);
			}
			const gpu = new Float32Array(read[0]);
			const texels = new Uint8Array(read[1]);
			const back = new Float32Array(read[2]);
			r.rgbaDiff = countDiff(texels, bytes);
			r.heightDiff = countDiff(bitsOf(gpu), bitsOf(cpu));
			r.kernelDiff = countDiff(bitsOf(gpu), bitsOf(decodeTerrarium(texels)));
			r.textureDiff = countDiff(bitsOf(back), bitsOf(gpu));
			r.apiDiff = countDiff(
				bitsOf(await decodeTerrariumTileGpu(device, bmp)),
				bitsOf(gpu),
			);
			if (r.rgbaDiff || r.heightDiff) {
				for (let i = 0; i < w * h; i++)
					if (
						bitsOf(gpu)[i] !== bitsOf(cpu)[i] ||
						texels[i * 4] !== bytes[i * 4] ||
						texels[i * 4 + 1] !== bytes[i * 4 + 1] ||
						texels[i * 4 + 2] !== bytes[i * 4 + 2] ||
						texels[i * 4 + 3] !== bytes[i * 4 + 3]
					) {
						r.first = `px ${i % w},${Math.floor(i / w)}: gpu rgba ${[...texels.subarray(i * 4, i * 4 + 4)]} h ${gpu[i]}; canvas rgba ${[...bytes.subarray(i * 4, i * 4 + 4)]} h ${cpu[i]}`;
						break;
					}
			}
			const v = validateTile(cpu, w);
			r.validate = {
				repaired: v.repaired,
				filled: v.filled,
				remaining: v.remaining,
			};
		} catch (e) {
			r.error = String((e as Error)?.stack ?? e).slice(0, 400);
		} finally {
			bmp?.close();
		}
		tiles.push(r);
	}
	return {
		device: `${device.info.vendor} ${device.info.renderer} (${device.info.gpuType})`,
		tiles,
	};
}
