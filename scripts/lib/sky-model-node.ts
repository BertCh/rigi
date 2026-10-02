// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The sky model (src/lib/sky/model.ts, U²-Net-P on src/lib/nn) for node scripts: WebGPU over Dawn when
// DAWN_DIR is set and an adapter exists (a few hundred ms per photo), else the nn CPU reference backend
// (about 5.5 s per 384×288 forward; set DAWN_DIR=/tmp/dawn for a few hundred ms). Weights come from public/models (fetchModel reads the file in node).

import {
	type Backend,
	createSkyModel,
	MODEL_LONG_SIDE,
	type SkyModel,
} from "../../src/lib/sky/model";
import { dawnDevice } from "../nn/dawn";

export async function createSkyModelNode(
	opts: { backend?: Backend; bytes?: Uint8Array } = {},
): Promise<{ model: SkyModel; backend: Backend; longSide: number }> {
	const device =
		opts.backend === "cpu" ? null : await dawnDevice("sky-model-node");
	const model = await createSkyModel({
		device,
		bytes: opts.bytes,
		backends: opts.backend ? [opts.backend] : undefined,
	});
	if (model.backend === "cpu")
		console.warn(
			"[sky] nn CPU backend (no DAWN_DIR / adapter): slow; set DAWN_DIR=/tmp/dawn for WebGPU",
		);
	return {
		model,
		backend: model.backend,
		// the app's per-backend input size
		longSide: MODEL_LONG_SIDE[model.backend],
	};
}
