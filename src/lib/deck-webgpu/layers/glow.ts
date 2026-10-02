// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WebGPU twin of deck/glow-layer.ts: glowing summit markers (style.labels.glow) as additive point
// sprites in the screen pass, after the composite (order 50), shaded by luma's `pointGlow` module
// (@luma.gl/shadertools, #3321). Photo view only; centres are normalised photo coordinates
// (look/labels/glow.ts). Output: sRGB-encoded radiance added into the canvas, alpha untouched.
// Wiring: const glow = createGlowCore(device); host.cores.push(new ViewGate(glow, view, inPhoto));
//   glow.setMarkers(markers | null); the engine requests a "screen" frame after a change.
import type { Buffer, Device, RenderPipelineParameters } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { pointGlow, type ShaderModule } from "@luma.gl/shadertools";
import {
	GLOW_STRIDE,
	type GlowMarkers,
	glowUniformsOf,
} from "#/lib/look/labels/glow";
import {
	type GpuLayerCore,
	ModelCache,
	type PassContext,
	type PassKind,
	screenModelProps,
	targetKey,
} from "../pass";
import { srgbEncodeWGSL } from "../wgsl";

export const GLOW_ORDER = 50;

export const glowSpriteModule = {
	name: "glowSprite",
	source: /* wgsl */ `\
struct GlowSpriteUniforms {
  tint: vec4<f32>,
  // x: radius (device px), y: intensity, zw: viewport (device px)
  params: vec4<f32>,
};
@group(0) @binding(auto) var<uniform> glowSprite: GlowSpriteUniforms;
`,
	uniformTypes: { tint: "vec4<f32>", params: "vec4<f32>" },
	bindingLayout: [{ name: "glowSprite", group: 0 }],
} as const satisfies ShaderModule;

export const GLOW_WGSL = /* wgsl */ `\
struct GlowOut {
  @builtin(position) position: vec4<f32>,
  @location(0) coord: vec2<f32>,
};

@vertex fn vertexMain(
  @builtin(vertex_index) vi: u32,
  @location(0) uv: vec2<f32>,
) -> GlowOut {
  var q = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
                              vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0));
  let corner = q[vi];
  let centre = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  var o: GlowOut;
  o.position = vec4<f32>(centre + corner * glowSprite.params.x * 2.0 / glowSprite.params.zw, 0.0, 1.0);
  o.coord = corner;
  return o;
}

${srgbEncodeWGSL}
@fragment fn fragmentMain(v: GlowOut) -> @location(0) vec4<f32> {
  let radiance = pointGlow_getColor(v.coord, glowSprite.tint.rgb) * glowSprite.params.y;
  return vec4<f32>(srgb_encode(radiance), 0.0);
}
`;

/** Additive colour, destination alpha kept. */
export const GLOW_BLEND = {
	blend: true,
	blendColorOperation: "add",
	blendColorSrcFactor: "one",
	blendColorDstFactor: "one",
	blendAlphaOperation: "add",
	blendAlphaSrcFactor: "zero",
	blendAlphaDstFactor: "one",
} as const;

export class GlowCore implements GpuLayerCore {
	readonly passes: readonly PassKind[] = ["screen"];
	readonly order = GLOW_ORDER;
	private markers: GlowMarkers | null = null;
	private instances: Buffer | null = null;
	private count = 0;
	private models = new ModelCache();
	/** Device pixels per CSS pixel of the canvas (default min(devicePixelRatio, 2), targets.ts). */
	pixelRatio: number | null = null;

	constructor(
		readonly device: Device,
		readonly id = "glow-markers",
	) {}

	setMarkers(m: GlowMarkers | null) {
		this.markers = m;
		const pts = m?.points;
		this.count = pts ? pts.length / GLOW_STRIDE : 0;
		if (!pts?.length) return;
		if (!this.instances || this.instances.byteLength < pts.byteLength) {
			this.instances?.destroy();
			this.instances = this.device.createBuffer({
				id: `${this.id}-instances`,
				data: pts,
				usage: 0x0020 | 0x0008, // VERTEX | COPY_DST
			});
		} else this.instances.write(pts);
	}

	visible() {
		return !!this.markers && this.count > 0;
	}

	/** Uniform values for a target (exported for checks). */
	uniforms(width: number, height: number) {
		const m = this.markers;
		if (!m) return null;
		const u = glowUniformsOf(m.look);
		const pr =
			this.pixelRatio ??
			Math.min(
				(globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1,
				2,
			);
		return {
			pointGlow: u.pointGlow,
			glowSprite: {
				tint: [...u.tint, 1],
				params: [u.radiusPx * pr, u.intensity, width, height],
			},
		};
	}

	draw(ctx: PassContext) {
		if (ctx.kind !== "screen" || !this.instances || !this.visible()) return;
		const u = this.uniforms(ctx.target.width, ctx.target.height);
		if (!u) return;
		const model = this.models.get(targetKey(ctx), () => {
			const p = screenModelProps(ctx.target);
			return new Model(ctx.device, {
				id: `${this.id}-model`,
				source: GLOW_WGSL,
				vertexEntryPoint: "vertexMain",
				fragmentEntryPoint: "fragmentMain",
				modules: [pointGlow, glowSpriteModule] as never,
				topology: "triangle-list",
				bufferLayout: [
					{
						name: "instances",
						byteStride: GLOW_STRIDE * 4,
						stepMode: "instance",
						attributes: [
							{ attribute: "uv", format: "float32x2", byteOffset: 0 },
						],
					},
				],
				isInstanced: true,
				vertexCount: 6,
				instanceCount: 0,
				...p,
				parameters: {
					...p.parameters,
					...GLOW_BLEND,
				} as RenderPipelineParameters,
			} as never);
		});
		model.shaderInputs.setProps(u as never);
		model.setAttributes({ instances: this.instances });
		model.setInstanceCount(this.count);
		model.draw(ctx.renderPass);
	}

	destroy() {
		this.models.destroy();
		this.instances?.destroy();
		this.instances = null;
		this.markers = null;
		this.count = 0;
	}
}

export function createGlowCore(device: Device, id = "glow-markers"): GlowCore {
	return new GlowCore(device, id);
}
