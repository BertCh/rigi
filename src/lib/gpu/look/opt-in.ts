// The look-on-GPU switch, without importing luma.gl: look/** checks this synchronously and only
// then loads the GPU code (hooks.ts) with a dynamic import, so the CPU path and the node tests never
// touch WebGPU.
//   switch:      globalThis.__RIGI_LOOKGPU__ | ?lookgpu= | localStorage "rigi.lookgpu" (first one set
//                wins; "0" turns it off). Default ON since 2026-09-28 where WebGPU exists: parity is
//                ≤ 1 byte / ~1e-6 and relief / haze run ~2× faster; results land one frame after the
//                settle frame, and export waits for them (lookIdle).
//   kill switch: the compute sidecar's (gpu/device.ts readMode, mirrored here): __RIGI_GPU__,
//                ?gpu=, localStorage "rigi.gpu"; "off" wins over the opt-in.

function pick(glob: string, query: string, storage: string): string | null {
	const g = (globalThis as Record<string, unknown>)[glob];
	if (typeof g === "string") return g;
	try {
		const q = new URLSearchParams(globalThis.location?.search ?? "").get(query);
		if (q != null) return q;
	} catch {}
	try {
		return globalThis.localStorage?.getItem(storage) ?? null;
	} catch {}
	return null;
}

/** The look switch alone (on unless set to "0"). */
export const lookGpuOptedIn = () =>
	pick("__RIGI_LOOKGPU__", "lookgpu", "rigi.lookgpu") !== "0";

/** Switched on, the compute sidecar not killed, and WebGPU present: the look passes try the GPU. */
export const lookGpuOn = () =>
	lookGpuOptedIn() &&
	pick("__RIGI_GPU__", "gpu", "rigi.gpu") !== "off" &&
	typeof navigator !== "undefined" &&
	!!(navigator as { gpu?: unknown }).gpu;

let warming: Promise<unknown> | null = null;
/**
 * When lookGpuOn(): start the compute device and compile the look kernels in the background, once
 * per realm (the engines call this at construction, while tiles still load). Otherwise a no-op.
 */
export function warmLookGpu() {
	if (warming || !lookGpuOn()) return;
	warming = import("./hooks")
		.then((m) => m.warmLook())
		.catch((e) => console.warn("[lookgpu] warm-up failed", e));
}

const inflight = new Set<Promise<unknown>>();
/** Register an async look pass (the controllers' GPU chains, through to their onAsync call). */
export function trackLook<T>(p: Promise<T>): Promise<T> {
	inflight.add(p);
	const drop = () => inflight.delete(p);
	p.then(drop, drop);
	return p;
}
/** Resolves once no async look pass is in flight (export waits so it draws the fresh results). */
export async function lookIdle(): Promise<void> {
	while (inflight.size) await Promise.allSettled([...inflight]);
}
