// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) vis.gl contributors
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Flow particles over the DEM (föhn / wind drift) for the WebGPU world view: the field math and the
// advection step, as a CPU reference plus the WGSL kernel it mirrors.
//
// The advection (midpoint integration on a bilinear velocity grid with a conservative missing-data
// mask, deterministic hash respawn, state records of normalized x, y, age, generation) is ported from
// luma.gl's experimental `FlowParticleSimulation` (visgl/luma.gl #3324, MIT, vis.gl contributors;
// modules/experimental/src/simulation/flow-particle-shaders.ts). Two changes: the pass is a compute
// kernel run through our ComputeGraph (the upstream one is a fullscreen fragment pass into float
// render targets), and the velocity grid is built here from the heights the world view already has:
// a uniform wind deflected by the DEM gradient.
//
// Field. A horizontal wind w blows over a surface of gradient g = (dh/dx, dh/dy). The air cannot
// enter the ground, so its 3D velocity is projected onto the tangent plane (w3 - (w3.n) n, n the
// surface normal); the horizontal part of that is
//     v = w - (w . g) g / (1 + |g|^2)
// Wind across a slope is untouched, wind straight up or down a slope loses the component the ground
// takes (a vertical wall stops it), so the flow goes around and over ridges. Deterministic, no state.
// Display only: it never feeds pose, confidence, measurements or exports.
import type { ViewStyle } from "../../style/types";

/** Particle capacity (the buffer); style density draws a fraction of it. */
export const FLOW_MAX_PARTICLES = 16384;
/** Half extent of the flow domain around the frame origin, metres (the grid spans 2x this). */
export const FLOW_EXTENT_M = 15000;
/** Grid cells per side. */
export const FLOW_GRID_DIM = 128;
/** Maximum simulated seconds per substep; a step runs at most FLOW_MAX_SUBSTEPS of them. */
export const FLOW_TIME_STEP = 1 / 30;
export const FLOW_MAX_SUBSTEPS = 8;
/** Lifetime of a particle in simulated seconds. */
export const FLOW_LIFETIME = 40;
/** Wall seconds to simulated seconds: m/s of wind would be invisible at kilometre scale. */
export const FLOW_TIME_SCALE = 10;
/** Streak length in simulated seconds of travel. */
export const FLOW_TAIL_SECONDS = 1.5;
/** Warm-up before the first frame: runs of FLOW_MAX_SUBSTEPS substeps (deterministic, also under webdriver). */
export const FLOW_WARMUP_RUNS = 4;
/** Height above the ground the particles ride at, metres. */
export const FLOW_LIFT_M = 12;

export type FlowWind = {
	/** Compass degrees the wind blows FROM, clockwise from north (a south föhn is 180). */
	direction: number;
	/** m/s */
	speed: number;
	/** 0..1 of FLOW_MAX_PARTICLES */
	density: number;
};

/** style.world.wind → the wind to simulate; null when off (the layer does nothing). */
export function flowWindFor(w: ViewStyle["world"]["wind"]): FlowWind | null {
	if (!w?.on || w.speed <= 0 || w.density <= 0) return null;
	return { direction: w.direction, speed: w.speed, density: w.density };
}

/** The particles drawn at this density. */
export const flowParticleCount = (density: number) =>
	Math.max(
		1,
		Math.round(FLOW_MAX_PARTICLES * Math.min(Math.max(density, 0), 1)),
	);

/** Wind vector (east, north) m/s, blowing toward the opposite of `direction`. */
export function windVector(direction: number, speed: number): [number, number] {
	const a = (direction * Math.PI) / 180;
	return [-speed * Math.sin(a), -speed * Math.cos(a)];
}

/** Terrain-following deflection of wind (wx, wy) over a surface of gradient (gx, gy). */
export function deflectWind(
	wx: number,
	wy: number,
	gx: number,
	gy: number,
): [number, number] {
	const k = (wx * gx + wy * gy) / (1 + gx * gx + gy * gy);
	return [wx - k * gx, wy - k * gy];
}

/**
 * The velocity grid: dim x dim texels, row-major from the south-west corner (x east, then y north),
 * 4 floats each: vx, vy (m/s), valid (1 / 0) and the surface height h (m, ENU up). `heights` holds
 * the same dim x dim ENU surface heights, NaN where unknown; a texel is invalid where its own height
 * or any neighbour used by the gradient is unknown.
 */
export function buildFlowGrid(
	heights: Float32Array | Float64Array,
	dim: number,
	extentM: number,
	wind: Pick<FlowWind, "direction" | "speed">,
): Float32Array {
	const out = new Float32Array(dim * dim * 4);
	const cell = (2 * extentM) / (dim - 1);
	const [wx, wy] = windVector(wind.direction, wind.speed);
	const at = (ix: number, iy: number) => heights[iy * dim + ix];
	for (let iy = 0; iy < dim; iy++) {
		for (let ix = 0; ix < dim; ix++) {
			const o = (iy * dim + ix) * 4;
			const h = at(ix, iy);
			// one-sided differences at the border, central inside
			const x0 = Math.max(ix - 1, 0);
			const x1 = Math.min(ix + 1, dim - 1);
			const y0 = Math.max(iy - 1, 0);
			const y1 = Math.min(iy + 1, dim - 1);
			const hx0 = at(x0, iy);
			const hx1 = at(x1, iy);
			const hy0 = at(ix, y0);
			const hy1 = at(ix, y1);
			if (
				!Number.isFinite(h) ||
				!Number.isFinite(hx0) ||
				!Number.isFinite(hx1) ||
				!Number.isFinite(hy0) ||
				!Number.isFinite(hy1)
			)
				continue; // zeros: invalid
			const gx = (hx1 - hx0) / ((x1 - x0) * cell);
			const gy = (hy1 - hy0) / ((y1 - y0) * cell);
			const [vx, vy] = deflectWind(wx, wy, gx, gy);
			out[o] = vx;
			out[o + 1] = vy;
			out[o + 2] = 1;
			out[o + 3] = h;
		}
	}
	return out;
}

// ---- the advection kernel and its CPU twin -----------------------------------------------------

/** Kernel parameters, as the uniform block packs them (8 floats). */
export type FlowStepParams = {
	count: number;
	/** simulated seconds per substep */
	dt: number;
	substeps: number;
	lifetime: number;
	extentM: number;
	dim: number;
	/** respawn epoch (frame counter) and seed, whole numbers */
	frame: number;
	seed: number;
};

export const FLOW_PARAM_FLOATS = 8;

export function packFlowParams(p: FlowStepParams): Float32Array {
	return new Float32Array([
		p.count,
		p.dt,
		p.lifetime,
		p.extentM,
		p.dim,
		p.frame,
		p.seed,
		p.substeps,
	]);
}

/** Particle records: x, y in 0..1 over the domain, age (s; negative = no valid spawn yet), generation. */
export function newFlowParticles(count = FLOW_MAX_PARTICLES): Float32Array {
	const out = new Float32Array(count * 4);
	for (let i = 0; i < count; i++) out[i * 4 + 2] = -1;
	return out;
}

/** The WGSL hash (u32 wrap-around), as numbers 0..1. */
export function flowHash(input: number): number {
	let v = input >>> 0;
	v = Math.imul(v ^ (v >>> 16), 2246822519) >>> 0;
	v = Math.imul(v ^ (v >>> 13), 3266489917) >>> 0;
	return ((v ^ (v >>> 16)) >>> 8) / 16777216;
}

type Sample = { x: number; y: number; ok: boolean };

/** Bilinear velocity in domain-fraction units per second; ok = false outside or beside missing data. */
export function sampleFlowVelocity(
	grid: Float32Array,
	dim: number,
	extentM: number,
	px: number,
	py: number,
): Sample {
	const none = { x: 0, y: 0, ok: false };
	if (px < 0 || py < 0 || px > 1 || py > 1) return none;
	const gx = Math.fround(px * (dim - 1));
	const gy = Math.fround(py * (dim - 1));
	const lx = Math.floor(gx);
	const ly = Math.floor(gy);
	const ux = Math.min(lx + 1, dim - 1);
	const uy = Math.min(ly + 1, dim - 1);
	const fx = gx - lx;
	const fy = gy - ly;
	const t = (ix: number, iy: number) => (iy * dim + ix) * 4;
	const a = t(lx, ly);
	const b = t(ux, ly);
	const c = t(lx, uy);
	const d = t(ux, uy);
	if (Math.min(grid[a + 2], grid[b + 2], grid[c + 2], grid[d + 2]) < 0.5)
		return none;
	const mix = (p: number, q: number, f: number) => p + (q - p) * f;
	const vx = mix(mix(grid[a], grid[b], fx), mix(grid[c], grid[d], fx), fy);
	const vy = mix(
		mix(grid[a + 1], grid[b + 1], fx),
		mix(grid[c + 1], grid[d + 1], fx),
		fy,
	);
	const size = 2 * extentM;
	return { x: vx / size, y: vy / size, ok: true };
}

/** One particle's respawn record (upstream spawnParticle). */
function spawnFlowParticle(
	grid: Float32Array,
	p: FlowStepParams,
	id: number,
	iteration: number,
	generation: number,
): [number, number, number, number] {
	const seed =
		(Math.imul(id, 747796405) +
			(p.seed >>> 0) +
			Math.imul(p.frame >>> 0, 2891336453) +
			Math.imul(iteration, 277803737)) >>>
		0;
	const x = flowHash(seed);
	const y = flowHash((seed + 1013904223) >>> 0);
	const valid = sampleFlowVelocity(grid, p.dim, p.extentM, x, y).ok;
	const age = valid
		? generation === 0
			? flowHash((seed + 12345) >>> 0) * p.lifetime
			: 0
		: -1;
	return [x, y, age, (generation + 1) % 65536];
}

/**
 * The CPU twin of FLOW_ADVECT_WGSL: advance `state` (in place) by `p.substeps` midpoint substeps of
 * `p.dt` seconds. The WGSL is the same arithmetic in f32; this uses Math.fround at the places that
 * matter for a node check, not for bit parity.
 */
export function stepFlowParticles(
	state: Float32Array,
	grid: Float32Array,
	p: FlowStepParams,
): void {
	for (let id = 0; id < p.count; id++) {
		const o = id * 4;
		let px = state[o];
		let py = state[o + 1];
		let age = state[o + 2];
		let gen = state[o + 3];
		for (let it = 0; it < FLOW_MAX_SUBSTEPS; it++) {
			if (it >= p.substeps) break;
			const v1 = sampleFlowVelocity(grid, p.dim, p.extentM, px, py);
			const mx = px + v1.x * p.dt * 0.5;
			const my = py + v1.y * p.dt * 0.5;
			const v2 = sampleFlowVelocity(grid, p.dim, p.extentM, mx, my);
			const dx = px + v2.x * p.dt;
			const dy = py + v2.y * p.dt;
			if (
				age < 0 ||
				age + p.dt >= p.lifetime ||
				!v1.ok ||
				!v2.ok ||
				!sampleFlowVelocity(grid, p.dim, p.extentM, dx, dy).ok
			) {
				[px, py, age, gen] = spawnFlowParticle(grid, p, id, it, gen);
			} else {
				px = dx;
				py = dy;
				age += p.dt;
			}
		}
		state[o] = px;
		state[o + 1] = py;
		state[o + 2] = age;
		state[o + 3] = gen;
	}
}

/** Step parameters for `dtSeconds` of wall time: clamped to eight substeps, scaled for display. */
export function flowStepFor(
	dtSeconds: number,
	count: number,
	frame: number,
	seed = 1,
): FlowStepParams | null {
	const simulated = Math.min(
		Math.max(dtSeconds, 0) * FLOW_TIME_SCALE,
		FLOW_TIME_STEP * FLOW_MAX_SUBSTEPS,
	);
	const substeps = Math.ceil(simulated / FLOW_TIME_STEP);
	if (substeps <= 0) return null;
	return {
		count,
		dt: simulated / substeps,
		substeps,
		lifetime: FLOW_LIFETIME,
		extentM: FLOW_EXTENT_M,
		dim: FLOW_GRID_DIM,
		frame: frame % 65536,
		seed,
	};
}

/** Particle position (ENU metres) of a record. */
export const flowPositionM = (nx: number, ny: number, extentM: number) =>
	[(nx * 2 - 1) * extentM, (ny * 2 - 1) * extentM] as const;

export const FLOW_ADVECT_WGSL = /* wgsl */ `\
struct FlowParams {
  a: vec4<f32>, // count, dt, lifetime, extentM
  b: vec4<f32>, // dim, frame, seed, substeps
};
@group(0) @binding(0) var<uniform> prm: FlowParams;
@group(0) @binding(1) var<storage, read> grid: array<vec4<f32>>; // vx, vy, valid, h
@group(0) @binding(2) var<storage, read_write> particles: array<vec4<f32>>;

fn hashNumber(input: u32) -> f32 {
  var value = input;
  value = (value ^ (value >> 16u)) * 2246822519u;
  value = (value ^ (value >> 13u)) * 3266489917u;
  return f32((value ^ (value >> 16u)) >> 8u) / 16777216.0;
}
// velocity in domain fractions per second, z = 1 when valid
fn sampleVelocity(position: vec2<f32>) -> vec3<f32> {
  if (any(position < vec2<f32>(0.0)) || any(position > vec2<f32>(1.0))) { return vec3<f32>(0.0); }
  let dim = i32(prm.b.x);
  let dimensions = vec2<i32>(dim, dim);
  let gridPosition = position * f32(dim - 1);
  let lower = vec2<i32>(floor(gridPosition));
  let upper = min(lower + vec2<i32>(1), dimensions - vec2<i32>(1));
  let fraction = fract(gridPosition);
  let lowerLeft = grid[lower.y * dim + lower.x];
  let lowerRight = grid[lower.y * dim + upper.x];
  let upperLeft = grid[upper.y * dim + lower.x];
  let upperRight = grid[upper.y * dim + upper.x];
  // Conservative mask: do not interpolate across a missing-data cell.
  if (min(min(lowerLeft.z, lowerRight.z), min(upperLeft.z, upperRight.z)) < 0.5) {
    return vec3<f32>(0.0);
  }
  let velocity = mix(mix(lowerLeft.xy, lowerRight.xy, fraction.x),
    mix(upperLeft.xy, upperRight.xy, fraction.x), fraction.y);
  return vec3<f32>(velocity / (2.0 * prm.a.w), 1.0);
}
fn spawnParticle(identifier: u32, iteration: u32, generation: f32) -> vec4<f32> {
  let seed = identifier * 747796405u + u32(prm.b.z) + u32(prm.b.y) * 2891336453u + iteration * 277803737u;
  let position = vec2<f32>(hashNumber(seed), hashNumber(seed + 1013904223u));
  let valid = sampleVelocity(position).z > 0.5;
  return vec4<f32>(position, select(-1.0, select(0.0, hashNumber(seed + 12345u) * prm.a.z, generation == 0.0), valid), (generation + 1.0) % 65536.0);
}

@compute @workgroup_size(64)
fn advect(@builtin(global_invocation_id) gid: vec3<u32>) {
  let identifier = gid.x;
  if (identifier >= u32(prm.a.x)) { return; }
  var particle = particles[identifier];
  let dt = prm.a.y;
  for (var iteration = 0u; iteration < 8u; iteration++) {
    if (iteration >= u32(prm.b.w)) { break; }
    let firstVelocity = sampleVelocity(particle.xy);
    let midpoint = particle.xy + firstVelocity.xy * dt * 0.5;
    let midpointVelocity = sampleVelocity(midpoint);
    let destination = particle.xy + midpointVelocity.xy * dt;
    if (particle.z < 0.0 || particle.z + dt >= prm.a.z ||
        firstVelocity.z < 0.5 || midpointVelocity.z < 0.5 || sampleVelocity(destination).z < 0.5) {
      particle = spawnParticle(identifier, iteration, particle.w);
    } else {
      particle = vec4<f32>(destination, particle.z + dt, particle.w);
    }
  }
  particles[identifier] = particle;
}
`;
