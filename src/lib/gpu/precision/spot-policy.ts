// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// How many GPU-certified outputs a certified-f32 stage re-derives on its CPU emulation per call
// (README.md step 4, "spot-check every call"), and the per-(adapter, shader) ledger that decides it.
//
// What the spot check guards: the strict-IEEE probe validates its own shader module only; fma fusion,
// subnormal flushing and fast-math re-association are decided when a shader is COMPILED, for one
// adapter / driver and one WGSL source. A compile that departs from what the node check proved is a
// systematic difference: it shows on many outputs of every call that runs that pipeline. So:
//   - the first SPOT_FULL_FIRST calls per (adapter, features, stage source) re-derive SPOT_CHECKS
//     outputs each (the full check, as every call did before), which qualifies the compile;
//   - after that, each call still re-derives SPOT_LIGHT outputs (never zero), and 1 call in
//     SPOT_FULL_EVERY at random runs the full check again (the photoprep pattern: first 3 + 1 in 32);
//   - any mismatch runs the f64 path for that call AND disables the stage for that key for the rest
//     of the realm (and, through the ledger snapshot, for the page's later workers).
// The per-output certificate (bound → every value in it rounds to one f32) is untouched: the spot
// check never certified anything, it detects a shader that does not compute what was proven. A rare
// wrong certificate that no sample hits could slip through before and still can (README "per-shader
// gap"); what changes is how many samples a qualified compile pays per call (64 → 8, and 64 on 1 in
// 32 calls).
//
// The ledger is keyed by the adapter's identity, the device features and a hash of the stage's WGSL,
// not by the GPUDevice: the horizon stages run in a fresh worker (a fresh device on the same adapter)
// per photo, and Dawn compiles the same WGSL on the same adapter with the same features to the same
// pipeline. A worker seeds its ledger from the page (mergeSpotLedger) and reports it back with its
// result; the page merges it (counts: max; a disabled key stays disabled).
import type { Device } from "@luma.gl/core";

/** Outputs a full spot check re-derives. */
export const SPOT_CHECKS = 64;
/** Outputs every other call re-derives (never 0). */
export const SPOT_LIGHT = 8;
/** Full checks per key before the light check applies. */
export const SPOT_FULL_FIRST = 3;
/** After that, 1 call in SPOT_FULL_EVERY (at random) runs the full check. */
export const SPOT_FULL_EVERY = 32;

/** Bench / test override: "full" re-derives SPOT_CHECKS outputs on every call (the pre-ledger policy). */
export const spotPolicyOptions: { mode: "ledger" | "full" } = {
	mode: "ledger",
};

export type SpotEntry = {
	/** full spot checks passed for this key */
	full: number;
	/** set once a spot check failed: the stage runs f64 for this key from then on */
	disabled?: string;
};
/** Serializable ledger (postMessage-able): key → entry. */
export type SpotLedger = Record<string, SpotEntry>;

const ledger = new Map<string, SpotEntry>();

/** FNV-1a 32-bit of a string (the shader-source part of a key). */
function fnv1a(s: string) {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/** The adapter / feature part of a key (what a pipeline compile depends on besides the source). */
export function adapterKey(device: Pick<Device, "info" | "features">) {
	const i = device.info;
	const features = [...(device.features ?? [])].map(String).sort().join(",");
	return [
		i?.type,
		i?.vendor,
		i?.renderer,
		i?.version,
		i?.gpu,
		i?.gpuArchitecture,
		i?.gpuBackend,
		fnv1a(features),
	].join("|");
}

/** Ledger key of one stage's pipelines on `device`: stage id, adapter, hash of the stage's WGSL. */
export function spotKey(
	device: Pick<Device, "info" | "features">,
	stage: string,
	source: string,
) {
	return `${stage}@${fnv1a(source)}|${adapterKey(device)}`;
}

export type SpotPlan = {
	/** outputs to re-derive this call (0 when disabled) */
	count: number;
	full: boolean;
	/** set when a spot check failed earlier for this key: the call must run the f64 path */
	disabled?: string;
};

/** How this call spot-checks (or that the key is disabled and the call must run f64). */
export function planSpotCheck(key: string, random = Math.random): SpotPlan {
	const e = ledger.get(key);
	if (e?.disabled) return { count: 0, full: false, disabled: e.disabled };
	const full =
		spotPolicyOptions.mode === "full" ||
		(e?.full ?? 0) < SPOT_FULL_FIRST ||
		random() < 1 / SPOT_FULL_EVERY;
	return { count: full ? SPOT_CHECKS : SPOT_LIGHT, full };
}

/** Record a spot check's outcome: a reason string (mismatch) disables the key. */
export function recordSpotCheck(
	key: string,
	plan: SpotPlan,
	outcome: number | string,
) {
	const e = ledger.get(key) ?? { full: 0 };
	if (typeof outcome === "string") e.disabled = outcome;
	else if (!plan.disabled && plan.full) e.full++;
	ledger.set(key, e);
}

/** A copy of this realm's ledger (to post to / from a worker). */
export function spotLedger(): SpotLedger {
	const out: SpotLedger = {};
	for (const [k, e] of ledger) out[k] = { ...e };
	return out;
}

/** Merge a ledger from another realm: full counts take the max, a disabled key stays disabled. */
export function mergeSpotLedger(from: SpotLedger | undefined | null) {
	if (!from) return;
	for (const [k, e] of Object.entries(from)) {
		if (!e || typeof e.full !== "number") continue;
		const mine = ledger.get(k) ?? { full: 0 };
		mine.full = Math.max(mine.full, e.full);
		if (e.disabled && !mine.disabled) mine.disabled = e.disabled;
		ledger.set(k, mine);
	}
}

/** Forget every key (tests). */
export function resetSpotLedger() {
	ledger.clear();
}
