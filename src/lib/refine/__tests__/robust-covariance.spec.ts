// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CR-36: the covariance (info) and the returned IRLS weights belong to the ACCEPTED pose, not to the
// iterate before the last LM step.
import { describe, expect, it } from "vitest";
import { cameraFromAngles, resizeCamera } from "../../geo/camera";
import type { HorizonProfile } from "../../geo/horizon";
import { projectSkylineRows } from "../../geo/solve";
import {
	columnsFromSkyline,
	DEG,
	type Geometry,
	PITCH,
	paramsFromCamera,
	YAW,
} from "../model";
import { defaultRobustOptions, refineRobust } from "../robust";

const TUKEY_C = 4.685;
const tukeyWeight = (z: number) =>
	Math.abs(z) >= TUKEY_C ? 0 : (1 - (z / TUKEY_C) ** 2) ** 2;

function profile(): HorizonProfile {
	const step = 0.25;
	const n = 1440;
	const elevation = new Float32Array(n);
	const distance = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const az = i * step;
		elevation[i] =
			2 +
			1.5 * Math.sin((az * Math.PI) / 23) +
			1.0 * Math.sin((az * Math.PI) / 7 + 2) +
			5 * Math.exp(-(((az - 150) / 3) ** 2)) +
			3 * Math.exp(-(((az - 172) / 2) ** 2));
		distance[i] = 6000 + 4000 * Math.sin((az * Math.PI) / 61) ** 2;
	}
	return {
		step,
		elevation,
		distance,
		ridges: Array.from({ length: n }, () => []),
	};
}

const W = 800;
const H = 600;

function problem() {
	const truth = cameraFromAngles({
		width: W,
		height: H,
		f: 900,
		yaw: 150,
		pitch: 2,
		roll: 0.5,
	});
	const horizon = profile();
	// a smooth 2 px skyline error: residuals of order σ (so ψ(z)/z varies across columns) without the
	// local roughness that would trigger run rejection
	const rows = Float32Array.from(
		projectSkylineRows(truth, horizon, W),
		(r, x) => r + 2 * Math.sin(x / 40),
	);
	const cols = columnsFromSkyline({
		rows,
		weight: Float32Array.from(rows, (r) => (Number.isFinite(r) ? 1 : 0)),
		width: W,
	});
	const prior = resizeCamera(
		cameraFromAngles({
			width: W,
			height: H,
			f: 900,
			yaw: 148.5,
			pitch: 1.4,
			roll: 0,
		}),
		W,
	);
	const geom: Geometry = {
		width: W,
		height: H,
		cx: prior.cx,
		cy: prior.cy,
		f0: prior.f,
	};
	const priorState = paramsFromCamera(prior, prior.f);
	return { prob: { geom, cols, horizon, prior: priorState }, priorState };
}

describe("refineRobust covariance (CR-36)", () => {
	it("returns weights ψ(z)/z of the residuals at the returned pose", () => {
		const { prob, priorState } = problem();
		// one LM step per stage: the last accepted step always moves the pose after the weights were
		// formed, which is where the stale weights showed up
		const opts = defaultRobustOptions({ maxIterations: 1, ransac: false });
		const res = refineRobust(prob, priorState, opts);
		// the start was off by 1.5° in yaw: the pose moved
		expect(Math.abs(res.p[YAW] - priorState[YAW]) / DEG).toBeGreaterThan(0.1);
		expect(Number.isFinite(res.p[PITCH])).toBe(true);
		// smooth skyline error: no run rejection (extra = 1), so ω_i·(σ_i·ŝ)² / ψ(z_i) is the same
		// constant (dataScale · w) for every column with non-zero weight
		const ratios: number[] = [];
		for (let i = 0; i < res.weights.length; i++) {
			const z = res.residuals[i] / res.sigma[i] / res.scale;
			const psi = tukeyWeight(z);
			if (psi === 0) {
				expect(res.weights[i]).toBe(0);
				continue;
			}
			ratios.push((res.weights[i] * (res.sigma[i] * res.scale) ** 2) / psi);
		}
		expect(ratios.length).toBeGreaterThan(50);
		const r0 = ratios[0];
		for (const r of ratios) expect(Math.abs(r / r0 - 1)).toBeLessThan(1e-9);
	});
});
