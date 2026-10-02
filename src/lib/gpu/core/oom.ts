// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Out-of-memory response for the core memory owners (no luma runtime imports, so buffer-pool, readback,
// graph and queue can all use it without import cycles). Each owner registers a purger; an
// 'out-of-memory' error observed on a device runs them all (`purgeDeviceMemory`, re-exported by
// memory.ts). Two triggers:
// - core/queue.ts: a checked submit (`__RIGI_GPU_CHECKS__`) whose error scope reports "out-of-memory";
// - watchOutOfMemory(device): luma's WebGPUDevice turns the uncapturederror event into the public
//   Device.reportError(); wrapping that method once per device sees allocation failures that no error
//   scope covers (a createBuffer / createTexture that fails). No raw WebGPU API is touched.
import type { Device } from "@luma.gl/core";

type Purger = (device: Device, level: "full" | "half") => void;
const purgers: Purger[] = [];

/** Register a memory owner's purge step (module load time). */
export function registerPurger(purge: Purger): void {
	purgers.push(purge);
}

/** At most one purge per device per second: an OOM storm must not loop. */
const COOLDOWN_MS = 1000;
const lastPurge = new WeakMap<Device, number>();

/**
 * Give back everything cheap to rebuild on `device`: idle pooled buffers, idle readback slots and
 * cached graphs down to half the graph byte budget. Live named-pool slots and in-flight work stay.
 * Returns false when it was skipped by the cooldown.
 */
export function purgeDeviceMemory(
	device: Device,
	opts: { force?: boolean } = {},
): boolean {
	const t = globalThis.performance?.now() ?? Date.now();
	const prev = lastPurge.get(device);
	if (!opts.force && prev !== undefined && t - prev < COOLDOWN_MS) return false;
	lastPurge.set(device, t);
	for (const p of purgers) {
		try {
			p(device, "half");
		} catch (e) {
			console.warn("[gpu] memory purge step failed", e);
		}
	}
	return true;
}

const OOM =
	/out of memory|out-of-memory|\boom\b|failed to allocate|allocation (failed|of)/i;
export const isOutOfMemoryMessage = (message: string) => OOM.test(message);

const watched = new WeakSet<Device>();

/** Idempotent: purge `device`'s memory when luma reports an out-of-memory uncaptured error. */
export function watchOutOfMemory(device: Device): void {
	if (watched.has(device)) return;
	watched.add(device);
	const report = device.reportError;
	if (typeof report !== "function") return;
	device.reportError = (error: Error, context: unknown, ...args: unknown[]) => {
		if (isOutOfMemoryMessage(error?.message ?? ""))
			queueMicrotask(() => purgeDeviceMemory(device));
		return report.call(device, error, context, ...args);
	};
}
