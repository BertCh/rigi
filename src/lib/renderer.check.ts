// Type-only assertions (no runtime code is emitted that anything imports): both deck engines satisfy
// the Renderer interface structurally. `tsc --noEmit` fails here if either drifts.
import type { DeckEngine } from "./deck/engine";
import type { WebGpuEngine } from "./deck-webgpu/engine";
import type { Renderer, RendererConstructor } from "./renderer";

export const _deck: Renderer = null as unknown as DeckEngine;
export const _webgpu: Renderer = null as unknown as WebGpuEngine;
export const _deckCtor: RendererConstructor =
	null as unknown as typeof DeckEngine;
export const _webgpuCtor: RendererConstructor =
	null as unknown as typeof WebGpuEngine;
