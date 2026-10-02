// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The look-pass selector (W5). The GPU twin runs whenever opt-in.ts lookGpuOn() (compute sidecar not
// killed, WebGPU present); the CPU look passes (look/**) are the reference and the fallback. With the
// GPU off, selectLook returns null and the caller keeps its synchronous CPU path unchanged.
import type { Device } from "@luma.gl/core";
import { getComputeDevice } from "../device";
import { lookGpuOn } from "./opt-in";

export { lookGpuOn };

/**
 * GPU off: null. GPU on: a promise of the GPU result, falling back to `cpu()` when there is no
 * device or the kernel throws (warned once per pass name).
 */
export function selectLook<T>(
	name: string,
	cpu: () => T,
	gpu: (device: Device) => Promise<T>,
): Promise<T> | null {
	if (!lookGpuOn()) return null;
	return (async () => {
		const device = await getComputeDevice();
		if (device)
			try {
				return await gpu(device);
			} catch (e) {
				if (!warned.has(name)) {
					warned.add(name);
					console.warn(`[lookgpu] ${name} failed, using the CPU`, e);
				}
			}
		return cpu();
	})();
}
const warned = new Set<string>();
