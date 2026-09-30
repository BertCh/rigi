// Reversed-Z depth: the WebGPU replacement for the GLSL LogDepthExtension / gl_FragDepth trick
// (deck/world-view.ts, deck/terrain-layer.ts LOG_DEPTH_FAR).
//
// camera.ts writes clip.z = near and clip.w = view depth, so the stored depth is near / viewDepth:
// 1 at the near plane, → 0 at infinity. In a float32 depth buffer that spacing is close to
// logarithmic (float exponent tracks 1/z), which gives ~1e-7 relative precision at every range:
// at 5 m near, a surface 150 km out is separable from one 2 cm behind it. No far plane, no
// per-fragment depth writes (which disable early-Z), and MSAA depth stays correct.
//
// Every pass that depth-tests MUST use these values; mixing a 'less' pipeline into a reversed-Z
// pass silently draws nothing.
import type { RenderPipelineParameters } from "@luma.gl/core";

export const REVERSED_Z = {
	/** Depth attachment format for every target (geometry, colour MSAA, overlays). */
	format: "depth32float" as const,
	/** Clear value (the far end of reversed-Z). */
	clearDepth: 0,
	/** Opaque geometry. */
	parameters: {
		depthWriteEnabled: true,
		depthCompare: "greater-equal",
	} satisfies RenderPipelineParameters,
	/** Transparent / overlay geometry: test, don't write. */
	testOnly: {
		depthWriteEnabled: false,
		depthCompare: "greater-equal",
	} satisfies RenderPipelineParameters,
	/** Full-screen passes that run INSIDE a depth-attached pass (sky): ignore depth. For passes
	 * with no depth attachment set no depth parameter at all (luma then adds a depth state). */
	none: {
		depthWriteEnabled: false,
		depthCompare: "always",
	} satisfies RenderPipelineParameters,
} as const;

/**
 * WGSL helpers for passes that read the depth attachment (bound as texture_depth_2d; depth32float
 * is not filterable, use textureLoad):
 *   depth_to_view_depth(d, near)  view depth (m) of a stored depth; +inf for the cleared value 0
 */
export const depthWGSL = /* wgsl */ `\
fn depth_to_view_depth(d: f32, near: f32) -> f32 {
  if (d <= 0.0) { return 3.0e38; }
  return near / d;
}
`;
