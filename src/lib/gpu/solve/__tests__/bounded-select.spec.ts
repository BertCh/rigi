// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { HorizonProfile } from "#/lib/geo/horizon";
import { type CoarsePlan, coarseCpu, coarseRow } from "../cpu";
import {
	type CoarseGpuStats,
	costBound,
	packCoarse,
	priorYaw,
	profileHz,
	rowsDigest,
	selectBounded,
} from "../index";

const horizon = (): HorizonProfile => {
	const n = 360;
	const elevation = Float32Array.from(
		{ length: n },
		(_, i) => 5 + 3 * Math.sin((i / n) * 6 * Math.PI) + (i % 7) * 0.05,
	);
	return { step: 1, elevation, distance: new Float32Array(n), ridges: [] };
};

const plan = (): CoarsePlan => {
	const h = horizon();
	const az: number[] = [];
	const el: number[] = [];
	const w: number[] = [];
	// observations: the profile seen at a 3 degree yaw offset and a 0.5 degree pitch offset
	for (let i = 0; i < 80; i++) {
		const a = 100 + i * 0.7;
		az.push(a - 3);
		el.push(h.elevation[Math.floor(a) % 360] - 0.5 + 0.02 * Math.sin(i));
		w.push(1 + (i % 3) * 0.25);
	}
	const dys: number[] = [];
	for (let dy = -10; dy <= 10 + 1e-9; dy += 0.5) dys.push(dy);
	const dps: number[] = [];
	for (let dp = -2; dp <= 2 + 1e-9; dp += 0.25) dps.push(dp);
	return {
		horizon: h,
		az,
		el,
		w,
		wSum: w.reduce((s, x) => s + x, 0),
		trunc: 1,
		dys,
		dps,
		sigmaYaw: 25,
		sigmaPitch: 3,
	};
};

const freshStats = (eps: number): CoarseGpuStats => ({
	uploadMs: 0,
	gpuMs: 0,
	selectMs: 0,
	nCells: 0,
	rescored: 0,
	rescoredCells: 0,
	eps,
	maxErr: 0,
	fellBack: false,
	readBytes: 0,
});

describe("profileHz", () => {
	it("appends the wrap sample", () => {
		const hz = profileHz(horizon());
		expect(hz?.length).toBe(361);
		expect(hz?.[360]).toBe(hz?.[0]);
	});
	it("refuses partial circles and non-finite elevations", () => {
		const h = horizon();
		expect(profileHz({ ...h, step: 0.9 })).toBeNull();
		const bad = horizon();
		bad.elevation[5] = Number.NaN;
		expect(profileHz(bad)).toBeNull();
	});
});

describe("costBound / priorYaw", () => {
	it("priorYaw is quadratic in the offset and scales with trunc", () => {
		const p = plan();
		expect(priorYaw(p, 0)).toBe(0);
		expect(priorYaw(p, 10)).toBeCloseTo(4 * priorYaw(p, 5), 12);
	});
	it("costBound is a small positive number that grows with the observation count", () => {
		const p = plan();
		const hz = profileHz(p.horizon) as Float32Array;
		const b = costBound(p, hz);
		expect(b).toBeGreaterThan(0);
		expect(b).toBeLessThan(1e-3);
		const more = { ...p, az: [...p.az, ...p.az, ...p.az] };
		expect(costBound(more, hz)).toBeGreaterThan(b);
	});
});

describe("rowsDigest", () => {
	it("is deterministic, 8 hex digits, and sensitive to every input", () => {
		const g = Float64Array.from([1, 2, 3]);
		const from = Int32Array.from([0, 1, 2]);
		const to = Int32Array.from([3, 4, 5]);
		const d = rowsDigest(g, from, to);
		expect(d).toMatch(/^[0-9a-f]{8}$/);
		expect(rowsDigest(g, from, to)).toBe(d);
		expect(rowsDigest(Float64Array.from([1, 2, 3.5]), from, to)).not.toBe(d);
		expect(rowsDigest(g, Int32Array.from([0, 1, 3]), to)).not.toBe(d);
		expect(rowsDigest(g, from, Int32Array.from([3, 4, 6]))).not.toBe(d);
	});
});

describe("packCoarse", () => {
	it("packs observations as (bin, fraction, el, w) and rows as (bin, fraction, prior)", () => {
		const p = plan();
		const r = packCoarse(p, {});
		expect(r).not.toBeNull();
		if (!r) return;
		expect(r.nObs).toBe(80);
		expect(r.nYaw).toBe(p.dys.length);
		expect(r.nPitch).toBe(p.dps.length);
		expect(r.nBlk).toBe(1);
		const obF = new Float32Array(r.obU.buffer);
		const t = (((p.az[0] % 360) + 360) % 360) / p.horizon.step;
		expect(r.obU[0]).toBe(Math.floor(t));
		expect(obF[1]).toBeCloseTo(t - Math.floor(t), 6);
		expect(obF[3]).toBeCloseTo(p.w[0], 6);
		// negative yaw offsets wrap into 0..nH-1
		for (let k = 0; k < r.nYaw; k++) expect(r.yU[k * 4]).toBeLessThan(r.nH);
		expect(r.pitch[0]).toBeCloseTo(p.dps[0], 6);
		expect(r.ub.byteLength).toBe(32);
	});
	it("the uniform epsilon is 2.5 eps and eps scales with epsScale", () => {
		const p = plan();
		const a = packCoarse(p, {});
		const b = packCoarse(p, { epsScale: 10 });
		expect(a && b && b.eps / a.eps).toBeCloseTo(10, 6);
		expect(new Float32Array(a?.ub as ArrayBuffer)[7]).toBeCloseTo(
			2.5 * (a?.eps ?? 0),
			10,
		);
		// epsScale < 1 never narrows the certified bound
		expect(packCoarse(p, { epsScale: 0.1 })?.eps).toBe(a?.eps);
	});
	it("returns null for a partial circle, an empty pitch axis, or a NaN profile", () => {
		const p = plan();
		expect(
			packCoarse({ ...p, horizon: { ...p.horizon, step: 2 } }, {}),
		).toBeNull();
		expect(packCoarse({ ...p, dps: [] }, {})).toBeNull();
		const el = Float32Array.from(p.horizon.elevation);
		el[0] = Number.NaN;
		expect(
			packCoarse({ ...p, horizon: { ...p.horizon, elevation: el } }, {}),
		).toBeNull();
	});
});

describe("selectBounded", () => {
	const p = plan();
	const exactRows = p.dys.map((_, i) => coarseRow(p, i));
	const g = Float64Array.from(exactRows.map((r) => r.c));
	const full = (v: number) => Int32Array.from(p.dys, () => v);
	const from = full(0);
	const to = full(p.dps.length - 1);

	it("matches the CPU reference when the GPU values are exact", () => {
		const want = coarseCpu(p);
		const stats = freshStats(1e-6);
		const got = selectBounded(p, g, from, to, stats);
		expect(got.coarse).toEqual(want.coarse);
		expect(got.seeds.map((s) => s.dy)).toEqual(want.seeds.map((s) => s.dy));
		expect(got.medianCost).toBe(want.medianCost);
		expect(got.nYaw).toBe(want.nYaw);
		expect(stats.rescored).toBeGreaterThan(0);
		expect(stats.rescored).toBeLessThan(p.dys.length);
		expect(stats.maxErr).toBeLessThanOrEqual(1e-12);
	});
	it("still matches when the GPU values carry error within eps, with more rows re-scored", () => {
		const want = coarseCpu(p);
		const eps = 0.02;
		const noisy = Float64Array.from(
			g,
			(v, i) => v + eps * 0.9 * Math.sin(i * 12.9898),
		);
		const tight = freshStats(1e-6);
		selectBounded(p, g, from, to, tight);
		const wide = freshStats(eps);
		const got = selectBounded(p, noisy, from, to, wide);
		expect(got.coarse).toEqual(want.coarse);
		expect(got.medianCost).toBe(want.medianCost);
		expect(wide.rescored).toBeGreaterThan(tight.rescored);
		expect(wide.maxErr).toBeLessThanOrEqual(eps);
	});
	it("rejects an empty pitch band for a row it has to re-score", () => {
		const badFrom = Int32Array.from(from);
		const badTo = Int32Array.from(to);
		const best = g.indexOf(Math.min(...g));
		badFrom[best] = 5;
		badTo[best] = 2;
		expect(() => selectBounded(p, g, badFrom, badTo, freshStats(1e-6))).toThrow(
			/empty pitch band/,
		);
	});
});
