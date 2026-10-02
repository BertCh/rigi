// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors
// synth.ts must regenerate the arrays the Python reference (fixtures/make_fixtures.py) saw:
// per-array checksums stored in fixtures/fusion.json are compared to 1e-9 relative.
import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/fusion.json";
import { checksumArray, makeScenario, SCENARIOS } from "./fixtures/synth";

type Checksum = {
	n: number;
	sum: number;
	sumsq: number;
	first: number;
	last: number;
};
const recorded = fixtures as unknown as Record<
	string,
	{ params: unknown; checksums: Record<string, Checksum> }
>;

function expectClose(actual: number, expected: number, label: string) {
	const tolerance = 1e-9 * Math.max(1, Math.abs(expected));
	expect(
		Math.abs(actual - expected),
		`${label}: ${actual} vs ${expected}`,
	).toBeLessThanOrEqual(tolerance);
}

describe("synth scenarios match the Python twin", () => {
	it("lists the same scenarios and params as fusion.json", () => {
		expect(SCENARIOS.map((s) => s.name)).toEqual(Object.keys(recorded));
		for (const params of SCENARIOS) {
			expect(recorded[params.name].params).toEqual(params);
		}
	});

	for (const params of SCENARIOS) {
		it(`${params.name}: array checksums`, () => {
			const scenario = makeScenario(params);
			const expected = recorded[params.name].checksums;
			expect(Object.keys(scenario).sort()).toEqual(
				Object.keys(expected).sort(),
			);
			for (const [key, array] of Object.entries(scenario)) {
				const got = checksumArray(array);
				const want = expected[key];
				expect(got.n, `${key} length`).toBe(want.n);
				for (const field of ["sum", "sumsq", "first", "last"] as const) {
					expectClose(
						got[field],
						want[field],
						`${params.name}.${key}.${field}`,
					);
				}
			}
		});
	}

	it("is deterministic and has the requested shape", () => {
		const a = makeScenario(SCENARIOS[0]);
		const b = makeScenario(SCENARIOS[0]);
		expect(a.sky).toEqual(b.sky);
		expect(a.x2d.length).toBe(SCENARIOS[0].nCorr * 2);
		expect(a.X.length).toBe(SCENARIOS[0].nCorr * 3);
		expect(a.dirs.length).toBe(1801 * 3);
		expect(a.xyz.length).toBe(48 * 64 * 3);
		expect(makeScenario(SCENARIOS[2]).x2d.length).toBe(0);
	});
});
