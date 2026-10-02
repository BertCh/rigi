// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The engine the in-browser matcher renders its views on (the photo workspace binds its engine). Kept
// import-light: the matcher itself (./service.ts and its solvers) loads on first use.

import type { Renderer } from "#/lib/renderer";

export type MatcherEngine = Pick<
	Renderer,
	| "photo"
	| "aspect"
	| "prior"
	| "eye"
	| "photoElement"
	| "renderPoseView"
	| "loadSatellite"
	| "loadFullTerrain"
	| "matchEvidence"
>;

let engine: MatcherEngine | null = null;

/** Bind the engine that renders the matcher's views; returns the unbind. */
export function bindMatcherEngine(e: MatcherEngine | null): () => void {
	engine = e;
	return () => {
		if (engine === e) engine = null;
	};
}

export const boundMatcherEngine = () => engine;
