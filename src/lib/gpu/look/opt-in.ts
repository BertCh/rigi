// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The look-on-GPU switch, without importing luma.gl: look/** checks this synchronously and only
// then loads the GPU code (hooks.ts) with a dynamic import, so the CPU path and the node tests never
// touch WebGPU.
//   switch:      ?lookgpu=off (src/lib/flags). Default ON since 2026-09-28 where WebGPU exists: parity
//                is ≤ 1 byte / ~1e-6 and relief / haze run ~2× faster; results land one frame after the
//                settle frame, and export waits for them (lookIdle).
//   kill switch: ?gpu=off (the compute sidecar's, gpu/device.ts) wins over the switch.
import { getFlag } from "#/lib/flags";

/** The look switch alone. */
export const lookGpuOptedIn = () => getFlag("lookgpu") === "on";

/** Switched on, the compute sidecar not killed, and WebGPU present: the look passes try the GPU. */
export const lookGpuOn = () =>
	lookGpuOptedIn() &&
	getFlag("gpu") === "on" &&
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
