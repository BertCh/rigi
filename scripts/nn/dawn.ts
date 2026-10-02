// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node-only: a luma WebGPU device over Dawn (the `webgpu` npm package installed in DAWN_DIR, not an
// app dependency), for nn's parity checks and benches. null when DAWN_DIR is unset or there is no
// adapter (callers SKIP). Same setup as scripts/gpu/*-dawn.ts.

import type { Device } from "@luma.gl/core";

export async function dawnDevice(id = "nn-dawn"): Promise<Device | null> {
	const dir = process.env.DAWN_DIR;
	if (!dir) return null;
	const path = await import("node:path");
	const { pathToFileURL } = await import("node:url");
	const { create, globals } = await import(
		pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
	);
	Object.assign(globalThis, globals);
	// keep the instance referenced: Dawn drops pipelines of a collected instance
	const gpu = create([]);
	(globalThis as { __nnDawn?: unknown }).__nnDawn = gpu;
	Object.defineProperty(globalThis, "navigator", {
		value: { gpu, userAgent: "node" },
		configurable: true,
	});
	const adapter = await gpu.requestAdapter();
	if (!adapter) return null;
	const { COMPUTE_FEATURES } = await import("../../src/lib/gpu/device");
	const { attachWebGPUDevice } = await import("../../src/lib/gpu/core/luma");
	const limits: Record<string, number> = {};
	for (const k of [
		"maxStorageBufferBindingSize",
		"maxBufferSize",
		"maxComputeWorkgroupStorageSize",
		"maxStorageBuffersPerShaderStage",
	])
		limits[k] = adapter.limits[k];
	const handle = await adapter.requestDevice({
		requiredFeatures: COMPUTE_FEATURES.filter((f: string) =>
			adapter.features.has(f),
		),
		requiredLimits: limits,
	});
	return (await attachWebGPUDevice(handle, { id }, true)) as Device;
}
