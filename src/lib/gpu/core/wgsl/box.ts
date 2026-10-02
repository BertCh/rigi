// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared WGSL for box-window kernels (guided filter family).

/** `span(c, r, n)`: the clamped window [lo, hi) of radius `r` around `c` in an extent of `n`. */
export const BOX_SPAN_WGSL = /* wgsl */ `
fn span(c: u32, r: u32, n: u32) -> vec2<u32> {
  return vec2<u32>(select(0u, c - r, c >= r), min(n, c + r + 1u));
}
`;
