// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { DEFAULT_SIGMA } from "#/lib/geo/solve";
import { finish, fullSearchOptions, selectCoarse, type YawCost } from "../cpu";

const yc = (dy: number, c: number): YawCost => ({ dy, dp: 0, c });

describe("coarse selection", () => {
	// costs: two basins, at dy=0 (deep) and dy=10 (shallow)
	const costs = [5, 4, 1, 4, 5, 6, 6, 5, 3, 5, 6, 7];
	const rows = costs.map((c, i) => yc(i * 1.2 - 2.4, c));
	it("finds the global minimum, seeds >1.5 deg apart, runner-up and ambiguity", () => {
		const r = selectCoarse(rows, 7);
		expect(r.best.c).toBe(1);
		expect(r.coarse).toEqual({ yaw: rows[2].dy, pitch: 0 });
		expect(r.seeds[0]).toBe(rows[2]);
		for (const s of r.seeds.slice(1))
			expect(Math.abs(s.dy - r.seeds[0].dy)).toBeGreaterThan(1.5);
		expect(r.seeds.length).toBeLessThanOrEqual(3);
		expect(r.runnerUp).toBe(rows[8]);
		expect(r.nYaw).toBe(12);
		expect(r.nPitch).toBe(7);
		expect(r.ambiguity).toBeGreaterThan(0);
		expect(r.ambiguity).toBeLessThanOrEqual(1);
	});
	it("ambiguity is 0 without a runner-up or spread", () => {
		const best = yc(0, 1);
		expect(finish(best, [best], undefined, 5, 1, 1).ambiguity).toBe(0);
		expect(finish(best, [best], yc(5, 2), 1, 1, 1).ambiguity).toBe(0);
		// a runner-up as deep as the best is fully ambiguous
		expect(finish(best, [best], yc(5, 1), 5, 1, 1).ambiguity).toBe(1);
	});
	it("fullSearchOptions widens yaw and frees the yaw prior", () => {
		const o = fullSearchOptions({ pitchRange: 3 } as never);
		expect(o.yawRange).toBe(180);
		expect(o.sigma?.yaw).toBe(1e6);
		expect(o.sigma?.pitch).toBe(DEFAULT_SIGMA.pitch);
		expect((o as { pitchRange?: number }).pitchRange).toBe(3);
	});
});
