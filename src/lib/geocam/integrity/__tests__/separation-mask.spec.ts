// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CR-17: a row-masked subset must not see the masked rows through the cluster whitener (masking has
// to happen before the rows are mixed). CR-49: a subset whose covariance is unbounded fails closed.
import { describe, expect, it } from "vitest";
import { projectX } from "../../../concord/core";
import {
	type CameraX,
	type GeoState,
	IDX,
	type MapProblem,
	type MapResult,
	NP,
	stateFromCameraX,
	type Vec3,
} from "../../core";
import { type Corr2D3D, pointFactor } from "../../map/factors";
import { maskFactor, protectionLevel } from "../separation";

const truth: CameraX = {
	pose: { yaw: 5, pitch: 4, roll: 0.5, vfov: 42 },
	eye: [0, 0, 0],
	aspect: 4 / 3,
	intr: { fScale: 1, k1: 0, cx: 0, cy: 0 },
};

/** Points in one azimuth sector (0–12°) and one distance band (5–15 km) = one DEM cluster. */
function corrs(): Corr2D3D[] {
	const out: Corr2D3D[] = [];
	for (let k = 0; k < 24; k++) {
		const az = (k % 12) + 0.5;
		const d = 6000 + 120 * k;
		const X: Vec3 = [
			d * Math.sin((az * Math.PI) / 180),
			d * Math.cos((az * Math.PI) / 180),
			200 + 25 * (k % 7),
		];
		const q = projectX(truth, X);
		if (!q) continue;
		// small deterministic misfit so residuals are non-zero
		out.push({ u: q.u + 0.0004 * Math.sin(k), v: q.v + 0.0003, world: X });
	}
	return out;
}

const opts = { demSigmaM: () => 10, cluster: { rho: 0.5, sectorDeg: 15 } };

describe("maskFactor with a cluster-whitened factor (CR-17)", () => {
	const cs = corrs();
	const x = stateFromCameraX(truth);
	// keep the left half of the correspondences (both rows of each)
	const keepCorr = (i: number) => i < cs.length / 2;
	const keepRow = (row: number) => keepCorr(row >> 1);

	it("kept rows do not change when a masked observation changes", () => {
		const a = maskFactor(pointFactor(truth, cs, opts), keepRow, "-right");
		const moved = cs.map((c, i) => (keepCorr(i) ? c : { ...c, u: c.u + 0.05 }));
		const b = maskFactor(pointFactor(truth, moved, opts), keepRow, "-right");
		const ra = a.residual(x);
		const rb = b.residual(x);
		for (let i = 0; i < ra.length; i++) {
			if (!keepRow(i)) {
				expect(Number.isNaN(ra[i])).toBe(true);
				continue;
			}
			expect(rb[i]).toBeCloseTo(ra[i], 12);
		}
	});

	it("the masked factor equals the factor built from the kept observations alone", () => {
		const masked = maskFactor(pointFactor(truth, cs, opts), keepRow, "-right");
		const kept = pointFactor(
			truth,
			cs.filter((_, i) => keepCorr(i)),
			opts,
		);
		const rm = masked.residual(x);
		const rk = kept.residual(x);
		for (let i = 0; i < rk.length; i++) expect(rm[i]).toBeCloseTo(rk[i], 12);
	});

	it("the whitening is real: unmasked full residuals differ from the kept-only factor", () => {
		const full = pointFactor(truth, cs, opts).residual(x);
		const kept = pointFactor(
			truth,
			cs.filter((_, i) => keepCorr(i)),
			opts,
		).residual(x);
		let maxDiff = 0;
		for (let i = 0; i < kept.length; i++)
			maxDiff = Math.max(maxDiff, Math.abs(full[i] - kept[i]));
		expect(maxDiff).toBeGreaterThan(1e-6);
	});
});

describe("protectionLevel with unbounded covariance (CR-49)", () => {
	const x0: GeoState = stateFromCameraX(truth);
	const covWith = (yawVar: number) => {
		const cov = new Float64Array(NP * NP);
		for (let k = 0; k < NP; k++) cov[k * NP + k] = 1e-4;
		cov[IDX.yaw * NP + IDX.yaw] = yawVar;
		return cov;
	};
	const result = (cov: Float64Array): MapResult => ({
		x: x0,
		cam: truth,
		cov,
		sigma: {} as MapResult["sigma"],
		sigmaEN: 0.01,
		perFamily: [],
		mad: 1,
		iterations: 1,
		outer: 1,
		converged: true,
		ms: 0,
	});
	const p: MapProblem = {
		base: truth,
		f0Px1600: 1000,
		factors: [pointFactor(truth, corrs(), opts)],
		free: { rotation: true, focal: false, eye: false },
	};
	const subsets = [{ name: "-x", factors: p.factors }];

	it("yaw unobservable in the full and the subset solve (∞ − ∞) fails, not passes", async () => {
		const inf = Number.POSITIVE_INFINITY;
		const pl = await protectionLevel(p, result(covWith(inf)), {
			subsets,
			solve: async () => result(covWith(inf)),
		});
		expect(pl.plYawDeg).toBe(inf);
		expect(pl.pass).toBe(false);
	});
	it("yaw unobservable only in the subset fails", async () => {
		const pl = await protectionLevel(p, result(covWith(1e-6)), {
			subsets,
			solve: async () => result(covWith(Number.POSITIVE_INFINITY)),
		});
		expect(pl.subsets[0].sepYawDeg).toBe(Number.POSITIVE_INFINITY);
		expect(pl.pass).toBe(false);
	});
	it("finite covariances: unchanged pass", async () => {
		const pl = await protectionLevel(p, result(covWith(1e-6)), {
			subsets,
			solve: async () => result(covWith(2e-6)),
		});
		expect(pl.subsets[0].sepYawDeg).toBeCloseTo(1e-3, 9);
		expect(pl.pass).toBe(true);
	});
});
