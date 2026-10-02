// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Farthest-point seeding for GPUKMeans without touching luma. GPUKMeans seeds cluster c from source
// row min(floor(c * rows / k), rows - 1) (gpu-k-means.js addSeedSelectionPass: the nearest valid row
// cyclically from that target, i.e. the target itself when every row is finite). So we permute the
// rows before upload such that those exact positions hold well-separated seeds, and map labels /
// ranks back through the permutation. The CPU twin runs kMeansCpu on the same permuted rows, so the
// two stay in parity.

/** The row GPUKMeans (and kMeansCpu) probes for cluster `cluster`. */
export const seedPosition = (
	cluster: number,
	rowCount: number,
	clusterCount: number,
) => Math.min(Math.floor((cluster * rowCount) / clusterCount), rowCount - 1);

/**
 * Deterministic farthest-point seeds over `candidateCount` rows: the row nearest the mean first,
 * then repeatedly the row maximising its minimum squared distance to the chosen seeds; ties go to
 * the lowest index, and a chosen row is never picked twice. Returns candidate indices.
 */
export function farthestPointSeeds(
	values: Float32Array,
	candidateCount: number,
	dimensions: number,
	rowStride: number,
	seedCount: number,
): number[] {
	const count = Math.min(seedCount, candidateCount);
	const mean = new Float64Array(dimensions);
	for (let row = 0; row < candidateCount; row++)
		for (let d = 0; d < dimensions; d++) mean[d] += values[row * rowStride + d];
	for (let d = 0; d < dimensions; d++) mean[d] /= Math.max(1, candidateCount);
	const distance = (
		row: number,
		other: ArrayLike<number>,
		otherStride: number,
		otherRow: number,
	) => {
		let sum = 0;
		for (let d = 0; d < dimensions; d++) {
			const diff =
				values[row * rowStride + d] - other[otherRow * otherStride + d];
			sum += diff * diff;
		}
		return sum;
	};
	const seeds: number[] = [];
	const chosen = new Uint8Array(candidateCount);
	const nearest = new Float64Array(candidateCount).fill(
		Number.POSITIVE_INFINITY,
	);
	let best = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let row = 0; row < candidateCount; row++) {
		const d = distance(row, mean, 0, 0);
		if (d < bestDistance) {
			bestDistance = d;
			best = row;
		}
	}
	while (seeds.length < count) {
		seeds.push(best);
		chosen[best] = 1;
		let next = -1;
		let farthest = -1;
		for (let row = 0; row < candidateCount; row++) {
			if (chosen[row]) continue;
			nearest[row] = Math.min(
				nearest[row],
				distance(row, values, rowStride, best),
			);
			if (nearest[row] > farthest) {
				farthest = nearest[row];
				next = row;
			}
		}
		if (next < 0) break;
		best = next;
	}
	return seeds;
}

/**
 * The permutation putting `seedRows` (original row indices, distinct) at GPUKMeans's seed positions:
 * `permutation[i]` is the original row stored at permuted position i.
 */
export function seedPermutation(
	rowCount: number,
	seedRows: number[],
): Uint32Array {
	const permutation = Uint32Array.from({ length: rowCount }, (_, i) => i);
	const position = Uint32Array.from({ length: rowCount }, (_, i) => i);
	seedRows.forEach((seed, cluster) => {
		const target = seedPosition(cluster, rowCount, seedRows.length);
		const from = position[seed];
		if (from === target) return;
		const displaced = permutation[target];
		permutation[target] = seed;
		permutation[from] = displaced;
		position[seed] = target;
		position[displaced] = from;
	});
	return permutation;
}

/** Rows of `values` in permuted order, packed `rowStride` floats per row. */
export function permuteRows(
	values: Float32Array,
	permutation: Uint32Array,
	rowStride: number,
): Float32Array {
	const out = new Float32Array(permutation.length * rowStride);
	for (let i = 0; i < permutation.length; i++)
		out.set(
			values.subarray(
				permutation[i] * rowStride,
				(permutation[i] + 1) * rowStride,
			),
			i * rowStride,
		);
	return out;
}

/** The farthest-point seed permutation of a row matrix (identity when it has a single row). */
export function farthestSeedPermutation(
	values: Float32Array,
	rowCount: number,
	dimensions: number,
	rowStride: number,
	clusterCount: number,
): Uint32Array {
	const seeds = farthestPointSeeds(
		values,
		rowCount,
		dimensions,
		rowStride,
		clusterCount,
	);
	return seedPermutation(rowCount, seeds);
}
