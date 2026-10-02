// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { angleDiffDeg, seededRandom, uniform } from "#/test/helpers";
import type { Pose } from "../../camera";
import { dirFromAzEl, project, unproject } from "../project";
import {
	ladder,
	paramsPose,
	residualsPx,
	solvePose6dof,
	toParams,
} from "../solve";
import type { Correspondence, Priors, SolveOptions } from "../types";

const ASPECT = 1.5;
const W = 1500;
const truth: Pose = { yaw: 40, pitch: 4, roll: 1.5, vfov: 45 };
const eye: [number, number, number] = [0, 0, 0];
const opts: SolveOptions = {
	aspect: ASPECT,
	imageWidth: W,
	sigmaPx: 1,
	seed: 3,
};

const dirCorrAt = (
	az: number,
	el: number,
	p: Pose = truth,
	e = eye,
): Correspondence | null => {
	const d = dirFromAzEl(az, el);
	const pr = project(p, ASPECT, e, { dir: d });
	return pr ? { kind: "dir", u: pr.u, v: pr.v, dir: [d[0], d[1], d[2]] } : null;
};
const dirs = (): Correspondence[] =>
	[
		[25, 5],
		[33, 12],
		[41, 2],
		[50, 9],
		[56, 4],
		[46, 14],
	].map(([az, el]) => dirCorrAt(az, el) as Correspondence);

const priors = (over: Partial<Priors> = {}): Priors => ({
	position: { value: [0, 0, 0], sigmaH: 0, sigmaV: 0 },
	yaw: { value: 30, sigma: 30 },
	pitch: { value: 2, sigma: 5 },
	roll: { value: 0, sigma: 5 },
	vfov: { value: 50, sigma: 10 },
	...over,
});

describe("toParams / paramsPose", () => {
	it("round trip", () => {
		const p = toParams(truth, [1, 2, 3]);
		expect(p).toEqual([1, 2, 3, 40, 4, 1.5, 45]);
		expect(paramsPose(p)).toEqual(truth);
	});
});

describe("residualsPx", () => {
	it("is zero for the true pose and grows with a yaw error", () => {
		const cs = dirs();
		for (const r of residualsPx(cs, truth, eye, ASPECT, W))
			expect(r).toBeLessThan(1e-9);
		const off = residualsPx(
			cs,
			{ ...truth, yaw: truth.yaw + 1 },
			eye,
			ASPECT,
			W,
		);
		const fpx = W / ASPECT / 2 / Math.tan((truth.vfov * Math.PI) / 360);
		for (const r of off) expect(r).toBeGreaterThan(0.5 * fpx * (Math.PI / 180));
	});
	it("is NaN for points behind the camera", () => {
		const behind: Correspondence = {
			kind: "dir",
			u: 0.5,
			v: 0.5,
			dir: [0, 0, 1],
		};
		const r = residualsPx(
			[behind],
			{ yaw: 0, pitch: 0, roll: 0, vfov: 40 },
			eye,
			ASPECT,
			W,
		);
		expect(r[0]).toBeNaN();
	});
	it("level correspondences report the vertical miss in px", () => {
		const d = unproject(truth, ASPECT, 0.5, 0.3);
		const elTrue = (Math.asin(d[2]) * 180) / Math.PI;
		const c: Correspondence = { kind: "level", u: 0.5, v: 0.3, el: elTrue };
		expect(residualsPx([c], truth, eye, ASPECT, W)[0]).toBeLessThan(1e-6);
		const c2: Correspondence = { ...c, el: elTrue + 1 };
		const fpx = W / ASPECT / 2 / Math.tan((truth.vfov * Math.PI) / 360);
		expect(residualsPx([c2], truth, eye, ASPECT, W)[0]).toBeCloseTo(
			(fpx * Math.PI) / 180,
			3,
		);
	});
	it("azimuth correspondences wrap through north", () => {
		const p: Pose = { yaw: 359, pitch: 0, roll: 0, vfov: 40 };
		const d = unproject(p, ASPECT, 0.5, 0.5);
		const c: Correspondence = { kind: "azimuth", u: 0.5, v: 0.5, az: 359 };
		expect(Number.isFinite(d[0])).toBe(true);
		expect(residualsPx([c], p, eye, ASPECT, W)[0]).toBeLessThan(1e-6);
		expect(residualsPx([{ ...c, az: 1 }], p, eye, ASPECT, W)[0]).toBeLessThan(
			80,
		);
	});
});

describe("ladder", () => {
	const o: SolveOptions = { aspect: ASPECT, imageWidth: W, sigmaPx: 1 };
	const mk = (kinds: Correspondence["kind"][]): Correspondence[] =>
		kinds.map((k, i) =>
			k === "point"
				? { kind: "point", u: 0.5, v: 0.5, world: [i, 1000, 0] }
				: k === "dir"
					? { kind: "dir", u: 0.5, v: 0.5, dir: [0, 1, 0] }
					: k === "level"
						? { kind: "level", u: 0.5, v: 0.5, el: 0 }
						: { kind: "azimuth", u: 0.5, v: 0.5, az: 0 },
		);
	const run = (
		cs: Correspondence[],
		opt = o,
		par?: number[],
		held?: boolean[],
	) =>
		ladder(
			cs,
			cs.map(() => true),
			opt,
			par,
			held,
		);
	const names = ["dx", "dy", "dz", "yaw", "pitch", "roll", "vfov"];
	const on = (l: ReturnType<typeof ladder>) =>
		names.filter((_, i) => l.active[i]);

	it("one bearing: yaw and pitch only", () => {
		expect(on(run(mk(["dir"])))).toEqual(["yaw", "pitch"]);
	});
	it("a lone level point only gives pitch", () => {
		expect(on(run(mk(["level"])))).toEqual(["pitch"]);
	});
	it("two bearings unlock roll, three unlock vfov", () => {
		expect(on(run(mk(["dir", "dir"])))).toEqual(["yaw", "pitch", "roll"]);
		expect(on(run(mk(["dir", "dir", "dir"])))).toEqual([
			"yaw",
			"pitch",
			"roll",
			"vfov",
		]);
	});
	it("levels and azimuths count as half points", () => {
		const l = run(mk(["dir", "level", "azimuth"]));
		expect(l.nEff).toBe(2);
		expect(on(l)).toContain("roll");
		expect(on(l)).not.toContain("vfov");
	});
	it("solveFov=false keeps vfov fixed", () => {
		expect(
			on(run(mk(["dir", "dir", "dir"]), { ...o, solveFov: false })),
		).not.toContain("vfov");
	});
	it("position needs >= 4 effective, >= 3 finite points and observable parallax", () => {
		const four = mk(["point", "point", "point", "point"]);
		const l = run(four);
		expect(on(l)).toEqual(names);
		expect(l.nFinite).toBe(4);
		// no parallax => locked
		expect(on(run(four, o, [0, 0, 0, 0]))).not.toContain("dx");
		// enough parallax => unlocked
		expect(on(run(four, o, [0, 0, 5, 0]))).toContain("dx");
		// only directions: never
		expect(on(run(mk(["dir", "dir", "dir", "dir", "dir"])))).not.toContain(
			"dx",
		);
		expect(on(run(mk(["point", "point", "dir", "dir"])))).not.toContain("dx");
		expect(on(run(four, { ...o, solvePosition: false }))).not.toContain("dx");
	});
	it("relax kicks in only when position is active and many finite points", () => {
		const six = mk(Array(6).fill("point"));
		expect(run(six).relax).toBe(true);
		expect(run(mk(Array(5).fill("point"))).relax).toBe(false);
		expect(run(six, { ...o, solvePosition: false }).relax).toBe(false);
	});
	it("held parameters are removed and forceParams overrides the ladder", () => {
		const cs = mk(["dir", "dir", "dir"]);
		const held = [false, false, false, false, true, false, false];
		expect(on(run(cs, o, undefined, held))).toEqual(["yaw", "roll", "vfov"]);
		expect(on(run(cs, { ...o, forceParams: ["yaw", "vfov"] }))).toEqual([
			"yaw",
			"vfov",
		]);
	});
});

describe("solvePose6dof", () => {
	it("recovers orientation from direction correspondences (position held)", () => {
		const r = solvePose6dof(dirs(), priors(), opts);
		expect(angleDiffDeg(r.pose.yaw, truth.yaw)).toBeLessThan(0.05);
		expect(r.pose.pitch).toBeCloseTo(truth.pitch, 1);
		expect(r.pose.roll).toBeCloseTo(truth.roll, 1);
		expect(r.pose.vfov).toBeCloseTo(truth.vfov, 0);
		expect(r.rmsPx).toBeLessThan(0.5);
		expect(r.eyeOffset).toEqual([0, 0, 0]);
		expect(r.inliers.every(Boolean)).toBe(true);
		expect(r.residualsPx).toHaveLength(6);
		expect(r.activeParams).toContain("yaw");
		expect(r.activeParams).not.toContain("dx");
		expect(r.sigma.dx).toBe(0);
		expect(r.covariance.length).toBe(r.activeParams.length);
	});
	it("is deterministic for a given seed", () => {
		const a = solvePose6dof(dirs(), priors(), opts);
		const b = solvePose6dof(dirs(), priors(), opts);
		expect(a.pose).toEqual(b.pose);
		expect(a.cost).toBe(b.cost);
	});
	it("rejects a gross outlier when there are enough points", () => {
		const cs = dirs();
		cs.push(
			...[
				[20, 8],
				[60, 7],
			].map(([az, el]) => dirCorrAt(az, el) as Correspondence),
		);
		const bad = { ...cs[2], u: 0.9, v: 0.9 } as Correspondence;
		cs[2] = bad;
		const r = solvePose6dof(cs, priors(), opts);
		expect(r.inliers[2]).toBe(false);
		expect(r.overThreshold[2]).toBe(true);
		expect(angleDiffDeg(r.pose.yaw, truth.yaw)).toBeLessThan(0.3);
	});
	it("a single point only solves yaw and pitch and keeps the roll/vfov priors", () => {
		const pr = priors({
			roll: { value: 1.5, sigma: 0.5 },
			vfov: { value: 45, sigma: 1 },
		});
		const r = solvePose6dof([dirs()[2]], pr, opts);
		expect(r.activeParams).toEqual(["yaw", "pitch"]);
		expect(r.pose.roll).toBe(1.5);
		expect(r.pose.vfov).toBe(45);
		expect(r.rmsPx).toBeLessThan(1);
	});
	it("solves a nonzero eye offset from finite points with a loose position prior", () => {
		const trueEye: [number, number, number] = [18, -12, 6];
		const rand = seededRandom(9);
		const pts: Correspondence[] = [];
		for (let i = 0; i < 9; i++) {
			const d = unproject(
				truth,
				ASPECT,
				uniform(rand, 0.05, 0.95),
				uniform(rand, 0.05, 0.95),
			);
			const dist = uniform(rand, 60, 400) * (i % 2 ? 1 : 4);
			const world: [number, number, number] = [
				trueEye[0] + d[0] * dist,
				trueEye[1] + d[1] * dist,
				trueEye[2] + d[2] * dist,
			];
			const pr = project(truth, ASPECT, trueEye, { world });
			pts.push({ kind: "point", u: pr?.u ?? 0, v: pr?.v ?? 0, world });
		}
		const r = solvePose6dof(
			pts,
			priors({ position: { value: [0, 0, 0], sigmaH: 40, sigmaV: 40 } }),
			{ ...opts, sigmaPx: 0.5 },
		);
		expect(r.activeParams).toContain("dx");
		expect(Math.hypot(r.eyeOffset[0] - 18, r.eyeOffset[1] + 12)).toBeLessThan(
			8,
		);
		expect(angleDiffDeg(r.pose.yaw, truth.yaw)).toBeLessThan(1);
		expect(r.rmsPx).toBeLessThan(2);
	});
	it("throws RangeError for a negative or NaN prior sigma", () => {
		expect(() =>
			solvePose6dof(dirs(), priors({ yaw: { value: 0, sigma: -1 } }), opts),
		).toThrow(RangeError);
		expect(() =>
			solvePose6dof(
				dirs(),
				priors({ pitch: { value: 0, sigma: Number.NaN } }),
				opts,
			),
		).toThrow(RangeError);
	});
	it("sigma 0 holds a parameter exactly", () => {
		const r = solvePose6dof(
			dirs(),
			priors({ roll: { value: 0, sigma: 0 } }),
			opts,
		);
		expect(r.pose.roll).toBe(0);
		expect(r.sigma.roll).toBe(0);
		expect(r.activeParams).not.toContain("roll");
	});
});
