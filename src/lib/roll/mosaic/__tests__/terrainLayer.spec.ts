// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RidgePeak, ViewpointTerrain } from "../ridgelines";
import {
	drawPeakLabels,
	drawTerrain,
	drawTerrainOnPhotos,
	prepareTerrain,
} from "../terrainLayer";

/** Path2D records its segments so tests can see what was drawn. */
class FakePath {
	ops: [string, ...number[]][] = [];
	moveTo(x: number, y: number) {
		this.ops.push(["M", x, y]);
	}
	lineTo(x: number, y: number) {
		this.ops.push(["L", x, y]);
	}
	closePath() {
		this.ops.push(["Z"]);
	}
}
beforeEach(() => vi.stubGlobal("Path2D", FakePath));

const pathOf = (p: unknown) => p as FakePath;

/** Two ridge strokes (slab 0 slope, slab 7 ridge) and two cue strokes at known slabs. */
function terrain(o: Partial<ViewpointTerrain> = {}): ViewpointTerrain {
	return {
		eye: { lat: 46.7, lon: 7.7, h: 1000 },
		slabs: 8,
		dMin: 40,
		dMax: 120_000,
		pts: new Float32Array([10, 1, 20, 2, 30, 3, 100, 5, 110, 6]),
		start: new Uint32Array([0, 3, 5]),
		slab: new Uint8Array([0, 7]),
		ridge: new Uint8Array([0, 1]),
		// cue strokes: slab 7 (far), slab 3 (near ~ 40 * 3000^(3/8) = 800 m: far), slab 1 (~ 40*3000^(1/8)=108 m: skipped)
		cuePts: new Float32Array([10, 1, 20, 2, 30, 3, 40, 4, 50, 5, 60, 6]),
		cueStart: new Uint32Array([0, 2, 4, 6]),
		cueSlab: new Uint8Array([7, 3, 1]),
		skyline: new Float32Array([1, 2, -90, 4]),
		step: 90,
		peaks: [],
		...o,
	};
}

describe("prepareTerrain", () => {
	it("splits strokes into slope and ridge buckets by depth", () => {
		const p = prepareTerrain(terrain());
		expect(p.paths).toHaveLength(2);
		expect(p.paths[0]).toHaveLength(8);
		// slab 0 slope goes in bucket 0; slab 7 of 8 (depth 1) in the last bucket of the ridge class
		expect(pathOf(p.paths[0][0]).ops).toEqual([
			["M", 10, 1],
			["L", 20, 2],
			["L", 30, 3],
		]);
		expect(pathOf(p.paths[1][7]).ops).toEqual([
			["M", 100, 5],
			["L", 110, 6],
		]);
		expect(p.paths[1][0].constructor).toBe(FakePath);
		expect(pathOf(p.paths[1][0]).ops).toEqual([]);
	});

	it("draws the ground as the skyline polygon closed along the bottom, floored at -90", () => {
		const ground = pathOf(prepareTerrain(terrain()).ground);
		expect(ground.ops[0]).toEqual(["M", 0, -90]);
		// four columns plus the closing one at 360 degrees, wrapping back to column 0
		expect(ground.ops.slice(1, 6)).toEqual([
			["L", 0, 1],
			["L", 90, 2],
			["L", 180, -90],
			["L", 270, 4],
			["L", 360, 1],
		]);
		expect(ground.ops.slice(-2)).toEqual([["L", 360, -90], ["Z"]]);
	});

	it("keeps far cue ridges, fades mid-distance ones by slab and drops those under 250 m", () => {
		const t = terrain({
			// slab 6 of 8: 40 * 3000^(6/8) = 16 km (far); slab 2: 40 * 3000^(0.25) = 296 m (mid); slab 1: 108 m (dropped)
			cueSlab: new Uint8Array([6, 2, 1]),
		});
		const p = prepareTerrain(t);
		const farOps = p.far.flatMap((x) => pathOf(x).ops);
		expect(farOps).toEqual([
			["M", 10, 1],
			["L", 20, 2],
		]);
		expect(p.mid).toHaveLength(1);
		expect(pathOf(p.mid[0].path).ops).toEqual([
			["M", 30, 3],
			["L", 40, 4],
		]);
		// 296 m is just past the 250 m floor: weight starts near 0.35
		expect(p.mid[0].weight).toBeGreaterThan(0.35);
		expect(p.mid[0].weight).toBeLessThan(0.6);
	});

	it("shares one mid path between cue strokes of the same slab", () => {
		const p = prepareTerrain(
			terrain({
				cueSlab: new Uint8Array([2, 2, 1]),
			}),
		);
		expect(p.mid).toHaveLength(1);
		expect(pathOf(p.mid[0].path).ops.filter((o) => o[0] === "M")).toHaveLength(
			2,
		);
	});

	it("ranks peaks by prominence, then elevation", () => {
		const pk = (
			name: string,
			ele: number,
			prominence: number | null,
		): RidgePeak => ({
			name,
			ele,
			az: 0,
			el: 0,
			d: 1000,
			prominence,
		});
		const p = prepareTerrain(
			terrain({
				peaks: [
					pk("low", 1000, 50),
					pk("none", 3000, null),
					pk("tall", 2500, 50),
					pk("big", 900, 400),
				],
			}),
		);
		expect(p.peaks.map((x) => x.name)).toEqual(["big", "tall", "low", "none"]);
	});
});

type Call = [string, ...unknown[]];
function fakeContext(textWidth = 40) {
	const calls: Call[] = [];
	const g = new Proxy(
		{
			measureText: (s: string) => ({ width: textWidth + 0 * s.length }),
		} as Record<string, unknown>,
		{
			get(target, prop: string) {
				if (prop in target) return target[prop];
				return (...a: unknown[]) => calls.push([prop, ...a]);
			},
			set(target, prop: string, v) {
				target[prop] = v;
				calls.push([`set:${prop}`, v]);
				return true;
			},
		},
	);
	return { g: g as unknown as CanvasRenderingContext2D, calls };
}

describe("drawTerrain", () => {
	it("paints the ground fill and strokes every bucket, once per 360 degree copy in view", () => {
		const p = prepareTerrain(terrain());
		const { g, calls } = fakeContext();
		drawTerrain(g, 2, 400, 200, { az0: 0, elc: 0, ppd: 2 }, p);
		const fills = calls.filter((c) => c[0] === "fill");
		const strokes = calls.filter((c) => c[0] === "stroke");
		// the strip is 360.5 degrees wide, so the copy one turn back spills 0.5 degrees into the view: two copies
		expect(fills).toHaveLength(2);
		expect(strokes).toHaveLength(2 * 8 * 2);
		expect(calls.filter((c) => c[0] === "setTransform")).toHaveLength(2);
		// degrees to device pixels, y up: scale dpr * ppd, flipped; the copy at 0 starts at the view's left edge
		expect(calls.filter((c) => c[0] === "setTransform")[1].slice(1)).toEqual([
			4, 0, 0, -4, 0, 200,
		]);
		expect(calls[0][0]).toBe("save");
		expect(calls[calls.length - 1][0]).toBe("restore");
	});

	it("draws a second copy when the view wraps past 360 degrees", () => {
		const p = prepareTerrain(terrain());
		const { g, calls } = fakeContext();
		drawTerrain(g, 1, 400, 200, { az0: 300, elc: 0, ppd: 1 }, p);
		expect(calls.filter((c) => c[0] === "setTransform")).toHaveLength(2);
	});

	it("fades the whole layer with `fade`", () => {
		const p = prepareTerrain(terrain());
		const a = fakeContext();
		drawTerrain(a.g, 1, 100, 100, { az0: 0, elc: 0, ppd: 1 }, p, 1);
		const b = fakeContext();
		drawTerrain(b.g, 1, 100, 100, { az0: 0, elc: 0, ppd: 1 }, p, 0);
		const fillA = a.calls.find((c) => c[0] === "set:fillStyle")?.[1] as string;
		const fillB = b.calls.find((c) => c[0] === "set:fillStyle")?.[1] as string;
		expect(fillA).toContain("0.035");
		expect(fillB).toMatch(/,0\)$/);
	});
});

describe("drawPeakLabels", () => {
	const pk = (
		name: string,
		az: number,
		el: number,
		prominence: number,
	): RidgePeak => ({
		name,
		ele: 2000,
		az,
		el,
		d: 5000,
		prominence,
	});
	const view = { az0: 0, elc: 0, ppd: 10 };

	it("places labels at their azimuth, high prominence first, skipping overlaps", () => {
		const p = prepareTerrain(
			terrain({
				peaks: [
					pk("Big", 20, 4, 300),
					pk("Near", 21, 5, 100),
					pk("Far", 60, 3, 50),
				],
			}),
		);
		const { g } = fakeContext(40);
		const placed = drawPeakLabels(g, 800, 400, view, p, 0, null);
		expect(placed.map((l) => l.peak.name)).toEqual(["Big", "Far"]); // "Near" collides with "Big"
		expect(placed[0].x).toBe(200);
		expect(placed[0].y).toBe(200 - 4 * 10);
		expect(placed[1].x).toBe(600);
	});

	it("skips peaks outside the vertical band or too close to the edges", () => {
		const p = prepareTerrain(
			terrain({
				peaks: [
					pk("tooHigh", 20, 30, 1), // y = 200 - 300 < top + 26
					pk("tooLow", 30, -25, 1), // y = 450 > h - 4
					pk("leftEdge", 0.1, 2, 1), // x = 1 < 2
					pk("rightEdge", 79.5, 2, 1), // label would pass the right edge
					pk("ok", 50, 1, 1),
				],
			}),
		);
		const { g } = fakeContext(40);
		expect(
			drawPeakLabels(g, 800, 400, view, p, 0, null).map((l) => l.peak.name),
		).toEqual(["ok"]);
	});

	it("repeats a peak that sits across the 360 degree seam when the view wraps", () => {
		const p = prepareTerrain(terrain({ peaks: [pk("Seam", 5, 1, 1)] }));
		const { g } = fakeContext(40);
		const placed = drawPeakLabels(
			g,
			800,
			400,
			{ az0: 300, elc: 0, ppd: 10 },
			p,
			0,
			null,
		);
		expect(placed).toHaveLength(1);
		expect(placed[0].x).toBe((5 + 360 - 300) * 10);
	});

	it("caps the labels at 24", () => {
		const peaks = Array.from({ length: 40 }, (_, i) =>
			pk(`P${i}`, 1 + i * 3, 1, 100 - i),
		);
		const p = prepareTerrain(terrain({ peaks }));
		const { g } = fakeContext(5); // minimum label width 42 + 12 still fits 3 deg apart at ppd 25
		const placed = drawPeakLabels(
			g,
			4000,
			400,
			{ az0: 0, elc: 0, ppd: 25 },
			p,
			0,
			null,
		);
		expect(placed.length).toBe(24);
	});

	it("highlights the hovered peak with its distance and elevation", () => {
		const p = prepareTerrain(terrain({ peaks: [pk("Hover", 20, 4, 300)] }));
		const { g, calls } = fakeContext(40);
		drawPeakLabels(g, 800, 400, view, p, 0, "Hover");
		const texts = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
		expect(texts).toEqual(["Hover", "2000 m · 5.0 km"]);
		const quiet = fakeContext(40);
		drawPeakLabels(quiet.g, 800, 400, view, p, 0, null);
		expect(
			quiet.calls.filter((c) => c[0] === "fillText").map((c) => c[1]),
		).toEqual(["Hover", "2000"]);
	});
});

describe("drawTerrainOnPhotos", () => {
	it("clips to each photo outline and strokes the far and mid cue paths", () => {
		const p = prepareTerrain(terrain({ cueSlab: new Uint8Array([6, 2, 1]) }));
		const { g, calls } = fakeContext();
		const a = new FakePath();
		const b = new FakePath();
		drawTerrainOnPhotos(g, 1, 400, 200, { az0: 0, elc: 0, ppd: 2 }, p, [
			{ path: a as unknown as Path2D, strength: 1 },
			{ path: b as unknown as Path2D, strength: 2 },
		]);
		expect(calls.filter((c) => c[0] === "clip").map((c) => c[1])).toEqual([
			a,
			b,
		]);
		expect(calls.filter((c) => c[0] === "save")).toHaveLength(2);
		expect(calls.filter((c) => c[0] === "restore")).toHaveLength(2);
		// per photo and strip copy (the 0.5 degree overlap gives two): 8 far buckets + 1 mid path, each a halo and a line
		expect(calls.filter((c) => c[0] === "stroke")).toHaveLength(
			2 * 2 * (8 + 1) * 2,
		);
	});

	it("does nothing without clips", () => {
		const { g, calls } = fakeContext();
		drawTerrainOnPhotos(
			g,
			1,
			100,
			100,
			{ az0: 0, elc: 0, ppd: 1 },
			prepareTerrain(terrain()),
			[],
		);
		expect(calls).toEqual([]);
	});
});
