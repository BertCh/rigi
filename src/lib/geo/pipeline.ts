// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Core shared by the /baseline and unknown-pose workers: DEM → terrain → eye → 360° horizon, and the
 * solvePose → refinePose cascade. Policy (DEM, tile loader, timeouts, solver options) stays with the caller.
 */
import type { DemSource } from "../dem";
import { type RefineOptions, refinePose } from "../refine/index";
import type { Camera } from "./camera";
import { computeHorizon, type HorizonProfile } from "./horizon";
import type { SkylineObservation } from "./skyline";
import {
	type CoarseProvider,
	type SkylineSolveResult,
	type SolveOptions,
	solvePose,
	solvePoseAsync,
} from "./solve";
import { loadTerrain, type TerrainSampler, type TileLoader } from "./terrain";

export const EYE_ABOVE_GROUND = 1.6;

/** Terrain from `dem` around (lat, lon); eye = GPS altitude, but at least 1.6 m above ground. */
export async function loadScene(
	lat: number,
	lon: number,
	alt: number | null | undefined,
	dem: DemSource,
	loadTile: TileLoader,
	tiles = new Map<string, Float32Array>(),
) {
	const terrain = await loadTerrain(
		lat,
		lon,
		loadTile,
		dem.levels,
		tiles,
		16,
		dem.tileSize,
	);
	const ground = terrain.sample(lon, lat, dem.levels[0].z);
	if (!Number.isFinite(ground))
		throw new Error("No DEM data at this location (tiles failed to load?)");
	return {
		terrain,
		ground,
		eye: Math.max(alt ?? ground, ground + EYE_ABOVE_GROUND),
	};
}

/** horizon-fast's drop-in (same accuracy in scripts/eval.ts); the classic ray-march is the fallback. */
export async function sceneHorizon(
	terrain: TerrainSampler,
	lat: number,
	lon: number,
	eye: number,
): Promise<HorizonProfile> {
	try {
		// `return await`: the fallback must also catch a rejection, should the march become async
		return await (
			await import("../horizon-fast/march")
		).computeHorizonFastCompat(terrain, lat, lon, eye);
	} catch (e) {
		console.warn("[pipeline] horizon-fast failed, using computeHorizon", e);
		return computeHorizon(terrain, lat, lon, eye);
	}
}

export type CascadeOptions = {
	solve?: SolveOptions;
	refine?: RefineOptions;
	gpsAccuracy?: number;
};
/** The cascade tier that produced a pose: solvePose, or refinePose after solve rejects. */
export type CascadeStage = "solve" | "refine";

/**
 * solvePose, escalating a reject to refinePose. Returns the first accepting stage, else solvePose's
 * (with no heading, refine's rejected pose can be 130–175° off), plus every stage that ran as
 * `candidates`. scripts/eval.ts SOLVER=cascade and tools/bench/harness/cascade.ts keep their own
 * copies of this rule; __tests__/pipeline-escalate.spec.ts pins this one. Refine accepts at its own
 * 0.5 bar: a caller with no heading or focal must apply the 0.75 bar itself (unknown-pose-core.ts,
 * src/baseline-ui/align-options.ts).
 */
export function cascade(
	prior: Camera,
	horizon: HorizonProfile,
	sky: SkylineObservation,
	o: CascadeOptions = {},
) {
	return escalate(
		solvePose(prior, horizon, sky, o.solve),
		prior,
		horizon,
		sky,
		o,
	);
}

/** cascade with solvePose's coarse grid from `coarse` (the GPU grid, src/lib/gpu/solve); refine stays on the CPU. */
export async function cascadeAsync(
	prior: Camera,
	horizon: HorizonProfile,
	sky: SkylineObservation,
	o: CascadeOptions = {},
	coarse?: CoarseProvider,
) {
	const s = await solvePoseAsync(prior, horizon, sky, o.solve, coarse);
	return escalate(s, prior, horizon, sky, o);
}

function escalate(
	s: SkylineSolveResult,
	prior: Camera,
	horizon: HorizonProfile,
	sky: SkylineObservation,
	o: CascadeOptions,
) {
	const { camera, confidence, accepted, residualPx, rejectReason } = s;
	const solve = {
		stage: "solve" as CascadeStage,
		camera,
		confidence,
		accepted,
		residualPx,
		rejectReason,
	};
	if (accepted) return { ...solve, candidates: [solve] };
	const r = refinePose({
		camera: prior,
		horizon,
		skyline: sky,
		gpsAccuracy: o.gpsAccuracy,
		options: o.refine,
	});
	const refine = {
		stage: "refine" as CascadeStage,
		camera: r.camera,
		confidence: r.confidence.score,
		accepted: r.confidence.accept,
		residualPx: Number.NaN,
		rejectReason: undefined,
	};
	return { ...(refine.accepted ? refine : solve), candidates: [solve, refine] };
}
