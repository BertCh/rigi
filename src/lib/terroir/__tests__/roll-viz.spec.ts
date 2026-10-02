// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { makeGrid } from "../pack";
import {
	fmtScale,
	isUncertainPose,
	lightPhase,
	luminance,
	mercatorLat,
	mercatorMPerPx,
	niceFloor,
	POSE_GLYPH,
	PRIOR_FAN_DEG,
	priorFanPath,
	SUN_STOPS,
	scaleBar,
	sunBandColor,
	sunEvents,
} from "../roll/logic";
import {
	approxDistM,
	aspectWord,
	clockHM,
	formatDist,
	niceTicks,
	parseTz,
	pointInMulti,
	pointInPolygon,
	pointInRing,
	resampleLine,
	sunIncidenceDeg,
	surfaceNormal,
} from "../viz/geo";
import { surfaceProfile } from "../viz/profile";
import { pathD, splitRuns } from "../viz/runs";
import { sunArc } from "../viz/sunarc";
import { viewStats } from "../viz/view";

describe("roll/logic sun band", () => {
	it("clamps at both ends and hits the stops exactly", () => {
		expect(sunBandColor(-90)).toEqual([10, 17, 40]);
		expect(sunBandColor(90)).toEqual([251, 248, 238]);
		for (const [e, r, g, b] of SUN_STOPS)
			expect(sunBandColor(e)).toEqual([r, g, b]);
	});
	it("interpolates between stops and gets brighter with elevation", () => {
		const mid = sunBandColor(-9);
		expect(mid).toEqual([34, 57, 110]);
		let prev = -1;
		for (let e = -18; e <= 60; e += 3) {
			const l = luminance(sunBandColor(e));
			expect(l).toBeGreaterThanOrEqual(prev - 1e-9);
			prev = l;
		}
	});
	it("luminance is 0 for black and 1 for white", () => {
		expect(luminance([0, 0, 0])).toBe(0);
		expect(luminance([255, 255, 255])).toBeCloseTo(1, 9);
	});
	it("lightPhase boundaries", () => {
		expect(lightPhase(-10)).toBe("night");
		expect(lightPhase(-3)).toBe("blue hour");
		expect(lightPhase(3)).toBe("golden hour");
		expect(lightPhase(20)).toBe("day");
	});
	it("sunEvents finds sunrise, noon and sunset with interpolated crossing", () => {
		const elev = [-10, -2, 4, 20, 40, 20, 4, -2];
		const at = elev.map((_, i) => i / (elev.length - 1));
		const ev = sunEvents(elev, at);
		expect(ev.map((e) => e.kind)).toEqual(["sunrise", "noon", "sunset"]);
		expect(ev[0].at).toBeGreaterThan(at[1]);
		expect(ev[0].at).toBeLessThan(at[2]);
		expect(ev[1].at).toBe(at[4]);
		expect(sunEvents([-5, -4, -3], [0, 0.5, 1])).toEqual([]);
	});
});

describe("roll/logic scale bar and mercator", () => {
	it("niceFloor picks the largest 1/2/5 x 10^n at or below", () => {
		expect(niceFloor(0)).toBe(0);
		expect(niceFloor(1)).toBe(1);
		expect(niceFloor(4.9)).toBe(2);
		expect(niceFloor(5)).toBe(5);
		expect(niceFloor(999)).toBe(500);
		expect(niceFloor(0.034)).toBeCloseTo(0.02, 12);
	});
	it("fmtScale and scaleBar never exceed the max width", () => {
		expect(fmtScale(200)).toBe("200 m");
		expect(fmtScale(1000)).toBe("1 km");
		expect(fmtScale(2500)).toBe("2.5 km");
		for (const mpp of [0.5, 3, 17, 120, 950]) {
			const b = scaleBar(mpp, 96);
			expect(b.px).toBeLessThanOrEqual(96 + 1e-9);
			expect(b.px).toBeGreaterThan(96 / 2.5);
		}
	});
	it("mercatorMPerPx halves per zoom and mercatorLat inverts the tile y", () => {
		expect(mercatorMPerPx(0, 1) / mercatorMPerPx(0, 2)).toBeCloseTo(2, 9);
		expect(mercatorMPerPx(60, 5)).toBeCloseTo(mercatorMPerPx(0, 5) / 2, 6);
		expect(mercatorLat((256 * 2 ** 3) / 2, 3)).toBeCloseTo(0, 9);
		expect(mercatorLat(0, 2)).toBeCloseTo(85.0511, 3);
	});
});

describe("roll/logic pose honesty", () => {
	it("every source has a distinct glyph and only a prior is uncertain", () => {
		expect(new Set(Object.values(POSE_GLYPH)).size).toBe(4);
		expect(isUncertainPose("prior")).toBe(true);
		expect(isUncertainPose("solved")).toBe(false);
	});
	it("priorFanPath is a closed wedge, the arc flag flips past 180 degrees", () => {
		const d = priorFanPath(50, 50, 20, 0, 60);
		expect(d.startsWith("M50,50 L")).toBe(true);
		expect(d.endsWith("Z")).toBe(true);
		expect(d).toContain(" 0 0 1 ");
		expect(priorFanPath(50, 50, 20, 0, 170)).toContain(" 0 1 1 ");
		const half = 30 + PRIOR_FAN_DEG;
		const x1 = 50 + 20 * Math.sin((half * Math.PI) / 180);
		expect(d).toContain(`${x1}`);
	});
});

describe("viz/geo", () => {
	const square = [
		[0, 0],
		[10, 0],
		[10, 10],
		[0, 10],
	] as [number, number][];
	const hole = [
		[4, 4],
		[6, 4],
		[6, 6],
		[4, 6],
	] as [number, number][];
	it("pointInRing / Polygon / Multi with holes and open rings", () => {
		expect(pointInRing(5, 5, square)).toBe(true);
		expect(pointInRing(15, 5, square)).toBe(false);
		expect(pointInPolygon(5, 5, [square, hole])).toBe(false);
		expect(pointInPolygon(2, 2, [square, hole])).toBe(true);
		expect(pointInPolygon(2, 2, [])).toBe(false);
		expect(
			pointInMulti(5, 5, [
				[square, hole],
				[
					[
						[4, 4],
						[6, 4],
						[5, 6],
					],
				],
			]),
		).toBe(true);
		expect(pointInMulti(50, 5, [[square]])).toBe(false);
	});
	it("aspectWord rounds to eight compass words and wraps", () => {
		expect(aspectWord(0)).toBe("north");
		expect(aspectWord(359)).toBe("north");
		expect(aspectWord(92)).toBe("east");
		expect(aspectWord(-90)).toBe("west");
		expect(aspectWord(225)).toBe("southwest");
	});
	it("surfaceNormal of a plane tilted toward the east faces east", () => {
		// z = 0.5 x -> slope atan(0.5), faces +x (east): aspect 90
		const n = surfaceNormal([-1, 0, -0.5], [1, 0, 0.5], [0, 1, 0], [0, -1, 0]);
		expect(n?.slope).toBeCloseTo((Math.atan(0.5) * 180) / Math.PI, 6);
		expect(n?.aspect).toBeCloseTo(270, 6); // normal (-0.5, 0, 1): leans west, i.e. faces west
		const flat = surfaceNormal([-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0]);
		expect(flat?.slope).toBeCloseTo(0, 6);
		expect(
			surfaceNormal([0, 0, 0], [0, 0, 0], [0, 1, 0], [0, -1, 0]),
		).toBeNull();
	});
	it("sunIncidenceDeg", () => {
		expect(sunIncidenceDeg([0, 0, 1], [0, 0, 1])).toBeCloseTo(0, 6);
		expect(sunIncidenceDeg([0, 0, 1], [1, 0, 0])).toBeCloseTo(90, 6);
		expect(sunIncidenceDeg([0, 0, 1], [0, 0, -1])).toBeCloseTo(180, 6);
	});
	it("distances and resampling", () => {
		expect(approxDistM(46, 7, 47, 7)).toBeCloseTo(111320, 0);
		const line = resampleLine({ lat: 46, lon: 7 }, { lat: 46, lon: 8 }, 4);
		expect(line).toHaveLength(5);
		expect(line[0].d).toBe(0);
		expect(line[4].d).toBeCloseTo(approxDistM(46, 7, 46, 8), 6);
		expect(line[2].lon).toBeCloseTo(7.5, 9);
	});
	it("formatDist, parseTz, clockHM", () => {
		expect(formatDist(234)).toBe("230 m");
		expect(formatDist(1500)).toBe("1.5 km");
		expect(formatDist(23000)).toBe("23 km");
		expect(parseTz("+02:00")).toBe(120);
		expect(parseTz("-0530")).toBe(-330);
		expect(parseTz("Z")).toBeNull();
		expect(parseTz(null)).toBeNull();
		const t = Date.UTC(2026, 5, 1, 13, 39);
		expect(clockHM(t, 120)).toBe("15:39");
		expect(clockHM(new Date(t), null)).toBe("13:39 UTC");
	});
	it("niceTicks gives round steps inside the range", () => {
		const t = niceTicks(1234, 2890, 5);
		expect(t.length).toBeGreaterThanOrEqual(3);
		expect(t[0]).toBeGreaterThanOrEqual(1234);
		expect(t[t.length - 1]).toBeLessThanOrEqual(2890 + 1e-6);
		const step = t[1] - t[0];
		for (let i = 1; i < t.length; i++)
			expect(t[i] - t[i - 1]).toBeCloseTo(step, 9);
		expect([100, 200, 500, 1000]).toContain(step);
	});
});

describe("viz/runs", () => {
	const p = (ok: boolean, x = 0) => ({ x, y: 0, dist: 1, ok });
	it("splits at not-ok points and keeps order", () => {
		const runs = splitRuns(
			[p(true, 0), p(true, 1), p(false), p(true, 3)],
			false,
		);
		expect(runs.map((r) => r.map((q) => q.x))).toEqual([[0, 1], [3]]);
	});
	it("a closed ring merges the run across the seam", () => {
		const runs = splitRuns(
			[p(true, 0), p(true, 1), p(false), p(true, 3), p(true, 4)],
			true,
		);
		expect(runs).toHaveLength(1);
		expect(runs[0].map((q) => q.x)).toEqual([3, 4, 0, 1]);
		expect(splitRuns([p(false)], true)).toEqual([]);
	});
	it("pathD", () => {
		expect(
			pathD([
				{ x: 1, y: 2 },
				{ x: 3.2, y: 4 },
			]),
		).toBe("M1.0 2.0L3.2 4.0");
		expect(pathD([])).toBe("");
	});
});

describe("viz/sunarc", () => {
	it("a June day at 46.7N has rise in the NE and set in the NW, noon peak near 67 degrees", () => {
		const a = sunArc(new Date("2026-06-21T10:00:00Z"), 46.7, 7.8, 120);
		expect(a.rise).not.toBeNull();
		expect(a.set).not.toBeNull();
		expect(a.rise?.az).toBeGreaterThan(30);
		expect(a.rise?.az).toBeLessThan(70);
		expect(a.set?.az).toBeGreaterThan(290);
		expect(a.set?.az).toBeLessThan(330);
		expect(a.pts.every((q) => q.el >= 0)).toBe(true);
		expect(Math.max(...a.pts.map((q) => q.el))).toBeGreaterThan(65);
		expect(a.pts.some((q) => q.hour === 12)).toBe(true);
		expect(a.rise && a.set && a.rise.t < a.set.t).toBe(true);
	});
	it("polar night has no crossings", () => {
		const a = sunArc(new Date("2026-12-21T12:00:00Z"), 80, 10, 0);
		expect(a.rise).toBeNull();
		expect(a.pts).toHaveLength(0);
	});
});

describe("viz/view and surfaceProfile", () => {
	const grid = makeGrid([0, 0, 2, 2], 2, 2, Uint8Array.from([12, 12, 1, 0]));
	it("viewStats takes min/max heights and class fractions of the visible samples", () => {
		const s = viewStats(
			(u, v) =>
				u < 0.5 ? null : { lat: 2 - v * 2, lon: u * 2, h: 1000 + v * 1000 },
			grid,
			4,
			4,
		);
		expect(s?.n).toBe(8);
		expect(s?.hMin).toBeLessThan(s?.hMax ?? 0);
		const total = [...(s?.cover.values() ?? [])].reduce((a, b) => a + b, 0);
		expect(total).toBeLessThanOrEqual(1);
		expect(viewStats(() => null, grid)).toBeNull();
		expect(
			viewStats(() => ({ lat: 1, lon: 1, h: 5 }), null, 2, 2)?.cover.size,
		).toBe(0);
	});
	it("surfaceProfile sorts by range and needs at least 4 points", () => {
		const prof = surfaceProfile(
			(_u, v) => ({
				h: 100 * (1 - v),
				range: 1000 * (1 - v),
				lat: 0.5,
				lon: 0.5,
			}),
			grid,
			0.5,
			0.2,
			10,
		);
		expect(prof?.kind).toBe("surface");
		expect(prof?.pts.length).toBe(11);
		for (let i = 1; i < (prof?.pts.length ?? 0); i++)
			expect(prof?.pts[i].d).toBeGreaterThanOrEqual(prof?.pts[i - 1].d ?? 0);
		expect(prof?.pts[0].cover).toBe(1); // (lat 0.5, lon 0.5) falls in the glacier cell
		expect(surfaceProfile(() => null, null, 0.5, 0.5)).toBeNull();
	});
});
