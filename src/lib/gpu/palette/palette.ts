// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Per-photo palette: k-means (default k = 5) in OKLab over a small RGBA8 image (about 64 x 64).
// GPU path: ONE ComputeGraph per (pixel count, k, iterations): a WGSL kernel unpacks the RGBA8 words
// into OKLab rows (float32, row stride 4: L, a, b, pad), luma GPUKMeans clusters them, and the
// centroids + counts + status are read back through a read node. CPU twin: kMeansCpu with the same
// seeding / tie / empty-cluster rules, so the two agree to f32 noise (sorted by share).
import type { Device } from "@luma.gl/core";
import { type ComputeGraph, cachedGraph } from "../core/graph";
import { defineKernel } from "../core/kernel";
import { GPUKMeans, type GraphEmbeddingMatrix } from "../core/luma";
import { pooledStorage, withLease } from "../core/pool";
import { kMeansCpu } from "./kmeans-cpu";
import { type Oklab, oklabToSrgb8, srgb8ToOklab } from "./oklab";

/** An RGBA8 image (what ImageData / getImageData give). */
export type PhotoPixels = {
	width: number;
	height: number;
	data: Uint8ClampedArray;
};

export type PaletteColor = {
	oklab: Oklab;
	/** sRGB bytes 0..255 */
	rgb: [number, number, number];
	/** fraction of the pixels, 0..1 */
	share: number;
};

/** Colours sorted by share, descending (empty clusters are dropped). */
export type PhotoPalette = { colors: PaletteColor[] };

export type PaletteOptions = {
	/** colours, default 5 */
	k?: number;
	/** Lloyd rounds, default 12 */
	maxIterations?: number;
};

export const PALETTE_DEFAULT_K = 5;
export const PALETTE_DEFAULT_ITERATIONS = 12;
const LAB_STRIDE = 4;
const PALETTE_GROUP = "palette";

const resolve = (pixels: PhotoPixels, options: PaletteOptions) => {
	const rowCount = pixels.width * pixels.height;
	return {
		rowCount,
		k: Math.max(1, Math.min(options.k ?? PALETTE_DEFAULT_K, rowCount)),
		maxIterations: options.maxIterations ?? PALETTE_DEFAULT_ITERATIONS,
	};
};

/** The image as OKLab rows, f32, packed `stride` floats per row (L, a, b, ...). */
export function pixelsToOklab(pixels: PhotoPixels, stride = 3): Float32Array {
	const rowCount = pixels.width * pixels.height;
	const out = new Float32Array(rowCount * stride);
	const { data } = pixels;
	for (let i = 0; i < rowCount; i++) {
		const lab = srgb8ToOklab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
		out[i * stride] = lab[0];
		out[i * stride + 1] = lab[1];
		out[i * stride + 2] = lab[2];
	}
	return out;
}

function toPalette(
	centroids: Float32Array,
	counts: Uint32Array,
	total: number,
): PhotoPalette {
	const colors: PaletteColor[] = [];
	for (let cluster = 0; cluster < counts.length; cluster++) {
		if (counts[cluster] === 0) continue;
		const oklab: Oklab = [
			centroids[cluster * 3],
			centroids[cluster * 3 + 1],
			centroids[cluster * 3 + 2],
		];
		colors.push({
			oklab,
			rgb: oklabToSrgb8(oklab[0], oklab[1], oklab[2]),
			share: counts[cluster] / total,
		});
	}
	// stable: equal shares keep the cluster (seed) order
	colors.sort((p, q) => q.share - p.share);
	return { colors };
}

/** CPU palette (the twin of photoPaletteGpu). */
export function photoPaletteCpu(
	pixels: PhotoPixels,
	options: PaletteOptions = {},
): PhotoPalette {
	const { rowCount, k, maxIterations } = resolve(pixels, options);
	if (rowCount === 0) return { colors: [] };
	const lab = pixelsToOklab(pixels, 3);
	const result = kMeansCpu(lab, rowCount, 3, 3, k, maxIterations);
	return toPalette(result.centroids, result.counts, rowCount);
}

const unpackSpecs = new Map<number, ReturnType<typeof defineKernel>>();

/** The unpack kernel for `rowCount` pixels (the count is baked into the WGSL). */
function unpackSpec(rowCount: number) {
	let spec = unpackSpecs.get(rowCount);
	if (spec) return spec;
	spec = defineKernel(
		`palette-unpack-${rowCount}`,
		/* wgsl */ `
@group(0) @binding(0) var<storage, read> pixelWords: array<u32>;
@group(0) @binding(1) var<storage, read_write> lab: array<f32>;

fn srgbToLinear(encoded: f32) -> f32 {
	return select(pow((encoded + 0.055) / 1.055, 2.4), encoded / 12.92, encoded <= 0.04045);
}
fn cubeRoot(value: f32) -> f32 {
	return select(0.0, pow(value, 1.0 / 3.0), value > 0.0);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
	let index = id.x;
	if (index >= ${rowCount}u) { return; }
	let word = pixelWords[index];
	let r = srgbToLinear(f32(word & 255u) / 255.0);
	let g = srgbToLinear(f32((word >> 8u) & 255u) / 255.0);
	let b = srgbToLinear(f32((word >> 16u) & 255u) / 255.0);
	let l = cubeRoot(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	let m = cubeRoot(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	let s = cubeRoot(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	let o = index * ${LAB_STRIDE}u;
	lab[o] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
	lab[o + 1u] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
	lab[o + 2u] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
	lab[o + 3u] = 0.0;
}
`,
		[
			["pixelWords", "read-only-storage"],
			["lab", "storage"],
		],
		{ group: PALETTE_GROUP, label: `palette-unpack-${rowCount}` },
	);
	unpackSpecs.set(rowCount, spec);
	return spec;
}

/** Builds unpack + GPUKMeans + read node into `g` (not compiled). */
function buildPaletteGraph(
	g: ComputeGraph<void>,
	rowCount: number,
	k: number,
	maxIterations: number,
) {
	const pixelWords = g.importBuffer("pixelWords", rowCount * 4);
	const lab = g.transientBuffer("lab", rowCount * LAB_STRIDE * 4);
	g.addKernel({
		id: "unpack",
		spec: unpackSpec(rowCount),
		bindings: { pixelWords, lab },
		workgroups: [Math.ceil(rowCount / 64)],
	});
	const values = g.view(lab, "float32", (rowCount - 1) * LAB_STRIDE + 3);
	const dataset: GraphEmbeddingMatrix = {
		dimensions: 3,
		rowCount,
		chunks: [
			{
				values,
				rowCount,
				rowStride: LAB_STRIDE,
				byteOffset: 0,
				sourceRowOffset: 0,
			},
		],
	};
	const centroidBuffer = g.transientBuffer("centroids", Math.max(16, k * 12));
	const countBuffer = g.transientBuffer("counts", Math.max(16, k * 4));
	const labelBuffer = g.transientBuffer("labels", rowCount * 4);
	const statusBuffer = g.transientBuffer("status", 16);
	const centroids = g.view(centroidBuffer, "float32", k * 3);
	const counts = g.view(countBuffer, "uint32", k);
	const labels = g.view(labelBuffer, "uint32", rowCount);
	const status = g.view(statusBuffer, "uint32", 3);
	new GPUKMeans({
		id: "palette-kmeans",
		dataset,
		clusterCount: k,
		centroids,
		labels,
		counts,
		status,
		maxIterations,
		seed: "evenly-spaced",
	}).addToGraph(g.graph);
	g.declareNode("palette-kmeans", {
		uses: [lab],
		writes: [centroidBuffer, countBuffer, labelBuffer, statusBuffer],
	});
	g.readNode("out", [centroids, counts]);
	return { pixelWords };
}

/** Packs RGBA8 bytes into u32 words (r in the low byte), copying so the offset is 4-aligned. */
const packWords = (pixels: PhotoPixels, rowCount: number) =>
	new Uint32Array(
		pixels.data.buffer.slice(
			pixels.data.byteOffset,
			pixels.data.byteOffset + rowCount * 4,
		),
	);

/**
 * GPU palette: one cached ComputeGraph per (pixel count, k, iterations). Throws on a pipeline /
 * device failure; callers (photoLook) fall back to the CPU twin.
 */
export async function photoPaletteGpu(
	device: Device,
	pixels: PhotoPixels,
	options: PaletteOptions = {},
): Promise<PhotoPalette> {
	const { rowCount, k, maxIterations } = resolve(pixels, options);
	if (rowCount === 0) return { colors: [] };
	const words = packWords(pixels, rowCount);
	return withLease(PALETTE_GROUP, async () => {
		const entry = cachedGraph<void, { pixelWords: unknown }>(
			device,
			PALETTE_GROUP,
			`${rowCount}x${k}x${maxIterations}`,
			(g) => buildPaletteGraph(g, rowCount, k, maxIterations),
		);
		await entry.graph.compileAsync();
		const input = pooledStorage(device, `${PALETTE_GROUP}/pixels`, words);
		const { reads } = await entry.graph.run(undefined, {
			buffers: { pixelWords: input },
		});
		const [centroidBytes, countBytes] = reads.out;
		return toPalette(
			new Float32Array(centroidBytes, 0, k * 3),
			new Uint32Array(countBytes, 0, k),
			rowCount,
		);
	});
}
