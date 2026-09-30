/**
 * Method (B): 0f's CPU cascade (on 0f's MAPTERHORN DEM, see sceneAt0f) (scripts/eval.ts SOLVER=cascade: solvePose → refinePose on reject),
 * fed ad-hoc photo metadata instead of HEIC EXIF. Import-only use of src/lib/geo, src/lib/refine
 * and scripts/lib; nothing there is modified.
 *
 *   npx tsx tools/bench/harness/cascade.ts <jobs.json> <out.json>
 *   jobs: [{key, photoFile, width, height, lat, lon, alt|null, gpsError?,
 *           prior: {yaw|null, pitch|null, roll|null, vfov}, focalKnown}]
 *
 * Two variants per job:
 *   native      eval.ts's cascade with default options; unknown yaw/pitch/roll are simply 0 in the
 *               prior (what the pipeline does when handed an upload without heading/gravity).
 *               solvePose still has its own fullSearchFallback (360° retry when the local search rejects).
 *   configured  the same solvers, told what is unknown through their public options:
 *               no gravity → solvePose pitchRange 15, σ pitch/roll 10°, tiltGate off;
 *                            refinePose init pitch/roll σ 10°, prior σ pitch/roll 10°
 *               no heading → solvePose yawRange 180 with σ yaw 1e6 (its "full" search);
 *                            refinePose init yawRange 180, yaw σ 1e6
 *               no focal   → hfov seeds 40/50/65°, best by (accepted, confidence)
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { demTileLoaderNode, loadRGBA } from "../../../scripts/lib/node-io";
import { eyeHeight } from "../../../scripts/lib/pipeline-node";
import {
	cameraToPose,
	poseToCamera,
	vfovFromHfov,
} from "../../../src/lib/camera";
import { MAPTERHORN } from "../../../src/lib/dem";
import type { Camera } from "../../../src/lib/geo/camera";
import {
	computeHorizon,
	type HorizonProfile,
} from "../../../src/lib/geo/horizon";
import { detectSkyline } from "../../../src/lib/geo/skyline";
import {
	type SolveOptions,
	type SolveResult,
	solvePose,
} from "../../../src/lib/geo/solve";
import { loadTerrain } from "../../../src/lib/geo/terrain";
import { type RefineOptions, refinePose } from "../../../src/lib/refine/index";
import { DEFAULT_INIT } from "../../../src/lib/refine/init";
import { DEFAULT_PRIOR_SIGMA } from "../../../src/lib/refine/robust";

/**
 * DEM for the cascade: 0f's own MAPTERHORN source (src/lib/geo/terrain.ts levels + 512 px tiles),
 * loaded with 0f's demTileLoaderNode (disk cache .cache/dem-mapterhorn), eye = eyeHeight(GPS alt,
 * terrain.ground()) on that same DEM: what `DEM=mapterhorn npx tsx scripts/eval.ts` does.
 */
const loadMapterhorn = demTileLoaderNode(MAPTERHORN);
const demTiles = new Map<string, Float32Array>();
const horizonMem = new Map<string, HorizonProfile>();
export async function sceneAt0f(lat: number, lon: number, alt: number | null) {
	if (demTiles.size > 400) demTiles.clear(); // ≈1 MB per decoded 512 px tile
	const terrain = await loadTerrain(
		lat,
		lon,
		loadMapterhorn,
		MAPTERHORN.levels,
		demTiles,
		16,
		MAPTERHORN.tileSize,
	);
	const ground = terrain.ground(lon, lat);
	const eye = eyeHeight(alt ?? undefined, ground);
	const key = `${lat},${lon},${eye}`;
	let horizon = horizonMem.get(key);
	if (!horizon) {
		horizon = computeHorizon(terrain, lat, lon, eye);
		if (horizonMem.size > 4)
			horizonMem.delete(horizonMem.keys().next().value as string);
		horizonMem.set(key, horizon);
	}
	return { terrain, ground, eye, horizon, dem: "mapterhorn-0f" };
}

const WORK_WIDTH = 800;
/** As src/lib/integration/unknown-pose.worker.ts FOCAL_/YAW_UNKNOWN_MIN_CONFIDENCE. */
const UNKNOWN_MIN_CONFIDENCE = 0.75;
/**
 * HARNESS_UNKNOWN_GATE=1 re-enables the harness-side mirror of the app's accept gate (below). Default off:
 * 0f's solvePose now applies the 0.75 bar itself for headingKnown:false.
 */
const HARNESS_GATE = process.env.HARNESS_UNKNOWN_GATE === "1"; // as scripts/eval.ts

export interface CascadeJob {
	key: string;
	photoFile: string;
	width: number;
	height: number;
	lat: number;
	lon: number;
	alt: number | null;
	gpsError?: number;
	prior: {
		yaw: number | null;
		pitch: number | null;
		roll: number | null;
		vfov: number;
	};
	focalKnown: boolean;
	/** When set, prior.yaw is only a weak heading: 360° search with this yaw σ (°). */
	yawSigmaDeg?: number;
}

type Sky = ReturnType<typeof detectSkyline>;

type Stage = {
	method: string;
	camera: Camera;
	confidence: number;
	accepted: boolean;
	search: string;
	residualPx: number;
	rejectReason?: string;
};

/** Mirror of scripts/eval.ts's `chain`: first accepted stage, else the FIRST (solvePose) result; all stages attached. */
const chain = (results: Stage[]) => {
	const candidates = results.map((r) => ({
		method: r.method,
		camera: r.camera,
		confidence: r.confidence,
		accepted: r.accepted,
	}));
	const winner = results.find((r) => r.accepted) ?? results[0];
	return { ...winner, candidates };
};

/** SOLVER=cascade as scripts/eval.ts: solvePose; on reject escalate to refinePose and `chain` the two. */
function cascade(
	prior: Camera,
	horizon: Parameters<typeof solvePose>[1],
	sky: Sky,
	gpsError: number | undefined,
	sOpts: SolveOptions,
	rOpts?: RefineOptions,
) {
	const first = solvePose(prior, horizon, sky, sOpts);
	const solve: Stage = {
		method: "solve",
		camera: first.camera,
		confidence: first.confidence,
		accepted: first.accepted,
		search: first.search,
		residualPx: first.residualPx,
		rejectReason: first.rejectReason,
	};
	// eval.ts returns `first` itself (no candidates) when it accepts; rows still list the one stage
	if (first.accepted)
		return {
			...solve,
			stage: "solve",
			candidates: [
				{
					method: "solve",
					camera: first.camera,
					confidence: first.confidence,
					accepted: true,
				},
			],
			first: summary(first),
		};
	const r = refinePose({
		camera: prior,
		horizon,
		skyline: sky,
		gpsAccuracy: gpsError,
		options: rOpts,
	});
	const refine: Stage = {
		method: "refine",
		camera: r.camera,
		confidence: r.confidence.score,
		accepted: r.confidence.accept,
		search: "refine",
		residualPx: r.confidence.metrics.rmsPx1600,
		rejectReason: r.confidence.accept
			? undefined
			: r.confidence.reasons.join("; "),
	};
	const c = chain([solve, refine]);
	return { ...c, stage: c.method, first: summary(first) };
}

function summary(s: SolveResult) {
	return {
		pose: { yaw: s.camera.yaw, pitch: s.camera.pitch, roll: s.camera.roll },
		confidence: s.confidence,
		accepted: s.accepted,
		rejectReason: s.rejectReason,
		search: s.search,
	};
}

function options(yawKnown: boolean, gravKnown: boolean, weakYawSigma?: number) {
	const sOpts: SolveOptions = {};
	const sigma = { yaw: 15, pitch: 1.5, roll: 1.5, focal: 0.06 };
	const init: Partial<typeof DEFAULT_INIT> = {};
	const prior = { ...DEFAULT_PRIOR_SIGMA };
	if (!gravKnown) {
		sOpts.pitchRange = 15;
		sOpts.tiltGate = 90;
		sigma.pitch = 10;
		sigma.roll = 10;
		init.pitchSigmaDeg = 10;
		init.rollSigmaDeg = 10;
		prior.pitchDeg = 10;
		prior.rollDeg = 10;
	}
	if (!yawKnown) {
		// 0f's API: headingKnown:false → straight to solvePose's full 360° search (yawRange 180, yaw σ 1e6)
		// at its 0.75 bar (acceptConfidence deliberately not passed). refinePose still gets 360° via init.
		sOpts.headingKnown = false;
		init.yawRange = 180;
		init.yawSigmaDeg = 1e6;
		prior.yawDeg = 1e6;
		if (weakYawSigma) {
			// (solvePose's full search overrides its yaw σ with 1e6; the weak heading only reaches refinePose)
			init.yawSigmaDeg = weakYawSigma;
			prior.yawDeg = weakYawSigma;
		}
	}
	sOpts.sigma = sigma;
	return {
		sOpts,
		rOpts: { init, robust: { priorSigma: prior } } as RefineOptions,
	};
}

const skyCache = new Map<string, { sky: Sky; ms: number }>();

/** Runs both variants for one job; never throws (errors are returned). */
export async function runCascade(
	job: CascadeJob,
): Promise<Record<string, unknown>> {
	const t0 = performance.now();
	try {
		const scene = await sceneAt0f(job.lat, job.lon, job.alt);
		const tScene = performance.now() - t0;
		let sk = skyCache.get(job.photoFile);
		if (!sk) {
			const ts = performance.now();
			const img = await loadRGBA(job.photoFile, WORK_WIDTH);
			sk = { sky: detectSkyline(img), ms: performance.now() - ts };
			skyCache.set(job.photoFile, sk);
		}
		const yawKnown = job.prior.yaw != null && !job.yawSigmaDeg;
		const gravKnown = job.prior.pitch != null && job.prior.roll != null;
		const cam = (vfov: number) =>
			poseToCamera(
				{
					yaw: job.prior.yaw ?? 0,
					pitch: gravKnown ? (job.prior.pitch as number) : 0,
					roll: gravKnown ? (job.prior.roll as number) : 0,
					vfov,
				},
				job.width,
				job.height,
			);
		const cands = (
			cs: {
				method: string;
				camera: Camera;
				confidence: number;
				accepted: boolean;
			}[],
		) =>
			cs.map((q) => ({
				method: q.method,
				pose: cameraToPose(q.camera),
				confidence: q.confidence,
				accepted: q.accepted,
			}));
		const variants: Record<string, unknown> = {};
		{
			const t = performance.now();
			const prior = cam(job.prior.vfov);
			const r = cascade(prior, scene.horizon, sk.sky, job.gpsError, {});
			variants.native = {
				...r,
				camera: undefined,
				candidates: cands(r.candidates),
				pose: cameraToPose(r.camera),
				prior: cameraToPose(prior),
				solveMs: performance.now() - t,
			};
		}
		{
			const t = performance.now();
			const { sOpts, rOpts } = options(yawKnown, gravKnown, job.yawSigmaDeg);
			const vfovs = job.focalKnown
				? [job.prior.vfov]
				: [40, 50, 65].map((h) => vfovFromHfov(h, job.width, job.height));
			let best: (ReturnType<typeof cascade> & { seedVfov: number }) | null =
				null;
			const seeds = [];
			for (const v of vfovs) {
				const r = {
					...cascade(cam(v), scene.horizon, sk.sky, job.gpsError, sOpts, rOpts),
					seedVfov: v,
				};
				seeds.push({
					seedVfov: v,
					pose: cameraToPose(r.camera),
					confidence: r.confidence,
					accepted: r.accepted,
					stage: r.stage,
				});
				if (
					!best ||
					Number(r.accepted) > Number(best.accepted) ||
					(r.accepted === best.accepted && r.confidence > best.confidence)
				)
					best = r;
			}
			const b = best as NonNullable<typeof best>;
			// Accept gate, mirroring src/lib/integration/unknown-pose.worker.ts exactly (final result, both
			// stages): unknown focal → ambiguous if another focal seed accepts > 1° of yaw away or the best is
			// < 0.75; unknown yaw → a 360° solve must reach 0.75 (solvePose's own fullSearchConfidence).
			const bYaw = b.camera.yaw;
			const ambiguous =
				!job.focalKnown &&
				(seeds.some(
					(q) =>
						q.accepted && Math.abs(((q.pose.yaw - bYaw + 540) % 360) - 180) > 1,
				) ||
					b.confidence < UNKNOWN_MIN_CONFIDENCE);
			const weak360 = !yawKnown && b.confidence < UNKNOWN_MIN_CONFIDENCE;
			variants.configured = {
				...b,
				accepted: HARNESS_GATE
					? b.accepted && !ambiguous && !weak360
					: b.accepted,
				acceptedRaw: b.accepted,
				gate: {
					enabled: HARNESS_GATE,
					ambiguous,
					weak360,
					threshold: UNKNOWN_MIN_CONFIDENCE,
				},
				camera: undefined,
				candidates: cands(b.candidates),
				pose: cameraToPose(b.camera),
				prior: cameraToPose(cam(b.seedVfov)),
				focalSeeds: job.focalKnown ? undefined : seeds,
				options: { solvePose: sOpts, refinePose: rOpts },
				solveMs: performance.now() - t,
			};
		}
		return {
			key: job.key,
			ok: true,
			eye: scene.eye,
			ground: scene.ground,
			dem: scene.dem,
			skylineMs: sk.ms,
			sceneMs: tScene,
			variants,
		};
	} catch (e) {
		return { key: job.key, ok: false, error: String((e as Error)?.stack ?? e) };
	}
}

async function main() {
	const [jobsFile, outFile] = process.argv.slice(2);
	const jobs: CascadeJob[] = JSON.parse(fs.readFileSync(jobsFile, "utf8"));
	const out: Record<string, unknown>[] = [];
	for (const job of jobs) {
		const r = await runCascade(job);
		out.push(r);
		const c = (
			r.variants as
				| Record<
						string,
						{
							pose: { yaw: number };
							accepted: boolean;
							confidence: number;
							solveMs: number;
						}
				  >
				| undefined
		)?.configured;
		console.error(
			c
				? `[cascade] ${job.key}: yaw ${c.pose.yaw.toFixed(2)} conf ${c.confidence.toFixed(2)} ${c.accepted ? "ACCEPT" : "reject"} (${Math.round(c.solveMs)} ms)`
				: `[cascade] ${job.key}: ERROR ${r.error}`,
		);
		fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
