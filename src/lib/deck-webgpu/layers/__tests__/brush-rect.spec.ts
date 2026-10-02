// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { circleRect, extractRed, unionRect } from "../brush-rect";

describe("unionRect", () => {
	it("returns the new rect when there is none yet", () => {
		const b = { x0: 1, y0: 2, x1: 3, y1: 4 };
		expect(unionRect(null, b)).toBe(b);
	});

	it("covers both rectangles", () => {
		expect(
			unionRect(
				{ x0: 5, y0: 5, x1: 10, y1: 10 },
				{ x0: 0, y0: 7, x1: 6, y1: 20 },
			),
		).toEqual({ x0: 0, y0: 5, x1: 10, y1: 20 });
	});
});

describe("circleRect", () => {
	it("pads the circle's box by a pixel", () => {
		expect(circleRect(100, 50, 10, 512, 256)).toEqual({
			x0: 89,
			y0: 39,
			x1: 111,
			y1: 61,
		});
	});

	it("clamps to the canvas", () => {
		expect(circleRect(2, 510, 20, 512, 512)).toEqual({
			x0: 0,
			y0: 489,
			x1: 23,
			y1: 512,
		});
	});

	it("is empty when fully outside", () => {
		const r = circleRect(-50, 10, 5, 512, 512);
		expect(r.x1 <= r.x0).toBe(true);
	});
});

describe("extractRed", () => {
	it("packs the red channel of a sub-rectangle", () => {
		// 4x3 canvas, red = 10 * y + x
		const rgba = new Uint8ClampedArray(4 * 3 * 4);
		for (let y = 0; y < 3; y++)
			for (let x = 0; x < 4; x++) rgba[(y * 4 + x) * 4] = 10 * y + x;
		expect(extractRed(rgba, { x0: 1, y0: 1, x1: 3, y1: 3 }, 4)).toEqual(
			Uint8Array.from([11, 12, 21, 22]),
		);
	});

	it("matches a full extract over the whole canvas", () => {
		const rgba = Uint8ClampedArray.from([1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0]);
		expect(extractRed(rgba, { x0: 0, y0: 0, x1: 3, y1: 1 }, 3)).toEqual(
			Uint8Array.from([1, 2, 3]),
		);
	});
});
