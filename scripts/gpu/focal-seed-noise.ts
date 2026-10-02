// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Noise-injection check for the unknown-pose accept decision (research_notes/wave5/skyline-gpu-flip.md):
// GT-12 IMG_6958 none+nofocal, CPU only, seeded uniform noise of +-a px added to the skyline rows before the
// cascade. The accept decision must be identical for a = 0, 1e-6, 1e-5, 1e-4, 1e-3 (before the
// SEED_REFINE_MIN_SOLVE_CONFIDENCE floor (?focalSeedGate=on, default off) the wrong-focal third seed refined into an accept between 1e-5 and
// 1e-4). Manual script, not a CI row (5+ full CPU cascades take minutes). SKIPs (exit 0) without the photo, the GT-12 manifest or the DEM tile cache (all gitignored).
//   npx tsx scripts/gpu/focal-seed-noise.ts [IMG_6958]
import fs from "node:fs";
import path from "node:path";
import { MAPTERHORN } from "#/lib/dem";
import type { UnknownPoseRequest } from "#/lib/integration/unknown-pose";
import {
	computeUnknownScene,
	isAmbiguousFocal,
	SEED_REFINE_MIN_SOLVE_CONFIDENCE,
	solveUnknownPose,
	type UnknownScene,
} from "#/lib/integration/unknown-pose-core";
import { demTileLoaderNode, loadRGBA } from "../lib/node-io";

// the floor is opt-in (?focalSeedGate=on, default off until the batch A/B): this check measures it switched on
(globalThis as { __RIGI_FLAGS__?: Record<string, string> }).__RIGI_FLAGS__ = {
	focalSeedGate: "on",
};

const ROOT = path.resolve(import.meta.dirname, "../..");
const ID = process.argv[2] ?? "IMG_6958";
const NOISE_PX = [0, 1e-6, 1e-5, 1e-4, 1e-3];
// noise realisations per level (argv[3]); the old decision flips only for some realisations
const NOISE_SEEDS = Number(process.argv[3] ?? 1);
const WORK_WIDTH = 800;

const manifestFile = path.join(
	ROOT,
	"tools/bench/harness/out/ablation/manifest.json",
);
const photoFile = path.join(ROOT, "public/photos", `${ID}.jpg`);
if (
	!fs.existsSync(manifestFile) ||
	!fs.existsSync(photoFile) ||
	!fs.existsSync(path.join(ROOT, ".cache/dem-mapterhorn"))
) {
	console.log(`SKIP: ${ID} photo / GT-12 manifest / DEM cache missing`);
	process.exit(0);
}
const e = JSON.parse(fs.readFileSync(manifestFile, "utf8")).find(
	(m: { id: string }) => m.id === ID,
);
if (!e) {
	console.log(`SKIP: ${ID} not in the GT-12 manifest`);
	process.exit(0);
}

const full = await loadRGBA(photoFile);
const image = await loadRGBA(photoFile, WORK_WIDTH);
const loadTile = demTileLoaderNode(MAPTERHORN);
let scene: Promise<UnknownScene> | null = null;
const request = (): UnknownPoseRequest => ({
	type: "solve",
	id: 1,
	lat: e.lat,
	lon: e.lon,
	alt: e.altitudeM ?? null,
	gpsAccuracy: e.gpsErrorM ?? null,
	width: full.width,
	height: full.height,
	// none+nofocal as unknown-gpu-gate.mjs GT12_CONDS: yaw, gravity and focal all unknown (yaw 0, level)
	prior: {
		yaw: 0,
		pitch: 0,
		roll: 0,
		vfov: e.vfovDeg,
	},
	unknown: { yaw: true, gravity: true, focal: true },
	image: {
		width: image.width,
		height: image.height,
		data: new Uint8ClampedArray(image.data),
	},
	gpu: false,
	solveGpu: false,
	gpuFused: false,
});

function noisy(amp: number, seed: number) {
	let x = seed >>> 0 || 1;
	const rnd = () => {
		x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
		return x / 4294967296;
	};
	return (sky: { rows: Float32Array }) => {
		const rows = Float32Array.from(sky.rows, (r) =>
			Number.isFinite(r) ? r + (2 * rnd() - 1) * amp : r,
		);
		return { ...sky, rows } as never;
	};
}

const decisions: boolean[] = [];
const oldDecisions: boolean[] = [];
for (const amp of NOISE_PX)
	for (let k = 0; k < (amp > 0 ? NOISE_SEEDS : 1); k++) {
		const r = await solveUnknownPose(
			request(),
			() => {
				scene ??= computeUnknownScene(
					e.lat,
					e.lon,
					e.altitudeM ?? null,
					loadTile,
				);
				return scene;
			},
			amp > 0 ? noisy(amp, 12345 + k) : undefined,
		);
		// the decision without the floor (the pre-fix rule), derived from the same seeds
		const best = { camera: r.pose, confidence: r.confidence };
		const bestSeed = r.seeds.reduce((m, c) =>
			Math.abs(c.yaw - r.pose.yaw) < Math.abs(m.yaw - r.pose.yaw) ? c : m,
		);
		const oldAccepted =
			bestSeed.accepted && !isAmbiguousFocal(r.seeds, best, false);
		decisions.push(r.accepted);
		oldDecisions.push(oldAccepted);
		console.log(
			`noise ${amp.toExponential(0).padStart(5)} px #${k}: accepted=${r.accepted} (pre-fix rule: ${oldAccepted}) yaw ${r.pose.yaw.toFixed(2)} conf ${r.confidence.toFixed(4)} | seeds ` +
				r.seeds
					.map(
						(s) =>
							`${s.stage[0]}${s.accepted ? "A" : "r"}(${s.solveConfidence.toFixed(3)}->${s.confidence.toFixed(3)}@${s.yaw.toFixed(1)})`,
					)
					.join(" "),
		);
	}
const same =
	decisions.every((d) => d === decisions[0]) &&
	decisions[0] === oldDecisions[0];
const oldSame = oldDecisions.every((d) => d === oldDecisions[0]);
console.log(
	`${same ? "PASS" : "FAIL"}: ${ID} none+nofocal decision ${same ? "identical" : "differs"} across ${decisions.length} noisy solves (floor ${SEED_REFINE_MIN_SOLVE_CONFIDENCE}); pre-fix rule on the same seeds ${oldSame ? "also stable" : "FLIPS"}`,
);
process.exit(same ? 0 : 1);
