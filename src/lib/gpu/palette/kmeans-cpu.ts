// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Lloyd k-means on a row-strided Float32 matrix: the CPU twin of luma's GPUKMeans
// (@luma.gl/gpgpu gpu-vector-search/gpu-k-means.js, read for its exact rules):
// - seeds: cluster c starts at row min(floor(c * rows / k), rows - 1); a non-finite row is skipped to
//   the next finite row cyclically (the "evenly-spaced" seed);
// - assignment: nearest centroid by squared distance, ties go to the lowest cluster index;
// - update: mean of the members, an empty cluster keeps its previous centroid;
// - exactly `maxIterations` rounds at most; stops once no label changed. Counts are those of the last
//   executed assignment (as GPUKMeans' counts output), centroids are the final means.
// Rows with a non-finite component get label 0xffffffff and are ignored.

export const INVALID_LABEL = 0xffffffff;

export type KMeansResult = {
	/** clusterCount * dimensions, packed */
	centroids: Float32Array;
	labels: Uint32Array;
	counts: Uint32Array;
	iterations: number;
	converged: boolean;
};

export function kMeansCpu(
	values: Float32Array,
	rowCount: number,
	dimensions: number,
	rowStride: number,
	clusterCount: number,
	maxIterations: number,
): KMeansResult {
	const centroids = new Float32Array(clusterCount * dimensions);
	const labels = new Uint32Array(rowCount).fill(INVALID_LABEL);
	const counts = new Uint32Array(clusterCount);
	const finite = new Uint8Array(rowCount);
	for (let row = 0; row < rowCount; row++) {
		let ok = 1;
		for (let d = 0; d < dimensions; d++)
			if (!Number.isFinite(values[row * rowStride + d])) ok = 0;
		finite[row] = ok;
	}
	if (rowCount === 0)
		return { centroids, labels, counts, iterations: 0, converged: true };
	for (let cluster = 0; cluster < clusterCount; cluster++) {
		const target = Math.min(
			Math.floor((cluster * rowCount) / clusterCount),
			rowCount - 1,
		);
		for (let step = 0; step < rowCount; step++) {
			const row = (target + step) % rowCount;
			if (!finite[row]) continue;
			for (let d = 0; d < dimensions; d++)
				centroids[cluster * dimensions + d] = values[row * rowStride + d];
			break;
		}
	}
	let iterations = 0;
	let converged = false;
	const sums = new Float64Array(clusterCount * dimensions);
	for (
		let iteration = 0;
		iteration < maxIterations && !converged;
		iteration++
	) {
		let changed = 0;
		counts.fill(0);
		for (let row = 0; row < rowCount; row++) {
			if (!finite[row]) continue;
			let best = 0;
			let bestDistance = Number.POSITIVE_INFINITY;
			for (let cluster = 0; cluster < clusterCount; cluster++) {
				let distance = 0;
				for (let d = 0; d < dimensions; d++) {
					const diff =
						values[row * rowStride + d] - centroids[cluster * dimensions + d];
					distance += diff * diff;
				}
				if (distance < bestDistance) {
					bestDistance = distance;
					best = cluster;
				}
			}
			if (labels[row] !== best) changed++;
			labels[row] = best;
			counts[best]++;
		}
		sums.fill(0);
		for (let row = 0; row < rowCount; row++) {
			if (!finite[row]) continue;
			const cluster = labels[row];
			for (let d = 0; d < dimensions; d++)
				sums[cluster * dimensions + d] += values[row * rowStride + d];
		}
		for (let cluster = 0; cluster < clusterCount; cluster++)
			if (counts[cluster] > 0)
				for (let d = 0; d < dimensions; d++)
					centroids[cluster * dimensions + d] =
						sums[cluster * dimensions + d] / counts[cluster];
		iterations++;
		converged = changed === 0;
	}
	return { centroids, labels, counts, iterations, converged };
}
