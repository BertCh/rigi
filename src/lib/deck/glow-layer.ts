// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Glowing summit markers for the deck photo view (style.labels.glow): additive point sprites drawn
// with luma's `pointGlow` shader module (@luma.gl/shadertools, #3321) in the "screen" view, after
// the composite (layerFilter keeps `screen-*` layers there). The sprite centres are normalised photo
// coordinates (look/labels/glow.ts), so no 3D projection is involved. The WebGPU twin is
// deck-webgpu/layers/glow.ts. Display-only.
import {
	COORDINATE_SYSTEM,
	Layer,
	type LayerProps,
	project32,
	type UpdateParameters,
} from "@deck.gl/core";
import type { Buffer } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { pointGlow, type ShaderModule } from "@luma.gl/shadertools";
import {
	GLOW_STRIDE,
	type GlowMarkers,
	glowUniformsOf,
} from "../look/labels/glow";

const uniformBlock = /* glsl */ `\
layout(std140) uniform glowSpriteUniforms {
  vec4 tint;
  float radiusPx;
  float intensity;
} glowSprite;
`;

const glowSpriteModule = {
	name: "glowSprite",
	vs: uniformBlock,
	fs: uniformBlock,
	uniformTypes: { tint: "vec4<f32>", radiusPx: "f32", intensity: "f32" },
} as const satisfies ShaderModule;

const vs = /* glsl */ `#version 300 es
#define SHADER_NAME glow-sprite-vs
in vec2 corner;
in vec2 instanceUv;
out vec2 vCoord;
void main() {
  vCoord = corner;
  // photo uv (v down) → clip space; the sprite is a pixel-sized quad around it
  vec2 centre = vec2(instanceUv.x * 2.0 - 1.0, 1.0 - instanceUv.y * 2.0);
  vec2 offset = corner * glowSprite.radiusPx * 2.0 * project.devicePixelRatio / project.viewportSize;
  gl_Position = vec4(centre + offset, 0.0, 1.0);
}
`;

const fs = /* glsl */ `#version 300 es
#define SHADER_NAME glow-sprite-fs
precision highp float;
in vec2 vCoord;
out vec4 fragColor;
vec3 srgbEncode(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
}
void main() {
  vec3 radiance = pointGlow_getColor(vCoord, glowSprite.tint.rgb) * glowSprite.intensity;
  // additive into the sRGB-encoded canvas; alpha untouched (blend: src alpha 0, dst alpha 1)
  fragColor = vec4(srgbEncode(radiance), 0.0);
}
`;

export type GlowLayerProps = LayerProps & { markers: GlowMarkers | null };

export class GlowMarkerLayer extends Layer<GlowLayerProps> {
	static layerName = "GlowMarkerLayer";
	declare state: { model?: Model; corners?: Buffer; instances?: Buffer };

	getShaders() {
		return super.getShaders({
			vs,
			fs,
			modules: [project32, pointGlow, glowSpriteModule],
		});
	}

	initializeState() {
		const device = this.context.device;
		const corners = device.createBuffer({
			data: new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
		});
		const model = new Model(device, {
			...this.getShaders(),
			id: this.props.id,
			topology: "triangle-list",
			vertexCount: 6,
			isInstanced: true,
			instanceCount: 0,
			bufferLayout: [
				{ name: "corner", format: "float32x2" },
				{ name: "instanceUv", format: "float32x2", stepMode: "instance" },
			],
		} as never);
		model.setAttributes({ corner: corners });
		this.setState({ model, corners });
		this.upload();
	}

	updateState({ props, oldProps }: UpdateParameters<this>) {
		if (props.markers !== oldProps.markers) this.upload();
	}

	private upload() {
		const pts = this.props.markers?.points;
		this.state.instances?.destroy();
		if (!pts?.length || !this.state.model) {
			this.setState({ instances: undefined });
			return;
		}
		const instances = this.context.device.createBuffer({ data: pts });
		this.state.model.setAttributes({ instanceUv: instances });
		this.setState({ instances });
	}

	finalizeState(context: Parameters<Layer["finalizeState"]>[0]) {
		super.finalizeState(context);
		this.state.model?.destroy();
		this.state.corners?.destroy();
		this.state.instances?.destroy();
	}

	draw() {
		const { model, instances } = this.state;
		const m = this.props.markers;
		if (!model || !instances || !m) return;
		const u = glowUniformsOf(m.look);
		model.setInstanceCount(m.points.length / GLOW_STRIDE);
		model.shaderInputs.setProps({
			pointGlow: u.pointGlow,
			glowSprite: {
				tint: [...u.tint, 1],
				radiusPx: u.radiusPx,
				intensity: u.intensity,
			},
		} as never);
		model.draw(this.context.renderPass);
	}
}

GlowMarkerLayer.defaultProps = {
	coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
	pickable: false,
	parameters: {
		cullMode: "none",
		depthCompare: "always",
		depthWriteEnabled: false,
		blend: true,
		blendColorOperation: "add",
		blendColorSrcFactor: "one",
		blendColorDstFactor: "one",
		blendAlphaOperation: "add",
		blendAlphaSrcFactor: "zero",
		blendAlphaDstFactor: "one",
	},
} as never;
