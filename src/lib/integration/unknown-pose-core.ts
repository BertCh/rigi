// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * The unknown-pose cascade without its worker shell (unknown-pose.worker.ts keeps the messages, the
 * horizon cache and the browser tile loader). Split out on 2026-10-01 so node checks run the very same
 * scene + solve code as the app: scripts/gpu/unknown-gpu-node.ts drives it on a Dawn WebGPU device for
 * the ?unknownGpu gate (CPU sceneHorizon vs the GPU march).
 */
import {
	cameraToPose,
	poseToCamera,
	vfovFromFocal,
	vfovFromHfov,
} from "#/lib/camera";
import { type DemSource, MAPTERHORN } from "#/lib/dem";
import { getFlag } from "#/lib/flags";
import type { HorizonProfile } from "#/lib/geo/horizon";
import {
	type CascadeOptions,
	type cascade,
	cascadeAsync,
	loadScene,
	sceneHorizon,
} from "#/lib/geo/pipeline";
import { detectSkylineAsync, type SkylineObservation } from "#/lib/geo/skyline";
import type { CoarseProvider, SolveOptions } from "#/lib/geo/solve";
import type { TileLoader } from "#/lib/geo/terrain";
import { solveCoarse } from "#/lib/gpu/solve";
import type { RefineOptions } from "#/lib/refine/index";
import type { InitOptions } from "#/lib/refine/init";
import { DEFAULT_PRIOR_SIGMA } from "#/lib/refine/robust";
import type {
	UnknownPosePrepare,
	UnknownPoseRequest,
	UnknownPoseResult,
} from "./unknown-pose";

/** Accept threshold when the focal length is unknown (see the ambiguity check in solve()). */
const FOCAL_UNKNOWN_MIN_CONFIDENCE = 0.75;
/**
 * Accept threshold for the 360° search when the heading is unknown: solvePose's own full-360° fallback
 * demands 0.75 (geo/solve.ts fullSearchConfidence), the 0.5 default is for a ±yawRange search around a
 * compass. Mapterhorn strip ablation (reports/bench-ablation.md): IMG_7053 without heading was accepted
 * at 0.66, 124° off.
 */
const YAW_UNKNOWN_MIN_CONFIDENCE = 0.75;
/**
 * A non-best focal seed that only accepted through `refinePose` (its solve stage rejected) counts as an
 * alternative accepted fit in the `ambiguous` test only when its solve stage reached this confidence.
 * refinePose from a wrong-focal prior is chaotic at the 1e-5..1e-4 px level of skyline-row noise
 * (research_notes/wave5/skyline-gpu-flip.md: GT-12 IMG_6958 none+nofocal, solve 0.065 -> refine accept
 * 0.70 flips with 1e-4 px row noise), so its accept is noise, not evidence of a second fit. 0.25 is half
 * of solvePose's 0.5 acceptConfidence default (geo/solve.ts): below it the solve stage found no
 * skyline fit worth a veto, and the observed noise-flipped seeds sat at 0.065..0.07.
 */
export const SEED_REFINE_MIN_SOLVE_CONFIDENCE = 0.25;
/** Most cascade candidates returned as matcher seeds (3 focal seeds × solve/refine = up to 6). */
const MAX_CANDIDATES = 4;

/** Solver options with the unknowns freed (same as tools/bench/harness/cascade.ts "configured"). */
export function options(yawKnown: boolean, gravKnown: boolean) {
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

/**
 * The fused horizon → solve chain (gpu/solve/fused.ts): only with the GPU horizon and the GPU coarse
 * grid. The default there (identical by construction: same kernels, the resident profile is
 * bit-checked on every coarse call); gpuFused: false opts out.
 */
export const fusedFor = (m: UnknownPosePrepare | UnknownPoseRequest) =>
	!!m.gpu && !!m.solveGpu && m.gpuFused !== false;

/**
 * Mapterhorn is the DEM the app engine (src/lib/dem) draws with, so the cascade solves on the same
 * terrain the overlay shows.
 */
export const UNKNOWN_POSE_DEM: DemSource = MAPTERHORN;

/** The 360° scene at the camera: its horizon, the eye height and where the horizon was marched. */
export type UnknownScene = {
	horizon: HorizonProfile;
	eye: number;
	horizonOn: "gpu" | "cpu";
};

/**
 * Load the 360° terrain through `loadTile` and march its horizon: on the GPU when `gpu` (fused with the
 * solve's resident profile when `fused`), the CPU sceneHorizon otherwise and whenever the GPU cannot serve.
 */
export async function computeUnknownScene(
	lat: number,
	lon: number,
	alt: number | null,
	loadTile: TileLoader,
	gpu = false,
	fused = false,
): Promise<UnknownScene> {
	const DEM = UNKNOWN_POSE_DEM;
	const { terrain, eye } = await loadScene(lat, lon, alt, DEM, loadTile);
	// fused (gpu/solve/fused.ts): the march on its command graph, then the solve's resident profile
	// primed with the same bits; the CPU sceneHorizon below when the GPU cannot serve
	if (gpu && fused) {
		const { fusedSceneHorizon } = await import("#/lib/gpu/solve/fused");
		const f = await fusedSceneHorizon(terrain, lat, lon, eye);
		if (f) return { horizon: f.horizon, eye, horizonOn: "gpu" as const };
	}
	// unknownGpuOptIn (page side) without the fused chain: the same march on the GPU; null → the CPU sceneHorizon below.
	// Not after a failed fused march: that is the same march, so straight to the CPU
	else if (gpu) {
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

type SeedFit = UnknownPoseResult["seeds"][number];

/**
 * Unknown focal: does the skyline fit more than one field of view (or fit only weakly)? True when another
 * focal seed also accepts more than 1 deg of yaw away from the best seed, or the best confidence is under
 * FOCAL_UNKNOWN_MIN_CONFIDENCE. A seed whose accept came only from `refinePose` after a solve stage under
 * SEED_REFINE_MIN_SOLVE_CONFIDENCE is ignored (chaotic, see that constant). The best seed itself is never
 * filtered: it decides `accepted` first. This only ever removes vetoes from refine-only seeds with no
 * solve-stage support.
 */
export function isAmbiguousFocal(
	seeds: readonly SeedFit[],
	best: { camera: { yaw: number }; confidence: number },
	skipUnstableRefine = true,
): boolean {
	return (
		seeds.some(
			(s) =>
				s.accepted &&
				Math.abs(((s.yaw - best.camera.yaw + 540) % 360) - 180) > 1 &&
				(!skipUnstableRefine ||
					s.stage === "solve" ||
					s.solveConfidence >= SEED_REFINE_MIN_SOLVE_CONFIDENCE),
		) || best.confidence < FOCAL_UNKNOWN_MIN_CONFIDENCE
	);
}

/** The cascade for one request on the scene `sceneOf` resolves (the worker's cached horizonAt). */
export async function solveUnknownPose(
	req: UnknownPoseRequest,
	sceneOf: () => Promise<UnknownScene>,
	/** test seam: rewrite the detected skyline before the cascade (noise-injection checks) */
	mapSkyline?: (sky: SkylineObservation) => SkylineObservation,
): Promise<UnknownPoseResult> {
	const t0 = performance.now();
	const { horizon, horizonOn } = await sceneOf();
	const tHorizon = performance.now() - t0;
	const detected = await detectSkylineAsync(req.image);
	const sky = mapSkyline ? mapSkyline(detected) : detected;
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
		? async (prior, horizon, sky, o) => {
				const r = await solveCoarse(prior, horizon, sky, o);
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
			solveConfidence: r.candidates[0].confidence,
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
		isAmbiguousFocal(seeds, b, getFlag("focalSeedGate") === "on");
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
