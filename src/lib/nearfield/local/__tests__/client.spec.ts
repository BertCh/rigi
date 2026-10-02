// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
	device: null as object | null,
	nnOk: true,
}));
vi.mock("#/lib/gpu/device", () => ({
	getComputeDevice: async () => env.device,
}));
vi.mock("#/lib/nn", () => ({
	createNn: async () => {
		if (!env.nnOk) throw new Error("no GPU backend");
		return { backend: { kind: "gpu" } };
	},
}));

import { LocalNearFieldClient } from "../client";

beforeEach(() => {
	env.device = null;
	env.nnOk = true;
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

describe("LocalNearFieldClient availability (= models loadable on WebGPU)", () => {
	it("is unavailable without a WebGPU compute device", async () => {
		const c = new LocalNearFieldClient();
		expect(await c.available()).toBe(false);
		expect((await c.health()).device).toBe("");
	});

	it("is available with a device, the nn GPU backend and reachable weights", async () => {
		env.device = {};
		const c = new LocalNearFieldClient();
		expect(await c.available()).toBe(true);
		expect(fetch).toHaveBeenCalledWith(
			expect.stringMatching(
				/models\/moge2-vits-normal\.[0-9a-f]{8}\.safetensors$/,
			),
			{ method: "HEAD" },
		);
	});

	it("is unavailable when the weights are not served or the GPU backend is missing", async () => {
		env.device = {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 404 })),
		);
		expect(await new LocalNearFieldClient().available()).toBe(false);
		env.device = {};
		env.nnOk = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 200 })),
		);
		expect(await new LocalNearFieldClient().available()).toBe(false);
	});
});
