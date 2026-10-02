// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WebGL context loss for DeckEngine (engine.ts). A context is lost to sleep, a GPU switch, a GPU
// process restart or memory pressure (luma: "too many apps or browser tabs are using the GPU").
// deck.gl only reports it (onError) and luma logs the restore; neither rebuilds anything.
//
// The engine has to keep its canvas (PhotoWorkspace owns it; the world / step cameras listen on
// it), and a canvas only ever has one WebGL context. So the lost context is restored in place:
//   - watchContextLoss cancels 'webglcontextlost' (preventDefault), which tells the browser we
//     restore, then reports 'webglcontextrestored';
//   - reviveDevice makes deck's luma device (deck reuses one device per context, _reuseDevices)
//     usable on the restored context: every GL object it cached died with the old context;
//   - the engine then finalizes its Deck and builds a new one (and new layers, compositor and
//     geometry sources) on that device.
// Test: gl.getExtension("WEBGL_lose_context").loseContext(), then .restoreContext().

import type { Device } from "@luma.gl/core";
import { type WebGLDevice, WebGLStateTracker } from "@luma.gl/webgl";

export type ContextLossHandlers = {
	/** The context is gone: stop drawing (every GL call is a no-op until restored). */
	onLost(): void;
	/** The browser restored the context: rebuild every GPU resource. */
	onRestored(): void;
};

/** Listens for loss / restore on `canvas`; returns the unsubscribe. */
export function watchContextLoss(
	canvas: HTMLCanvasElement,
	h: ContextLossHandlers,
): () => void {
	const lost = (e: Event) => {
		// without this the browser never restores the context
		e.preventDefault();
		h.onLost();
	};
	const restored = () => h.onRestored();
	canvas.addEventListener("webglcontextlost", lost, false);
	canvas.addEventListener("webglcontextrestored", restored, false);
	return () => {
		canvas.removeEventListener("webglcontextlost", lost, false);
		canvas.removeEventListener("webglcontextrestored", restored, false);
	};
}

/**
 * luma's WebGLDevice as reviveDevice sees it: the public `gl` / `extensions` (optional: any Device
 * may come in), the public but readonly `lost`, and the private members luma has no restore API for.
 */
type LumaWebGLDevice = Partial<Pick<WebGLDevice, "gl">> & {
	lost: Promise<unknown>;
	_resolveContextLost?: (v: { reason: "destroyed"; message: string }) => void;
	_isLost?: boolean;
	_lossWasRequested?: boolean;
	_moduleData?: Record<string, Record<string, unknown>>;
	extensions?: Record<string, unknown>;
};

/**
 * Make luma's WebGL device (@luma.gl/webgl 10 WebGLDevice) work again on its restored context.
 * luma internals, all of them caches of the dead context:
 *   - `lost` resolved at the loss, and every fence race (geometry-pass.ts gpuDone) would read it as
 *     "lost" forever: a fresh pending promise;
 *   - the per-device module data holds the default shader / pipeline factories, whose compiled
 *     programs died: dropped, so the next Model compiles again;
 *   - the WebGL state tracker believes the pre-loss state (a restored context starts at the GL
 *     defaults): emptied, so the next setter of every parameter reaches GL;
 *   - extensions must be enabled again on the new context (EXT_color_buffer_float: float targets).
 * Returns false when the context is still lost (or the device is not luma's WebGL device).
 */
export function reviveDevice(device: Device): boolean {
	const d = device as unknown as LumaWebGLDevice;
	const gl = d.gl;
	if (!gl || gl.isContextLost()) return false;
	d.lost = new Promise((resolve) => {
		d._resolveContextLost = resolve;
	});
	d._isLost = false;
	// set by loseDevice(); left true, the next real loss would report "destroyed" (app-requested)
	d._lossWasRequested = false;
	d._moduleData = {};
	// luma's state tracker of this context (public WebGLStateTracker.get; undefined if untracked)
	const st = WebGLStateTracker.get(gl) as WebGLStateTracker | undefined;
	if (st) {
		// re-read every tracked parameter from the restored context (its defaults), with the
		// tracker's getParameter override off; an empty cache would make push / pop restore
		// `undefined` (glFrontFace(0), clearColor(...undefined))
		st.enable = false;
		const fresh: Record<string, unknown> = {};
		for (const key of Object.keys(st.cache)) {
			const pname = Number(key);
			if (!Number.isInteger(pname)) continue;
			try {
				fresh[key] = gl.getParameter(pname);
			} catch {}
		}
		st.cache = fresh;
		st.enable = true;
		st.program = null;
		st.stateStack.length = 0;
	}
	const ext = d.extensions;
	if (ext)
		for (const name of Object.keys(ext))
			if (ext[name]) ext[name] = gl.getExtension(name) ?? null;
	return true;
}

/**
 * Programs still linking on `device` (luma's default pipeline factory; KHR_parallel_shader_compile
 * links asynchronously, and a draw with a pending program is silently skipped). 0 when unknown.
 */
export function pendingPrograms(device: Device): number {
	const d = device as unknown as LumaWebGLDevice;
	const factory = d._moduleData?.["@luma.gl/core"]?.defaultPipelineFactory as
		| {
				_sharedRenderPipelineCache?: Record<
					string,
					{ resource?: { linkStatus?: string } }
				>;
		  }
		| undefined;
	let n = 0;
	for (const item of Object.values(factory?._sharedRenderPipelineCache ?? {}))
		if (item.resource?.linkStatus === "pending") n++;
	return n;
}

/**
 * Resolves once no program on `device` is linking (true), or after `maxMs` (false). A draw issued
 * while its program links is silently skipped (luma WebGLRenderPass.draw returns false), so a pass
 * that came back empty has to be drawn again after this resolves. A device without luma's pipeline
 * factory counts as nothing pending and resolves at once.
 */
export async function waitForPrograms(
	device: Device,
	maxMs = 5000,
	pollMs = 25,
): Promise<boolean> {
	const t0 = performance.now();
	while (pendingPrograms(device) > 0) {
		if (performance.now() - t0 >= maxMs) return false;
		await new Promise((r) => setTimeout(r, pollMs));
	}
	return true;
}
