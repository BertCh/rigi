// Analytic self-checks for eye.ts (fitRotationToHorizon, skylineResidualsPx, refineEyeFromSkyline)
// on a synthetic ridge: the horizon is computed exactly from a known 3-D ridge line, so there is
// no DEM, no rasterisation and no detector in the loop.
//
//   npx tsx src/lib/pose6dof/eye.check.ts
//
// `runEyeChecks()` is exported so scripts/test-pose6dof.ts (lead-owned) can call it too.
import type { Pose } from "../camera";
import { wrap180 } from "../geodesy";
import {
	type EyeHorizon,
	fitRotationToHorizon,
	refineEyeFromSkyline,
	type SkylineSample,
	skylineResidualsPx,
	type Vec3,
} from "./eye";
import { azElFromDir, dirFromAzEl, project } from "./project";

const D = Math.PI / 180;
const STEP = 0.1;
const ASPECT = 4 / 3;
const H = 600;

/**
 * Ridge crest points (ENU, m) with strong depth contrast, so an eye shift is not just a rotation:
 * a near ridge 0.7–1.5 km away on the left (az −45…0) and a far one 12–15 km away on the right.
 */
function ridge(): Vec3[] {
	const pts: Vec3[] = [];
	for (let az = -50; az <= 50; az += 0.02) {
		const near = az < 0;
		const d = near
			? 1100 + 400 * Math.sin(az * 9 * D)
			: 13500 + 1500 * Math.sin(az * 4 * D);
		const h = near
			? 200 + 40 * Math.sin(az * 13 * D) + 15 * Math.cos(az * 31 * D)
			: 1500 + 300 * Math.sin(az * 6 * D + 0.5) + 80 * Math.cos(az * 17 * D);
		pts.push([d * Math.sin(az * D), d * Math.cos(az * D), h]);
	}
	return pts;
}
const RIDGE = ridge();

/** Exact horizon of the ridge seen from `eye` (max elevation per 0.1° bin; −90 = none). */
export function ridgeHorizon(eye: ArrayLike<number>): EyeHorizon {
	const n = Math.round(360 / STEP);
	const el = new Float64Array(n).fill(-90);
	for (const p of RIDGE) {
		const [az, e] = azElFromDir([p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]]);
		const i = Math.round(az / STEP) % n;
		if (e > el[i]) el[i] = e;
	}
	return { step: STEP, elevation: el };
}

/** Observed skyline samples: the horizon from `eye` projected under `pose` (+ optional noise). */
function observe(eye: Vec3, pose: Pose): SkylineSample[] {
	const h = ridgeHorizon(eye);
	const out: SkylineSample[] = [];
	for (let az = -40; az <= 40; az += 0.2) {
		const a = (az + 360) % 360;
		const e = h.elevation[Math.round(a / STEP) % h.elevation.length];
		if (e <= -89) continue;
		const p = project(pose, ASPECT, [0, 0, 0], { dir: dirFromAzEl(a, e) });
		if (p && p.u > 0 && p.u < 1 && p.v > 0 && p.v < 1)
			out.push({ u: p.u, v: p.v, w: 1 });
	}
	return out;
}

interface Check {
	name: string;
	pass: boolean;
	detail: string;
}

export async function runEyeChecks(): Promise<Check[]> {
	const checks: Check[] = [];
	const add = (name: string, pass: boolean, detail: string) =>
		checks.push({ name, pass, detail });
	const truth: Pose = { yaw: 2, pitch: 4, roll: 1, vfov: 50 };
	const eye0: Vec3 = [0, 0, 100];
	const base = { aspect: ASPECT, imageHeight: H };
	const obs0 = observe(eye0, truth);
	const angErr = (p: Pose) =>
		Math.max(
			Math.abs(wrap180(p.yaw - truth.yaw)),
			Math.abs(p.pitch - truth.pitch),
			Math.abs(p.roll - truth.roll),
		);

	// 1. Residuals vanish at the true pose and eye (projection/unprojection round trip).
	const r0 = skylineResidualsPx(obs0, ridgeHorizon(eye0), truth, ASPECT, H);
	const maxR = Math.max(...r0.filter(Number.isFinite).map(Math.abs));
	add(
		"skylineResidualsPx ≈ 0 at the true pose",
		obs0.length > 100 && maxR < 0.5,
		`${obs0.length} samples, max |r| ${maxR.toFixed(3)} px`,
	);

	// 2. Rotation recovery from a perturbed start (weak priors).
	const start: Pose = {
		...truth,
		yaw: truth.yaw + 1.2,
		pitch: truth.pitch - 0.7,
		roll: truth.roll + 0.9,
	};
	const fit = fitRotationToHorizon(obs0, ridgeHorizon(eye0), start, {
		...base,
		rotationSigma: { yaw: 100, pitch: 100, roll: 100 },
	});
	add(
		"fitRotationToHorizon recovers a known rotation",
		angErr(fit.pose) < 0.03 && fit.meanClippedPx < 0.5,
		`max angle err ${angErr(fit.pose).toFixed(4)}° (start 1.2°), ${fit.meanClippedPx.toFixed(2)} px, ${fit.iterations} it`,
	);

	// 3. Zero shift: the eye must not move.
	const ground = () => 0; // flat ground at 0 m, eye0 is 100 m above it
	const z = await refineEyeFromSkyline(obs0, start, eye0, ridgeHorizon, {
		...base,
		sigmaH: 20,
		ground,
	});
	add(
		"refineEyeFromSkyline: zero shift → no move",
		!z.moved && z.shift.every((x) => x === 0) && angErr(z.pose) < 0.05,
		`moved ${z.moved}, refined shift ${z.refinedEye.map((x, i) => (x - eye0[i]).toFixed(1)).join(",")} m, angle err ${angErr(z.pose).toFixed(3)}°`,
	);

	// 4. Known shift, no ground: the eye and rotation are recovered.
	const shift: Vec3 = [30, -20, 15];
	const eyeT: Vec3 = [
		eye0[0] + shift[0],
		eye0[1] + shift[1],
		eye0[2] + shift[2],
	];
	const obsT = observe(eyeT, truth);
	const k = await refineEyeFromSkyline(obsT, start, eye0, ridgeHorizon, {
		...base,
		sigmaH: 20,
	});
	const eyeErr = Math.hypot(...k.eye.map((x, i) => x - eyeT[i]));
	add(
		"refineEyeFromSkyline recovers a (30,−20,15) m shift",
		k.moved && eyeErr < 8 && angErr(k.pose) < 0.1,
		`recovered ${k.shift.map((x) => x.toFixed(1)).join(",")} m (err ${eyeErr.toFixed(1)} m; GPS prior σ 20 m shrinks it), angle err ${angErr(k.pose).toFixed(3)}°`,
	);

	// 5. Height-above-ground prior: an eye truly 40 m up over flat ground is held near the ground
	//    by a tight prior, and not by `aboveGround: false`.
	const eyeG: Vec3 = [0, 0, 1.6];
	const obsUp = observe([0, 0, 41.6], truth);
	const opts5 = { ...base, sigmaH: 20, ground, grid: false as const };
	const free = await refineEyeFromSkyline(obsUp, truth, eyeG, ridgeHorizon, {
		...opts5,
		aboveGround: false,
	});
	const held = await refineEyeFromSkyline(obsUp, truth, eyeG, ridgeHorizon, {
		...opts5,
		aboveGround: { height: 1.6, sigma: 0.5 },
	});
	const dflt = await refineEyeFromSkyline(
		obsUp,
		truth,
		eyeG,
		ridgeHorizon,
		opts5,
	);
	add(
		"aboveGround soft prior and default hard cap limit the eye height over the DEM",
		free.refinedAboveGroundM > 20 &&
			held.refinedAboveGroundM < 5 &&
			dflt.refinedAboveGroundM <= 10 + 1e-6,
		`AGL without limits ${free.refinedAboveGroundM.toFixed(1)} m, σ 0.5 m prior ${held.refinedAboveGroundM.toFixed(1)} m, default (σ 3, cap 10) ${dflt.refinedAboveGroundM.toFixed(1)} m`,
	);
	return checks;
}

// Run directly (tsx): print and exit non-zero on failure.
if (
	typeof process !== "undefined" &&
	process.argv[1]?.endsWith("eye.check.ts")
) {
	runEyeChecks().then((cs) => {
		for (const c of cs)
			console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
		const bad = cs.filter((c) => !c.pass).length;
		console.log(bad ? `${bad} EYE CHECK(S) FAILED` : "ALL EYE CHECKS PASSED");
		if (bad) process.exit(1);
	});
}
