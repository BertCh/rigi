// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// One shared, bucketed free pool of GPU buffers per device. Owners that cycle many short-lived
// buffers (core/pool.ts named slots that grow, the nn runtime's tensors) take from and hand back to
// it, so a buffer one owner is done with serves the next owner of the same usage and size class
// instead of being destroyed and re-created, and the idle bytes are visible, capped and purgeable
// in one place (core/memory.ts).
// Not luma's @luma.gl/gpgpu buffer-pool: that one is internal (not exported from the package), has
// one fixed usage, best-fit unbucketed reuse, is a singleton shared with luma's own ops and counts
// no bytes.
//
// Buckets: power-of-two capacity (capacityFor, min 256 B) per exact usage mask. A taken buffer is at
// least as large as asked and holds whatever its previous owner left: zero it if you rely on zeros.
//
// QUEUE-SAFETY CONTRACT. recycleBuffer(device, b) is legal only once every command that uses `b` has
// been SUBMITTED (queue.submit; a queue.writeBuffer already counts). Queue order then guarantees that
// a later owner's writes (queue.writeBuffer or a later submit) land after the old owner's reads and
// writes. A caller whose work is still recorded but unsubmitted must delay the hand-back until after
// its submit (nn/gpu/runtime.ts does it behind its own queue chain). Never recycle a buffer that is
// bound in an encoder you have not submitted, mapped, or still referenced by the owner.
//
// Idle buffers are capped per device (IDLE_CAP_BYTES by default): over the cap the oldest idle
// buffers are destroyed on recycle. purgeBuffers() drops them on demand (memory pressure), and
// everything is dropped when the device is lost.
import type { Buffer, Device } from "@luma.gl/core";
import { onLost } from "./lifecycle";
import { registerPurger, watchOutOfMemory } from "./oom";

/** Default cap on idle (free) bytes per device. */
export const IDLE_CAP_BYTES = 256 * 1024 * 1024;

export type BufferPoolStats = {
	/** bytes of buffers taken and not yet recycled */
	liveBytes: number;
	/** bytes of free buffers waiting in buckets */
	idleBytes: number;
	idleBuffers: number;
};

type State = {
	/** bucket key (`usage|capacity`) → free buffers (most recently recycled last) */
	buckets: Map<string, Buffer[]>;
	/** free buffers, oldest first (insertion order), with their bucket key */
	idle: Map<Buffer, string>;
	/** taken buffers and their bucket key */
	/** taken buffers (weak: an owner that destroys one instead of recycling it leaks no reference) */
	live: WeakMap<Buffer, string>;
	liveBytes: number;
	idleBytes: number;
	idleCap: number;
};

const states = new WeakMap<Device, State>();
const known = new Set<WeakRef<Device>>();

/** Capacity for `bytes`: the next power of two, at least 256 (4-byte aligned for WebGPU). */
export const capacityFor = (bytes: number) =>
	2 ** Math.ceil(Math.log2(Math.max(256, bytes)));

function stateOf(device: Device): State {
	let s = states.get(device);
	if (!s) {
		const created: State = {
			buckets: new Map(),
			idle: new Map(),
			live: new WeakMap(),
			liveBytes: 0,
			idleBytes: 0,
			idleCap: IDLE_CAP_BYTES,
		};
		states.set(device, created);
		const ref = new WeakRef(device);
		known.add(ref);
		watchOutOfMemory(device);
		onLost(device, () => {
			// idle buffers are ours to destroy; live ones belong to their owners (who drop them on loss)
			for (const b of created.idle.keys()) b.destroy();
			created.buckets.clear();
			created.idle.clear();
			created.live = new WeakMap();
			created.liveBytes = created.idleBytes = 0;
			states.delete(device);
			known.delete(ref);
		});
		s = created;
	}
	return s;
}

/**
 * A buffer of `usage` with at least `byteLength` bytes (capacity = next power of two, min 256), reused
 * from the device's free pool when one of that bucket is idle. Contents are undefined when reused.
 * `fresh`: always a new (zeroed) buffer, still tracked and recyclable (core/pool.ts named slots,
 * whose first use may rely on WebGPU's zero-initialised buffers).
 */
export function takeBuffer(
	device: Device,
	byteLength: number,
	usage: number,
	id = "pool-buffer",
	opts: { fresh?: boolean } = {},
): Buffer {
	const s = stateOf(device);
	const capacity = capacityFor(byteLength);
	const key = `${usage}|${capacity}`;
	let b = opts.fresh ? undefined : s.buckets.get(key)?.pop();
	if (b) {
		s.idle.delete(b);
		s.idleBytes -= capacity;
	} else b = device.createBuffer({ id, usage, byteLength: capacity });
	s.live.set(b, key);
	s.liveBytes += capacity;
	return b;
}

/**
 * Hand `buffer` back to its bucket. Only legal once every command using it was submitted (see the
 * queue-safety contract above). A buffer that did not come from takeBuffer, or one already idle, is
 * left alone (the former is destroyed: nothing else owns it); on a lost device it is destroyed.
 */
export function recycleBuffer(device: Device, buffer: Buffer): void {
	const s = states.get(device);
	if (!s || device.isLost) {
		buffer.destroy();
		return;
	}
	if (s.idle.has(buffer)) return;
	const key = s.live.get(buffer);
	if (key === undefined) {
		buffer.destroy();
		return;
	}
	s.live.delete(buffer);
	s.liveBytes -= buffer.byteLength;
	let list = s.buckets.get(key);
	if (!list) {
		list = [];
		s.buckets.set(key, list);
	}
	list.push(buffer);
	s.idle.set(buffer, key);
	s.idleBytes += buffer.byteLength;
	if (s.idleBytes > s.idleCap) trim(s, s.idleCap);
}

/** Destroy idle buffers, oldest first, until at most `keepBytes` idle bytes remain. */
function trim(s: State, keepBytes: number) {
	for (const [b, key] of s.idle) {
		if (s.idleBytes <= keepBytes) break;
		s.idle.delete(b);
		s.idleBytes -= b.byteLength;
		const list = s.buckets.get(key);
		if (list) {
			list.splice(list.indexOf(b), 1);
			if (!list.length) s.buckets.delete(key);
		}
		b.destroy();
	}
}

/**
 * Destroy idle buffers of `device` (every device when omitted), oldest first, until at most
 * `keepBytes` (default 0) idle bytes remain. Live buffers are untouched.
 */
export function purgeBuffers(
	device?: Device,
	opts: { keepBytes?: number } = {},
): void {
	const keep = opts.keepBytes ?? 0;
	if (device) {
		const s = states.get(device);
		if (s) trim(s, keep);
		return;
	}
	for (const ref of known) {
		const d = ref.deref();
		const s = d && states.get(d);
		if (s) trim(s, keep);
		else known.delete(ref);
	}
}

/** Per-device idle cap in bytes (default IDLE_CAP_BYTES); lowering it trims at once. */
export function setBufferIdleCap(device: Device, bytes: number): void {
	const s = stateOf(device);
	s.idleCap = Math.max(0, bytes);
	if (s.idleBytes > s.idleCap) trim(s, s.idleCap);
}

export function bufferPoolStats(device: Device): BufferPoolStats {
	const s = states.get(device);
	return {
		liveBytes: s?.liveBytes ?? 0,
		idleBytes: s?.idleBytes ?? 0,
		idleBuffers: s?.idle.size ?? 0,
	};
}

registerPurger((device) => purgeBuffers(device));
