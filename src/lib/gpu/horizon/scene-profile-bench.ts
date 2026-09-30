/**
 * Browser bench + parity of sceneHorizonGpu (./scene-profile.ts) against the unknown-pose worker's CPU
 * 360° horizon (geo/pipeline sceneHorizon), on the worker's own scene (loadScene, Mapterhorn, plain
 * fetchDemTile). Loaded by scripts/gpu/unknown-horizon.mjs inside headless Chromium:
 *
 *   const { benchScene } = await import('/src/lib/gpu/horizon/scene-profile-bench.ts');
 *   await benchScene({ lat, lon, alt })
 *
 * Returns small JSON (no profiles).
 */
import { fetchDemTile, MAPTERHORN } from "#/lib/dem";
import type { HorizonProfile } from "#/lib/geo/horizon";
import { loadScene, sceneHorizon } from "#/lib/geo/pipeline";
import {
	computeHorizonFast,
	type FastHorizonProfile,
	mosaicsFromSampler,
} from "#/lib/horizon-fast/march";
import { parity } from "./bench";
import {
	releaseSceneHorizonGpu,
	type SceneHorizonGpuTiming,
	sceneHorizonGpu,
} from "./scene-profile";

const asFast = (h: HorizonProfile) => h as unknown as FastHorizonProfile;

export async function benchScene(a: {
	lat: number;
	lon: number;
	alt: number | null;
}) {
	const t0 = performance.now();
	const { terrain, eye } = await loadScene(
		a.lat,
		a.lon,
		a.alt,
		MAPTERHORN,
		(k) => fetchDemTile(MAPTERHORN, k).catch(() => undefined),
	);
	const loadMs = performance.now() - t0;
	const tiles = (terrain as unknown as { tiles: Map<string, unknown> }).tiles
		.size;

	const cpuRuns: number[] = [];
	let cpu: HorizonProfile | null = null;
	for (let r = 0; r < 2; r++) {
		const t = performance.now();
		cpu = await sceneHorizon(terrain, a.lat, a.lon, eye);
		cpuRuns.push(performance.now() - t);
	}
	const ref = cpu as HorizonProfile;

	// CPU twin of the GPU path: the same march, ridges off (what the GPU computes, in f64)
	const twin = computeHorizonFast(
		mosaicsFromSampler(terrain, a.lat, a.lon, 150_000),
		{ lat: a.lat, lon: a.lon, h: eye },
		{ noRidges: true },
	);
	let twinDiff = 0;
	for (let i = 0; i < ref.elevation.length; i++)
		if (
			twin.elevation[i] !== ref.elevation[i] ||
			twin.distance[i] !== ref.distance[i]
		)
			twinDiff++;

	const gpuRuns: SceneHorizonGpuTiming[] = [];
	let gpu: HorizonProfile | null = null;
	// First run as the app does it (build, march, free); runs 2-3 keep the scene (the cached path).
	for (let r = 0; r < 3; r++) {
		gpu = await sceneHorizonGpu(
			terrain,
			a.lat,
			a.lon,
			eye,
			(t) => gpuRuns.push(t),
			{ keep: r > 0 },
		);
		if (!gpu) break;
	}
	releaseSceneHorizonGpu();
	return {
		eye,
		tiles,
		loadMs,
		cpuMs: cpuRuns,
		gpuMs: gpuRuns,
		twinBitDiff: twinDiff,
		n: ref.elevation.length,
		ridgesCpu: ref.ridges.reduce((s, r) => s + r.length, 0),
		parity: gpu ? parity(asFast(ref), asFast(gpu)) : null,
	};
}
