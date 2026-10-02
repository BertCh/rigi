// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	BLEED_BOTTOM,
	BLEED_TOP,
	clampCardPosition,
	normaliseCardPosition,
	restoreCardPosition,
} from "../topo-layout";

const box = { w: 100, h: 80 };

describe("clampCardPosition", () => {
	const size = { w: 1000, h: 600 };
	it("leaves an inside position alone", () => {
		expect(clampCardPosition({ x: 10, y: -20 }, box, size, 160)).toEqual({
			x: 10,
			y: -20,
		});
	});
	it("pins the card edge to the bleed area", () => {
		const p = clampCardPosition({ x: 9999, y: 9999 }, box, size, 160);
		expect(p.x).toBe(500 + 160 - 50);
		expect(p.y).toBe(300 + BLEED_BOTTOM - 40);
		const q = clampCardPosition({ x: -9999, y: -9999 }, box, size, 160);
		expect(q.x).toBe(-(500 + 160 - 50));
		expect(q.y).toBe(-300 - BLEED_TOP + 40);
	});
});

describe("dragged positions across a resize", () => {
	it("round-trips at the same size", () => {
		const size = { w: 800, h: 500 };
		const pos = { x: 123, y: -45 };
		const back = restoreCardPosition(
			normaliseCardPosition(pos, size),
			box,
			size,
			100,
		);
		expect(back.x).toBeCloseTo(pos.x, 9);
		expect(back.y).toBeCloseTo(pos.y, 9);
	});
	it("scales with the board and stays inside the narrower bleed area", () => {
		const wide = { w: 1000, h: 600 };
		const narrow = { w: 400, h: 600 };
		const norm = normaliseCardPosition({ x: 300, y: 0 }, wide);
		const p = restoreCardPosition(norm, box, narrow, 0);
		expect(p.x).toBe(120); // 0.3 * 400, inside +-(200 - 50)
		const edge = restoreCardPosition(
			normaliseCardPosition({ x: 640, y: 0 }, wide),
			box,
			narrow,
			0,
		);
		expect(edge.x).toBe(150); // clamped
	});
	it("tolerates a zero-sized board", () => {
		expect(normaliseCardPosition({ x: 5, y: 5 }, { w: 0, h: 0 })).toEqual({
			x: 5,
			y: 5,
		});
	});
});
