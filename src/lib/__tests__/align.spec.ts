// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { angleDiffDeg, expectArrayClose } from "#/test/helpers";
import {
	autoAlign,
	coarseGridPoses,
	DESCENT_KEYS,
	Descent,
	descentSteps,
	type EdgeMap,
	edgeMapFg,
	edgeMapFromPixels,
	halve,
	neighbour,
	newRefineStats,
	type Pin,
	penaltyTerms,
	probeKey,
	scanLabels,
	scoreFromSum,
	scorePose,
	skylineRows,
	solvePins,
	stopHasBand,
} from "../align";
import { type Pose, projectPoint } from "../camera";

const prior: Pose = { yaw: 100, pitch: 3, roll: 1, vfov: 50 };

describe("descent helpers", () => {
	it("descentSteps scales the vfov step with the starting vfov", () => {
		expect(descentSteps(50)).toEqual({
			yaw: 0.4,
			pitch: 0.4,
			roll: 0.8,
			vfov: 1,
		});
	});
	it("halve halves every step and does not mutate", () => {
		const s = descentSteps(40);
		const h = halve(s);
		expect(h).toEqual({ yaw: 0.2, pitch: 0.2, roll: 0.4, vfov: 0.4 });
		expect(s.yaw).toBe(0.4);
	});
	it("neighbour j moves key j>>1 by + then - one step, leaving the others", () => {
		const steps = descentSteps(50);
		DESCENT_KEYS.forEach((k, i) => {
			const plus = neighbour(prior, 2 * i, steps);
			const minus = neighbour(prior, 2 * i + 1, steps);
			expect(plus[k]).toBeCloseTo(prior[k] + steps[k], 12);
			expect(minus[k]).toBeCloseTo(prior[k] - steps[k], 12);
			for (const other of DESCENT_KEYS)
				if (other !== k) expect(plus[other]).toBe(prior[other]);
		});
	});
	it("probeKey identifies exact bit patterns and the map", () => {
		expect(probeKey(prior, true)).toBe(probeKey({ ...prior }, true));
		expect(probeKey(prior, true)).not.toBe(probeKey(prior, false));
		expect(probeKey(prior, true)).not.toBe(
			probeKey({ ...prior, yaw: prior.yaw + 1e-12 }, true),
		);
		expect(probeKey({ ...prior, roll: 0 }, true)).not.toBe(
			probeKey({ ...prior, roll: -0 }, true),
		);
	});
	it("newRefineStats starts at zero", () => {
		const s = newRefineStats();
		for (const v of Object.values(s)) expect(v).toBe(0);
	});
});

describe("penaltyTerms", () => {
	const t = penaltyTerms(prior);
	it("is zero at the prior and quadratic away from it", () => {
		expect(t.yaw(prior.yaw)).toBe(0);
		expect(t.pitch(prior.pitch)).toBe(0);
		expect(t.roll(prior.roll)).toBe(0);
		expect(t.vfov(prior.vfov)).toBe(0);
		expect(t.yaw(prior.yaw + 20)).toBeCloseTo(0.04, 12);
		expect(t.yaw(prior.yaw + 40)).toBeCloseTo(4 * t.yaw(prior.yaw + 20), 12);
		expect(t.yaw(prior.yaw - 7)).toBeCloseTo(t.yaw(prior.yaw + 7), 12);
	});
	it("trusts gravity more than the compass", () => {
		expect(t.pitch(prior.pitch + 2)).toBeGreaterThan(t.yaw(prior.yaw + 2));
	});
});

describe("scoreFromSum", () => {
	it("is 0 with 20 or fewer in-frame points", () => {
		expect(scoreFromSum(100, 20, 100, 50, 1.5)).toBe(0);
	});
	it("is the mean times coverage, coverage capped at 1, monotone in sum", () => {
		expect(scoreFromSum(60, 60, 60, 50, 1.5)).toBeCloseTo(1, 12);
		const a = scoreFromSum(30, 60, 600, 50, 1.5);
		expect(a).toBeLessThan(0.5);
		expect(scoreFromSum(40, 60, 600, 50, 1.5)).toBeGreaterThan(a);
	});
});

describe("coarseGridPoses", () => {
	it("is yaw-major and pitch-minor with 0.5 degree steps", () => {
		const g = coarseGridPoses(prior, 2);
		expect(g.nYaw).toBe(9);
		expect(g.nPitch).toBe(25);
		expect(g.poses).toHaveLength(9 * 25);
		expect(g.poses[0]).toEqual({ ...prior, yaw: 98, pitch: -3 });
		expect(g.poses[1].pitch).toBeCloseTo(-2.5, 12);
		expect(g.poses[25].yaw).toBeCloseTo(98.5, 12);
		expect(coarseGridPoses(prior, 0).nYaw).toBe(1);
	});
});

describe("stopHasBand / edgeMapFg", () => {
	it("requires the stop to be inside the plausible band of the frame", () => {
		expect(stopHasBand(50, 3, 100)).toBe(true);
		expect(stopHasBand(2, 3, 100)).toBe(false);
		expect(stopHasBand(90, 3, 100)).toBe(false);
	});
	it("rejects stops far from the prior skyline", () => {
		const rows = Float32Array.from([50, 50, -1]);
		expect(stopHasBand(52, 0, 100, rows)).toBe(true);
		expect(stopHasBand(80, 0, 100, rows)).toBe(false);
		expect(stopHasBand(50, 2, 100, rows)).toBe(false); // prior row < 0: no skyline there
	});
	it("edgeMapFg resamples a mask to w x h in 0..1; none gives zeros", () => {
		expect(Array.from(edgeMapFg(4, 4))).toEqual(new Array(16).fill(0));
		const mask = {
			width: 2,
			height: 2,
			data: Uint8Array.from([0, 255, 255, 0]),
		};
		const fg = edgeMapFg(4, 4, mask as never);
		expect(fg[0]).toBe(0);
		expect(fg[3]).toBe(1);
		expect(fg[12]).toBe(1);
		expect(fg[15]).toBe(0);
	});
});

// ---- a synthetic scene: blue sky above a profile-shaped dark terrain ----
const W = 160;
const H = 100;
const ASPECT = W / H;
const truth: Pose = { yaw: 100, pitch: 3, roll: 0, vfov: 50 };
const elevationAt = (az: number) =>
	4 + 3 * Math.sin((az * Math.PI) / 9) + 2 * Math.sin((az * Math.PI) / 4 + 1);

function dirsOf(): Float32Array {
	const out: number[] = [];
	for (let az = 0; az < 360; az += 0.25) {
		const a = (az * Math.PI) / 180;
		const e = (elevationAt(az) * Math.PI) / 180;
		out.push(Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e));
	}
	return Float32Array.from(out);
}

function scene(): { rgb: Uint8ClampedArray; rows: Float32Array } {
	const dirs = dirsOf();
	const rows = new Float32Array(W).fill(Number.NaN);
	for (let i = 0; i < dirs.length; i += 3) {
		const q = projectPoint(
			truth,
			ASPECT,
			[0, 0, 0],
			[dirs[i], dirs[i + 1], dirs[i + 2]],
		);
		if (!q) continue;
		const x = Math.floor(q.u * W);
		if (x >= 0 && x < W && !(rows[x] <= q.v * H)) rows[x] = q.v * H;
	}
	const rgb = new Uint8ClampedArray(W * H * 4);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const o = 4 * (y * W + x);
			const sky = y < (Number.isFinite(rows[x]) ? rows[x] : H * 0.5);
			[rgb[o], rgb[o + 1], rgb[o + 2]] = sky ? [110, 160, 235] : [60, 55, 50];
			rgb[o + 3] = 255;
		}
	return { rgb, rows };
}
const { rgb, rows: trueRows } = scene();
const dirs = dirsOf();
const freshMap = (): EdgeMap =>
	edgeMapFromPixels(rgb, W, H, new Float32Array(W * H));

describe("edgeMapFromPixels / scanLabels", () => {
	it("builds all planes at the image size and learns sky above, terrain below", () => {
		const m = freshMap();
		expect(m.coarse).toHaveLength(W * H);
		expect(m.fine).toHaveLength(W * H);
		expect(m.sky).toHaveLength(W * H);
		expect(m.skyCum).toHaveLength(W * (H + 1));
		const x = 80;
		expect(m.sky[2 * W + x]).toBeGreaterThan(0.8);
		expect(m.sky[(H - 3) * W + x]).toBeLessThan(0.2);
		// the edge response peaks at the skyline row
		const row = Math.round(trueRows[x]);
		expect(m.fine[row * W + x]).toBeGreaterThan(m.fine[(row - 15) * W + x]);
	});
	it("skyCum is the column prefix sum of sky", () => {
		const m = freshMap();
		const x = 40;
		let acc = 0;
		for (let y = 0; y < H; y++) {
			expect(m.skyCum[y * W + x]).toBeCloseTo(acc, 3);
			acc += m.sky[y * W + x];
		}
	});
	it("scanLabels marks the top as sky (1), the bottom as terrain (-1)", () => {
		const m = freshMap();
		const lbl = scanLabels(m);
		const x = 80;
		expect(lbl[1 * W + x]).toBe(1);
		expect(lbl[(H - 1) * W + x]).toBe(-1);
		expect(lbl[Math.round(trueRows[x]) * W + x]).toBe(0);
	});
	it("foreground pixels are neutral (0.5) in the sky model and zero the edge map", () => {
		const fg = new Float32Array(W * H);
		for (let y = 0; y < H; y++)
			for (let x = 60; x < 100; x++) fg[y * W + x] = 1;
		const m = edgeMapFromPixels(rgb, W, H, fg);
		expect(m.sky[30 * W + 80]).toBeCloseTo(0.5, 1);
		expect(m.fine[Math.round(trueRows[80]) * W + 80]).toBe(0);
	});
});

describe("skylineRows / scorePose", () => {
	it("projects the horizon directions to the same rows the image was drawn with", () => {
		const m = freshMap();
		const rows = skylineRows(truth, ASPECT, dirs, m);
		let compared = 0;
		for (let x = 5; x < W - 5; x++) {
			if (rows[x] < 0 || !Number.isFinite(trueRows[x])) continue;
			expect(Math.abs(rows[x] - trueRows[x])).toBeLessThan(1.5);
			compared++;
		}
		expect(compared).toBeGreaterThan(W * 0.8);
	});
	it("marks columns with no projected point as -1 for a pose looking away", () => {
		const rows = skylineRows(
			{ ...truth, vfov: 10 },
			ASPECT,
			new Float32Array([0, -1, 0]),
			freshMap(),
		);
		expect(rows.every((r) => r === -1)).toBe(true);
	});
	it("the true pose scores higher than shifted poses, in both maps", () => {
		const m = freshMap();
		for (const fine of [false, true]) {
			const s0 = scorePose(truth, ASPECT, dirs, m, fine);
			expect(s0).toBeGreaterThan(0);
			for (const d of [{ yaw: 3 }, { yaw: -3 }, { pitch: 2 }, { pitch: -2 }])
				expect(
					scorePose(
						{
							...truth,
							...Object.fromEntries(
								Object.entries(d).map(([k, v]) => [
									k,
									truth[k as keyof Pose] + v,
								]),
							),
						},
						ASPECT,
						dirs,
						m,
						fine,
					),
				).toBeLessThan(s0);
		}
	});
	it("a pose looking away from the data scores 0", () => {
		expect(
			scorePose(
				{ ...truth, yaw: truth.yaw + 180 },
				ASPECT,
				new Float32Array([0, -1, 0, 0, -1, 0]),
				freshMap(),
				true,
			),
		).toBe(0);
	});
	it("stride subsamples the directions but keeps the score near the full one", () => {
		const m = freshMap();
		const a = scorePose(truth, ASPECT, dirs, m, true, 1);
		const b = scorePose(truth, ASPECT, dirs, m, true, 3);
		expect(Math.abs(a - b)).toBeLessThan(0.1 * Math.abs(a));
	});
});

describe("Descent / autoAlign", () => {
	it("Descent climbs a quadratic to its maximum and terminates", () => {
		const goal: Pose = { yaw: 101.3, pitch: 2.2, roll: 0.4, vfov: 52 };
		const f = (p: Pose) =>
			-(
				(p.yaw - goal.yaw) ** 2 +
				(p.pitch - goal.pitch) ** 2 +
				(p.roll - goal.roll) ** 2 +
				((p.vfov - goal.vfov) / 2) ** 2
			);
		const stats = newRefineStats();
		const d = new Descent(
			{ yaw: 100, pitch: 3, roll: 1, vfov: 50 },
			true,
			f,
			() => 0,
			50,
			stats,
		);
		let guard = 0;
		while (!d.done && guard++ < 100) d.step();
		expect(d.done).toBe(true);
		expect(d.iter).toBeLessThanOrEqual(60);
		expect(Math.abs(d.best.yaw - goal.yaw)).toBeLessThan(0.1);
		expect(Math.abs(d.best.pitch - goal.pitch)).toBeLessThan(0.1);
		expect(d.result.score).toBe(d.cur);
		expect(d.cur).toBeGreaterThan(f({ yaw: 100, pitch: 3, roll: 1, vfov: 50 }));
		expect(stats.cpuEvals).toBeGreaterThan(8);
	});
	it("a certified bound lets Descent skip neighbours without changing the result", () => {
		const f = (p: Pose) =>
			-((p.yaw - 100.8) ** 2) -
			(p.pitch - 3) ** 2 -
			(p.roll - 1) ** 2 -
			((p.vfov - 50) / 2) ** 2;
		const run = (withBound: boolean) => {
			const stats = newRefineStats();
			const d = new Descent(prior, true, f, () => 0, 50, stats);
			while (!d.done)
				d.step(withBound ? (p) => ({ ub: f(p) + 1e-9, eps: 0 }) : undefined);
			return { d, stats };
		};
		const a = run(false);
		const b = run(true);
		expect(b.d.best).toEqual(a.d.best);
		expect(b.d.cur).toBe(a.d.cur);
		expect(b.stats.skipped).toBeGreaterThan(0);
		expect(b.stats.cpuEvals).toBeLessThan(a.stats.cpuEvals);
	});
	it("speculate lists the first neighbours in loop order; covered() agrees with probeKey", () => {
		const d = new Descent(
			prior,
			false,
			() => 0,
			() => 0,
			50,
		);
		const out = d.speculate(0, 1, []);
		expect(out).toHaveLength(8);
		const steps = descentSteps(50);
		expect(out[0]).toEqual(neighbour(prior, 0, steps));
		const known = new Map<string, undefined>();
		expect(d.covered(known)).toBe(false);
		for (const p of out) known.set(probeKey(p, false), undefined);
		expect(d.covered(known)).toBe(true);
	});
	it("autoAlign recovers the yaw of a synthetic scene from a 6 degree compass error", () => {
		const m = freshMap();
		const off: Pose = { ...truth, yaw: truth.yaw + 6, pitch: truth.pitch - 1 };
		const r = autoAlign(off, ASPECT, dirs, m, 12);
		expect(angleDiffDeg(r.pose.yaw, truth.yaw)).toBeLessThan(1);
		expect(Math.abs(r.pose.pitch - truth.pitch)).toBeLessThan(1);
		expect(r.score).toBeGreaterThan(0);
		expect(r.confidence).toBeGreaterThanOrEqual(0);
		expect(r.confidence).toBeLessThanOrEqual(1);
		expect(r.alternatives?.length).toBeGreaterThan(0);
		expectArrayClose([r.alternatives?.[0].score ?? 0], [r.score], 0);
	});
});

describe("solvePins", () => {
	const eye = [0, 0, 0];
	const W2 = 1000;
	const H2 = 700;
	const asp = W2 / H2;
	const pinAt = (p: Pose, world: [number, number, number]): Pin => {
		const q = projectPoint(p, asp, eye, world);
		return { world, u: q?.u ?? 0, v: q?.v ?? 0 };
	};
	const worlds: [number, number, number][] = [
		[3000, 5000, 400],
		[-500, 6000, 900],
		[1500, 4500, 100],
		[2500, 7000, 1200],
	];
	it("returns the prior without pins", () => {
		expect(solvePins(prior, asp, eye, [], W2, H2)).toBe(prior);
	});
	it("one pin fixes yaw and pitch exactly, leaving roll and vfov", () => {
		const t: Pose = { yaw: 25, pitch: 5, roll: 1, vfov: 50 };
		const p = solvePins(
			{ ...t, yaw: 20, pitch: 3 },
			asp,
			eye,
			[pinAt(t, worlds[0])],
			W2,
			H2,
		);
		expect(angleDiffDeg(p.yaw, 25)).toBeLessThan(0.02);
		expect(p.pitch).toBeCloseTo(5, 1);
		expect(p.roll).toBe(1);
		expect(p.vfov).toBe(50);
	});
	it("several pins recover roll and vfov too (weak priors only)", () => {
		const t: Pose = { yaw: 25, pitch: 5, roll: 1.5, vfov: 46 };
		const start: Pose = { yaw: 22, pitch: 4, roll: 1.2, vfov: 48 };
		const p = solvePins(
			start,
			asp,
			eye,
			worlds.map((w) => pinAt(t, w)),
			W2,
			H2,
		);
		expect(angleDiffDeg(p.yaw, 25)).toBeLessThan(0.1);
		expect(Math.abs(p.roll - 1.5)).toBeLessThan(0.2);
		expect(Math.abs(p.vfov - 46)).toBeLessThan(1);
	});
	it("solveFov=false keeps vfov at the prior", () => {
		const t: Pose = { yaw: 25, pitch: 5, roll: 1.5, vfov: 46 };
		const start: Pose = { yaw: 22, pitch: 4, roll: 1.2, vfov: 48 };
		const p = solvePins(
			start,
			asp,
			eye,
			worlds.map((w) => pinAt(t, w)),
			W2,
			H2,
			false,
		);
		expect(p.vfov).toBe(48);
	});
	it("never returns NaN even with a pin behind the camera", () => {
		const p = solvePins(
			prior,
			asp,
			eye,
			[{ world: [0, -1000, 0], u: 0.5, v: 0.5 }],
			W2,
			H2,
		);
		for (const v of Object.values(p)) expect(Number.isFinite(v)).toBe(true);
	});
});
