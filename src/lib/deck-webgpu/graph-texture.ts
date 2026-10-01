// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Sampled imports of render-device textures (the geometry targets) into a core ComputeGraph, for the
// point-query and silhouette graphs (geo-query-gpu.ts, silhouette-gpu.ts). gpu-core validates an
// imported texture against its descriptor EXACTLY (format, dimension, size, depth, mip levels,
// samples), so the descriptor copies every one of them from the texture, and the graph cache key
// carries the same fields (a resized target compiles another graph instead of failing validation).
import { Texture } from "@luma.gl/core";
import type { ComputeGraph, GraphTexture } from "#/lib/gpu/core/graph";

/** The texture fields gpu-core checks an import against, as a cache-key fragment. */
export const textureShapeKey = (texture: Texture) =>
	`${texture.format}:${texture.dimension}:${texture.width}x${texture.height}x${texture.depth}:${texture.mipLevels}:${texture.samples}`;

/** Import `texture`'s shape as sampled texture `id` of `graph` (the texture is bound per run by id). */
export function importSampledTexture<P>(
	graph: ComputeGraph<P>,
	id: string,
	texture: Texture,
): GraphTexture {
	return graph.importTexture({
		id,
		format: texture.format,
		dimension: texture.dimension,
		width: texture.width,
		height: texture.height,
		depth: texture.depth,
		mipLevels: texture.mipLevels,
		samples: texture.samples,
		usage: Texture.SAMPLE,
	});
}
