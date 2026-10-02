// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * First-photo warm-up of the sky model: after the weights load, build and compile the graphs the first
 * photos would otherwise compile (the three-step path's U²-Net forward and the fused prep → model →
 * refine graph) for the common 4:3 landscape shape, without running anything. A photo of another
 * shape compiles its own graphs as before; the warm-up never fails or delays a request.
 */
import type { Device } from "@luma.gl/core";
import { warmFusedSky } from "#/lib/gpu/sky/fused-graph";
import { modelSize, workingSize } from "./core";
import { fusedModelHooks } from "./fused";
import { MODEL_LONG_SIDE, type SkyModel } from "./model";
import { runU2netp } from "./u2netp";

/** The photo the warm-up assumes: 4:3 at the app's default working resolution (sky/index.ts). */
const WARM_PHOTO = { w: 4000, h: 3000, longSide: 1024 };

/** Compile the U²-Net forward (and, with a `device`, the fused graph) for a 4:3 photo. */
export async function warmSkyModel(
	model: SkyModel,
	device?: Device | null,
): Promise<void> {
	if (model.backend !== "webgpu") return;
	const { w, h, longSide } = WARM_PHOTO;
	const { width: W, height: H } = workingSize(w, h, longSide);
	const { width: lw, height: lh } = modelSize(W, H, MODEL_LONG_SIDE.webgpu);
	const { nn, net } = model;
	await nn.warm?.((scratch) => runU2netp(nn, net, scratch([1, 3, lh, lw])));
	if (device)
		await warmFusedSky(device, {
			W,
			H,
			lw,
			lh,
			model: fusedModelHooks(model),
		});
}
