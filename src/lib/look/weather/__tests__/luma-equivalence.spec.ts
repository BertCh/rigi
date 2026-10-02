// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The WebGPU weather layer draws with luma's `precipitation` shadertools module. This pins that luma's
// formula, fed the uniforms lumaUniformsFor() produces, lands on Rigi's lattice positions.
import { precipitation } from "@luma.gl/shadertools";
import { describe, expect, it } from "vitest";
import {
	lumaPrecipitationPosition,
	lumaUniformsFor,
	PRECIPITATION_SEED,
	type Precipitation,
	precipitationDrift,
	precipitationPosition,
} from "../precipitation";

const rain = { fallSpeed: 9, wind: [3, 1] as [number, number], volumeM: 400 };
const snow = {
	fallSpeed: 1.4,
	wind: [-2.5, -0.9] as [number, number],
	volumeM: 300,
};
const cases: [string, Pick<Precipitation, "fallSpeed" | "wind" | "volumeM">][] =
	[
		["rain", rain],
		["snow (negative wind drift)", snow],
	];
const centers: [number, number, number][] = [
	[0, 0, 0],
	[30000, -30000, 2500],
	[-12345.6, 7890.1, -40],
];
const times = [0, 12.5, 987.65, 3599.9, 123456.7];

describe("luma precipitation == Rigi lattice", () => {
	it("is the shadertools module whose WGSL source we rely on", () => {
		expect(precipitation.source).toContain("@group(3)");
		expect(precipitation.bindingLayout?.[0]).toEqual({
			name: "precipitation",
			group: 3,
		});
	});

	for (const [name, p] of cases)
		it(`matches for ${name} over ids, centres and times`, () => {
			const size: [number, number, number] = [
				p.volumeM,
				p.volumeM,
				p.volumeM * 0.6,
			];
			let worst = 0;
			for (const c of centers)
				for (const t of times) {
					const u = lumaUniformsFor(p, c, t);
					expect(u.seed).toBe(PRECIPITATION_SEED);
					const drift = precipitationDrift(p, t);
					for (let id = 0; id < 600; id++) {
						const a = lumaPrecipitationPosition(id, u);
						const b = precipitationPosition(id, c, size, drift);
						for (let k = 0; k < 3; k++)
							worst = Math.max(worst, Math.abs(a[k] - b[k]) / size[k]);
					}
				}
			expect(worst).toBeLessThan(1e-6);
		});
});
