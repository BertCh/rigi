// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The tile shading rules of Step Inside 3D Tiles, shared by both deck layers (deck-layer.ts GLSL,
// deck-webgpu/layers/tiles3d.ts WGSL, which ports the same fragment logic):
//   · texture (Google, unlit photogrammetry) or a flat colour with derivative-normal shading
//     (swisstopo buildings / trees)
//   · logarithmic depth, w scaled by the source's depth bias (< 1) so a DSM tile wins over the
//     coincident DEM instead of z-fighting
//   · blend "fill": inside the photo frame, where the photo camera sees a surface (or sky), the
//     fragment is dropped (the drape shows the photo there); tiles only show outside the frame and
//     where the photo is occluded (disocclusions). Feathered at the frame edge.
//   · dithered fade from fade[0] to fade[1] metres from the eye (horizontal), so the DEM takes over
//   · the refraction lift of geodesy.ts EnuFrame.fromGeo (z += lift·d²), matching the terrain
import { EARTH_R, REFRACTION_K } from "../geodesy";

/** Per-set values every tile draw shares (the engine updates `eye`). */
export type TileSharedUniforms = {
	/** Eye (ENU) the fade radius is measured from. */
	eye: [number, number, number];
	/** (fadeStart, radius) metres. */
	fade: [number, number];
	/**
	 * (start, end) metres: tiles fade IN from start to end around the photo eye (5→10 m
	 * around the live camera). Photogrammetry that close is melted anyway, and the GPS eye is 7–37 m off
	 * (step-inside-results.md), so a tile house at the eye would swallow the camera; the near field is
	 * the splats' job anyway.
	 */
	clear: [number, number];
};

export function makeTileSharedUniforms(): TileSharedUniforms {
	return { eye: [0, 0, 0], fade: [2200, 3000], clear: [25, 40] };
}

/** k·d²/(2R): geodesy.ts EnuFrame.fromGeo's lift of distant terrain, per m² of horizontal distance. */
export const REFRACTION_LIFT = REFRACTION_K / (2 * EARTH_R);

/** GLSL shared with the deck layer: dither, the fill test's visibility rule, derivative shading. */
export const TILE_GLSL_COMMON = /* glsl */ `
float tileDither(vec2 fc) {
  return fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715))));
}
vec3 tileShade(vec3 world, vec3 albedo) {
  vec3 n = normalize(cross(dFdx(world), dFdy(world)));
  vec3 L = normalize(vec3(0.45, 0.35, 0.82));
  return albedo * (0.55 + 0.45 * max(dot(n, L), 0.0));
}
// fill: 1 where the photo covers this surface (drop the tile); a 0.4% feather at the frame edge (a
// wider one lets tiles show through the photo's border)
float tileCoveredByPhoto(vec2 puv, float r, float seen, bool masked) {
  if (any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) return 0.0;
  vec2 e = min(puv, 1.0 - puv);
  float edge = smoothstep(0.0, 0.004, min(e.x, e.y));
  // the photo camera's range buffer: 0 = sky (the photo shows sky: no tile there either);
  // a surface well behind the photographed one (a disocclusion) keeps the tile; the margin is wider
  // than the drape's (1.5% + 15 m): at grazing angles (lakes, meadows) a metre of height between the
  // tileset and the DEM is tens of metres of range
  bool occluded = seen > 0.0 && r > seen * 1.08 + 25.0;
  // the drape skips masked (people / Object) pixels: those are holes the tiles may fill
  return occluded || (masked && seen > 0.0) ? 0.0 : edge;
}
`;
