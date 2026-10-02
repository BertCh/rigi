// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Draco decoding off the main thread: loaders.gl's own Draco worker bundle, served from our build
// (Vite `?url`) instead of loaders.gl's default unpkg CDN URL. The worker fetches the decoder from
// `modules` (tiles.ts dracoModules: public/tiles3d/draco). Browser only: deck-tiles.ts passes these
// options; node scripts and specs keep loaders.gl's main-thread decoder.
import dracoWorkerUrl from "@loaders.gl/draco/draco-worker.js?url";

/** Tileset load options that run every Draco decode in a loaders.gl worker. */
export function dracoWorkerOptions(): Record<string, unknown> {
	return {
		core: { worker: true },
		draco: { workerUrl: dracoWorkerUrl },
	};
}
