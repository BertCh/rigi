// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Builds the /live engine through the same resolver as /photo (src/lib/renderer-select.ts). Both engines
// implement the live additions (src/lib/live/contract.ts LiveRendererApi) through Renderer.

import type { PhotoMeta } from "#/lib/photos";
import type { Renderer } from "#/lib/renderer";
import { type ResolvedRenderer, resolveRenderer } from "#/lib/renderer-select";

export type LiveEngine = Renderer;

export type LiveEngineHandle = {
	engine: LiveEngine;
	backend: ResolvedRenderer;
	reason: string;
};

/** `forceDeck` is the retry after a WebGPU start-up failure (a canvas that held a WebGPU context cannot give WebGL2). */
export async function createLiveEngine(
	canvas: HTMLCanvasElement,
	photo: PhotoMeta,
	options: { pixelRatioCap: number; forceDeck?: boolean },
): Promise<LiveEngineHandle> {
	const choice = options.forceDeck
		? { renderer: "deck" as const, reason: "retry after WebGPU failure" }
		: await resolveRenderer();
	const opts = { pixelRatioCap: options.pixelRatioCap };
	if (choice.renderer === "webgpu") {
		const { WebGpuEngine } = await import("#/lib/deck-webgpu/engine");
		const engine = new WebGpuEngine(canvas, photo, opts);
		await engine.whenReady();
		return {
			engine: engine as LiveEngine,
			backend: "webgpu",
			reason: choice.reason,
		};
	}
	const { DeckEngine } = await import("#/lib/deck/engine");
	return {
		engine: new DeckEngine(canvas, photo, opts) as LiveEngine,
		backend: "deck",
		reason: choice.reason,
	};
}
