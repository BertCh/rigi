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
 */
import type { HorizonProfile } from "#/lib/geo/horizon";
import type { TerrainSampler } from "#/lib/geo/terrain";
import { mosaicsFromSampler } from "#/lib/horizon-fast/march";
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

/**
 * sceneHorizon(terrain, lat, lon, eye) marched on the GPU, or null when there is no WebGPU device or the
 * kernel fails (the caller then runs the CPU sceneHorizon). Never throws.
 */
export async function sceneHorizonGpu(
	terrain: TerrainSampler,
	lat: number,
	lon: number,
	eye: number,
	timing?: (t: SceneHorizonGpuTiming) => void,
): Promise<HorizonProfile | null> {
	const t0 = performance.now();
	const device = await getComputeDevice();
	if (!device) return null;
	let mosaics: ReturnType<typeof mosaicsFromSampler> | null = null;
	try {
		mosaics = mosaicsFromSampler(terrain, lat, lon, MAX_DISTANCE);
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
		return null;
	} finally {
		// one eye per scene: free the VRAM now rather than when the device goes away
		if (mosaics) releaseHorizonGpu(mosaics);
	}
}
