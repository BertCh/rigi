// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WebGPU twin of the roll map's "pins" ScatterplotLayer (roll/map/roll-map.ts updateLayers):
// the photo-viewpoint selection pins, `stroked`, `billboard`, radiusUnits / lineWidthUnits
// 'pixels', LogDepthExtension, parameters {depthCompare: 'always', depthWriteEnabled: false}.
// Colour pass only, drawn after everything.
//
// Semantics of deck's scatterplot shader (verified in @deck.gl/layers scatterplot-layer-*.glsl):
//   outer radius = radius + lineWidth / 2        (the stroke straddles radiusPx)
//   inner radius = outer - lineWidth
//   fill → line = mix(fill, line, smoothedge(inner, d)); alpha *= smoothedge(d, outer)
//   smoothedge(edge, x) = smoothstep(edge - 0.5, edge + 0.5, x) (±0.5 px of the target)
//   billboard: the quad is offset in clip space (screen px), anchored at the projected point.
// Sizes are CSS px × pixelRatio (deck scales 'pixels' units by devicePixelRatio). Colours are
// RollPin's 0..255 sRGB RGBA, decoded to linear in the vertex shader (the colour target is linear,
// premultiplied; the compositor encodes sRGB).
//
// WebGL → WebGPU mapping:
//   LogDepthExtension + depthCompare 'always'  → depth "none" (always, no write): the pins ignore
//        and never touch depth, so the log-depth anchor is moot.
//   points behind the camera                   → culled (clip.w < near), as the WebGL clip does.
//
// Wiring:  const pins = createPins(host.device);   // add to host.cores
//          pins.setPins(frame.pins);               // identity-checked: re-uploads only on change
//          pins.setPixelRatio(r)                   // optional; default min(devicePixelRatio, 2)
// Request a colour re-render after setPins (the pins live in the colour pass).
import type { Buffer, Device } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import type { RollPin } from "#/lib/roll/map/backend";
import { cameraModule } from "../camera";
import {
	type GpuLayerCore,
	ModelCache,
	type PassContext,
	type PassKind,
	passModelProps,
} from "../pass";
import { srgbDecodeWGSL } from "../wgsl";
import { PIN_STRIDE_BYTES, packPins } from "./pins-pack";

export { PIN_STRIDE_BYTES, packPins, packRGBA8 } from "./pins-pack";

/** Last in the colour pass: above the atmosphere sky (90), the gizmo (20) and everything else
 * (the WebGL pins layer is the last entry of updateLayers). */
export const PINS_ORDER = 100;

const pinsModule = {
	name: "pins",
	source: /* wgsl */ `\
struct PinsUniforms {
  // x: device px per CSS px, yzw unused
  params: vec4<f32>,
};
@group(0) @binding(auto) var<uniform> pins: PinsUniforms;
`,
	uniformTypes: { params: "vec4<f32>" },
	bindingLayout: [{ name: "pins", group: 0 }],
} as const satisfies ShaderModule;

export const PINS_WGSL = /* wgsl */ `\
struct PinIn {
  @location(0) position: vec3<f32>,
  // x radius (CSS px), y line width (CSS px)
  @location(1) size: vec2<f32>,
  @location(2) fill: vec4<f32>,
  @location(3) line: vec4<f32>,
};

struct PinOut {
  @builtin(position) position: vec4<f32>,
  // device-pixel offset from the pin centre
  @location(0) px: vec2<f32>,
  // x outer radius, y inner radius (device px)
  @location(1) @interpolate(flat) radii: vec2<f32>,
  @location(2) @interpolate(flat) fill: vec4<f32>,
  @location(3) @interpolate(flat) line: vec4<f32>,
};

${srgbDecodeWGSL}
// a position the rasteriser clips away (depth > 1)
const PIN_CULLED: vec4<f32> = vec4<f32>(0.0, 0.0, 2.0, 1.0);

@vertex fn vertexMain(@builtin(vertex_index) vi: u32, i: PinIn) -> PinOut {
  var q = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
                              vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
  let pr = pins.params.x;
  let lw = i.size.y * pr;
  let outer = i.size.x * pr + lw * 0.5;
  // + the smoothedge band (SMOOTH_EDGE_RADIUS 0.5 px) and a pixel of slack
  let ext = outer + 0.5 * pr + 1.0;
  let c = camera_clip(i.position);
  var o: PinOut;
  o.px = q[vi] * ext;
  o.radii = vec2<f32>(outer, outer - lw);
  o.fill = vec4<f32>(srgb_decode(i.fill.rgb), i.fill.a);
  o.line = vec4<f32>(srgb_decode(i.line.rgb), i.line.a);
  // billboard: keep z and w, move xy by the pixel offset (clip = ndc · w)
  let moved = vec4<f32>(c.xy + o.px * 2.0 / camera.viewport * c.w, c.z, c.w);
  o.position = select(moved, PIN_CULLED, c.w < camera.near);
  return o;
}

@fragment fn fragmentMain(v: PinOut) -> @location(0) vec4<f32> {
  let e = 0.5 * pins.params.x;
  let d = length(v.px);
  let inCircle = 1.0 - smoothstep(v.radii.x - e, v.radii.x + e, d);
  if (inCircle <= 0.0) { discard; }
  let isLine = smoothstep(v.radii.y - e, v.radii.y + e, d);
  let c = mix(v.fill, v.line, isLine);
  let a = c.a * inCircle;
  return vec4<f32>(c.rgb * a, a);
}
`;

export class PinCore implements GpuLayerCore {
	readonly passes: readonly PassKind[] = ["color"];
	readonly order = PINS_ORDER;
	private models = new ModelCache();
	private pins: readonly RollPin[] | null = null;
	private buffer: Buffer | null = null;
	private count = 0;
	private pixelRatio: number | null = null;

	constructor(
		readonly device: Device,
		readonly id = "roll-pins",
	) {}

	/** Rebuilds the instance buffer only when the array identity changes. */
	setPins(pins: readonly RollPin[]) {
		if (pins === this.pins) return;
		this.pins = pins;
		this.count = pins.length;
		if (!pins.length) return;
		const data = packPins(pins);
		if (!this.buffer || this.buffer.byteLength < data.byteLength) {
			this.buffer?.destroy();
			this.buffer = this.device.createBuffer({
				id: `${this.id}-instances`,
				data: new Uint8Array(data),
				usage: 0x0020 | 0x0008, // VERTEX | COPY_DST
			});
		} else this.buffer.write(new Uint8Array(data));
	}

	/** Device pixels per CSS pixel of the colour target (default min(devicePixelRatio, 2), the
	 * cap targets.ts applies to the canvas). */
	setPixelRatio(r: number | null) {
		this.pixelRatio = r;
	}

	visible() {
		return this.count > 0 && !!this.buffer;
	}

	draw(ctx: PassContext) {
		if (ctx.kind !== "color" || !this.buffer || !this.visible()) return;
		const pr =
			this.pixelRatio ??
			Math.min(
				(globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1,
				2,
			);
		const model = this.models.get("pins", () => {
			return new Model(ctx.device, {
				id: `${this.id}-model`,
				source: PINS_WGSL,
				vertexEntryPoint: "vertexMain",
				fragmentEntryPoint: "fragmentMain",
				modules: [cameraModule, pinsModule] as never,
				topology: "triangle-list",
				bufferLayout: [
					{
						name: "instances",
						byteStride: PIN_STRIDE_BYTES,
						stepMode: "instance",
						attributes: [
							{ attribute: "position", format: "float32x3", byteOffset: 0 },
							{ attribute: "size", format: "float32x2", byteOffset: 12 },
							{ attribute: "fill", format: "unorm8x4", byteOffset: 20 },
							{ attribute: "line", format: "unorm8x4", byteOffset: 24 },
						],
					},
				],
				isInstanced: true,
				vertexCount: 6,
				instanceCount: 0,
				...passModelProps("color", { depth: "none", blend: true }),
			} as never);
		});
		model.shaderInputs.setProps({
			camera: ctx.camera,
			pins: { params: [pr, 0, 0, 0] },
		} as never);
		model.setAttributes({ instances: this.buffer });
		model.setInstanceCount(this.count);
		model.draw(ctx.renderPass);
	}

	destroy() {
		this.models.destroy();
		this.buffer?.destroy();
		this.buffer = null;
		this.pins = null;
		this.count = 0;
	}
}

/** Factory for the assembler (see the wiring note at the top of the file). */
export function createPins(device: Device, id = "roll-pins"): PinCore {
	return new PinCore(device, id);
}
