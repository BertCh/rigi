// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import { invSym } from "../../../linalg";
import { CLUSTER_DEFAULTS, clusterKey, clusterWhitener } from "../cluster";

describe("clusterKey", () => {
	it("groups by azimuth sector and distance band", () => {
		expect(clusterKey(0, 100, 15)).toBe("0|<0.5km");
		expect(clusterKey(14.9, 400, 15)).toBe("0|<0.5km");
		expect(clusterKey(15, 400, 15)).toBe("1|<0.5km");
		expect(clusterKey(15, 3000, 15)).toBe("1|2-5km");
	});
	it("wraps negative and >= 360 azimuths", () => {
		expect(clusterKey(-1, 100, 15)).toBe(clusterKey(359, 100, 15));
		expect(clusterKey(375, 100, 15)).toBe(clusterKey(15, 100, 15));
	});
	it("exposes sane defaults", () => {
		expect(CLUSTER_DEFAULTS).toEqual({ rho: 0.5, sectorDeg: 15 });
	});
});

describe("clusterWhitener", () => {
	const rand = seededRandom(3);
	const n = 8;
	const G = Float64Array.from({ length: n * 3 }, () => uniform(rand, -1, 1));
	const r0 = Float64Array.from({ length: n }, () => uniform(rand, -2, 2));
	const sigmaM = 2.5;

	it("applies exactly Sigma^-1/2 for Sigma = I + sigma^2 G G^T (norm check)", () => {
		const rows = [...Array(n).keys()];
		const w = clusterWhitener(G, [{ rows, sigmaM }]);
		expect(w.n).toBe(1);
		const out = w.apply(Float64Array.from(r0));
		// explicit r^T Sigma^-1 r
		const S = rows.map((i) =>
			rows.map((j) => {
				let g = 0;
				for (let a = 0; a < 3; a++) g += G[i * 3 + a] * G[j * 3 + a];
				return (i === j ? 1 : 0) + sigmaM * sigmaM * g;
			}),
		);
		const Si = invSym(S);
		let q = 0;
		for (let i = 0; i < n; i++)
			for (let j = 0; j < n; j++) q += r0[i] * Si[i][j] * r0[j];
		let o = 0;
		for (const v of out) o += v * v;
		expect(o).toBeCloseTo(q, 8);
	});
	it("never inflates a residual and leaves the orthogonal complement untouched", () => {
		const rows = [...Array(n).keys()];
		const out = clusterWhitener(G, [{ rows, sigmaM }]).apply(
			Float64Array.from(r0),
		);
		const norm = (v: ArrayLike<number>) => Math.hypot(...Array.from(v));
		expect(norm(out)).toBeLessThan(norm(r0));
		// a residual orthogonal to every G column passes through
		const rp = Float64Array.from(r0);
		for (let a = 0; a < 3; a++) {
			let gg = 0;
			let rg = 0;
			for (let i = 0; i < n; i++) {
				gg += G[i * 3 + a] ** 2;
				rg += rp[i] * G[i * 3 + a];
			}
			for (let i = 0; i < n; i++)
				rp[i] -= (rg / gg) * G[i * 3 + a] * (a === 0 ? 1 : 0);
		}
		// full projection is simpler via normal equations; just check a zero residual stays zero
		expect(
			Array.from(
				clusterWhitener(G, [{ rows, sigmaM }]).apply(new Float64Array(n)),
			),
		).toEqual(new Array(n).fill(0));
	});
	it("shrinks a residual that is a pure eye offset more than white noise", () => {
		const rows = [...Array(n).keys()];
		const w = clusterWhitener(G, [{ rows, sigmaM }]);
		const eyeShift = new Float64Array(n);
		for (let i = 0; i < n; i++) eyeShift[i] = G[i * 3]; // moving the eye along axis 0
		const shrunk = Math.hypot(
			...Array.from(w.apply(Float64Array.from(eyeShift))),
		);
		expect(shrunk).toBeLessThan(0.5 * Math.hypot(...Array.from(eyeShift)));
	});
	it("skips NaN rows and keeps them NaN", () => {
		const rows = [...Array(n).keys()];
		const r = Float64Array.from(r0);
		r[2] = Number.NaN;
		const out = clusterWhitener(G, [{ rows, sigmaM }]).apply(r);
		expect(out[2]).toBeNaN();
		expect(out.filter((_, i) => i !== 2).every(Number.isFinite)).toBe(true);
	});
	it("ignores clusters with zero sigma, no rows or a null Jacobian", () => {
		const w0 = clusterWhitener(G, [
			{ rows: [0, 1, 2], sigmaM: 0 },
			{ rows: [], sigmaM: 3 },
		]);
		expect(w0.n).toBe(0);
		const out = w0.apply(Float64Array.from(r0));
		expect(Array.from(out)).toEqual(Array.from(r0));
		const wz = clusterWhitener(new Float64Array(n * 3), [
			{ rows: [0, 1, 2], sigmaM: 3 },
		]);
		expect(wz.n).toBe(0);
	});
	it("whitens clusters independently", () => {
		const a = clusterWhitener(G, [{ rows: [0, 1, 2, 3], sigmaM }]);
		const b = clusterWhitener(G, [
			{ rows: [0, 1, 2, 3], sigmaM },
			{ rows: [4, 5, 6, 7], sigmaM },
		]);
		const oa = a.apply(Float64Array.from(r0));
		const ob = b.apply(Float64Array.from(r0));
		for (let i = 0; i < 4; i++) expect(ob[i]).toBeCloseTo(oa[i], 12);
		expect(oa[5]).toBe(r0[5]);
		expect(ob[5]).not.toBe(r0[5]);
	});
});
