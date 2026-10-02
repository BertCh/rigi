// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { type Pin, solvePins } from "#/lib/align";
import { type Pose, projectPoint } from "#/lib/camera";
import { expectArrayClose, seededRandom } from "#/test/helpers";
import {
	checkPinPairs,
	leaveOneOutPx,
	PIN_CHECKABLE_R,
	pairFitDeg,
	pinRedundancy,
	pinReliability,
	pinResidualsPx,
	pinSigmaDeg,
	pinUnknowns,
} from "../diagnostics";

const eye = [0, 0, 0];
const W = 1000;
const H = 700;
const asp = W / H;
const truth: Pose = { yaw: 25, pitch: 4, roll: 1.5, vfov: 46 };
const worlds: [number, number, number][] = [
	[3000, 5000, 400],
	[-500, 6000, 900],
	[1500, 4500, 100],
	[2500, 7000, 1200],
];
const pinAt = (p: Pose, world: [number, number, number]): Pin => {
	const q = projectPoint(p, asp, eye, world);
	if (!q) throw new Error("test summit behind the camera");
	return { world, u: q.u, v: q.v };
};
const pins = (list = worlds) => list.map((w) => pinAt(truth, w));
/** a summit 6° away (in azimuth) from worlds[1]: what a wrong name from the menu looks like */
const misnamed: [number, number, number] = (() => {
	const [x, y, z] = worlds[1];
	const a = 6 * (Math.PI / 180);
	return [
		x * Math.cos(a) + y * Math.sin(a),
		-x * Math.sin(a) + y * Math.cos(a),
		z,
	];
})();

describe("pinUnknowns / pinRedundancy", () => {
	it("follow the solvePins ladder", () => {
		expect(pinUnknowns(0)).toEqual([]);
		expect(pinUnknowns(1)).toEqual(["yaw", "pitch"]);
		expect(pinUnknowns(2)).toEqual(["yaw", "pitch", "roll"]);
		expect(pinUnknowns(3)).toEqual(["yaw", "pitch", "roll", "vfov"]);
		expect(pinUnknowns(3, false)).toEqual(["yaw", "pitch", "roll"]);
	});
	it("one pin can never be checked; two leave one equation", () => {
		expect(pinRedundancy(1)).toBe(0);
		expect(pinRedundancy(2)).toBe(1);
		expect(pinRedundancy(3)).toBe(2);
		expect(pinRedundancy(3, false)).toBe(3);
	});
	it("one wrong pin solves to ~0 residual: one tap cannot tell a wrong name", () => {
		const bad = { ...pinAt(truth, worlds[1]), world: misnamed };
		const p = solvePins({ ...truth, yaw: 20 }, asp, eye, [bad], W, H);
		expect(pinResidualsPx(p, asp, eye, [bad], W, H)[0]).toBeLessThan(0.5);
	});
});

describe("checkPinPairs", () => {
	it("passes true pins over a lens range that holds the truth", () => {
		const r = checkPinPairs(pins(), eye, asp, [40, 52]);
		expect(r.pairs).toHaveLength(6);
		for (const p of r.pairs) expect(p.ok).toBe(true);
		expect(r.suspect).toBeNull();
	});
	it("flags a pair with a wrong name, before any solve", () => {
		const two = [
			pinAt(truth, worlds[0]),
			{ ...pinAt(truth, worlds[1]), world: misnamed },
		];
		const r = checkPinPairs(two, eye, asp, [40, 52]);
		expect(r.pairs[0].ok).toBe(false);
		expect(r.pairs[0].missDeg).toBeGreaterThan(1);
		// two pins: a bad pair, but nothing says which pin is wrong
		expect(r.suspect).toBeNull();
	});
	it("isolates the one wrong pin among three", () => {
		const three = pins(worlds.slice(0, 3));
		three[1] = { ...three[1], world: misnamed };
		const r = checkPinPairs(three, eye, asp, [40, 52]);
		expect(r.suspect).toBe(1);
	});
	it("a lens range that excludes the truth fails even true pins", () => {
		const r = checkPinPairs(pins(), eye, asp, [20, 25]);
		expect(r.pairs.some((p) => !p.ok)).toBe(true);
	});
	it("is rotation-free: the same summits tapped under another rotation give the same pair angles", () => {
		const other: Pose = { yaw: 20, pitch: -6, roll: -5, vfov: 46 };
		// rotate the world with the camera so every summit stays in view
		const spin = (w: [number, number, number]): [number, number, number] => {
			const a = (-5 * Math.PI) / 180;
			return [
				w[0] * Math.cos(a) + w[1] * Math.sin(a),
				-w[0] * Math.sin(a) + w[1] * Math.cos(a),
				w[2],
			];
		};
		const tapped = worlds.map((w) => {
			const q = projectPoint(other, asp, eye, spin(w));
			if (!q) throw new Error("behind");
			return { world: spin(w), u: q.u, v: q.v };
		});
		const a = checkPinPairs(pins(), eye, asp, [40, 52]);
		const b = checkPinPairs(tapped, eye, asp, [40, 52]);
		for (const p of b.pairs) expect(p.ok).toBe(true);
		expectArrayClose(
			b.pairs.map((p) => p.worldDeg),
			a.pairs.map((p) => p.worldDeg),
			1e-9,
		);
	});
});

describe("pinSigmaDeg", () => {
	it("frees only the ladder's parameters and shrinks with more pins", () => {
		const s1 = pinSigmaDeg(truth, asp, eye, pins(worlds.slice(0, 1)), W, H, 5);
		expect(Object.keys(s1 ?? {})).toEqual(["yaw", "pitch"]);
		const s2 = pinSigmaDeg(truth, asp, eye, pins(worlds.slice(0, 2)), W, H, 5);
		const s4 = pinSigmaDeg(truth, asp, eye, pins(), W, H, 5);
		expect(s4?.vfov).toBeGreaterThan(0);
		expect(s4?.yaw ?? 9).toBeLessThan(s1?.yaw ?? 0);
		expect(s2?.roll).toBeGreaterThan(0);
	});
	it("matches the scatter of solves from noisy taps (within 35 %)", () => {
		const rnd = seededRandom(7);
		const gauss = () => {
			const a = Math.max(1e-12, rnd());
			return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * rnd());
		};
		const sigmaPx = 4;
		const base = pins();
		const yaws: number[] = [];
		for (let k = 0; k < 200; k++) {
			const noisy = base.map((p) => ({
				...p,
				u: p.u + (gauss() * sigmaPx) / W,
				v: p.v + (gauss() * sigmaPx) / H,
			}));
			yaws.push(solvePins(truth, asp, eye, noisy, W, H).yaw);
		}
		const m = yaws.reduce((s, x) => s + x, 0) / yaws.length;
		const sd = Math.sqrt(
			yaws.reduce((s, x) => s + (x - m) ** 2, 0) / (yaws.length - 1),
		);
		const pred = pinSigmaDeg(truth, asp, eye, base, W, H, sigmaPx)?.yaw ?? 0;
		expect(Math.abs(sd / pred - 1)).toBeLessThan(0.35);
	});
	it("is null for two pins on the same pixel", () => {
		const p = pinAt(truth, worlds[0]);
		expect(pinSigmaDeg(truth, asp, eye, [p, { ...p }], W, H, 5)).toBeNull();
	});
});

describe("leaveOneOutPx", () => {
	const solve = (rest: Pin[]) =>
		solvePins({ ...truth, yaw: 22, pitch: 3 }, asp, eye, rest, W, H, false);
	it("is null below three pins", () => {
		expect(
			leaveOneOutPx(pins(worlds.slice(0, 2)), solve, asp, eye, W, H),
		).toEqual([null, null]);
	});
	it("is ~0 for true pins and largest at the wrong one among four", () => {
		const good = leaveOneOutPx(pins(), solve, asp, eye, W, H);
		for (const g of good) expect(g ?? 99).toBeLessThan(1);
		const four = pins();
		four[1] = { ...four[1], world: misnamed };
		const loo = leaveOneOutPx(four, solve, asp, eye, W, H) as number[];
		const worst = loo.indexOf(Math.max(...loo));
		expect(worst).toBe(1);
		expect(loo[1]).toBeGreaterThan(50);
	});
});

describe("pairFitDeg", () => {
	it("is 0 with no pins and for the true summit, large for a wrong name", () => {
		const [a, b] = pins(worlds.slice(0, 2));
		expect(pairFitDeg([], b, eye, asp, [40, 52])).toBe(0);
		expect(pairFitDeg([a], b, eye, asp, [40, 52])).toBeLessThan(0.05);
		expect(
			pairFitDeg([a], { ...b, world: misnamed }, eye, asp, [40, 52]),
		).toBeGreaterThan(1);
	});
});

describe("pinReliability", () => {
	it("one pin cannot be checked; redundancy numbers sum to the spare equations", () => {
		const one = pinReliability(
			truth,
			asp,
			eye,
			pins(worlds.slice(0, 1)),
			W,
			H,
			5,
		);
		expect(one?.redundancy[0]).toBeLessThan(1e-6);
		expect(one?.detectablePx[0]).toBe(Number.POSITIVE_INFINITY);
		for (const n of [2, 3, 4]) {
			const r = pinReliability(
				truth,
				asp,
				eye,
				pins(worlds.slice(0, n)),
				W,
				H,
				5,
			);
			const sum = (r?.redundancy ?? []).reduce((s, x) => s + 2 * x, 0);
			expect(sum).toBeCloseTo(pinRedundancy(n), 3);
		}
	});
	it("more pins raise a pin's redundancy; a fixed lens raises it further", () => {
		const r2 = pinReliability(
			truth,
			asp,
			eye,
			pins(worlds.slice(0, 2)),
			W,
			H,
			5,
		);
		const r4 = pinReliability(truth, asp, eye, pins(), W, H, 5);
		const r4f = pinReliability(truth, asp, eye, pins(), W, H, 5, false);
		expect(r4?.redundancy[0] ?? 0).toBeGreaterThan(r2?.redundancy[0] ?? 1);
		expect(r4f?.redundancy[0] ?? 0).toBeGreaterThan(r4?.redundancy[0] ?? 1);
		// even four pins can leave one with high leverage below the checkable line
		expect(Math.min(...(r4?.redundancy ?? []))).toBeLessThan(PIN_CHECKABLE_R);
		expect(Math.min(...(r4f?.redundancy ?? []))).toBeGreaterThan(
			PIN_CHECKABLE_R,
		);
	});
});
