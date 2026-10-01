// Which engine /photo runs: the ?renderer flag (src/lib/flags) resolved against what this browser can do.
//
//   ?renderer=auto    WebGPU deck (src/lib/deck-webgpu WebGpuEngine) when the probe below passes, else the
//                     WebGL deck (src/lib/deck DeckEngine)
//   ?renderer=webgpu  the same, but asked for explicitly (falls back to WebGL deck with a console warning)
//   ?renderer=deck    WebGL deck, never WebGPU (today's renderer; the escape hatch)
//   ?renderer=three   the three.js PhotoEngine
//
// ?webgpu=off makes auto / webgpu behave as if navigator.gpu were missing: the switch that proves the WebGL
// fallback on a WebGPU machine. A WebGpuEngine that fails during start-up also falls back (PhotoWorkspace
// re-mounts a fresh canvas: one that held a WebGPU context cannot give a WebGL2 one).
//
// The resolved engine is on the workspace root as [data-renderer] = webgpu | deck | three, and the reason in
// [data-renderer-reason], so harnesses assert which engine actually ran.

import { getFlag } from "#/lib/flags";
import { resolveStyle } from "#/lib/style/presets";
import { getStyleStore } from "#/lib/style/store";

/**
 * Terroir shading (src/lib/terroir/glsl: contour ink by ground, range-adaptive contours, real land cover,
 * snow for the date) exists in the WebGL deck and three engines only, not yet in deck-webgpu. While the
 * current style uses any of it, `auto` resolves to WebGL deck so the look renders (the SVG terroir
 * overlays work on every engine). Remove once deck-webgpu ports it.
 */
function terroirNeedsWebGl(): boolean {
	try {
		const t = resolveStyle(getStyleStore().getState()).terroir;
		return t.cover.on || t.contours.inkByCover || t.contours.adaptive;
	} catch {
		return false;
	}
}

export type ResolvedRenderer = "webgpu" | "deck" | "three";
export type RendererChoice = { renderer: ResolvedRenderer; reason: string };

/** Adapter features WebGpuEngine cannot run without: keep equal to deck-webgpu/device.ts REQUIRED_FEATURES
 * (duplicated so this probe never pulls the WebGPU chunk). */
export const WEBGPU_REQUIRED_FEATURES = ["float32-filterable"] as const;

/** Limits below which the engine would not fit (geometry target 1024², imagery array, MRT). */
const MIN_LIMITS: Record<string, number> = {
	maxTextureDimension2D: 8192,
	maxColorAttachments: 2,
	maxStorageBufferBindingSize: 128 << 20,
};

let probe: Promise<
	{ ok: true; adapter: string } | { ok: false; reason: string }
> | null = null;

/**
 * Can WebGpuEngine run here? navigator.gpu, an adapter with the required features and limits, and a device
 * that is actually granted (then destroyed: the engine creates its own). Cached per page; never throws.
 */
export function probeWebGpu() {
	probe ??= (async () => {
		const gpu = (globalThis.navigator as { gpu?: GPU } | undefined)?.gpu;
		if (!gpu) return { ok: false as const, reason: "no navigator.gpu" };
		try {
			const a = await gpu.requestAdapter({
				powerPreference: "high-performance",
			});
			if (!a) return { ok: false as const, reason: "no WebGPU adapter" };
			const missing = WEBGPU_REQUIRED_FEATURES.filter(
				(f) => !a.features.has(f),
			);
			if (missing.length)
				return {
					ok: false as const,
					reason: `adapter lacks ${missing.join(", ")}`,
				};
			for (const [k, min] of Object.entries(MIN_LIMITS)) {
				const v = (a.limits as unknown as Record<string, number>)[k];
				if (typeof v === "number" && v < min)
					return { ok: false as const, reason: `adapter ${k} ${v} < ${min}` };
			}
			const d = await a.requestDevice({
				requiredFeatures: [...WEBGPU_REQUIRED_FEATURES],
			});
			d.destroy();
			const i = a.info;
			return {
				ok: true as const,
				adapter: `${i?.vendor ?? "?"} ${i?.architecture ?? ""}`.trim(),
			};
		} catch (e) {
			return {
				ok: false as const,
				reason: `WebGPU probe failed: ${(e as Error).message}`,
			};
		}
	})();
	return probe;
}

/** The engine the current flags ask for, before probing (decides which chunk to preload). */
export function requestedRenderer(): "auto" | ResolvedRenderer {
	return getFlag("renderer");
}

/** Resolve ?renderer / ?webgpu to the engine to construct. Never throws. */
export async function resolveRenderer(): Promise<RendererChoice> {
	const want = requestedRenderer();
	if (want === "three" || want === "deck")
		return { renderer: want, reason: "pinned" };
	if (getFlag("webgpu") === "off")
		return { renderer: "deck", reason: "webgpu=off" };
	if (want === "auto" && terroirNeedsWebGl())
		return { renderer: "deck", reason: "auto: terroir shading is WebGL-only" };
	const p = await probeWebGpu();
	if (p.ok)
		return {
			renderer: "webgpu",
			reason: want === "auto" ? `auto: ${p.adapter}` : "pinned",
		};
	if (want === "webgpu")
		console.warn(
			`[renderer] webgpu asked for but unavailable (${p.reason}); using WebGL deck`,
		);
	return { renderer: "deck", reason: `fallback: ${p.reason}` };
}
