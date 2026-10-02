// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
	device: null as object | null,
	nnOk: true,
	fetchModel: null as null | ((file: string) => Promise<ArrayBuffer>),
}));
vi.mock("#/lib/models", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/lib/models")>()),
	fetchModel: (file: string) =>
		env.fetchModel ? env.fetchModel(file) : Promise.reject(new Error("off")),
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
import { MOGE2_WEIGHTS } from "../depth-net";

beforeEach(() => {
	env.device = null;
	env.nnOk = true;
	env.fetchModel = null;
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
			expect.stringMatching(/models\/moge2-vits-q8\.[0-9a-f]{8}\.safetensors$/),
			{ method: "HEAD" },
		);
	});

	it("picks the weights file from the constructor, else the nearfieldWeights flag (q8)", () => {
		expect(new LocalNearFieldClient().weightsFile).toBe(MOGE2_WEIGHTS.q8);
		expect(new LocalNearFieldClient({ weights: "fp16" }).weightsFile).toBe(
			MOGE2_WEIGHTS.fp16,
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

describe("LocalNearFieldClient prefetch", () => {
	it("fetches the chosen weights and marks them reachable without a HEAD", async () => {
		env.device = {};
		const files: string[] = [];
		env.fetchModel = async (file) => {
			files.push(file);
			return new ArrayBuffer(8);
		};
		const c = new LocalNearFieldClient({ weights: "q8lite" });
		expect(await c.prefetch()).toBe(true);
		expect(files).toEqual([MOGE2_WEIGHTS.q8lite]);
		expect(await c.available()).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("resolves false when the download fails", async () => {
		env.fetchModel = async () => {
			throw new Error("offline");
		};
		expect(await new LocalNearFieldClient().prefetch()).toBe(false);
	});
});
