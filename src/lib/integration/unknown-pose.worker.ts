/// <reference lib="webworker" />
/**
 * 0f's CPU cascade (solvePose → refinePose on reject) for photos with unknown heading / gravity /
 * focal, with the unknowns declared through the solvers' public options (reports/bench-ablation.md,
 * "cascade (unknowns via options)": 0 false accepts in all four ablation conditions).
 * Loads its own 360° Mapterhorn terrain + horizon (the DEM the app engine draws with).
 */
import {
	cameraToPose,
	poseToCamera,
	vfovFromFocal,
	vfovFromHfov,
} from "#/lib/camera";
import { fetchDemTileCached, MAPTERHORN, type TileKey } from "#/lib/dem";
import type { HorizonProfile } from "#/lib/geo/horizon";
import {
	type CascadeOptions,
	type cascade,
	cascadeAsync,
	loadScene,
	sceneHorizon,
} from "#/lib/geo/pipeline";
import { detectSkyline } from "#/lib/geo/skyline";
import type { CoarseProvider, SolveOptions } from "#/lib/geo/solve";
import { applyRealmGpuOptions, takeGpuProfile } from "#/lib/gpu/core/realm";
import { getComputeDevice, releaseWhenIdle } from "#/lib/gpu/device";
import { solveCoarse, warmSolveGpu } from "#/lib/gpu/solve";
import type { RefineOptions } from "#/lib/refine/index";
import type { InitOptions } from "#/lib/refine/init";
import { DEFAULT_PRIOR_SIGMA } from "#/lib/refine/robust";
import type {
	UnknownPosePrepare,
	UnknownPoseRequest,
	UnknownPoseResponse,
	UnknownPoseResult,
} from "./unknown-pose";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
/**
 * This worker lives as long as the photo (re-runs reuse its horizon) but uses the GPU in bursts:
 * destroy the WebGPU device after this long without GPU use; the next solve recreates it.
 */
const GPU_IDLE_MS = 30_000;
releaseWhenIdle(GPU_IDLE_MS);
/** Accept threshold when the focal length is unknown (see the ambiguity check in solve()). */
const FOCAL_UNKNOWN_MIN_CONFIDENCE = 0.75;
/**
 * Accept threshold for the 360° search when the heading is unknown: solvePose's own full-360° fallback
 * demands 0.75 (geo/solve.ts fullSearchConfidence), the 0.5 default is for a ±yawRange search around a
 * compass. Mapterhorn strip ablation (reports/bench-ablation.md): IMG_7053 without heading was accepted
 * at 0.66, 124° off.
 */
const YAW_UNKNOWN_MIN_CONFIDENCE = 0.75;
/** Most cascade candidates returned as matcher seeds (3 focal seeds × solve/refine = up to 6). */
const MAX_CANDIDATES = 4;

/** Solver options with the unknowns freed (same as tools/bench/harness/cascade.ts "configured"). */
function options(yawKnown: boolean, gravKnown: boolean) {
	const sOpts: SolveOptions = {};
	const sigma = { yaw: 15, pitch: 1.5, roll: 1.5, focal: 0.06 };
	const init: Partial<InitOptions> = {};
	const prior = { ...DEFAULT_PRIOR_SIGMA };
	if (!gravKnown) {
		sOpts.pitchRange = 15;
		sOpts.tiltGate = 90;
		sigma.pitch = 10;
		sigma.roll = 10;
		init.pitchSigmaDeg = 10;
		init.rollSigmaDeg = 10;
		prior.pitchDeg = 10;
		prior.rollDeg = 10;
	}
	if (!yawKnown) {
		// direct 360° pass at solvePose's full-search bar (0.75); YAW_UNKNOWN_MIN_CONFIDENCE below also covers refine
		sOpts.headingKnown = false;
		sOpts.yawRange = 180;
		sOpts.fullSearchFallback = false;
		sigma.yaw = 1e6;
		init.yawRange = 180;
		init.yawSigmaDeg = 1e6;
		prior.yawDeg = 1e6;
	}
	sOpts.sigma = sigma;
	return {
		solve: sOpts,
		refine: { init, robust: { priorSigma: prior } } as RefineOptions,
	};
}

let horizonCache: {
	key: string;
	promise: Promise<{
		horizon: HorizonProfile;
		eye: number;
		horizonOn: "gpu" | "cpu";
	}>;
} | null = null;

/** 360° horizon at the camera, computed once per position (the 'prepare' message starts it early). */
function horizonAt(lat: number, lon: number, alt: number | null, gpu = false) {
	const key = `${lat.toFixed(6)},${lon.toFixed(6)},${alt ?? ""},${gpu ? "gpu" : ""}`;
	if (horizonCache?.key !== key) {
		const promise = computeScene(lat, lon, alt, gpu);
		promise.catch(() => {
			if (horizonCache?.promise === promise) horizonCache = null;
		});
		horizonCache = { key, promise };
	}
	return horizonCache.promise;
}

/**
 * The whole 360° DEM load must finish within this (Terrarium was ~205 tiles, ~28 MB cold);
 * a stalled network otherwise hangs the solve forever (the upload overlay, item 05's export lock).
 * Cold loads measured 3–77 s.
 */
const SCENE_TIMEOUT_MS = 90_000;

/**
 * Mapterhorn is the DEM the app engine (src/lib/terrain.ts) draws with, so the cascade solves on the same
 * terrain the overlay shows. Tiles come through the page's shared tile cache (dem's fetchDemTileCached;
 * this worker gets a read-only view of the same store), so tiles the page loaded cost no request; the
 * rest are fetched through the HTTP cache. Abortable.
 */
const DEM = MAPTERHORN;

async function computeScene(
	lat: number,
	lon: number,
	alt: number | null,
	gpu = false,
) {
	const signal = AbortSignal.timeout(SCENE_TIMEOUT_MS);
	// a failed tile stays a hole (ocean, 404) as before, but a timeout fails the scene: a horizon with
	// holes could be accepted at a wrong pose. horizonAt drops the failed promise, so a re-run retries.
	const loadTile = (k: TileKey) => {
		if (signal.aborted) return Promise.reject(signal.reason);
		return fetchDemTileCached(DEM, k, signal).catch(() => {
			if (signal.aborted)
				throw new Error(
					`terrain tiles timed out after ${SCENE_TIMEOUT_MS / 1000} s`,
				);
			return undefined;
		});
	};
	const { terrain, eye } = await loadScene(lat, lon, alt, DEM, loadTile);
	// opt-in (unknownGpuOptIn, page side): the same march on the GPU; null → the CPU sceneHorizon below
	if (gpu) {
		const { sceneHorizonGpu } = await import("#/lib/gpu/horizon/scene-profile");
		const horizon = await sceneHorizonGpu(terrain, lat, lon, eye);
		if (horizon) return { horizon, eye, horizonOn: "gpu" as const };
	}
	return {
		horizon: await sceneHorizon(terrain, lat, lon, eye),
		eye,
		horizonOn: "cpu" as const,
	};
}

async function solve(req: UnknownPoseRequest): Promise<UnknownPoseResult> {
	const t0 = performance.now();
	const { horizon, horizonOn } = await horizonAt(
		req.lat,
		req.lon,
		req.alt,
		req.gpu,
	);
	const tHorizon = performance.now() - t0;
	const sky = detectSkyline(req.image);
	const yawKnown = !req.unknown.yaw;
	const gravKnown = !req.unknown.gravity;
	// everything known (second opinion on the app's autoAlign, second-opinion.ts): 0f's recommended
	// default exactly, i.e. the cascade with default options (leaderboard "CPU classic+cascade")
	const allKnown = yawKnown && gravKnown && !req.unknown.focal;
	// gpsAccuracy goes to refinePose even when everything is known
	const opts: CascadeOptions = {
		...(allKnown ? { solve: {} } : options(yawKnown, gravKnown)),
		gpsAccuracy: req.gpsAccuracy ?? undefined,
	};
	const cam = (vfov: number) =>
		poseToCamera(
			{
				yaw: req.prior.yaw,
				pitch: gravKnown ? req.prior.pitch : 0,
				roll: gravKnown ? req.prior.roll : 0,
				vfov,
			},
			req.width,
			req.height,
		);
	const vfovs = req.unknown.focal
		? [40, 50, 65].map((h) => vfovFromHfov(h, req.width, req.height))
		: [req.prior.vfov];
	// solvePose's coarse grid on the GPU when the page allows it (identical by construction)
	const on = new Set<"gpu" | "cpu">();
	const coarse: CoarseProvider | undefined = req.solveGpu
		? async (...a) => {
				const r = await solveCoarse(...a);
				if (r) on.add(r.on);
				return r;
			}
		: undefined;
	let best: ReturnType<typeof cascade> | null = null;
	const seeds: UnknownPoseResult["seeds"] = [];
	const runs: ReturnType<typeof cascade>[] = [];
	for (const v of vfovs) {
		const r = await cascadeAsync(cam(v), horizon, sky, opts, coarse);
		runs.push(r);
		seeds.push({
			vfov: v,
			yaw: r.camera.yaw,
			solvedVfov: vfovFromFocal(r.camera.f, r.camera.height),
			confidence: r.confidence,
			accepted: r.accepted,
			stage: r.stage,
		});
		if (
			!best ||
			Number(r.accepted) > Number(best.accepted) ||
			(r.accepted === best.accepted && r.confidence > best.confidence)
		)
			best = r;
	}
	const b = best as NonNullable<typeof best>;
	// Unknown focal: two focal seeds that both accept at different yaws mean the skyline fits more than
	// one field of view (IMG_7068 with nothing known: 66° and 78° vfov both accepted, 1.6° apart). Ambiguous.
	// And a wrong focal seed can accept at a middling confidence (IMG_7053 focal-only: 0.68 at 40° vfov,
	// 4° off; a correct one scored 0.66): like solvePose's 360° fallback, demand ≥ 0.75 then.
	const ambiguous =
		req.unknown.focal &&
		(seeds.some(
			(s) =>
				s.accepted && Math.abs(((s.yaw - b.camera.yaw + 540) % 360) - 180) > 1,
		) ||
			b.confidence < FOCAL_UNKNOWN_MIN_CONFIDENCE);
	const weak360 = req.unknown.yaw && b.confidence < YAW_UNKNOWN_MIN_CONFIDENCE;
	// matcher seeds: the chosen focal seed's stages first, then the other focal seeds'. Each wrong seed costs
	// a local render + match on the server, so drop near-duplicates and cap the count.
	const candidates: UnknownPoseResult["candidates"] = [];
	for (const c of [b, ...runs.filter((r) => r !== b)].flatMap(
		(r) => r.candidates,
	)) {
		const pose = cameraToPose(c.camera);
		const dup = candidates.some(
			(o) =>
				Math.abs(((o.pose.yaw - pose.yaw + 540) % 360) - 180) < 1 &&
				Math.abs(o.pose.pitch - pose.pitch) < 1 &&
				Math.abs(o.pose.vfov - pose.vfov) < 3,
		);
		if (!dup && candidates.length < MAX_CANDIDATES)
			candidates.push({
				pose,
				confidence: c.confidence,
				stage: c.stage,
				accepted: c.accepted,
			});
	}
	return {
		pose: cameraToPose(b.camera),
		candidates,
		confidence: b.confidence,
		accepted: b.accepted && !ambiguous && !weak360,
		stage: b.stage,
		seeds,
		ms: {
			horizon: Math.round(tHorizon),
			total: Math.round(performance.now() - t0),
		},
		horizonOn,
		solveOn: on.size === 2 ? "mixed" : on.has("gpu") ? "gpu" : "cpu",
	};
}

ctx.onmessage = async (
	ev: MessageEvent<UnknownPoseRequest | UnknownPosePrepare>,
) => {
	applyRealmGpuOptions(ev.data.gpuOpts);
	if (ev.data.type === "prepare") {
		horizonAt(ev.data.lat, ev.data.lon, ev.data.alt, ev.data.gpu).catch(
			() => {},
		);
		if (ev.data.solveGpu)
			getComputeDevice()
				.then((d) => d && warmSolveGpu(d))
				.catch(() => {});
		return;
	}
	let msg: UnknownPoseResponse;
	try {
		msg = { id: ev.data.id, ok: true, result: await solve(ev.data) };
	} catch (e) {
		msg = {
			id: ev.data.id,
			ok: false,
			error: e instanceof Error ? e.message : String(e),
		};
	}
	// profiling only (undefined, nothing awaited, when the page does not profile)
	const prof = takeGpuProfile();
	if (prof) msg.gpuProfile = await prof;
	ctx.postMessage(msg);
};
