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
import type { Buffer, Device } from "@luma.gl/core";
import { getComputeDevice } from "../device";
import {
	type BindKind,
	dispatch,
	type KernelSpec,
	kernel,
	release,
	stage,
	storage,
	uniform,
} from "../look/kernel";
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
	REDUCE_WGSL,
} from "./skyglobal.wgsl";

const spec = (
	id: string,
	source: string,
	layout: [string, BindKind][],
): KernelSpec => ({
	id: `skyglobal-${id}`,
	source,
	layout,
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
const K_REDUCE = spec("reduce", REDUCE_WGSL, [
	["u", "uniform"],
	["cells", "read-only-storage"],
	["red", "storage"],
]);
const K_CANDS = spec("cands", CANDS_WGSL, [
	["u", "uniform"],
	["cells", "read-only-storage"],
	["red", "read-only-storage"],
	["list", "storage"],
]);

/** Compile the three pipelines now (so the first search does not pay the WGSL compile). */
export function warmSkyGlobalGpu(device: Device) {
	for (const k of [K_CELLS, K_REDUCE, K_CANDS]) kernel(device, k);
}

export type GridGpuOptions = {
	/** pixel-edge / validity-bound ambiguity band in px (default 5e-3; f32 error is ~3e-4 px) */
	eps?: number;
	/** |z − 0.1| ambiguity band (default 1e-5) */
	zeps?: number;
	/** candidate list capacity (default max(65536, 32 · nYaw)); overflow → CPU grid */
	cap?: number;
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

// the pipelines' bindings are shared state: one grid at a time per device
let queue: Promise<unknown> = Promise.resolve();

/** SkyGlobal.gridCpu(g) with the scoring on the GPU; resolves the identical {best, arg}. */
export function gridGpu(
	device: Device,
	sg: SkyGlobal,
	g: GridPlan,
	o: GridGpuOptions = {},
): Promise<GridGpuResult> {
	const run = queue.then(() => gridOnce(device, sg, g, o));
	queue = run.catch(() => {});
	return run;
}

async function gridOnce(
	device: Device,
	sg: SkyGlobal,
	g: GridPlan,
	o: GridGpuOptions,
): Promise<GridGpuResult> {
	const t0 = performance.now();
	const nYaw = g.nYaw;
	const nCombo = g.combos.length;
	const nCells = nYaw * nCombo;
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

	const bufs: Buffer[] = [];
	const keep = <B extends Buffer>(b: B) => {
		bufs.push(b);
		return b;
	};
	try {
		const u = keep(uniform(device, ub));
		const S = keep(storage(device, sg.Sc));
		const cells = keep(storage(device, nCells * 16));
		const red = keep(storage(device, nYaw * 16));
		const list = keep(storage(device, new Uint32Array(cap + 1)));
		const bind = {
			u,
			S,
			prof: keep(storage(device, prof)),
			alpha: keep(storage(device, alpha)),
			vfs: keep(storage(device, vfs)),
			combos: keep(storage(device, combos)),
			cells,
		};
		const t1 = performance.now();
		const enc = device.createCommandEncoder({ id: "skyglobal-grid" });
		dispatch(enc, kernel(device, K_CELLS), bind, Math.ceil(nYaw / 64), nCombo);
		dispatch(enc, kernel(device, K_REDUCE), { u, cells, red }, nYaw);
		dispatch(
			enc,
			kernel(device, K_CANDS),
			{ u, cells, red, list },
			Math.ceil(nYaw / 64),
			nCombo,
		);
		const rList = stage(device, enc, list, (cap + 1) * 4);
		const rRed = stage(device, enc, red, nYaw * 16);
		const rCells = o.debugGrid ? stage(device, enc, cells, nCells * 16) : null;
		device.submit(enc.finish());
		const [lb, rb, cb] = await Promise.all([
			rList.read(),
			rRed.read(),
			rCells?.read(),
		]);
		const t2 = performance.now();
		const L = new Uint32Array(lb);
		const Ru = new Uint32Array(rb);
		const count = L[0];
		const stats: GridGpuStats = {
			gpuMs: t2 - t1,
			uploadMs: t1 - t0,
			rescoreMs: 0,
			nCells,
			nCand: count,
			maxCandPerYaw: 0,
			midArgFlips: 0,
			fellBack: false,
		};
		let dbg: Pick<GridGpuResult, "mid" | "lo" | "hi"> = {};
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
			const r = sg.gridCpu(g);
			return { ...r, ms: performance.now() - t0, stats, ...dbg };
		}
		return {
			best,
			arg,
			ms: performance.now() - t0,
			stats,
			cands: L.slice(1, count + 1),
			...dbg,
		};
	} finally {
		release(...bufs);
	}
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
