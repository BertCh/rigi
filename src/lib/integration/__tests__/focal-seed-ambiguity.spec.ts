// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	isAmbiguousFocal,
	SEED_REFINE_MIN_SOLVE_CONFIDENCE,
} from "../unknown-pose-core";

type Seed = Parameters<typeof isAmbiguousFocal>[0][number];
const seed = (o: Partial<Seed>): Seed => ({
	vfov: 40,
	yaw: 43,
	solvedVfov: 40,
	confidence: 0.99,
	solveConfidence: 0.99,
	accepted: true,
	stage: "solve",
	...o,
});
const best = { camera: { yaw: 43.26 }, confidence: 0.99 };

describe("isAmbiguousFocal", () => {
	it("is false when the best seed is the only accepting one", () => {
		const seeds = [
			seed({}),
			seed({ accepted: false, confidence: 0.07, solveConfidence: 0.07 }),
		];
		expect(isAmbiguousFocal(seeds, best)).toBe(false);
	});
	it("vetoes a second solve-stage accept more than 1 deg away", () => {
		const seeds = [seed({}), seed({ yaw: 50, confidence: 0.8 })];
		expect(isAmbiguousFocal(seeds, best)).toBe(true);
	});
	it("does not veto a second accept within 1 deg (wrapping at 360)", () => {
		expect(isAmbiguousFocal([seed({ yaw: 43.9 })], best)).toBe(false);
		expect(
			isAmbiguousFocal([seed({ yaw: 359.9 })], {
				camera: { yaw: 0.4 },
				confidence: 0.99,
			}),
		).toBe(false);
	});
	it("vetoes when the best confidence is under the focal-unknown floor", () => {
		expect(
			isAmbiguousFocal([seed({})], { camera: { yaw: 43 }, confidence: 0.7 }),
		).toBe(true);
	});
	it("ignores a refine-only accept whose solve stage was far below the floor (IMG_6958 seed 3)", () => {
		const wrong = seed({
			yaw: 47.5,
			stage: "refine",
			solveConfidence: 0.065,
			confidence: 0.698,
		});
		expect(isAmbiguousFocal([seed({}), wrong], best)).toBe(false);
		// still the old behaviour when the filter is disabled
		expect(isAmbiguousFocal([seed({}), wrong], best, false)).toBe(true);
	});
	it("still vetoes a refine accept whose solve stage reached the floor", () => {
		const real = seed({
			yaw: 47.5,
			stage: "refine",
			solveConfidence: SEED_REFINE_MIN_SOLVE_CONFIDENCE,
			confidence: 0.9,
		});
		expect(isAmbiguousFocal([seed({}), real], best)).toBe(true);
	});
	it("never filters on the best confidence: a weak best stays ambiguous", () => {
		const wrong = seed({ stage: "refine", solveConfidence: 0.01, yaw: 90 });
		expect(
			isAmbiguousFocal([wrong], { camera: { yaw: 43 }, confidence: 0.6 }),
		).toBe(true);
	});
	it("a rejected seed never vetoes, whatever its stage", () => {
		const s = seed({ accepted: false, stage: "refine", yaw: 90 });
		expect(isAmbiguousFocal([s], best)).toBe(false);
	});
});
