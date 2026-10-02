// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The app's GPU skyline march (horizon-fast-app worker) runs wherever WebGPU exists: the profile matches
// the CPU to ~1e-4° (p99) at 5–100× the speed. It is not bit for bit, so autoAlign can move by last-bit
// amounts (IMG_6958: 0.01°); the user accepted that drift. ?gpu=off (../device.ts) keeps the CPU march.
import { gpuEnabled } from "../device";
import type { HorizonPrecision } from "./certified-cpu";

/**
 * Precision of the worker's tan → degrees and ENU stages (README.md "Certified f32"): the certified GPU
 * stages while the GPU march is on, else "f64" (the CPU). Wherever its certificate holds, a certified
 * output has the f64 stage's bits; uncertified outputs are recomputed in f64, and the soundness is checked
 * by the node check and random spot checks (README "Certified f32"). This is about the post stages only:
 * the march itself is not bit for bit.
 */
export function horizonPrecisionOptIn(): HorizonPrecision {
	return gpuEnabled() ? "certified-f32" : "f64";
}
