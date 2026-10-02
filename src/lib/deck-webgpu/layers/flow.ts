// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Wind-drift particles over the DEM in the WebGPU WORLD view (style.world.wind, default off). LF4 in
// reports/roadmap.md; the field math, the WGSL advection kernel and its CPU twin are in
// look/flow/field.ts (ported from luma.gl #3324's FlowParticleSimulation, MIT, vis.gl contributors).
//
//   field    a uniform wind deflected by the DEM gradient on a 128 x 128 grid over +-15 km around the
//            frame origin (setGrid; the engine samples the heights it already has). The grid is a
//            storage buffer of (vx, vy, valid, height) texels.
//   sim      one compute kernel (FLOW_ADVECT_WGSL) in a one-node ComputeGraph, recorded in prepass()
//            on the colour pass's encoder right before the pass begins: no raw dispatch, nothing is
//            read back, the particle records (x, y, age, generation) stay in one storage buffer.
//   draw     one instanced screen-space streak per particle (6 vertices from @builtin(vertex_index),
//            the instance is the particle id), read straight from the two storage buffers; the head
//            rides FLOW_LIFT_M above the DEM, the tail fades to nothing. Colour pass, depth test only,
//            premultiplied alpha like the trails.
//   time     advance(dt) feeds wall seconds (the engine's tick); under webdriver the engine never
//            ticks, so the layer shows its deterministic warm-up state (FLOW_WARMUP_RUNS fixed runs).
//   WebGL    deck/flow-layer.ts draws the same streaks; WebGL2 has no compute, so look/flow/sim.ts runs
//            the CPU twin of the kernel there (README.md, the layers/flow.ts row).
import { Buffer, type Device } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import { ComputeGraph } from "#/lib/gpu/core/graph";
import { defineKernel } from "#/lib/gpu/core/kernel";
import {
	FLOW_ADVECT_WGSL,
	FLOW_EXTENT_M,
	FLOW_GRID_DIM,
	FLOW_LIFETIME,
	FLOW_LIFT_M,
	FLOW_MAX_PARTICLES,
	FLOW_PARAM_FLOATS,
	FLOW_STREAK_OPACITY,
	FLOW_STREAK_WIDTH,
	FLOW_TAIL_SECONDS,
	FLOW_TIME_SCALE,
	FLOW_WARMUP_RUNS,
	type FlowStepParams,
	type FlowWind,
	flowParticleCount,
	flowStepFor,
	newFlowParticles,
	packFlowParams,
} from "#/lib/look/flow/field";
import { cameraModule } from "../camera";
import {
	type GpuLayerCore,
	ModelCache,
	type PassContext,
	type PassKind,
	type PrepassContext,
	passModelProps,
} from "../pass";

export const FLOW_KERNEL = defineKernel(
	"flow-advect",
	FLOW_ADVECT_WGSL,
	[
		["prm", "uniform"],
		["grid", "read-only-storage"],
		["particles", "storage"],
	],
	{ entryPoint: "advect", group: "flow", label: "flow-advect" },
);

const U = {
	params: Buffer.UNIFORM | Buffer.COPY_DST,
	storage: Buffer.STORAGE | Buffer.COPY_DST,
};
const GRID_BYTES = FLOW_GRID_DIM * FLOW_GRID_DIM * 16;
const PARTICLE_BYTES = FLOW_MAX_PARTICLES * 16;
/** Relative depth nudge toward the camera (as the trails). */
const FLOW_DEPTH_BIAS = 1e-4;
/** Wall seconds one advance() may carry (a long pause must not teleport the particles). */
const MAX_ADVANCE_S = 0.25;

export type FlowStyle = {
	/** Streak width, target pixels. */
	width: number;
	/** Peak alpha. */
	opacity: number;
};
export const DEFAULT_FLOW_STYLE: FlowStyle = {
	width: FLOW_STREAK_WIDTH,
	opacity: FLOW_STREAK_OPACITY,
};

export type FlowUniforms = {
	width: number;
	opacity: number;
	depthBias: number;
	nearTrim: number;
	viewport: [number, number];
	extent: number;
	dim: number;
	lift: number;
	tailScale: number;
	lifetime: number;
	pad: number;
};

/** `flow` uniform block: 48 bytes (the vec2 lands on offset 16). */
export const flowModule = {
	name: "flow",
	source: /* wgsl */ `\
struct FlowUniforms {
  width: f32,
  opacity: f32,
  depthBias: f32,
  nearTrim: f32,
  viewport: vec2<f32>,
  extent: f32,
  dim: f32,
  lift: f32,
  tailScale: f32,
  lifetime: f32,
  pad: f32,
};
@group(0) @binding(auto) var<uniform> flow: FlowUniforms;
`,
	uniformTypes: {
		width: "f32",
		opacity: "f32",
		depthBias: "f32",
		nearTrim: "f32",
		viewport: "vec2<f32>",
		extent: "f32",
		dim: "f32",
		lift: "f32",
		tailScale: "f32",
		lifetime: "f32",
		pad: "f32",
	},
	bindingLayout: [{ name: "flow", group: 0 }],
} as const satisfies ShaderModule;

export const FLOW_DRAW_WGSL = /* wgsl */ `\
@group(0) @binding(auto) var<storage, read> flowGrid: array<vec4<f32>>;
@group(0) @binding(auto) var<storage, read> flowParticles: array<vec4<f32>>;

struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) fade: f32,
};

var<private> QUAD = array<vec2<f32>, 6>(
  vec2<f32>(0.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0),
);

// bilinear (vx, vy, valid, height) at a domain fraction
fn gridAt(p: vec2<f32>) -> vec4<f32> {
  let dim = i32(flow.dim);
  let q = clamp(p, vec2<f32>(0.0), vec2<f32>(1.0)) * (flow.dim - 1.0);
  let lo = vec2<i32>(floor(q));
  let hi = min(lo + vec2<i32>(1), vec2<i32>(dim - 1));
  let f = fract(q);
  let a = flowGrid[lo.y * dim + lo.x];
  let b = flowGrid[lo.y * dim + hi.x];
  let c = flowGrid[hi.y * dim + lo.x];
  let d = flowGrid[hi.y * dim + hi.x];
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
fn enuAt(p: vec2<f32>) -> vec3<f32> {
  let g = gridAt(p);
  return vec3<f32>((p * 2.0 - 1.0) * flow.extent, g.w + flow.lift);
}

@vertex fn vertexMain(@builtin(vertex_index) vi: u32, @builtin(instance_index) id: u32) -> Varyings {
  var o: Varyings;
  o.fade = 0.0;
  o.position = vec4<f32>(2.0, 2.0, 2.0, 1.0); // culled unless it survives below
  let s = flowParticles[id];
  if (s.z < 0.0) { return o; }
  let g = gridAt(s.xy);
  let headEnu = enuAt(s.xy);
  // tail: back along the local wind by tailScale seconds of (display-scaled) travel
  let tailXY = s.xy - g.xy * flow.tailScale / (2.0 * flow.extent);
  let tailEnu = enuAt(tailXY);
  let corner = QUAD[vi % 6u];
  var a = camera_clip(tailEnu);
  var b = camera_clip(headEnu);
  let NEAR = flow.nearTrim;
  if (a.w < NEAR || b.w < NEAR) { return o; }
  let halfRes = 0.5 * flow.viewport;
  let sa = a.xy / a.w * halfRes;
  let sb = b.xy / b.w * halfRes;
  var dir = sb - sa;
  let len = length(dir);
  dir = select(vec2<f32>(1.0, 0.0), dir / len, len > 1e-6);
  let nrm = vec2<f32>(-dir.y, dir.x);
  var p = select(b, a, corner.x < 0.5);
  p = vec4<f32>(p.xy + nrm * corner.y * flow.width * 0.5 / halfRes * p.w, p.z, p.w);
  p.z = p.z * (1.0 + flow.depthBias);
  o.position = p;
  // born and dying particles fade in and out; the tail end of the streak is transparent
  let life = clamp(s.z / flow.lifetime, 0.0, 1.0);
  let envelope = sin(3.14159265 * life);
  o.fade = envelope * select(0.0, 1.0, g.z > 0.5) * select(0.0, 1.0, corner.x > 0.5);
  return o;
}

@fragment fn fragmentMain(v: Varyings) -> @location(0) vec4<f32> {
  let alpha = flow.opacity * v.fade;
  return vec4<f32>(vec3<f32>(0.92, 0.96, 1.0) * alpha, alpha);
}
`;

/** The wind-drift particles as a colour-pass core. */
export class FlowCore implements GpuLayerCore {
	readonly passes: readonly PassKind[] = ["color"];
	/** After the terrain (0) and the trails (10). */
	readonly order = 12;
	style: FlowStyle = { ...DEFAULT_FLOW_STYLE };
	depthBias = FLOW_DEPTH_BIAS;
	private wind: FlowWind | null = null;
	private count = 0;
	private gridBuf: Buffer | null = null;
	private particleBuf: Buffer | null = null;
	private gridData: Float32Array | null = null;
	private gridDirty = false;
	private paramBufs: Buffer[] = [];
	private graph: ComputeGraph<FlowStepParams> | null = null;
	private failed = false;
	private warmed = false;
	private frameN = 0;
	private pendingS = 0;
	private models = new ModelCache();
	stats = { runs: 0, drawn: 0 };

	constructor(
		readonly device: Device,
		readonly id = "flow",
	) {}

	/** style.world.wind (null = off: nothing is built, drawn or stepped). */
	setWind(wind: FlowWind | null) {
		this.wind = wind;
		this.count = wind ? flowParticleCount(wind.density) : 0;
	}

	/** The velocity grid (look/flow buildFlowGrid), for the current wind; null = no field yet. */
	setGrid(grid: Float32Array | null) {
		this.gridData = grid;
		this.gridDirty = !!grid;
	}

	setStyle(style: Partial<FlowStyle>) {
		this.style = { ...this.style, ...style };
	}

	/** Wall seconds since the last tick (the engine's animation clock). */
	advance(dtSeconds: number) {
		this.pendingS = Math.min(this.pendingS + dtSeconds, MAX_ADVANCE_S);
	}

	visible() {
		return !!this.wind && !!this.gridData && this.count > 0 && !this.failed;
	}

	private ensure() {
		if (!this.gridBuf) {
			this.gridBuf = this.device.createBuffer({
				id: `${this.id}-grid`,
				byteLength: GRID_BYTES,
				usage: U.storage,
			});
			this.particleBuf = this.device.createBuffer({
				id: `${this.id}-particles`,
				byteLength: PARTICLE_BYTES,
				usage: U.storage,
				data: newFlowParticles(),
			});
			for (let i = 0; i < FLOW_WARMUP_RUNS + 1; i++)
				this.paramBufs.push(
					this.device.createBuffer({
						id: `${this.id}-prm-${i}`,
						byteLength: FLOW_PARAM_FLOATS * 4,
						usage: U.params,
					}),
				);
		}
		if (!this.graph) {
			const g = new ComputeGraph<FlowStepParams>(this.device, "flow-advect");
			const prm = g.importBuffer(
				"prm",
				FLOW_PARAM_FLOATS * 4,
				undefined,
				U.params,
			);
			const grid = g.importBuffer("grid", GRID_BYTES, undefined, U.storage);
			const particles = g.importBuffer(
				"particles",
				PARTICLE_BYTES,
				undefined,
				U.storage,
			);
			g.addKernel({
				id: "advect",
				spec: FLOW_KERNEL,
				bindings: { prm, grid, particles },
				workgroups: (p) => [Math.max(1, Math.ceil(p.count / 64))],
			});
			g.compile();
			this.graph = g;
		}
		if (this.gridDirty && this.gridData && this.gridBuf) {
			this.gridBuf.write(this.gridData);
			this.gridDirty = false;
		}
	}

	/** Record the advection (the warm-up first, then the ticked time) before the colour pass. */
	prepass(ctx: PrepassContext) {
		if (ctx.kind !== "color" || !this.visible()) return;
		try {
			this.ensure();
			const runs: (FlowStepParams | null)[] = [];
			if (!this.warmed) {
				this.warmed = true;
				// the fixed warm-up, at the largest step: particles spread over their lifetimes
				for (let i = 0; i < FLOW_WARMUP_RUNS; i++)
					runs.push(flowStepFor(1e3, this.count, this.frameN++));
			}
			runs.push(flowStepFor(this.pendingS, this.count, this.frameN));
			this.pendingS = 0;
			let slot = 0;
			for (const step of runs) {
				if (!step) continue;
				this.frameN = (this.frameN + 1) % 65536;
				const prm = this.paramBufs[slot++ % this.paramBufs.length];
				prm.write(packFlowParams(step));
				this.graph?.encode(ctx.commandEncoder, step, {
					prm,
					grid: this.gridBuf as Buffer,
					particles: this.particleBuf as Buffer,
				});
				this.stats.runs++;
			}
		} catch (e) {
			console.warn("[flow] advection failed; wind drift off", e);
			this.failed = true;
		}
	}

	private model() {
		return this.models.get(
			"color",
			() =>
				new Model(this.device, {
					id: `${this.id}-color`,
					source: FLOW_DRAW_WGSL,
					modules: [cameraModule, flowModule] as never,
					...passModelProps("color", { depth: "test", blend: true }),
					topology: "triangle-list",
					bufferLayout: [],
					isInstanced: true,
					vertexCount: 6,
					instanceCount: 1,
				} as never),
		);
	}

	/** Uniform values for a pass (exported for checks). */
	uniforms(ctx: Pick<PassContext, "camera" | "target">): FlowUniforms {
		return {
			width: this.style.width,
			opacity: this.style.opacity,
			depthBias: this.depthBias,
			nearTrim: ctx.camera.near * (1 + Math.max(1e-3, 2 * this.depthBias)),
			viewport: [ctx.target.width, ctx.target.height],
			extent: FLOW_EXTENT_M,
			dim: FLOW_GRID_DIM,
			lift: FLOW_LIFT_M,
			tailScale: FLOW_TIME_SCALE * FLOW_TAIL_SECONDS,
			lifetime: FLOW_LIFETIME,
			pad: 0,
		};
	}

	draw(ctx: PassContext) {
		this.stats.drawn = 0;
		if (ctx.kind !== "color" || !this.visible() || !this.warmed) return;
		if (!this.gridBuf || !this.particleBuf) return;
		const model = this.model();
		model.shaderInputs.setProps({
			camera: ctx.camera,
			flow: this.uniforms(ctx),
		} as never);
		model.setBindings({
			flowGrid: this.gridBuf,
			flowParticles: this.particleBuf,
		} as never);
		model.setInstanceCount(this.count);
		model.draw(ctx.renderPass);
		this.stats.drawn = this.count;
	}

	destroy() {
		this.models.destroy();
		this.graph?.destroy();
		this.graph = null;
		this.gridBuf?.destroy();
		this.particleBuf?.destroy();
		for (const b of this.paramBufs) b.destroy();
		this.gridBuf = this.particleBuf = null;
		this.paramBufs = [];
		this.warmed = false;
	}
}

/** Factory for the assembler. */
export function createFlowCore(device: Device, id = "flow"): FlowCore {
	return new FlowCore(device, id);
}
