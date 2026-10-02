// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The roll map's screen pass: the resolved colour target (linear, premultiplied) to the canvas,
// sRGB-encoded, ALPHA KEPT. The canvas is premultiplied and the page's sky colour sits behind it
// (canvas.style.backgroundColor), as with the WebGL roll map; deck-webgpu's PresentCore writes
// alpha 1 (it composites over a photo). No blending: the pass overwrites the cleared canvas.
import { Model } from "@luma.gl/engine";
import {
	type GpuLayerCore,
	ModelCache,
	type PassContext,
	type PassKind,
	screenModelProps,
	targetKey,
} from "../../deck-webgpu/pass";
import { colorWGSL, fullscreenWGSL } from "../../deck-webgpu/wgsl";

export const ALPHA_PRESENT_WGSL = /* wgsl */ `\
${colorWGSL}
${fullscreenWGSL}
@group(0) @binding(auto) var colorTex: texture_2d<f32>;

@fragment fn fragmentMain(v: FullscreenOut) -> @location(0) vec4<f32> {
  let dims = textureDimensions(colorTex);
  let p = vec2<i32>(clamp(v.uv * vec2<f32>(dims), vec2<f32>(0.0), vec2<f32>(dims) - 1.0));
  let c = textureLoad(colorTex, p, 0);
  if (c.a <= 0.0) { return vec4<f32>(0.0); }
  // premultiplied linear -> straight -> sRGB -> premultiplied again
  let rgb = srgb_encode(clamp(c.rgb / c.a, vec3<f32>(0.0), vec3<f32>(1.0)));
  return vec4<f32>(rgb * c.a, c.a);
}
`;

export class AlphaPresentCore implements GpuLayerCore {
	readonly passes: readonly PassKind[] = ["screen"];
	readonly order = 100;
	private models = new ModelCache();

	constructor(readonly id = "roll-present") {}

	draw(ctx: PassContext) {
		if (ctx.kind !== "screen" || !ctx.color) return;
		const model = this.models.get(targetKey(ctx), () => {
			return new Model(ctx.device, {
				id: `${this.id}-model`,
				source: ALPHA_PRESENT_WGSL,
				vertexEntryPoint: "fullscreenVertex",
				fragmentEntryPoint: "fragmentMain",
				vertexCount: 3,
				...screenModelProps(ctx.target),
			} as never);
		});
		model.setBindings({ colorTex: ctx.color.color });
		model.draw(ctx.renderPass);
	}

	destroy() {
		this.models.destroy();
	}
}
