// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Capture-time order of many rolls at once: makeRoll's stable `takenAt.localeCompare` sort, with the
// rolls as independent segments of ONE graph. Keys are u32 seconds since the roll's earliest
// photo, values the photo's position in the roll, so luma's STABLE sorts keep equal times in input
// order, exactly like Array.sort. Rolls of up to 256 photos go through one GPUSegmentedSort (a
// workgroup each); a larger roll gets its own GPUSort over its range.
//
// Seconds drop sub-second digits and ignore how a takenAt string would collate, so the GPU order
// of each roll is verified against the CPU comparator (adjacent pairs ordered, equal ones in input
// order); a roll that fails the check, or has an unparseable time, is sorted on the CPU.
import type { Device } from "@luma.gl/core";
import { ComputeGraph } from "#/lib/gpu/core/graph";
import { GPUSegmentedSort, GPUSort } from "#/lib/gpu/core/luma";
import { pooledStorage, withLease } from "#/lib/gpu/core/pool";
import type { PhotoMeta } from "../../photos";
import { compareTakenAt } from "../roll";

/** GPUSegmentedSort sorts domains of at most this many rows. */
const SEGMENT_MAX = 256;
/** Segment starts are padded to this many rows (256 bytes: the view offset alignment). */
const ROW_ALIGN = 64;
const MAX_KEY = 0xffffffff;

/** CPU twin: each group in capture order (stable; what makeRoll does). */
export function sortGroupsByTimeCpu(groups: PhotoMeta[][]): PhotoMeta[][] {
	return groups.map((g) => [...g].sort(compareTakenAt));
}

/** True when `order` (indices into `group`) is the stable compareTakenAt order of the group. */
function isStableOrder(group: PhotoMeta[], order: ArrayLike<number>): boolean {
	if (order.length !== group.length) return false;
	const seen = new Uint8Array(group.length);
	for (let k = 0; k < order.length; k++) {
		const i = order[k];
		if (i >= group.length || seen[i]) return false;
		seen[i] = 1;
		if (k === 0) continue;
		const c = compareTakenAt(group[order[k - 1]], group[i]);
		if (c > 0 || (c === 0 && order[k - 1] > i)) return false;
	}
	return true;
}

/** Seconds since the group's earliest photo, or null (unparseable time or beyond u32). */
function secondsKeys(group: PhotoMeta[]): Uint32Array | null {
	const times = group.map((m) => Date.parse(m.takenAt));
	if (times.some((t) => !Number.isFinite(t))) return null;
	const t0 = Math.min(...times);
	const keys = new Uint32Array(group.length);
	for (let i = 0; i < times.length; i++) {
		const seconds = Math.floor((times[i] - t0) / 1000);
		if (seconds > MAX_KEY) return null;
		keys[i] = seconds;
	}
	return keys;
}

type Layout = { group: number; offset: number; length: number };

/**
 * Capture order of every group on the GPU: for each group, the indices into it in order, or null
 * where the CPU must decide (single photos need nothing; the rest failed a precondition).
 */
export async function sortOrdersGpu(
	device: Device,
	groups: PhotoMeta[][],
): Promise<(Uint32Array | null)[]> {
	const orders: (Uint32Array | null)[] = groups.map(() => null);
	const layout: Layout[] = [];
	const keyRuns: (Uint32Array | null)[] = [];
	let rows = 0;
	groups.forEach((g, group) => {
		if (g.length < 2) return;
		const keys = secondsKeys(g);
		if (!keys) return;
		layout.push({ group, offset: rows, length: g.length });
		keyRuns.push(keys);
		rows += Math.ceil(g.length / ROW_ALIGN) * ROW_ALIGN;
	});
	if (!layout.length) return orders;
	const keys = new Uint32Array(rows);
	const values = new Uint32Array(rows);
	layout.forEach((l, n) => {
		keys.set(keyRuns[n] as Uint32Array, l.offset);
		for (let i = 0; i < l.length; i++) values[l.offset + i] = i;
	});
	return withLease("roll-spatial-sort", async () => {
		const graph = new ComputeGraph<undefined>(device, "roll-spatial-sort");
		try {
			const bytes = rows * 4;
			const bKeys = pooledStorage(device, "roll-spatial-sort/keys", keys);
			const bValues = pooledStorage(device, "roll-spatial-sort/values", values);
			const bOutKeys = pooledStorage(
				device,
				"roll-spatial-sort/out-keys",
				bytes,
			);
			const bOutValues = pooledStorage(
				device,
				"roll-spatial-sort/out-values",
				bytes,
			);
			const hKeys = graph.importBuffer("keys", bytes);
			const hValues = graph.importBuffer("values", bytes);
			const hOutKeys = graph.importBuffer("outKeys", bytes);
			const hOutValues = graph.importBuffer("outValues", bytes);
			const small = layout.filter((l) => l.length <= SEGMENT_MAX);
			if (small.length)
				graph.add(
					new GPUSegmentedSort({
						id: "roll-spatial-segments",
						keys: graph.view(hKeys, "uint32", rows),
						values: graph.view(hValues, "uint32", rows),
						outputKeys: graph.view(hOutKeys, "uint32", rows),
						outputValues: graph.view(hOutValues, "uint32", rows),
						segments: small.map((l) => ({
							keysOffset: l.offset,
							valuesOffset: l.offset,
							outputKeysOffset: l.offset,
							outputValuesOffset: l.offset,
							length: l.length,
						})),
					}),
				);
			for (const l of layout.filter((x) => x.length > SEGMENT_MAX))
				graph.add(
					new GPUSort({
						id: `roll-spatial-sort-${l.group}`,
						keys: graph.view(hKeys, "uint32", l.length, l.offset * 4),
						values: graph.view(hValues, "uint32", l.length, l.offset * 4),
						outputKeys: graph.view(hOutKeys, "uint32", l.length, l.offset * 4),
						outputValues: graph.view(
							hOutValues,
							"uint32",
							l.length,
							l.offset * 4,
						),
					}),
				);
			const { data } = await graph.run(undefined, {
				buffers: {
					keys: bKeys,
					values: bValues,
					outKeys: bOutKeys,
					outValues: bOutValues,
				},
				read: [{ buffer: bOutValues, size: bytes }],
			});
			const sorted = new Uint32Array(data[0]);
			for (const l of layout) {
				const order = sorted.slice(l.offset, l.offset + l.length);
				if (isStableOrder(groups[l.group], order)) orders[l.group] = order;
			}
			return orders;
		} finally {
			graph.destroy();
		}
	});
}

/**
 * Each group in capture order, from the GPU when `device` is given (rolls it cannot order exactly
 * fall back to the CPU), else the CPU twin. Equal to sortGroupsByTimeCpu.
 */
export async function sortGroupsByTime(
	groups: PhotoMeta[][],
	device: Device | null = null,
): Promise<PhotoMeta[][]> {
	if (!device) return sortGroupsByTimeCpu(groups);
	let orders: (Uint32Array | null)[];
	try {
		orders = await sortOrdersGpu(device, groups);
	} catch {
		return sortGroupsByTimeCpu(groups);
	}
	return groups.map((g, i) => {
		const order = orders[i];
		if (order) return Array.from(order, (k) => g[k]);
		return g.length < 2 ? [...g] : [...g].sort(compareTakenAt);
	});
}

/** Alias for callers that think in rolls: sortRollsByTime(clusters). */
export const sortRollsByTime = sortGroupsByTime;
