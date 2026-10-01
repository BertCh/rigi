// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Screen pass stand-in until the compositor port (layers/composite.ts) lands: shows the resolved
// colour target (sRGB-encoded) or a debug view of the geometry targets on the canvas.
//   color     ColorTargets.color, linear → sRGB
//   geometry  range, log-scaled false colour (5 m … 150 km), sky dark blue
//   normal    geometry normal · 0.5 + 0.5
//   depth     the geometry pass's reversed-Z depth (bright = near)
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import {
	type GpuLayerCore,
	ModelCache,
	type PassContext,
	type PassKind,
	screenModelProps,
	targetKey,
} from "./pass";
import { colorWGSL, fullscreenWGSL } from "./wgsl";

export type PresentMode = "color" | "geometry" | "normal" | "depth";
const MODES: Record<PresentMode, number> = {
	color: 0,
	geometry: 1,
	normal: 2,
	depth: 3,
};

const presentModule = {
	name: "present",
	source: /* wgsl */ `\
struct PresentUniforms { mode: f32, pad0: f32, pad1: f32, pad2: f32 };
@group(0) @binding(auto) var<uniform> present: PresentUniforms;
`,
	uniformTypes: { mode: "f32", pad0: "f32", pad1: "f32", pad2: "f32" },
	bindingLayout: [{ name: "present", group: 0 }],
} as const satisfies ShaderModule;

const WGSL = /* wgsl */ `\
${colorWGSL}
${fullscreenWGSL}
@group(0) @binding(auto) var colorTex: texture_2d<f32>;
@group(0) @binding(auto) var geometryTex: texture_2d<f32>;
@group(0) @binding(auto) var normalTex: texture_2d<f32>;
@group(0) @binding(auto) var depthTex: texture_depth_2d;

fn texel(dims: vec2<u32>, uv: vec2<f32>) -> vec2<i32> {
  return vec2<i32>(clamp(uv * vec2<f32>(dims), vec2<f32>(0.0), vec2<f32>(dims) - 1.0));
}

@fragment fn fragmentMain(v: FullscreenOut) -> @location(0) vec4<f32> {
  let mode = i32(present.mode + 0.5);
  let c = textureLoad(colorTex, texel(textureDimensions(colorTex), v.uv), 0);
  let gp = texel(textureDimensions(geometryTex), v.uv);
  let g = textureLoad(geometryTex, gp, 0);
  let n = textureLoad(normalTex, gp, 0);
  let d = textureLoad(depthTex, gp, 0);
  if (mode == 1) {
    if (g.w <= 0.0) { return vec4<f32>(0.05, 0.07, 0.2, 1.0); }
    let t = clamp(log(max(g.w, 5.0) / 5.0) / log(150000.0 / 5.0), 0.0, 1.0);
    let col = mix(mix(vec3<f32>(1.0, 0.95, 0.4), vec3<f32>(0.9, 0.2, 0.3), smoothstep(0.0, 0.5, t)),
                  vec3<f32>(0.2, 0.3, 0.9), smoothstep(0.5, 1.0, t));
    return vec4<f32>(col, 1.0);
  }
  if (mode == 2) { return vec4<f32>(n.xyz * 0.5 + 0.5, 1.0); }
  if (mode == 3) { return vec4<f32>(vec3<f32>(pow(d, 0.25)), 1.0); }
  // premultiplied over black (the compositor puts the photo underneath)
  return vec4<f32>(srgb_encode(c.rgb), 1.0);
}
`;

export class PresentCore implements GpuLayerCore {
	readonly passes: readonly PassKind[] = ["screen"];
	readonly order = 100;
	private models = new ModelCache();
	mode: PresentMode = "color";

	constructor(readonly id = "present") {}

	draw(ctx: PassContext) {
		if (ctx.kind !== "screen" || !ctx.color || !ctx.geometry) return;
		const model = this.models.get(targetKey(ctx), () => {
			const p = screenModelProps(ctx.target);
			return new Model(ctx.device, {
				id: `${this.id}-model`,
				source: WGSL,
				vertexEntryPoint: "fullscreenVertex",
				fragmentEntryPoint: "fragmentMain",
				modules: [presentModule] as never,
				vertexCount: 3,
				...p,
			} as never);
		});
		model.shaderInputs.setProps({
			present: { mode: MODES[this.mode], pad0: 0, pad1: 0, pad2: 0 },
		} as never);
		model.setBindings({
			colorTex: ctx.color.color,
			geometryTex: ctx.geometry.geometry,
			normalTex: ctx.geometry.normal,
			depthTex: ctx.geometry.depth,
		});
		model.draw(ctx.renderPass);
	}

	destroy() {
		this.models.destroy();
	}
}
