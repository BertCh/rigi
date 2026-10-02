// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// inferSkyModel / runSkyModel against a stub ORT session (no model file, no GPU).
import { describe, expect, it, vi } from "vitest";
import { modelSize } from "../core";
import {
	inferSkyModel,
	inferSkyModelGpu,
	MODEL_LONG_SIDE,
	runSkyModel,
	type SkyModel,
} from "../model";

const W = 96;
const H = 64;

function stubModel(opts: { gpu?: boolean; backend?: "webgpu" | "wasm" } = {}) {
	const seen: { dims?: readonly number[]; dispose: number } = { dispose: 0 };
	const { width, height } = modelSize(W, H, 64);
	const outDispose = vi.fn();
	const session = {
		inputNames: ["in"],
		outputNames: ["out"],
		run: vi.fn(async (feeds: Record<string, { dims: readonly number[] }>) => {
			seen.dims = feeds.in.dims;
			return {
				out: opts.gpu
					? {
							location: "gpu-buffer",
							gpuBuffer: { id: "buf" },
							getData: async () => new Float32Array(width * height).fill(0.25),
							dispose: outDispose,
						}
					: {
							location: "cpu",
							data: new Float32Array(width * height).fill(0.75),
							dispose: outDispose,
						},
			};
		}),
	};
	return {
		model: {
			session,
			backend: opts.backend ?? "wasm",
			sharedDevice: opts.gpu ? ({} as GPUDevice) : undefined,
		} as unknown as SkyModel,
		session,
		seen,
		outDispose,
		width,
		height,
	};
}

describe("MODEL_LONG_SIDE", () => {
	it("webgpu runs larger than wasm", () => {
		expect(MODEL_LONG_SIDE.webgpu).toBeGreaterThan(MODEL_LONG_SIDE.wasm);
	});
});

describe("inferSkyModel (CPU output)", () => {
	it("feeds a normalised NCHW tensor at model size and returns a copy of the probabilities", async () => {
		const s = stubModel();
		const rgb = new Float32Array(W * H * 3).fill(0.5);
		const r = await inferSkyModel(s.model, rgb, W, H, 64);
		expect(s.seen.dims).toEqual([1, 3, s.height, s.width]);
		expect(r.width).toBe(s.width);
		expect(r.height).toBe(s.height);
		expect(r.rgbLo).toHaveLength(3 * s.width * s.height);
		expect(r.prob?.[0]).toBe(0.75);
		expect(r.gpuBuffer).toBeUndefined();
		expect((await r.download())[0]).toBe(0.75);
		expect(s.outDispose).toHaveBeenCalledTimes(1); // CPU copy taken, output tensor freed
		r.release();
	});
	it("runSkyModel returns P(sky) at model size", async () => {
		const s = stubModel();
		const out = await runSkyModel(
			s.model,
			new Float32Array(W * H * 3),
			W,
			H,
			64,
		);
		expect(out.width).toBe(s.width);
		expect(out.prob).toHaveLength(s.width * s.height);
		expect(out.prob[10]).toBe(0.75);
	});
	it("propagates a session error", async () => {
		const s = stubModel();
		s.session.run.mockRejectedValueOnce(new Error("ort failed"));
		await expect(
			inferSkyModel(s.model, new Float32Array(W * H * 3), W, H, 64),
		).rejects.toThrow("ort failed");
	});
});

describe("inferSkyModel (GPU output)", () => {
	it("keeps the buffer on the GPU, downloads lazily once, and release frees the tensor", async () => {
		const s = stubModel({ gpu: true, backend: "webgpu" });
		const r = await inferSkyModel(
			s.model,
			new Float32Array(W * H * 3),
			W,
			H,
			64,
		);
		expect(r.prob).toBeUndefined();
		expect(r.gpuBuffer).toEqual({ id: "buf" });
		const a = await r.download();
		const b = await r.download();
		expect(a[0]).toBe(0.25);
		expect(a).toBe(b);
		r.release();
		expect(s.outDispose).toHaveBeenCalledTimes(1);
	});
});

describe("inferSkyModelGpu", () => {
	it("requires a model on the shared device", async () => {
		const s = stubModel();
		await expect(
			inferSkyModelGpu(s.model, {} as GPUBuffer, 32, 32),
		).rejects.toThrow(/shared device/);
	});
});
