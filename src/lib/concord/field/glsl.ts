// WP-E: the display warp in GLSL (ES 3.0), shared by the three.js composite (engine.ts compositeFrag,
// compiled as GLSL 3 by three: texture2D is #defined to texture there) and the deck.gl composite
// (deck/composite-shader.ts, #version 300 es). Declares no uniforms: each engine declares its own
// (three: `uniform sampler2D tWarp; uniform float uWarpScale; uniform float uWarpOn;`, deck: a
// `warpTex` sampler + `warpScale` / `warpOn` in its std140 block) and passes them in.
//
// The warp texture is encodeFieldRGBA8 (core/field.ts) uploaded as RGBA8 with row 0 = TOP (v down),
// NEAREST filtering, no flip (three: DataTexture flipY = false; deck: createTexture({data})). RGBA8
// holds 16-bit fixed point per component, so filtering is manual: 4 texelFetch + bilinear, with the
// same clamped cell-centred sampling as core sampleField (no float-linear filtering on iOS).
//
// Both composites run with vUv in GL convention (v UP, the render targets' rows). warpUV() returns
// the render-space uv at which to read tLayer / tGeo: vUv + W(photo uv) with W's v flipped. With
// on < 0.5 it returns vUv itself, so every read — and the output — is bit-identical to no warp.

export const WARP_GLSL = /* glsl */ `
// ---- concord display warp (src/lib/concord/field/glsl.ts) ----
vec2 warpDecode(vec4 t) {
  vec4 b = floor(t * 255.0 + 0.5);
  return (vec2(b.x * 256.0 + b.y, b.z * 256.0 + b.w) / 65535.0) * 2.0 - 1.0;
}
// W at photo uv (v DOWN, 0..1), normalised units, v down
vec2 warpAt(sampler2D tWarp, float scale, vec2 uv) {
  ivec2 sz = textureSize(tWarp, 0);
  vec2 g = clamp(uv * vec2(sz) - 0.5, vec2(0.0), vec2(sz - 1));
  ivec2 i0 = ivec2(floor(g));
  ivec2 i1 = min(i0 + 1, sz - 1);
  vec2 f = g - vec2(i0);
  vec2 a = warpDecode(texelFetch(tWarp, i0, 0));
  vec2 b = warpDecode(texelFetch(tWarp, ivec2(i1.x, i0.y), 0));
  vec2 c = warpDecode(texelFetch(tWarp, ivec2(i0.x, i1.y), 0));
  vec2 d = warpDecode(texelFetch(tWarp, i1, 0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * scale;
}
// render-space uv (GL, v up) for the composite fragment at vUv (GL, v up)
vec2 warpUV(sampler2D tWarp, float scale, float on, vec2 vUv) {
  if (on < 0.5) return vUv;
  vec2 w = warpAt(tWarp, scale, vec2(vUv.x, 1.0 - vUv.y));
  return vUv + vec2(w.x, -w.y);
}
// ---- end concord display warp ----
`;

/**
 * CPU mirror of warpAt() on the packed bytes (tests; also a reference for the integration's
 * deck-vs-three check). uv v down; returns normalised (du, dv) v down.
 */
export function warpAtCPU(
	data: Uint8Array,
	w: number,
	h: number,
	scale: number,
	u: number,
	v: number,
): [number, number] {
	const cl = (x: number, lo: number, hi: number) =>
		x < lo ? lo : x > hi ? hi : x;
	const gx = cl(u * w - 0.5, 0, w - 1);
	const gy = cl(v * h - 0.5, 0, h - 1);
	const i0 = Math.floor(gx);
	const j0 = Math.floor(gy);
	const i1 = Math.min(i0 + 1, w - 1);
	const j1 = Math.min(j0 + 1, h - 1);
	const fx = gx - i0;
	const fy = gy - j0;
	const dec = (i: number, j: number): [number, number] => {
		const k = (j * w + i) * 4;
		return [
			((data[k] * 256 + data[k + 1]) / 65535) * 2 - 1,
			((data[k + 2] * 256 + data[k + 3]) / 65535) * 2 - 1,
		];
	};
	const a = dec(i0, j0);
	const b = dec(i1, j0);
	const c = dec(i0, j1);
	const d = dec(i1, j1);
	const mix = (p: number, q: number, t: number) => p * (1 - t) + q * t;
	return [
		mix(mix(a[0], b[0], fx), mix(c[0], d[0], fx), fy) * scale,
		mix(mix(a[1], b[1], fx), mix(c[1], d[1], fx), fy) * scale,
	];
}
