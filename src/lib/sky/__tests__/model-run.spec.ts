// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// inferSkyModel / runSkyModel on the nn CPU backend with the miniature weights (no model file, no GPU).
import { describe, expect, it } from "vitest";
import { modelSize, normalise, resamplePlanes } from "../core";
import {
	createSkyModel,
	inferSkyModel,
	inferSkyModelGpu,
	MODEL_LONG_SIDE,
	runSkyModel,
} from "../model";
import { tinyU2netpBytes } from "./u2netp-fixture";

const W = 96;
const H = 64;

const model = () => createSkyModel({ bytes: tinyU2netpBytes() });

describe("MODEL_LONG_SIDE", () => {
	it("webgpu runs larger than the cpu backend", () => {
		expect(MODEL_LONG_SIDE.webgpu).toBeGreaterThan(MODEL_LONG_SIDE.cpu);
	});
});

describe("inferSkyModel (CPU output)", () => {
	it("resamples to the model size and returns P(sky) in (0, 1)", async () => {
		const m = await model();
		const rgb = new Float32Array(W * H * 3).fill(0.5);
		const r = await inferSkyModel(m, rgb, W, H, 64);
		const { width, height } = modelSize(W, H, 64);
		expect(r.width).toBe(width);
		expect(r.height).toBe(height);
		expect(r.rgbLo).toHaveLength(3 * width * height);
		expect(r.prob).toHaveLength(width * height);
		expect(r.gpuBuffer).toBeUndefined();
		for (const v of r.prob as Float32Array) {
			expect(v).toBeGreaterThan(0);
			expect(v).toBeLessThan(1);
		}
		expect(await r.download()).toEqual(r.prob);
		r.release();
	});
	it("matches the miniature graph on the normalised input", async () => {
		const m = await model();
		const rgb = Float32Array.from({ length: W * H * 3 }, (_, i) => (i % 7) / 7);
		const { width, height } = modelSize(W, H, 64);
		const lo = resamplePlanes(rgb, W, H, 3, width, height);
		const x = normalise(lo, width * height);
		const out = await runSkyModel(m, rgb, W, H, 64);
		// centre pixel, away from borders: a = relu(.5 xr + .25 xg + .25 xb), d = (up(pool(a)) + a) * 1, sigmoid(2d)
		const n = width * height;
		const at = (y: number, xx: number) => {
			const i = y * width + xx;
			return Math.max(0, 0.5 * x[i] + 0.25 * x[n + i] + 0.25 * x[2 * n + i]);
		};
		// the dilated conv's centre tap only, so a is pointwise; the pooled/resized branch is checked
		// through its bounds: d >= a, so P >= sigmoid(2a)
		const y = Math.floor(height / 2);
		const xx = Math.floor(width / 2);
		expect(out.prob[y * width + xx]).toBeGreaterThanOrEqual(
			1 / (1 + Math.exp(-2 * at(y, xx))) - 1e-6,
		);
	});
});

describe("inferSkyModelGpu", () => {
	it("requires a model on the GPU", async () => {
		const m = await model();
		await expect(inferSkyModelGpu(m, {} as never, 32, 32)).rejects.toThrow(
			/not on the GPU/,
		);
	});
});
