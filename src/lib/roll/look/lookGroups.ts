// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Roll look grouping: the GPU / CPU engines live in lib/gpu/palette/look-search.ts (a GPU module of
// the app graph manifest); these wrappers pick the compute device and fall back to the CPU twin.
import { getComputeDevice } from "#/lib/gpu/device";
import {
	groupByLookCpu,
	groupByLookGpu,
	type LookGrouping,
	type SimilarLook,
	similarLooksCpu,
	similarLooksGpu,
} from "#/lib/gpu/palette/look-search";

export * from "#/lib/gpu/palette/look-search";

/** Group photo embeddings by look: GPU when a compute device exists, else (or on failure) CPU. */
export async function groupByLook(
	embeddings: Float32Array[],
	clusterCountRequest?: number,
): Promise<LookGrouping> {
	const device =
		embeddings.length > 1 ? await getComputeDevice().catch(() => null) : null;
	if (device) {
		try {
			return await groupByLookGpu(device, embeddings, clusterCountRequest);
		} catch {
			// fall through to the CPU twin
		}
	}
	return groupByLookCpu(embeddings, clusterCountRequest);
}

/** The `k` most similar looks to `queryIndex`: GPU when a compute device exists, else CPU. */
export async function similarLooks(
	embeddings: Float32Array[],
	queryIndex: number,
	k: number,
): Promise<SimilarLook[]> {
	const device = await getComputeDevice().catch(() => null);
	if (device) {
		try {
			return await similarLooksGpu(device, embeddings, queryIndex, k);
		} catch {
			// CPU twin
		}
	}
	return similarLooksCpu(embeddings, queryIndex, k);
}
