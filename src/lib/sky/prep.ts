// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Worker side of the GPU prep (gpu/sky/prep.ts): when to use it, and the runtime guard.
 *
 * The prep (ImageBitmap → rgbLo, ORT's normalised input and the refine's RGBA guide, all on the
 * shared compute device) must equal the CPU chain bit for bit, because rgbLo is the refine's guide
 * and the refine is identity-gated. The kernels are checked in node against core.ts
 * (scripts/gpu/sky-prep-check.ts), but two things are only knowable per browser / driver / GPU: that
 * the compiled WGSL computes what the emulation does, and that the ImageBitmap's pixels are the
 * bytes getImageData returns. So the first PREP_VERIFY photos on each device run both paths and the
 * GPU buffers (RGBA bytes, rgbLo, input; compared in full, not a checksum — 3 × ~2.6 MB readback) are
 * compared with the CPU's. A mismatch disables the GPU prep for that device for the life of the
 * worker and that photo continues on its CPU results; repeated GPU errors disable it too.
 *
 * The prep needs ORT on the shared device (the input buffer is an ORT tensor), a hardware WebGPU
 * model session and a shape the kernels support (downsampling; limits). Anything else is the CPU path.
 */
import type { Device } from "@luma.gl/core";
import { prepSkyGpu, type SkyPrepGpu } from "#/lib/gpu/sky/prep";
import { modelSize, normalise, resamplePlanes, rgbPlanes } from "./core";
import type { SkyModel } from "./model";
import type { SkyPrepStatus } from "./protocol";

/** Photos per device compared against the CPU chain before the CPU pixels are dropped. */
export const PREP_VERIFY = 3;
const MAX_ERRORS = 3;

/** The worker needs the CPU pixels (verification, or a fallback from the GPU prep): resend with `rgba`. */
export class NeedPixels extends Error {
	constructor() {
		super("sky prep: RGBA pixels needed");
	}
}

interface State {
	verified: number;
	errors: number;
	disabled?: string;
}
const states = new WeakMap<Device, State>();
const stateOf = (device: Device) => {
	let s = states.get(device);
	if (!s) {
		s = { verified: 0, errors: 0 };
		states.set(device, s);
	}
	return s;
};

/** The reply's prep field. */
export function prepStatus(
	device: Device | null | undefined,
	on: "gpu" | "cpu",
): SkyPrepStatus {
	const s = device && states.get(device);
	return {
		on,
		verified: s ? s.verified : 0,
		disabled: s ? s.disabled : undefined,
	};
}

const words = (f: Float32Array) =>
	new Uint32Array(f.buffer, f.byteOffset, f.length);

/** First differing element between the GPU and CPU results, as text (undefined: identical). */
function firstDiff(
	name: string,
	got: ArrayLike<number>,
	want: ArrayLike<number>,
): string | undefined {
	if (got.length !== want.length)
		return `${name}: length ${got.length} != ${want.length}`;
	for (let i = 0; i < got.length; i++)
		if (got[i] !== want[i])
			return `${name}[${i}]: gpu ${got[i]} != cpu ${want[i]}`;
	return undefined;
}

async function verify(
	prep: SkyPrepGpu,
	rgba: Uint8Array,
): Promise<string | undefined> {
	const { W, H, lw, lh } = prep;
	const lo = resamplePlanes(
		rgbPlanes({ width: W, height: H, data: rgba }),
		W,
		H,
		3,
		lw,
		lh,
	);
	const inp = normalise(lo, lw * lh);
	const g = await prep.readAll();
	return (
		firstDiff("rgba", g.rgba, rgba) ??
		firstDiff("rgbLo", g.rgbLo, words(lo)) ??
		firstDiff("input", g.input, words(inp))
	);
}

/**
 * What to do with a prepared photo, given the alpha gate and the verification state. "gpu": use the
 * GPU buffers; "verify": compare them with the CPU chain first; "cpu": drop them (a translucent photo
 * is outside what the bitmap upload is verified for, so it always takes the CPU path, however many
 * photos were verified before); "need-pixels": verification due but no CPU pixels were sent.
 */
export function prepGate(
	opaque: boolean,
	verified: number,
	hasPixels: boolean,
): "gpu" | "verify" | "cpu" | "need-pixels" {
	if (!opaque) return "cpu";
	if (verified < PREP_VERIFY) return hasPixels ? "verify" : "need-pixels";
	return "gpu";
}

/**
 * The GPU prep of `bitmap` for `model`, or undefined when this photo takes the CPU path (not eligible,
 * unsupported shape, GPU error, a translucent photo, or a failed verification — `rgba` then carries the photo). Throws
 * NeedPixels when verification is due and `rgba` was not sent. The caller owns the returned buffers.
 */
export async function prepareGpu(
	device: Device,
	model: SkyModel,
	bitmap: ImageBitmap,
	W: number,
	H: number,
	longSide: number,
	rgba: Uint8Array | undefined,
): Promise<SkyPrepGpu | undefined> {
	if (model.backend !== "webgpu" || model.sharedDevice !== device.handle)
		return undefined;
	const st = stateOf(device);
	if (st.disabled) return undefined;
	if (st.verified < PREP_VERIFY && !rgba) throw new NeedPixels();
	const { width: lw, height: lh } = modelSize(W, H, longSide);
	let prep: SkyPrepGpu;
	try {
		prep = await prepSkyGpu(device, bitmap, W, H, lw, lh);
	} catch (e) {
		const unsupported = String(e).includes("sky prep:");
		if (!unsupported && ++st.errors >= MAX_ERRORS)
			st.disabled = `GPU prep failed ${st.errors} times: ${String(e)}`;
		console.warn("[sky] GPU prep unavailable, using the CPU prep:", e);
		return undefined;
	}
	// every photo, verified device or not: ImageBitmap bytes equal getImageData's only where alpha = 255
	let opaque = false;
	try {
		opaque = await prep.isOpaque();
	} catch (e) {
		console.warn("[sky] GPU prep alpha check failed, using the CPU prep:", e);
	}
	if (prepGate(opaque, st.verified, !!rgba) === "cpu") {
		prep.dispose();
		return undefined;
	}
	if (st.verified < PREP_VERIFY && rgba) {
		let diff: string | undefined;
		try {
			diff = await verify(prep, rgba);
		} catch (e) {
			diff = `verification failed: ${String(e)}`;
		}
		if (diff) {
			st.disabled = diff;
			console.warn(
				"[sky] GPU prep differs from the CPU chain, disabled for this device:",
				diff,
			);
			prep.dispose();
			return undefined;
		}
		st.verified++;
	}
	return prep;
}
