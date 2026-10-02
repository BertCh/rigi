// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import { viewStats } from "../core";

/** The three former per-view scans, as reference. */
function reference(W: number, H: number, xyz: Float32Array, rgba: Uint8Array) {
	const terrain: number[] = [];
	let n = 0;
	let s = 0;
	let s2 = 0;
	for (let i = 0; i < W * H; i++) {
		if (xyz[i * 3] === 0 && xyz[i * 3 + 1] === 0 && xyz[i * 3 + 2] === 0)
			continue;
		terrain.push(i);
		for (let c = 0; c < 3; c++) {
			const x = rgba[i * 4 + c];
			s += x;
			s2 += x * x;
			n++;
		}
	}
	const rgbStd = n ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : 0;
	return { terrain, rgbStd };
}

function randomView(seed: number, W: number, H: number, skyFrac: number) {
	const rand = seededRandom(seed);
	const xyz = new Float32Array(W * H * 3);
	const rgba = new Uint8Array(W * H * 4);
	for (let i = 0; i < W * H; i++) {
		for (let c = 0; c < 4; c++) rgba[i * 4 + c] = Math.floor(rand() * 256);
		if (rand() < skyFrac) continue;
		for (let c = 0; c < 3; c++) xyz[i * 3 + c] = rand() * 2000 - 1000;
		// a terrain point may sit on one zero axis
		if (rand() < 0.1) xyz[i * 3] = 0;
	}
	return { W, H, xyz, rgba };
}

describe("viewStats", () => {
	it("equals the former terrain-count, terrain-index and rgbStd scans", () => {
		for (const [seed, sky] of [
			[1, 0.3],
			[2, 0],
			[3, 0.95],
		] as const) {
			const v = randomView(seed, 37, 23, sky);
			const ref = reference(v.W, v.H, v.xyz, v.rgba);
			const got = viewStats(v);
			expect(Array.from(got.terrain)).toEqual(ref.terrain);
			expect(got.rgbStd).toBeCloseTo(ref.rgbStd, 9);
		}
	});
	it("an all-sky view has no terrain and zero spread", () => {
		const v = randomView(4, 8, 8, 1);
		const got = viewStats(v);
		expect(got.terrain.length).toBe(0);
		expect(got.rgbStd).toBe(0);
	});
	it("a view without rgba still lists its terrain (rgbStd 0)", () => {
		const v = { ...randomView(5, 9, 7, 0.5), rgba: new Uint8Array(0) };
		const got = viewStats(v);
		expect(got.terrain.length).toBeGreaterThan(0);
		expect(got.rgbStd).toBe(0);
	});
	it("is memoised per xyz buffer", () => {
		const v = randomView(6, 5, 5, 0.2);
		expect(viewStats(v)).toBe(viewStats({ ...v }));
	});
});
