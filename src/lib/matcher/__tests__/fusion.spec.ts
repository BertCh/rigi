// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Parity of the ported fused solve (fusion.ts, core.ts, rotation.ts) with the Python reference
// (tools/matcher/fusion.py, server/fuse.py, server/core.py, match.py) on the synthetic scenarios of
// fixtures/synth.ts; the reference values are fixtures/fusion.json (make_fixtures.py). Not bit-exact
// (own LM and RNG): poses within 0.01°, statistics within a few hundredths.

import { describe, expect, it } from "vitest";
import type { Pose } from "#/lib/camera";
import { checkView, coverage, legacySolve, lift } from "../core";
import {
	type Corr,
	diagnostics,
	fuse,
	matchResid,
	poseFromX,
	robustSigma,
	selectionCost,
	skyAssociate,
	skyCurve,
	skylineFromArrays,
	solveFusion,
	xFromPose,
} from "../fusion";
import { dang, focalPx, rotAngle, rToPose, vfovFromF } from "../geometry";
import { solveRotation } from "../rotation";
import fixtures from "./fixtures/fusion.json";
import { makeScenario, SCENARIOS, XYZ_H, XYZ_W } from "./fixtures/synth";

// biome-ignore lint/suspicious/noExplicitAny: fixture JSON
const REF = fixtures as unknown as Record<string, any>;

const near = (
	a: number | null,
	b: number | null,
	tol: number,
	what: string,
) => {
	if (a == null || b == null) {
		expect(a, what).toBe(b);
		return;
	}
	expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThanOrEqual(tol);
};
const nearPose = (
	a: Pose | null,
	b: Pose | null,
	tol: number,
	what: string,
) => {
	expect(!!a, `${what} present`).toBe(!!b);
	if (!a || !b) return;
	near(dang(a.yaw, b.yaw), 0, tol, `${what}.yaw`);
	near(a.pitch, b.pitch, tol, `${what}.pitch`);
	near(a.roll, b.roll, tol, `${what}.roll`);
	near(a.vfov, b.vfov, tol, `${what}.vfov`);
};

function setup(name: string) {
	const p = SCENARIOS.find((s) => s.name === name);
	if (!p) throw new Error(name);
	const s = makeScenario(p);
	const sk = skylineFromArrays(p.w, p.h, s.fine, s.fg, s.sky, s.dirs, {
		pose: p.appPose,
	});
	const corr: Corr = { x2d: s.x2d, X: s.X, W: p.W, H: p.H };
	return { p, s, sk, corr, ref: REF[name], prior: REF[name].prior as Pose };
}

describe.each(SCENARIOS.map((s) => s.name))("fusion parity: %s", (name) => {
	const { p, s, sk, corr, ref, prior } = setup(name);
	const { W, H, eye } = p;
	const hasCorr = corr.x2d.length > 0;
	const x = xFromPose(p.appPose, H);

	it("skyline score map S", () => {
		let sum = 0;
		let sumsq = 0;
		for (const v of sk.S) {
			sum += v;
			sumsq += v * v;
		}
		near(sum, ref.S.sum, 1e-6 * Math.max(1, Math.abs(ref.S.sum)), "S.sum");
		near(sumsq, ref.S.sumsq, 1e-6 * Math.max(1, ref.S.sumsq), "S.sumsq");
		for (const [r, c, v] of ref.S.samples)
			near(sk.S[r * p.w + c], v, 1e-6, `S[${r},${c}]`);
	});

	it("sky curve and association", () => {
		const cu = Float64Array.from(
			{ length: p.w },
			(_, c) => ((c + 0.5) / p.w) * W,
		);
		const curve = skyCurve(x, sk, W, H, cu);
		ref.skyCurve.forEach((v: number | null, i: number) =>
			near(Number.isFinite(curve[i]) ? curve[i] : null, v, 1e-5, `curve[${i}]`),
		);
		const a = skyAssociate(x, sk, W, H, 24);
		expect(a.ncol).toBe(ref.skyAssociate.ncol);
		expect(a.cu.length).toBe(ref.skyAssociate.cu.length);
		ref.skyAssociate.tgt.forEach((v: number, i: number) =>
			near(a.tgt[i], v, 1e-5, `tgt[${i}]`),
		);
	});

	it.runIf(hasCorr)("match residuals and robust sigma", () => {
		const r = matchResid(x, corr, eye);
		ref.matchResid.first20.forEach(([u, v]: [number, number], i: number) => {
			near(r[i * 2], u, 1e-5, `r[${i}].u`);
			near(r[i * 2 + 1], v, 1e-5, `r[${i}].v`);
		});
		near(robustSigma(r, 1.0), ref.matchResid.robustSigma, 1e-6, "robustSigma");
	});

	it.runIf(hasCorr)("rotation RANSAC + LM (fixed and free focal)", async () => {
		for (const [key, free] of [
			["fixedFocal", false],
			["freeFocal", true],
		] as const) {
			const f0 = focalPx(prior.vfov, H);
			const rs = await solveRotation(corr.x2d, corr.X, eye, W, H, f0, free);
			expect(rs).not.toBeNull();
			if (!rs) return;
			const want = ref.solveRotation[key];
			nearPose(rToPose(rs.R, vfovFromF(rs.f, H)), want.pose, 0.01, key);
			let n = 0;
			for (const v of rs.inliers) n += v;
			near(n, want.inliers, 3, `${key}.inliers`);
			near(rs.rmse, want.rmse, 0.02, `${key}.rmse`);
		}
	});

	it("single-cue and fused LM solves, selection cost, diagnostics", async () => {
		const f0 = focalPx(prior.vfov, H);
		const s1 = solveFusion(x, W, H, f0, { sk, useMatch: false });
		expect(s1).not.toBeNull();
		if (!s1) return;
		nearPose(poseFromX(s1[0], H), ref.solveSky.pose, 0.01, "solveSky");
		near(
			s1[1].sky?.sigma ?? null,
			ref.solveSky.info.sky.sigma,
			1e-3,
			"sky sigma",
		);
		const sigma = ref.sigma;
		for (const start of ["skyline", "match"] as const) {
			const want = ref.solveFused[start];
			if (!want) continue;
			const x0 =
				start === "skyline" ? x : xFromPose(ref.solveMatch.pose as Pose, H);
			const sf = solveFusion(x0, W, H, f0, {
				sk,
				c: hasCorr ? corr : null,
				eye,
				sigma,
			});
			expect(sf).not.toBeNull();
			if (!sf) continue;
			nearPose(poseFromX(sf[0], H), want.pose, 0.01, `fused from ${start}`);
			const sel = selectionCost(
				sf[0],
				sk,
				hasCorr ? corr : null,
				eye,
				W,
				H,
				sigma,
			);
			near(
				sel,
				want.selectionCost,
				2e-3 * Math.max(1, want.selectionCost),
				"selection",
			);
		}
		const best = ref.solveFused[ref.diagnostics.start];
		const d = diagnostics(
			Float64Array.from(best.x),
			sk,
			hasCorr ? corr : null,
			eye,
			W,
			H,
		);
		near(d.sky_med ?? null, ref.diagnostics.sky_med, 1e-4, "sky_med");
		expect(d.sky_cols).toBe(ref.diagnostics.sky_cols);
		if (hasCorr)
			near(
				d.match_support ?? null,
				ref.diagnostics.match_support,
				1e-6,
				"support",
			);
		if (ref.rotAngle != null)
			near(
				rotAngle(p.appPose, ref.solveMatch.pose),
				ref.rotAngle,
				1e-6,
				"rotAngle",
			);
	});

	it("fuse(): fused pose, HIGH/LOW level, checks, score", async () => {
		const r = await fuse(prior, eye, W, H, sk, hasCorr ? corr : null);
		const want = ref.fuse;
		expect(r.level).toBe(want.level);
		expect(r.start).toBe(want.start);
		nearPose(r.fusedPose, want.fusedPose, 0.01, "fusedPose");
		near(r.checks.cueAgreeDeg, want.checks.cueAgreeDeg, 0.01, "cueAgreeDeg");
		near(r.checks.skylineMedPx, want.checks.skylineMedPx, 0.02, "skylineMedPx");
		near(
			r.checks.matchSupport,
			want.checks.matchSupport,
			0.005,
			"matchSupport",
		);
		near(r.fusionScore, want.fusionScore, 0.01, "fusionScore");
		expect(!!r.cues.match).toBe(!!want.cues.match);
		if (r.cues.match)
			near(r.cues.match.inliers, want.cues.match.inliers, 3, "match inliers");
	});

	it("legacy render-match solve (v0.1 confidence) and coverage", async () => {
		const views = [-20, -10, 0, 10, 20].map((d) => ({
			pose: { ...prior, yaw: prior.yaw + d },
		}));
		const r = await legacySolve(
			{ ...corr, perView: [], matchMs: 0 },
			views,
			eye,
			prior,
		);
		const want = ref.coreSolve;
		expect(!!r.pose).toBe(!!want.pose);
		if (want.pose) {
			nearPose(r.pose, want.pose, 0.01, "legacy pose");
			near(r.confidence, want.confidence, 0.01, "confidence");
			near(r.inliers, want.inliers, 3, "inliers");
			near(r.coverage ?? null, want.coverage, 1e-8, "coverage");
		} else expect(r.reason).toBe(want.reason);
		near(
			coverage(corr.x2d.subarray(0, 400), W, H),
			ref.coverage,
			1e-8,
			"coverage(200)",
		);
	});

	it("lift and check_view on the small xyz view", () => {
		const { X, ok } = lift(s.kp, s.xyz, XYZ_W, XYZ_H, eye);
		expect(Array.from(ok)).toEqual(ref.lift.ok);
		ref.lift.X.forEach((row: number[], i: number) => {
			for (let k = 0; k < 3; k++)
				near(X[i * 3 + k], row[k], 1e-3, `X[${i}][${k}]`);
		});
		const cv = checkView(
			{
				tag: "t",
				pose: p.truePose,
				W: XYZ_W,
				H: XYZ_H,
				rgba: new Uint8Array(0),
				xyz: s.xyz,
			},
			eye,
		);
		const all = ref.checkViewDetail.medianAll;
		if (all == null) expect(cv).toBe(Number.POSITIVE_INFINITY);
		else near(cv, all, 0.1 * all + 0.5, "checkView");
	});
});
