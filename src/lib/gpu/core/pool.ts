// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Persistent grow-only buffer pool, per device. A kernel module names its buffers once
// ("look-relief/dem", "horizon/rays", …) and gets the same Buffer back on every call, so warm calls
// allocate nothing. Capacity grows by powers of two (min 256 B) and never shrinks; everything is
// destroyed when the device is lost (or releasePool is called).
//
// Pooled buffers are shared state, so two async callers must not use one slot at the same time:
// wrap the whole acquire → encode → submit → read sequence in withLease(owner, fn). Leases are a
// per-key FIFO mutex; a lease on "look-relief" covers every "look-relief/…" slot.
//
// Numerics: a pooled buffer is at least as large as asked (so bind `range(buf, bytes)` if the WGSL
// uses arrayLength()), and holds the previous call's bytes, so zero it (`zero: true` or clear())
// when a kernel relies on a fresh buffer being zero, as look/kernel.ts's storage(device, n) did.
import { Buffer, type CommandEncoder, type Device } from "@luma.gl/core";
import { busy, done as notBusy, onLost } from "./lifecycle";

type Entry = { buffer: Buffer; retired: Buffer[] };
type Pool = Map<string, Entry>;

const pools = new WeakMap<Device, Pool>();
const pooled = new WeakSet<Buffer>();

function poolOf(device: Device): Pool {
	let p = pools.get(device);
	if (!p) {
		const created: Pool = new Map();
		pools.set(device, created);
		onLost(device, () => destroyPool(device, created));
		p = created;
	}
	return p;
}

/** Capacity for `bytes`: the next power of two, at least 256 (4-byte aligned for WebGPU). */
export const capacityFor = (bytes: number) =>
	2 ** Math.ceil(Math.log2(Math.max(256, bytes)));

/**
 * The pooled buffer for (`key`, `usage`) with at least `byteLength` bytes. Same Buffer across
 * calls until a larger size is asked for; then a new power-of-two buffer replaces it (the old one
 * is destroyed when the current lease on `key` ends, or at the next core submit() if unleased).
 */
export function acquire(
	device: Device,
	key: string,
	byteLength: number,
	usage: number,
): Buffer {
	const pool = poolOf(device);
	const k = `${key}|${usage}`;
	let e = pool.get(k);
	if (e && e.buffer.byteLength >= byteLength) return e.buffer;
	const buffer = device.createBuffer({
		id: `pool:${key}`,
		usage,
		byteLength: capacityFor(byteLength),
	});
	pooled.add(buffer);
	if (e) {
		e.retired.push(e.buffer);
		e.buffer = buffer;
		markRetiring(device);
	} else {
		e = { buffer, retired: [] };
		pool.set(k, e);
	}
	return buffer;
}

export type UploadOptions = {
	/** Extra usage bits (STORAGE | COPY_DST | COPY_SRC is always set for storage). */
	usage?: number;
};

/**
 * A pooled storage buffer (STORAGE | COPY_DST | COPY_SRC) holding `data` (queue.writeBuffer, padded
 * to 4 bytes), or at least `bytes` bytes; `zero` (default true for a size) clears those bytes.
 */
export function pooledStorage(
	device: Device,
	key: string,
	data: ArrayBufferView | number,
	opts: UploadOptions & { zero?: boolean } = {},
): Buffer {
	const usage =
		Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC | (opts.usage ?? 0);
	if (typeof data === "number") {
		const bytes = Math.max(16, Math.ceil(data / 4) * 4);
		const b = acquire(device, key, bytes, usage);
		if (opts.zero ?? true) b.write(new Uint8Array(bytes));
		return b;
	}
	const bytes = Math.ceil(data.byteLength / 4) * 4;
	const b = acquire(device, key, Math.max(16, bytes), usage);
	writePadded(b, data);
	return b;
}

/** A pooled uniform buffer (UNIFORM | COPY_DST) holding `words`, zero-padded to 16 bytes. */
export function pooledUniform(
	device: Device,
	key: string,
	words: ArrayBuffer | ArrayBufferView,
): Buffer {
	const src = ArrayBuffer.isView(words)
		? new Uint8Array(words.buffer, words.byteOffset, words.byteLength)
		: new Uint8Array(words);
	const n = Math.max(16, Math.ceil(src.byteLength / 16) * 16);
	const b = acquire(device, key, n, Buffer.UNIFORM | Buffer.COPY_DST);
	const d = new Uint8Array(n);
	d.set(src);
	b.write(d);
	return b;
}

/** Write `data` at 0, padding a non-multiple-of-4 tail with zeros (WebGPU wants 4-byte writes). */
function writePadded(b: Buffer, data: ArrayBufferView) {
	if (data.byteLength % 4 === 0) {
		b.write(data);
		return;
	}
	// luma 10.0.0-alpha.2's WebGPUBuffer constructor ignores `props.byteOffset` when initialising from `data` (luma PR #3287), so never pass createBuffer({data, byteOffset}); copy into a 0-offset view as done here.
	const p = new Uint8Array(Math.ceil(data.byteLength / 4) * 4);
	p.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	b.write(p);
}

/** A binding of the first `bytes` of `buffer` (so WGSL arrayLength() sees `bytes`, not the pool capacity). */
export const range = (buffer: Buffer, bytes: number, offset = 0) => ({
	buffer,
	offset,
	size: Math.ceil(bytes / 4) * 4,
});

type RawEncoder = {
	clearBuffer: (b: unknown, offset?: number, size?: number) => void;
};

/** Record a zero-fill of `buffer` (whole, or `size` bytes at `offset`; both 4-byte multiples). */
export function clear(
	enc: CommandEncoder,
	buffer: Buffer,
	offset = 0,
	size?: number,
): void {
	// luma 9.4 has no CommandEncoder.clearBuffer; this is WebGPU-only code anyway
	const raw = (enc as unknown as { handle: RawEncoder }).handle;
	raw.clearBuffer(
		(buffer as unknown as { handle: unknown }).handle,
		offset,
		size ?? buffer.byteLength - offset,
	);
}

/** Whether `buffer` belongs to a pool (core/kernel.ts's release() skips those). */
export const isPooled = (buffer: Buffer) => pooled.has(buffer);

// ---- leases ----

const tails = new Map<string, Promise<void>>();
const active = new Set<string>();

/**
 * Run `fn` holding the lease on `key`: calls with the same key run one at a time, in call order.
 * Hold it across acquire → encode → submit → read of that key's slots. Rejections propagate to
 * the caller and release the lease. Not re-entrant: don't take the same key inside `fn`.
 */
export function withLease<T>(
	key: string,
	fn: () => Promise<T> | T,
): Promise<T> {
	const prev = tails.get(key) ?? Promise.resolve();
	let done!: () => void;
	const tail = new Promise<void>((r) => {
		done = r;
	});
	tails.set(key, tail);
	return prev.then(async () => {
		active.add(key);
		busy();
		try {
			return await fn();
		} finally {
			notBusy();
			active.delete(key);
			destroyRetired((k) => covers(key, k));
			if (tails.get(key) === tail) tails.delete(key);
			done();
		}
	});
}

const covers = (lease: string, slot: string) =>
	slot === lease || slot.startsWith(`${lease}/`);

const leased = (slot: string) => {
	for (const l of active) if (covers(l, slot)) return true;
	return false;
};

// devices with retired buffers pending (a WeakMap cannot be iterated)
const retiring = new Set<WeakRef<Device>>();

function destroyRetired(match: (slotKey: string) => boolean) {
	for (const ref of retiring) {
		const device = ref.deref();
		const pool = device && pools.get(device);
		if (!pool) {
			retiring.delete(ref);
			continue;
		}
		let left = false;
		for (const [k, e] of pool) {
			if (!e.retired.length) continue;
			const slot = k.slice(0, k.lastIndexOf("|"));
			if (!match(slot)) {
				left = true;
				continue;
			}
			for (const b of e.retired.splice(0)) b.destroy();
		}
		if (!left) retiring.delete(ref);
	}
}

/** @internal core/queue.ts: after a submit, destroy grown-out buffers of slots no lease holds. */
export function afterSubmit(device: Device) {
	const pool = pools.get(device);
	if (!pool) return;
	for (const [k, e] of pool) {
		if (!e.retired.length) continue;
		if (leased(k.slice(0, k.lastIndexOf("|")))) continue;
		for (const b of e.retired.splice(0)) b.destroy();
	}
}

function markRetiring(device: Device) {
	for (const r of retiring) if (r.deref() === device) return;
	retiring.add(new WeakRef(device));
}

function destroyPool(device: Device, pool: Pool) {
	for (const e of pool.values()) {
		e.buffer.destroy();
		for (const b of e.retired) b.destroy();
	}
	pool.clear();
	if (pools.get(device) === pool) pools.delete(device);
}

/** Destroy every pooled buffer of `device` whose key starts with `prefix` (all when omitted). */
export function releasePool(device: Device, prefix = ""): void {
	const pool = pools.get(device);
	if (!pool) return;
	for (const [k, e] of pool)
		if (k.startsWith(prefix)) {
			e.buffer.destroy();
			for (const b of e.retired) b.destroy();
			pool.delete(k);
		}
}

/** Pool size of `device`: slot count and bytes held (capacity, including retired buffers). */
export function poolStats(device: Device): { slots: number; bytes: number } {
	const pool = pools.get(device);
	let bytes = 0;
	if (pool)
		for (const e of pool.values()) {
			bytes += e.buffer.byteLength;
			for (const b of e.retired) bytes += b.byteLength;
		}
	return { slots: pool?.size ?? 0, bytes };
}
