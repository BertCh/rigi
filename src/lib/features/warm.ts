// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * First-extract warm-up: after the weights load, compile ALIKED's single forward (aliked.ts
 * `alikedForward`, the very code runAliked records) for a 1024×768 source image (4:3 landscape at the
 * default long side, no resize step) and 4096 keypoints, without running it, so the first extract of
 * that shape is a graph hit. Other source sizes or keypoint budgets compile their own graph as before.
 * LightGlue is not warmed: every layer's shapes depend on both sets' sizes and the pruning.
 */
import type { Nn, Weights } from "#/lib/nn";
import { alikedForward, prepareAliked } from "./aliked";

export const WARM_SHAPE = { width: 1024, height: 768, maxKeypoints: 4096 };

export async function warmAliked(
	nn: Nn,
	w: Weights,
	longSide = 1024,
): Promise<void> {
	const { width, height, maxKeypoints } = WARM_SHAPE;
	const shape = [1, 3, height, width];
	// constants are uploaded outside the forward, as runAliked does
	const prepared = prepareAliked(nn, shape, longSide);
	await nn.warm?.((scratch) =>
		alikedForward(nn, w, scratch(shape), { longSide, maxKeypoints }, prepared),
	);
}
