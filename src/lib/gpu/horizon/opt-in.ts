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
import type { HorizonPrecision } from "./certified-cpu";

export function gpuHorizonOptIn(): boolean {
	return getFlag("gpuHorizon") === "on" && gpuEnabled();
}

/**
 * Precision of the worker's tan → degrees and ENU stages (README.md "Certified f32"): "f64" (default)
 * or, with ?horizonPrecision=certified-f32 and the GPU march on, the certified GPU stages. Both give
 * the same bits; certified-f32 stays opt-in until its EVAL / wild-set gate passes.
 */
export function horizonPrecisionOptIn(): HorizonPrecision {
	return getFlag("horizonPrecision") === "certified-f32" && gpuHorizonOptIn()
		? "certified-f32"
		: "f64";
}
