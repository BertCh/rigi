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
			solveConfidence: sp.confidence,
			solveAccepted: sp.accepted,
		});
	}
	return { id: e.id, sceneMs, warmMs, skyWidth: sky.width, rows };
}
