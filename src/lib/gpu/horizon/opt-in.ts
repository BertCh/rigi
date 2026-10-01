// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Switch for the app's GPU skyline march (horizon-fast-app worker). ON by default since 2026-09-28
// where WebGPU exists: the profile matches the CPU to ~1e-4° (p99) at 5–100× the speed. It is not bit
// for bit, so autoAlign can move by last-bit amounts (IMG_6958: 0.01°); the user accepted that drift.
//
// Off with ?gpuHorizon=off (src/lib/flags) or the global kill switch ?gpu=off (../device.ts). Without
// WebGPU the CPU march runs as before.
import { getFlag } from "#/lib/flags";
import { gpuEnabled } from "../device";

export function gpuHorizonOptIn(): boolean {
	return getFlag("gpuHorizon") === "on" && gpuEnabled();
}
