// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	NOTEBOOK_ENTRIES,
	NOTEBOOK_NODE_IDS,
	STEP_ENTRY,
	STEP_NUMBER,
	stepAnchor,
} from "../notebook/entries";
import { labelSizes } from "../swiss/sheet-labels";
import { CHAPTERS, stepOf } from "../tafel/chapters";
import { azAtX, projectAzEl } from "../tafel/project";

describe("tafel projection", () => {
	const cam = { yaw: 90, pitch: 0, roll: 0, f: 1000 };
	it("puts the optical axis at the frame centre", () => {
		const [x, y] = projectAzEl(cam, 2000, 1000, 90, 0);
		expect(x).toBeCloseTo(1000, 6);
		expect(y).toBeCloseTo(500, 6);
	});
	it("moves right for larger azimuth and up for larger elevation", () => {
		const [xr] = projectAzEl(cam, 2000, 1000, 95, 0);
		expect(xr).toBeGreaterThan(1000);
		const [, yu] = projectAzEl(cam, 2000, 1000, 90, 5);
		expect(yu).toBeLessThan(500);
	});
	it("wraps azimuth across north", () => {
		const north = { ...cam, yaw: 359 };
		const [x] = projectAzEl(north, 2000, 1000, 1, 0);
		expect(x).toBeCloseTo(1000 + 1000 * Math.tan((2 * Math.PI) / 180), 4);
	});
	it("azAtX inverts the horizon projection", () => {
		const [x] = projectAzEl(cam, 2000, 1000, 97, 0);
		expect(azAtX(cam, 2000, x)).toBeCloseTo(97, 6);
	});
});

describe("tafel chapters", () => {
	it("keeps sheet ids unique across chapters", () => {
		const all = CHAPTERS.flatMap((c) => c.ids);
		expect(new Set(all).size).toBe(all.length);
	});
	it("stepOf labels the step with the chapter numeral", () => {
		const c = CHAPTERS[1];
		expect(stepOf(c.ids[2])?.label).toBe(`${c.numeral}.3`);
		expect(stepOf("no-such-sheet")).toBeNull();
	});
});

describe("notebook entries", () => {
	it("numbers steps 1..n across the whole book", () => {
		const n = NOTEBOOK_ENTRIES.flatMap((e) => e.steps).length;
		expect([...STEP_NUMBER.values()].sort((a, b) => a - b)).toEqual(
			Array.from({ length: n }, (_, i) => i + 1),
		);
	});
	it("maps each step to its entry and lists hubs and steps as nodes", () => {
		for (const e of NOTEBOOK_ENTRIES) {
			expect(NOTEBOOK_NODE_IDS).toContain(e.hub);
			for (const s of e.steps) expect(STEP_ENTRY.get(s.id)).toBe(e.key);
		}
		expect(stepAnchor("x")).toBe("nb-step-x");
	});
});

describe("labelSizes", () => {
	it("keeps sheet units when the sheet is large on screen", () => {
		expect(labelSizes(10).peak).toBe(28);
	});
	it("enforces a pixel floor on small screens", () => {
		const s = labelSizes(0.25);
		expect(s.peak * 0.25).toBeGreaterThanOrEqual(11);
		expect(s.contour * 0.25).toBeGreaterThanOrEqual(9);
	});
});
