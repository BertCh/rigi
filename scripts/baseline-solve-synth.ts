// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Synthetic check of solvePose: render the DEM skyline from a known pose
 * (prior perturbed), add noise + fake foreground occluders, solve from the
 * prior, and report recovery error.  npx tsx scripts/baseline-solve-synth.ts
 */
import { perturbCamera, resizeCamera } from "../src/lib/geo/camera";
import { projectSkylineRows, solvePose } from "../src/lib/geo/solve";
import { listPhotos } from "./lib/node-io";
import { photoContext } from "./lib/pipeline-node";

const W = 800;
let seed = 1;
const rand = () => {
	seed = (seed * 16807) % 2147483647;
	return seed / 2147483647;
};

for (const { name, heic } of listPhotos(process.argv.slice(2))) {
	const ctx = await photoContext(name, heic);
	// BIG_YAW=1 simulates a fooled compass (40–120° off) to exercise the 360° fallback.
	const dYaw = process.env.BIG_YAW
		? (rand() < 0.5 ? -1 : 1) * (40 + rand() * 80)
		: (rand() - 0.5) * 20;
	const dPitch = (rand() - 0.5) * 4;
	const dRoll = (rand() - 0.5) * 3;
	const fS = 1 + (rand() - 0.5) * 0.06;
	const truth = perturbCamera(ctx.prior, dYaw, dPitch, dRoll, fS);
	const t = resizeCamera(truth, W);
	const rows = projectSkylineRows(t, ctx.horizon, W);
	const weight = new Float32Array(W);
	// Noise + one "person" block (boundary 150 px too high) + a cloud gap.
	const personAt = Math.floor(rand() * W * 0.7);
	for (let x = 0; x < W; x++) {
		if (!Number.isFinite(rows[x]) || rows[x] < 0 || rows[x] > t.height) {
			rows[x] = Number.NaN;
			continue;
		}
		rows[x] += (rand() - 0.5) * 2;
		weight[x] = 1;
		if (x >= personAt && x < personAt + W * 0.2) rows[x] -= 150;
		if (x > W * 0.85) rows[x] = Number.NaN;
	}
	const t0 = performance.now();
	// NO_HEADING=1: solve as if the photo had no compass (headingKnown: false).
	const res = solvePose(
		ctx.prior,
		ctx.horizon,
		{ width: W, height: t.height, rows, weight },
		process.env.NO_HEADING ? { headingKnown: false } : {},
	);
	const ms = performance.now() - t0;
	const c = res.camera;
	const err = (a: number, b: number) =>
		(((a - b + 540) % 360) - 180).toFixed(2);
	console.log(
		`${name}  true Δ(y,p,r,f)=(${dYaw.toFixed(1)}, ${dPitch.toFixed(1)}, ${dRoll.toFixed(1)}, ${fS.toFixed(3)})` +
			`  err yaw ${err(c.yaw, truth.yaw)} pitch ${err(c.pitch, truth.pitch)} roll ${err(c.roll, truth.roll)} f ${(c.f / truth.f).toFixed(3)}` +
			`  coarse (${res.coarse.yaw.toFixed(2)}, ${res.coarse.pitch.toFixed(2)})  conf ${res.confidence.toFixed(2)} inl ${res.inlierFraction.toFixed(2)} amb ${res.ambiguity.toFixed(2)} relief ${res.horizonRelief.toFixed(2)}°  ${ms.toFixed(0)}ms`,
	);
}
