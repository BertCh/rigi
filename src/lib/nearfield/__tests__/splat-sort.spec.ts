// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import { SplatSorter } from "../splat-sort";
import { newSortScratch, sortSplatsByDepth } from "../splat-sort.worker";

// Camera at the origin looking down -z (three convention): view z = z, so depth = -z.
const ROW = [0, 0, 1, 0] as const;

describe("sortSplatsByDepth", () => {
	it("orders farthest first and returns the kept count", () => {
		const pos = new Float32Array([0, 0, -1, 0, 0, -9, 0, 0, -5, 0, 0, -3]);
		const out = new Uint32Array(4);
		const n = sortSplatsByDepth(pos, 4, ROW, out);
		expect(n).toBe(4);
		expect([...out]).toEqual([1, 2, 3, 0]);
	});

	it("drops splats at or behind the camera plane and those inside `near`", () => {
		const pos = new Float32Array([0, 0, -4, 0, 0, 2, 0, 0, 0, 0, 0, -0.5]);
		const out = new Uint32Array(4);
		expect(sortSplatsByDepth(pos, 4, ROW, out)).toBe(2);
		expect([...out.subarray(0, 2)]).toEqual([0, 3]);
		expect(sortSplatsByDepth(pos, 4, ROW, out, newSortScratch(4), 1)).toBe(1);
		expect(out[0]).toBe(0);
	});

	it("returns 0 when everything is behind the camera", () => {
		const pos = new Float32Array([0, 0, 1, 0, 0, 2]);
		expect(sortSplatsByDepth(pos, 2, ROW, new Uint32Array(2))).toBe(0);
	});

	it("is a permutation of the kept indices and monotone in depth (up to quantisation)", () => {
		const r = seededRandom(11);
		const n = 2000;
		const pos = new Float32Array(3 * n);
		for (let i = 0; i < n; i++) {
			pos[3 * i] = uniform(r, -10, 10);
			pos[3 * i + 1] = uniform(r, -10, 10);
			pos[3 * i + 2] = uniform(r, -300, 5);
		}
		const out = new Uint32Array(n);
		const kept = sortSplatsByDepth(pos, n, ROW, out);
		let expectedKept = 0;
		for (let i = 0; i < n; i++) if (-pos[3 * i + 2] > 0) expectedKept++;
		expect(kept).toBe(expectedKept);
		const seen = new Set(out.subarray(0, kept));
		expect(seen.size).toBe(kept);
		for (const i of seen) expect(-pos[3 * i + 2]).toBeGreaterThan(0);
		// bucket width = span / 65535 ~ 0.005 m; consecutive depths never increase beyond that
		const bucket = 305 / 65535;
		for (let k = 1; k < kept; k++)
			expect(-pos[3 * out[k] + 2]).toBeLessThanOrEqual(
				-pos[3 * out[k - 1] + 2] + bucket,
			);
	});

	it("handles all splats at identical depth (zero span)", () => {
		const pos = new Float32Array([1, 0, -2, 2, 0, -2, 3, 0, -2]);
		const out = new Uint32Array(3);
		expect(sortSplatsByDepth(pos, 3, ROW, out)).toBe(3);
		expect([...out].sort()).toEqual([0, 1, 2]);
	});

	it("uses the full modelView row, not just z", () => {
		// depth = -(x + d): larger x is nearer the camera
		const pos = new Float32Array([-1, 0, 0, -5, 0, 0, -3, 0, 0]);
		const out = new Uint32Array(3);
		sortSplatsByDepth(pos, 3, [1, 0, 0, 0], out);
		expect([...out]).toEqual([1, 2, 0]);
	});
});

describe("SplatSorter (synchronous path)", () => {
	it("sorts inline, calls back immediately and is never busy", () => {
		const pos = new Float32Array([0, 0, -1, 0, 0, -7, 0, 0, -4]);
		const sorter = new SplatSorter(pos, 3, { worker: false });
		expect(sorter.usingWorker).toBe(false);
		let result: { count: number; indices: Uint32Array } = {
			count: -1,
			indices: new Uint32Array(0),
		};
		const accepted = sorter.sort(ROW, new Uint32Array(3), (r) => {
			result = r;
		});
		expect(accepted).toBe(true);
		expect(sorter.busy).toBe(false);
		expect(result.count).toBe(3);
		expect([...result.indices]).toEqual([1, 2, 0]);
	});

	it("refuses requests after dispose", () => {
		const sorter = new SplatSorter(new Float32Array(3), 1, { worker: false });
		sorter.dispose();
		expect(sorter.sort(ROW, new Uint32Array(1), () => {})).toBe(false);
	});
});
