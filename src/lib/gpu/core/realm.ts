// The page → GPU worker protocol for the realm-level debug switches. A worker has its own globals,
// so the page's `__RIGI_GPU_PROFILE__` (core/profile.ts) and `__RIGI_GPU_CHECKS__` (core/queue.ts)
// do not reach it. The worker clients put realmGpuOptions() on a message they already send
// (undefined when both are off, so nothing changes by default); the worker calls
// applyRealmGpuOptions() on it, and returns takeGpuProfile() with its result, which the client
// hands to mergeGpuProfile(realm, …). Import-light: no luma runtime, safe for the page chunks.
export {
	type GpuProfile,
	mergeGpuProfile,
	takeGpuProfile,
} from "./profile";

/** The page's GPU debug switches, for a worker message (only the ones that are on). */
export type RealmGpuOptions = { profile?: true; checks?: true };

/** This realm's switches to forward, or undefined when all are off (the default). */
export function realmGpuOptions(): RealmGpuOptions | undefined {
	const profile = globalThis.__RIGI_GPU_PROFILE__ === true;
	const checks = globalThis.__RIGI_GPU_CHECKS__ === true;
	if (!profile && !checks) return undefined;
	return {
		...(profile ? { profile: true as const } : {}),
		...(checks ? { checks: true as const } : {}),
	};
}

/** Worker side: turn on the switches the page forwarded (never turns one off). */
export function applyRealmGpuOptions(o: RealmGpuOptions | undefined): void {
	if (o?.profile) globalThis.__RIGI_GPU_PROFILE__ = true;
	if (o?.checks) globalThis.__RIGI_GPU_CHECKS__ = true;
}
