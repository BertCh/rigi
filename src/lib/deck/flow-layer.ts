// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) vis.gl contributors
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Wind-drift particles over the DEM for the deck WORLD view (style.world.wind, default off): the WebGL2
// counterpart of deck-webgpu/layers/flow.ts, same look (instanced screen-space streaks riding
// FLOW_LIFT_M above the DEM, the tail fading to nothing, depth-tested, the same colour / width /
// opacity). The field math is look/flow/field.ts (after luma.gl #3324's FlowParticleSimulation, MIT,
// vis.gl contributors). WebGL2 has no compute, so the advection is the CPU twin of the WGSL kernel
// (look/flow/sim.ts FlowSim); this layer uploads its particle records (x, y, age, generation) to a
// dynamic instance buffer when they changed (256 KB at 16384 particles, about 30 Hz) and keeps the
// velocity / height grid in an RGBA32F texture. The vertex shader mirrors FLOW_DRAW_WGSL.
// Drawn straight onto the canvas after the opaque world (like the world trails and the weather: sRGB
// out, straight alpha, no depth write) with the terrain's logarithmic depth per fragment so the
// terrain occludes it. Never in the offscreen colour passes. Nothing is created unless the layer is.
import {
	COORDINATE_SYSTEM,
	Layer,
	type LayerProps,
	project32,
} from "@deck.gl/core";
import { Buffer, type Texture } from "@luma.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import {
	FLOW_EXTENT_M,
	FLOW_GRID_DIM,
	FLOW_LIFETIME,
	FLOW_LIFT_M,
	FLOW_MAX_PARTICLES,
	FLOW_STREAK_COLOR,
	FLOW_STREAK_OPACITY,
	FLOW_STREAK_WIDTH,
	FLOW_TAIL_SECONDS,
	FLOW_TIME_SCALE,
} from "../look/flow/field";
import type { FlowSim } from "../look/flow/sim";
import { currentTerrainPass, LOG_DEPTH_FAR } from "./terrain-layer";

const uniformBlock = /* glsl */ `\
layout(std140) uniform flowUniforms {
  float width;
  float opacity;
  float extent;
  float dim;
  float lift;
  float tailScale;
  float lifetime;
  float logDepthFC;
} flow;
`;

const flowModule = {
	name: "flow",
	vs: uniformBlock,
	fs: uniformBlock,
	uniformTypes: {
		width: "f32",
		opacity: "f32",
		extent: "f32",
		dim: "f32",
		lift: "f32",
		tailScale: "f32",
		lifetime: "f32",
		logDepthFC: "f32",
	},
} as const satisfies ShaderModule;

const vs = /* glsl */ `#version 300 es
#define SHADER_NAME flow-vs
precision highp float;
precision highp int;
uniform highp sampler2D flowGrid; // vx, vy, valid, height; texel (x, y) = grid row y, column x
in vec2 positions;
in vec4 instanceParticle; // x, y (domain fractions), age (s; < 0 = unspawned), generation
out float vFade;
out float vLogW;

// bilinear (vx, vy, valid, height) at a domain fraction
vec4 gridAt(vec2 p) {
  int dim = int(flow.dim);
  vec2 q = clamp(p, vec2(0.0), vec2(1.0)) * (flow.dim - 1.0);
  ivec2 lo = ivec2(floor(q));
  ivec2 hi = min(lo + ivec2(1), ivec2(dim - 1));
  vec2 f = fract(q);
  vec4 a = texelFetch(flowGrid, ivec2(lo.x, lo.y), 0);
  vec4 b = texelFetch(flowGrid, ivec2(hi.x, lo.y), 0);
  vec4 c = texelFetch(flowGrid, ivec2(lo.x, hi.y), 0);
  vec4 d = texelFetch(flowGrid, ivec2(hi.x, hi.y), 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
vec3 enuAt(vec2 p) {
  vec4 g = gridAt(p);
  return vec3((p * 2.0 - 1.0) * flow.extent, g.w + flow.lift);
}

void main() {
  vFade = 0.0;
  vLogW = 1.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // culled unless it survives below
  vec4 s = instanceParticle;
  if (s.z < 0.0) return;
  vec4 g = gridAt(s.xy);
  vec3 headEnu = enuAt(s.xy);
  // tail: back along the local wind by tailScale seconds of (display-scaled) travel
  vec2 tailXY = s.xy - g.xy * flow.tailScale / (2.0 * flow.extent);
  vec3 tailEnu = enuAt(tailXY);
  vec4 pc;
  vec4 a = project_position_to_clipspace(tailEnu, vec3(0.0), vec3(0.0), pc);
  vec4 b = project_position_to_clipspace(headEnu, vec3(0.0), vec3(0.0), pc);
  const float NEAR = 1.0;
  if (a.w < NEAR || b.w < NEAR) return;
  vec2 half_res = 0.5 * project.viewportSize;
  vec2 sa = a.xy / a.w * half_res;
  vec2 sb = b.xy / b.w * half_res;
  vec2 dir = sb - sa;
  float len = length(dir);
  dir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 p = positions.x < 0.5 ? a : b;
  p.xy += nrm * positions.y * flow.width * 0.5 / half_res * p.w;
  gl_Position = p;
  vLogW = 1.0 + max(p.w, 1e-6);
  // born and dying particles fade in and out; the tail end of the streak is transparent
  float life = clamp(s.z / flow.lifetime, 0.0, 1.0);
  vFade = sin(3.14159265 * life) * (g.z > 0.5 ? 1.0 : 0.0) * (positions.x > 0.5 ? 1.0 : 0.0);
}
`;

const STREAK_COLOR = `vec3(${FLOW_STREAK_COLOR.map((c) => c.toFixed(2)).join(", ")})`;

const fs = /* glsl */ `#version 300 es
#define SHADER_NAME flow-fs
precision highp float;
in float vFade;
in float vLogW;
out vec4 fragColor;
void main() {
  float alpha = flow.opacity * vFade;
  if (alpha < 0.003) discard;
  gl_FragDepth = log2(vLogW) * flow.logDepthFC;
  // straight alpha on the canvas (WebGPU writes the same colour premultiplied)
  fragColor = vec4(${STREAK_COLOR}, alpha);
}
`;

const NEAREST = {
	minFilter: "nearest",
	magFilter: "nearest",
	addressModeU: "clamp-to-edge",
	addressModeV: "clamp-to-edge",
} as const;

export type FlowLayerProps = LayerProps & {
	/** The CPU advection and its grid (look/flow/sim.ts); the engine owns and ticks it. */
	sim: FlowSim;
};

/** Wind-drift particles, canvas pass only (the world view's trails and weather do the same). */
export class FlowLayer extends Layer<FlowLayerProps> {
	static layerName = "FlowLayer";
	declare state: {
		model?: Model;
		particles?: Buffer;
		grid?: Texture | null;
		uploadedGrid?: number;
		uploadedState?: number;
	};

	getShaders() {
		return super.getShaders({ vs, fs, modules: [project32, flowModule] });
	}

	initializeState() {
		const device = this.context.device;
		const particles = device.createBuffer({
			id: `${this.props.id}-particles`,
			byteLength: FLOW_MAX_PARTICLES * 16,
			usage: Buffer.VERTEX | Buffer.COPY_DST,
		});
		const model = new Model(device, {
			...this.getShaders(),
			id: this.props.id,
			geometry: new Geometry({
				topology: "triangle-list",
				attributes: {
					positions: {
						size: 2,
						value: new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1]),
					},
				},
			}),
			bufferLayout: [
				{ name: "instanceParticle", format: "float32x4", stepMode: "instance" },
			],
			instanceCount: 0,
		});
		model.setAttributes({ instanceParticle: particles });
		this.setState({
			model,
			particles,
			grid: null,
			uploadedGrid: -1,
			uploadedState: -1,
		});
	}

	finalizeState(context: Parameters<Layer["finalizeState"]>[0]) {
		super.finalizeState(context);
		this.state.model?.destroy();
		this.state.particles?.destroy();
		this.state.grid?.destroy();
	}

	draw() {
		const { model, particles } = this.state;
		const sim = this.props.sim;
		if (!model || !particles || !sim.active || currentTerrainPass() !== null)
			return;
		const grid = sim.grid as Float32Array;
		if (this.state.uploadedGrid !== sim.gridVersion) {
			this.state.grid?.destroy();
			this.state.grid = this.context.device.createTexture({
				id: `${this.props.id}-grid`,
				format: "rgba32float",
				width: FLOW_GRID_DIM,
				height: FLOW_GRID_DIM,
				data: grid,
				sampler: NEAREST,
			});
			this.state.uploadedGrid = sim.gridVersion;
		}
		// the warm-up and the ticked time (CPU), then the records when they changed
		sim.step();
		if (this.state.uploadedState !== sim.stateVersion) {
			particles.write(sim.state.subarray(0, sim.count * 4));
			this.state.uploadedState = sim.stateVersion;
		}
		if (!sim.isWarm) return;
		model.setInstanceCount(sim.count);
		model.shaderInputs.setProps({
			flow: {
				width: FLOW_STREAK_WIDTH,
				opacity: FLOW_STREAK_OPACITY,
				extent: FLOW_EXTENT_M,
				dim: FLOW_GRID_DIM,
				lift: FLOW_LIFT_M,
				tailScale: FLOW_TIME_SCALE * FLOW_TAIL_SECONDS,
				lifetime: FLOW_LIFETIME,
				logDepthFC: 1 / Math.log2(LOG_DEPTH_FAR + 1),
				flowGrid: this.state.grid,
			},
		} as never);
		model.draw(this.context.renderPass);
	}
}

FlowLayer.defaultProps = {
	coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
	pickable: false,
	parameters: {
		cullMode: "none",
		depthWriteEnabled: false,
		depthCompare: "less-equal",
		blend: true,
		blendColorOperation: "add",
		blendColorSrcFactor: "src-alpha",
		blendColorDstFactor: "one-minus-src-alpha",
		blendAlphaOperation: "add",
		blendAlphaSrcFactor: "one",
		blendAlphaDstFactor: "one-minus-src-alpha",
	},
} as never;
