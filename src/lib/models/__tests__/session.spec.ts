// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// createOrtSession against a mocked onnxruntime-web (the node path reads the bytes from disk).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ortMock = vi.hoisted(() => ({
	env: { webgpu: {} as Record<string, unknown>, wasm: {} },
	calls: [] as { bytes: Uint8Array; opts: Record<string, unknown> }[],
}));

vi.mock("onnxruntime-web", () => ({
	env: ortMock.env,
	InferenceSession: {
		create: async (bytes: Uint8Array, opts: Record<string, unknown>) => {
			ortMock.calls.push({ bytes, opts });
			return { inputNames: ["x"] };
		},
	},
	Tensor: class {},
}));

import { createOrtSession } from "../index";

beforeEach(() => {
	ortMock.calls.length = 0;
	ortMock.env.webgpu = {};
	const dir = mkdtempSync(join(tmpdir(), "rigi-ort-"));
	writeFileSync(join(dir, "net.onnx"), new Uint8Array([9, 8, 7]));
	vi.stubEnv("RIGI_MODELS_DIR", dir);
	vi.stubGlobal("navigator", {});
});

describe("createOrtSession", () => {
	it("loads the bytes and falls back to wasm without WebGPU", async () => {
		const s = await createOrtSession("models/net.onnx");
		expect(s.backend).toBe("wasm");
		expect(s.sharedDevice).toBeUndefined();
		expect([...ortMock.calls[0].bytes]).toEqual([9, 8, 7]);
		expect(ortMock.calls[0].opts.executionProviders).toEqual(["wasm"]);
		expect(ortMock.calls[0].opts.preferredOutputLocation).toBeUndefined();
	});

	it("preferWebGpu: false never tries WebGPU, even on a hardware adapter", async () => {
		vi.stubGlobal("navigator", {
			gpu: { requestAdapter: async () => ({ info: {} }) },
		});
		const s = await createOrtSession("net.onnx", { preferWebGpu: false });
		expect(s.backend).toBe("wasm");
		expect(ortMock.calls).toHaveLength(1);
	});

	it("tries WebGPU first on a hardware adapter and passes session options through", async () => {
		vi.stubGlobal("navigator", {
			gpu: { requestAdapter: async () => ({ info: {} }) },
		});
		const s = await createOrtSession("net.onnx", {
			sessionOptions: { logSeverityLevel: 3 },
		});
		expect(s.backend).toBe("webgpu");
		expect(ortMock.calls[0].opts.logSeverityLevel).toBe(3);
		expect(ortMock.calls[0].opts.graphOptimizationLevel).toBe("all");
	});

	it("does not hand a WebGL device to ORT", async () => {
		const s = await createOrtSession("net.onnx", {
			device: { type: "webgl" } as never,
		});
		expect(s.backend).toBe("wasm");
		expect(ortMock.env.webgpu.adapter).toBeUndefined();
	});

	it("honours an aborted signal", async () => {
		const c = new AbortController();
		c.abort(new Error("stop"));
		await expect(
			createOrtSession("net.onnx", { signal: c.signal }),
		).rejects.toThrow("stop");
	});
});
