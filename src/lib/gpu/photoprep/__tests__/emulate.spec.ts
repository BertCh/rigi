// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { edgeMapFromPixels } from "#/lib/align";
import { seededRandom } from "#/test/helpers";
import { blurCol, blurRow, emulateEdge, lumab, radixSelect } from "../emulate";
import { bandLimits, photoPrepDims, photoPrepSupported } from "../plan";

const W = 28;
const H = 24;
function scene() {
	const rnd = seededRandom(21);
	const rgba = new Uint8ClampedArray(W * H * 4);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4;
			const sky = y < 8 + Math.floor(3 * Math.sin(x / 3));
			rgba[i] = (sky ? 120 : 60) + Math.floor(rnd() * 20);
			rgba[i + 1] = (sky ? 160 : 90) + Math.floor(rnd() * 20);
			rgba[i + 2] = (sky ? 230 : 50) + Math.floor(rnd() * 20);
			rgba[i + 3] = 255;
		}
	const fg = new Float32Array(W * H);
	for (let y = 14; y < 20; y++) for (let x = 10; x < 14; x++) fg[y * W + x] = 1;
	return { rgba, fg };
}

describe("photoprep plan", () => {
	it("dims words follow the CPU thresholds", () => {
		const d = photoPrepDims(W, H, 7);
		expect([d[0], d[1], d[2], d[7]]).toEqual([W, H, W * H, 7]);
		expect(d[3]).toBe(Math.floor(W * H * 0.97));
		expect(d[4]).toBe(Math.round(H * 0.12));
		expect(d[6]).toBe(Math.round(H * 0.8));
	});
	it("supported sizes", () => {
		expect(photoPrepSupported(512, 341)).toBe(true);
		expect(photoPrepSupported(2, 10)).toBe(false);
		expect(photoPrepSupported(4096, 4096)).toBe(false);
	});
	it("bandLimits are one interval per column and respect the prior", () => {
		const lim = bandLimits(W, H);
		expect(lim.length).toBe(2 * W);
		expect(lim[0]).toBeGreaterThanOrEqual(3);
		expect(lim[1]).toBeLessThanOrEqual(H - 2);
		expect(lim[2 * (W - 1)]).toBe(lim[0]);
		const prior = new Float32Array(W).fill(-1);
		prior[3] = 10;
		const lp = bandLimits(W, H, prior);
		expect([lp[0], lp[1]]).toEqual([1, 0]); // implausible column: empty
		expect(lp[6]).toBeLessThanOrEqual(10);
		expect(lp[7]).toBeGreaterThanOrEqual(10);
	});
});

describe("photoprep emulation", () => {
	it("blur of a constant plane is the constant", () => {
		const dims = photoPrepDims(8, 8);
		const src = new Uint32Array(64).fill(
			new Uint32Array(new Float32Array([0.25]).buffer)[0],
		);
		expect(blurCol(dims, blurRow(dims, src, 2), 2)).toEqual(src);
	});
	it("radixSelect returns the k-th smallest value", () => {
		const dims = photoPrepDims(8, 8);
		const rnd = seededRandom(4);
		const e = new Uint32Array(64);
		const f = new Float32Array(1);
		const u = new Uint32Array(f.buffer);
		for (let i = 0; i < 64; i++) {
			f[0] = rnd() * 3;
			e[i] = u[0];
		}
		const sorted = [...e].sort((a, b) => a - b);
		const sel = radixSelect(dims, e);
		expect(sel[0]).toBe(sorted[dims[3]]);
		expect(sel[2]).toBe(sorted[dims[3]]);
	});
	it("luminance of grey is the grey", () => {
		const dims = photoPrepDims(2, 2);
		const rgba = new Uint32Array(4).fill(0x00808080);
		const { lum } = lumab(dims, rgba);
		const f = new Float32Array(lum.buffer);
		expect(f[0]).toBeCloseTo(128 / 255, 6);
	});
	it("whole edge graph equals the CPU reference bit for bit", () => {
		const { rgba, fg } = scene();
		const cpu = edgeMapFromPixels(rgba, W, H, fg);
		const words = new Uint32Array(rgba.buffer.slice(0));
		const fgBits = new Uint32Array(fg.buffer.slice(0));
		const gpu = emulateEdge(
			photoPrepDims(W, H),
			words,
			fgBits,
			bandLimits(W, H),
		);
		const eq = (a: Uint32Array, b: Float32Array) =>
			expect(new Float32Array(a.buffer)).toEqual(b);
		eq(gpu.coarse, cpu.coarse);
		eq(gpu.fine, cpu.fine);
		eq(gpu.sky, cpu.sky);
		eq(gpu.skyCum, cpu.skyCum);
	});
});
