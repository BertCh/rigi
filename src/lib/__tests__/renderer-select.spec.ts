// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFlags } from "#/test/helpers";

type Mod = typeof import("../renderer-select");

type GpuOpts = {
	adapter?: boolean;
	features?: string[];
	limits?: Record<string, number>;
	deviceError?: Error;
	info?: { vendor?: string; architecture?: string };
};

function stubGpu(o: GpuOpts = {}) {
	const destroy = vi.fn();
	const requestDevice = vi.fn(async () => {
		if (o.deviceError) throw o.deviceError;
		return { destroy };
	});
	const requestAdapter = vi.fn(async () =>
		o.adapter === false
			? null
			: {
					features: new Set(o.features ?? ["float32-filterable"]),
					limits: {
						maxTextureDimension2D: 16384,
						maxColorAttachments: 8,
						maxStorageBufferBindingSize: 1 << 30,
						...o.limits,
					},
					info: o.info ?? { vendor: "apple", architecture: "metal-3" },
					requestDevice,
				},
	);
	vi.stubGlobal("navigator", { gpu: { requestAdapter } });
	return { requestAdapter, requestDevice, destroy };
}

let R: Mod;
let warn: ReturnType<typeof vi.spyOn>;
// the probe result is cached per module instance: reload it for each case
beforeEach(async () => {
	vi.resetModules();
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	R = await import("../renderer-select");
});

describe("requestedRenderer", () => {
	it("defaults to auto", () => {
		expect(R.requestedRenderer()).toBe("auto");
	});
	it("returns the renderer flag", async () => {
		withFlags({ renderer: "deck" });
		expect(R.requestedRenderer()).toBe("deck");
		withFlags({ renderer: "webgpu" });
		expect(R.requestedRenderer()).toBe("webgpu");
	});
	it("?backend overrides ?renderer (webgl pins deck, webgpu pins webgpu)", () => {
		withFlags({ renderer: "webgpu", backend: "webgl" });
		expect(R.requestedRenderer()).toBe("deck");
		withFlags({ renderer: "deck", backend: "webgpu" });
		expect(R.requestedRenderer()).toBe("webgpu");
		withFlags({ renderer: "deck", backend: "auto" });
		expect(R.requestedRenderer()).toBe("deck");
	});
	it("treats the retired three value as auto", () => {
		withFlags({ renderer: "three" });
		expect(R.requestedRenderer()).toBe("auto");
	});
});

describe("probeWebGpu", () => {
	it("fails without navigator.gpu", async () => {
		vi.stubGlobal("navigator", {});
		expect(await R.probeWebGpu()).toEqual({
			ok: false,
			reason: "no navigator.gpu",
		});
	});
	it("fails when there is no adapter", async () => {
		stubGpu({ adapter: false });
		expect(await R.probeWebGpu()).toEqual({
			ok: false,
			reason: "no WebGPU adapter",
		});
	});
	it("names a missing required feature", async () => {
		stubGpu({ features: [] });
		expect(await R.probeWebGpu()).toEqual({
			ok: false,
			reason: "adapter lacks float32-filterable",
		});
	});
	it.each([
		[
			"maxTextureDimension2D",
			4096,
			"adapter maxTextureDimension2D 4096 < 8192",
		],
		["maxColorAttachments", 1, "adapter maxColorAttachments 1 < 2"],
		[
			"maxStorageBufferBindingSize",
			1 << 20,
			`adapter maxStorageBufferBindingSize ${1 << 20} < ${128 << 20}`,
		],
	])("rejects a too-small %s", async (k, v, reason) => {
		stubGpu({ limits: { [k]: v } });
		expect(await R.probeWebGpu()).toEqual({ ok: false, reason });
	});
	it("accepts limits exactly at the minimum", async () => {
		stubGpu({
			limits: {
				maxTextureDimension2D: 8192,
				maxColorAttachments: 2,
				maxStorageBufferBindingSize: 128 << 20,
			},
		});
		expect((await R.probeWebGpu()).ok).toBe(true);
	});
	it("requests a device with the required features and destroys it", async () => {
		const g = stubGpu();
		const p = await R.probeWebGpu();
		expect(p).toEqual({ ok: true, adapter: "apple metal-3" });
		expect(g.requestAdapter).toHaveBeenCalledWith({
			powerPreference: "high-performance",
		});
		expect(g.requestDevice).toHaveBeenCalledWith({
			requiredFeatures: ["float32-filterable"],
		});
		expect(g.destroy).toHaveBeenCalledTimes(1);
	});
	it("labels a missing adapter info as ?", async () => {
		stubGpu({ info: {} });
		expect(await R.probeWebGpu()).toEqual({ ok: true, adapter: "?" });
	});
	it("turns a device-creation failure into a reason, never throws", async () => {
		stubGpu({ deviceError: new Error("lost") });
		expect(await R.probeWebGpu()).toEqual({
			ok: false,
			reason: "WebGPU probe failed: lost",
		});
	});
	it("caches the result per page", async () => {
		const g = stubGpu();
		await R.probeWebGpu();
		await R.probeWebGpu();
		expect(g.requestAdapter).toHaveBeenCalledTimes(1);
	});
	it("exposes the required features", () => {
		expect([...R.WEBGPU_REQUIRED_FEATURES]).toEqual(["float32-filterable"]);
	});
});

describe("resolveRenderer", () => {
	it("auto + capable browser = webgpu with the adapter in the reason", async () => {
		stubGpu();
		expect(await R.resolveRenderer()).toEqual({
			renderer: "webgpu",
			reason: "auto: apple metal-3",
		});
	});
	it("renderer=webgpu on a capable browser says pinned", async () => {
		stubGpu();
		withFlags({ renderer: "webgpu" });
		expect(await R.resolveRenderer()).toEqual({
			renderer: "webgpu",
			reason: "pinned",
		});
	});
	it("renderer=deck never probes", async () => {
		const g = stubGpu();
		withFlags({ renderer: "deck" });
		expect(await R.resolveRenderer()).toEqual({
			renderer: "deck",
			reason: "pinned",
		});
		expect(g.requestAdapter).not.toHaveBeenCalled();
	});
	it("webgpu=off forces the WebGL deck without probing", async () => {
		const g = stubGpu();
		withFlags({ webgpu: "off" });
		expect(await R.resolveRenderer()).toEqual({
			renderer: "deck",
			reason: "webgpu=off",
		});
		expect(g.requestAdapter).not.toHaveBeenCalled();
	});
	it("auto falls back silently when WebGPU is unavailable", async () => {
		vi.stubGlobal("navigator", {});
		expect(await R.resolveRenderer()).toEqual({
			renderer: "deck",
			reason: "fallback: no navigator.gpu",
		});
		expect(warn).not.toHaveBeenCalled();
	});
	it("renderer=webgpu falls back with a console warning", async () => {
		stubGpu({ features: [] });
		withFlags({ renderer: "webgpu" });
		const r = await R.resolveRenderer();
		expect(r.renderer).toBe("deck");
		expect(r.reason).toBe("fallback: adapter lacks float32-filterable");
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("webgpu asked for but unavailable"),
		);
	});
	it("backend=webgl pins deck even if renderer=webgpu", async () => {
		stubGpu();
		withFlags({ renderer: "webgpu", backend: "webgl" });
		expect((await R.resolveRenderer()).renderer).toBe("deck");
	});
	it("backend=webgpu pins webgpu over renderer=deck", async () => {
		stubGpu();
		withFlags({ renderer: "deck", backend: "webgpu" });
		expect(await R.resolveRenderer()).toEqual({
			renderer: "webgpu",
			reason: "pinned",
		});
	});
});

describe("WEBGPU_REQUIRED_FEATURES", () => {
	// duplicated so the probe never pulls the WebGPU chunk: read device.ts as text instead of importing it
	it("equals deck-webgpu/device.ts REQUIRED_FEATURES", () => {
		const src = readFileSync(
			new URL("../deck-webgpu/device.ts", import.meta.url),
			"utf8",
		);
		const m = /export const REQUIRED_FEATURES = \[([^\]]*)\]/.exec(src);
		expect(m).not.toBeNull();
		const listed = [...(m?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]);
		expect(listed).toEqual([...R.WEBGPU_REQUIRED_FEATURES]);
	});
});
