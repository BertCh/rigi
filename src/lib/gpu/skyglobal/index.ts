// GPU path of the T6 skyline global search (tools/matcher/stage1/skyglobal.py; CPU twin ./cpu.ts).
//
// Only the exhaustive yaw × pitch × roll × FOV grid runs on the GPU (skyglobal.wgsl.ts: CELLS →
// REDUCE → CANDS). The GPU returns, per yaw, the few cells whose certified score interval reaches the
// best lower bound; the CPU re-scores exactly those cells with cpu.ts cellScore (float64, numpy's
// pairwise float32 sum), so gridGpu's {best, arg} equal gridCpu's bit for bit whenever the interval
// assumptions hold (see the WGSL header). Pre-steps (sky model, score maps, profile) and the polish
// (coordinate descent, ~1400 sequential pose scores) stay on the CPU: they are cheap there and the
// polish is inherently sequential.
//
// Not wired into the service: see the parity / timing report (scripts/gpu/skyglobal-bench.mjs).
//
// Plumbing (src/lib/gpu/core): pooled buffers under the "skyglobal" lease (one grid on the GPU at a
// time, as before; the lease covers the GPU phase only, not the CPU re-score), bindings per pass, one
// core submit. The candidate list is read count-first: the one submit reads the count plus the first
// `head` slots (sized from the device's, or the caller's, last count), and only an unusually long
// list costs a second, exact-length read of the rest.
import { type Device, Buffer as LumaBuffer } from "@luma.gl/core";
import {
	type BindKind,
	defineKernel,
	dispatch,
	kernel,
	kernelAsync,
	submit,
} from "../core/kernel";
import {
	acquire,
	clear,
	pooledStorage,
	pooledUniform,
	releasePool,
	withLease,
} from "../core/pool";
import { readBack, stageReads } from "../core/readback";
import { getComputeDevice, hasFeature } from "../device";
import {
	type EdgeInputs,
	type GridPlan,
	type GridResult,
	SkyGlobal,
} from "./cpu";
import {
	CANDS_WGSL,
	CELLS_WGSL,
	COMBO_FLOATS,
	REDUCE_SG_WGSL,
	REDUCE_WGSL,
} from "./skyglobal.wgsl";

const spec = (id: string, source: string, layout: [string, BindKind][]) =>
	defineKernel(`skyglobal-${id}`, source, layout, {
		group: "skyglobal",
		label: `skyglobal-${id}`,
	});
const K_CELLS = spec("cells", CELLS_WGSL, [
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
const K_REDUCE = spec("reduce", REDUCE_WGSL, REDUCE_LAYOUT);
// defined outside the "skyglobal" warm group: it only compiles on devices with "subgroups"
const K_REDUCE_SG = defineKernel(
	"skyglobal-reduce-sg",
	REDUCE_SG_WGSL,
	REDUCE_LAYOUT,
	{ group: "skyglobal-sg", label: "skyglobal-reduce-sg" },
);
const K_CANDS = spec("cands", CANDS_WGSL, [
	["u", "uniform"],
	["cells", "read-only-storage"],
	["red", "read-only-storage"],
	["list", "storage"],
]);

/** REDUCE with subgroup ops where the device has them (identical output), else the shared-memory tree. */
const reduceSpec = (device: Device) =>
	hasFeature(device, "subgroups") ? K_REDUCE_SG : K_REDUCE;

/** Compile the three pipelines now (so the first search does not pay the WGSL compile). */
export function warmSkyGlobalGpu(device: Device) {
	for (const k of [K_CELLS, reduceSpec(device), K_CANDS]) kernel(device, k);
}

/** warmSkyGlobalGpu without blocking the thread (createComputePipelineAsync). */
export async function warmSkyGlobalGpuAsync(device: Device) {
	await Promise.all(
		[K_CELLS, reduceSpec(device), K_CANDS].map((k) => kernelAsync(device, k)),
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

// the pooled buffers are shared state: one grid at a time (FIFO), as the old module queue did
const OWNER = "skyglobal";
const key = (slot: string) => `${OWNER}/${slot}`;
const STORAGE = LumaBuffer.STORAGE | LumaBuffer.COPY_DST | LumaBuffer.COPY_SRC;
/** Minimum candidate slots read in the first readback (16 KiB); dev fixtures have ~700–800. */
const HEAD_MIN = 4096;
// per device, the last grid's candidate count: sizes the next grid's first read (1.5×, so one read
// nearly always). A caller with its own mix of photos can keep its own hint instead (`o.hint`).
const lastCounts = new WeakMap<Device, number>();

/** Free the grid's pooled buffers on `device` (the cells buffer alone is nCells × 16 B, ~24 MB). */
export function releaseSkyGlobalGpu(device: Device) {
	return withLease(OWNER, () => releasePool(device, `${OWNER}/`));
}

/** The grid's inputs, packed on the CPU (no GPU state: built outside the lease). */
type Packed = {
	T: ReturnType<SkyGlobal["tables"]>;
	ub: ArrayBuffer;
	prof: Float32Array;
	alpha: Float32Array;
	vfs: Uint32Array;
	combos: Float32Array;
	cap: number;
};

/** What the GPU phase hands the CPU re-score: the candidate list and the reduction. */
type GpuOut = {
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
	const r = await withLease(OWNER, () => gridOnGpu(device, sg, g, o, P));
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
	const ub = new ArrayBuffer(48);
	const uu = new Uint32Array(ub);
	const uf = new Float32Array(ub);
	uu.set([sg.w, sg.h, g.n, g.sy, nYaw, nCombo, Math.floor(g.cntMin) + 1, cap]);
	uf.set([o.eps ?? 5e-3, o.zeps ?? 1e-5, smin, smax], 8);
	return { T, ub, prof, alpha, vfs, combos, cap };
}

/** The GPU phase (under the lease): upload, CELLS → REDUCE → CANDS, the count-first readback. */
async function gridOnGpu(
	device: Device,
	sg: SkyGlobal,
	g: GridPlan,
	o: GridGpuOptions,
	P: Packed,
): Promise<GpuOut> {
	const t0 = performance.now();
	const nYaw = g.nYaw;
	const nCombo = g.combos.length;
	const nCells = nYaw * nCombo;
	const { cap } = P;
	const hint = o.hint ? o.hint.count : (lastCounts.get(device) ?? 0);
	const head = Math.min(
		cap,
		Math.max(1, o.head ?? Math.max(HEAD_MIN, Math.ceil(hint * 1.5))),
	);
	const sub = !o.noSubgroups && hasFeature(device, "subgroups");

	// every slot is either fully rewritten (inputs, cells, red) or cleared where it is read (the
	// list's count word): no stale bytes from the previous call reach a result
	const u = pooledUniform(device, key("u"), P.ub);
	const S = pooledStorage(device, key("S"), sg.Sc);
	const cells = acquire(device, key("cells"), nCells * 16, STORAGE);
	const red = acquire(device, key("red"), nYaw * 16, STORAGE);
	const list = acquire(device, key("list"), (cap + 1) * 4, STORAGE);
	const bind = {
		u,
		S,
		prof: pooledStorage(device, key("prof"), P.prof),
		alpha: pooledStorage(device, key("alpha"), P.alpha),
		vfs: pooledStorage(device, key("vfs"), P.vfs),
		combos: pooledStorage(device, key("combos"), P.combos),
		cells,
	};
	const t1 = performance.now();
	const enc = device.createCommandEncoder({ id: "skyglobal-grid" });
	clear(enc, list, 0, 4);
	dispatch(enc, kernel(device, K_CELLS), bind, Math.ceil(nYaw / 64), nCombo);
	dispatch(
		enc,
		kernel(device, sub ? K_REDUCE_SG : K_REDUCE),
		{ u, cells, red },
		nYaw,
	);
	dispatch(
		enc,
		kernel(device, K_CANDS),
		{ u, cells, red, list },
		Math.ceil(nYaw / 64),
		nCombo,
	);
	// one submit: the count + the first `head` slots, the reduction, (debug) the whole grid
	const ranges = [
		{ buffer: list, size: (head + 1) * 4 },
		{ buffer: red, size: nYaw * 16 },
	];
	if (o.debugGrid) ranges.push({ buffer: cells, size: nCells * 16 });
	const staged = stageReads(device, enc, ranges);
	try {
		submit(device, enc);
	} catch (e) {
		staged.cancel();
		throw e;
	}
	const [lb, rb, cb] = await staged.read();
	let readBytes = ranges.reduce((a, r) => a + r.size, 0);
	let reads = 1;
	const L0 = new Uint32Array(lb);
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
		gpuMs: t2 - t1,
		uploadMs: t1 - t0,
		rescoreMs: 0,
		nCells,
		nCand: count,
		maxCandPerYaw: 0,
		midArgFlips: 0,
		fellBack: false,
		readBytes,
		reads,
		subgroups: sub,
	};
	let dbg: GpuOut["dbg"] = {};
	if (cb) {
		const C = new Float32Array(cb);
		const mid = new Float32Array(nCells);
		const lo = new Float32Array(nCells);
		const hi = new Float32Array(nCells);
		for (let i = 0; i < nCells; i++) {
			mid[i] = C[i * 4];
			lo[i] = C[i * 4 + 1];
			hi[i] = C[i * 4 + 2];
		}
		dbg = { mid, lo, hi };
	}
	return { L, Ru: new Uint32Array(rb), count, stats, dbg };
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
