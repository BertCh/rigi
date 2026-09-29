// Type-only assertions (no runtime code is emitted that anything imports): both engines satisfy
// the Renderer interface structurally. `tsc --noEmit` fails here if either drifts.
import type { DeckEngine } from "./deck/engine";
import type { PhotoEngine } from "./engine";
import type { Renderer, RendererConstructor } from "./renderer";

export const _three: Renderer = null as unknown as PhotoEngine;
export const _deck: Renderer = null as unknown as DeckEngine;
export const _threeCtor: RendererConstructor =
	null as unknown as typeof PhotoEngine;
export const _deckCtor: RendererConstructor =
	null as unknown as typeof DeckEngine;
