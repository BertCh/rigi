// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The skyglobal kernel specs and the GPU phase's helpers (./graph.ts): the lease / pool names, the
// count-first head sizing and the readback → GpuOut decode (incl. the optional tail read of a long
// candidate list from the pooled list buffer). Its own module so ./graph.ts can import it without
// an import cycle through ./index.ts.
import { type Buffer, type Device, Buffer as LumaBuffer } from "@luma.gl/core";
import { type BindKind, defineKernel } from "../core/kernel";
import { readBack } from "../core/readback";
import { hasFeature } from "../device";
import type { GpuOut, GridGpuOptions, GridGpuStats } from "./index";
import {
	CELLS_WGSL,
	FLAGS_WGSL,
	PICK_WGSL,
	REDUCE_SG_WGSL,
	REDUCE_WGSL,
	RESCORE_WGSL,
} from "./skyglobal.wgsl";

const spec = (id: string, source: string, layout: [string, BindKind][]) =>
	defineKernel(`skyglobal-${id}`, source, layout, {
		group: "skyglobal",
		label: `skyglobal-${id}`,
	});
export const K_CELLS = spec("cells", CELLS_WGSL, [
	["u", "uniform"],
	["S", "read-only-storage"],
	["prof", "read-only-storage"],
	["alpha", "read-only-storage"],
	["vfs", "read-only-storage"],
	["combos", "read-only-storage"],
	["cells", "storage"],
]);
const REDUCE_LAYOUT: [string, BindKind][] = [
	["u", "uniform"],
	["cells", "read-only-storage"],
	["red", "storage"],
];
export const K_REDUCE = spec("reduce", REDUCE_WGSL, REDUCE_LAYOUT);
// defined outside the "skyglobal" warm group: it only compiles on devices with "subgroups"
export const K_REDUCE_SG = defineKernel(
	"skyglobal-reduce-sg",
	REDUCE_SG_WGSL,
	REDUCE_LAYOUT,
	{ group: "skyglobal-sg", label: "skyglobal-reduce-sg" },
);
export const K_FLAGS = spec("flags", FLAGS_WGSL, [
	["u", "uniform"],
	["cells", "read-only-storage"],
	["red", "read-only-storage"],
	["vals", "storage"],
	["flags", "storage"],
]);

// the optional GPU re-score (GridGpuOptions.rescore "gpu"); bestKey / argOut are atomic arrays
export const K_RESCORE = spec("rescore", RESCORE_WGSL, [
	["u", "uniform"],
	["S", "read-only-storage"],
	["prof", "read-only-storage"],
	["alpha", "read-only-storage"],
	["vfs", "read-only-storage"],
	["combos", "read-only-storage"],
	["list", "read-only-storage"],
	["score", "storage"],
	["bestKey", "storage"],
]);
export const K_PICK = spec("pick", PICK_WGSL, [
	["u", "uniform"],
	["list", "read-only-storage"],
	["score", "read-only-storage"],
	["bestKey", "storage"],
	["argOut", "storage"],
]);

/** REDUCE with subgroup ops where the device has them (identical output), else the shared-memory tree. */
export const reduceSpec = (device: Device) =>
	hasFeature(device, "subgroups") ? K_REDUCE_SG : K_REDUCE;

// the pooled buffers are shared state: one grid at a time (FIFO), as the old module queue did
export const OWNER = "skyglobal";
export const key = (slot: string) => `${OWNER}/${slot}`;
export const STORAGE =
	LumaBuffer.STORAGE | LumaBuffer.COPY_DST | LumaBuffer.COPY_SRC;
/** Minimum candidate slots read in the first readback (16 KiB); dev fixtures have ~700–800. */
const HEAD_MIN = 4096;
// per device, the last grid's candidate count: sizes the next grid's first read (1.5×, so one read
// nearly always). A caller with its own mix of photos can keep its own hint instead (`o.hint`).
const lastCounts = new WeakMap<Device, number>();

/** Candidate slots read with the count in the first readback. */
export function headFor(device: Device, o: GridGpuOptions, cap: number) {
	const hint = o.hint ? o.hint.count : (lastCounts.get(device) ?? 0);
	return Math.min(
		cap,
		Math.max(1, o.head ?? Math.max(HEAD_MIN, Math.ceil(hint * 1.5))),
	);
}

/**
 * Decode the first readback ([list count + head slots, red, (debug) cells]) into GpuOut; reads the
 * rest of the list from `list` (a second, exact-length read) only when it outgrew `head`. Call under
 * the "skyglobal" lease (`list` is the pooled list buffer).
 */
export async function collect(
	device: Device,
	a: {
		list: Buffer;
		head: number;
		cap: number;
		nCells: number;
		readBytes: number;
		sub: boolean;
		t0: number;
		t1: number;
	},
	o: GridGpuOptions,
	lb: ArrayBuffer,
	rb: ArrayBuffer,
	cb: ArrayBuffer | undefined,
): Promise<GpuOut> {
	const { list, head, cap, nCells } = a;
	let { readBytes } = a;
	let reads = 1;
	const L0 = new Uint32Array(lb, 0, head + 1);
	const count = L0[0];
	if (o.hint) o.hint.count = Math.min(count, cap);
	else lastCounts.set(device, Math.min(count, cap));
	// the rest of the list, only when it outgrew `head` (and fits: an overflow falls back anyway)
	let L = L0;
	if (count > head && count <= cap) {
		const rest = {
			buffer: list,
			offset: (head + 1) * 4,
			size: (count - head) * 4,
		};
		const [tail] = await readBack(device, () => {}, [rest], {
			id: "skyglobal-cands-tail",
		});
		L = new Uint32Array(count + 1);
		L.set(L0);
		L.set(new Uint32Array(tail), head + 1);
		readBytes += rest.size;
		reads++;
	}
	const t2 = performance.now();
	const stats: GridGpuStats = {
		gpuMs: t2 - a.t1,
		uploadMs: a.t1 - a.t0,
		rescoreMs: 0,
		nCells,
		nCand: count,
		maxCandPerYaw: 0,
		midArgFlips: 0,
		fellBack: false,
		readBytes,
		reads,
		subgroups: a.sub,
		rescore: "cpu",
	};
	const dbg: GpuOut["dbg"] = cb ? debugGrid(cb, nCells) : {};
	return { L, Ru: new Uint32Array(rb), count, stats, dbg };
}

/** Decode the GPU-rescore readback ([count, bestKey, argOut]) into GpuOut (L / Ru empty, `rescored` set). */
export function decodeGpuRescore(
	r: { count: number; key: Uint32Array; arg: Uint32Array },
	a: {
		nCells: number;
		readBytes: number;
		sub: boolean;
		t0: number;
		t1: number;
	},
	cb: ArrayBuffer | undefined,
): GpuOut {
	const t2 = performance.now();
	const stats: GridGpuStats = {
		gpuMs: t2 - a.t1,
		uploadMs: a.t1 - a.t0,
		rescoreMs: 0,
		nCells: a.nCells,
		nCand: r.count,
		maxCandPerYaw: 0,
		midArgFlips: 0,
		fellBack: false,
		readBytes: a.readBytes,
		reads: 1,
		subgroups: a.sub,
		rescore: "gpu",
	};
	return {
		L: new Uint32Array([r.count]),
		Ru: new Uint32Array(0),
		count: r.count,
		stats,
		dbg: cb ? debugGrid(cb, a.nCells) : {},
		gpuRescore: { key: r.key, arg: r.arg },
	};
}

function debugGrid(cb: ArrayBuffer, nCells: number): GpuOut["dbg"] {
	const C = new Float32Array(cb, 0, nCells * 4);
	const mid = new Float32Array(nCells);
	const lo = new Float32Array(nCells);
	const hi = new Float32Array(nCells);
	for (let i = 0; i < nCells; i++) {
		mid[i] = C[i * 4];
		lo[i] = C[i * 4 + 1];
		hi[i] = C[i * 4 + 2];
	}
	return { mid, lo, hi };
}
