// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	arangeF,
	BINS,
	boxNearest,
	camera,
	type EdgeInputs,
	fitSky,
	horizonProfile,
	pairwiseSumF32,
	pyRound,
	SkyGlobal,
	scanLabels,
	scoreMap,
} from "../cpu";

describe("numpy twins", () => {
	it("pyRound rounds half to even", () => {
		expect([0.5, 1.5, 2.5, -0.5, -1.5, 2.4, 2.6].map(pyRound)).toEqual([
			0, 2, 2, -0, -2, 2, 3,
		]);
	});
	it("arangeF follows numpy's length and values", () => {
		expect(arangeF(0, 1, 0.25)).toEqual([0, 0.25, 0.5, 0.75]);
		expect(arangeF(-1, 1 + 1e-9, 0.5)).toHaveLength(5);
		expect(arangeF(3, 3, 1)).toEqual([]);
		expect(arangeF(0, 0.5, 1)).toEqual([0]);
	});
	it("pairwiseSumF32 is exact on small integers and covers every branch", () => {
		for (const n of [0, 3, 8, 13, 128, 129, 300, 1000]) {
			const a = new Float32Array(n + 2).fill(1);
			expect(pairwiseSumF32(a, 1, n)).toBe(n);
		}
		const a = Float32Array.from({ length: 500 }, (_, i) =>
			Math.fround(0.1 * (i % 7)),
		);
		const exact = a.reduce((s, v) => s + v, 0);
		expect(Math.abs(pairwiseSumF32(a, 0, 500) - exact)).toBeLessThan(1e-2);
	});
	it("boxNearest preserves constants and smooths an impulse", () => {
		const w = 7;
		const h = 5;
		const flat = new Float64Array(w * h).fill(2);
		expect(Array.from(boxNearest(flat, w, h, 1))).toEqual(Array.from(flat));
		const imp = new Float64Array(w * h);
		imp[2 * w + 3] = 9;
		const out = boxNearest(imp, w, h, 1);
		expect(out[2 * w + 3]).toBeCloseTo(1, 12);
		expect(out.reduce((s, v) => s + v, 0)).toBeCloseTo(9, 9);
	});
	it("horizonProfile keeps the max per bin, fills gaps by wrapped interpolation", () => {
		const az = new Float64Array(40);
		const el = new Float64Array(40);
		for (let i = 0; i < 40; i++) {
			az[i] = i * 9 + 1;
			el[i] = i;
		}
		const p = horizonProfile(az, el, 9);
		expect(p).not.toBeNull();
		expect(p?.length).toBe(40);
		expect(p?.[5]).toBe(5);
		expect(
			horizonProfile(new Float64Array([1, 2]), new Float64Array([1, 2]), 1),
		).toBeNull();
		// two samples in one bin: the higher wins; a missing bin is interpolated
		const sparse = horizonProfile(
			new Float64Array([
				0.5, 0.6, 2.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5,
			]),
			new Float64Array([1, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
			1,
		);
		expect(sparse?.[0]).toBe(3);
		expect(sparse?.[1]).toBeCloseTo(2.5, 9);
	});
	it("camera basis is orthonormal", () => {
		const c = camera(10, 5, 40, 1.5);
		const dot = (a: number[], b: number[]) =>
			a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
		const f = [c.fx, c.fy, c.fz];
		const r = [c.rx, c.ry, c.rz];
		const u = [c.ux, c.uy, c.uz];
		expect(dot(f, f)).toBeCloseTo(1, 12);
		expect(dot(f, r)).toBeCloseTo(0, 12);
		expect(dot(f, u)).toBeCloseTo(0, 12);
		expect(dot(r, u)).toBeCloseTo(0, 12);
		expect(c.ta).toBeCloseTo(c.t * 1.5, 12);
	});
});

const D = Math.PI / 180;
const W = 64;
const H2 = 40;
const ridge = (az: number) =>
	4 + 3 * Math.sin(az * 5 * D) + 2 * Math.sin(az * 13 * D + 1);

function scene(
	truth = { yaw: 120, pitch: 2, roll: 0, vfov: 40 },
	aspect = W / H2,
) {
	const n = 1440;
	const dirs = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		const az = (i / n) * 360;
		const el = ridge(az) * D;
		dirs[i * 3] = Math.sin(az * D) * Math.cos(el);
		dirs[i * 3 + 1] = Math.cos(az * D) * Math.cos(el);
		dirs[i * 3 + 2] = Math.sin(el);
	}
	const c = camera(truth.pitch, truth.roll, truth.vfov, aspect);
	const rows = new Float32Array(W).fill(-1);
	for (let i = 0; i < n; i++) {
		const a = ((i / n) * 360 - truth.yaw) * D;
		const el = ridge((i / n) * 360) * D;
		const dx = Math.sin(a) * Math.cos(el);
		const dy = Math.cos(a) * Math.cos(el);
		const dz = Math.sin(el);
		const z = dx * c.fx + dy * c.fy + dz * c.fz;
		if (z <= 0.1) continue;
		const u = 0.5 + (dx * c.rx + dy * c.ry + dz * c.rz) / z / c.ta / 2;
		const v = 0.5 - (dx * c.ux + dy * c.uy + dz * c.uz) / z / c.t / 2;
		const col = Math.floor(u * W);
		if (col >= 0 && col < W) rows[col] = v * H2;
	}
	const rgb = new Uint8Array(W * H2 * 3);
	const fine = new Float32Array(W * H2);
	const coarse = new Float32Array(W * H2);
	for (let y = 0; y < H2; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			const r = rows[x] < 0 ? H2 / 2 : rows[x];
			rgb.set(y < r ? [110, 150, 230] : [90, 80, 60], i * 3);
			const d = y - r;
			fine[i] = Math.exp(-(d * d) / 3);
			coarse[i] = Math.exp(-(d * d) / 30);
		}
	const ed: EdgeInputs = {
		w: W,
		h: H2,
		dirs,
		fine,
		coarse,
		fg: new Float32Array(W * H2),
		rgb,
	};
	return { ed, aspect, truth };
}

describe("labels and sky model", () => {
	const { ed } = scene();
	it("scanLabels marks the sky above the colour stop and terrain below", () => {
		const lbl = scanLabels(ed.rgb, ed.fg, W, H2);
		expect(lbl).toHaveLength(W * H2);
		expect(lbl[0]).toBe(1);
		expect(lbl[(H2 - 1) * W + 5]).toBe(-1);
	});
	it("fitSky gives high P(sky) in the sky and low below the ridge", () => {
		const lbl = scanLabels(ed.rgb, ed.fg, W, H2);
		const sky = fitSky(ed.rgb, ed.fg, lbl, W, H2);
		expect(sky[0]).toBeGreaterThan(0.8);
		expect(sky[(H2 - 1) * W + 5]).toBeLessThan(0.2);
		expect(BINS).toBe(12);
	});
	it("scoreMap rewards sky-above / terrain-below edges, kills foreground", () => {
		const lbl = scanLabels(ed.rgb, ed.fg, W, H2);
		const sky = fitSky(ed.rgb, ed.fg, lbl, W, H2);
		const s = scoreMap(ed.fine, sky, ed.fg, W, H2, true);
		expect(Math.max(...s)).toBeGreaterThan(0.5);
		const fg = new Float32Array(W * H2).fill(1);
		expect(Math.max(...scoreMap(ed.fine, sky, fg, W, H2, false))).toBe(0);
	});
});

describe("SkyGlobal search", () => {
	const { ed, aspect, truth } = scene();
	const sg = new SkyGlobal(ed, aspect);
	it("scores the true pose above wrong ones, and 0 off-screen", () => {
		const at = sg.scorePose(truth);
		expect(at).toBeGreaterThan(sg.scorePose({ ...truth, yaw: truth.yaw + 25 }));
		expect(at).toBeGreaterThan(
			sg.scorePose({ ...truth, pitch: truth.pitch + 6 }),
		);
		expect(sg.scorePose({ ...truth, pitch: 85 })).toBe(0);
		expect(sg.evals).toBe(4);
	});
	it("plan -> grid -> peaks -> polish recovers the pose", () => {
		const plan = sg.plan(truth.vfov, true, 3, 1.5, 1);
		expect(plan).not.toBeNull();
		if (!plan) return;
		expect(plan.vfovs).toHaveLength(3);
		expect(plan.combos.length).toBe(
			plan.vfovs.length * plan.pitches.length * plan.rolls.length,
		);
		const full = new Float64Array(plan.combos.length * plan.nYaw);
		const r = sg.gridCpu(plan, full);
		// the winning combo per yaw is the max of the full grid column
		for (const iy of [0, 17, plan.nYaw - 1]) {
			let m = Number.NEGATIVE_INFINITY;
			for (let ci = 0; ci < plan.combos.length; ci++)
				m = Math.max(m, full[ci * plan.nYaw + iy]);
			expect(r.best[iy]).toBe(m);
		}
		const pk = sg.peaks(plan, r, truth.vfov, 3);
		expect(pk.length).toBeGreaterThan(0);
		expect(pk.length).toBeLessThanOrEqual(6);
		for (let i = 1; i < pk.length; i++)
			expect(pk[i].coarse).toBeLessThanOrEqual(pk[i - 1].coarse);
		const hyps = sg.polish(pk, truth.vfov, true, 3);
		expect(hyps.length).toBeGreaterThan(0);
		const top = hyps[0];
		const dy = Math.abs(((top.pose.yaw - truth.yaw + 540) % 360) - 180);
		expect(dy).toBeLessThan(3);
		expect(hyps.length).toBeLessThanOrEqual(3);
		for (let i = 1; i < hyps.length; i++)
			expect(hyps[i].score).toBeLessThanOrEqual(hyps[i - 1].score);
	});
	it("refine never lowers the score", () => {
		const start = { ...truth, yaw: truth.yaw + 1.5 };
		const [p, s] = sg.refine(start, null, 0.08, true);
		expect(s).toBeGreaterThanOrEqual(sg.scorePose(start));
		expect(Math.abs(p.yaw - truth.yaw)).toBeLessThan(1.5);
	});
	it("a profile with too few bins refuses to plan", () => {
		const tiny = { ...ed, dirs: ed.dirs.slice(0, 15) };
		expect(new SkyGlobal(tiny, aspect).plan(40, true)).toBeNull();
	});
});
