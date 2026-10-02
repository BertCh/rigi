// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The matcher's keypoint backend: src/lib/features/client (ALIKED-n16 + LightGlue on the src/lib/nn runtime,
// WGSL on the compute graph, in a worker so the page's thread never runs a forward), the same models the
// Python service ran. WebGPU only: null without it ("needs WebGPU"). Loaded lazily by ./service.ts.

import type { FeatureBackend } from "./context";

export async function loadFeatureBackend(): Promise<FeatureBackend | null> {
	const f = await import("#/lib/features/client");
	if (!(await f.featuresAvailable())) return null;
	return {
		extractFeatures: (image, opts) => f.extractFeatures(image, opts),
		matchFeatures: (a, b, opts) => f.matchFeatures(a, b, opts),
	};
}
