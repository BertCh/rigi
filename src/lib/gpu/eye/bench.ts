/**
 * Browser bench + parity of the eye search (pose6dof refineEyeFromSkyline) on the batched GPU horizon.
 * Loaded by scripts/gpu/eye-bench.mjs inside headless Chromium:
 *
 *   const { benchEye } = await import('/src/lib/gpu/eye/bench.ts');
 *   await benchEye({ id, lat, lon, eyeU, sigmaH, pose, img })
 *
 * One photo: the photo skyline is detectSkyline on an 800 px copy (as scripts/eval.ts), pose0 is the
 * ground-truth rotation (vfov from its focal), eye0 = [0, 0, eyeU]. Mosaics (Mapterhorn, DEFAULT_RINGS,
 * the pose sector ± 8°) are built once. Then the same search runs four ways:
 *   gpuBatch  horizonsAtEyes on the GPU (grid stage and LM Jacobian probes batched)
 *   gpuSeq    per-eye GPU calls (the original callback path)
 *   cpuBatch  horizonsAtEyes with the GPU kill switch off (computeHorizonsAuto → CPU march)
 *   cpuSeq    per-eye CPU calls: the original path, the reference
 * Returns small JSON (no profiles).
 */

import { flagOverride, setFlagOverride } from "#/lib/flags";
import {
	type EyeHorizon,
	fitRotationToHorizon,
	type RefineEyeOptions,
	type RefineEyeResult,
	refineEyeFromSkyline,
	type Vec3,
} from "#/lib/pose6dof/eye";
import { DEG } from "../../geodesy";
import { getComputeDevice } from "../device";
import {
	createEyeHorizonProvider,
	loadEyeMosaics,
	mapterhornTileStore,
	sectorForPose,
} from "./index";
import { photoSamples } from "./samples";

export interface EyeBenchIn {
	id: string;
	lat: number;
	lon: number;
	/** Start eye height, m MSL. */
	eyeU: number;
	/** Horizontal GPS σ, m. */
	sigmaH: number;
	/** Start rotation; f in px of a `width` × `height` image. */
	pose: {
		yaw: number;
		pitch: number;
		roll: number;
		f: number;
		width: number;
		height: number;
	};
	/** Photo URL (served by the dev server). */
	img: string;
	modes?: Mode[];
	/** false: GPU horizon on the pooled path; default the command-graph path (../horizon/graph.ts) */
	graph?: boolean;
}

/** cpuJitter: cpuBatch with ±1e-4° deterministic noise on the horizon (the search's own sensitivity). */
type Mode = "gpuBatch" | "gpuSeq" | "cpuBatch" | "cpuSeq" | "cpuJitter";

/** Horizons with a deterministic ±amp° perturbation per azimuth (hash of the index). */
const jitter =
	(inner: (e: Vec3[]) => Promise<EyeHorizon[]>, amp: number) =>
	async (es: Vec3[]) =>
		(await inner(es)).map((h) => {
			const el = Float32Array.from(h.elevation);
			for (let i = 0; i < el.length; i++)
				if (el[i] > -89) {
					const u = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
					el[i] += amp * (2 * (u - Math.floor(u)) - 1);
				}
			return { ...h, elevation: el };
		});

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

function summary(r: RefineEyeResult) {
	return {
		eye: r.refinedEye.map(r6),
		shift: r.shift.map(r6),
		moved: r.moved,
		pose: {
			yaw: r6(r.after.pose.yaw),
			pitch: r6(r.after.pose.pitch),
			roll: r6(r.after.pose.roll),
		},
		beforeCost: r6(r.before.cost),
		afterCost: r6(r.after.cost),
		rmsInlierPx: r6(r.after.rmsInlierPx),
		medianAbsPx: r6(r.after.medianAbsPx),
		meanClippedPx: r6(r.after.meanClippedPx),
		inlierFrac: r6(r.after.inlierFrac),
		gridBest: r.gridBest && {
			shift: r.gridBest.shift.map(r6),
			cost: r6(r.gridBest.cost),
		},
		sigma: r.sigma,
		clamped: r.clamped,
		refinedAboveGroundM: r6(r.refinedAboveGroundM),
		horizonCalls: r.horizonCalls,
		cacheHits: r.cacheHits,
		ms: Math.round(r.ms),
	};
}

/** Differences of a run against the reference run. */
function delta(a: RefineEyeResult, ref: RefineEyeResult) {
	const d = a.refinedEye.map((x, i) => x - ref.refinedEye[i]);
	const dAng = (x: number, y: number) => ((((x - y) % 360) + 540) % 360) - 180;
	let maxResid = 0;
	for (let i = 0; i < a.after.residualsPx.length; i++) {
		const x = a.after.residualsPx[i];
		const y = ref.after.residualsPx[i];
		if (Number.isFinite(x) && Number.isFinite(y))
			maxResid = Math.max(maxResid, Math.abs(x - y));
		else if (Number.isFinite(x) !== Number.isFinite(y)) maxResid = Infinity;
	}
	return {
		dEyeM: Math.hypot(d[0], d[1], d[2]),
		dEye: d.map((x) => Number(x.toExponential(3))),
		dYaw: dAng(a.after.pose.yaw, ref.after.pose.yaw),
		dPitch: a.after.pose.pitch - ref.after.pose.pitch,
		dRoll: a.after.pose.roll - ref.after.pose.roll,
		dAfterCost: a.after.cost - ref.after.cost,
		dBeforeCost: a.before.cost - ref.before.cost,
		maxResidDiffPx: maxResid,
		sameMoved: a.moved === ref.moved,
		sameGridBest:
			JSON.stringify(a.gridBest?.shift) === JSON.stringify(ref.gridBest?.shift),
		identical:
			a.refinedEye.every((x, i) => x === ref.refinedEye[i]) &&
			a.after.cost === ref.after.cost &&
			a.before.cost === ref.before.cost &&
			a.after.pose.yaw === ref.after.pose.yaw &&
			a.after.pose.pitch === ref.after.pose.pitch &&
			a.after.pose.roll === ref.after.pose.roll &&
			a.horizonCalls === ref.horizonCalls &&
			a.cacheHits === ref.cacheHits,
	};
}

export async function benchEye(o: EyeBenchIn) {
	const prevMode = flagOverride("gpu");
	const t0 = performance.now();
	const { W, H, samples } = await photoSamples(o.img);
	const skyMs = performance.now() - t0;
	const aspect = W / H;
	if (Math.abs(aspect - o.pose.width / o.pose.height) > 0.01)
		throw new Error(`${o.id}: photo aspect ${aspect} ≠ pose frame`);
	const pose0 = {
		yaw: o.pose.yaw,
		pitch: o.pose.pitch,
		roll: o.pose.roll,
		vfov: (2 * Math.atan(o.pose.height / 2 / o.pose.f)) / DEG,
	};
	const sector = sectorForPose(pose0, aspect);
	const m0 = performance.now();
	const mosaics = await loadEyeMosaics(o.lat, o.lon, { sector });
	const mosaicMs = performance.now() - m0;
	const hp = createEyeHorizonProvider({
		lat: o.lat,
		lon: o.lon,
		mosaics,
		sector,
		graph: o.graph,
	});
	const eye0: Vec3 = [0, 0, o.eyeU];
	const opts: RefineEyeOptions = {
		aspect,
		imageHeight: H,
		sigmaH: o.sigmaH,
		sigmaV: 50,
		ground: hp.ground,
		clearance: 1.5,
	};
	const out: Record<string, unknown> = {
		id: o.id,
		samples: samples.length,
		work: [W, H],
		sector: [sector.az0, sector.az1].map((x) => Math.round(x * 100) / 100),
		ground0: hp.ground(0, 0),
		mosaicMB: mosaics.reduce((a, m) => a + m.data.byteLength, 0) / 1e6,
		skyMs: Math.round(skyMs),
		mosaicMs: Math.round(mosaicMs),
	};
	const runs: Partial<Record<Mode, RefineEyeResult>> = {};
	const modes = o.modes ?? ["gpuBatch", "gpuSeq", "cpuBatch", "cpuSeq"];
	try {
		// Warm-up: device, pipeline, mosaic upload (reported, not charged to the runs).
		setFlagOverride("gpu", "on");
		out.gpu = !!(await getComputeDevice());
		const w0 = performance.now();
		const [hg] = await hp.horizonsAtEyes([eye0]);
		out.gpuWarmupMs = Math.round(performance.now() - w0);
		setFlagOverride("gpu", "off");
		const c0 = performance.now();
		const [hc] = await hp.horizonsAtEyes([eye0]);
		out.cpuHorizonMs = Math.round(performance.now() - c0);
		// Horizon parity at eye0 over the sector.
		let maxD = 0;
		let emptyMismatch = 0;
		for (let i = 0; i < hc.elevation.length; i++) {
			const a = hc.elevation[i];
			const b = hg.elevation[i];
			if (a === -90 || b === -90) {
				if (a !== b) emptyMismatch++;
			} else maxD = Math.max(maxD, Math.abs(a - b));
		}
		out.horizonParity = { maxDElDeg: maxD, emptyMismatch };
		for (const mode of modes) {
			setFlagOverride("gpu", mode.startsWith("gpu") ? "on" : "off");
			hp.stats.maxBatch = 0;
			const s0 = { ...hp.stats };
			const batch = mode !== "gpuSeq" && mode !== "cpuSeq";
			const res = await refineEyeFromSkyline(
				samples,
				pose0,
				eye0,
				batch ? null : hp.horizonAt,
				batch
					? {
							...opts,
							horizonsAtEyes:
								mode === "cpuJitter"
									? jitter(hp.horizonsAtEyes, 1e-4)
									: hp.horizonsAtEyes,
						}
					: opts,
			);
			runs[mode] = res;
			out[mode] = {
				...summary(res),
				provider: {
					batches: hp.stats.batches - s0.batches,
					eyes: hp.stats.eyes - s0.eyes,
					horizonMs: Math.round(hp.stats.ms - s0.ms),
					maxBatch: hp.stats.maxBatch,
				},
			};
		}
		// Cross-check: both final eyes under both horizons (is a GPU/CPU gap the horizon or the path?).
		const cross: Record<string, Record<string, number>> = {};
		for (const k of ["gpuBatch", "cpuSeq"] as const) {
			const r = runs[k];
			if (!r) continue;
			cross[k] = {};
			for (const hz of ["gpu", "cpu"] as const) {
				setFlagOverride("gpu", hz === "gpu" ? "on" : "off");
				const [h] = await hp.horizonsAtEyes([r.refinedEye]);
				const f = fitRotationToHorizon(samples, h, r.after.pose, {
					...opts,
					priorPose: pose0,
				});
				cross[k][`${hz}Cost`] = r6(f.cost);
				cross[k][`${hz}MeanClippedPx`] = r6(f.meanClippedPx);
			}
		}
		out.crossEval = cross;
		// Batch latency scaling on the GPU (eyes on a 2 m lattice around eye0).
		setFlagOverride("gpu", "on");
		const scaling: Record<string, number> = {};
		for (const nb of [1, 6, 30, 100, 343]) {
			const es: Vec3[] = Array.from({ length: nb }, (_, i) => [
				2 * ((i % 7) - 3),
				2 * ((Math.floor(i / 7) % 7) - 3),
				o.eyeU + 2 * (Math.floor(i / 49) - 3),
			]);
			const b0 = performance.now();
			await hp.horizonsAtEyes(es);
			scaling[nb] = Math.round(performance.now() - b0);
		}
		out.gpuBatchMs = scaling;
	} finally {
		setFlagOverride("gpu", prevMode);
		hp.release();
		mapterhornTileStore().clear();
	}
	const ref = runs.cpuSeq ?? runs.cpuBatch;
	if (ref) {
		const vs: Record<string, unknown> = {};
		for (const [k, r] of Object.entries(runs))
			if (r !== ref) vs[k] = delta(r, ref);
		out.vsCpuSeq = vs;
	}
	if (runs.gpuBatch && runs.gpuSeq)
		out.gpuBatchVsGpuSeq = delta(runs.gpuBatch, runs.gpuSeq);
	return out;
}
