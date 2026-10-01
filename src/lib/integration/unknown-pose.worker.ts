// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/// <reference lib="webworker" />
/**
 * 0f's CPU cascade (solvePose → refinePose on reject) for photos with unknown heading / gravity /
 * focal, with the unknowns declared through the solvers' public options (reports/bench-ablation.md,
 * "cascade (unknowns via options)": 0 false accepts in all four ablation conditions).
 * Loads its own 360° Mapterhorn terrain + horizon (the DEM the app engine draws with). The scene and
 * solve code is in ./unknown-pose-core.ts (shared with the node gate); this file is the message shell.
 */
import { fetchDemTileCached, type TileKey } from "#/lib/dem";
import { applyRealmGpuOptions, takeGpuProfile } from "#/lib/gpu/core/realm";
import { getComputeDevice, releaseWhenIdle } from "#/lib/gpu/device";
import { warmSolveGpu } from "#/lib/gpu/solve";
import type {
	UnknownPosePrepare,
	UnknownPoseRequest,
	UnknownPoseResponse,
} from "./unknown-pose";
import {
	computeUnknownScene,
	fusedFor,
	solveUnknownPose,
	UNKNOWN_POSE_DEM,
	type UnknownScene,
} from "./unknown-pose-core";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
/**
 * This worker lives as long as the photo (re-runs reuse its horizon) but uses the GPU in bursts:
 * destroy the WebGPU device after this long without GPU use; the next solve recreates it.
 */
const GPU_IDLE_MS = 30_000;
releaseWhenIdle(GPU_IDLE_MS);

let horizonCache: {
	key: string;
	promise: Promise<UnknownScene>;
} | null = null;

/** 360° horizon at the camera, computed once per position (the 'prepare' message starts it early). */
function horizonAt(
	lat: number,
	lon: number,
	alt: number | null,
	gpu = false,
	fused = false,
) {
	const key = `${lat.toFixed(6)},${lon.toFixed(6)},${alt ?? ""},${gpu ? "gpu" : ""}${fused ? "+fused" : ""}`;
	if (horizonCache?.key !== key) {
		const promise = computeScene(lat, lon, alt, gpu, fused);
		promise.catch(() => {
			if (horizonCache?.promise === promise) horizonCache = null;
		});
		horizonCache = { key, promise };
	}
	return horizonCache.promise;
}

/**
 * Tiles come through the page's shared tile cache (dem's fetchDemTileCached; this worker gets a
 * read-only view of the same store), so tiles the page loaded cost no request; the rest are fetched
 * through the HTTP cache. Abortable.
 *
 * The whole 360° DEM load must finish within this (Terrarium was ~205 tiles, ~28 MB cold);
 * a stalled network otherwise hangs the solve forever (the upload overlay, item 05's export lock).
 * Cold loads measured 3–77 s.
 */
const SCENE_TIMEOUT_MS = 90_000;

async function computeScene(
	lat: number,
	lon: number,
	alt: number | null,
	gpu = false,
	fused = false,
) {
	const signal = AbortSignal.timeout(SCENE_TIMEOUT_MS);
	// a failed tile stays a hole (ocean, 404) as before, but a timeout fails the scene: a horizon with
	// holes could be accepted at a wrong pose. horizonAt drops the failed promise, so a re-run retries.
	const loadTile = (k: TileKey) => {
		if (signal.aborted) return Promise.reject(signal.reason);
		return fetchDemTileCached(UNKNOWN_POSE_DEM, k, signal).catch(() => {
			if (signal.aborted)
				throw new Error(
					`terrain tiles timed out after ${SCENE_TIMEOUT_MS / 1000} s`,
				);
			return undefined;
		});
	};
	return computeUnknownScene(lat, lon, alt, loadTile, gpu, fused);
}

const solve = (req: UnknownPoseRequest) =>
	solveUnknownPose(req, () =>
		horizonAt(req.lat, req.lon, req.alt, req.gpu, fusedFor(req)),
	);

ctx.onmessage = async (
	ev: MessageEvent<UnknownPoseRequest | UnknownPosePrepare>,
) => {
	applyRealmGpuOptions(ev.data.gpuOpts);
	if (ev.data.type === "prepare") {
		horizonAt(
			ev.data.lat,
			ev.data.lon,
			ev.data.alt,
			ev.data.gpu,
			fusedFor(ev.data),
		).catch(() => {});
		if (ev.data.solveGpu) {
			const fused = fusedFor(ev.data);
			getComputeDevice()
				.then(async (d) => {
					if (!d) return;
					if (fused)
						await (await import("#/lib/gpu/solve/fused")).warmFusedSolve(d);
					else await warmSolveGpu(d);
				})
				.catch(() => {});
		}
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
