// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Group photos by look (the LOOK_DIMS embeddings of lib/gpu/palette) and find
// similar looks. GPU: ONE ComputeGraph per (rows, dims, k): luma GPUKMeans over the embeddings, then
// GPUSimilaritySearch (squared euclidean, k = rows) with the k centroids as queries, so each group's
// members come out ordered by closeness to their centroid (most typical first). CPU twin: kMeansCpu
// plus a brute-force sort with the same tie rule (equal scores order by source row id).
import type { Device } from "@luma.gl/core";
import { type ComputeGraph, cachedGraph } from "../core/graph";
import {
	GPUKMeans,
	GPUSimilaritySearch,
	type GraphEmbeddingMatrix,
} from "../core/luma";
import { pooledStorage, withLease } from "../core/pool";
import { kMeansCpu } from "./kmeans-cpu";
import { farthestSeedPermutation, permuteRows } from "./seeding";

const GROUP_LEASE = "roll-look";
const SIMILAR_LEASE = "roll-look-similar";
const INVALID_ID = 0xffffffff;
export const LOOK_GROUP_ITERATIONS = 12;

export type LookGroup = {
	/** photo indices into the input array, most typical (closest to the centroid) first */
	members: number[];
	centroid: Float32Array;
};

export type LookGrouping = {
	/** groups ordered by size (largest first), then by their smallest member index */
	groups: LookGroup[];
	/** group index (into `groups`) of every input photo */
	groupOfPhoto: Uint32Array;
	backend: "gpu" | "cpu";
};

/** Default group count: round(sqrt(n / 2)) clamped to 2..6, and at most n. */
export const defaultLookGroupCount = (photoCount: number) =>
	Math.max(
		1,
		Math.min(
			photoCount,
			Math.max(2, Math.min(6, Math.round(Math.sqrt(photoCount / 2)))),
		),
	);

const dimensionsOf = (embeddings: Float32Array[]) => embeddings[0]?.length ?? 0;

const flatten = (embeddings: Float32Array[]) => {
	const dimensions = dimensionsOf(embeddings);
	const flat = new Float32Array(embeddings.length * dimensions);
	embeddings.forEach((row, i) => {
		flat.set(row, i * dimensions);
	});
	return flat;
};

const squaredDistance = (
	flat: Float32Array,
	row: number,
	centroids: Float32Array,
	cluster: number,
	dimensions: number,
) => {
	let sum = 0;
	for (let d = 0; d < dimensions; d++) {
		const diff =
			flat[row * dimensions + d] - centroids[cluster * dimensions + d];
		sum += diff * diff;
	}
	return sum;
};

/**
 * Seeds the k-means with farthest-point rows (seeding.ts): returns the permuted rows and the
 * permutation (permuted position -> original photo index) to map labels and ranks back.
 */
function seedRowsFor(
	flat: Float32Array,
	rowCount: number,
	dimensions: number,
	k: number,
) {
	const permutation = farthestSeedPermutation(
		flat,
		rowCount,
		dimensions,
		dimensions,
		k,
	);
	return { permutation, permuted: permuteRows(flat, permutation, dimensions) };
}

/** labels in permuted order -> labels per original photo */
const unpermuteLabels = (labels: Uint32Array, permutation: Uint32Array) => {
	const out = new Uint32Array(labels.length);
	for (let i = 0; i < labels.length; i++) out[permutation[i]] = labels[i];
	return out;
};

/** Shared tail: labels + centroids + per-cluster ranked row lists -> ordered groups. */
function assemble(
	rowCount: number,
	clusterCount: number,
	dimensions: number,
	labels: Uint32Array,
	centroids: Float32Array,
	rankedRows: (cluster: number) => ArrayLike<number>,
	backend: "gpu" | "cpu",
): LookGrouping {
	const raw: { members: number[]; centroid: Float32Array }[] = [];
	for (let cluster = 0; cluster < clusterCount; cluster++) {
		const ranked = rankedRows(cluster);
		const members: number[] = [];
		for (let i = 0; i < ranked.length; i++) {
			const row = ranked[i];
			if (row !== INVALID_ID && row < rowCount && labels[row] === cluster)
				members.push(row);
		}
		if (members.length)
			raw.push({
				members,
				centroid: centroids.slice(
					cluster * dimensions,
					(cluster + 1) * dimensions,
				),
			});
	}
	const smallest = (group: { members: number[] }) => Math.min(...group.members);
	raw.sort(
		(p, q) => q.members.length - p.members.length || smallest(p) - smallest(q),
	);
	const groupOfPhoto = new Uint32Array(rowCount).fill(INVALID_ID);
	raw.forEach((group, index) => {
		for (const row of group.members) groupOfPhoto[row] = index;
	});
	return { groups: raw, groupOfPhoto, backend };
}

const trivial = (
	embeddings: Float32Array[],
	backend: "gpu" | "cpu",
): LookGrouping => ({
	groups: embeddings.length
		? [
				{
					members: embeddings.map((_, i) => i),
					centroid: embeddings[0].slice(),
				},
			]
		: [],
	groupOfPhoto: new Uint32Array(embeddings.length),
	backend,
});

/** CPU twin of groupByLookGpu. */
export function groupByLookCpu(
	embeddings: Float32Array[],
	clusterCountRequest?: number,
): LookGrouping {
	const rowCount = embeddings.length;
	if (rowCount < 2) return trivial(embeddings, "cpu");
	const dimensions = dimensionsOf(embeddings);
	const k = Math.min(
		rowCount,
		clusterCountRequest ?? defaultLookGroupCount(rowCount),
	);
	const flat = flatten(embeddings);
	const { permutation, permuted } = seedRowsFor(flat, rowCount, dimensions, k);
	const result = kMeansCpu(
		permuted,
		rowCount,
		dimensions,
		dimensions,
		k,
		LOOK_GROUP_ITERATIONS,
	);
	const ranked = (cluster: number) => {
		const order = Array.from({ length: rowCount }, (_, i) => i);
		const distance = order.map((row) =>
			Math.fround(
				squaredDistance(flat, row, result.centroids, cluster, dimensions),
			),
		);
		return order.sort((p, q) => distance[p] - distance[q] || p - q);
	};
	return assemble(
		rowCount,
		k,
		dimensions,
		unpermuteLabels(result.labels, permutation),
		result.centroids,
		ranked,
		"cpu",
	);
}

function buildGroupGraph(
	g: ComputeGraph<void>,
	rowCount: number,
	dimensions: number,
	k: number,
) {
	const embeddingBuffer = g.importBuffer(
		"embeddings",
		rowCount * dimensions * 4,
	);
	const dataset: GraphEmbeddingMatrix = {
		dimensions,
		rowCount,
		chunks: [
			{
				values: g.view(embeddingBuffer, "float32", rowCount * dimensions),
				rowCount,
				rowStride: dimensions,
				byteOffset: 0,
				sourceRowOffset: 0,
			},
		],
	};
	const centroidBuffer = g.transientBuffer(
		"centroids",
		Math.max(16, k * dimensions * 4),
	);
	const countBuffer = g.transientBuffer("counts", Math.max(16, k * 4));
	const labelBuffer = g.transientBuffer("labels", rowCount * 4);
	const statusBuffer = g.transientBuffer("status", 16);
	const centroids = g.view(centroidBuffer, "float32", k * dimensions);
	const counts = g.view(countBuffer, "uint32", k);
	const labels = g.view(labelBuffer, "uint32", rowCount);
	const status = g.view(statusBuffer, "uint32", 3);
	new GPUKMeans({
		id: "look-kmeans",
		dataset,
		clusterCount: k,
		centroids,
		labels,
		counts,
		status,
		maxIterations: LOOK_GROUP_ITERATIONS,
		seed: "evenly-spaced",
	}).addToGraph(g.graph);
	g.declareNode("look-kmeans", {
		uses: [embeddingBuffer],
		writes: [centroidBuffer, countBuffer, labelBuffer, statusBuffer],
	});
	const idBuffer = g.transientBuffer("rank-ids", rowCount * k * 4);
	const scoreBuffer = g.transientBuffer("rank-scores", rowCount * k * 4);
	const resultBuffer = g.transientBuffer("rank-counts", Math.max(16, k * 4));
	new GPUSimilaritySearch({
		id: "look-rank",
		dataset,
		queries: {
			dimensions,
			rowCount: k,
			chunks: [
				{
					values: centroids,
					rowCount: k,
					rowStride: dimensions,
					byteOffset: 0,
					sourceRowOffset: 0,
				},
			],
		},
		outputIds: g.view(idBuffer, "uint32", rowCount * k),
		outputScores: g.view(scoreBuffer, "float32", rowCount * k),
		resultCounts: g.view(resultBuffer, "uint32", k),
		k: rowCount,
		metric: "squared-euclidean",
	}).addToGraph(g.graph);
	g.declareNode("look-rank", {
		uses: [embeddingBuffer, centroidBuffer],
		writes: [idBuffer, scoreBuffer, resultBuffer],
	});
	g.readNode("out", [
		labels,
		centroids,
		g.view(idBuffer, "uint32", rowCount * k),
	]);
}

/** GPU grouping (k-means + similarity ranking in one graph). Throws on device failure. */
export async function groupByLookGpu(
	device: Device,
	embeddings: Float32Array[],
	clusterCountRequest?: number,
): Promise<LookGrouping> {
	const rowCount = embeddings.length;
	if (rowCount < 2) return trivial(embeddings, "gpu");
	const dimensions = dimensionsOf(embeddings);
	const k = Math.min(
		rowCount,
		clusterCountRequest ?? defaultLookGroupCount(rowCount),
	);
	const { permutation, permuted } = seedRowsFor(
		flatten(embeddings),
		rowCount,
		dimensions,
		k,
	);
	return withLease(GROUP_LEASE, async () => {
		const entry = cachedGraph<void, void>(
			device,
			GROUP_LEASE,
			`${rowCount}x${dimensions}x${k}`,
			(g) => buildGroupGraph(g, rowCount, dimensions, k),
		);
		await entry.graph.compileAsync();
		const input = pooledStorage(device, `${GROUP_LEASE}/embeddings`, permuted);
		const { reads } = await entry.graph.run(undefined, {
			buffers: { embeddings: input },
		});
		const [labelBytes, centroidBytes, idBytes] = reads.out;
		const ids = new Uint32Array(idBytes, 0, rowCount * k);
		return assemble(
			rowCount,
			k,
			dimensions,
			unpermuteLabels(new Uint32Array(labelBytes, 0, rowCount), permutation),
			new Float32Array(centroidBytes, 0, k * dimensions),
			(cluster) =>
				Array.from(
					ids.subarray(cluster * rowCount, (cluster + 1) * rowCount),
					(id) => (id === INVALID_ID ? id : permutation[id]),
				),
			"gpu",
		);
	});
}

export type SimilarLook = { index: number; score: number };

const cosineScore = (a: Float32Array, b: Float32Array) => {
	let dot = 0;
	let aa = 0;
	let bb = 0;
	for (let d = 0; d < a.length; d++) {
		dot += a[d] * b[d];
		aa += a[d] * a[d];
		bb += b[d] * b[d];
	}
	if (aa === 0 && bb === 0) return 1;
	if (aa === 0 || bb === 0) return 0;
	return dot / Math.sqrt(aa * bb);
};

/** CPU twin of similarLooksGpu: the `k` most similar looks (cosine, best first, self excluded). */
export function similarLooksCpu(
	embeddings: Float32Array[],
	queryIndex: number,
	k: number,
): SimilarLook[] {
	const scored: SimilarLook[] = [];
	embeddings.forEach((row, index) => {
		if (index !== queryIndex)
			scored.push({ index, score: cosineScore(embeddings[queryIndex], row) });
	});
	scored.sort((p, q) => q.score - p.score || p.index - q.index);
	return scored.slice(0, k);
}

/** GPU similarity search (cosine, excludeSelf) over the embeddings. */
export async function similarLooksGpu(
	device: Device,
	embeddings: Float32Array[],
	queryIndex: number,
	k: number,
): Promise<SimilarLook[]> {
	const rowCount = embeddings.length;
	const resultLimit = Math.min(k, rowCount - 1);
	if (resultLimit < 1) return [];
	const dimensions = dimensionsOf(embeddings);
	const flat = flatten(embeddings);
	return withLease(SIMILAR_LEASE, async () => {
		const entry = cachedGraph<void, void>(
			device,
			SIMILAR_LEASE,
			`${rowCount}x${dimensions}x${resultLimit}`,
			(g) => {
				const embeddingBuffer = g.importBuffer(
					"embeddings",
					rowCount * dimensions * 4,
				);
				const queryBuffer = g.importBuffer("query", dimensions * 4);
				const queryIdBuffer = g.importBuffer("queryId", 4);
				const dataset: GraphEmbeddingMatrix = {
					dimensions,
					rowCount,
					chunks: [
						{
							values: g.view(embeddingBuffer, "float32", rowCount * dimensions),
							rowCount,
							rowStride: dimensions,
							byteOffset: 0,
							sourceRowOffset: 0,
						},
					],
				};
				const idBuffer = g.transientBuffer("ids", resultLimit * 4);
				const scoreBuffer = g.transientBuffer("scores", resultLimit * 4);
				const countBuffer = g.transientBuffer("count", 16);
				new GPUSimilaritySearch({
					id: "look-similar",
					dataset,
					queries: {
						dimensions,
						rowCount: 1,
						chunks: [
							{
								values: g.view(queryBuffer, "float32", dimensions),
								rowCount: 1,
								rowStride: dimensions,
								byteOffset: 0,
								sourceRowOffset: 0,
								// the query's own photo id, so excludeSelf can drop it
								sourceRowIds: g.view(queryIdBuffer, "uint32", 1),
							},
						],
					},
					outputIds: g.view(idBuffer, "uint32", resultLimit),
					outputScores: g.view(scoreBuffer, "float32", resultLimit),
					resultCounts: g.view(countBuffer, "uint32", 1),
					k: resultLimit,
					metric: "cosine",
					excludeSelf: true,
				}).addToGraph(g.graph);
				g.declareNode("look-similar", {
					uses: [embeddingBuffer, queryBuffer, queryIdBuffer],
					writes: [idBuffer, scoreBuffer, countBuffer],
				});
				g.readNode("out", [idBuffer, scoreBuffer, countBuffer]);
				return undefined;
			},
		);
		await entry.graph.compileAsync();
		const input = pooledStorage(device, `${SIMILAR_LEASE}/embeddings`, flat);
		const query = pooledStorage(
			device,
			`${SIMILAR_LEASE}/query`,
			embeddings[queryIndex],
		);
		const queryId = pooledStorage(
			device,
			`${SIMILAR_LEASE}/queryId`,
			new Uint32Array([queryIndex]),
		);
		const { reads } = await entry.graph.run(undefined, {
			buffers: { embeddings: input, query, queryId },
		});
		const [idBytes, scoreBytes, countBytes] = reads.out;
		const count = new Uint32Array(countBytes, 0, 1)[0];
		const ids = new Uint32Array(idBytes, 0, resultLimit);
		const scores = new Float32Array(scoreBytes, 0, resultLimit);
		const out: SimilarLook[] = [];
		for (let i = 0; i < Math.min(count, resultLimit); i++)
			if (ids[i] !== INVALID_ID) out.push({ index: ids[i], score: scores[i] });
		return out;
	});
}
