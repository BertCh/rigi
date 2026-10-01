// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Self-tests for src/lib/refine:
 *   1. the closed-form back-projection in model.ts matches geo/camera.ts;
 *   2. analytic Jacobians match central differences (h = 1e-4 rad);
 *   3. the FFT and circular correlation match brute force;
 *   4. refinePose recovers a synthetic pose from a perturbed prior.
 *
 *   npx tsx scripts/refine-test.ts
 */
import {
	azimuthElevation,
	cameraFromAngles,
	unproject,
} from "../src/lib/geo/camera";
import type { HorizonProfile } from "../src/lib/geo/horizon";
import { projectSkylineRows } from "../src/lib/geo/solve";
import { correlateSpectra, rfft } from "../src/lib/refine/fft";
import { refinePose } from "../src/lib/refine/index";
import {
	DEG,
	evalColumn,
	type Geometry,
	horizonTable,
	NPARAM,
	newEval,
	PARAM_NAMES,
} from "../src/lib/refine/model";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
	if (!ok) failures++;
};

// Deterministic PRNG.
let seed = 12345;
const rand = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 2 ** 32;
};

function syntheticHorizon(step = 0.01): HorizonProfile {
	const n = Math.round(360 / step);
	const elevation = new Float32Array(n);
	const distance = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const a = i * step * DEG;
		elevation[i] =
			2 +
			1.5 * Math.sin(3 * a) +
			0.6 * Math.sin(17 * a + 1) +
			0.2 * Math.cos(41 * a);
		distance[i] = 20_000 + 15_000 * Math.sin(5 * a);
	}
	return { step, elevation, distance, ridges: [] };
}

// 1. Back-projection vs geo/camera.ts.
{
	let worst = 0;
	for (let t = 0; t < 200; t++) {
		const cam = cameraFromAngles({
			width: 800,
			height: 600,
			f: 500 + 400 * rand(),
			yaw: 360 * rand(),
			pitch: -15 + 30 * rand(),
			roll: -10 + 20 * rand(),
		});
		const x = 800 * rand();
		const y = 600 * rand();
		const [az, el] = azimuthElevation(unproject(cam, x, y));
		const g: Geometry = {
			width: 800,
			height: 600,
			cx: cam.cx,
			cy: cam.cy,
			f0: cam.f,
		};
		const p = [cam.yaw * DEG, cam.pitch * DEG, cam.roll * DEG, 0, 0.13, 0];
		const e = evalColumn(
			p,
			g,
			horizonTable(syntheticHorizon(1)),
			{ x, y, w: 1 },
			newEval(),
		);
		const dAz = Math.abs(((e.az - az + 540) % 360) - 180);
		const dEl = Math.abs(e.el / DEG - el);
		worst = Math.max(worst, dAz, dEl);
	}
	check(
		"back-projection matches geo/camera.ts",
		worst < 1e-9,
		`max err ${worst.toExponential(2)}°`,
	);
}

// 2. Jacobian vs central differences.
{
	// Piecewise-linear horizon: skip points within 3h of a sample (kink), where
	// the central difference averages two slopes.
	const t = horizonTable(syntheticHorizon(0.1));
	const H = [1e-4, 1e-4, 1e-4, 1e-5, 1e-3, 0.05];
	const worst = new Array(NPARAM).fill(0);
	const J = new Float64Array(NPARAM);
	const e = newEval();
	for (let trial = 0; trial < 300; trial++) {
		const g: Geometry = { width: 800, height: 600, cx: 400, cy: 300, f0: 600 };
		const p = [
			360 * rand() * DEG,
			(-10 + 20 * rand()) * DEG,
			(-5 + 10 * rand()) * DEG,
			-0.05 + 0.1 * rand(),
			0.05 + 0.2 * rand(),
			-50 + 100 * rand(),
		];
		const c = { x: 800 * rand(), y: 600 * rand(), w: 1 };
		evalColumn(p, g, t, c, e, J);
		const u = e.az / 0.1;
		if (Math.abs(u - Math.round(u)) * 0.1 < (3 * 1e-4) / DEG) continue;
		for (let j = 0; j < NPARAM; j++) {
			const a = [...p];
			const b = [...p];
			a[j] += H[j];
			b[j] -= H[j];
			const num =
				(evalColumn(a, g, t, c, newEval()).r -
					evalColumn(b, g, t, c, newEval()).r) /
				(2 * H[j]);
			const rel =
				Math.abs(num - J[j]) / Math.max(1e-3, Math.abs(num), Math.abs(J[j]));
			worst[j] = Math.max(worst[j], rel);
		}
	}
	for (let j = 0; j < NPARAM; j++)
		check(
			`Jacobian ∂r/∂${PARAM_NAMES[j]} vs central difference`,
			worst[j] < 2e-2,
			`max rel err ${worst[j].toExponential(2)}`,
		);
}

// 3. FFT correlation vs brute force.
{
	const n = 64;
	const a = Array.from({ length: n }, () => rand() - 0.5);
	const b = Array.from({ length: n }, () => rand() - 0.5);
	const c = correlateSpectra(rfft(a), rfft(b));
	let worst = 0;
	for (let s = 0; s < n; s++) {
		let ref = 0;
		for (let j = 0; j < n; j++) ref += a[j] * b[(j + s) % n];
		worst = Math.max(worst, Math.abs(ref - c[s]));
	}
	check(
		"FFT circular correlation",
		worst < 1e-10,
		`max err ${worst.toExponential(2)}`,
	);
}

// 4. End-to-end on a synthetic skyline.
{
	const horizon = syntheticHorizon(0.05);
	const truth = cameraFromAngles({
		width: 800,
		height: 600,
		f: 620,
		yaw: 123.4,
		pitch: 3.2,
		roll: -1.1,
	});
	// projectSkylineRows samples at pixel centres, as observations are.
	const rows = projectSkylineRows(truth, horizon, 800);
	const weight = new Float32Array(800);
	for (let x = 0; x < 800; x++) {
		// Noise, plus an occluder (tree) over 15% of the width.
		rows[x] += (rand() - 0.5) * 1.0;
		if (x > 500 && x < 620) rows[x] -= 25 + 10 * rand();
		weight[x] = Number.isFinite(rows[x]) ? 1 : 0;
	}
	for (const dy of [0, 8, -14]) {
		const prior = cameraFromAngles({
			width: 800,
			height: 600,
			f: 600,
			yaw: 123.4 + dy,
			pitch: 2.2,
			roll: -0.2,
		});
		const res = refinePose({
			camera: prior,
			horizon,
			skyline: { rows, weight, width: 800, height: 600 },
		});
		const eYaw = Math.abs(((res.camera.yaw - truth.yaw + 540) % 360) - 180);
		const ePitch = Math.abs(res.camera.pitch - truth.pitch);
		const eRoll = Math.abs(res.camera.roll - truth.roll);
		check(
			`synthetic refinePose, prior yaw off ${dy}°`,
			eYaw < 0.05 && ePitch < 0.05 && eRoll < 0.1,
			`err yaw ${eYaw.toFixed(3)} pitch ${ePitch.toFixed(3)} roll ${eRoll.toFixed(3)}  f ${(res.camera.f / truth.f).toFixed(4)}  score ${res.confidence.score.toFixed(2)} ${res.ms.toFixed(0)} ms ${res.confidence.reasons.join("; ")}`,
		);
	}
}

if (failures) {
	console.log(`${failures} failure(s)`);
	process.exit(1);
}
console.log("all passed");
