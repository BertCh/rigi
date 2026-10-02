// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * The photo page's "Check camera position" suggestion: pose6dof's eye search (refineEyeFromSkyline)
 * on the batched horizon provider (./index.ts: WebGPU when getComputeDevice() gives a device, else the
 * CPU march), set up exactly as the W6 bench (./bench.ts gpuBatch mode):
 * - samples: ./samples.ts photoSamples (detectSkyline on an 800 px copy);
 * - pose0: the caller's current pose (vfov held); eye0 = [0, 0, eyeAltitude(alt, DEM at the fix)] on
 *   the Mapterhorn mosaic, the lead experiment's eye0;
 * - mosaics: Mapterhorn, DEFAULT_RINGS, the pose sector ± 8°; opts sigmaV 50, clearance 1.5.
 *
 * matching-v2 policy (reports/matching-v2.md): a moved eye is a LOW-confidence suggestion. This module
 * only computes; nothing here applies, saves or trusts the result. Runs in suggest.worker.ts (client.ts
 * spawns it) or, as a fallback, on the calling thread.
 */
import type { Pose } from "#/lib/camera";
import { eyeAltitude } from "#/lib/geo/eye-rule";
import {
	type RefineEyeResult,
	refineEyeFromSkyline,
	type SkylineFit,
	type Vec3,
} from "#/lib/pose6dof/eye";
import { getComputeDevice } from "../device";
import { warmHorizonGpuAsync } from "../horizon";
import {
	createEyeHorizonProvider,
	loadEyeMosaics,
	mapterhornTileStore,
	sectorForPose,
} from "./index";
import { photoSamples } from "./samples";

export interface EyeSearchInput {
	/** Photo URL (same origin or blob:). */
	photoUrl: string;
	/** GPS fix (the ENU origin) and GPS altitude (m MSL, null = snap to the DEM). */
	lat: number;
	lon: number;
	alt: number | null;
	/** Horizontal GPS σ, m (the photo's hAccuracy; eye.ts floors it at 5). */
	sigmaH: number;
	/** Start rotation (the current app pose); vfov is held. */
	pose: Pose;
	/** Start eye height, m MSL (default eyeAltitude(alt, DEM at the fix)); for bench parity checks. */
	eye0U?: number;
}

export interface EyeSearchProgress {
	stage: "skyline" | "terrain" | "search";
	/** Eyes marched so far and horizon batches. */
	eyes: number;
	batches: number;
	/** Where the horizons are marched (null until known). */
	gpu: boolean | null;
	ms: number;
}

export interface EyeFitStats {
	/** Normalised robust cost (data + priors), eye.ts's own objective. */
	cost: number;
	/** Weighted mean |residual| clipped at 3·cauchy, px of the 800 px work image. */
	meanClippedPx: number;
	medianAbsPx: number;
	rmsInlierPx: number;
	inlierFrac: number;
}

export interface EyeSearchResult {
	/** eye.ts's acceptance: the refined eye beat the start by minGain (2) in cost incl. priors. */
	moved: boolean;
	/** Best eye found (refinedEye) − eye0, m [E, N, U], whether or not it was accepted. */
	shift: Vec3;
	distanceM: number;
	/** Start eye height (m MSL) and the refined eye as lat / lon / height (m MSL). */
	eye0U: number;
	eye: { lat: number; lon: number; h: number };
	/** Rotation re-fitted at the refined eye (vfov unchanged). */
	pose: Pose;
	before: EyeFitStats;
	after: EyeFitStats;
	/** LM 1σ, m. */
	sigma: { dx?: number; dy?: number; dz?: number };
	clamped: boolean;
	refinedAboveGroundM: number;
	samples: number;
	workSize: [number, number];
	gpu: boolean;
	horizonCalls: number;
	eyesMarched: number;
	ms: number;
}

const stats = (f: SkylineFit): EyeFitStats => ({
	cost: f.cost,
	meanClippedPx: f.meanClippedPx,
	medianAbsPx: f.medianAbsPx,
	rmsInlierPx: f.rmsInlierPx,
	inlierFrac: f.inlierFrac,
});

export async function runEyeSearch(
	input: EyeSearchInput,
	onProgress?: (p: EyeSearchProgress) => void,
): Promise<EyeSearchResult> {
	const t0 = performance.now();
	let gpu: boolean | null = null;
	const report = (stage: EyeSearchProgress["stage"], eyes = 0, batches = 0) =>
		onProgress?.({ stage, eyes, batches, gpu, ms: performance.now() - t0 });
	report("skyline");
	const { W, H, samples } = await photoSamples(input.photoUrl);
	if (samples.length < 20)
		throw new Error("too little skyline detected in the photo");
	const aspect = W / H;
	const pose0: Pose = { ...input.pose };
	const sector = sectorForPose(pose0, aspect);
	report("terrain");
	const device = await getComputeDevice();
	gpu = !!device;
	// compile the march kernel off-thread while the tiles download (the first batch then doesn't pay it)
	if (device) void warmHorizonGpuAsync(device);
	const mosaics = await loadEyeMosaics(input.lat, input.lon, { sector });
	const hp = createEyeHorizonProvider({
		lat: input.lat,
		lon: input.lon,
		mosaics,
		sector,
	});
	try {
		const g0 = hp.ground(0, 0);
		if (!Number.isFinite(g0)) throw new Error("no DEM at the camera position");
		const eye0: Vec3 = [0, 0, input.eye0U ?? eyeAltitude(input.alt, g0)];
		const horizonsAtEyes = async (es: Vec3[]) => {
			const out = await hp.horizonsAtEyes(es);
			report("search", hp.stats.eyes, hp.stats.batches);
			return out;
		};
		report("search");
		const res: RefineEyeResult = await refineEyeFromSkyline(
			samples,
			pose0,
			eye0,
			null,
			{
				aspect,
				imageHeight: H,
				sigmaH: input.sigmaH,
				sigmaV: 50,
				ground: hp.ground,
				clearance: 1.5,
				horizonsAtEyes,
			},
		);
		const e = res.refinedEye;
		const shift: Vec3 = [e[0] - eye0[0], e[1] - eye0[1], e[2] - eye0[2]];
		const geo = hp.toEye(e);
		return {
			moved: res.moved,
			shift,
			distanceM: Math.hypot(...shift),
			eye0U: eye0[2],
			eye: { lat: geo.lat, lon: geo.lon, h: geo.h },
			pose: res.after.pose,
			before: stats(res.before),
			after: stats(res.after),
			sigma: res.sigma,
			clamped: res.clamped,
			refinedAboveGroundM: res.refinedAboveGroundM,
			samples: samples.length,
			workSize: [W, H],
			gpu,
			horizonCalls: res.horizonCalls,
			eyesMarched: hp.stats.eyes,
			ms: performance.now() - t0,
		};
	} finally {
		hp.release();
		mapterhornTileStore().clear();
	}
}
