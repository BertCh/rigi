// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Which GPU backend the roll map starts on, and the one-way fallback. The app's renderer selection
// (src/lib/renderer-select.ts: ?renderer / ?webgpu) decides the first kind; a WebGPU backend that
// fails to start or loses its device switches the mount to "webgl" once and never retries WebGPU
// (a canvas that held a WebGPU context cannot give WebGL2, so the component also takes a fresh canvas).

import type { RendererChoice } from "#/lib/renderer-select";
import type { RollBackendKind } from "./backend";

export type RollBackendState = {
	kind: RollBackendKind;
	/** Value for [data-renderer-reason] (same vocabulary as the workspace root). */
	reason: string;
	/** True once a WebGPU start or device loss switched this mount to WebGL. */
	fellBack: boolean;
};

/** "webgpu" when the app resolved to the WebGPU engine, else "webgl" (deck.gl on WebGL2). */
export function rollBackendFor(choice: RendererChoice): RollBackendKind {
	return choice.renderer === "webgpu" ? "webgpu" : "webgl";
}

export function initialBackendState(choice: RendererChoice): RollBackendState {
	return {
		kind: rollBackendFor(choice),
		reason: choice.reason,
		fellBack: false,
	};
}

/**
 * The state after the backend failed (start error, onBackendFailed, device loss). From "webgpu" it
 * returns the "webgl" state; from "webgl" (or after a fallback) it returns the same state, so a
 * caller can compare identity to see that nothing changed and WebGPU is never retried.
 */
export function failBackend(
	state: RollBackendState,
	error: unknown,
): RollBackendState {
	if (state.kind !== "webgpu") return state;
	const why = error instanceof Error ? error.message : String(error);
	return { kind: "webgl", reason: `fallback: ${why}`, fellBack: true };
}

/** The [data-renderer] value of a roll backend, matching the workspace root: webgpu | deck. */
export function rendererAttrFor(kind: RollBackendKind): "webgpu" | "deck" {
	return kind === "webgpu" ? "webgpu" : "deck";
}
