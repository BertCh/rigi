// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The page → GPU worker protocol for the realm-level debug switches and page flags. A worker has its
// own globals and no page URL, so the page's `__RIGI_GPU_PROFILE__` (core/profile.ts),
// `__RIGI_GPU_CHECKS__` (core/queue.ts) and the explicit GPU flags (?skylineGpu=on, ?gpu=off, …)
// do not reach it. The worker clients put realmGpuOptions() on a message they already send
// (undefined when all are off or unset, so nothing changes by default); the worker calls
// applyRealmGpuOptions() on it, and returns takeGpuProfile() with its result, which the client
// hands to mergeGpuProfile(realm, …). Import-light: no luma runtime, safe for the page chunks.
import { type FlagName, flagSet, getFlag, setFlagOverride } from "#/lib/flags";

export {
	type GpuProfile,
	mergeGpuProfile,
	takeGpuProfile,
} from "./profile";

/**
 * The page flags worker code reads (getFlag / flagSet in the modules the GPU workers import): forwarded
 * when the page sets them explicitly. Add a flag here when worker-reachable code starts reading it.
 */
export const FORWARDED_FLAGS = [
	"gpu",
	"gpuHorizon",
	"mosaicGpu",
	"horizonPrecision",
	"skylineGpu",
	"focalSeedGate",
	"unknownGpu",
	"alignPrecision",
	"skyGpuPrep",
] as const satisfies readonly FlagName[];

/** The page's GPU debug switches and explicit flags, for a worker message (only the ones that are on/set). */
export type RealmGpuOptions = {
	profile?: true;
	checks?: true;
	flags?: Partial<Record<FlagName, string>>;
};

/** This realm's switches to forward, or undefined when all are off (the default). */
export function realmGpuOptions(): RealmGpuOptions | undefined {
	const profile = globalThis.__RIGI_GPU_PROFILE__ === true;
	const checks = globalThis.__RIGI_GPU_CHECKS__ === true;
	const flags: Partial<Record<FlagName, string>> = {};
	let any = false;
	for (const name of FORWARDED_FLAGS) {
		if (!flagSet(name)) continue;
		flags[name] = String(getFlag(name));
		any = true;
	}
	if (!profile && !checks && !any) return undefined;
	return {
		...(profile ? { profile: true as const } : {}),
		...(checks ? { checks: true as const } : {}),
		...(any ? { flags } : {}),
	};
}

/** Worker side: turn on the switches the page forwarded (never turns one off) and adopt its flags. */
export function applyRealmGpuOptions(o: RealmGpuOptions | undefined): void {
	if (o?.profile) globalThis.__RIGI_GPU_PROFILE__ = true;
	if (o?.checks) globalThis.__RIGI_GPU_CHECKS__ = true;
	if (!o?.flags) return;
	// unknown keys are ignored: only the audited names become overrides
	for (const name of FORWARDED_FLAGS) {
		const value = o.flags[name];
		if (value !== undefined) setFlagOverride(name, value);
	}
}
