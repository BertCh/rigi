// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU path of the T6 skyline global search (tools/matcher/stage1/skyglobal.py; CPU twin ./cpu.ts).
//
// Only the exhaustive yaw × pitch × roll × FOV grid runs on the GPU (skyglobal.wgsl.ts: CELLS →
// REDUCE → FLAGS → luma GPUCompaction). The GPU returns, per yaw, the few cells whose certified
// score interval reaches the best lower bound, as a stable (ascending cell index) list; the CPU re-scores exactly those cells with cpu.ts cellScore (float64, numpy's
// pairwise float32 sum), so gridGpu's {best, arg} equal gridCpu's bit for bit whenever the interval
// assumptions hold (see the WGSL header). Pre-steps (sky model, score maps, profile) and the polish
// (coordinate descent, ~1400 sequential pose scores) stay on the CPU: they are cheap there and the
// polish is inherently sequential.
//
// Not wired into the service: see the parity / timing report (scripts/gpu/skyglobal-bench.mjs).
//
// Plumbing (src/lib/gpu/core): one core ComputeGraph encoding (./graph.ts; cells / red / compaction scratch are graph
// transients, cached per capacity; the inputs and the candidate list are pooled imports) under the
// "skyglobal" lease (one grid on the GPU at a time; the lease covers the GPU phase only, not the CPU
// re-score). The pooled per-pass path it replaced (bit for bit) was removed on 2026-10-01. Kernel
// specs and the readback decode live in ./kernels.ts. The candidate list is read count-first: the
// one submit reads the count plus the first `head` slots (sized from the device's, or the caller's,
// last count), and only an unusually long list costs a second, exact-length read of the rest from
// the pooled list buffer.
import type { Device } from "@luma.gl/core";
import { kernel, kernelAsync } from "../core/kernel";
import { releasePool, withLease } from "../core/pool";
import { getComputeDevice } from "../device";
import {
	type EdgeInputs,
	type GridPlan,
	type GridResult,
	SkyGlobal,
} from "./cpu";
import { gridOnGraph, releaseSkyGlobalGraphs } from "./graph";
import { K_CELLS, K_FLAGS, OWNER, reduceSpec } from "./kernels";
import { COMBO_FLOATS } from "./skyglobal.wgsl";
import { packSkyGlobalUniform } from "./uniforms";

/** Compile the three pipelines now (so the first search does not pay the WGSL compile). */
export function warmSkyGlobalGpu(device: Device) {
	for (const k of [K_CELLS, reduceSpec(device), K_FLAGS]) kernel(device, k);
}

/** warmSkyGlobalGpu without blocking the thread (createComputePipelineAsync). */
export async function warmSkyGlobalGpuAsync(device: Device) {
	await Promise.all(
		[K_CELLS, reduceSpec(device), K_FLAGS].map((k) => kernelAsync(device, k)),
	);
}

export type GridGpuOptions = {
	/** pixel-edge / validity-bound ambiguity band in px (default 5e-3; f32 error is ~3e-4 px) */
	eps?: number;
	/** |z − 0.1| ambiguity band (default 1e-5) */
	zeps?: number;
	/** candidate list capacity (default max(65536, 32 · nYaw)); overflow → CPU grid */
	cap?: number;
	/** candidate slots read with the count in the first readback (default from the last count); a longer list costs a second read */
	head?: number;
	/** the caller's own last-count hint for `head` (read, then updated); default: one per device */
	hint?: { count: number };
	/** force the shared-memory REDUCE even when the device has subgroups (parity checks) */
	noSubgroups?: boolean;
	/** also read back the GPU's point estimates (combo × yaw, float32) for parity reports */
	debugGrid?: boolean;
};

export type GridGpuStats = {
	/** submit → readback resolved (GPU work + transfer), ms */
	gpuMs: number;
	/** host-side packing + buffer creation, ms */
	uploadMs: number;
	/** exact CPU re-score of the candidates, ms */
	rescoreMs: number;
	nCells: number;
	nCand: number;
	/** most candidates at one yaw */
	maxCandPerYaw: number;
	/** yaws whose GPU point-estimate argmax differs from the exact winner */
	midArgFlips: number;
	/** true when the candidate list overflowed or was inconsistent and the CPU grid ran instead */
	fellBack: boolean;
	/** bytes read back from the GPU (all reads) */
	readBytes: number;
	/** readbacks (1, or 2 when the list outgrew `head`) */
	reads: number;
	/** REDUCE ran with subgroup ops */
	subgroups: boolean;
};

export type GridGpuResult = GridResult & {
	stats: GridGpuStats;
	/** GPU point estimates [combo × nYaw + yaw] (debugGrid only) */
	mid?: Float32Array;
	/** the certified candidate cells (combo × nYaw + yaw), for an exact re-score elsewhere (e.g. numpy) */
	cands?: Uint32Array;
	/** GPU certified intervals, lo / hi (debugGrid only) */
	lo?: Float32Array;
	hi?: Float32Array;
};

/**
 * Free the grid's pooled buffers and cached graphs on `device` (the cells buffer / transient alone is
 * nCells × 16 B, ~24 MB).
 */
export async function releaseSkyGlobalGpu(device: Device) {
	await withLease(OWNER, () => releasePool(device, `${OWNER}/`));
	await releaseSkyGlobalGraphs(device);
}

/** The grid's inputs, packed on the CPU (no GPU state: built outside the lease). */
export type Packed = {
	T: ReturnType<SkyGlobal["tables"]>;
	ub: ArrayBuffer;
	prof: Float32Array;
	alpha: Float32Array;
	vfs: Uint32Array;
	combos: Float32Array;
	cap: number;
};

/** What the GPU phase hands the CPU re-score: the candidate list and the reduction. */
export type GpuOut = {
	L: Uint32Array;
	Ru: Uint32Array;
	count: number;
	stats: GridGpuStats;
	dbg: Pick<GridGpuResult, "mid" | "lo" | "hi">;
};

/**
 * SkyGlobal.gridCpu(g) with the scoring on the GPU; resolves the identical {best, arg}. The
 * "skyglobal" lease covers the GPU phase only (buffers, submit, readbacks): the packing before it and
 * the exact CPU re-score (and any gridCpu fallback, 1–2 s) after it run with the lease released.
 */
export async function gridGpu(
	device: Device,
	sg: SkyGlobal,
	g: GridPlan,
	o: GridGpuOptions = {},
): Promise<GridGpuResult> {
	const t0 = performance.now();
	const P = pack(sg, g, o);
	const packMs = performance.now() - t0;
	const r = await withLease(OWNER, () => gridOnGraph(device, sg, g, o, P));
	r.stats.uploadMs += packMs;
	return rescore(sg, g, P, r, t0);
}

function pack(sg: SkyGlobal, g: GridPlan, o: GridGpuOptions): Packed {
	const nYaw = g.nYaw;
	const nCombo = g.combos.length;
	const cap = o.cap ?? Math.max(65536, 32 * nYaw);
	const T = sg.tables(g);
	// tables (float64 on the CPU, rounded once to float32)
	const prof = new Float32Array(g.n * 2);
	for (let i = 0; i < g.n; i++) {
		prof[i * 2] = T.sinP[i];
		prof[i * 2 + 1] = T.cosP[i];
	}
	const vfs = new Uint32Array(g.vfovs.length * 2);
	let na = 0;
	g.halfBins.forEach((hb, vi) => {
		vfs[vi * 2] = na;
		vfs[vi * 2 + 1] = hb;
		na += 2 * hb + 1;
	});
	const alpha = new Float32Array(na * 2);
	g.halfBins.forEach((_, vi) => {
		const s = T.sinA[vi];
		const c = T.cosA[vi];
		for (let j = 0; j < s.length; j++) {
			alpha[(vfs[vi * 2] + j) * 2] = s[j];
			alpha[(vfs[vi * 2] + j) * 2 + 1] = c[j];
		}
	});
	const combos = new Float32Array(nCombo * COMBO_FLOATS);
	g.combos.forEach((cb, i) => {
		const c = cb.cam;
		combos.set(
			[
				c.fy,
				c.fz,
				c.rx,
				c.ry,
				c.rz,
				c.ux,
				c.uy,
				c.uz,
				c.ta,
				c.t,
				cb.covDen,
				cb.vi,
			],
			i * COMBO_FLOATS,
		);
	});
	let smin = Number.POSITIVE_INFINITY;
	let smax = Number.NEGATIVE_INFINITY;
	for (const v of sg.Sc) {
		if (v < smin) smin = v;
		if (v > smax) smax = v;
	}
	const ub = packSkyGlobalUniform({
		w: sg.w,
		h: sg.h,
		n: g.n,
		sy: g.sy,
		nYaw,
		nCombo,
		cntMin: g.cntMin,
		cap,
		eps: o.eps,
		zeps: o.zeps,
		smin,
		smax,
	});
	return { T, ub, prof, alpha, vfs, combos, cap };
}

/** The CPU phase (no lease): exact re-score of the candidates, or gridCpu when the list is unusable. */
function rescore(
	sg: SkyGlobal,
	g: GridPlan,
	P: Packed,
	r: GpuOut,
	t0: number,
): GridGpuResult {
	const { L, Ru, count, stats, dbg } = r;
	const nYaw = g.nYaw;
	const { cap, T } = P;
	// exact re-score of the candidates, per yaw in combo order (gridCpu's strict ">" keeps the first max)
	const t3 = performance.now();
	const perYaw: number[][] = Array.from({ length: nYaw }, () => []);
	if (count <= cap)
		for (let i = 1; i <= count; i++) {
			const c = L[i];
			perYaw[c % nYaw].push(Math.floor(c / nYaw));
		}
	const best = new Float64Array(nYaw).fill(Number.NEGATIVE_INFINITY);
	const arg = new Int32Array(nYaw);
	let ok = count <= cap;
	for (let iy = 0; ok && iy < nYaw; iy++) {
		const cs = perYaw[iy].sort((a, b) => a - b);
		if (!cs.length) ok = false;
		stats.maxCandPerYaw = Math.max(stats.maxCandPerYaw, cs.length);
		for (const ci of cs) {
			const sc = sg.cellScore(g, T, iy, ci);
			if (sc > best[iy]) {
				best[iy] = sc;
				arg[iy] = ci;
			}
		}
		if (Ru[iy * 4 + 2] !== arg[iy]) stats.midArgFlips++;
	}
	stats.rescoreMs = performance.now() - t3;
	if (!ok) {
		stats.fellBack = true;
		const c = sg.gridCpu(g);
		return { ...c, ms: performance.now() - t0, stats, ...dbg };
	}
	return {
		best,
		arg,
		ms: performance.now() - t0,
		stats,
		cands: L.slice(1, count + 1),
		...dbg,
	};
}

/** SkyGlobal.search with the GPU grid (CPU grid when there is no device). Same result shape. */
export async function searchGpu(
	sg: SkyGlobal,
	vfov0: number,
	focalKnown: boolean,
	k = 6,
	o: GridGpuOptions & { device?: Device | null } = {},
) {
	const device = o.device === undefined ? await getComputeDevice() : o.device;
	const g = sg.plan(vfov0, focalKnown);
	if (!g) throw new Error("skyglobal: horizon profile has < 10 bins");
	let r: GridResult & { stats?: GridGpuStats };
	let gpu = false;
	if (device)
		try {
			r = await gridGpu(device, sg, g, o);
			gpu = !r.stats?.fellBack;
		} catch (e) {
			console.warn("[skyglobal] GPU grid failed, using the CPU", e);
			r = sg.gridCpu(g);
		}
	else r = sg.gridCpu(g);
	const t0 = performance.now();
	const peaks = sg.peaks(g, r, vfov0, k);
	const hyps = sg.polish(peaks, vfov0, focalKnown, k);
	return {
		hyps,
		peaks,
		gridMs: r.ms,
		refineMs: performance.now() - t0,
		gpu,
		stats: r.stats,
		plan: g,
		grid: r,
	};
}

/** Convenience: SkyGlobal(ed, aspect).search(vfov0, focalKnown, k) with the GPU grid when available. */
export async function skyGlobalSearch(
	ed: EdgeInputs,
	aspect: number,
	vfov0: number,
	focalKnown: boolean,
	k = 6,
	o: GridGpuOptions & { device?: Device | null } = {},
) {
	return searchGpu(new SkyGlobal(ed, aspect), vfov0, focalKnown, k, o);
}
