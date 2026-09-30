// The one tile material of Step Inside 3D Tiles (three.js ShaderMaterial; deck-layer.ts ports the same
// fragment logic). Tiles replace their glTF materials with it on load (tiles.ts):
//   · texture (Google, unlit photogrammetry) or a flat colour with derivative-normal shading
//     (swisstopo buildings / trees), linear working space + <colorspace_fragment> like materials.ts
//   · three's logarithmic depth, w scaled by uDepthBias (< 1) so a DSM tile wins over the coincident
//     DEM instead of z-fighting
//   · blend "fill": inside the photo frame, where the photo camera sees a surface (or sky), the
//     fragment is dropped (the drape shows the photo there); tiles only show outside the frame and
//     where the photo is occluded (disocclusions). Feathered at the frame edge.
//   · dithered fade from uFade.x to uFade.y metres from the eye (horizontal), so the DEM takes over
//   · the refraction lift of geodesy.ts EnuFrame.fromGeo (z += uLift·d²), matching the terrain
import * as THREE from "three";
import { EARTH_R, REFRACTION_K } from "../geodesy";

/** Uniforms shared by every tile material of a Tiles3DSet (tiles.ts); the engine updates them. */
export type TileSharedUniforms = {
	uPhotoViewProj: { value: THREE.Matrix4 };
	uPhotoPos: { value: THREE.Vector3 };
	uPhotoRange: { value: THREE.Texture | null };
	/**
	 * The drape's foreground mask (people / the split's Object pixels, sampled as materials.ts does) and
	 * its switch: masked photo pixels are not on the drape, so the tiles fill there (behind people: a
	 * disocclusion the photo can't show).
	 */
	uPhotoFg: { value: THREE.Texture | null };
	uPhotoFgOn: { value: number };
	/** 1 = blend "fill" and the photo projection is valid this frame. */
	uFill: { value: number };
	/** Eye (ENU) the fade radius is measured from. */
	uEye: { value: THREE.Vector3 };
	/** (fadeStart, radius) metres. */
	uFade: { value: THREE.Vector2 };
	/**
	 * (start, end) metres: tiles fade IN from start to end around the photo eye (5→10 m
	 * around the live camera). Photogrammetry that close is melted anyway, and the GPS eye is 7–37 m off
	 * (step-inside-results.md), so a tile house at the eye would swallow the camera; the near field is
	 * the splats' job anyway.
	 */
	uClear: { value: THREE.Vector2 };
	/** Truth tint mix (0 = off) and its colour (sRGB). */
	uTruth: { value: number };
	uTruthColor: { value: THREE.Color };
	uOpacity: { value: number };
};

export function makeTileSharedUniforms(): TileSharedUniforms {
	return {
		uPhotoViewProj: { value: new THREE.Matrix4() },
		uPhotoPos: { value: new THREE.Vector3() },
		uPhotoRange: { value: null },
		uPhotoFg: { value: null },
		uPhotoFgOn: { value: 0 },
		uFill: { value: 0 },
		uEye: { value: new THREE.Vector3() },
		uFade: { value: new THREE.Vector2(2200, 3000) },
		uClear: { value: new THREE.Vector2(25, 40) },
		uTruth: { value: 0 },
		uTruthColor: { value: new THREE.Color(1, 1, 1) },
		uOpacity: { value: 1 },
	};
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

const vertexShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uDepthBias;
uniform float uLift;
varying vec2 vUv;
varying vec3 vWorld;
#ifdef USE_COLOR
varying vec3 vColor;
#endif
void main() {
  vUv = uv;
#ifdef USE_COLOR
  vColor = color.rgb;
#endif
#ifdef USE_INSTANCING
  // i3dm (swisstopo vegetation: one tree model, instanced)
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
#else
  vec4 w = modelMatrix * vec4(position, 1.0);
#endif
  w.z += uLift * dot(w.xy, w.xy);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  vFragDepth = 1.0 + gl_Position.w * uDepthBias;
#endif
}
`;

const fragmentShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
uniform float uHasMap;
uniform vec3 uColor;
uniform mat4 uPhotoViewProj;
uniform vec3 uPhotoPos;
uniform sampler2D uPhotoRange;
uniform sampler2D uPhotoFg;
uniform float uPhotoFgOn;
uniform float uFill;
uniform vec3 uEye;
uniform vec2 uFade;
uniform vec2 uClear;
uniform float uTruth;
uniform vec3 uTruthColor;
uniform float uOpacity;
varying vec2 vUv;
varying vec3 vWorld;
#ifdef USE_COLOR
varying vec3 vColor;
#endif
${TILE_GLSL_COMMON}
vec3 toLinear3(vec3 c) { return pow(c, vec3(2.2)); }
void main() {
  float dith = tileDither(gl_FragCoord.xy);
  float d = length(vWorld.xy - uEye.xy);
  float keep = (1.0 - smoothstep(uFade.x, uFade.y, d)) * smoothstep(uClear.x, uClear.y, d) * uOpacity;
  // the orbiting step camera must not end up inside a tile house either
  keep *= smoothstep(5.0, 10.0, length(vWorld - cameraPosition));
  if (uFill > 0.5) {
    vec4 clip = uPhotoViewProj * vec4(vWorld, 1.0);
    if (clip.w > 0.0) {
      vec2 puv = (clip.xy / clip.w) * 0.5 + 0.5;
      float seen = texture2D(uPhotoRange, puv).a;
      bool masked = uPhotoFgOn > 0.5 && texture2D(uPhotoFg, puv).r > 0.5;
      keep *= 1.0 - tileCoveredByPhoto(puv, length(vWorld - uPhotoPos), seen, masked);
    }
  }
  if (keep <= dith) discard;
  vec3 base;
  if (uHasMap > 0.5) base = texture2D(uMap, vUv).rgb;
  else {
    vec3 c = toLinear3(uColor);
#ifdef USE_COLOR
    c *= vColor;
#endif
    base = tileShade(vWorld, c);
  }
  if (uTruth > 0.0) base = mix(base, toLinear3(uTruthColor), uTruth);
  gl_FragColor = vec4(base, 1.0);
  #include <logdepthbuf_fragment>
  #include <colorspace_fragment>
}
`;

/** A tile's material: its glTF texture (or colour) + the set's shared uniforms. */
export function makeTileMaterial(
	shared: TileSharedUniforms,
	opts: {
		map: THREE.Texture | null;
		color: [number, number, number];
		vertexColors: boolean;
		depthBias: number;
	},
): THREE.ShaderMaterial {
	return new THREE.ShaderMaterial({
		name: "tiles3d",
		vertexShader,
		fragmentShader,
		vertexColors: opts.vertexColors,
		side: THREE.DoubleSide,
		uniforms: {
			...shared,
			uMap: { value: opts.map },
			uHasMap: { value: opts.map ? 1 : 0 },
			uColor: { value: new THREE.Color(...opts.color) },
			uDepthBias: { value: opts.depthBias },
			uLift: { value: REFRACTION_LIFT },
		},
	});
}
