// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Parity of the basin-gap port (basin.ts) with tools/matcher/pose6.py basin_gap on the analytic fake DEM of
// fixtures/make_basin_fixtures.py (same formulas below) and the synthetic "agree" / "disagree" scenarios.

import { describe, expect, it } from "vitest";
import type { Pose } from "#/lib/camera";
import {
	arangeLen,
	type BasinDem,
	basinEye,
	basinGap,
	basinProblem,
	deltaDirs,
	priorRes,
	rotCandidates,
	rotSearchCpu,
	sigmas,
	skyWith,
	solveRotationAtEye,
	totalCost,
} from "../basin";
import { skylineFromArrays, xFromPose } from "../fusion";
import { DEG, dang } from "../geometry";
import fixtures from "./fixtures/basin.json";
import { horizonElevationDeg, makeScenario, SCENARIOS } from "./fixtures/synth";

// biome-ignore lint/suspicious/noExplicitAny: fixture JSON
const REF = fixtures as unknown as Record<string, any>;

/** make_basin_fixtures.py FakeDem. */
const fakeDem: BasinDem = {
	ground: (e, n) =>
		1200.0 +
		0.05 * e -
		0.03 * n +
		20.0 * Math.sin(e / 300.0) * Math.cos(n / 400.0),
	async horizons(eyes, az0, az1, step) {
		const n = arangeLen(az0, az1 + step * 0.5, step);
		return eyes.map(([E, N, Z]) =>
			Float64Array.from({ length: n }, (_, k) => {
				const a = (az0 + k * step) * DEG;
				return (
					horizonElevationDeg(a) +
					0.002 * (E * Math.cos(3 * a) - N * Math.sin(2 * a)) +
					0.001 * (Z - 1500.0)
				);
			}),
		);
	},
};

const near = (
	a: number | null | undefined,
	b: number | null,
	tol: number,
	what: string,
) => {
	if (a == null || b == null) return expect(a ?? null, what).toBe(b);
	expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThanOrEqual(tol);
};

async function setup(name: string) {
	const p = SCENARIOS.find((s) => s.name === name);
	if (!p) throw new Error(name);
	const s = makeScenario(p);
	const sk = skylineFromArrays(p.w, p.h, s.fine, s.fg, s.sky, s.dirs, {
		pose: p.appPose,
	});
	const ref = REF[name];
	const prob = await basinProblem({
		W: p.W,
		H: p.H,
		sk,
		corr: { x2d: s.x2d, X: s.X, W: p.W, H: p.H },
		eye0: ref.eye0,
		pose0: ref.pose0 as Pose,
		focalKnown: true,
		regime: "manual",
		dem: fakeDem,
	});
	return { p, prob, ref };
}

describe.each(Object.keys(REF))("basin gap parity: %s", (name) => {
	it("problem setup, delta horizon base and eye", async () => {
		const { prob, ref } = await setup(name);
		const r = ref.problem;
		near(prob.f0, r.f0, 1e-5, "f0");
		near(prob.hfov, r.hfov, 1e-7, "hfov");
		near(prob.agl0, r.agl0, 1e-6, "agl0");
		near(prob.az0, r.az0, 1e-6, "az0");
		near(prob.azstep, r.azstep, 1e-9, "azstep");
		expect(prob.nAz).toBe(r.n);
		near(
			prob.baseEl.reduce((a, b) => a + b, 0),
			r.base_el_sum,
			1e-4,
			"base_el sum",
		);
		r.base_el_every10.forEach((v: number, i: number) => {
			near(prob.baseEl[i * 10], v, 1e-6, `base_el[${i * 10}]`);
		});
		for (const e of ref.eyeAt)
			near(basinEye(prob, e.E, e.N, e.a)[2], e.eye[2], 1e-5, "eye z");
	});

	it("sigmas, rotation search, fixed-eye LM and the comparable cost", async () => {
		const { p, prob, ref } = await setup(name);
		const sk0 = skyWith(prob, deltaDirs(prob, prob.py0));
		const sig = sigmas(prob, xFromPose(prob.pose0, p.H), prob.eye0, sk0);
		near(sig.sky, ref.sigmas.sky, 1e-3, "sigma.sky");
		near(sig.match, ref.sigmas.match, 1e-3, "sigma.match");
		const cands = rotCandidates(prob, prob.pose0);
		for (const rs of ref.rotSearch) {
			const eye = basinEye(prob, rs.E, rs.N, prob.aglRef);
			const [py] = await fakeDem.horizons(
				[eye],
				prob.az0,
				prob.az1,
				prob.azstep,
			);
			const [hyps] = await rotSearchCpu(
				[deltaDirs(prob, py)],
				cands,
				prob.sk,
				p.W,
				p.H,
				prob.f0,
			);
			expect(hyps.length).toBe(rs.hyps.length);
			rs.hyps.forEach((h: { score: number; pose: Pose }, i: number) => {
				near(hyps[i].score, h.score, 1e-6, `score ${i}`);
				near(dang(hyps[i].pose.yaw, h.pose.yaw), 0, 1e-6, `yaw ${i}`);
				near(hyps[i].pose.pitch, h.pose.pitch, 1e-6, `pitch ${i}`);
			});
		}
		const s6 = ref.solve6;
		const eye = basinEye(prob, s6.p0[4], s6.p0[5], s6.p0[6]);
		const [py] = await fakeDem.horizons([eye], prob.az0, prob.az1, prob.azstep);
		const sk = skyWith(prob, deltaDirs(prob, py));
		const q = solveRotationAtEye(prob, s6.p0, ref.sigmas, eye, sk);
		expect(q).not.toBeNull();
		if (!q) return;
		for (let k = 0; k < 3; k++) near(q[k], s6.p[k], 0.01, `p[${k}]`);
		near(
			totalCost(prob, q, ref.sigmas, eye, sk),
			s6.totalCost,
			0.01 * s6.totalCost,
			"totalCost",
		);
		priorRes(prob, s6.p).forEach((v, k) => {
			near(v, s6.priorRes[k], 1e-6, `priorRes[${k}]`);
		});
	});

	it("basin_gap: best node, second node and the gap", async () => {
		const { prob, ref } = await setup(name);
		const r = await basinGap(prob);
		const b = ref.basinGap;
		expect(r.grid?.step).toBe(b.step);
		expect(r.grid?.n).toBe(b.n);
		expect(r.grid?.evaluated).toBe(b.evaluated);
		expect([r.grid?.best.E, r.grid?.best.N]).toEqual([b.best.E, b.best.N]);
		expect([r.grid?.second?.E, r.grid?.second?.N]).toEqual([
			b.second.E,
			b.second.N,
		]);
		near(r.grid?.best.cost, b.best.cost, 0.01 * b.best.cost, "c1");
		near(r.gap, b.gap, 0.02 * b.gap, "gap");
	});
});
