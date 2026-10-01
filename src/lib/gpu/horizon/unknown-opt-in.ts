// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Opt-in for the unknown-pose worker's GPU 360° horizon (./scene-profile.ts). Off by default.
//
// Separate from gpuHorizonOptIn (./opt-in.ts, the app's skyline march for autoAlign): the two feed
// different solvers, each with its own acceptance evidence (the unknown-pose cascade has a hard
// 0-false-accept rule), so turning one on must not turn on the other.
//
// On with ?unknownGpu=on (src/lib/flags), never with the GPU kill switch (?gpu=off; ../device.ts). Call
// it in the page, not in the worker (a worker has no page URL): UnknownPoseSolver sends the answer with
// its messages.
import { getFlag } from "#/lib/flags";
import { gpuEnabled } from "../device";

export function unknownGpuOptIn(): boolean {
	return getFlag("unknownGpu") === "on" && gpuEnabled();
}
