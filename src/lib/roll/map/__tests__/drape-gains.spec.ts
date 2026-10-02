// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { unprojectDir } from "#/lib/camera";
import { CLEAR_AIR_OFF } from "#/lib/look/clear-air";
import {
	type GainPhoto,
	type RangeGrid,
	sampleGrid,
	solveGains,
} from "../drape-gains";

type Cam = Parameters<typeof sampleGrid>[0];

const camAt = (x: number, y: number, yaw: number, aspect = 4 / 3): Cam => ({
	pose: { yaw, pitch: -20, roll: 0, vfov: 50 },
	eye: [x, y, 600],
	aspect,
});

/** Range map of the flat ground z = 0 seen by `cam` (0 = sky). */
function groundRange(cam: Cam, w = 32, h = 24): RangeGrid {
	const data = new Float32Array(w * h);
	for (let j = 0; j < h; j++)
		for (let i = 0; i < w; i++) {
			const d = unprojectDir(
				cam.pose,
				cam.aspect,
				(i + 0.5) / w,
				(j + 0.5) / h,
			);
			data[j * w + i] = d[2] < -1e-3 ? -cam.eye[2] / d[2] : 0;
		}
	return { w, h, data };
}

const solid = (r: number, g: number, b: number, w = 40, h = 30) => {
	const data = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < w * h; i++) data.set([r, g, b, 255], i * 4);
	return { width: w, height: h, data };
};

describe("sampleGrid", () => {
	const cam = camAt(0, 0, 0);

	it("sizes the grid by aspect, 64 on the long side", () => {
		const land = sampleGrid(cam, groundRange(cam), solid(100, 100, 100));
		expect([land.gw, land.gh]).toEqual([64, 48]);
		const portrait = camAt(0, 0, 0, 0.75);
		const p = sampleGrid(portrait, groundRange(portrait), solid(100, 100, 100));
		expect([p.gw, p.gh]).toEqual([48, 64]);
		expect(land.pos).toHaveLength(64 * 48 * 3);
		expect(land.col).toHaveLength(64 * 48 * 3);
	});

	it("puts ground samples on the ground plane along the cell ray", () => {
		const s = sampleGrid(cam, groundRange(cam), solid(100, 100, 100));
		let n = 0;
		for (let i = 0; i < s.gw * s.gh; i++) {
			if (Number.isNaN(s.pos[i * 3])) continue;
			n++;
			expect(Math.abs(s.pos[i * 3 + 2])).toBeLessThan(40); // within the coarse range map's error
		}
		expect(n).toBeGreaterThan(s.gw * s.gh * 0.5);
	});

	it("averages the colour in linear light", () => {
		const s = sampleGrid(cam, groundRange(cam), solid(255, 0, 128));
		expect(s.col[0]).toBeCloseTo(1, 5);
		expect(s.col[1]).toBeCloseTo(0, 5);
		expect(s.col[2]).toBeCloseTo(0.2158, 3); // sRGB 128 is about 0.216 linear
	});

	it("leaves sky and out-of-reach cells without a position but keeps their colour", () => {
		const sky = { w: 4, h: 4, data: new Float32Array(16) };
		const s = sampleGrid(cam, sky, solid(255, 255, 255));
		expect(s.pos.every(Number.isNaN)).toBe(true);
		expect(s.col[0]).toBeCloseTo(1, 5);
		const near = { w: 4, h: 4, data: new Float32Array(16).fill(50) };
		expect(sampleGrid(cam, near, solid(1, 1, 1)).pos.every(Number.isNaN)).toBe(
			true,
		);
		const far = { w: 4, h: 4, data: new Float32Array(16).fill(20_000) };
		expect(sampleGrid(cam, far, solid(1, 1, 1)).pos.every(Number.isNaN)).toBe(
			true,
		);
	});

	it("skips cells at a depth discontinuity", () => {
		const w = 8;
		const h = 8;
		const data = new Float32Array(w * h).fill(1000);
		for (let j = 0; j < h; j++)
			for (let i = w / 2; i < w; i++) data[j * w + i] = 3000;
		const s = sampleGrid(cam, { w, h, data }, solid(10, 10, 10));
		const col = (gx: number) => Number.isNaN(s.pos[(10 * s.gw + gx) * 3]);
		expect(col(5)).toBe(false); // flat, far from the step
		expect(col(s.gw / 2 - 1)).toBe(true); // either side of the step
		expect(col(s.gw / 2)).toBe(true);
	});
});

describe("solveGains", () => {
	function photoOf(cam: Cam, rgb: [number, number, number]): GainPhoto {
		const range = groundRange(cam);
		return {
			cam,
			range,
			samples: sampleGrid(cam, range, solid(...rgb)),
			values: CLEAR_AIR_OFF,
		};
	}

	it("needs at least two photos", async () => {
		expect(await solveGains([])).toBeNull();
		expect(
			await solveGains([photoOf(camAt(0, 0, 0), [90, 90, 90])]),
		).toBeNull();
	});

	it("is null when the photos see different ground", async () => {
		const a = photoOf(camAt(0, 0, 0), [90, 90, 90]);
		const b = photoOf(camAt(0, 0, 180), [90, 90, 90]);
		expect(await solveGains([a, b])).toBeNull();
	});

	it("gives unit gains to overlapping photos that already agree", async () => {
		const a = photoOf(camAt(0, 0, 0), [90, 120, 150]);
		const b = photoOf(camAt(40, 10, 5), [90, 120, 150]);
		const g = await solveGains([a, b]);
		expect(g).not.toBeNull();
		for (const gain of g ?? [])
			for (const c of gain) expect(c).toBeCloseTo(1, 1);
	});

	it("brightens the darker photo and dims the brighter, symmetrically about 1", async () => {
		const dark = photoOf(camAt(0, 0, 0), [60, 60, 60]);
		const bright = photoOf(camAt(40, 10, 5), [120, 120, 120]);
		const g = (await solveGains([dark, bright])) as number[][];
		expect(g[0][1]).toBeGreaterThan(1.05);
		expect(g[1][1]).toBeLessThan(0.95);
		// the corrected photos agree better than the originals (log ratio shrinks)
		const before = Math.abs(Math.log(0.1329 / 0.0452)); // linear 120 vs 60
		const after = Math.abs(Math.log((0.1329 * g[1][1]) / (0.0452 * g[0][1])));
		expect(after).toBeLessThan(before * 0.6);
		for (const gain of g)
			for (const c of gain) {
				expect(c).toBeGreaterThanOrEqual(0.5);
				expect(c).toBeLessThanOrEqual(2);
			}
	});

	it("fixes a colour cast per channel", async () => {
		const a = photoOf(camAt(0, 0, 0), [100, 100, 100]);
		const b = photoOf(camAt(40, 10, 5), [140, 100, 100]);
		const g = (await solveGains([a, b])) as number[][];
		expect(g[1][0]).toBeLessThan(g[0][0]);
		expect(g[1][1]).toBeCloseTo(g[0][1], 1);
	});

	it("stops with null when the request is stale", async () => {
		const a = photoOf(camAt(0, 0, 0), [60, 60, 60]);
		const b = photoOf(camAt(40, 10, 5), [120, 120, 120]);
		expect(await solveGains([a, b], () => true)).toBeNull();
	});
});
