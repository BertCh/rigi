// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import { liftRecordsCpu } from "../../local/lift";
import {
	blockTapPixels,
	cellCentre,
	chooseLiveGrid,
	LiveSchedule,
	refreshColourCpu,
	tapsPerAxis,
} from "../schedule";

describe("LiveSchedule", () => {
	it("runs depth on frames 0, N, 2N and refreshes colour every frame", () => {
		const s = new LiveSchedule({ depthEvery: 3, refitEvery: 100 });
		const plans = Array.from({ length: 10 }, () => s.next());
		expect(plans.map((p) => p.runDepth)).toEqual([
			true,
			false,
			false,
			true,
			false,
			false,
			true,
			false,
			false,
			true,
		]);
		expect(plans.every((p) => p.refreshColour)).toBe(true);
		expect(plans.map((p) => p.depthRun)).toEqual([
			0, 0, 0, 1, 1, 1, 2, 2, 2, 3,
		]);
	});

	it("defers a due run until the net outputs are ready, then restarts the cadence there", () => {
		const s = new LiveSchedule({ depthEvery: 2, refitEvery: 100 });
		expect(s.next({ depthReady: false }).runDepth).toBe(false); // frame 0, due, not ready
		expect(s.next({ depthReady: false }).runDepth).toBe(false); // frame 1
		expect(s.next({ depthReady: true }).runDepth).toBe(true); // frame 2 runs
		expect(s.next().runDepth).toBe(false); // frame 3: cadence counts from frame 2
		expect(s.next().runDepth).toBe(true); // frame 4
		expect(s.depthRuns).toBe(2);
	});

	it("isDepthDue agrees with next() without advancing", () => {
		const s = new LiveSchedule({ depthEvery: 4, refitEvery: 100 });
		for (let f = 0; f < 20; f++) {
			const due = s.isDepthDue();
			expect(s.isDepthDue()).toBe(due);
			expect(s.next().runDepth).toBe(due);
		}
	});

	it("refits on every K-th depth run after the first, never on frames without depth", () => {
		const s = new LiveSchedule({ depthEvery: 1, refitEvery: 3 });
		const refits = Array.from({ length: 10 }, () => s.next()).map(
			(p) => p.refit,
		);
		// depth runs 0..9: refit when the count of previous runs is a positive multiple of 3
		expect(refits).toEqual([
			false,
			false,
			false,
			true,
			false,
			false,
			true,
			false,
			false,
			true,
		]);
		const t = new LiveSchedule({
			depthEvery: 2,
			refitEvery: Number.POSITIVE_INFINITY,
		});
		expect(
			Array.from({ length: 20 }, () => t.next()).some((p) => p.refit),
		).toBe(false);
	});

	it("treats depthEvery < 1 as 1 and reset() restarts at frame 0", () => {
		const s = new LiveSchedule({ depthEvery: 0, refitEvery: 5 });
		expect(s.next().runDepth && s.next().runDepth).toBe(true);
		s.reset();
		expect(s.next().frame).toBe(0);
		expect(s.depthRuns).toBe(1);
	});
});

describe("chooseLiveGrid", () => {
	it("keeps the still-photo stride 2 when it fits the budget", () => {
		expect(chooseLiveGrid(1024, 683, 250_000)).toEqual({
			stride: 2,
			gw: 512,
			gh: 341,
			capacity: 512 * 341,
		});
	});

	it("raises the stride until the cell grid fits", () => {
		const g = chooseLiveGrid(1024, 683, 50_000);
		expect(g.capacity).toBeLessThanOrEqual(50_000);
		expect(g.stride).toBe(4);
		// the previous stride would not have fit
		expect(Math.floor(1024 / 3) * Math.floor(683 / 3)).toBeGreaterThan(50_000);
	});

	it("never returns an empty grid", () => {
		const g = chooseLiveGrid(8, 8, 1);
		expect(g.capacity).toBeGreaterThanOrEqual(1);
	});
});

describe("colour refresh index math", () => {
	it("one tap pair per pixel when the video matches the depth grid at stride 2", () => {
		expect(tapsPerAxis(2, 1024, 1024)).toBe(2);
		expect(blockTapPixels(5, 2, 1024, 1024)).toEqual([10, 11]);
	});

	it("scales taps with a larger video and caps them at 4", () => {
		expect(tapsPerAxis(2, 512, 1920)).toBe(4);
		expect(tapsPerAxis(2, 512, 512)).toBe(2);
		expect(tapsPerAxis(2, 1024, 256)).toBe(1);
		const px = blockTapPixels(3, 2, 512, 1920);
		expect(px).toHaveLength(4);
		// all taps inside the cell's span [3·2·3.75, 4·2·3.75) = [22.5, 30)
		for (const x of px) {
			expect(x).toBeGreaterThanOrEqual(22);
			expect(x).toBeLessThan(30);
		}
	});

	it("stays inside the texture at the last cell", () => {
		const px = blockTapPixels(511, 2, 512, 1920);
		for (const x of px) expect(x).toBeLessThanOrEqual(1919);
		expect(blockTapPixels(0, 2, 512, 7).every((x) => x >= 0)).toBe(true);
	});

	it("cellCentre is the lift's centre pixel", () => {
		expect(cellCentre(7 * 10 + 3, 10, 2)).toEqual({
			gi: 3,
			gj: 7,
			px: 7,
			py: 15,
		});
	});

	it("matches the CPU lift's block-mean colour when the video is the depth grid", () => {
		const rand = seededRandom(7);
		const W = 12;
		const H = 8;
		const rgba = new Uint8Array(4 * W * H);
		for (let i = 0; i < rgba.length; i++) rgba[i] = Math.floor(rand() * 256);
		const depth = new Float32Array(W * H).fill(10);
		const { grid, records } = liftRecordsCpu({
			width: W,
			height: H,
			depth,
			valid: new Uint8Array(W * H).fill(1),
			rgba,
			K: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 },
		});
		const u = new Uint32Array(records.buffer);
		for (let gj = 0; gj < grid.gh; gj++)
			for (let gi = 0; gi < grid.gw; gi++)
				expect(refreshColourCpu(rgba, W, H, gi, gj, 2, W, H)).toBe(
					u[(gj * grid.gw + gi) * 12 + 10],
				);
	});

	it("averages a larger video over the cell's span", () => {
		// a 4×4 video, depth grid 2×2 at stride 1: each cell is a 2×2 block of the video
		const rgba = new Uint8Array(4 * 16);
		for (let y = 0; y < 4; y++)
			for (let x = 0; x < 4; x++) {
				const k = 4 * (y * 4 + x);
				rgba[k] = x < 2 ? 10 : 200;
				rgba[k + 1] = y < 2 ? 20 : 100;
				rgba[k + 2] = 0;
				rgba[k + 3] = 255;
			}
		const c = refreshColourCpu(rgba, 4, 4, 1, 0, 1, 2, 2);
		expect([c & 255, (c >>> 8) & 255, (c >>> 16) & 255, c >>> 24]).toEqual([
			200, 20, 0, 255,
		]);
	});
});
