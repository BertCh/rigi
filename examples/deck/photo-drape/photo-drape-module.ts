// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type {Texture} from '@luma.gl/core';
import type {ShaderModule} from '@luma.gl/shadertools';
import type {Matrix4} from '@math.gl/core';

type Vector3 = [number, number, number];

/** Uniforms of the photo projector, shared by the shadow-map pass and the draped terrain. */
export type PhotoDrapeUniforms = {
  /** Local frame to the photo camera's clip space (OpenGL convention, z in -1..1). */
  viewProjectionMatrix: Matrix4;
  /** Photo camera position in the local frame. */
  eye: Vector3;
  /** 0 leaves the hillshade, 1 shows the photo wherever the camera saw the surface. */
  opacity: number;
  /** 1 tints surfaces inside the photo frame that the camera did not see. */
  shadowedTint: number;
  /** Vertical angle of one shadow-map texel, radians, for the slope-scaled bias. */
  texelAngle: number;
  /** 0 until the shadow map holds the current photo pose. */
  shadowMapReady: number;
};

/** Module props: the uniforms plus the two textures the draped terrain samples. */
export type PhotoDrapeProps = Partial<PhotoDrapeUniforms> & {
  /** r16float range from the photo camera in kilometres, 0 where the camera saw no terrain. */
  photoDrapeShadowMap?: Texture;
  /** The photo, row 0 at the top. */
  photoDrapeImage?: Texture;
};

/**
 * Uniforms only: the textures are declared by the draped terrain's fragment shader, so the
 * shadow-map pass can use this module without binding the texture it renders into.
 */
export const photoDrape = {
  name: 'photoDrape',
  bindingLayout: [{name: 'photoDrape', group: 0}],
  source: /* wgsl */ `struct PhotoDrapeUniforms {
  viewProjectionMatrix: mat4x4<f32>,
  eye: vec3<f32>,
  opacity: f32,
  shadowedTint: f32,
  texelAngle: f32,
  shadowMapReady: f32,
};
@group(0) @binding(auto) var<uniform> photoDrape: PhotoDrapeUniforms;`,
  vs: /* glsl */ `layout(std140) uniform photoDrapeUniforms {
  mat4 viewProjectionMatrix;
  vec3 eye;
  float opacity;
  float shadowedTint;
  float texelAngle;
  float shadowMapReady;
} photoDrape;`,
  fs: /* glsl */ `layout(std140) uniform photoDrapeUniforms {
  mat4 viewProjectionMatrix;
  vec3 eye;
  float opacity;
  float shadowedTint;
  float texelAngle;
  float shadowMapReady;
} photoDrape;`,
  uniformTypes: {
    viewProjectionMatrix: 'mat4x4<f32>',
    eye: 'vec3<f32>',
    opacity: 'f32',
    shadowedTint: 'f32',
    texelAngle: 'f32',
    shadowMapReady: 'f32'
  }
} as const satisfies ShaderModule<PhotoDrapeProps, PhotoDrapeUniforms>;

/**
 * The drape itself. A point is lit by the photo when it projects inside the frame and is no
 * farther from the camera than the nearest surface the shadow map recorded along that ray, plus a
 * bias: 1 % of the range, 10 m, and a slope-scaled term for grazing surfaces, where one texel
 * spans `range · texelAngle / sin(incidence)` metres. The four nearest texels vote and their votes
 * are weighted bilinearly (percentage-closer filtering), so shadow edges are one texel soft.
 */
export const PHOTO_DRAPE_WGSL = /* wgsl */ `
@group(0) @binding(auto) var photoDrapeShadowMap: texture_2d<f32>;
@group(0) @binding(auto) var photoDrapeImage: texture_2d<f32>;
@group(0) @binding(auto) var photoDrapeImageSampler: sampler;

const PHOTO_DRAPE_SHADOWED_COLOR: vec3<f32> = vec3<f32>(0.45, 0.2, 0.6);

fn photoDrape_getTexelVote(texel: vec2<i32>, range: f32, bias: f32) -> f32 {
  let lastTexel = vec2<i32>(textureDimensions(photoDrapeShadowMap)) - vec2<i32>(1);
  let seenRange = textureLoad(photoDrapeShadowMap, clamp(texel, vec2<i32>(0), lastTexel), 0).r * 1000.0;
  return select(0.0, 1.0, seenRange > 0.0 && range < seenRange * 1.01 + bias);
}

// WebGPU render targets store row 0 at the top, like the photo.
fn photoDrape_getVisibility(imageCoordinates: vec2<f32>, range: f32, bias: f32) -> f32 {
  let texelPosition = imageCoordinates * vec2<f32>(textureDimensions(photoDrapeShadowMap)) - 0.5;
  let corner = vec2<i32>(floor(texelPosition));
  let weight = fract(texelPosition);
  let upper = mix(photoDrape_getTexelVote(corner, range, bias), photoDrape_getTexelVote(corner + vec2<i32>(1, 0), range, bias), weight.x);
  let lower = mix(photoDrape_getTexelVote(corner + vec2<i32>(0, 1), range, bias), photoDrape_getTexelVote(corner + vec2<i32>(1, 1), range, bias), weight.x);
  return mix(upper, lower, weight.y);
}

fn photoDrape_apply(color: vec3<f32>, position: vec3<f32>, normal: vec3<f32>) -> vec3<f32> {
  let clip = photoDrape.viewProjectionMatrix * vec4<f32>(position, 1.0);
  let ndc = clip.xy / max(abs(clip.w), 1e-6);
  let imageCoordinates = vec2<f32>(0.5 + 0.5 * ndc.x, 0.5 - 0.5 * ndc.y);
  // Sample before any branch: the mip level comes from implicit derivatives.
  let photoColor = textureSample(photoDrapeImage, photoDrapeImageSampler, clamp(imageCoordinates, vec2<f32>(0.0), vec2<f32>(1.0))).rgb;
  let inFrame = clip.w > 0.0 && all(abs(ndc) < vec2<f32>(1.0));
  if (!inFrame || photoDrape.shadowMapReady < 0.5) { return color; }
  let ray = position - photoDrape.eye;
  let range = length(ray);
  let sinIncidence = -dot(ray / range, normal);
  let bias = 10.0 + 1.5 * range * photoDrape.texelAngle / max(sinIncidence, 0.012);
  // Back faces are never seen; the smoothstep hides DEM noise at the silhouette.
  let visibility = photoDrape_getVisibility(imageCoordinates, range, bias) * smoothstep(0.0, 0.02, sinIncidence);
  let draped = mix(color, photoColor, photoDrape.opacity * visibility);
  return mix(draped, PHOTO_DRAPE_SHADOWED_COLOR, photoDrape.shadowedTint * 0.6 * (1.0 - visibility));
}
`;

/** GLSL twin of {@link PHOTO_DRAPE_WGSL}. */
export const PHOTO_DRAPE_GLSL = /* glsl */ `
uniform sampler2D photoDrapeShadowMap;
uniform sampler2D photoDrapeImage;

const vec3 PHOTO_DRAPE_SHADOWED_COLOR = vec3(0.45, 0.2, 0.6);

float photoDrape_getTexelVote(ivec2 texel, float range, float bias) {
  ivec2 lastTexel = textureSize(photoDrapeShadowMap, 0) - ivec2(1);
  float seenRange = texelFetch(photoDrapeShadowMap, clamp(texel, ivec2(0), lastTexel), 0).r * 1000.0;
  return seenRange > 0.0 && range < seenRange * 1.01 + bias ? 1.0 : 0.0;
}

// WebGL render targets store row 0 at the bottom: flip the image coordinates.
float photoDrape_getVisibility(vec2 imageCoordinates, float range, float bias) {
  vec2 shadowCoordinates = vec2(imageCoordinates.x, 1.0 - imageCoordinates.y);
  vec2 texelPosition = shadowCoordinates * vec2(textureSize(photoDrapeShadowMap, 0)) - 0.5;
  ivec2 corner = ivec2(floor(texelPosition));
  vec2 weight = fract(texelPosition);
  float upper = mix(photoDrape_getTexelVote(corner, range, bias), photoDrape_getTexelVote(corner + ivec2(1, 0), range, bias), weight.x);
  float lower = mix(photoDrape_getTexelVote(corner + ivec2(0, 1), range, bias), photoDrape_getTexelVote(corner + ivec2(1, 1), range, bias), weight.x);
  return mix(upper, lower, weight.y);
}

vec3 photoDrape_apply(vec3 color, vec3 position, vec3 normal) {
  vec4 clip = photoDrape.viewProjectionMatrix * vec4(position, 1.0);
  vec2 ndc = clip.xy / max(abs(clip.w), 1e-6);
  vec2 imageCoordinates = vec2(0.5 + 0.5 * ndc.x, 0.5 - 0.5 * ndc.y);
  vec3 photoColor = texture(photoDrapeImage, clamp(imageCoordinates, vec2(0.0), vec2(1.0))).rgb;
  bool inFrame = clip.w > 0.0 && all(lessThan(abs(ndc), vec2(1.0)));
  if (!inFrame || photoDrape.shadowMapReady < 0.5) { return color; }
  vec3 ray = position - photoDrape.eye;
  float range = length(ray);
  float sinIncidence = -dot(ray / range, normal);
  float bias = 10.0 + 1.5 * range * photoDrape.texelAngle / max(sinIncidence, 0.012);
  float visibility = photoDrape_getVisibility(imageCoordinates, range, bias) * smoothstep(0.0, 0.02, sinIncidence);
  vec3 draped = mix(color, photoColor, photoDrape.opacity * visibility);
  return mix(draped, PHOTO_DRAPE_SHADOWED_COLOR, photoDrape.shadowedTint * 0.6 * (1.0 - visibility));
}
`;
