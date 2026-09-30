// GPU → CPU readback through reusable MAP_READ staging slots, per device (the GPUReadbackRing
// pattern, but slots grow on demand because our readback sizes vary per call):
// - stageReads() records copies of the wanted ranges into ONE slot, packed, on the caller's
//   encoder (so they run after that encoder's passes); the caller submits once;
// - read() maps just the packed bytes, slices out one ArrayBuffer per range, returns the slot.
// No per-call staging allocation once warm, and never luma's readAsync on a non-mappable buffer
// (which creates and submits a temporary buffer + encoder per call).
// read() rejects when the encoder's checked submit failed (core/queue.ts error checks) and as soon
// as the device is lost (core/lifecycle.ts), so a failed or orphaned kernel never resolves zeros
// or hangs its caller (and the lease it holds).
import { Buffer, type CommandEncoder, type Device } from "@luma.gl/core";
import { busy, done, GpuDeviceLostError, onLost, untilLost } from "./lifecycle";
import { capacityFor } from "./pool";
import { cancelIfSubmitFails, submit, submitted } from "./queue";

/** `size` bytes of `buffer` from `offset` (a 4-byte multiple). */
export type ReadRange = { buffer: Buffer; offset?: number; size: number };

/**
 * Staged copies: call read() after submitting the encoder, or cancel() if it won't be (a core
 * submit() that throws cancels them itself).
 */
export type StagedRead = {
	read: () => Promise<ArrayBuffer[]>;
	/** Return the slot unread (only when the encoder was NOT submitted). */
	cancel: () => void;
};

type Slot = { buffer: Buffer; busy: boolean };

/** Idle slots kept per device; more are destroyed as reads finish. */
const MAX_IDLE = 4;
const rings = new WeakMap<Device, Slot[]>();

function ring(device: Device): Slot[] {
	let r = rings.get(device);
	if (!r) {
		const created: Slot[] = [];
		rings.set(device, created);
		onLost(device, () => {
			for (const s of created) {
				if (s.busy) {
					s.busy = false;
					done();
				}
				s.buffer.destroy();
			}
			created.length = 0;
			rings.delete(device);
		});
		r = created;
	}
	return r;
}

function reserve(device: Device, bytes: number): Slot {
	const r = ring(device);
	let best: Slot | null = null;
	for (const s of r)
		if (
			!s.busy &&
			s.buffer.byteLength >= bytes &&
			(!best || s.buffer.byteLength < best.buffer.byteLength)
		)
			best = s;
	if (!best) {
		// too small or all busy: replace the smallest idle slot, else add one
		let small = -1;
		for (let i = 0; i < r.length; i++)
			if (
				!r[i].busy &&
				(small < 0 || r[i].buffer.byteLength < r[small].buffer.byteLength)
			)
				small = i;
		best = {
			buffer: device.createBuffer({
				id: "core-readback-slot",
				usage: Buffer.MAP_READ | Buffer.COPY_DST,
				byteLength: capacityFor(bytes),
			}),
			busy: false,
		};
		if (small >= 0) r.splice(small, 1)[0].buffer.destroy();
		r.push(best);
	}
	best.busy = true;
	busy();
	return best;
}

function giveBack(device: Device, slot: Slot) {
	if (!slot.busy) return;
	slot.busy = false;
	done();
	const r = rings.get(device);
	if (!r || device.isLost) {
		slot.buffer.destroy();
		return;
	}
	const idle = r.filter((s) => !s.busy);
	if (idle.length > MAX_IDLE) {
		idle.sort((a, b) => a.buffer.byteLength - b.buffer.byteLength);
		const drop = idle[0];
		r.splice(r.indexOf(drop), 1);
		drop.buffer.destroy();
	}
}

/**
 * Record copies of `ranges` into one staging slot on `enc` (after whatever `enc` recorded so far).
 * Offsets must be 4-byte multiples; sizes are rounded up to 4 for the copy (the source must hold
 * those bytes; core buffers are always padded) but each result is exactly `size` bytes.
 */
export function stageReads(
	device: Device,
	enc: CommandEncoder,
	ranges: ReadRange[],
): StagedRead {
	const at: number[] = [];
	let total = 0;
	for (const { buffer, offset = 0, size } of ranges) {
		const n = Math.ceil(size / 4) * 4;
		if (offset % 4 || offset + n > buffer.byteLength)
			throw new Error(
				`readback range ${offset}+${size} (padded ${n}) is unaligned or outside ${buffer.id} (${buffer.byteLength} B)`,
			);
		at.push(total);
		total += n;
	}
	if (!total)
		return {
			read: async () => ranges.map(() => new ArrayBuffer(0)),
			cancel() {},
		};
	const slot = reserve(device, total);
	ranges.forEach(({ buffer, offset = 0, size }, i) => {
		if (size > 0)
			enc.copyBufferToBuffer({
				sourceBuffer: buffer,
				sourceOffset: offset,
				destinationBuffer: slot.buffer,
				destinationOffset: at[i],
				size: Math.ceil(size / 4) * 4,
			});
	});
	let used = false;
	const cancel = () => {
		if (used) return;
		used = true;
		giveBack(device, slot);
	};
	cancelIfSubmitFails(enc, cancel);
	return {
		read: async () => {
			if (used) throw new Error("readback already read or cancelled");
			used = true;
			// Raw mapAsync, not luma's mapAndReadAsync: that awaits queue.onSubmittedWorkDone() first,
			// so a read would also wait for everything submitted after this encoder (horizon's chunk
			// c+1). mapAsync alone resolves once the work using this slot is done. Offset 0 and a
			// 4-byte-multiple size meet its alignment rule (offset % 8, size % 4). `mapped` settles
			// only after unmap(), so the slot is never given back while mapped. Losing the device
			// aborts the map at once (AbortError): report that as the loss it is.
			const handle = (slot.buffer as unknown as { handle: GPUBuffer }).handle;
			const mapped = (async () => {
				await handle.mapAsync(1 /* GPUMapMode.READ */, 0, total);
				try {
					const view = handle.getMappedRange(0, total);
					return ranges.map(({ size }, i) => view.slice(at[i], at[i] + size));
				} finally {
					handle.unmap();
				}
			})().catch((e) => {
				throw device.isLost ? new GpuDeviceLostError("readback") : e;
			});
			let settled = false;
			try {
				const [out] = await untilLost(
					device,
					Promise.all([mapped, submitted(enc)]),
				);
				settled = true;
				return out;
			} finally {
				// a failed check (or loss) can beat the map: return the slot once the map is over
				const back = () => giveBack(device, slot);
				if (settled || device.isLost) back();
				else mapped.then(back, back);
			}
		},
		cancel,
	};
}

/**
 * Encode with `build`, stage `ranges` (or the ReadRange[] `build` returns) on the same encoder, submit
 * once, and resolve one ArrayBuffer per range.
 */
export async function readBack(
	device: Device,
	build: (enc: CommandEncoder) => unknown,
	ranges?: ReadRange[],
	opts: { id?: string } = {},
): Promise<ArrayBuffer[]> {
	const enc = device.createCommandEncoder({ id: opts.id ?? "core-readback" });
	const built = build(enc);
	const staged = stageReads(
		device,
		enc,
		ranges ?? (Array.isArray(built) ? (built as ReadRange[]) : []),
	);
	try {
		submit(device, enc);
	} catch (e) {
		staged.cancel();
		throw e;
	}
	return staged.read();
}

/** Staging slots of `device`: count, busy count and bytes held. */
export function readbackStats(device: Device): {
	slots: number;
	busy: number;
	bytes: number;
} {
	const r = rings.get(device) ?? [];
	let busy = 0;
	let bytes = 0;
	for (const s of r) {
		if (s.busy) busy++;
		bytes += s.buffer.byteLength;
	}
	return { slots: r.length, busy, bytes };
}
