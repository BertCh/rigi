// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU memory ledger of a device: what core owns (named pool slots, the shared free pool, cached
// graphs, readback staging) plus whatever other modules register (`registerDeviceBytes`: nn weights,
// DEM atlases, …). Bytes are capacities as allocated, not logical sizes. `purgeDeviceMemory` (also
// run on an out-of-memory error, see core/oom.ts) gives back the cheap-to-rebuild part.
import type { Device } from "@luma.gl/core";
import { bufferPoolStats } from "./buffer-pool";
import { cachedGraphBytes } from "./graph";
import { onLost } from "./lifecycle";
import { poolStats } from "./pool";
import { readbackStats } from "./readback";

export { purgeDeviceMemory } from "./oom";

export type DeviceBytes = {
	/** named pool slots (core/pool.ts), capacity incl. retired buffers */
	pool: number;
	/** shared free pool (core/buffer-pool.ts): bytes handed out and bytes idle */
	freePool: { live: number; idle: number };
	/** cached graphs: compiled physical transients + owned resources */
	graphs: number;
	/** readback staging slots */
	readback: number;
	/** modules' own providers (registerDeviceBytes), by name */
	registered: Record<string, number>;
	/**
	 * freePool.live + freePool.idle + graphs + readback + registered. `pool` is not added: the named
	 * slots are buffers taken from the shared pool, so they are already inside freePool.live.
	 */
	total: number;
};

const providers = new WeakMap<Device, Map<string, () => number>>();

/**
 * Report `bytes()` under `name` in deviceBytes(device) (e.g. "nn-weights", "dem-atlas"). Re-registering
 * a name replaces it. Returns an unregister function; providers are dropped when the device is lost.
 */
export function registerDeviceBytes(
	device: Device,
	name: string,
	bytes: () => number,
): () => void {
	let m = providers.get(device);
	if (!m) {
		const created = new Map<string, () => number>();
		providers.set(device, created);
		onLost(device, () => {
			created.clear();
			providers.delete(device);
		});
		m = created;
	}
	m.set(name, bytes);
	return () => {
		if (providers.get(device)?.get(name) === bytes)
			providers.get(device)?.delete(name);
	};
}

export function deviceBytes(device: Device): DeviceBytes {
	const pool = poolStats(device).bytes;
	const free = bufferPoolStats(device);
	const graphs = cachedGraphBytes(device);
	const readback = readbackStats(device).bytes;
	const registered: Record<string, number> = {};
	let reg = 0;
	for (const [name, f] of providers.get(device) ?? []) {
		let n = 0;
		try {
			n = f();
		} catch {
			// a provider of a destroyed owner reports nothing
		}
		registered[name] = n;
		reg += n;
	}
	return {
		pool,
		freePool: { live: free.liveBytes, idle: free.idleBytes },
		graphs,
		readback,
		registered,
		total: free.liveBytes + free.idleBytes + graphs + readback + reg,
	};
}
