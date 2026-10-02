// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Alternative pose refinement + confidence (parallel to geo/solve.ts).
 *
 *   const res = refinePose({ camera: prior, horizon, skyline });
 *   if (res.confidence.accept) use(res.camera); else openTapAPeakUI();
 *
 * Pipeline: FFT yaw correlation (init.ts) → top-K modes (+ the prior itself)
 * → robust coarse-to-fine IRLS per mode (robust.ts) → pick by robust cost at
 * a common scale → confidence (confidence.ts). Consumes exactly what the
 * baseline pipeline produces: a prior Camera (geo/camera.ts), a
 * HorizonProfile (geo/horizon.ts) and a per-column skyline
 * (SkylineObservation from geo/skyline.ts or sky/skyline.ts). Runs in the
 * browser and in node; no DOM.
 */
import { type Camera, resizeCamera } from "../geo/camera";
import type { HorizonProfile } from "../geo/horizon";
import { wrap180 } from "../geodesy";
import {
	type ConfidenceThresholds,
	computeConfidence,
	type RefineConfidence,
} from "./confidence";
import {
	DEFAULT_INIT,
	globalInit,
	globalInitAsync,
	type InitCorrelator,
	type InitOptions,
	type InitResult,
} from "./init";
import {
	cameraFromParams,
	columnsFromSkyline,
	DEG,
	DEYE,
	type Geometry,
	KREF,
	LOGF,
	PITCH,
	paramsFromCamera,
	ROLL,
	YAW,
} from "./model";
import {
	defaultRobustOptions,
	type RobustOptions,
	type RobustResult,
	refineRobust,
	scoreState,
} from "./robust";
import { fuseSkylines, rejectSpikes } from "./skyline-clean";

export type { RefineConfidence } from "./confidence";

export interface SkylineInput {
	rows: Float32Array | ArrayLike<number>;
	weight: Float32Array | ArrayLike<number>;
	width: number;
	height: number;
}

export interface RefineInput {
	/** Sensor prior (EXIF focal + gravity + compass), any resolution. */
	camera: Camera;
	horizon: HorizonProfile;
	/** Per-column photo skyline at its own working resolution. */
	skyline: SkylineInput;
	/**
	 * Optional second skyline (e.g. detectSkyline when `skyline` comes from a
	 * sky-model mask). Only columns where both agree survive, weighted by
	 * both, and narrow spikes (posts) are removed (skyline-clean.ts).
	 */
	crossCheck?: SkylineInput;
	/** Horizontal GPS accuracy, m (EXIF GPSHPositioningError). Default 10. */
	gpsAccuracy?: number;
	/** Vertical GPS / eye-height accuracy, m. Default 20. */
	gpsVerticalAccuracy?: number;
	/** DEM vertical error, m. Default 8 (GLO-30 / Terrarium class). */
	demSigma?: number;
	options?: RefineOptions;
}

export interface RefineOptions {
	robust?: Partial<RobustOptions>;
	init?: Partial<InitOptions>;
	thresholds?: ConfidenceThresholds;
	/** Skip the global correlation and refine from the prior only. */
	localOnly?: boolean;
}

export interface RefineMode {
	yaw: number;
	pitch: number;
	roll: number;
	f: number;
	/** Robust cost at the common scale (lower is better). */
	cost: number;
	/** Tukey support (higher is better). */
	support: number;
	inlierFraction: number;
	/** Where the mode's seed came from. */
	seed: "prior" | "correlation";
}

export interface RefineResult {
	/** Refined camera at the prior's resolution. */
	camera: Camera;
	confidence: RefineConfidence;
	/** Distinct refined modes, best first. */
	modes: RefineMode[];
	iterations: number;
	ms: number;
	/** Fitted eye-height offset, m (0 when not observable). */
	dEye: number;
	/** Fitted (or fixed) refraction coefficient. */
	k: number;
	kFitted: boolean;
	eyeFitted: boolean;
	/** Near/far differential shift (px at the working width) for a 20 m eye error. */
	eyeSensitivityPx: number;
	/** Weight fraction of skyline columns beyond 60 km. */
	farFraction: number;
	ransac: boolean;
	/** Correlation diagnostics. */
	init: { psr: number; ms: number; seeds: number };
}

/** What refinePose / refinePoseAsync share between the setup and the finish step. */
interface RefineContext {
	t0: number;
	input: RefineInput;
	prior: Camera;
	horizon: HorizonProfile;
	W: number;
	geom: Geometry;
	cols: ReturnType<typeof columnsFromSkyline>;
	priorState: Float64Array;
	ropts: ReturnType<typeof defaultRobustOptions>;
	initOptions: InitOptions;
}

/** The skyline columns, geometry and robust options; or the early "no usable skyline" result. */
function setupRefine(
	input: RefineInput,
): { early: RefineResult } | { ctx: RefineContext } {
	const t0 = performance.now();
	const { camera: prior, horizon } = input;
	const skyline: SkylineInput = input.crossCheck
		? rejectSpikes(fuseSkylines(input.skyline, input.crossCheck))
		: input.skyline;
	const W = skyline.width;
	const work = resizeCamera(prior, W);
	const geom: Geometry = {
		width: W,
		height: skyline.height,
		cx: work.cx,
		cy: work.cy,
		f0: work.f,
	};
	const cols = columnsFromSkyline(skyline);
	const priorState = paramsFromCamera(work, work.f);
	const ropts = defaultRobustOptions({
		error: {
			sigmaPx: Math.max(1, W / 1600),
			sigmaZ: input.demSigma ?? 8,
			sigmaK: 0.05,
			sigmaXY: input.gpsAccuracy ?? 10,
		},
		eyeSigma: input.gpsVerticalAccuracy ?? 20,
		...input.options?.robust,
	});
	ropts.priorSigma = {
		...ropts.priorSigma,
		dEye: Math.max(input.gpsVerticalAccuracy ?? 20, 20),
		...input.options?.robust?.priorSigma,
	};

	if (cols.length < Math.max(20, 0.05 * W)) {
		const early: RefineResult = {
			camera: prior,
			confidence: {
				accept: false,
				score: 0,
				sigmaDeg: {
					yaw: Number.POSITIVE_INFINITY,
					pitch: Number.POSITIVE_INFINITY,
					roll: Number.POSITIVE_INFINITY,
				},
				reasons: ["no usable skyline"],
				metrics: {
					psr: 0,
					modeRatio: 1,
					inlierFraction: 0,
					corrLength: 1,
					rmsSlope: 0,
					yawInfo: 0,
					rmsPx1600: Number.NaN,
					scale: Number.NaN,
					sigmaFocal: Number.NaN,
					sigmaEye: Number.NaN,
				},
			},
			modes: [],
			iterations: 0,
			ms: performance.now() - t0,
			dEye: 0,
			k: priorState[KREF],
			kFitted: false,
			eyeFitted: false,
			eyeSensitivityPx: 0,
			farFraction: 0,
			ransac: false,
			init: { psr: 0, ms: 0, seeds: 0 },
		};
		return { early };
	}
	return {
		ctx: {
			t0,
			input,
			prior,
			horizon,
			W,
			geom,
			cols,
			priorState,
			ropts,
			initOptions: { ...DEFAULT_INIT, ...input.options?.init },
		},
	};
}

export function refinePose(input: RefineInput): RefineResult {
	const s = setupRefine(input);
	if ("early" in s) return s.early;
	const { ctx } = s;
	const init = input.options?.localOnly
		? undefined
		: globalInit(
				ctx.priorState,
				ctx.geom,
				ctx.cols,
				ctx.horizon,
				ctx.initOptions,
			);
	return finishRefine(ctx, init);
}

/**
 * refinePose with the global yaw correlation on the GPU (four-step FFT in a core ComputeGraph,
 * fft-gpu.ts) when a compute device resolves (?gpu=off respected) and the grid fits; otherwise, or
 * on any GPU error, the CPU correlation. Never throws because of the GPU. The result agrees with
 * refinePose within the f32 correlation tolerance (refine-fft-dawn.ts), not bit for bit.
 */
export async function refinePoseAsync(
	input: RefineInput,
): Promise<RefineResult> {
	const s = setupRefine(input);
	if ("early" in s) return s.early;
	const { ctx } = s;
	let init: InitResult | undefined;
	if (!input.options?.localOnly) {
		const correlate = await gpuCorrelator(ctx.initOptions.gridSize);
		const args = [
			ctx.priorState,
			ctx.geom,
			ctx.cols,
			ctx.horizon,
			ctx.initOptions,
		] as const;
		if (correlate) {
			try {
				init = await globalInitAsync(...args, correlate);
			} catch (e) {
				warnGpuFallbackOnce(e);
			}
		}
		init ??= globalInit(...args);
	}
	return finishRefine(ctx, init);
}

let warnedGpu = false;
function warnGpuFallbackOnce(e: unknown) {
	if (warnedGpu) return;
	warnedGpu = true;
	console.debug("[refine] GPU correlation failed, using the CPU", e);
}

/** The GPU correlator, or null (no device, ?gpu=off, grid unsupported, module failed to load). */
async function gpuCorrelator(gridSize: number): Promise<InitCorrelator | null> {
	try {
		const { getComputeDevice } = await import("../gpu/device");
		const device = await getComputeDevice();
		if (!device) return null;
		const { correlateGpu, gpuCorrelationSupported } = await import("./fft-gpu");
		if (!gpuCorrelationSupported(gridSize)) return null;
		return (prep) => correlateGpu(device, prep);
	} catch (e) {
		warnGpuFallbackOnce(e);
		return null;
	}
}

/** The seeds, robust refinement, mode selection and confidence, given the correlation result. */
function finishRefine(
	ctx: RefineContext,
	init: InitResult | undefined,
): RefineResult {
	const { t0, input, prior, geom, cols, priorState, ropts, W, horizon } = ctx;

	// Seeds: the prior itself plus the correlation modes.
	const seeds: { p: Float64Array; seed: RefineMode["seed"] }[] = [
		{ p: Float64Array.from(priorState), seed: "prior" },
	];
	let psr = 0;
	let initMs = 0;
	if (init) {
		psr = init.psr;
		initMs = init.ms;
		for (const m of init.modes) {
			const p = Float64Array.from(priorState);
			p[YAW] += m.dYaw * DEG;
			p[PITCH] += m.dPitch * DEG;
			p[ROLL] += m.dRoll * DEG;
			p[LOGF] += Math.log(m.fScale);
			seeds.push({ p, seed: "correlation" });
		}
	}

	const prob = { geom, cols, horizon, prior: priorState };
	const runs: { res: RobustResult; seed: RefineMode["seed"] }[] = [];
	let iterations = 0;
	for (const s of seeds) {
		// Skip seeds that duplicate an already-refined pose.
		const res = refineRobust(prob, s.p, ropts);
		iterations += res.iterations;
		const dup = runs.find(
			(r) =>
				Math.abs(wrap180((r.res.p[YAW] - res.p[YAW]) / DEG)) < 0.2 &&
				Math.abs((r.res.p[PITCH] - res.p[PITCH]) / DEG) < 0.2,
		);
		if (dup) continue;
		runs.push({ res, seed: s.seed });
	}

	// Compare on a common scale.
	const sRef = Math.min(...runs.map((r) => r.res.scale));
	const scored = runs
		.map((r) => ({ ...r, sc: scoreState(prob, r.res.p, ropts, sRef) }))
		.sort((a, b) => a.sc.cost - b.sc.cost);
	const best = scored[0];
	let modeRatio = 0;
	for (const r of scored.slice(1)) {
		if (Math.abs(wrap180((r.res.p[YAW] - best.res.p[YAW]) / DEG)) <= 1)
			continue;
		modeRatio = Math.max(
			modeRatio,
			r.sc.support / Math.max(1e-9, best.sc.support),
		);
	}

	const b = best.res;
	const confidence = computeConfidence(
		{
			psr,
			modeRatio,
			inlierFraction: b.inlierFraction,
			info: b.info,
			priorInfo: b.priorInfo,
			active: b.active,
			scale: b.scale,
			residuals: b.residuals,
			sigma: b.sigma,
			weights: b.weights,
			slope: b.slope,
			f0: geom.f0,
			rmsPx: b.rmsPx,
			workWidth: W,
		},
		input.options?.thresholds,
	);

	const modes: RefineMode[] = scored.map((r) => {
		const c = cameraFromParams(r.res.p, prior);
		return {
			yaw: c.yaw,
			pitch: c.pitch,
			roll: c.roll,
			f: c.f,
			cost: r.sc.cost,
			support: r.sc.support,
			inlierFraction: r.res.inlierFraction,
			seed: r.seed,
		};
	});

	return {
		camera: cameraFromParams(b.p, prior),
		confidence,
		modes,
		iterations,
		ms: performance.now() - t0,
		dEye: b.p[DEYE],
		k: b.p[KREF],
		kFitted: b.kFitted,
		eyeFitted: b.eyeFitted,
		eyeSensitivityPx: b.eyeSensitivityPx,
		farFraction: b.farFraction,
		ransac: b.ransac,
		init: { psr, ms: initMs, seeds: seeds.length },
	};
}
