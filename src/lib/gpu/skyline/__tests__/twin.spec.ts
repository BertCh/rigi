// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { resolveOptions, viterbi } from "#/lib/geo/skyline";
import { seededRandom } from "#/test/helpers";
import { skylineUnary, viterbiWindowed } from "../twin";
import { packSkylineDetect, skylineDpWindow } from "../uniforms";

function randomPlanes(w: number, h: number, seed: number) {
	const rnd = seededRandom(seed);
	const sky = new Float32Array(w * h);
	const edge = new Float32Array(w * h);
	// a noisy ridge so the DP has structure to follow
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const ridge = h * 0.5 + 0.2 * h * Math.sin(x / 3 + seed);
			sky[y * w + x] = y < ridge ? 0.7 + 0.3 * rnd() : 0.3 * rnd();
			edge[y * w + x] =
				Math.abs(y - ridge) < 2 ? 0.1 + 0.3 * rnd() : 0.02 * rnd();
		}
	return { sky, edge };
}

describe("skyline Viterbi GPU twins", () => {
	it("the truncated-window DP equals geo/skyline viterbi", () => {
		let compared = 0;
		for (let seed = 1; seed <= 12; seed++) {
			const w = 6 + (seed % 5) * 7;
			const h = 20 + (seed % 4) * 13;
			const { sky, edge } = randomPlanes(w, h, seed);
			// small caps force the truncation window to matter
			for (const [jumpCost, jumpCap] of [
				[2, 80],
				[2, 7],
				[0.5, 3],
				[3, 10],
			]) {
				const o = resolveOptions(h, { jumpCost, jumpCap }).o;
				const ref = viterbi(sky, edge, w, h, o);
				const got = viterbiWindowed(
					skylineUnary(sky, edge, w, h, o),
					w,
					h + 1,
					jumpCost,
					jumpCap,
				);
				expect([...got]).toEqual([...ref]);
				compared += w;
			}
		}
		expect(compared).toBeGreaterThan(500);
	});

	it("covers every column of a single-column image", () => {
		const { sky, edge } = randomPlanes(1, 30, 3);
		const o = resolveOptions(30, {}).o;
		const got = viterbiWindowed(
			skylineUnary(sky, edge, 1, 30, o),
			1,
			31,
			2,
			80,
		);
		expect([...got]).toEqual([...viterbi(sky, edge, 1, 30, o)]);
	});

	it("window is ceil(cap / cost), clamped to the rows", () => {
		expect(skylineDpWindow(2, 80, 601)).toBe(40);
		expect(skylineDpWindow(3, 10, 601)).toBe(4);
		expect(skylineDpWindow(2, 80, 20)).toBe(19);
		expect(skylineDpWindow(0, 80, 20)).toBe(19);
	});

	it("packs a 64-byte uniform with the fit grid", () => {
		const o = {
			belowBand: 9,
			aboveBand: 12,
			edgeWeight: 60,
			jumpCost: 2,
			jumpCap: 80,
		};
		const words = new Uint32Array(packSkylineDetect(30, 17, o));
		expect(words.byteLength).toBe(64);
		expect([...words.subarray(0, 4)]).toEqual([30, 17, 510, 18]);
		const nx = 8;
		const ny = 5;
		expect(words[7]).toBe(nx * ny);
		expect(words[8]).toBe(1);
		expect(words[9]).toBe(nx);
	});
});
