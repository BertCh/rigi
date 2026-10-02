// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU twin of the GPU splat sort (./index.ts, ./splat-sort.wgsl.ts). The REFERENCE is the worker's
// sortSplatsByDepth (nearfield/splat-sort.worker.ts); this file twins the GPU's arithmetic so the
// identity argument can be checked in node (scripts/gpu/splat-sort-check.ts):
//
//   - splatKeysF32: the depth + key kernels with every WGSL f32 operation rounded by Math.fround
//     (no fused multiply-add: WGSL permits fusing, so a real GPU may differ from this by one ulp
//     of the depth, which can move a key by 1 at a bin edge; see README.md);
//   - stableOrderByKey: the order of luma's stable radix GPUSort (ascending key, ties by index).

import { DROPPED_KEY, TILE } from "./splat-sort.wgsl";

export { DROPPED_KEY, TILE };

const f = Math.fround;

/**
 * Keys as the GPU computes them: f32 depth, f32 span / scale, truncating u32 conversion.
 * Dropped splats (depth <= 0) get DROPPED_KEY. Returns the kept count too.
 */
export function splatKeysF32(
	positions: Float32Array,
	count: number,
	row: readonly [number, number, number, number],
): { keys: Uint32Array; kept: number } {
	const a = f(row[0]);
	const b = f(row[1]);
	const c = f(row[2]);
	const d = f(row[3]);
	const dist = new Float32Array(count);
	let minD = Number.POSITIVE_INFINITY;
	let maxD = Number.NEGATIVE_INFINITY;
	let kept = 0;
	for (let i = 0; i < count; i++) {
		const j = 3 * i;
		const s = f(
			f(f(a * positions[j]) + f(b * positions[j + 1])) +
				f(c * positions[j + 2]),
		);
		const v = -f(s + d);
		// +Inf (a corrupt splat) is dropped too: it would make maxD = Inf and every key NaN
		if (v > 0 && v < Number.POSITIVE_INFINITY) {
			dist[i] = v;
			if (v < minD) minD = v;
			if (v > maxD) maxD = v;
			kept++;
		} else dist[i] = -1;
	}
	const keys = new Uint32Array(count);
	const span = f(maxD - minD);
	const k = span > 0 ? f(65535 / span) : 0;
	for (let i = 0; i < count; i++) {
		if (dist[i] < 0) keys[i] = DROPPED_KEY;
		else keys[i] = Math.min(65535, Math.trunc(f(f(maxD - dist[i]) * k)));
	}
	return { keys, kept };
}

/**
 * The order luma's stable radix GPUSort produces over `keys`: ascending key, ties in ascending index,
 * for ALL `count` elements (dropped ones, key DROPPED_KEY, last). A counting sort over the 17-bit keys.
 */
export function stableOrderByKey(
	keys: Uint32Array,
	count: number,
): Uint32Array {
	const start = new Uint32Array(DROPPED_KEY + 2);
	for (let i = 0; i < count; i++) start[keys[i] + 1]++;
	for (let k = 1; k < start.length; k++) start[k] += start[k - 1];
	const order = new Uint32Array(count);
	for (let i = 0; i < count; i++) order[start[keys[i]]++] = i;
	return order;
}

/** The whole GPU pipeline on the CPU: f32 keys, then the stable order. */
export function gpuSplatOrderCpu(
	positions: Float32Array,
	count: number,
	row: readonly [number, number, number, number],
) {
	const { keys, kept } = splatKeysF32(positions, count, row);
	return { order: stableOrderByKey(keys, count), keys, kept };
}
