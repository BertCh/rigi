// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { type Pose, projectPoint } from "../../../camera";
import type { Vec3 } from "../../../linalg";
import {
	eyePixelJacobian,
	eyeRowJacobian,
	type HorizonSamples,
	predictSkylineColumns,
	SKYPAR,
	skylineParallax,
} from "../skyline-parallax";

const W = 1024;
const H = 576;
const pose: Pose = { yaw: 40, pitch: 3, roll: 1.5, vfov: 17 };
const D = Math.PI / 180;

/**
 * Synthetic horizon whose depth varies smoothly along azimuth from about 4 km (a near ridge) to 32 km (far
 * peaks) with a few sharp ridges, so a displaced eye shifts the skyline by a 1/d-shaped amount.
 */
function syntheticWorld(eye: Vec3, step = 0.05) {
	const n = Math.round(360 / step);
	const elevation = new Float64Array(n);
	const distance = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const az = i * step;
		const d = 18000 + 14000 * Math.sin(az * D * 9);
		const z = 900 + 700 * Math.sin(az * D * 23) + 500 * Math.cos(az * D * 7);
		const dd = Math.max(4000, d);
		elevation[i] = Math.atan2(z - eye[2], dd) / D;
		distance[i] = dd;
	}
	return { step, elevation, distance } satisfies HorizonSamples;
}

/**
 * Horizon seen from an eye displaced from `eye0`: the same world points, re-projected to direction + distance.
 */
function horizonFromEye(
	base: HorizonSamples,
	eye0: Vec3,
	eye1: Vec3,
): HorizonSamples {
	const n = base.elevation.length;
	const elevation = new Float64Array(n);
	const distance = new Float64Array(n);
	const az1 = (a: number) => ((a % 360) + 360) % 360;
	const pts: { az: number; el: number; d: number }[] = [];
	for (let i = 0; i < n; i++) {
		const az = i * base.step * D;
		const e = base.elevation[i] * D;
		const d = base.distance[i];
		const x = eye0[0] + d * Math.sin(az) * Math.cos(e) - eye1[0];
		const y = eye0[1] + d * Math.cos(az) * Math.cos(e) - eye1[1];
		const z = eye0[2] + d * Math.sin(e) - eye1[2];
		const dd = Math.hypot(x, y, z);
		pts.push({
			az: az1(Math.atan2(x, y) / D),
			el: Math.asin(z / dd) / D,
			d: dd,
		});
	}
	// resample onto the regular azimuth grid by linear interpolation (pts az is monotone for small shifts)
	for (let i = 0; i < n; i++) {
		const a = i * base.step;
		let k = 0;
		// find bracket
		const start = Math.max(0, i - 40);
		for (k = start; k < n + start - 1; k++) {
			const p = pts[k % n];
			const q = pts[(k + 1) % n];
			const a0 = p.az;
			let a1 = q.az;
			let aa = a;
			if (a1 < a0 - 180) a1 += 360;
			if (aa < a0 - 180) aa += 360;
			if (aa >= a0 && aa <= a1) {
				const t = a1 === a0 ? 0 : (aa - a0) / (a1 - a0);
				elevation[i] = p.el + t * (q.el - p.el);
				distance[i] = p.d + t * (q.d - p.d);
				break;
			}
		}
	}
	return { step: base.step, elevation, distance };
}

describe("eye Jacobians", () => {
	it("matches finite differences of the projection", () => {
		const v: Vec3 = [4000, 9000, 700];
		const eye: Vec3 = [0, 0, 0];
		const j = eyePixelJacobian(pose, W, H, v);
		expect(j).not.toBeNull();
		const base = projectPoint(pose, W / H, eye, v) as { u: number; v: number };
		const px = (e: Vec3) => {
			const p = projectPoint(pose, W / H, e, v) as { u: number; v: number };
			return [p.u * W, p.v * H];
		};
		const eps = 1e-3;
		for (let k = 0; k < 3; k++) {
			const e1: Vec3 = [0, 0, 0];
			e1[k] = eps;
			const [x1, y1] = px(e1);
			const [x0, y0] = [base.u * W, base.v * H];
			expect(j?.dx[k]).toBeCloseTo((x1 - x0) / eps, 3);
			expect(j?.dy[k]).toBeCloseTo((y1 - y0) / eps, 3);
		}
	});
	it("scales as 1/d and the row form subtracts slope times dx", () => {
		const u: Vec3 = [0.3, 0.9, 0.05];
		const n = Math.hypot(...u);
		const at = (d: number): Vec3 => [
			(u[0] / n) * d,
			(u[1] / n) * d,
			(u[2] / n) * d,
		];
		const g1 = eyeRowJacobian(pose, W, H, at(2000), 0) as Vec3;
		const g2 = eyeRowJacobian(pose, W, H, at(20000), 0) as Vec3;
		for (let k = 0; k < 3; k++) expect(g1[k] / g2[k]).toBeCloseTo(10, 1);
		const j = eyePixelJacobian(pose, W, H, at(5000)) as { dx: Vec3; dy: Vec3 };
		const g = eyeRowJacobian(pose, W, H, at(5000), 0.2) as Vec3;
		for (let k = 0; k < 3; k++)
			expect(g[k]).toBeCloseTo(j.dy[k] - 0.2 * j.dx[k], 12);
	});
});

describe("skylineParallax", () => {
	const eye0: Vec3 = [0, 0, 0];
	const base = syntheticWorld(eye0);
	const photoPose = pose;
	const photo = predictSkylineColumns(base, photoPose, W, H);

	it("a perfect hypothesis has chi2 ~ 0 and is not rejected", () => {
		const r = skylineParallax(photo.row, photo, photoPose);
		expect(r.abstain).toBeNull();
		expect(r.nValid).toBeGreaterThan(300);
		expect(r.reject).toBe(false);
		expect(r.deltaNormM).toBeLessThan(5);
	});

	it("a pure rotation offset is absorbed by the nuisances (chi2_eye ~ 0, not rejected)", () => {
		const rotated = { ...photoPose, pitch: photoPose.pitch + 0.1 };
		const hyp = predictSkylineColumns(base, rotated, W, H);
		const r = skylineParallax(photo.row, hyp, rotated);
		expect(r.abstain).toBeNull();
		expect(r.reject).toBe(false);
		expect(r.chi2Eye).toBeLessThan(SKYPAR.chi2Reject);
	});

	it("recovers a known eye offset from a two-depth skyline (within tolerance) and rejects it", () => {
		const trueEye: Vec3 = [0, 0, 0];
		const hypEye: Vec3 = [45, -25, 6];
		// photo = the true world seen from the true eye; hypothesis horizon from the displaced eye
		const hypHorizon = horizonFromEye(base, trueEye, hypEye);
		const hyp = predictSkylineColumns(hypHorizon, photoPose, W, H);
		const r = skylineParallax(photo.row, hyp, photoPose);
		expect(r.abstain).toBeNull();
		// delta-hat = hypothesis eye - true eye
		const err = Math.hypot(
			r.deltaM[0] - (hypEye[0] - trueEye[0]),
			r.deltaM[1] - (hypEye[1] - trueEye[1]),
			r.deltaM[2] - (hypEye[2] - trueEye[2]),
		);
		const size = Math.hypot(45, 25, 6);
		// first-order model: the radial component is weakly observed, so the tolerance is loose
		expect(err).toBeLessThan(0.8 * size);
		expect(r.deltaNormM).toBeGreaterThan(0.5 * size);
		expect(r.deltaNormM).toBeLessThan(1.5 * size);
		expect(r.chi2Eye).toBeGreaterThan(SKYPAR.chi2Reject);
		expect(r.reject).toBe(true);
	});

	it("abstains without depth diversity and with too few columns", () => {
		const n = base.elevation.length;
		const farOnly: HorizonSamples = {
			step: base.step,
			elevation: base.elevation,
			distance: new Float64Array(n).fill(30000),
		};
		const hyp = predictSkylineColumns(farOnly, photoPose, W, H);
		const r = skylineParallax(hyp.row, hyp, photoPose);
		expect(r.abstain).toBe("no-depth-diversity");
		expect(r.reject).toBe(false);
		const sparse = new Float64Array(W).fill(Number.NaN);
		for (let x = 0; x < 30; x++) sparse[x * 10] = photo.row[x * 10];
		expect(skylineParallax(sparse, photo, photoPose).abstain).toBe(
			"too-few-columns",
		);
	});
});
