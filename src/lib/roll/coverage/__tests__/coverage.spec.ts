// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "../../../../test/helpers";
import {
	type CoveragePhoto,
	fromEnu,
	makeFrame,
	SAMPLES_PER_WEDGE,
	toEnu,
	wedgeBounds,
	wedgeContains,
	wedgeSamples,
	wedgesOf,
	wrapAngle,
} from "../frame";
import { coverageGridCpu } from "../grid";
import { coverageRaster, gridLatLonBounds, hexToRgb } from "../raster";
import { createWedgeIndex, whoSeesCpu } from "../who";

const FRAME = makeFrame(46.6, 7.8);
const photoAt = (
	x: number,
	y: number,
	yawDeg: number,
	hfovDeg = 60,
	uncertain = false,
): CoveragePhoto => ({
	...fromEnu(FRAME, x, y),
	yawDeg,
	hfovDeg,
	uncertain,
});

describe("local frame", () => {
	it("round-trips lat/lon through ENU metres", () => {
		const random = seededRandom(1);
		for (let i = 0; i < 50; i++) {
			const lat = 46.6 + (random() - 0.5) * 0.2;
			const lon = 7.8 + (random() - 0.5) * 0.3;
			const { x, y } = toEnu(FRAME, lat, lon);
			const back = fromEnu(FRAME, x, y);
			expect(back.lat).toBeCloseTo(lat, 10);
			expect(back.lon).toBeCloseTo(lon, 10);
		}
	});

	it("puts north on +y and east on +x with metre scale", () => {
		const north = toEnu(FRAME, 46.6 + 0.01, 7.8);
		expect(north.x).toBeCloseTo(0, 6);
		expect(north.y).toBeGreaterThan(1100);
		expect(north.y).toBeLessThan(1120);
		const east = toEnu(FRAME, 46.6, 7.8 + 0.01);
		expect(east.y).toBeCloseTo(0, 6);
		expect(east.x).toBeGreaterThan(760); // cos(46.6 deg) * 1112 m
		expect(east.x).toBeLessThan(780);
	});
});

describe("wedges", () => {
	it("widens and down-weights an uncertain pose", () => {
		const [sure, prior] = wedgesOf(
			[photoAt(0, 0, 0, 60), photoAt(0, 0, 0, 60, true)],
			FRAME,
		);
		expect(prior.halfRad).toBeGreaterThan(sure.halfRad);
		expect(prior.weight).toBeLessThan(sure.weight);
	});

	it("wraps angles into (-pi, pi]", () => {
		expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 9);
		expect(wrapAngle(-Math.PI * 1.5)).toBeCloseTo(Math.PI / 2, 9);
	});

	it("bounds a north-facing wedge by the arc, not the full circle", () => {
		const [w] = wedgesOf([photoAt(0, 0, 0, 60)], FRAME, { radiusM: 1000 });
		const b = wedgeBounds(w);
		expect(b.maxY).toBeCloseTo(1000, 3); // the north axis lies inside the arc
		expect(b.minY).toBeCloseTo(0, 6);
		expect(b.maxX).toBeCloseTo(500, 3); // sin 30 deg
		expect(b.minX).toBeCloseTo(-500, 3);
	});

	it("generates SAMPLES_PER_WEDGE samples per wedge, all inside the wedge, mass = area / cell area", () => {
		const [w] = wedgesOf([photoAt(100, -50, 40, 70)], FRAME, { radiusM: 2000 });
		const { positions, weights } = wedgeSamples([w], 100 * 100);
		expect(weights.length).toBe(SAMPLES_PER_WEDGE);
		for (let i = 0; i < weights.length; i += 97)
			expect(
				wedgeContains(
					{ ...w, radius: w.radius * 1.0001 },
					positions[2 * i],
					positions[2 * i + 1],
				),
			).toBe(true);
		const mass = weights.reduce((a, v) => a + v, 0);
		const area = w.halfRad * w.radius ** 2; // sector area: half angle * r^2
		expect(mass).toBeCloseTo(area / (100 * 100), 0);
	});

	it("pads to a capacity with zero-weight rows", () => {
		const wedges = wedgesOf([photoAt(0, 0, 0)], FRAME);
		const { weights } = wedgeSamples(wedges, 1, 4);
		expect(weights.length).toBe(4 * SAMPLES_PER_WEDGE);
		expect(weights[SAMPLES_PER_WEDGE]).toBe(0);
	});
});

describe("coverageGridCpu", () => {
	const cellCentre = (
		g: ReturnType<typeof coverageGridCpu>,
		col: number,
		row: number,
	) => {
		const side = g.bounds.maxX - g.bounds.minX;
		return {
			x: g.bounds.minX + ((col + 0.5) / g.size) * side,
			y: g.bounds.minY + ((row + 0.5) / g.size) * side,
		};
	};

	it("puts a single photo facing north only in cells north of the eye and within the fan", () => {
		const photos = [photoAt(0, 0, 0, 60)];
		const g = coverageGridCpu(photos, {
			frame: FRAME,
			radiusM: 3000,
			gridSize: 64,
		});
		expect(g.backend).toBe("cpu");
		let southMass = 0;
		let outsideMass = 0;
		for (let row = 0; row < g.size; row++)
			for (let col = 0; col < g.size; col++) {
				const v = g.data[row * g.size + col];
				const c = cellCentre(g, col, row);
				if (c.y < -150) southMass += v;
				// beyond the fan (half angle 30 deg) with a margin of two cells
				if (c.y > 100 && Math.abs(c.x) > c.y * Math.tan(Math.PI / 6) + 250)
					outsideMass += v;
			}
		expect(southMass).toBe(0);
		expect(outsideMass).toBe(0);
		// a deep cell on the axis is covered about once
		let best = 0;
		for (let row = 0; row < g.size; row++)
			for (let col = 0; col < g.size; col++) {
				const c = cellCentre(g, col, row);
				if (Math.abs(c.x) < 60 && c.y > 800 && c.y < 2000)
					best = Math.max(best, g.data[row * g.size + col]);
			}
		expect(best).toBeGreaterThan(0.6);
		expect(best).toBeLessThan(1.5);
	});

	it("total mass equals the wedge area in cells", () => {
		const g = coverageGridCpu([photoAt(0, 0, 90, 80)], {
			frame: FRAME,
			radiusM: 2500,
			gridSize: 96,
		});
		const cellArea = ((g.bounds.maxX - g.bounds.minX) / g.size) ** 2;
		const area = ((80 * Math.PI) / 180 / 2) * 2500 ** 2;
		expect(g.total).toBeCloseTo(area / cellArea, -1);
	});

	it("counts about 2 where two photos overlap, and about 1 only where one covers", () => {
		// two eyes 100 m apart both looking north at a spot 1.5 km ahead
		const photos = [
			photoAt(-50, 0, 0, 60),
			photoAt(50, 0, 0, 60),
			photoAt(0, 0, 180, 30),
		];
		const g = coverageGridCpu(photos, {
			frame: FRAME,
			radiusM: 3000,
			gridSize: 128,
		});
		let sum = 0;
		let n = 0;
		for (let row = 0; row < g.size; row++)
			for (let col = 0; col < g.size; col++) {
				const c = cellCentre(g, col, row);
				if (Math.abs(c.x) < 150 && c.y > 1200 && c.y < 1800) {
					sum += g.data[row * g.size + col];
					n++;
				}
			}
		expect(sum / n).toBeGreaterThan(1.7);
		expect(sum / n).toBeLessThan(2.3);
	});

	it("handles an empty roll", () => {
		const g = coverageGridCpu([]);
		expect(g.total).toBe(0);
		expect(g.max).toBe(0);
	});

	it("rasterises north up with transparent empty cells and lat/lon corners", () => {
		const g = coverageGridCpu([photoAt(0, 0, 0, 60)], {
			frame: FRAME,
			radiusM: 2000,
			gridSize: 32,
		});
		const px = coverageRaster(g, hexToRgb("#000000"), hexToRgb("#ffffff"));
		expect(px.length).toBe(32 * 32 * 4);
		expect(px[3]).toBe(0);
		let opaque = 0;
		for (let i = 3; i < px.length; i += 4) if (px[i] > 0) opaque++;
		expect(opaque).toBeGreaterThan(10);
		const b = gridLatLonBounds(g);
		expect(b.north).toBeGreaterThan(b.south);
		expect(b.east).toBeGreaterThan(b.west);
		expect(b.south).toBeLessThan(46.6);
		expect(b.north).toBeGreaterThan(46.6);
	});
});

describe("who sees (exact wedge test)", () => {
	const at = (photo: CoveragePhoto, radiusM = 1000) =>
		wedgesOf([photo], FRAME, { radiusM })[0];

	it("contains points inside the fan and rejects beside, behind and beyond", () => {
		const w = at(photoAt(0, 0, 0, 60));
		expect(wedgeContains(w, 0, 500)).toBe(true);
		expect(wedgeContains(w, 200, 500)).toBe(true);
		expect(wedgeContains(w, 400, 500)).toBe(false); // 38.7 deg off axis
		expect(wedgeContains(w, 0, -10)).toBe(false);
		expect(wedgeContains(w, 0, 1001)).toBe(false);
		expect(wedgeContains(w, 0, 999)).toBe(true);
	});

	it("wraps around north: heading 350 +- 20 sees bearings 330 .. 10", () => {
		const w = at(photoAt(0, 0, 350, 40));
		const at_ = (deg: number, r = 500) =>
			[
				r * Math.sin((deg * Math.PI) / 180),
				r * Math.cos((deg * Math.PI) / 180),
			] as const;
		expect(wedgeContains(w, ...at_(5))).toBe(true);
		expect(wedgeContains(w, ...at_(359))).toBe(true);
		expect(wedgeContains(w, ...at_(331))).toBe(true);
		expect(wedgeContains(w, ...at_(15))).toBe(false);
		expect(wedgeContains(w, ...at_(325))).toBe(false);
		expect(wedgeContains(w, ...at_(180))).toBe(false);
	});

	it("counts the eye itself as seen, whatever the heading", () => {
		expect(wedgeContains(at(photoAt(30, 40, 123)), 30, 40)).toBe(true);
	});

	it("whoSeesCpu lists the indices of every wedge holding the point", () => {
		const wedges = wedgesOf(
			[
				photoAt(0, 0, 0, 60),
				photoAt(0, 800, 180, 60),
				photoAt(2000, 0, 0, 60),
				photoAt(-100, 0, 350, 40),
			],
			FRAME,
			{ radiusM: 1500 },
		);
		const r = whoSeesCpu(wedges, { x: -150, y: 400 });
		expect(r.indices).toEqual([0, 1, 3]);
		expect(whoSeesCpu(wedges, { x: 0, y: -900 }).indices).toEqual([]);
	});

	it("the CPU index (no device) agrees with brute force", async () => {
		const random = seededRandom(5);
		const photos = Array.from({ length: 30 }, () =>
			photoAt(
				(random() - 0.5) * 3000,
				(random() - 0.5) * 3000,
				random() * 360,
				40 + random() * 40,
				random() < 0.3,
			),
		);
		const wedges = wedgesOf(photos, FRAME);
		const index = await createWedgeIndex(wedges, FRAME, null);
		expect(index.backend).toBe("cpu");
		const r = await index.query({ x: 100, y: 100 });
		expect(r.indices).toEqual(whoSeesCpu(wedges, { x: 100, y: 100 }).indices);
	});
});
