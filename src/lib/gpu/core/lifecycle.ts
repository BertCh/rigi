// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Device-loss and activity bookkeeping shared by the core modules (no luma runtime imports, so the
// registry, pool, readback and queue can all use it without import cycles):
// - untilLost(device, p): p, but rejecting as soon as `device` is lost. Readbacks, timestamp reads
//   and async pipeline builds go through it, so a caller in flight when the device dies rejects
//   (and falls back to its CPU twin) instead of waiting on a promise that may never settle.
// - onLost(device, fn): run fn once when `device` is lost (one listener per device, not per call).
// - busy()/idle(): the registry's idle release (gpu/device.ts releaseWhenIdle) must not destroy a
//   device while a lease is held or a readback is in flight.
import type { Device } from "@luma.gl/core";

declare global {
	/** core/queue.ts error checks (opt-in, per realm) */
	var __RIGI_GPU_CHECKS__: boolean | undefined;
}

/** Error for work that was in flight (or started) on a lost device. */
export class GpuDeviceLostError extends Error {
	constructor(what = "GPU work") {
		super(`[gpu] ${what}: the compute device was lost`);
		this.name = "GpuDeviceLostError";
	}
}

const hooks = new WeakMap<Device, (() => void)[]>();
/** Devices whose lost promise has fired (their hooks ran; later ones run at once). */
const fired = new WeakSet<Device>();
const rejections = new WeakMap<Device, Promise<never>>();

function runHook(f: () => void) {
	try {
		f();
	} catch (e) {
		console.warn("[gpu] device-lost hook failed", e);
	}
}

/** Run `fn` once when `device` is lost (at once, in a microtask, if it already is). */
export function onLost(device: Device, fn: () => void): void {
	if (fired.has(device)) {
		queueMicrotask(() => runHook(fn));
		return;
	}
	let list = hooks.get(device);
	if (!list) {
		const created: (() => void)[] = [];
		hooks.set(device, created);
		device.lost.then(() => {
			fired.add(device);
			hooks.delete(device);
			for (const f of created.splice(0)) runHook(f);
		});
		list = created;
	}
	list.push(fn);
}

/** A promise that rejects with GpuDeviceLostError when `device` is lost (never resolves). */
function lostRejection(device: Device): Promise<never> {
	let r = rejections.get(device);
	if (!r) {
		r = device.lost.then(() => {
			throw new GpuDeviceLostError();
		});
		r.catch(() => {});
		rejections.set(device, r);
	}
	return r;
}

/** `p`, rejecting with GpuDeviceLostError as soon as `device` is lost (or at once if it is). */
export function untilLost<T>(device: Device, p: Promise<T>): Promise<T> {
	if (device.isLost) {
		p.catch(() => {});
		return Promise.reject(new GpuDeviceLostError());
	}
	return Promise.race([p, lostRejection(device)]);
}

// ---- activity, for the idle release ----

let inflight = 0;
let last = 0;
const now = () => globalThis.performance?.now() ?? Date.now();

/** Note GPU use (a submit, a getComputeDevice call). */
export const touch = () => {
	last = now();
};
/** Bracket work that must keep the device alive (a lease, a staged readback). */
export const busy = () => {
	inflight++;
	last = now();
};
export const done = () => {
	inflight = Math.max(0, inflight - 1);
	last = now();
};
/** Milliseconds since the last GPU use; 0 while anything is in flight. */
export const idleFor = () => (inflight ? 0 : now() - last);

export { abortable, isAbortError } from "./abort";
