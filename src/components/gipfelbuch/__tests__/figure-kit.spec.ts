// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { scrubValue } from "../viz/hooks";
import {
	dashFor,
	inkFor,
	isPhotoLayer,
	LAYER_INKS,
	LAYER_STYLE,
	layerOfColor,
	type PhotoLayer,
} from "../viz/inks";
import { coneWedge, demToPx, layoutPeakLabels } from "../viz/real";

describe("layer inks", () => {
	const layers = Object.keys(LAYER_INKS) as PhotoLayer[];
	it("has a photo ink, a paper ink and a label for every layer", () => {
		for (const layer of layers) {
			expect(inkFor(layer, "photo")).toBeTruthy();
			expect(inkFor(layer, "paper")).toBeTruthy();
			expect(LAYER_INKS[layer].label).toBeTruthy();
			expect(LAYER_INKS[layer].paperHex).toMatch(/^#[0-9a-f]{6}$/);
		}
	});
	it("keeps LAYER_STYLE on the photo ink", () => {
		for (const layer of layers)
			expect(LAYER_STYLE[layer].color).toBe(inkFor(layer, "photo"));
	});
	it("puts the dash on the prior layer only, scaled", () => {
		expect(dashFor("prior")).toBe("6 5");
		expect(dashFor("prior", 0.6)).toBe("3.6 3");
		expect(dashFor("solved")).toBeUndefined();
	});
	it("finds a layer from its ink, the first of a shared ink", () => {
		expect(layerOfColor(inkFor("prior", "photo"))).toBe("prior");
		expect(layerOfColor(inkFor("solved", "photo"))).toBe("solved");
		expect(layerOfColor("#123456")).toBeUndefined();
		expect(isPhotoLayer("solved")).toBe(true);
		expect(isPhotoLayer("toString")).toBe(false);
	});
});

describe("coneWedge", () => {
	const data = { demPatch: { halfKm: 5 } };
	it("puts the camera at the centre and the arc ends on the cone edges", () => {
		const d = coneWedge(data, 90, 60);
		expect(d.startsWith("M200 200L")).toBe(true);
		// north-up: yaw 90 points east, so both edges sit right of the centre
		const edge = demToPx(5, 60, 8000);
		expect(d).toContain(`L${edge[0]} ${edge[1]}`);
		expect(d.endsWith("Z")).toBe(true);
	});
	it("scales the arc radius with the reach", () => {
		// reach = half width (5 km) is a 200 px radius on the 400 px patch
		expect(coneWedge(data, 0, 40, 5000)).toContain("A200 200 0 0 1");
	});
	it("maps bearings north up", () => {
		const [x, y] = demToPx(5, 0, 5000);
		expect(x).toBeCloseTo(200);
		expect(y).toBeCloseTo(0);
	});
});

describe("layoutPeakLabels", () => {
	const box = { k: 1, left: 0, right: 800 };
	const at = (name: string, x: number) => ({
		name,
		at: [x, 300] as [number, number],
	});
	it("numbers a summit whose name fits no row, in priority order", () => {
		// four names on top of each other: three rows take three, the fourth is dropped
		const placed = layoutPeakLabels(
			[
				at("Alpha", 400),
				at("Bravo", 402),
				at("Charlie", 404),
				at("Delta", 406),
			],
			box,
		);
		expect(placed.map((p) => p.row)).toEqual([0, 1, 2, -1]);
		expect(placed.map((p) => p.note)).toEqual([
			undefined,
			undefined,
			undefined,
			1,
		]);
	});
	it("numbers several dropped summits consecutively from firstNote, and 0 gives none", () => {
		const items = ["A", "B", "C", "D", "E"].map((n) => at(`${n}name`, 400));
		expect(layoutPeakLabels(items, box).map((p) => p.note)).toEqual([
			undefined,
			undefined,
			undefined,
			1,
			2,
		]);
		expect(
			layoutPeakLabels(items, box, 3)
				.map((p) => p.note)
				.slice(3),
		).toEqual([3, 4]);
		expect(
			layoutPeakLabels(items, box, 0).every((p) => p.note === undefined),
		).toBe(true);
	});
	it("anchors names inside the frame", () => {
		const [a, b, c] = layoutPeakLabels(
			[at("Leftmost", 5), at("Middle", 400), at("Rightmost", 795)],
			box,
		);
		expect([a.anchor, b.anchor, c.anchor]).toEqual(["start", "middle", "end"]);
	});
});

describe("scrubValue", () => {
	const range = { min: 0, max: 10, period: 1000 };
	it("ping-pongs between min and max", () => {
		expect(scrubValue(0, range)).toBe(0);
		expect(scrubValue(250, range)).toBeCloseTo(5);
		expect(scrubValue(500, range)).toBeCloseTo(10);
		expect(scrubValue(750, range)).toBeCloseTo(5);
		expect(scrubValue(1000, range)).toBeCloseTo(0);
		expect(scrubValue(1250, range)).toBeCloseTo(5);
	});
});
