// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device } from "@luma.gl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withFlags } from "#/test/helpers";

const compute = vi.hoisted(() => ({ device: null as unknown, reject: false }));
vi.mock("#/lib/gpu/device", () => ({
	getComputeDevice: () =>
		compute.reject
			? Promise.reject(new Error("lost"))
			: Promise.resolve(compute.device),
}));
vi.mock("#/lib/gpu/look/textures", async (orig) => ({
	...(await orig<object>()),
	warmTextureKernelsAsync: vi.fn(async () => {}),
	releaseTextureGraphs: vi.fn(async () => {}),
}));

import {
	createLookBridge,
	LookBridge,
	lookBridgeGate,
} from "../compute-bridge";

const fakeDevice = (over: Record<string, unknown> = {}) =>
	({
		type: "webgpu",
		isLost: false,
		features: new Set(["float32-filterable"]),
		...over,
	}) as unknown as Device;

beforeEach(() => {
	vi.stubGlobal("navigator", { gpu: {} });
	withFlags({ gpu: "on" });
	compute.reject = false;
	compute.device = null;
});
afterEach(() => vi.unstubAllGlobals());

describe("lookBridgeGate", () => {
	it("is open when the compute device IS the render device", async () => {
		const d = fakeDevice();
		compute.device = d;
		expect(await lookBridgeGate(d)).toBeNull();
	});

	it("is closed by ?gpu=off and a missing navigator.gpu", async () => {
		const d = fakeDevice();
		compute.device = d;
		withFlags({ gpu: "off" });
		expect(await lookBridgeGate(d)).toMatch(/look GPU off/);
		withFlags({ gpu: "on" });
		vi.stubGlobal("navigator", {});
		expect(await lookBridgeGate(d)).toMatch(/look GPU off/);
	});

	it("is closed for a WebGL device and for a device without float32-filterable", async () => {
		expect(await lookBridgeGate(fakeDevice({ type: "webgl" }))).toBe(
			"not a WebGPU device",
		);
		expect(await lookBridgeGate(fakeDevice({ features: new Set() }))).toBe(
			"no float32-filterable",
		);
	});

	it("is closed when the compute sidecar is another device, or fails to start", async () => {
		const d = fakeDevice();
		compute.device = fakeDevice();
		expect(await lookBridgeGate(d)).toMatch(/not the render device/);
		compute.reject = true;
		expect(await lookBridgeGate(d)).toMatch(/not the render device/);
		compute.reject = false;
		compute.device = null;
		expect(await lookBridgeGate(d)).toMatch(/not the render device/);
	});
});

describe("createLookBridge", () => {
	it("returns a bridge when open", async () => {
		const d = fakeDevice();
		compute.device = d;
		const onOff = vi.fn();
		const b = await createLookBridge(d, onOff);
		expect(b).toBeInstanceOf(LookBridge);
		expect(b?.device).toBe(d);
		expect(onOff).not.toHaveBeenCalled();
		b?.destroy();
	});

	it("returns null and reports the reason when gated off (callback optional)", async () => {
		const d = fakeDevice({ type: "webgl" });
		const onOff = vi.fn();
		expect(await createLookBridge(d, onOff)).toBeNull();
		expect(onOff).toHaveBeenCalledWith("not a WebGPU device");
		expect(await createLookBridge(d)).toBeNull();
	});
});

describe("LookBridge state", () => {
	it("wantsStats needs a positive amount and a key it has not computed", () => {
		const b = new LookBridge(fakeDevice());
		expect(b.wantsStats(0, "k")).toBe(false);
		expect(b.wantsStats(-1, "k")).toBe(false);
		expect(b.wantsStats(0.5, "k")).toBe(true);
		b.destroy();
	});

	it("starts empty, with fusion on and no height source", () => {
		const b = new LookBridge(fakeDevice());
		expect(b.masks).toBeNull();
		expect(b.stats).toBeNull();
		expect(b.version).toBe(0);
		expect(b.fusionOn()).toBe(true);
		expect(b.heightSource).toBeNull();
		expect(b.fused).toEqual({
			masksPrepared: 0,
			masksAdopted: 0,
			statsEncoded: 0,
		});
		b.destroy();
	});
});
