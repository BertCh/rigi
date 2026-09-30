// The one submit for core/** users: finishes the encoder, submits it, then lets the pool destroy
// grown-out buffers and the profiler collect pass timestamps. Use it instead of
// device.submit(enc.finish()) wherever pooled buffers or profiled passes were recorded.
//
// Error checks (opt-in, `globalThis.__RIGI_GPU_CHECKS__ = true`, read live per realm; workers get it
// through core/realm.ts): WebGPU reports validation and out-of-memory errors asynchronously, so a
// broken kernel (bad WGSL, a wrong binding, an allocation that failed) otherwise "succeeds" and the
// readback returns whatever the output buffer held (zeros). With checks on, submit() wraps
// finish + submit in 'validation' and 'out-of-memory' error scopes; encoder errors (invalid
// pipelines, bind groups and buffers used by the passes) surface at finish(), so this one scope
// covers the dispatches recorded on `enc`. The staged readbacks of `enc` (core/readback.ts, which
// ComputeGraph.run uses too) then REJECT with GpuValidationError, and callers take their CPU path.
// Cost: two push/pop pairs per submit; the pops settle on the device timeline, in parallel with the
// map, so the readback does not wait longer (core-selftest "error-checks-cost").
import type { CommandEncoder, Device } from "@luma.gl/core";
import { GpuDeviceLostError, touch } from "./lifecycle";
import { afterSubmit as poolAfterSubmit } from "./pool";
import { afterSubmit as profileAfterSubmit } from "./profile";

/** A WebGPU validation / out-of-memory error raised by a checked submit. */
export class GpuValidationError extends Error {
	constructor(
		readonly kind: "validation" | "out-of-memory",
		message: string,
		id?: string,
	) {
		super(`[gpu] ${kind} error in ${id ?? "submit"}: ${message}`);
		this.name = "GpuValidationError";
	}
}

/** Whether submits in this realm are wrapped in error scopes. */
export const errorChecks = () => globalThis.__RIGI_GPU_CHECKS__ === true;

type RawDevice = {
	pushErrorScope: (f: "validation" | "out-of-memory") => void;
	popErrorScope: () => Promise<{ message: string } | null>;
};

const checks = new WeakMap<CommandEncoder, Promise<void>>();
const OK = Promise.resolve();
/** Staged reads of an encoder not yet submitted (core/readback.ts), cancelled if submit throws. */
const staged = new WeakMap<CommandEncoder, (() => void)[]>();

/** Run `cancel` if `enc`'s core submit() throws (a lost device, a finish error). */
export function cancelIfSubmitFails(enc: CommandEncoder, cancel: () => void) {
	const list = staged.get(enc);
	if (list) list.push(cancel);
	else staged.set(enc, [cancel]);
}

function failed(enc: CommandEncoder) {
	const list = staged.get(enc);
	staged.delete(enc);
	for (const c of list ?? []) c();
}

/**
 * Finish `enc` and submit it on `device`'s queue. Throws GpuDeviceLostError on a lost device (so a
 * caller in flight falls back to the CPU instead of reading a buffer nothing will write). When it
 * throws, the reads staged on `enc` are cancelled (their slots returned), so a caller that does not
 * cancel() them itself leaks nothing.
 */
export function submit(device: Device, enc: CommandEncoder): void {
	if (device.isLost) {
		failed(enc);
		throw new GpuDeviceLostError("submit");
	}
	touch();
	try {
		finishAndSubmit(device, enc);
	} catch (e) {
		failed(enc);
		throw e;
	}
	staged.delete(enc);
	poolAfterSubmit(device);
	profileAfterSubmit(device);
}

function finishAndSubmit(device: Device, enc: CommandEncoder) {
	const raw =
		errorChecks() && device.type === "webgpu"
			? (device as unknown as { handle: RawDevice }).handle
			: null;
	if (raw) {
		raw.pushErrorScope("out-of-memory");
		raw.pushErrorScope("validation");
		try {
			device.submit(enc.finish());
		} finally {
			const v = raw.popErrorScope();
			const m = raw.popErrorScope();
			const id = (enc as { id?: string }).id;
			const p = Promise.all([v, m]).then(([ve, me]) => {
				if (ve) throw new GpuValidationError("validation", ve.message, id);
				if (me) throw new GpuValidationError("out-of-memory", me.message, id);
			});
			p.catch(() => {});
			checks.set(enc, p);
		}
	} else device.submit(enc.finish());
}

/**
 * Resolves once `enc`'s submit passed its error checks, rejects with GpuValidationError if it did
 * not (resolved at once when checks were off or `enc` was not submitted through core submit()).
 * core/readback.ts awaits this for every staged read; use it where outputs stay on the GPU.
 */
export const submitted = (enc: CommandEncoder): Promise<void> =>
	checks.get(enc) ?? OK;
