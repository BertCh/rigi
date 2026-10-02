// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { liveDepthGrid, rgbaToPlanes } from "../video-input";

describe("liveDepthGrid", () => {
	it("gives a token grid whose input is a multiple of 14 and a depth grid capped at maxSide", () => {
		const g = liveDepthGrid(1280, 720, 256, 512);
		expect(g.inputWidth % 14).toBe(0);
		expect(g.inputHeight % 14).toBe(0);
		expect(g.bw * g.bh).toBeGreaterThan(200);
		expect(g.bw * g.bh).toBeLessThan(320);
		expect(g.width).toBe(512);
		expect(g.height).toBe(288);
	});
	it("does not upscale a small frame", () => {
		const g = liveDepthGrid(320, 240, 256, 512);
		expect([g.width, g.height]).toEqual([320, 240]);
	});
});

describe("rgbaToPlanes", () => {
	it("splits interleaved RGBA into planar 0..1", () => {
		const rgba = new Uint8Array([255, 0, 51, 255, 0, 255, 102, 255]);
		const out = rgbaToPlanes(rgba, 2, new Float32Array(6));
		expect(Array.from(out)).toEqual(
			Array.from(new Float32Array([1, 0, 0, 1, 51 / 255, 102 / 255])),
		);
	});
});
