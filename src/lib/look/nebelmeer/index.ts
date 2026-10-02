// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) vis.gl contributors
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Nebelmeer: a sea of valley fog layered over the physical atmosphere (look/atmosphere.ts).
// The extinction is luma's analytic height-fog ray-transmittance integral: the shadertools
// `heightFogFunctions` module supplies the GLSL (WebGL look) and the WGSL (deck-webgpu); the CPU
// mirror below stays local (it is the spec oracle), uniform-free on purpose.
//   Fog density is constant below `top` and falls off exponentially above it, so `top` is the
//   visible surface of the sea; a ray crossing it integrates the exact average density.
// Credit: luma.gl heightFog (MIT, Copyright (c) vis.gl contributors), imported from @luma.gl/shadertools.
// Heights are metres ASL, curvature-corrected by the caller (enuAltitude / atmAltitude).
// Default density 0 is the identity (the shaders skip the layer; nothing else reads these fields).
import { heightFogFunctions } from "@luma.gl/shadertools";
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

/**
 * GLSL: luma's uniform-free `heightFogFunctions` (heightFog_getRayTransmittance plus its wisp
 * helpers; ATMOSPHERE_FNS prepends it). The wisp functions go unused: the sea is a flat layer.
 */
export const NEBELMEER_GLSL = heightFogFunctions.fs as string;

/** WGSL twin of NEBELMEER_GLSL (deck-webgpu atm-sky.ts): `heightFog_getRayTransmittance`. */
export const NEBELMEER_WGSL = heightFogFunctions.source as string;
