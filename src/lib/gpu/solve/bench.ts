/**
 * Browser parity + timing of the GPU coarse grid (./index.ts) against solvePose (geo/solve.ts) and
 * the CPU twin (./cpu.ts), on the unknown-pose worker's own scene (loadScene + sceneHorizon,
 * Mapterhorn) and skyline (detectSkyline on an 800 px working copy). Loaded by
 * scripts/gpu/solve-bench.mjs inside headless Chromium:
 *
 *   const { benchPhoto } = await import('/src/lib/gpu/solve/bench.ts');
 *   await benchPhoto(entry)
 *
 * Per condition (the worker's options: known / no gravity / no heading / none), solvePose runs as a
 * single solveOnce (fullSearchFallback off; headingKnown false for the 360° ones) so its time is the
 * time of the grid being replaced plus the fine stage. Returns small JSON.
 */
import { poseToCamera } from "#/lib/camera";
import { fetchDemTile, MAPTERHORN } from "#/lib/dem";
import { loadScene, sceneHorizon } from "#/lib/geo/pipeline";
import { detectSkyline } from "#/lib/geo/skyline";
import { type SolveOptions, solvePose } from "#/lib/geo/solve";
import { getComputeDevice } from "../core/device";
import {
	type CoarseGpuStats,
	type CoarseResult,
	coarseCpu,
	coarseGpu,
	fullSearchOptions,
	planCoarse,
	warmSolveGpu,
} from "./index";

type Entry = {
	id: string;
	lat: number;
	lon: number;
	altitudeM?: number | null;
	headingDeg: number;
	pitchDeg: number;
	rollDeg: number;
	vfovDeg: number;
	width: number;
	height: number;
};

const WORK_WIDTH = 800;
/** ε multiplier of the stress run (the observed error is ≤ 5e-3 ε, so this is still a valid bound) */
const STRESS = 100;

/** unknown-pose.worker.ts options() for the solve stage (plus fullSearchFallback off when local). */
function conditionOptions(yawKnown: boolean, gravKnown: boolean): SolveOptions {
	const o: SolveOptions = {};
	const sigma = { yaw: 15, pitch: 1.5, roll: 1.5, focal: 0.06 };
	if (!gravKnown) {
		o.pitchRange = 15;
		o.tiltGate = 90;
		sigma.pitch = 10;
		sigma.roll = 10;
	}
	if (!yawKnown) {
		o.headingKnown = false;
		o.yawRange = 180;
		sigma.yaw = 1e6;
	}
	o.sigma = sigma;
	o.fullSearchFallback = false;
	return o;
}

const CONDS: [string, boolean, boolean][] = [
	["known", true, true],
	["nogravity", true, false],
	["noheading", false, true],
	["none", false, false],
];

const same = (a: CoarseResult, b: CoarseResult) =>
	a.coarse.yaw === b.coarse.yaw &&
	a.coarse.pitch === b.coarse.pitch &&
	a.ambiguity === b.ambiguity &&
	a.medianCost === b.medianCost &&
	a.best.c === b.best.c &&
	a.runnerUp?.c === b.runnerUp?.c &&
	a.runnerUp?.dy === b.runnerUp?.dy &&
	a.seeds.length === b.seeds.length &&
	a.seeds.every(
		(s, i) =>
			s.dy === b.seeds[i].dy && s.dp === b.seeds[i].dp && s.c === b.seeds[i].c,
	);

async function skylineOf(id: string) {
	const blob = await (await fetch(`/photos/${id}.jpg`)).blob();
	const bmp = await createImageBitmap(blob);
	const w = WORK_WIDTH;
	const h = Math.round((bmp.height * w) / bmp.width);
	const c = new OffscreenCanvas(w, h);
	const c2d = c.getContext("2d", { willReadFrequently: true });
	if (!c2d) throw new Error("2D canvas unavailable");
	c2d.drawImage(bmp, 0, 0, w, h);
	return detectSkyline(c2d.getImageData(0, 0, w, h));
}

export async function benchPhoto(e: Entry, reps = 3) {
	const device = await getComputeDevice();
	if (!device) return { id: e.id, error: "no WebGPU device" };
	const tw = performance.now();
	await warmSolveGpu(device);
	const warmMs = performance.now() - tw;
	const t0 = performance.now();
	const { terrain, eye } = await loadScene(
		e.lat,
		e.lon,
		e.altitudeM ?? null,
		MAPTERHORN,
		(k) => fetchDemTile(MAPTERHORN, k).catch(() => undefined),
	);
	const horizon = await sceneHorizon(terrain, e.lat, e.lon, eye);
	const sceneMs = performance.now() - t0;
	const sky = await skylineOf(e.id);

	const rows = [];
	for (const [cond, yawKnown, gravKnown] of CONDS) {
		const opts = conditionOptions(yawKnown, gravKnown);
		const prior = poseToCamera(
			{
				yaw: yawKnown ? e.headingDeg : 0,
				pitch: gravKnown ? e.pitchDeg : 0,
				roll: gravKnown ? e.rollDeg : 0,
				vfov: e.vfovDeg,
			},
			e.width,
			e.height,
		);
		// the options solveOnce itself receives
		const once = yawKnown ? opts : fullSearchOptions(opts);
		const plan = planCoarse(prior, horizon, sky, once);
		let t = performance.now();
		const sp = solvePose(prior, horizon, sky, opts);
		const solveMs = performance.now() - t;
		if (!plan) {
			rows.push({ cond, noSkyline: true, solveReject: sp.rejectReason });
			continue;
		}
		t = performance.now();
		const cpu = coarseCpu(plan);
		const cpuMs = performance.now() - t;
		const gpuRuns = [];
		let gpuSame = true;
		let gpu = null;
		for (let r = 0; r < reps; r++) {
			gpu = await coarseGpu(device, plan);
			gpuSame &&= same(gpu, cpu);
			gpuRuns.push({
				ms: gpu.ms,
				uploadMs: gpu.stats.uploadMs,
				gpuMs: gpu.stats.gpuMs,
				selectMs: gpu.stats.selectMs,
			});
		}
		const g = gpu as NonNullable<typeof gpu>;
		// stress: ε × STRESS makes the selection decide far more from exact re-scores (same result)
		const stress = await coarseGpu(device, plan, { epsScale: STRESS });
		// old single-dispatch path vs the command-graph path (./graph.ts): result, per-row intervals
		// (digest of g / band from / to) and every non-timing stat must be identical; alternate the two
		// so both see the same warm state; median warm times.
		const sameStats = (a: CoarseGpuStats, b: CoarseGpuStats) =>
			a.rescored === b.rescored &&
			a.rescoredCells === b.rescoredCells &&
			a.eps === b.eps &&
			a.maxErr === b.maxErr &&
			a.fellBack === b.fellBack &&
			a.nCells === b.nCells &&
			a.digest === b.digest;
		const cmp = {
			same: true,
			sameStress: true,
			oldMs: [] as number[],
			graphMs: [] as number[],
			hzUploads: [] as boolean[],
			graphFellBack: 0,
			oldReadBytes: 0,
			graphReadBytes: 0,
			digest: "",
		};
		for (let r = 0; r < Math.max(reps, 5); r++) {
			const a = await coarseGpu(device, plan, { digest: true });
			const b = await coarseGpu(device, plan, { digest: true, graph: true });
			cmp.same &&= same(a, b) && same(b, cpu) && sameStats(a.stats, b.stats);
			cmp.oldMs.push(a.ms);
			cmp.graphMs.push(b.ms);
			cmp.hzUploads.push(!!b.stats.hzUploaded);
			if (b.stats.graphFellBack) cmp.graphFellBack++;
			cmp.oldReadBytes = a.stats.readBytes;
			cmp.graphReadBytes = b.stats.readBytes;
			cmp.digest = b.stats.digest ?? "";
		}
		{
			const a = await coarseGpu(device, plan, {
				digest: true,
				epsScale: STRESS,
			});
			const b = await coarseGpu(device, plan, {
				digest: true,
				epsScale: STRESS,
				graph: true,
			});
			cmp.sameStress = same(a, b) && sameStats(a.stats, b.stats);
		}
		const med = (x: number[]) =>
			[...x].sort((p, q) => p - q)[Math.floor(x.length / 2)];
		rows.push({
			cond,
			nYaw: plan.dys.length,
			nPitch: plan.dps.length,
			nObs: plan.az.length,
			cells: plan.dys.length * plan.dps.length,
			// the twin is solveOnce's coarse stage (checked on what SolveResult exposes)
			twinVsSolvePose:
				sp.coarse.yaw === cpu.coarse.yaw &&
				sp.coarse.pitch === cpu.coarse.pitch &&
				sp.ambiguity === cpu.ambiguity,
			gpuVsCpu: gpuSame,
			stressSame: same(stress, cpu),
			stressRescored: stress.stats.rescored,
			stressCells: stress.stats.rescoredCells,
			fellBack: g.stats.fellBack,
			coarse: cpu.coarse,
			ambiguity: cpu.ambiguity,
			seeds: cpu.seeds.length,
			rescored: g.stats.rescored,
			rescoredCells: g.stats.rescoredCells,
			eps: g.stats.eps,
			maxErr: g.stats.maxErr,
			readBytes: g.stats.readBytes,
			solvePoseMs: solveMs,
			gridCpuMs: cpuMs,
			gridFraction: cpuMs / solveMs,
			gpu: gpuRuns,
			graph: {
				same: cmp.same,
				sameStress: cmp.sameStress,
				digest: cmp.digest,
				graphFellBack: cmp.graphFellBack,
				hzUploads: cmp.hzUploads,
				oldReadBytes: cmp.oldReadBytes,
				graphReadBytes: cmp.graphReadBytes,
				oldMedMs: med(cmp.oldMs),
				graphMedMs: med(cmp.graphMs),
			},
			solveConfidence: sp.confidence,
			solveAccepted: sp.accepted,
		});
	}
	return { id: e.id, sceneMs, warmMs, skyWidth: sky.width, rows };
}

/**
 * The GPU row fold (./graph.ts FOLD) against the single-dispatch path's CPU fold on adversarial blocks:
 * NaN / ±inf / ±0 minima, empty bands (first > last), and block minima within a few ulps of the f64
 * threshold g + 2ε. Every row must either match the CPU fold bit for bit (g bits incl. the sign of 0,
 * band from / to) or carry the "too close" flag (which makes the graph path rerun the old path); a
 * NaN block must set the NaN flag. Also runs the fold graph twice with different data (stale transients).
 */
export async function benchFold(nYaw = 20000, nBlk = 3) {
	const device = await getComputeDevice();
	if (!device) return { error: "no WebGPU device" };
	const { ComputeGraph } = await import("../core/graph");
	const { K_FOLD } = await import("./graph");
	const { Buffer } = await import("@luma.gl/core");
	type P = { n: number };
	const g = new ComputeGraph<P>(device, "solve-fold-bench");
	const fu = g.importBuffer(
		"fu",
		16,
		undefined,
		Buffer.UNIFORM | Buffer.COPY_DST,
	);
	const blocks = g.importBuffer("blocks", nYaw * nBlk * 16);
	const rows = g.transientBuffer("rows", nYaw * 16);
	g.clearNode("clear-rows", { buffer: rows, size: (p) => p.n * 16 });
	g.addKernel({
		id: "fold",
		spec: K_FOLD,
		bindings: { fu, blocks, rows },
		workgroups: (p) => [Math.ceil(p.n / 64)],
		writes: { rows: "partial" },
	});
	g.readNode("rows", [{ buffer: rows, size: (p) => p.n * 16 }]);
	g.compile();
	const f32 = new Float32Array(1);
	const u32 = new Uint32Array(f32.buffer);
	const bitsOf = (x: number) => ((f32[0] = x), u32[0]);
	const ulp = (x: number, k: number) => {
		f32[0] = x;
		u32[0] += k;
		return f32[0];
	};
	let seed = 12345;
	const rnd = () =>
		(seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
	const runs = [];
	let ok = true;
	for (const [rep, n, eps] of [
		[0, nYaw, 3.7e-5],
		[1, Math.floor(nYaw * 0.7), 1.1e-3],
	] as const) {
		const nPitch = nBlk * 256;
		const buf = new ArrayBuffer(nYaw * nBlk * 16);
		const bu = new Uint32Array(buf);
		const bf = new Float32Array(buf);
		for (let r = 0; r < n; r++) {
			const kind = r % 11;
			const base = kind === 0 ? 0 : Math.fround(0.05 + 3 * rnd());
			for (let b = 0; b < nBlk; b++) {
				const o = (r * nBlk + b) * 4;
				let v: number;
				const t = rnd();
				if (kind === 1 && b === 1) v = Number.NaN;
				else if (kind === 2 && b === 2) v = Number.POSITIVE_INFINITY;
				else if (kind === 0)
					v = b === 0 ? -0 : b === 1 ? 0 : Math.fround(2 * eps * rnd());
				else if (b === 0) v = base;
				// near the threshold: base + 2ε, then ±0..6 ulps
				else if (t < 0.6)
					v = ulp(Math.fround(base + 2 * eps), Math.floor(rnd() * 13) - 6);
				else v = Math.fround(base + 4 * eps * rnd());
				bf[o] = v;
				const first = Math.floor(rnd() * nPitch);
				const last =
					rnd() < 0.1
						? first - 1
						: Math.min(nPitch - 1, first + Math.floor(rnd() * 20));
				// an empty band looks like the kernel's init: first = 0xffffffff > last = 0
				bu[o + 1] = last < 0 ? 0xffffffff : first;
				bu[o + 2] = last < 0 ? 0 : last;
			}
			// shuffle which block holds the minimum
			if (r % 3 === 1 && nBlk > 1) {
				const a = r * nBlk * 4;
				const c = (r * nBlk + nBlk - 1) * 4;
				for (let k = 0; k < 4; k++)
					[bu[a + k], bu[c + k]] = [bu[c + k], bu[a + k]];
			}
		}
		const fb = new ArrayBuffer(16);
		new Uint32Array(fb).set([n, nBlk, nPitch]);
		new Float32Array(fb)[3] = 2 * eps;
		const fuBuf = device.createBuffer({
			usage: Buffer.UNIFORM | Buffer.COPY_DST,
			byteLength: 16,
			data: new Uint8Array(fb),
		});
		const bBuf = device.createBuffer({
			usage: Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC,
			byteLength: buf.byteLength,
			data: new Uint8Array(buf),
		});
		const { reads } = await g.run(
			{ n },
			{ buffers: { fu: fuBuf, blocks: bBuf } },
		);
		fuBuf.destroy();
		bBuf.destroy();
		const ru = new Uint32Array(reads.rows[0]);
		let close = 0;
		let nan = 0;
		let bad = 0;
		let naiveWrong = 0;
		for (let r = 0; r < n; r++) {
			// the single-dispatch path's CPU fold (index.ts coarseOnce), verbatim semantics
			let m = Number.POSITIVE_INFINITY;
			for (let b = 0; b < nBlk; b++) m = Math.min(m, bf[(r * nBlk + b) * 4]);
			let from = nPitch;
			let to = -1;
			let naiveFrom = nPitch;
			let naiveTo = -1;
			const thr32 = Math.fround(m + Math.fround(2 * eps));
			for (let b = 0; b < nBlk; b++) {
				const o = (r * nBlk + b) * 4;
				if (bu[o + 1] > bu[o + 2]) continue;
				if (!(bf[o] > m + 2 * eps)) {
					from = Math.min(from, bu[o + 1]);
					to = Math.max(to, bu[o + 2]);
				}
				if (!(bf[o] > thr32)) {
					naiveFrom = Math.min(naiveFrom, bu[o + 1]);
					naiveTo = Math.max(naiveTo, bu[o + 2]);
				}
			}
			const flags = ru[r * 4 + 3];
			if (Number.isNaN(m)) {
				nan++;
				if (flags !== 1) bad++;
				continue;
			}
			const naiveDiffers = naiveFrom !== from || naiveTo !== to;
			if (naiveDiffers) naiveWrong++;
			if (flags & 2) {
				close++;
				continue;
			}
			const has = (flags & 4) !== 0;
			if (
				ru[r * 4] !== bitsOf(m) ||
				(has ? ru[r * 4 + 1] : nPitch) !== from ||
				(has ? ru[r * 4 + 2] : -1) !== to
			)
				bad++;
		}
		ok &&= bad === 0 && nan > 0 && close > 0;
		runs.push({ rep, n, eps, bad, nan, close, naiveWrong });
	}
	g.destroy();
	return { ok, runs };
}
