// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The nn GPU runtime per (compute device, consumer). Every app consumer of src/lib/nn (people masks,
// the sky model, ALIKED / LightGlue, …) gets its runtime here instead of calling createNn itself:
// - GPU only: null without a live WebGPU compute device (no CPU nn forward on the page's thread).
// - Device loss: the entry of a lost device is dropped (gpu/core lifecycle onLost), so the next call
//   resolves the new compute device and builds a fresh runtime. Consumers cache their weights by the
//   returned Nn (`perNn`), so they follow automatically.
// - One runtime per consumer, with its own cachedGraph group `nn/<consumer>` (nn/gpu/runtime.ts): one
//   consumer's graphs never evict another's.

import type { Device } from "@luma.gl/core";
import type { Nn } from "./types";

type Entry = Map<string, Promise<Nn | null>>;
const runtimes = new WeakMap<Device, Entry>();

/** The cachedGraph group of a consumer's forward graphs. */
export const nnGraphGroup = (consumer: string) => `nn/${consumer}`;

/**
 * The nn GPU runtime of `consumer` on `device` (default: getComputeDevice(), the adopted render device
 * or the sidecar). Null when there is no live WebGPU device or the runtime cannot be created. Cached
 * until the device is lost.
 */
export async function getNn(
	consumer: string,
	device?: Device | null,
): Promise<Nn | null> {
	if (device === undefined) {
		const { getComputeDevice } = await import("#/lib/gpu/device");
		device = await getComputeDevice();
	}
	if (!device || device.type !== "webgpu" || device.isLost) return null;
	let entry = runtimes.get(device);
	if (!entry) {
		const created: Entry = new Map();
		entry = created;
		runtimes.set(device, created);
		const { onLost } = await import("#/lib/gpu/core/lifecycle");
		onLost(device, () => {
			if (runtimes.get(device) === created) runtimes.delete(device);
		});
	}
	let nn = entry.get(consumer);
	if (!nn) {
		const forDevice = device;
		nn = import("./gpu/gpu-nn")
			.then(
				({ GpuNn }): Nn =>
					new GpuNn(forDevice, { graphGroup: nnGraphGroup(consumer) }),
			)
			.catch((e) => {
				console.warn(`[nn] no GPU runtime for ${consumer}`, e);
				return null;
			});
		entry.set(consumer, nn);
		// a failed creation is not cached: the next call retries
		const settled = nn;
		const cache = entry;
		void settled.then((v) => {
			if (!v && cache.get(consumer) === settled) cache.delete(consumer);
		});
	}
	return nn;
}

/**
 * A per-runtime memo: `of(nn)` builds `make(nn)` once per Nn (weights, bound nets). A runtime dropped
 * after a device loss takes its value with it; a rejected build is forgotten so the next call retries.
 */
export function perNn<T>(make: (nn: Nn) => Promise<T>): (nn: Nn) => Promise<T> {
	const memo = new WeakMap<Nn, Promise<T>>();
	return (nn) => {
		let p = memo.get(nn);
		if (!p) {
			const built = make(nn);
			p = built;
			memo.set(nn, built);
			built.catch(() => {
				if (memo.get(nn) === built) memo.delete(nn);
			});
		}
		return p;
	};
}
