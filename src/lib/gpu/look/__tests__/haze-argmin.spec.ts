// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import { GRID_PICK_CAP, gridTolerance } from "../haze";
import {
	decodePick,
	emulatePick,
	PICK_ARENA_WORDS,
	PICK_K1,
	PICK_K2,
} from "../haze-argmin";

const f32 = (xs: number[]) => Float32Array.from(xs);

describe("emulatePick + decodePick", () => {
	it("finds the minimum and the tolerance superset", () => {
		const g = f32([5, 3, 3.0001, 9, 3, Number.NaN, 4]);
		const pick = decodePick(...emulatePick(g));
		expect(pick).not.toBeNull();
		expect(pick?.gMin).toBe(3);
		expect(pick?.count).toBe(3);
		expect(Array.from(pick?.idx ?? []).sort()).toEqual([1, 2, 4]);
	});
	it("ignores NaN cells and folds -0 onto 0", () => {
		const pick = decodePick(...emulatePick(f32([Number.NaN, -0, 0, 1])));
		expect(pick?.gMin === 0).toBe(true); // +0 or -0
		expect(pick?.count).toBe(2);
	});
	it("tolerance mirrors gridTolerance (f64) at least", () => {
		const rand = seededRandom(5);
		for (let i = 0; i < 50; i++) {
			const g = f32(Array.from({ length: 64 }, () => uniform(rand, -50, 50)));
			const [words] = emulatePick(g);
			const tol = new Float32Array(words)[1];
			const gMin = new Float32Array(words)[0];
			expect(tol).toBeGreaterThanOrEqual(gridTolerance(gMin));
			expect(tol).toBeLessThanOrEqual(
				gMin + Math.abs(gMin) * PICK_K1 * 1.001 + PICK_K2 * 2,
			);
		}
	});
	it("the result is independent of the atomic slot order (as a set)", () => {
		const g = f32([2, 1, 1, 1, 7, 1.0000001]);
		const fwd = decodePick(...emulatePick(g));
		const rev = decodePick(
			...emulatePick(g, (n) => [...Array(n).keys()].reverse()),
		);
		expect(Array.from(fwd?.idx ?? []).sort()).toEqual(
			Array.from(rev?.idx ?? []).sort(),
		);
		expect(fwd?.count).toBe(rev?.count);
	});
	it("past the cap keeps the cap smallest in (err, index) order", () => {
		const n = GRID_PICK_CAP + 40;
		const g = new Float32Array(n).fill(1); // all tie at the minimum
		const pick = decodePick(
			...emulatePick(g, (m) => [...Array(m).keys()].reverse()),
		);
		expect(pick?.count).toBe(n);
		expect(pick?.idx.length).toBe(GRID_PICK_CAP);
		expect(Array.from(pick?.idx ?? [])).toEqual([
			...Array(GRID_PICK_CAP).keys(),
		]);
	});
});

describe("decodePick rejects inconsistent reads", () => {
	const words = (gMin: number, tol: number, count: number) => {
		const b = new ArrayBuffer(PICK_ARENA_WORDS * 4);
		new Float32Array(b).set([gMin, tol]);
		new Uint32Array(b)[2] = count;
		return b;
	};
	const pairs = (entries: [number, number][]) => {
		const b = new ArrayBuffer(GRID_PICK_CAP * 8);
		const u = new Uint32Array(b);
		const f = new Float32Array(1);
		const fu = new Uint32Array(f.buffer);
		entries.forEach(([idx, err], i) => {
			f[0] = err;
			u[2 * i] = idx;
			u[2 * i + 1] = fu[0];
		});
		return b;
	};
	it("accepts a consistent read", () => {
		expect(
			decodePick(words(1, gridTolerance(1) * 1.01, 1), pairs([[3, 1]]))?.idx[0],
		).toBe(3);
	});
	it("rejects a tolerance tighter than the f64 one", () => {
		expect(decodePick(words(1, 1, 1), pairs([[0, 1]]))).toBeNull();
	});
	it("rejects an err outside [gMin, tol]", () => {
		expect(
			decodePick(
				words(1, 1.01, 2),
				pairs([
					[0, 1],
					[1, 2],
				]),
			),
		).toBeNull();
		expect(decodePick(words(1, 1.01, 1), pairs([[0, 0.5]]))).toBeNull();
	});
	it("rejects a read where nothing equals gMin", () => {
		expect(decodePick(words(1, 1.01, 1), pairs([[0, 1.005]]))).toBeNull();
	});
	it("accepts an empty selection", () => {
		expect(
			decodePick(
				words(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 0),
				pairs([]),
			)?.count,
		).toBe(0);
	});
});
