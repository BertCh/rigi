// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The look-pass selector (W5). The CPU look passes (look/**) stay the default and the reference;
// a GPU twin runs only when opt-in.ts lookGpuOn() (opt-in set, compute sidecar not killed). With
// the flag off, selectLook returns null and the caller keeps its synchronous CPU path unchanged.
import type { Device } from "@luma.gl/core";
import { getComputeDevice } from "../device";
import { lookGpuOn } from "./opt-in";

export { lookGpuOn };

/**
 * Flag off: null. Flag on: a promise of the GPU result, falling back to `cpu()` when there is no
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
