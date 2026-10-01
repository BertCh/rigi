/**
 * Browser parity + timing of the skyline global search: GPU grid (./index.ts; graph path by default,
 * diffed against the pooled path `{ graph: false }`, which must be bit-identical) vs the TS CPU twin
 * (./cpu.ts) vs Python skyglobal.py (reference outputs dumped by
 * tools/matcher/gpu_port/dump_skyglobal_fixtures.py). Loaded by scripts/gpu/skyglobal-bench.mjs in
 * headless Chromium:
 *
 *   const { benchPhoto } = await import('/src/lib/gpu/skyglobal/bench.ts');
 *   await benchPhoto({ id, base: '/@fs/<repo>/out/gpu/skyglobal', reps: 3 })
 *
 * Returns small JSON (no grids).
 */
import { getComputeDevice } from "../device";
import { type Hyp, type Pose, SkyGlobal } from "./cpu";
import { lastSkyGlobalGraphRun } from "./graph";
import { gridGpu, warmSkyGlobalGpu } from "./index";

type Ref = {
	hyps: Hyp[];
	k: number;
	profileMs: Record<string, number>;
};

async function bin(url: string) {
	const r = await fetch(url);
	if (!r.ok) throw new Error(`${url}: ${r.status}`);
	return r.arrayBuffer();
}

const poseDiff = (a: Pose, b: Pose) =>
	Math.max(
		Math.abs(((a.yaw - b.yaw + 540) % 360) - 180),
		Math.abs(a.pitch - b.pitch),
		Math.abs(a.roll - b.roll),
		Math.abs(a.vfov - b.vfov),
	);
const hypsDiff = (a: Hyp[], b: Hyp[]) => ({
	identical:
		a.length === b.length &&
		a.every(
			(h, i) => poseDiff(h.pose, b[i].pose) === 0 && h.score === b[i].score,
		),
	maxPoseDiff:
		a.length === b.length
			? Math.max(0, ...a.map((h, i) => poseDiff(h.pose, b[i].pose)))
			: Number.POSITIVE_INFINITY,
	n: [a.length, b.length],
});
const med = (xs: number[]) =>
	[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

export async function benchPhoto(o: {
	id: string;
	base: string;
	reps?: number;
	eps?: number;
}) {
	const reps = o.reps ?? 3;
	const d = `${o.base}/${o.id}`;
	const meta = await (await fetch(`${d}/meta.json`)).json();
	const ref: Ref = await (await fetch(`${d}/ref.json`)).json();
	const [dirs, fine, coarse, fg, rgb, pyBest] = await Promise.all(
		["dirs.f32", "fine.f32", "coarse.f32", "fg.f32", "rgb.u8", "best.f64"].map(
			(f) => bin(`${d}/${f}`),
		),
	);
	const ed = {
		w: meta.w,
		h: meta.h,
		dirs: new Float32Array(dirs),
		fine: new Float32Array(fine),
		coarse: new Float32Array(coarse),
		fg: new Float32Array(fg),
		rgb: new Uint8Array(rgb),
	};
	const k = ref.k;
	// --- CPU twin (timed: construction, grid, polish), full grid kept on a separate run
	const ctorMs: number[] = [];
	let sg: SkyGlobal | null = null;
	for (let i = 0; i < reps; i++) {
		const t0 = performance.now();
		sg = new SkyGlobal(ed, meta.aspect);
		ctorMs.push(performance.now() - t0);
	}
	if (!sg) throw new Error("reps must be ≥ 1");
	const g = sg.plan(meta.vfov0, meta.focalKnown);
	if (!g) throw new Error(`${o.id}: no horizon profile`);
	const cpuGridMs: number[] = [];
	let cpu = sg.gridCpu(g);
	cpuGridMs.push(cpu.ms);
	if (reps > 1) {
		cpu = sg.gridCpu(g);
		cpuGridMs.push(cpu.ms);
	}
	const full = new Float64Array(g.combos.length * g.nYaw);
	sg.gridCpu(g, full);
	let t0 = performance.now();
	const e0 = sg.evals;
	const cpuPeaks = sg.peaks(g, cpu, meta.vfov0, k);
	const cpuHyps = sg.polish(cpuPeaks, meta.vfov0, meta.focalKnown, k);
	const polishMs = performance.now() - t0;
	const evals = sg.evals - e0;
	const pb = new Float64Array(pyBest);
	let cpuPyBest = 0;
	for (let i = 0; i < g.nYaw; i++)
		cpuPyBest = Math.max(cpuPyBest, Math.abs(cpu.best[i] - pb[i]));

	// --- GPU
	const device = await getComputeDevice();
	if (!device) return { id: o.id, gpu: null, error: "no WebGPU device" };
	t0 = performance.now();
	warmSkyGlobalGpu(device);
	const compileMs = performance.now() - t0;
	t0 = performance.now();
	const cold = await gridGpu(device, sg, g, { eps: o.eps });
	const coldMs = performance.now() - t0;
	const warm: {
		total: number;
		gpu: number;
		upload: number;
		rescore: number;
	}[] = [];
	let last = cold;
	for (let i = 0; i < reps; i++) {
		t0 = performance.now();
		last = await gridGpu(device, sg, g, { eps: o.eps });
		warm.push({
			total: performance.now() - t0,
			gpu: last.stats.gpuMs,
			upload: last.stats.uploadMs,
			rescore: last.stats.rescoreMs,
		});
	}
	const dbg = await gridGpu(device, sg, g, { eps: o.eps, debugGrid: true });
	const graphInfo = lastSkyGlobalGraphRun;
	// the pooled path (graph: false): timed like the graph path, then diffed bit for bit
	const pooledWarm: number[] = [];
	const pooledGpu: number[] = [];
	let pooled = await gridGpu(device, sg, g, { eps: o.eps, graph: false });
	for (let i = 0; i < reps; i++) {
		t0 = performance.now();
		pooled = await gridGpu(device, sg, g, { eps: o.eps, graph: false });
		pooledWarm.push(performance.now() - t0);
		pooledGpu.push(pooled.stats.gpuMs);
	}
	const pooledDbg = await gridGpu(device, sg, g, {
		eps: o.eps,
		debugGrid: true,
		graph: false,
	});
	const pooledSplit = await gridGpu(device, sg, g, {
		eps: o.eps,
		head: 16,
		graph: false,
	});
	// subgroup REDUCE vs the shared-memory tree (must be identical); a forced 2-read list (head 16)
	const tree = await gridGpu(device, sg, g, { eps: o.eps, noSubgroups: true });
	const split = await gridGpu(device, sg, g, { eps: o.eps, head: 16 });
	const sortedCands = (r: typeof last) =>
		Array.from(r.cands ?? []).sort((a, b) => a - b);
	const sameCands = (a: typeof last, b: typeof last) => {
		const x = sortedCands(a);
		const y = sortedCands(b);
		return x.length === y.length && x.every((v, i) => v === y[i]);
	};
	const sameGrid = (a: typeof last, b: typeof last) =>
		sameCands(a, b) &&
		a.arg.every((v, i) => v === b.arg[i]) &&
		a.best.every((v, i) => v === b.best[i]) &&
		a.stats.midArgFlips === b.stats.midArgFlips;
	const sameBits = (a?: Float32Array, b?: Float32Array) =>
		!!a &&
		!!b &&
		a.length === b.length &&
		new Uint32Array(a.buffer, a.byteOffset, a.length).every(
			(v, i) => v === new Uint32Array(b.buffer, b.byteOffset, b.length)[i],
		);
	const graphVsPooled = {
		// sorted candidate set, best (f64 bits via ===), arg, midArgFlips (= red's mid argmax)
		grid: sameGrid(last, pooled),
		splitRead: split.stats.reads === 2 && sameGrid(split, pooledSplit),
		// the full GPU grid: mid / lo / hi bitwise
		cells:
			sameBits(dbg.mid, pooledDbg.mid) &&
			sameBits(dbg.lo, pooledDbg.lo) &&
			sameBits(dbg.hi, pooledDbg.hi),
		stats:
			last.stats.nCand === pooled.stats.nCand &&
			last.stats.readBytes === pooled.stats.readBytes &&
			last.stats.reads === pooled.stats.reads &&
			last.stats.fellBack === pooled.stats.fellBack,
	};
	// parity: GPU exact result vs CPU; GPU point estimates vs CPU full grid; certification check
	let bestDiff = 0;
	let argFlips = 0;
	for (let i = 0; i < g.nYaw; i++) {
		bestDiff = Math.max(bestDiff, Math.abs(last.best[i] - cpu.best[i]));
		if (last.arg[i] !== cpu.arg[i]) argFlips++;
	}
	let midMax = 0;
	let midOver1e5 = 0;
	let outside = 0;
	let widthSum = 0;
	let midWinnerFlips = 0;
	const mid = dbg.mid as Float32Array;
	const lo = dbg.lo as Float32Array;
	const hi = dbg.hi as Float32Array;
	for (let i = 0; i < full.length; i++) {
		const dd = Math.abs(mid[i] - full[i]);
		if (dd > midMax) midMax = dd;
		if (dd > 1e-5) midOver1e5++;
		if (full[i] < lo[i] || full[i] > hi[i]) outside++;
		widthSum += hi[i] - lo[i];
	}
	// what a plain float32 GPU grid (argmax of the point estimates, no exact re-score) would pick
	const midBest = new Float64Array(g.nYaw).fill(Number.NEGATIVE_INFINITY);
	const midArg = new Int32Array(g.nYaw);
	for (let c = 0; c < g.combos.length; c++)
		for (let i = 0; i < g.nYaw; i++)
			if (mid[c * g.nYaw + i] > midBest[i]) {
				midBest[i] = mid[c * g.nYaw + i];
				midArg[i] = c;
			}
	for (let i = 0; i < g.nYaw; i++)
		if (midArg[i] !== cpu.arg[i]) midWinnerFlips++;
	const midPeaks = sg.peaks(
		g,
		{ best: midBest, arg: midArg, ms: 0 },
		meta.vfov0,
		k,
	);
	const gpuPeaks = sg.peaks(g, last, meta.vfov0, k);
	const gpuHyps = sg.polish(gpuPeaks, meta.vfov0, meta.focalKnown, k);
	const midHyps = sg.polish(midPeaks, meta.vfov0, meta.focalKnown, k);
	const samePeaks = (a: typeof cpuPeaks, b: typeof cpuPeaks) =>
		a.length === b.length &&
		a.every(
			(p, i) =>
				p.yaw === b[i].yaw &&
				p.pitch === b[i].pitch &&
				p.roll === b[i].roll &&
				p.vfov === b[i].vfov,
		);
	return {
		id: o.id,
		nYaw: g.nYaw,
		nCombo: g.combos.length,
		nCells: g.nYaw * g.combos.length,
		focalKnown: meta.focalKnown,
		cpu: {
			ctorMs: med(ctorMs),
			gridMs: Math.min(...cpuGridMs),
			polishMs,
			evals,
			vsPython: { bestMaxAbs: cpuPyBest, hyps: hypsDiff(cpuHyps, ref.hyps) },
		},
		py: ref.profileMs,
		gpu: {
			compileMs,
			coldMs,
			warmMs: med(warm.map((w) => w.total)),
			gpuMs: med(warm.map((w) => w.gpu)),
			uploadMs: med(warm.map((w) => w.upload)),
			rescoreMs: med(warm.map((w) => w.rescore)),
			nCand: last.stats.nCand,
			maxCandPerYaw: last.stats.maxCandPerYaw,
			fellBack: last.stats.fellBack,
			subgroups: last.stats.subgroups,
			readBytes: last.stats.readBytes,
			reads: last.stats.reads,
			treeReduceIdentical: sameGrid(last, tree),
			graphVsPooled,
			pooledWarmMs: med(pooledWarm),
			pooledGpuMs: med(pooledGpu),
			graph: graphInfo && {
				key: graphInfo.key,
				nodes: graphInfo.stats.nodeCount,
				logicalTransientBytes: graphInfo.stats.logicalTransientBytes,
				physicalTransientBytes: graphInfo.stats.physicalTransientBytes,
			},
			splitReadIdentical: split.stats.reads === 2 && sameGrid(last, split),
			// exact path (GPU intervals + CPU re-score) vs the CPU grid
			bestMaxAbs: bestDiff,
			argFlips,
			peaksIdentical: samePeaks(gpuPeaks, cpuPeaks),
			hyps: hypsDiff(gpuHyps, cpuHyps),
			hypsVsPython: hypsDiff(gpuHyps, ref.hyps),
			// plain float32 grid (no re-score) vs the CPU grid
			midMaxAbs: midMax,
			midCellsOver1e5: midOver1e5,
			midWinnerFlips,
			midPeaksIdentical: samePeaks(midPeaks, cpuPeaks),
			midHyps: hypsDiff(midHyps, cpuHyps),
			// certification: CPU exact values outside the GPU's [lo, hi] (must be 0)
			outsideInterval: outside,
			meanIntervalWidth: widthSum / full.length,
		},
		hyps: cpuHyps.map((h) => ({ ...h.pose, score: h.score })),
		/** candidate cells for the numpy re-score (tools/matcher/gpu_port/verify_gpu_cands.py) */
		cands: Array.from(last.cands ?? []),
	};
}
