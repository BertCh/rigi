// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MOTION } from "../motion";
import type { GipfelbuchPeak, GipfelbuchPhotoData } from "../real";
import {
	coneFitBox,
	declutterRim,
	followMode,
	footprintRuns,
	mapPeakSet,
	mixHex,
	peakInk,
	placeNamed,
	rayDraw,
	SEARCH_LOOP_MS,
	searchT,
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
	it("follows any stream of fast updates at once, even with big steps", () => {
		expect(
			followMode({ target: 0.5, at: 1000 }, { target: 0.53, at: 1016 }),
		).toBe("instant");
		// a fast drag: 0.1 steps 16 ms apart
		expect(
			followMode({ target: 0.5, at: 1000 }, { target: 0.6, at: 1016 }),
		).toBe("instant");
		expect(
			followMode({ target: 0.5, at: 1000 }, { target: 0.52, at: 1400 }),
		).toBe("instant");
	});
	it("settles on a lone jump", () => {
		expect(followMode({ target: 0, at: 1000 }, { target: 1, at: 1400 })).toBe(
			"settle",
		);
		expect(
			followMode({ target: 0.5, at: 1000 }, { target: 0.6, at: 1200 }),
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
		const b = coneFitBox(wide, 4 / 3);
		expect(b.w).toBe(400);
		expect(b.h).toBeCloseTo(300, 6);
		expect(b.y).toBeGreaterThanOrEqual(0);
		expect(b.y + b.h).toBeLessThanOrEqual(400 + 1e-9);
	});
});

describe("searchT", () => {
	const hold = MOTION.beat * MOTION.resultHold;
	const lead0 = MOTION.replayFade;
	const sweep0 = lead0 + MOTION.lead;
	const hold0 = sweep0 + MOTION.sweep;
	const out0 = hold0 + hold;
	it("runs fadeIn, lead, sweep, hold, fadeOut and loops", () => {
		expect(SEARCH_LOOP_MS).toBe(out0 + MOTION.replayFade);
		expect(searchT(0)).toEqual({ t: 0, phase: "fadeIn", opacity: 0, rays: 0 });
		expect(searchT(MOTION.replayFade / 2)).toMatchObject({
			phase: "fadeIn",
			opacity: 0.5,
			t: 0,
		});
		expect(searchT(lead0 + 1).phase).toBe("lead");
		expect(searchT(sweep0 + 1).phase).toBe("sweep");
		const held = searchT(hold0 + 10);
		expect(held).toMatchObject({ t: 1, phase: "hold", opacity: 1 });
		expect(held.rays).toBeGreaterThan(0);
		expect(held.rays).toBeLessThan(0.1);
		expect(searchT(hold0 + MOTION.draw + 1).rays).toBe(1);
		const mid = searchT(out0 + MOTION.replayFade / 2);
		expect(mid.phase).toBe("fadeOut");
		expect(mid.opacity).toBeCloseTo(0.5, 6);
		expect(searchT(SEARCH_LOOP_MS + 5).phase).toBe("fadeIn");
	});
	it("is continuous in opacity across the loop wrap", () => {
		const end = searchT(SEARCH_LOOP_MS - 0.001).opacity;
		const start = searchT(SEARCH_LOOP_MS).opacity;
		expect(Math.abs(end - start)).toBeLessThan(1e-3);
	});
	it("keeps the rays off through the sweep's overshoot and on through the fade out", () => {
		for (let ms = 0; ms < hold0; ms += 25) expect(searchT(ms).rays).toBe(0);
		expect(searchT(out0 + 10).rays).toBe(1);
	});
	it("starts the sweep at the guess, overshoots past the solved pose and settles on it", () => {
		expect(searchT(sweep0).t).toBeCloseTo(0, 6);
		let lo = 1;
		let hi = 0;
		for (let ms = sweep0; ms < hold0; ms += 20) {
			const { t } = searchT(ms);
			lo = Math.min(lo, t);
			hi = Math.max(hi, t);
		}
		expect(lo).toBeGreaterThanOrEqual(0);
		expect(hi).toBeGreaterThan(1);
		expect(searchT(hold0 - 1).t).toBeCloseTo(1, 1);
	});
});

// ---- real data: the tracked demo JSONs ----

const DEMOS = Array.from({ length: 12 }, (_, i) => {
	const id = `demo-${String(i + 1).padStart(2, "0")}`;
	return JSON.parse(
		readFileSync(`public/demo/gipfelbuch/${id}.json`, "utf8"),
	) as GipfelbuchPhotoData;
});

describe("placeNamed and declutterRim", () => {
	it("places every named peak: exact inside the square, on the rim beyond it", () => {
		let rimmed = 0;
		for (const d of DEMOS) {
			const { named } = mapPeakSet(d);
			const placed = placeNamed(d, named);
			expect(placed).toHaveLength(named.length);
			for (const q of placed) {
				expect(q.x).toBeGreaterThanOrEqual(0);
				expect(q.x).toBeLessThanOrEqual(400);
				expect(q.y).toBeGreaterThanOrEqual(0);
				expect(q.y).toBeLessThanOrEqual(400);
				if (q.rim) {
					rimmed++;
					expect(Math.hypot(q.x - 200, q.y - 200)).toBeCloseTo(184, 6);
				}
			}
		}
		expect(rimmed).toBeGreaterThan(0);
	});
	it("keeps the rim points on the peak's bearing", () => {
		const d = DEMOS[2];
		for (const q of placeNamed(d, mapPeakSet(d).named).filter((r) => r.rim)) {
			const az = (Math.atan2(q.x - 200, -(q.y - 200)) * 180) / Math.PI;
			expect(Math.abs(((az - q.p.az + 540) % 360) - 180)).toBeLessThan(1e-6);
			expect(q.km).toBe(Math.round(q.p.distance / 1000));
		}
	});
	it("drops the label, never the peak, of rim points closer than the gap", () => {
		const mk = (name: string, az: number): GipfelbuchPeak =>
			peak(name, null, null, { az, distance: 90000 });
		const d = fake([], [], { demPatch: { halfKm: 5 } });
		const placed = placeNamed(d, [mk("A", 0), mk("B", 2), mk("C", 90)]);
		const out = declutterRim(placed, 16);
		expect(out).toHaveLength(3);
		expect(out.map((q) => q.label)).toEqual([true, false, true]);
		expect(declutterRim(placed, 1).every((q) => q.label)).toBe(true);
	});
	it("labels inside peaks untouched", () => {
		const d = fake([], [], { demPatch: { halfKm: 5 } });
		const near = peak("N", null, null, { az: 10, distance: 1000 });
		const [q] = declutterRim(placeNamed(d, [near]));
		expect(q.rim).toBe(false);
		expect(q.label).toBe(true);
	});
});

describe("coneFitBox on the demo photos", () => {
	it("crops at least 4 of 12 and holds the camera and the solved cone tip", () => {
		let cropped = 0;
		for (const d of DEMOS) {
			const b = coneFitBox(d, 4 / 3);
			if (b.w < 399 || b.h < 399) cropped++;
			expect(b.x).toBeGreaterThanOrEqual(-1e-9);
			expect(b.y).toBeGreaterThanOrEqual(-1e-9);
			expect(b.x + b.w).toBeLessThanOrEqual(400 + 1e-9);
			expect(b.y + b.h).toBeLessThanOrEqual(400 + 1e-9);
			const inBox = (x: number, y: number) =>
				x >= b.x - 1e-6 &&
				x <= b.x + b.w + 1e-6 &&
				y >= b.y - 1e-6 &&
				y <= b.y + b.h + 1e-6;
			expect(inBox(200, 200)).toBe(true);
			// the solved cone's centre line, at the same reach the box uses
			const half = d.demPatch.halfKm * 1000;
			const r = (Math.min(half * 1.6, 0.92 * half) * 400) / (2 * half);
			const a = (d.solved.yaw * Math.PI) / 180;
			// only when the whole box could hold it (a fallback crop may cut a very wide cone)
			if (b.w < 399 || b.h < 399)
				expect(inBox(200 + Math.sin(a) * r, 200 - Math.cos(a) * r)).toBe(true);
		}
		expect(cropped).toBeGreaterThanOrEqual(4);
	});
});
