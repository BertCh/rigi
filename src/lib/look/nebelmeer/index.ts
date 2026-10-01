// Nebelmeer: a sea of valley fog layered over the physical atmosphere (look/atmosphere.ts).
// The extinction is luma's analytic height-fog ray-transmittance integral, ported (GLSL for the
// WebGL look, WGSL for deck-webgpu, and the CPU mirror below), uniform-free on purpose.
//   Fog density is constant below `top` and falls off exponentially above it, so `top` is the
//   visible surface of the sea; a ray crossing it integrates the exact average density.
// Credit: luma.gl heightFog (MIT, Copyright (c) vis.gl contributors; luma master 7d1d11e9, #3325,
//   modules/shadertools/src/modules/lighting/height-fog/height-fog-functions.ts). The wisp-noise
//   variation of the original is not ported: the sea of fog is a flat layer.
// Heights are metres ASL, curvature-corrected by the caller (enuAltitude / atmAltitude).
// Default density 0 is the identity (the shaders skip the layer; nothing else reads these fields).
import { NEBELMEER_DEFAULT } from "../../style/defaults";
import type { NebelmeerStyle } from "../../style/types";

export type { NebelmeerStyle };
export { NEBELMEER_DEFAULT };

/**
 * Transmittance of the fog along a ray of length `rayLength` between altitudes `h0` and `h1`
 * (luma heightFog_getRayTransmittance, same branches).
 */
export function nebelRayTransmittance(
	rayLength: number,
	h0: number,
	h1: number,
	density: number,
	top: number,
	falloff: number,
) {
	const k = Math.max(falloff, 0);
	const start = (h0 - top) * k;
	const end = (h1 - top) * k;
	const lower = Math.min(start, end);
	const upper = Math.max(start, end);
	let avg = 1;
	if (upper > 0) {
		const span = upper - lower;
		if (span < 0.001) avg = Math.exp(-Math.max((start + end) * 0.5, 0));
		else if (lower >= 0) avg = (Math.exp(-lower) - Math.exp(-upper)) / span;
		else avg = (-lower + 1 - Math.exp(-upper)) / span;
	}
	return Math.exp(-Math.max(density, 0) * rayLength * avg);
}

/** GLSL: the transmittance function (ATMOSPHERE_FNS prepends it; no uniforms). */
export const NEBELMEER_GLSL = /* glsl */ `
float nebelRayT(float rayLength, float h0, float h1, float density, float top, float falloff) {
  float k = max(falloff, 0.0);
  float startH = (h0 - top) * k;
  float endH = (h1 - top) * k;
  float lowerH = min(startH, endH);
  float upperH = max(startH, endH);
  float avg = 1.0;
  if (upperH > 0.0) {
    float span = upperH - lowerH;
    if (span < 0.001) avg = exp(-max((startH + endH) * 0.5, 0.0));
    else if (lowerH >= 0.0) avg = (exp(-lowerH) - exp(-upperH)) / span;
    else avg = (-lowerH + 1.0 - exp(-upperH)) / span;
  }
  return exp(-max(density, 0.0) * rayLength * avg);
}
`;

/** WGSL twin of NEBELMEER_GLSL (deck-webgpu atm-sky.ts). */
export const NEBELMEER_WGSL = /* wgsl */ `
fn nebel_ray_t(rayLength: f32, h0: f32, h1: f32, density: f32, top: f32, falloff: f32) -> f32 {
  let k = max(falloff, 0.0);
  let startH = (h0 - top) * k;
  let endH = (h1 - top) * k;
  let lowerH = min(startH, endH);
  let upperH = max(startH, endH);
  var avg = 1.0;
  if (upperH > 0.0) {
    let span = upperH - lowerH;
    if (span < 0.001) {
      avg = exp(-max((startH + endH) * 0.5, 0.0));
    } else if (lowerH >= 0.0) {
      avg = (exp(-lowerH) - exp(-upperH)) / span;
    } else {
      avg = (-lowerH + 1.0 - exp(-upperH)) / span;
    }
  }
  return exp(-max(density, 0.0) * rayLength * avg);
}
`;
