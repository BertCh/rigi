// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) vis.gl contributors
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Rain / snow for the deck WORLD view and the landing scenes (style.world.weather, default off): the
// instanced screen-space streaks / flakes of look/weather/precipitation.ts (a port of luma.gl #3325's
// precipitation module, MIT). Drawn straight onto the canvas after the opaque world (like the world
// trails: sRGB out, straight alpha, no depth write) with the terrain's logarithmic depth per fragment
// so the terrain occludes it. Never in the offscreen colour passes, so the photo overlay path never
// sees it. The volume follows the camera; time comes from the clock (frozen under webdriver).
import {
	COORDINATE_SYSTEM,
	Layer,
	type LayerProps,
	project32,
} from "@deck.gl/core";
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import {
	PRECIPITATION_GLSL,
	PRECIPITATION_SEED,
	type Precipitation,
	precipitationDrift,
} from "../look/weather/precipitation";
import { currentTerrainPass, LOG_DEPTH_FAR } from "./terrain-layer";

const uniformBlock = /* glsl */ `\
layout(std140) uniform weatherUniforms {
  vec3 center;
  float kind;
  vec3 size;
  float time;
  vec3 drift;
  float turbulence;
  vec3 tailDir;
  float focal;
  vec4 color;
  float sizeM;
  float streakM;
  float seed;
  float logDepthFC;
} weather;
`;

const weatherModule = {
	name: "weather",
	vs: uniformBlock,
	fs: uniformBlock,
	uniformTypes: {
		center: "vec3<f32>",
		kind: "f32",
		size: "vec3<f32>",
		time: "f32",
		drift: "vec3<f32>",
		turbulence: "f32",
		tailDir: "vec3<f32>",
		focal: "f32",
		color: "vec4<f32>",
		sizeM: "f32",
		streakM: "f32",
		seed: "f32",
		logDepthFC: "f32",
	},
} as const satisfies ShaderModule;

const vs = /* glsl */ `#version 300 es
#define SHADER_NAME weather-vs
${PRECIPITATION_GLSL}
out vec2 vLocal;
out float vAlong;
out float vAlpha;
out float vLogW;
void main() {
  uint id = uint(gl_InstanceID);
  // two triangles: u along the streak (0 head, 1 tail), v across
  const vec2 CORNERS[6] = vec2[6](vec2(0.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0), vec2(0.0, -1.0), vec2(1.0, 1.0), vec2(0.0, 1.0));
  vec2 cn = CORNERS[gl_VertexID];
  float u = cn.x;
  float v = cn.y;
  vec3 head = precipitation_getPosition(id, weather.center, weather.size, weather.drift, weather.turbulence, weather.time, weather.seed);
  float fade = precipitation_getFade(head, weather.center, weather.size);
  vec3 tail = head + weather.tailDir * weather.streakM;
  vec4 pc;
  vec4 a = project_position_to_clipspace(head, vec3(0.0), vec3(0.0), pc);
  vec4 b = project_position_to_clipspace(tail, vec3(0.0), vec3(0.0), pc);
  const float NEAR = 1.0;
  if (a.w < NEAR || b.w < NEAR) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vLogW = 1.0;
    return;
  }
  vec2 half_res = 0.5 * project.viewportSize;
  vec2 sa = a.xy / a.w * half_res;
  vec2 sb = b.xy / b.w * half_res;
  vec2 dir = sb - sa;
  float len = length(dir);
  dir = len > 1e-6 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  // flake radius / streak half-width in px: metres over distance, clamped so far drops stay a sub-pixel haze
  float radius = clamp(weather.sizeM * weather.focal * half_res.y / a.w, 0.35, 6.0);
  float cap = weather.kind > 0.5 ? radius : 0.5;
  vec4 p = u < 0.5 ? a : b;
  vec2 off = dir * (u * 2.0 - 1.0) * cap + nrm * v * radius;
  p.xy += off / half_res * p.w;
  gl_Position = p;
  vLogW = 1.0 + max(p.w, 1e-6);
  vLocal = vec2((u * 2.0 - 1.0), v);
  vAlong = u;
  float rnd = 0.55 + 0.45 * precipitation_random(id * 7u + 5u, weather.seed);
  // sub-pixel drops fade instead of shimmering; the camera's own near field fades in
  float thin = smoothstep(0.35, 0.9, weather.sizeM * weather.focal * half_res.y / a.w);
  vAlpha = weather.color.a * rnd * fade * smoothstep(1.5, 6.0, a.w) * mix(0.35, 1.0, thin);
}
`;

const fs = /* glsl */ `#version 300 es
#define SHADER_NAME weather-fs
precision highp float;
in vec2 vLocal;
in float vAlong;
in float vAlpha;
in float vLogW;
out vec4 fragColor;
void main() {
  float shape = weather.kind > 0.5
    ? 1.0 - smoothstep(0.55, 1.0, length(vLocal))
    : (1.0 - smoothstep(0.3, 1.0, abs(vLocal.y))) * mix(1.0, 0.15, vAlong);
  float a = vAlpha * shape;
  if (a < 0.003) discard;
  gl_FragDepth = log2(vLogW) * weather.logDepthFC;
  // sRGB colour, straight alpha, drawn on the canvas
  fragColor = vec4(weather.color.rgb, a);
}
`;

export type WeatherLayerProps = LayerProps & {
	precipitation: Precipitation;
};

/** Camera-following precipitation, canvas pass only (the world view's gizmo / trails do the same). */
export class WeatherLayer extends Layer<WeatherLayerProps> {
	static layerName = "WeatherLayer";
	declare state: { model?: Model; t0?: number };

	getShaders() {
		return super.getShaders({ vs, fs, modules: [project32, weatherModule] });
	}

	initializeState() {
		const model = new Model(this.context.device, {
			...this.getShaders(),
			id: this.props.id,
			topology: "triangle-list",
			vertexCount: 6,
			bufferLayout: [],
		});
		this.setState({ model, t0: performance.now() });
	}

	finalizeState(context: Parameters<Layer["finalizeState"]>[0]) {
		super.finalizeState(context);
		this.state.model?.destroy();
	}

	draw() {
		const { model, t0 = 0 } = this.state;
		if (!model || currentTerrainPass() !== null) return;
		const p = this.props.precipitation;
		const vp = this.context.viewport;
		// a still frame under webdriver (reproducible screenshots), the clock otherwise
		const still =
			typeof navigator !== "undefined" &&
			(navigator as Navigator & { webdriver?: boolean }).webdriver;
		const t = still ? 12.5 : (performance.now() - t0) / 1000;
		const drift = precipitationDrift(p, t);
		const v = p.volumeM;
		// the streak trails up-wind of the drop: opposite its velocity (wind, -fall)
		const vl = Math.hypot(p.wind[0], p.wind[1], p.fallSpeed) || 1;
		const tailDir: [number, number, number] = [
			-p.wind[0] / vl,
			-p.wind[1] / vl,
			p.fallSpeed / vl,
		];
		model.setInstanceCount(p.count);
		model.shaderInputs.setProps({
			weather: {
				center: Array.from(vp.cameraPosition) as [number, number, number],
				kind: p.kind === "snow" ? 1 : 0,
				size: [v, v, v * 0.6],
				time: t % 3600,
				drift,
				turbulence: p.turbulence,
				tailDir,
				color: p.color,
				focal: vp.projectionMatrix[5],
				sizeM: p.sizeM,
				streakM: p.streakM,
				seed: PRECIPITATION_SEED,
				logDepthFC: 1 / Math.log2(LOG_DEPTH_FAR + 1),
			},
		});
		model.draw(this.context.renderPass);
	}
}

WeatherLayer.defaultProps = {
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
