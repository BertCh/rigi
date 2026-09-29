// GLSL for DeckSplatLayer (deck-splat-layer.ts): 3D Gaussians as instanced screen-space quads with
// EWA covariance projection, premultiplied alpha and the terrain's LOGARITHMIC depth
// (deck/terrain-layer.ts: gl_FragDepth = log2(1 + clip.w) * logDepthFC, logDepthFC =
// 1 / log2(LOG_DEPTH_FAR + 1)), so the log-depth terrain occludes the splats with
// depthCompare 'less-equal' and depthWrite off (as the trails / world gizmo do).
//
// Per-splat data lives in one rgba32float texture, SPLAT_TEX_PER_ROW splats per row, 3 texels each:
//   t0 = position xyz (layer coordinates, ENU metres), provenance code
//   t1 = covariance xx, xy, xz, yy (metres²)
//   t2 = covariance yz, zz, r*256+g, b*256+a (colour bytes, sRGB)
// The only instance attribute is the splat index, rewritten back-to-front after each sort.
//
// Covariance projection: deck's project_position_to_clipspace is affine in homogeneous clip space
// for CARTESIAN coordinates, so its exact linear part is clip(p + e_k) - clip(p). The screen
// Jacobian of the perspective divide at p follows from that (no view / projection matrices of our
// own, so modelMatrix and the photo viewport's eye offset are honoured exactly as for the terrain).
import type { Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";

/** Splats per texture row (3 texels each: width = 3 × this). */
export const SPLAT_TEX_PER_ROW = 1024;

const uniformBlock = /* glsl */ `\
layout(std140) uniform splatUniforms {
  vec4 tint0;
  vec4 tint1;
  vec4 tint2;
  vec4 tint3;
  float opacity;
  float truth;
  float logDepthFC;
  float linearOut;
  float maxRadiusPx;
  float nearW;
  float sigmas;
  float lowPass;
} splat;
`;

export type SplatModuleProps = {
	/** Provenance tints (linear-ish sRGB 0..1, a = mix strength) for PROVENANCE_CODE 0..3. */
	tint0: number[];
	tint1: number[];
	tint2: number[];
	tint3: number[];
	opacity: number;
	truth: number;
	logDepthFC: number;
	linearOut: number;
	maxRadiusPx: number;
	nearW: number;
	sigmas: number;
	lowPass: number;
	/** The packed splat texture (deck-splat-layer.ts packSplatTexture), bound as `splatData`. */
	splatData?: Texture;
};

export const splatModule = {
	name: "splat",
	vs: uniformBlock,
	fs: uniformBlock,
	uniformTypes: {
		tint0: "vec4<f32>",
		tint1: "vec4<f32>",
		tint2: "vec4<f32>",
		tint3: "vec4<f32>",
		opacity: "f32",
		truth: "f32",
		logDepthFC: "f32",
		linearOut: "f32",
		maxRadiusPx: "f32",
		nearW: "f32",
		sigmas: "f32",
		lowPass: "f32",
	},
} as const satisfies ShaderModule;

export const splatVs = /* glsl */ `#version 300 es
#define SHADER_NAME deck-splat-vs
precision highp float;
precision highp int;
uniform highp sampler2D splatData;
in vec2 positions;
in float splatIndex;
out vec4 vColor;
out vec2 vUv;
flat out float vLogW;

const int PER_ROW = ${SPLAT_TEX_PER_ROW};

void cull() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vColor = vec4(0.0);
  vUv = vec2(0.0);
  vLogW = 1.0;
}

vec3 clipOf(vec3 p) {
  vec4 pc;
  return project_position_to_clipspace(p, vec3(0.0), vec3(0.0), pc).xyw;
}

void main() {
  int i = int(splatIndex + 0.5);
  ivec2 c = ivec2((i % PER_ROW) * 3, i / PER_ROW);
  vec4 t0 = texelFetch(splatData, c, 0);
  vec4 t1 = texelFetch(splatData, c + ivec2(1, 0), 0);
  vec4 t2 = texelFetch(splatData, c + ivec2(2, 0), 0);
  vec3 p = t0.xyz;

  vec4 pc;
  vec4 clip = project_position_to_clipspace(p, vec3(0.0), vec3(0.0), pc);
  if (clip.w < splat.nearW) { cull(); return; }

  // linear part of world -> clip (x, y, w), exact for the affine CARTESIAN projection
  vec3 c0 = clip.xyw;
  vec3 dX = clipOf(p + vec3(1.0, 0.0, 0.0)) - c0;
  vec3 dY = clipOf(p + vec3(0.0, 1.0, 0.0)) - c0;
  vec3 dZ = clipOf(p + vec3(0.0, 0.0, 1.0)) - c0;
  vec2 ndc = clip.xy / clip.w;
  vec2 halfRes = 0.5 * project.viewportSize;
  // d(pixel)/d(world_k) = halfRes * (d clip.xy - ndc * d clip.w) / clip.w
  vec2 jX = halfRes * (dX.xy - ndc * dX.z) / clip.w;
  vec2 jY = halfRes * (dY.xy - ndc * dY.z) / clip.w;
  vec2 jZ = halfRes * (dZ.xy - ndc * dZ.z) / clip.w;
  // rows of J (2x3): screen x and screen y
  vec3 Jx = vec3(jX.x, jY.x, jZ.x);
  vec3 Jy = vec3(jX.y, jY.y, jZ.y);
  mat3 S = mat3(
    t1.x, t1.y, t1.z,
    t1.y, t1.w, t2.x,
    t1.z, t2.x, t2.y
  );
  vec3 SJx = S * Jx;
  vec3 SJy = S * Jy;
  float a = dot(Jx, SJx) + splat.lowPass;
  float b = dot(Jx, SJy);
  float d = dot(Jy, SJy) + splat.lowPass;

  float mid = 0.5 * (a + d);
  float rad = sqrt(max(0.25 * (a - d) * (a - d) + b * b, 0.0));
  float l1 = mid + rad;
  float l2 = max(mid - rad, 0.05);
  vec2 v1 = abs(b) > 1e-9 ? normalize(vec2(b, l1 - a)) : (a >= d ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec2 v2 = vec2(-v1.y, v1.x);
  float r1 = min(splat.sigmas * sqrt(l1), splat.maxRadiusPx);
  float r2 = min(splat.sigmas * sqrt(l2), splat.maxRadiusPx);

  // off-screen (with the quad's own radius) -> cull
  vec2 px = ndc * halfRes;
  if (any(greaterThan(abs(px) - vec2(r1), halfRes * 1.05))) { cull(); return; }

  float code = t0.w;
  float rg = t2.z;
  float ba = t2.w;
  vec4 col = vec4(floor(rg / 256.0), mod(rg, 256.0), floor(ba / 256.0), mod(ba, 256.0)) / 255.0;
  if (splat.truth > 0.5) {
    vec4 tint = code < 0.5 ? splat.tint0 : code < 1.5 ? splat.tint1 : code < 2.5 ? splat.tint2 : splat.tint3;
    col.rgb = mix(col.rgb, tint.rgb, tint.a);
  }
  col.a *= splat.opacity;
  if (col.a < 1.0 / 255.0) { cull(); return; }
  vColor = col;

  vec2 off = positions.x * r1 * v1 + positions.y * r2 * v2;
  // quad corner in units of sigma along the ellipse's axes (the fragment Gaussian's argument);
  // a radius clamped by maxRadiusPx keeps its sigma scale, so the clamp crops rather than stretches
  vUv = vec2(positions.x * r1 / max(sqrt(l1), 1e-6), positions.y * r2 / max(sqrt(l2), 1e-6));
  gl_Position = vec4(clip.xy + off / halfRes * clip.w, clip.z, clip.w);
  // the terrain's log depth, at the splat centre (constant over the quad)
  vLogW = 1.0 + max(clip.w, 1e-6);
}
`;

export const splatFs = /* glsl */ `#version 300 es
#define SHADER_NAME deck-splat-fs
precision highp float;
in vec4 vColor;
in vec2 vUv;
flat in float vLogW;
out vec4 fragColor;

vec3 srgbDecode(vec3 c) {
  return mix(pow(c * 0.9478672986 + vec3(0.0521327014), vec3(2.4)), c * 0.0773993808, vec3(lessThanEqual(c, vec3(0.04045))));
}

void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > splat.sigmas * splat.sigmas) discard;
  float alpha = vColor.a * exp(-0.5 * r2);
  if (alpha < 1.0 / 255.0) discard;
  gl_FragDepth = log2(vLogW) * splat.logDepthFC;
  // canvas: sRGB bytes as-is (what every splat viewer blends in); the photo view's offscreen colour
  // pass (composite.ts) is linear, so decode there. Premultiplied: blend (one, 1 - src alpha).
  vec3 c = splat.linearOut > 0.5 ? srgbDecode(vColor.rgb) : vColor.rgb;
  fragColor = vec4(c * alpha, alpha);
}
`;
