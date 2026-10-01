// Fused horizon → solve path of the unknown-pose worker (opt-out: the worker's gpuFused: false).
//
// One chain over core command graphs on one device, sharing the solve's resident horizon buffer:
//   horizon-march graph (../horizon/graph.ts, one encoding per chunk) → read [out, stats]
//   → CPU: elevation = f32(atan(t) / DEG) in f64 (../horizon/index.ts collect, unchanged)
//   → write the solve's resident hz (./graph.ts residentHz) with exactly packCoarse's bits
//   → every solve-coarse graph run of the photo (3 focal seeds × cascade stages) binds it as is.
// So the first coarse call of a photo finds its profile resident (stats.hzUploaded false), and the
// fold kernel is compiled before the first request (the coarse kernel already was: warmSolveGpu).
//
// What is NOT fused, and why (bit-identity):
// - The horizon's readback stays. The CPU needs the profile regardless: solvePose's LM fine stage,
//   refinePose, the exact f64 re-scores in selectBounded (coarseRow) and the certified ε (costBound reads
//   max |hz| and the steepest step) all run on the CPU on `horizon.elevation`.
// - The tan → degrees conversion stays on the CPU. The coarse kernel must see the CPU's bits
//   f32(Math.atan(t) / DEG) (f64 atan, then one rounding to f32): WGSL has no f64, its atan is only
//   specified to 4096 ULP and implementations may contract a·b + c into an FMA, so a GPU node cannot be
//   proven to give those bits. Verifying a GPU-converted hz would need it read back (28.8 KB, the size
//   of the upload it would save); using it unverified with ε widened by the atan error would keep the
//   final result but change the per-row intervals, the bands and the re-score work (and need a bound
//   that rests on the driver's atan). Neither saves anything: the upload it replaces happens once per
//   photo already.
// - The march and the first coarse grid cannot share one submit: the coarse uniforms carry 2.5ε, and
//   ε, the plan's observations and the selection all need the CPU profile first.
import type { Device } from "@luma.gl/core";
import type { HorizonProfile } from "#/lib/geo/horizon";
import type { TerrainSampler } from "#/lib/geo/terrain";
import { kernelAsync } from "../core/kernel";
import { withLease } from "../core/pool";
import { getComputeDevice } from "../device";
import { K_FOLD, primeResidentHz } from "./graph";
import { profileHz, warmSolveGpu } from "./index";

/** Lease of the solve's pooled slots and resident profile (./index.ts OWNER). */
const SOLVE = "solve";

export type FusedHorizon = {
	horizon: HorizonProfile;
	/** the solve's resident profile now holds this horizon's bits (false: no device, or the CPU march) */
	primed: boolean;
};

/**
 * Put `horizon` into the solve's resident profile buffer of `device` (the bits packCoarse builds), so
 * the coarse graph's first call of the photo binds it without an upload. Never throws.
 */
export async function primeSolveHorizon(
	device: Device,
	horizon: HorizonProfile,
): Promise<boolean> {
	const hz = profileHz(horizon);
	if (!hz) return false;
	try {
		await withLease(SOLVE, async () => {
			primeResidentHz(device, hz);
		});
		return true;
	} catch (e) {
		console.warn("[solve] priming the resident horizon failed", e);
		return false;
	}
}

/** warmSolveGpu plus the graph path's fold kernel (the coarse graph's compile then hits both). */
export async function warmFusedSolve(device: Device) {
	await Promise.all([warmSolveGpu(device), kernelAsync(device, K_FOLD)]);
}

/**
 * The worker's 360° scene horizon on the command-graph chain: sceneHorizonGpu with the march graph,
 * then the solve's resident profile primed with it. null when the GPU march cannot serve (the caller
 * runs the CPU sceneHorizon, as the unfused path does).
 */
export async function fusedSceneHorizon(
	terrain: TerrainSampler,
	lat: number,
	lon: number,
	eye: number,
): Promise<FusedHorizon | null> {
	const { sceneHorizonGpu } = await import("../horizon/scene-profile");
	const horizon = await sceneHorizonGpu(terrain, lat, lon, eye, undefined, {
		graph: true,
	});
	if (!horizon) return null;
	const device = await getComputeDevice();
	const primed = device ? await primeSolveHorizon(device, horizon) : false;
	return { horizon, primed };
}
