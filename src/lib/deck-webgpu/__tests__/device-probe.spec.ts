// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device } from "@luma.gl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RAISED_LIMITS } from "#/lib/gpu/core/device";
import {
	assertRequiredFeatures,
	deckBuild,
	IMPLICIT_MAX_FEATURES,
	OPTIONAL_FEATURES,
	REQUIRED_FEATURES,
	renderRequiredLimits,
	webgpuAvailable,
} from "../device";

type Adapter = {
	features: Set<string>;
	limits?: Record<string, unknown>;
	info?: Record<string, string>;
};

function stubGpu(
	requestAdapter: (opts: unknown) => Promise<Adapter | null> | Adapter | null,
) {
	vi.stubGlobal("navigator", {
		gpu: { requestAdapter: vi.fn(requestAdapter) },
	});
	return (
		navigator as unknown as {
			gpu: { requestAdapter: ReturnType<typeof vi.fn> };
		}
	).gpu.requestAdapter;
}

afterEach(() => vi.unstubAllGlobals());

describe("webgpuAvailable decision table", () => {
	it("no navigator.gpu -> not ok, names the API", async () => {
		vi.stubGlobal("navigator", {});
		const r = await webgpuAvailable();
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.reason).toMatch(/navigator\.gpu/);
	});

	it("null adapter -> blocklisted / disabled reason", async () => {
		stubGpu(() => null);
		const r = await webgpuAvailable();
		expect(r).toMatchObject({ ok: false });
		expect(r.ok === false && r.reason).toMatch(/no adapter/);
	});

	it("an adapter missing float32-filterable is refused with the feature named", async () => {
		stubGpu(() => ({ features: new Set(["timestamp-query"]) }));
		const r = await webgpuAvailable();
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.reason).toContain("float32-filterable");
	});

	it("a capable adapter is ok and reports vendor / architecture / description", async () => {
		const req = stubGpu(() => ({
			features: new Set(REQUIRED_FEATURES),
			info: { vendor: "apple", architecture: "metal-3", description: "M2" },
		}));
		const r = await webgpuAvailable();
		expect(r).toEqual({ ok: true, adapter: "apple metal-3 M2" });
		expect(req).toHaveBeenCalledWith({ powerPreference: "high-performance" });
	});

	it("missing adapter info degrades to a placeholder, never throws", async () => {
		stubGpu(() => ({ features: new Set(REQUIRED_FEATURES) }));
		expect(await webgpuAvailable()).toEqual({ ok: true, adapter: "?" });
	});

	it("a throwing requestAdapter becomes a reason string", async () => {
		stubGpu(() => {
			throw new Error("gpu process crashed");
		});
		const r = await webgpuAvailable();
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.reason).toBe(
			"requestAdapter failed: gpu process crashed",
		);
	});
});

describe("renderRequiredLimits", () => {
	it("asks for a core-level adapter and keeps only numeric raised limits", async () => {
		const limits: Record<string, unknown> = {
			maxTextureArrayLayers: 2048,
			ignored: 5,
		};
		for (const k of RAISED_LIMITS) limits[k] = 1234;
		const req = stubGpu(() => ({ features: new Set(), limits }));
		limits[RAISED_LIMITS[0]] = "not-a-number";
		const out = await renderRequiredLimits();
		expect(req).toHaveBeenCalledWith({
			powerPreference: "high-performance",
			featureLevel: "core",
		});
		expect(out.maxTextureArrayLayers).toBe(2048);
		expect(out.ignored).toBeUndefined();
		expect(RAISED_LIMITS[0] in out).toBe(false);
		for (const k of RAISED_LIMITS.slice(1)) expect(out[k]).toBe(1234);
	});

	it("is empty without WebGPU, without an adapter, or when the request throws", async () => {
		vi.stubGlobal("navigator", {});
		expect(await renderRequiredLimits()).toEqual({});
		stubGpu(() => null);
		expect(await renderRequiredLimits()).toEqual({});
		stubGpu(() => {
			throw new Error("x");
		});
		expect(await renderRequiredLimits()).toEqual({});
	});
});

describe("assertRequiredFeatures", () => {
	const dev = (features: string[]) =>
		({ features: new Set(features) }) as unknown as Device;
	it("passes with every required feature and throws naming the missing ones", () => {
		expect(() =>
			assertRequiredFeatures(dev([...REQUIRED_FEATURES])),
		).not.toThrow();
		expect(() => assertRequiredFeatures(dev([]))).toThrow(/float32-filterable/);
	});
});

describe("feature tables", () => {
	it("every required feature is also requested, and the lists do not overlap", () => {
		for (const f of REQUIRED_FEATURES) expect(OPTIONAL_FEATURES).toContain(f);
		for (const f of IMPLICIT_MAX_FEATURES)
			expect(OPTIONAL_FEATURES as readonly string[]).not.toContain(f);
		expect(new Set(IMPLICIT_MAX_FEATURES).size).toBe(
			IMPLICIT_MAX_FEATURES.length,
		);
	});
});

describe("deckBuild", () => {
	it("is a build tag (the vitest resolution carries the full build's WGSL source or none)", () => {
		expect(["full", "webgl-only"]).toContain(deckBuild());
	});
});
