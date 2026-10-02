// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// One basin-gap check end to end (app.basin_gap_check's pose6 call): the DEM around the photo, the delta
// horizon problem at the stage-2 eye, the grid with its coarse search on the GPU (one graph per grid,
// ./basin-gpu.ts) or the CPU twin, and the gap. Runs in the solve worker (./solve.worker.ts) when there
// is one, so the DEM decode, the march readback and the LM stay off the page's main thread.

import type { Pose } from "#/lib/camera";
import { isAbortError } from "#/lib/gpu/core/abort";
import { getComputeDevice } from "#/lib/gpu/device";
import {
	type BasinGap,
	basinGap,
	basinProblem,
	type GridScorer,
	rotSearchCpu,
} from "./basin";
import { loadBasinDem } from "./basin-dem";
import type { Corr, SkylineCue } from "./fusion";
import { hfovFromVfov } from "./geometry";

export type BasinJob = {
	lat: number;
	lon: number;
	sk: SkylineCue;
	corr: Corr | null;
	eye: number[];
	pose: Pose;
	W: number;
	H: number;
	focalKnown: boolean;
};

export async function runBasinGap(
	job: BasinJob,
	o: { signal?: AbortSignal } = {},
): Promise<BasinGap> {
	const half = hfovFromVfov(job.pose.vfov, job.W / job.H) / 2 + 18;
	const dem = await loadBasinDem(
		job.lat,
		job.lon,
		{ az0: job.pose.yaw - half, az1: job.pose.yaw + half },
		o,
	);
	try {
		const prob = await basinProblem({
			W: job.W,
			H: job.H,
			sk: job.sk,
			corr: job.corr,
			eye0: job.eye,
			pose0: job.pose,
			focalKnown: job.focalKnown,
			regime: "manual",
			dem,
		});
		let scorer: GridScorer = rotSearchCpu;
		let name = "cpu";
		const device = await getComputeDevice().catch(() => null);
		if (device) {
			const { rotSearchGpu } = await import("./basin-gpu");
			const gpu = rotSearchGpu(device, o.signal);
			name = "gpu";
			scorer = async (...a) => {
				try {
					return await gpu(...a);
				} catch (e) {
					if (isAbortError(e)) throw e; // a cancel, not a GPU failure
					console.warn(
						"[matcher] basin grid on the GPU failed, using the CPU",
						e,
					);
					name = "cpu (GPU failed)";
					return rotSearchCpu(...a);
				}
			};
		}
		const tick = () => {
			if (o.signal?.aborted) throw new DOMException("aborted", "AbortError");
		};
		const r = await basinGap(prob, { scorer, tick });
		return { ...r, scorer: name };
	} finally {
		dem.release();
	}
}
