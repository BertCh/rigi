// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The one WGSL Terrarium decode, shared by terrarium.ts (reference node) and terrarium-tile.ts (the
// app's tile path): an rgba8unorm texel (as loaded, 0..1) → metres in f32. bytes = round(v · 255)
// (exact for unorm8), then h = R·256 + G + B·(1/256) − 32768 in f32 (every step exact, see
// terrarium-f32.ts), with the sea clamp of dem/decode.ts decodeTerrarium. Multiplying by 0.00390625
// instead of dividing by 256: WGSL f32 division is only 2.5 ULP.
import { INV_256, OFFSET, SEA_FLOOR } from "./terrarium-f32";

/** A number as a WGSL f32 literal. */
export const wgslF32 = (x: number) =>
	Number.isInteger(x) ? `${x}.0` : String(x);

/** `fn decodeTerrariumTexel(v: vec4f) -> f32` */
export const TERRARIUM_DECODE_WGSL = /* wgsl */ `
fn decodeTerrariumTexel(v: vec4f) -> f32 {
  let c = round(clamp(v, vec4f(0.0), vec4f(1.0)) * 255.0);
  let h = c.r * 256.0 + c.g + c.b * ${wgslF32(INV_256)} - ${wgslF32(OFFSET)};
  return select(h, 0.0, h < 0.0 && h > ${wgslF32(SEA_FLOOR)});
}
`;
