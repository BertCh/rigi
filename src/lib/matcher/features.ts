// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The matcher's keypoint backend: src/lib/features (ALIKED-n16 + LightGlue on the src/lib/nn runtime,
// WGSL on the compute graph under WebGPU, a CPU reference otherwise), the same models the Python service
// ran. Loaded lazily by ./service.ts; null when the weights do not load.

import type { FeatureBackend } from "./context";

export async function loadFeatureBackend(): Promise<FeatureBackend | null> {
	const f = await import("#/lib/features");
	if (!(await f.featuresAvailable())) return null;
	return {
		extractFeatures: (image, opts) => f.extractFeatures(image, opts),
		matchFeatures: (a, b, opts) => f.matchFeatures(a, b, opts),
	};
}
