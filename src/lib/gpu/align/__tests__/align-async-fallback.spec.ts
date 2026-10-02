// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import { autoAlign, type EdgeMap, edgeMapFromPixels } from "#/lib/align";
import { type Pose, projectPoint } from "#/lib/camera";
import { autoAlignAsync, lastAlignTiming } from "../index";

// Mocks for the "device present but the grid fails" branch; the default is no device.
const gpu = vi.hoisted(() => ({
	device: null as object | null,
	gridError: false,
}));
vi.mock("#/lib/gpu/device", () => ({
	getComputeDevice: async () => gpu.device,
}));
vi.mock("#/lib/gpu/photoprep", () => ({
	fitPriorSkyGpu: async () => null,
}));
vi.mock("../pose-grid", async (importOriginal) => ({
	...(await importOriginal<typeof import("../pose-grid")>()),
	scorePoseGridGpu: async () => {
		throw new Error("grid boom");
	},
}));

const W = 120;
const H = 80;
const ASPECT = W / H;
const truth: Pose = { yaw: 100, pitch: 3, roll: 0, vfov: 50 };
const elevationAt = (az: number) =>
	4 + 3 * Math.sin((az * Math.PI) / 9) + 2 * Math.sin((az * Math.PI) / 4 + 1);

const dirs = (() => {
	const out: number[] = [];
	for (let az = 0; az < 360; az += 0.5) {
		const a = (az * Math.PI) / 180;
		const e = (elevationAt(az) * Math.PI) / 180;
		out.push(Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e));
	}
	return Float32Array.from(out);
})();

function freshMap(): EdgeMap {
	const rows = new Float32Array(W).fill(Number.NaN);
	for (let i = 0; i < dirs.length; i += 3) {
		const q = projectPoint(
			truth,
			ASPECT,
			[0, 0, 0],
			[dirs[i], dirs[i + 1], dirs[i + 2]],
		);
		if (!q) continue;
		const x = Math.floor(q.u * W);
		if (x >= 0 && x < W && !(rows[x] <= q.v * H)) rows[x] = q.v * H;
	}
	const rgb = new Uint8ClampedArray(W * H * 4);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const o = 4 * (y * W + x);
			const sky = y < (Number.isFinite(rows[x]) ? rows[x] : H * 0.5);
			[rgb[o], rgb[o + 1], rgb[o + 2]] = sky ? [110, 160, 235] : [60, 55, 50];
			rgb[o + 3] = 255;
		}
	return edgeMapFromPixels(rgb, W, H, new Float32Array(W * H));
}

const prior: Pose = { ...truth, yaw: truth.yaw + 5, pitch: truth.pitch - 1 };

describe("autoAlignAsync CPU fallbacks", () => {
	it("no compute device (?gpu=off): the result is exactly autoAlign's", async () => {
		(globalThis as { __RIGI_FLAGS__?: unknown }).__RIGI_FLAGS__ = {
			gpu: "off",
		};
		gpu.device = null;
		const want = autoAlign(prior, ASPECT, dirs, freshMap(), 10);
		const got = await autoAlignAsync(prior, ASPECT, dirs, freshMap(), 10);
		expect(got).toEqual(want);
		expect(got.score).toBe(want.score);
		expect(got.confidence).toBe(want.confidence);
		expect(lastAlignTiming?.path).toBe("cpu");
		expect(lastAlignTiming?.rescored).toBe(0);
	});
	it("a failing GPU grid falls back to the CPU search with the same result", async () => {
		gpu.device = {};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const want = autoAlign(prior, ASPECT, dirs, freshMap(), 10);
		const got = await autoAlignAsync(prior, ASPECT, dirs, freshMap(), 10);
		warn.mockRestore();
		expect(got).toEqual(want);
		expect(lastAlignTiming?.path).toBe("cpu");
		expect(lastAlignTiming?.error).toContain("grid boom");
		expect(lastAlignTiming?.refine).toBe("cpu");
	});
});
