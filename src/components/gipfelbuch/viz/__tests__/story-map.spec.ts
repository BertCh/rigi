// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { GipfelbuchPeak, GipfelbuchPhotoData } from "../real";
import {
	BEAT_MS,
	coneFitBox,
	DRAW_MS,
	followMode,
	footprintRuns,
	LEAD_MS,
	mapPeakSet,
	mixHex,
	peakInk,
	REPLAY_FADE_MS,
	RESULT_HOLD,
	rayDraw,
	SWEEP_MS,
	searchT,
	splitByCone,
	wrap180,
} from "../story-map";

const peak = (
	name: string,
	solved: [number, number] | null,
	prior: [number, number] | null,
	extra: Partial<GipfelbuchPeak> = {},
): GipfelbuchPeak => ({
	name,
	ele: 2000,
	dem: 2000,
	az: 0,
	el: 5,
	distance: 3000,
	visible: true,
	labelled: true,
	solved,
	prior,
	...extra,
});

function fake(
	peaks: GipfelbuchPeak[],
	profile: { az: number; d: number }[] = [],
	over: Record<string, unknown> = {},
) {
	return {
		id: "demo-test",
		photo: { width: 800, height: 600 },
		demPatch: { halfKm: 5 },
		prior: { yaw: 0, hfov: 60 },
		solved: { yaw: 20, hfov: 60 },
		horizon: {
			step: 1,
			profile: profile.map((p) => ({ ...p, el: 0, ridges: [] })),
		},
		peaks,
		...over,
	} as unknown as GipfelbuchPhotoData;
}

describe("mapPeakSet", () => {
	it("names the photo's label set: solved then prior in crop, deduped, capped", () => {
		const d = fake([
			peak("A", [100, 100], [900, 100]),
			peak("B", [900, 100], [100, 100]),
			peak("C", [200, 100], null),
			peak("D", [300, 100], [300, 100]),
		]);
		const { named } = mapPeakSet(d, { crop: [0, 0, 400, 400], maxLabels: 2 });
		expect(named.map((p) => p.name)).toEqual(["A", "C", "B", "D"]);
		expect(mapPeakSet(d).named.map((p) => p.name)).toEqual([
			"A",
			"C",
			"D",
			"B",
		]);
	});
	it("puts other labelled peaks in the patch into context", () => {
		const d = fake([
			peak("A", [10, 10], null),
			peak("Near", null, null, { distance: 1000 }),
			peak("Far", null, null, { distance: 99000 }),
			peak("Unlabelled", null, null, { labelled: false }),
		]);
		const { named, context } = mapPeakSet(d);
		expect(named.map((p) => p.name)).toEqual(["A"]);
		expect(context.map((p) => p.name)).toEqual(["Near"]);
	});
});

describe("footprintRuns", () => {
	it("splits where the distance jumps, drops one-point runs and points outside", () => {
		const profile = [
			{ az: 0, d: 3000 },
			{ az: 1, d: 3010 },
			{ az: 2, d: 3020 },
			{ az: 3, d: 5000 }, // jump
			{ az: 4, d: 5010 },
			{ az: 5, d: 9000 }, // jump, lone point
			{ az: 6, d: 90000 }, // outside the square
			{ az: 7, d: 3000 },
			{ az: 8, d: 3000 },
		];
		const runs = footprintRuns(fake([], profile, { demPatch: { halfKm: 20 } }));
		expect(runs.map((r) => r.pts.length)).toEqual([3, 2, 2]);
		expect(runs[0].az0).toBe(0);
		expect(runs[0].az1).toBe(2);
		for (const r of runs)
			for (const [x, y] of r.pts) {
				expect(x).toBeGreaterThan(4);
				expect(y).toBeLessThan(396);
			}
	});
	it("splits where the azimuth steps by more than two profile steps", () => {
		const runs = footprintRuns(
			fake(
				[],
				[
					{ az: 0, d: 3000 },
					{ az: 1, d: 3000 },
					{ az: 10, d: 3000 },
					{ az: 11, d: 3000 },
				],
			),
		);
		expect(runs).toHaveLength(2);
	});
});

describe("splitByCone", () => {
	it("covers every point and keeps the inside part in the cone", () => {
		const profile = Array.from({ length: 41 }, (_, i) => ({
			az: i - 20,
			d: 3000,
		}));
		const runs = footprintRuns(fake([], profile));
		expect(runs).toHaveLength(1);
		const { inside, outside } = splitByCone(runs, 0, 10);
		expect(inside).toHaveLength(1);
		expect(outside).toHaveLength(2);
		for (const az of inside[0].azs.slice(1, -1))
			expect(Math.abs(wrap180(az))).toBeLessThanOrEqual(5);
		const total = [...inside, ...outside].reduce((n, r) => n + r.pts.length, 0);
		expect(total).toBe(41 + 4); // four shared boundary points
	});
	it("wraps across north", () => {
		const profile = Array.from({ length: 21 }, (_, i) => ({
			az: (350 + i) % 360,
			d: 3000,
		}));
		const { inside } = splitByCone(footprintRuns(fake([], profile)), 0, 10);
		expect(inside).toHaveLength(1);
	});
});

describe("peakInk, rayDraw, followMode", () => {
	it("mixes the guess ink to the solved ink inside the cone, null outside", () => {
		expect(peakInk(0.5, false)).toBeNull();
		expect(peakInk(0, true)).toBe("#ab343a");
		expect(peakInk(1, true)).not.toBe(peakInk(0, true));
		expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
		expect(mixHex("#000000", "#ffffff", 2)).toBe("#ffffff");
	});
	it("draws every ray in full at t = 1, none before 0.82, monotone in t", () => {
		for (let count = 1; count <= 10; count++)
			for (let rank = 0; rank < count; rank++) {
				expect(rayDraw(1, rank, count)).toBe(1);
				expect(rayDraw(0.82, rank, count)).toBe(0);
				expect(rayDraw(0.3, rank, count)).toBe(0);
				let last = 0;
				for (let t = 0.8; t <= 1.0001; t += 0.02) {
					const k = rayDraw(t, rank, count);
					expect(k).toBeGreaterThanOrEqual(last);
					last = k;
				}
			}
	});
	it("staggers rays by rank", () => {
		expect(rayDraw(0.9, 5, 6)).toBeLessThan(rayDraw(0.9, 0, 6));
	});
	it("follows a run of small fast steps at once and settles on a jump", () => {
		expect(
			followMode({ target: 0.5, at: 1000 }, { target: 0.53, at: 1016 }),
		).toBe("instant");
		expect(followMode({ target: 0, at: 1000 }, { target: 1, at: 1016 })).toBe(
			"settle",
		);
		expect(
			followMode({ target: 0.5, at: 1000 }, { target: 0.52, at: 1400 }),
		).toBe("settle");
	});
});

describe("coneFitBox", () => {
	const d = fake([]);
	it("has the requested aspect, stays inside the square and holds the camera", () => {
		for (const aspect of [4 / 3, 1, 3 / 4]) {
			const b = coneFitBox(d, aspect);
			expect(b.w / b.h).toBeCloseTo(aspect, 6);
			expect(b.x).toBeGreaterThanOrEqual(0);
			expect(b.y).toBeGreaterThanOrEqual(0);
			expect(b.x + b.w).toBeLessThanOrEqual(400 + 1e-9);
			expect(b.y + b.h).toBeLessThanOrEqual(400 + 1e-9);
			expect(b.x).toBeLessThanOrEqual(200);
			expect(b.x + b.w).toBeGreaterThanOrEqual(200);
			expect(b.y).toBeLessThanOrEqual(200);
			expect(b.y + b.h).toBeGreaterThanOrEqual(200);
		}
	});
	it("falls back to a central crop of the whole square for an all-round cone", () => {
		const wide = fake([], [], {
			prior: { yaw: 0, hfov: 340 },
			solved: { yaw: 0, hfov: 340 },
		});
		expect(coneFitBox(wide, 4 / 3)).toEqual({ x: 0, y: 50, w: 400, h: 300 });
	});
});

describe("searchT", () => {
	it("runs lead, sweep, hold, fade and loops", () => {
		const hold = BEAT_MS * RESULT_HOLD;
		const total = LEAD_MS + SWEEP_MS + hold + REPLAY_FADE_MS;
		expect(searchT(0)).toEqual({ t: 0, phase: "lead", fade: 0, rays: 0 });
		expect(searchT(LEAD_MS + 1).phase).toBe("sweep");
		const held = searchT(LEAD_MS + SWEEP_MS + 10);
		expect(held).toMatchObject({ t: 1, phase: "hold", fade: 0 });
		expect(held.rays).toBeGreaterThan(0);
		expect(held.rays).toBeLessThan(0.1);
		expect(searchT(LEAD_MS + SWEEP_MS + DRAW_MS + 1).rays).toBe(1);
		const mid = searchT(LEAD_MS + SWEEP_MS + hold + REPLAY_FADE_MS / 2);
		expect(mid.phase).toBe("fade");
		expect(mid.fade).toBeCloseTo(0.5, 6);
		expect(searchT(total + 5).phase).toBe("lead");
	});
	it("keeps the rays off through the sweep's overshoot and on through the fade", () => {
		for (let ms = 0; ms < LEAD_MS + SWEEP_MS; ms += 25)
			expect(searchT(ms).rays).toBe(0);
		expect(searchT(LEAD_MS + SWEEP_MS + BEAT_MS * RESULT_HOLD + 10).rays).toBe(
			1,
		);
	});
	it("starts at the guess, overshoots past it and settles at the solved pose", () => {
		expect(searchT(LEAD_MS).t).toBeCloseTo(0, 6);
		let lo = 1;
		let hi = 0;
		for (let ms = LEAD_MS; ms < LEAD_MS + SWEEP_MS; ms += 20) {
			const { t } = searchT(ms);
			lo = Math.min(lo, t);
			hi = Math.max(hi, t);
		}
		expect(lo).toBeGreaterThanOrEqual(0);
		expect(hi).toBeGreaterThan(1);
		expect(searchT(LEAD_MS + SWEEP_MS - 1).t).toBeCloseTo(1, 1);
	});
});
