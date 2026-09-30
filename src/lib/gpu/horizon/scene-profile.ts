/**
 * The unknown-pose worker's 360° horizon (geo/pipeline sceneHorizon) on the GPU horizon kernel.
 *
 * sceneHorizon is horizon-fast's CPU march (computeHorizonFastCompat) over mosaicsFromSampler(terrain):
 * one mosaic per geo DEM level (Mapterhorn z15 to 1 km … z9 to 150 km), 0.05° azimuth step, 150 km. This
 * builds the very same mosaics and marches them with computeHorizonGpu, so the GPU sees the same rings,
 * range and resolution as the CPU reference; differences are the kernel's f32 rounding only.
 *
 * Ridges: the GPU records none (see ./index.ts). The cascade (geo/solve solvePose, refine/refinePose) reads
 * only `step`, `elevation` and `distance`, so the profile carries one empty ridge list per azimuth.
 *
 * Opt-in only: unknownGpuOptIn() (./unknown-opt-in.ts, page side; the worker gets the answer in its messages). The CPU
 * sceneHorizon stays the default and the fallback (null here → the caller uses it).
 *
 * Mosaic cache (opt-in, `keep`): by default the mosaics are built per call and their VRAM is freed
 * right after the march (the app worker builds a fresh terrain per scene, so nothing could hit a
 * cache). With `keep: true` the mosaics (CPU build) and their GPU pages are kept for the last
 * MAX_SCENES scenes, keyed on the terrain sampler's identity plus (lat, lon, tile count), so marching
 * the same terrain again (the bench's repeat runs) skips both the build and the upload. An evicted,
 * garbage-collected or device-lost scene releases its pages; releaseSceneHorizonGpu frees them all.
 */
import type { Device } from "@luma.gl/core";
import type { HorizonProfile } from "#/lib/geo/horizon";
import type { TerrainSampler } from "#/lib/geo/terrain";
import { mosaicsFromSampler } from "#/lib/horizon-fast/march";
import type { Mosaic } from "#/lib/horizon-fast/mosaic";
import { getComputeDevice } from "../device";
import { computeHorizonGpu, releaseHorizonGpu } from "./index";

/** sceneHorizon's defaults (geo/horizon.ts computeHorizon / horizon-fast march). */
const MAX_DISTANCE = 150_000;
const STEP = 0.05;

export interface SceneHorizonGpuTiming {
	mosaicMs: number;
	gpuMs: number;
	totalMs: number;
}

/** Scenes whose mosaics (and GPU pages) are kept. Each is tens of MB of CPU + VRAM. */
const MAX_SCENES = 2;

interface SceneEntry {
	terrain: WeakRef<TerrainSampler>;
	key: string;
	mosaics: Mosaic[];
}

/** Most recently used last. */
const scenes: SceneEntry[] = [];
// a terrain dropped by its owner frees its scene's VRAM without waiting for eviction
const finalizer = new FinalizationRegistry<SceneEntry>((e) => dropScene(e));
const watched = new WeakSet<Device>();

function dropScene(e: SceneEntry) {
	const i = scenes.indexOf(e);
	if (i >= 0) scenes.splice(i, 1);
	releaseHorizonGpu(e.mosaics);
}

const tileCount = (terrain: TerrainSampler) =>
	(terrain as unknown as { tiles?: Map<string, unknown> }).tiles?.size ?? -1;

/** The scene's mosaics, built once per (terrain, lat, lon) and kept for the last MAX_SCENES scenes (`keep`). */
function sceneMosaics(
	device: Device,
	terrain: TerrainSampler,
	lat: number,
	lon: number,
): Mosaic[] {
	if (!watched.has(device)) {
		watched.add(device);
		// a lost device took the pages with it; drop the CPU mosaics too
		device.lost.then(() => {
			for (const e of [...scenes]) dropScene(e);
		});
	}
	const key = `${lat},${lon},${MAX_DISTANCE},${tileCount(terrain)}`;
	for (let i = scenes.length - 1; i >= 0; i--) {
		const e = scenes[i];
		const t = e.terrain.deref();
		if (!t) {
			dropScene(e);
			continue;
		}
		if (t === terrain && e.key === key) {
			scenes.splice(i, 1);
			scenes.push(e);
			return e.mosaics;
		}
	}
	const e: SceneEntry = {
		terrain: new WeakRef(terrain),
		key,
		mosaics: mosaicsFromSampler(terrain, lat, lon, MAX_DISTANCE),
	};
	scenes.push(e);
	finalizer.register(terrain, e, e);
	while (scenes.length > MAX_SCENES) {
		const old = scenes[0];
		finalizer.unregister(old);
		dropScene(old);
	}
	return e.mosaics;
}

/** Frees every cached scene's mosaics and GPU pages. */
export function releaseSceneHorizonGpu() {
	for (const e of [...scenes]) {
		finalizer.unregister(e);
		dropScene(e);
	}
}

/**
 * sceneHorizon(terrain, lat, lon, eye) marched on the GPU, or null when there is no WebGPU device or the
 * kernel fails (the caller then runs the CPU sceneHorizon). Never throws. `opts.keep` caches the scene's
 * mosaics + GPU pages for a later call on the same terrain (see the header); otherwise they're freed now.
 */
export async function sceneHorizonGpu(
	terrain: TerrainSampler,
	lat: number,
	lon: number,
	eye: number,
	timing?: (t: SceneHorizonGpuTiming) => void,
	opts: { keep?: boolean } = {},
): Promise<HorizonProfile | null> {
	const t0 = performance.now();
	const device = await getComputeDevice();
	if (!device) return null;
	let once: Mosaic[] | null = null;
	try {
		if (!opts.keep) once = mosaicsFromSampler(terrain, lat, lon, MAX_DISTANCE);
		const mosaics = once ?? sceneMosaics(device, terrain, lat, lon);
		const t1 = performance.now();
		const [p] = await computeHorizonGpu(
			device,
			mosaics,
			[{ lat, lon, h: eye }],
			{ step: STEP, maxDistance: MAX_DISTANCE, noRidges: true },
		);
		const t2 = performance.now();
		timing?.({ mosaicMs: t1 - t0, gpuMs: t2 - t1, totalMs: t2 - t0 });
		return {
			step: p.step,
			elevation: p.elevation,
			distance: p.distance,
			ridges: p.ridges,
		};
	} catch (e) {
		console.warn("[gpu] scene horizon failed, using the CPU", e);
		// don't keep a scene that failed (a later call rebuilds it)
		if (opts.keep) releaseSceneHorizonGpu();
		return null;
	} finally {
		// one eye per scene: free the VRAM now rather than when the device goes away
		if (once) releaseHorizonGpu(once);
	}
}
