// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) vis.gl contributors
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Rain / snow in the WebGPU WORLD view (style.world.weather, default off): the instanced screen-space
// streaks / flakes of deck/weather-layer.ts (the GLSL twin), with the particle positions from luma.gl's
// `precipitation` shadertools module (MIT, vis.gl contributors; WGSL `source`, uniform block at
// `@group(3)`). Rigi's world-anchored lattice is reproduced through that module's uniforms
// (look/weather/precipitation.ts lumaUniformsFor: time = 1, the CPU-reduced drift as wind / fall speed,
// turbulence 0, the volume centred on the camera), the wobble is added here with the real time.
//   draw     colour pass only, 6 vertices per particle from @builtin(vertex_index), the instance is
//            the particle id. Depth test against the terrain (reversed-Z, no depth write), premultiplied
//            linear output (the style colour is sRGB: srgb_decode, then rgb * alpha).
//   time     the engine ticks a frame request while weather is on; under webdriver the layer shows the
//            fixed frame t = 12.5 like the GLSL layer.
import type { Device } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import { precipitation } from "@luma.gl/shadertools";
import {
	lumaUniformsFor,
	type Precipitation,
} from "#/lib/look/weather/precipitation";
import { cameraModule } from "../camera";
import {
	type GpuLayerCore,
	ModelCache,
	type PassContext,
	type PassKind,
	passModelProps,
} from "../pass";
import { colorWGSL } from "../wgsl";

/** `weather` uniform block: 48 bytes. */
export type WeatherUniforms = {
	color: [number, number, number, number];
	tailDir: [number, number, number];
	kind: number;
	sizeM: number;
	streakM: number;
	turbulence: number;
	time: number;
};

export const weatherModule = {
	name: "weather",
	source: /* wgsl */ `\
struct WeatherUniforms {
  color: vec4<f32>,
  tailDir: vec3<f32>,
  kind: f32,
  sizeM: f32,
  streakM: f32,
  turbulence: f32,
  time: f32,
};
@group(0) @binding(auto) var<uniform> weather: WeatherUniforms;
`,
	uniformTypes: {
		color: "vec4<f32>",
		tailDir: "vec3<f32>",
		kind: "f32",
		sizeM: "f32",
		streakM: "f32",
		turbulence: "f32",
		time: "f32",
	},
	bindingLayout: [{ name: "weather", group: 0 }],
} as const satisfies ShaderModule;

export const WEATHER_DRAW_WGSL = /* wgsl */ `\
${colorWGSL}
struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) along: f32,
  @location(2) alpha: f32,
};

var<private> CORNERS = array<vec2<f32>, 6>(
  vec2<f32>(0.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0),
);

@vertex fn vertexMain(@builtin(vertex_index) vi: u32, @builtin(instance_index) id: u32) -> Varyings {
  var o: Varyings;
  o.local = vec2<f32>(0.0);
  o.along = 0.0;
  o.alpha = 0.0;
  o.position = vec4<f32>(2.0, 2.0, 2.0, 1.0); // degenerate unless it survives below
  let corner = CORNERS[vi % 6u];
  let u = corner.x;
  let v = corner.y;
  // luma's lattice position (time = 1, turbulence = 0 on its side), plus the wobble with the real time
  var head = precipitation_getPosition(id);
  let rx = precipitation_random(id * 3u);
  let rz = precipitation_random(id * 3u + 2u);
  head.x += weather.turbulence * sin(weather.time * 0.9 + rz * 31.0);
  head.y += weather.turbulence * cos(weather.time * 0.7 + rx * 23.0);
  let fade = precipitation_getFade(head);
  let tail = head + weather.tailDir * weather.streakM;
  let a = camera_clip(head);
  let b = camera_clip(tail);
  let NEAR = 1.0;
  if (a.w < NEAR || b.w < NEAR) { return o; }
  let halfRes = 0.5 * camera.viewport;
  let sa = a.xy / a.w * halfRes;
  let sb = b.xy / b.w * halfRes;
  var dir = sb - sa;
  let len = length(dir);
  dir = select(vec2<f32>(1.0, 0.0), dir / len, len > 1e-6);
  let nrm = vec2<f32>(-dir.y, dir.x);
  // flake radius / streak half-width in px: metres over distance, clamped so far drops stay a sub-pixel haze
  let focal = 1.0 / camera.tanHalfY;
  let raw = weather.sizeM * focal * halfRes.y / a.w;
  let radius = clamp(raw, 0.35, 6.0);
  let cap = select(0.5, radius, weather.kind > 0.5);
  var p = select(b, a, u < 0.5);
  let off = dir * (u * 2.0 - 1.0) * cap + nrm * v * radius;
  p = vec4<f32>(p.xy + off / halfRes * p.w, p.z, p.w);
  o.position = p;
  o.local = vec2<f32>(u * 2.0 - 1.0, v);
  o.along = u;
  let rnd = 0.55 + 0.45 * precipitation_random(id * 7u + 5u);
  // sub-pixel drops fade instead of shimmering; the camera's own near field fades in
  let thin = smoothstep(0.35, 0.9, raw);
  o.alpha = weather.color.a * rnd * fade * smoothstep(1.5, 6.0, a.w) * mix(0.35, 1.0, thin);
  return o;
}

@fragment fn fragmentMain(v: Varyings) -> @location(0) vec4<f32> {
  let shape = select(
    (1.0 - smoothstep(0.3, 1.0, abs(v.local.y))) * mix(1.0, 0.15, v.along),
    1.0 - smoothstep(0.55, 1.0, length(v.local)),
    weather.kind > 0.5);
  let a = v.alpha * shape;
  if (a < 0.003) { discard; }
  return vec4<f32>(srgb_decode(weather.color.rgb) * a, a);
}
`;

/** Animation time (s) for a frame: fixed under webdriver, the clock otherwise. */
function weatherClock(t0: number): number {
	const still =
		typeof navigator !== "undefined" &&
		(navigator as Navigator & { webdriver?: boolean }).webdriver;
	return still ? 12.5 : (performance.now() - t0) / 1000;
}

/** Rain / snow as a colour-pass core. */
export class WeatherCore implements GpuLayerCore {
	readonly passes: readonly PassKind[] = ["color"];
	/** After the terrain (0), the trails (10) and the flow particles (12): blends last. */
	readonly order = 14;
	private precip: Precipitation | null = null;
	private t0 = performance.now();
	private models = new ModelCache();
	stats = { drawn: 0 };

	constructor(
		readonly device: Device,
		readonly id = "weather",
	) {}

	/** style.world.weather -> draw parameters (null = off: nothing is built or drawn). */
	setPrecipitation(p: Precipitation | null) {
		this.precip = p;
	}

	visible() {
		return !!this.precip && this.precip.count > 0;
	}

	private model() {
		return this.models.get(
			"color",
			() =>
				new Model(this.device, {
					id: `${this.id}-color`,
					source: WEATHER_DRAW_WGSL,
					modules: [cameraModule, weatherModule, precipitation] as never,
					...passModelProps("color", { depth: "test", blend: true }),
					topology: "triangle-list",
					bufferLayout: [],
					isInstanced: true,
					vertexCount: 6,
					instanceCount: 1,
				} as never),
		);
	}

	/** Uniform values for a frame at `t` seconds (exported for checks). */
	uniforms(
		p: Precipitation,
		eye: [number, number, number],
		t: number,
	): { weather: WeatherUniforms; precipitation: object } {
		// the streak trails up-wind of the drop: opposite its velocity (wind, -fall)
		const vl = Math.hypot(p.wind[0], p.wind[1], p.fallSpeed) || 1;
		return {
			weather: {
				color: p.color,
				tailDir: [-p.wind[0] / vl, -p.wind[1] / vl, p.fallSpeed / vl],
				kind: p.kind === "snow" ? 1 : 0,
				sizeM: p.sizeM,
				streakM: p.streakM,
				turbulence: p.turbulence,
				time: t % 3600,
			},
			precipitation: lumaUniformsFor(p, eye, t),
		};
	}

	draw(ctx: PassContext) {
		this.stats.drawn = 0;
		const p = this.precip;
		if (ctx.kind !== "color" || !p || !this.visible()) return;
		const model = this.model();
		const u = this.uniforms(
			p,
			[...ctx.camera.eye] as [number, number, number],
			weatherClock(this.t0),
		);
		model.shaderInputs.setProps({ camera: ctx.camera, ...u } as never);
		model.setInstanceCount(p.count);
		model.draw(ctx.renderPass);
		this.stats.drawn = p.count;
	}

	destroy() {
		this.models.destroy();
	}
}

/** Factory for the assembler. */
export function createWeatherCore(device: Device, id = "weather"): WeatherCore {
	return new WeatherCore(device, id);
}
