// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// createSkyModel backend selection and shareOrtDevice against a mocked onnxruntime-web.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ortMock = vi.hoisted(() => ({
	env: { webgpu: {} as Record<string, unknown> },
	create: undefined as unknown as (
		bytes: Uint8Array,
		opts: Record<string, unknown>,
	) => Promise<unknown>,
	calls: [] as { backend: string; opts: Record<string, unknown> }[],
}));

vi.mock("onnxruntime-web", () => ({
	env: ortMock.env,
	InferenceSession: {
		create: (bytes: Uint8Array, opts: Record<string, unknown>) => {
			ortMock.calls.push({
				backend: (opts.executionProviders as string[])[0],
				opts,
			});
			return ortMock.create(bytes, opts);
		},
	},
	Tensor: class {},
}));

import { createSkyModel, shareOrtDevice } from "../model";

const bytes = new Uint8Array(4);
const device = (id = "d") =>
	({
		id,
		limits: { l: 1 },
		features: new Set(),
		adapterInfo: { vendor: "x" },
	}) as unknown as GPUDevice;

function stubGpu(adapter: unknown | null | Error) {
	vi.stubGlobal("navigator", {
		gpu: {
			requestAdapter: async () => {
				if (adapter instanceof Error) throw adapter;
				return adapter;
			},
		},
	});
}

beforeEach(() => {
	ortMock.env.webgpu = {};
	ortMock.calls.length = 0;
	ortMock.create = async () => ({ session: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("shareOrtDevice", () => {
	it("hands ORT an adapter whose requestDevice resolves the caller's device", async () => {
		const d = device();
		expect(await shareOrtDevice(d)).toBe(true);
		const a = ortMock.env.webgpu.adapter as {
			limits: unknown;
			features: unknown;
			info: unknown;
			requestDevice(): Promise<unknown>;
			requestAdapterInfo(): Promise<unknown>;
		};
		expect(await a.requestDevice()).toBe(d);
		expect(a.limits).toBe(d.limits);
		expect(a.features).toBe(d.features);
		expect(await a.requestAdapterInfo()).toEqual({ vendor: "x" });
	});

	it("once ORT has its own device, only reports whether it is the caller's", async () => {
		const d = device();
		ortMock.env.webgpu = { device: d };
		expect(await shareOrtDevice(d)).toBe(true);
		expect(await shareOrtDevice(device("other"))).toBe(false);
		// a promise-valued ORT device is awaited
		ortMock.env.webgpu = { device: Promise.resolve(d) };
		expect(await shareOrtDevice(d)).toBe(true);
		expect(ortMock.env.webgpu.adapter).toBeUndefined();
	});

	it("returns false when ORT's adapter slot is read-only", async () => {
		ortMock.env.webgpu = Object.defineProperty({}, "adapter", {
			get: () => null,
			set() {
				throw new TypeError("read-only");
			},
		});
		expect(await shareOrtDevice(device())).toBe(false);
	});
});

describe("createSkyModel backend choice", () => {
	it("uses wasm when WebGPU is missing", async () => {
		vi.stubGlobal("navigator", {});
		const m = await createSkyModel(bytes);
		expect(m.backend).toBe("wasm");
		expect(ortMock.calls.map((c) => c.backend)).toEqual(["wasm"]);
	});

	it("skips software adapters and adapters that throw", async () => {
		for (const a of [
			{ isFallbackAdapter: true },
			{ info: { architecture: "swiftshader" } },
			null,
			new Error("denied"),
		]) {
			ortMock.calls.length = 0;
			stubGpu(a);
			expect((await createSkyModel(bytes)).backend).toBe("wasm");
			expect(ortMock.calls.map((c) => c.backend)).toEqual(["wasm"]);
		}
	});

	it("prefers WebGPU on a hardware adapter", async () => {
		stubGpu({ info: { architecture: "ampere" } });
		expect((await createSkyModel(bytes)).backend).toBe("webgpu");
		expect(ortMock.calls[0].opts.graphOptimizationLevel).toBe("all");
		expect(ortMock.calls[0].opts.preferredOutputLocation).toBeUndefined();
	});

	it("tries WebGPU even on a software adapter when it is the only backend requested", async () => {
		stubGpu({ isFallbackAdapter: true });
		expect((await createSkyModel(bytes, ["webgpu"])).backend).toBe("webgpu");
	});

	it("falls back to wasm when the WebGPU session fails, and rethrows the last error when all fail", async () => {
		stubGpu({});
		ortMock.create = async (_b, o) => {
			if ((o.executionProviders as string[])[0] === "webgpu")
				throw new Error("gpu boom");
			return {};
		};
		expect((await createSkyModel(bytes)).backend).toBe("wasm");
		ortMock.create = async (_b, o) => {
			throw new Error(`${(o.executionProviders as string[])[0]} boom`);
		};
		await expect(createSkyModel(bytes)).rejects.toThrow("wasm boom");
	});

	it("reports no backend for an empty list", async () => {
		await expect(createSkyModel(bytes, [])).rejects.toThrow(
			"no ONNX Runtime backend available",
		);
	});
});

describe("createSkyModel with a shared device", () => {
	it("keeps the output on the GPU and records the shared device when ORT adopts it", async () => {
		stubGpu({});
		const d = device();
		ortMock.create = async () => {
			ortMock.env.webgpu.device = d; // what ORT does after initialising on our adapter
			return {};
		};
		const m = await createSkyModel(bytes, ["webgpu"], { device: d });
		expect(m.sharedDevice).toBe(d);
		expect(ortMock.calls[0].opts.preferredOutputLocation).toBe("gpu-buffer");
	});

	it("does not claim the device when ORT ended up on another one", async () => {
		stubGpu({});
		const d = device();
		ortMock.create = async () => {
			ortMock.env.webgpu.device = device("ort-own");
			return {};
		};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const m = await createSkyModel(bytes, ["webgpu"], { device: d });
		expect(m.sharedDevice).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("did not take the shared"),
		);
	});

	it("never shares the device with the wasm backend", async () => {
		vi.stubGlobal("navigator", {});
		const m = await createSkyModel(bytes, ["wasm"], { device: device() });
		expect(m.sharedDevice).toBeUndefined();
		expect(ortMock.env.webgpu.adapter).toBeUndefined();
		expect(ortMock.calls[0].opts.preferredOutputLocation).toBeUndefined();
	});
});
