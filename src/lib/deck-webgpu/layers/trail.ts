// Hiking trails on WebGPU: the port of deck/trail-layer.ts (itself engine.ts buildTrails + three's
// LineSegments2 / LineMaterial). README.md "Layer contract", port row `layers/trail.ts`.
//
//   pass     colour only (order 10: after the terrain, order 0). Not drawn in the geometry pass
//            (the WebGL path doesn't either); a class-1 write to normal.w is a later decision.
//   shape    one instanced screen-space quad per segment (6 vertices from @builtin(vertex_index),
//            no quad vertex buffer), width in TARGET pixels (the colour target = canvas device
//            pixels, trail.viewport = ctx.target size, like three's LineMaterial resolution),
//            both ends trimmed at the near plane so behind-camera ends never flip.
//   colour   the segment's vertex colour (linear rgb, trailPalette) × style.trails.opacity,
//            output PREMULTIPLIED (rgb·a, a) into the linear colour target with one /
//            one-minus-src-alpha — identical to the WebGL straight-alpha src-alpha blend.
//   depth    reversed-Z, test only (passModelProps('color', {depth: 'test', blend: true})). The
//            WebGL log gl_FragDepth is NOT ported: the vertex depth is nudged toward the camera by
//            a RELATIVE bias, clip.z·(1 + depthBias) → depth = near·(1 + b) / viewDepth, i.e. the
//            trail tests as if (b × its view depth) closer: ~1e-4 → 1 cm at 100 m, 10 m at 100 km,
//            far below the drape lift buildTrailSegments already applies (2 m + 0.06 % of range).
//            An absolute bias would be meaningless at range (reversed-Z depth ~ near / z).
//
// The world view (WebGL: `onCanvas`, sRGB-encoded straight to the canvas) needs no variant here:
// on WebGPU the world view is the colour pass with the world camera, and the compositor encodes.
//
// Wiring (the assembler / engine port):
//   const trails = createTrailCore(device);                 // GpuLayerCore, passes ['color']
//   trails.setSegments(buildTrailSegments(region, frame, at, heightAt, trailPalette(style)));
//   trails.setStyle(style.trails);                          // width px, opacity
//   on style.trails.colors change: trails.setSegments(recolorTrailSegments(seg, trailPalette(style)))
//   trails.setEnabled(look.trails)                          // the style / sidebar toggle
//   cores = [terrain, trails, …] → host (hosts/direct.ts or hosts/deck.ts)
import type { Buffer, Device } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import type { TrailSegments } from "#/lib/deck/trail-layer";
import { cameraModule } from "../camera";
import {
	type GpuLayerCore,
	ModelCache,
	type PassContext,
	type PassKind,
	passModelProps,
} from "../pass";

export type { TrailSegments } from "#/lib/deck/trail-layer";
export {
	buildTrailSegments,
	recolorTrailSegments,
} from "#/lib/deck/trail-layer";

/** style.trails as the layer reads it (ViewStyle['trails'] minus the palette). */
export type TrailStyle = {
	/** Line width in render-target pixels (three / classic: 2.2). */
	width: number;
	/** Line opacity (three / classic: 0.95). */
	opacity: number;
};

export const DEFAULT_TRAIL_STYLE: TrailStyle = { width: 2.2, opacity: 0.95 };

/** Relative depth nudge toward the camera (see the header). */
export const TRAIL_DEPTH_BIAS = 1e-4;

/** Floats per instance in the interleaved buffer: start xyz, end xyz, colour rgb. */
const STRIDE = 9;

export type TrailUniforms = {
	width: number;
	opacity: number;
	depthBias: number;
	nearTrim: number;
	viewport: [number, number];
	pad0: number;
	pad1: number;
};

/** `trail` uniform block: 32 bytes, scalars first so the vec2 lands on offset 16. */
export const trailModule = {
	name: "trail",
	source: /* wgsl */ `\
struct TrailUniforms {
  width: f32,
  opacity: f32,
  depthBias: f32,
  nearTrim: f32,
  viewport: vec2<f32>,
  pad0: f32,
  pad1: f32,
};
@group(0) @binding(auto) var<uniform> trail: TrailUniforms;
`,
	uniformTypes: {
		width: "f32",
		opacity: "f32",
		depthBias: "f32",
		nearTrim: "f32",
		viewport: "vec2<f32>",
		pad0: "f32",
		pad1: "f32",
	},
	bindingLayout: [{ name: "trail", group: 0 }],
} as const satisfies ShaderModule;

export const TRAIL_WGSL = /* wgsl */ `\
struct Instance {
  @location(0) instanceStart: vec3<f32>,
  @location(1) instanceEnd: vec3<f32>,
  @location(2) instanceColor: vec3<f32>,
};

struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec3<f32>,
};

// LineSegments2 quad: x = 0 start / 1 end, y = -1 / +1 across the line (var<private>: indexed
// with a runtime index)
var<private> QUAD = array<vec2<f32>, 6>(
  vec2<f32>(0.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0),
);

@vertex fn vertexMain(@builtin(vertex_index) vi: u32, i: Instance) -> Varyings {
  var o: Varyings;
  o.color = i.instanceColor;
  let corner = QUAD[vi % 6u];
  var a = camera_clip(i.instanceStart);
  var b = camera_clip(i.instanceEnd);
  // trim at the near plane (as LineSegments2 / the WebGL layer) so behind-camera ends don't flip
  let NEAR = trail.nearTrim;
  if (a.w < NEAR && b.w < NEAR) {
    o.position = vec4<f32>(2.0, 2.0, 2.0, 1.0); // outside the clip volume: culled
    return o;
  }
  if (a.w < NEAR) {
    a = mix(a, b, (NEAR - a.w) / (b.w - a.w));
  } else if (b.w < NEAR) {
    b = mix(b, a, (NEAR - b.w) / (a.w - b.w));
  }
  let halfRes = 0.5 * trail.viewport;
  let sa = a.xy / a.w * halfRes;
  let sb = b.xy / b.w * halfRes;
  var dir = sb - sa;
  let len = length(dir);
  dir = select(vec2<f32>(1.0, 0.0), dir / len, len > 1e-6);
  let nrm = vec2<f32>(-dir.y, dir.x);
  var p = select(b, a, corner.x < 0.5);
  // width in target pixels (three: LineMaterial linewidth at resolution = the render target)
  p = vec4<f32>(p.xy + nrm * corner.y * trail.width * 0.5 / halfRes * p.w, p.z, p.w);
  // reversed-Z: a larger depth is closer; relative nudge toward the camera (header)
  p.z = p.z * (1.0 + trail.depthBias);
  o.position = p;
  return o;
}

@fragment fn fragmentMain(v: Varyings) -> @location(0) vec4<f32> {
  // linear rgb (vertex colour), premultiplied into the colour target
  let a = trail.opacity;
  return vec4<f32>(max(v.color, vec3<f32>(0.0)) * a, a);
}
`;

/** The trails as a colour-pass core. */
export class TrailCore implements GpuLayerCore {
	readonly passes: readonly PassKind[] = ["color"];
	/** After the terrain (0), before sky fills (atm-sky / photo-sky draw at depth 0 later anyway). */
	readonly order = 10;
	style: TrailStyle = { ...DEFAULT_TRAIL_STYLE };
	depthBias = TRAIL_DEPTH_BIAS;
	private enabled = true;
	private segments: TrailSegments | null = null;
	private instances: Buffer | null = null;
	private count = 0;
	private models = new ModelCache();
	stats = { segments: 0, drawn: 0, uploadMs: 0 };

	constructor(
		readonly device: Device,
		readonly id = "trails",
	) {}

	/** Replace the segments (null / empty = nothing to draw). Same object → no-op. */
	setSegments(seg: TrailSegments | null) {
		if (seg === this.segments) return;
		const t0 = performance.now();
		this.segments = seg;
		const n = seg?.count ?? 0;
		if (!seg || !n) {
			this.count = 0;
			this.stats.segments = 0;
			return;
		}
		const data = new Float32Array(n * STRIDE);
		for (let i = 0; i < n; i++) {
			const o = i * STRIDE;
			data.set(seg.positions.subarray(i * 6, i * 6 + 6), o);
			data.set(seg.colors.subarray(i * 3, i * 3 + 3), o + 6);
		}
		// reuse the buffer when it is big enough (a recolour keeps the count)
		if (!this.instances || this.instances.byteLength < data.byteLength) {
			this.instances?.destroy();
			this.instances = this.device.createBuffer({
				id: `${this.id}-instances`,
				data,
				usage: 0x0020 | 0x0008, // VERTEX | COPY_DST
			});
		} else this.instances.write(data);
		this.count = n;
		this.stats.segments = n;
		this.stats.uploadMs += performance.now() - t0;
	}

	/** style.trails width / opacity (the palette goes through recolorTrailSegments). */
	setStyle(style: Partial<TrailStyle>) {
		this.style = {
			width: style.width ?? this.style.width,
			opacity: style.opacity ?? this.style.opacity,
		};
	}

	/** The trails toggle (look.trails / world style trails). */
	setEnabled(on: boolean) {
		this.enabled = on;
	}

	visible() {
		return this.enabled && this.count > 0 && this.style.opacity > 0;
	}

	private model() {
		return this.models.get(
			"color",
			() =>
				new Model(this.device, {
					id: `${this.id}-color`,
					source: TRAIL_WGSL,
					modules: [cameraModule, trailModule] as never,
					...passModelProps("color", { depth: "test", blend: true }),
					topology: "triangle-list",
					bufferLayout: [
						{
							name: "instances",
							byteStride: STRIDE * 4,
							stepMode: "instance",
							attributes: [
								{
									attribute: "instanceStart",
									format: "float32x3",
									byteOffset: 0,
								},
								{
									attribute: "instanceEnd",
									format: "float32x3",
									byteOffset: 12,
								},
								{
									attribute: "instanceColor",
									format: "float32x3",
									byteOffset: 24,
								},
							],
						},
					],
					isInstanced: true,
					vertexCount: 6,
					instanceCount: 0,
				} as never),
		);
	}

	/** Uniform values for a pass (exported for checks). */
	uniforms(ctx: Pick<PassContext, "camera" | "target">): TrailUniforms {
		return {
			width: this.style.width,
			opacity: this.style.opacity,
			depthBias: this.depthBias,
			// just past the near plane so the nudged depth stays ≤ 1 (inside the clip volume)
			nearTrim: ctx.camera.near * (1 + Math.max(1e-3, 2 * this.depthBias)),
			viewport: [ctx.target.width, ctx.target.height],
			pad0: 0,
			pad1: 0,
		};
	}

	draw(ctx: PassContext) {
		this.stats.drawn = 0;
		if (ctx.kind !== "color" || !this.instances || !this.visible()) return;
		const model = this.model();
		model.shaderInputs.setProps({
			camera: ctx.camera,
			trail: this.uniforms(ctx),
		} as never);
		model.setAttributes({ instances: this.instances });
		model.setInstanceCount(this.count);
		model.draw(ctx.renderPass);
		this.stats.drawn = this.count;
	}

	destroy() {
		this.models.destroy();
		this.instances?.destroy();
		this.instances = null;
		this.segments = null;
		this.count = 0;
	}
}

/** Factory for the assembler (see the header for wiring). */
export function createTrailCore(device: Device, id = "trails"): TrailCore {
	return new TrailCore(device, id);
}
