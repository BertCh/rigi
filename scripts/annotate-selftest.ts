// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/** Synthetic check of solveFromControlPoints: npx tsx scripts/annotate-selftest.ts */
import {
	azimuthElevation,
	cameraFromAngles,
	perturbCamera,
	unproject,
} from "../src/lib/geo/camera";
import {
	type ControlPoint,
	solveFromControlPoints,
} from "../src/lib/geo/control-points";
import { wrap180 } from "../src/lib/geodesy";

const angDiff = (a: number, b: number) => wrap180(a - b);
let worst = 0;
for (const truth of [
	{ width: 4032, height: 3024, f: 3200, yaw: 358, pitch: -4, roll: 1.5 },
	{ width: 3024, height: 4032, f: 3200, yaw: 120, pitch: 6, roll: -3 },
	{ width: 4032, height: 3024, f: 1600, yaw: 225, pitch: -9, roll: -6 },
]) {
	const cam = cameraFromAngles(truth);
	const px: [number, number][] = [
		[500, 900],
		[3000, 1200],
		[1800, 700],
		[2600, 1500],
		[1200, 1400],
	];
	const pts: ControlPoint[] = px.map(([x, y]) => {
		const [azimuth, elevation] = azimuthElevation(unproject(cam, x, y));
		return { x, y, azimuth, elevation };
	});
	for (const n of [1, 2, 3, 5]) {
		const init =
			n === 1
				? perturbCamera(cam, 10, 3)
				: n === 2
					? perturbCamera(cam, 10, 3, 2)
					: perturbCamera(cam, 10, 3, 2, 1.05);
		const s = solveFromControlPoints(init, pts.slice(0, n));
		const e = {
			yaw: angDiff(s.camera.yaw, truth.yaw),
			pitch: s.camera.pitch - truth.pitch,
			roll: s.camera.roll - truth.roll,
			fPct: (100 * (s.camera.f - truth.f)) / truth.f,
		};
		worst = Math.max(
			worst,
			Math.abs(e.yaw),
			Math.abs(e.pitch),
			Math.abs(e.roll),
		);
		console.log(
			`yaw ${truth.yaw} n=${n}: dYaw ${e.yaw.toExponential(1)} dPitch ${e.pitch.toExponential(1)} dRoll ${e.roll.toExponential(1)} df ${e.fPct.toExponential(1)}% rms ${s.rmsPx.toExponential(1)}px focal=${s.solvedFocal}`,
		);
	}
}
console.log(
	worst < 0.01 ? `PASS (worst ${worst.toExponential(1)}°)` : `FAIL ${worst}`,
);
