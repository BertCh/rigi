// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { RollPin } from "#/lib/roll/map/backend";
import { PIN_STRIDE_BYTES, packPins, packRGBA8 } from "../pins-pack";

const pin = (over: Partial<RollPin> = {}): RollPin => ({
	id: "a",
	position: [1500.5, -20, 300],
	radiusPx: 8,
	fill: [10, 20, 30, 255],
	line: [255, 85, 51, 230],
	lineWidthPx: 2.5,
	...over,
});

describe("packRGBA8", () => {
	it("puts r in the low byte and clamps", () => {
		expect(packRGBA8([1, 2, 3, 4])).toBe(0x04030201);
		expect(packRGBA8([300, -5, 0, 255])).toBe(0xff0000ff);
	});
});

describe("packPins", () => {
	it("writes one 28-byte record per pin in order", () => {
		const buf = packPins([pin(), pin({ radiusPx: 5 })]);
		expect(buf.byteLength).toBe(2 * PIN_STRIDE_BYTES);
		const f = new Float32Array(buf);
		const u = new Uint32Array(buf);
		expect([...f.slice(0, 5)]).toEqual([1500.5, -20, 300, 8, 2.5]);
		expect(u[5]).toBe(packRGBA8([10, 20, 30, 255]));
		expect(u[6]).toBe(packRGBA8([255, 85, 51, 230]));
		expect(f[7 + 3]).toBe(5);
	});

	it("allocates a non-empty buffer for no pins", () => {
		expect(packPins([]).byteLength).toBe(PIN_STRIDE_BYTES);
	});
});
