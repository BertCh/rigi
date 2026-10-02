// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The app's one raw WebGPU adapter request. luma creates its own adapter inside
// webgpuAdapter.create(), but the app needs an adapter's features, limits and info BEFORE creating a
// device (renderer-select's engine probe, the render device's and the compute sidecar's
// requiredLimits at the adapter maximum) and luma has no public peek: @luma.gl/webgpu exports the
// WebGPUAdapter class as a type only and its requestGPUAdapter is protected. Dependency-free on
// purpose (renderer-select must not pull the WebGPU chunk). Replace with a luma peek when one ships.

/** navigator.gpu, or undefined where WebGPU is missing (and outside a browser / worker). */
export function navigatorGpu(): GPU | undefined {
	return (globalThis.navigator as { gpu?: GPU } | undefined)?.gpu;
}

/** A fresh adapter for `options` (null when WebGPU is missing or no adapter is granted). May throw like requestAdapter. */
export async function peekWebGPUAdapter(
	options?: GPURequestAdapterOptions,
): Promise<GPUAdapter | null> {
	const gpu = navigatorGpu();
	return gpu ? await gpu.requestAdapter(options) : null;
}

/** The adapter's numeric limits for `keys` (keys it does not report are left out). */
export function adapterLimits<K extends string>(
	adapter: GPUAdapter,
	keys: readonly K[],
): Partial<Record<K, number>> {
	const limits = adapter.limits as unknown as Record<string, unknown>;
	const out: Partial<Record<K, number>> = {};
	for (const k of keys) {
		const v = limits[k];
		if (typeof v === "number") out[k] = v;
	}
	return out;
}
