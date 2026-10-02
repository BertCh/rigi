// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Uniform block of the solve fold kernel (graph.ts FOLD_WGSL `struct FU`), packed through
// defineUniformBlock. Pure (no GPU): core/uniform-block-a.check.ts proves it byte-identical to the
// former hand-packed words.

import { defineUniformBlock } from "#/lib/gpu/core/uniform-block";

/** FOLD_WGSL struct FU (16 B). */
export const FOLD_U = defineUniformBlock({
	nYaw: "u32",
	nBlk: "u32",
	nPitch: "u32",
	e2: "f32",
});
