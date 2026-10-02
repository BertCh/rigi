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
 * Precision of the worker's tan → degrees and ENU stages (README.md "Certified f32"): the certified GPU
 * stages (?horizonPrecision=certified-f32, the default since 2026-10-01) while the GPU march is on, else
 * "f64" (?horizonPrecision=f64, the CPU). Both are bit-identical by certificate (README "Certified f32"), with random spot checks.
 */
export function horizonPrecisionOptIn(): HorizonPrecision {
	return getFlag("horizonPrecision") === "certified-f32" && gpuHorizonOptIn()
		? "certified-f32"
		: "f64";
}
