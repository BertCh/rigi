// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import {
	buildFlowGrid,
	deflectWind,
	FLOW_GRID_DIM,
	FLOW_LIFETIME,
	FLOW_MAX_PARTICLES,
	FLOW_MAX_SUBSTEPS,
	FLOW_PARAM_FLOATS,
	FLOW_TIME_STEP,
	flowHash,
	flowParticleCount,
	flowStepFor,
	flowWindFor,
	newFlowParticles,
	packFlowParams,
	sampleFlowHeights,
	sampleFlowVelocity,
	stepFlowParticles,
	windVector,
} from "../flow/field";
import { FLOW_MAX_ADVANCE_S, FlowSim, flowCoarseStep } from "../flow/sim";
import {
	PRECIPITATION_SEED,
	precipitationDrift,
	precipitationFor,
	precipitationPosition,
	precipitationRandom,
} from "../weather/precipitation";

describe("precipitationFor", () => {
	it("is null when off or missing", () => {
		expect(precipitationFor({ mode: "off" } as never)).toBeNull();
		expect(precipitationFor(undefined as never)).toBeNull();
	});
	it("scales particle count with intensity and gives rain streaks, snow none", () => {
		const base = { wind: 4, turbulence: 0 };
		const rain = precipitationFor({
			...base,
			mode: "rain",
			intensity: 0.5,
		} as never);
		const snow = precipitationFor({
			...base,
			mode: "snow",
			intensity: 1,
		} as never);
		expect(rain?.kind).toBe("rain");
		expect(rain?.count).toBe(4500);
		expect(rain?.streakM).toBeGreaterThan(0);
		expect(snow?.count).toBe(7000);
		expect(snow?.streakM).toBe(0);
		expect(snow?.fallSpeed).toBeLessThan(rain?.fallSpeed ?? 0);
		expect(rain?.wind).toEqual([4, 1.4]);
	});
});

describe("precipitation hash and drift", () => {
	it("hash is deterministic, in [0,1), and roughly uniform", () => {
		let sum = 0;
		for (let i = 0; i < 2000; i++) {
			const r = precipitationRandom(i, PRECIPITATION_SEED);
			expect(r).toBeGreaterThanOrEqual(0);
			expect(r).toBeLessThan(1);
			expect(r).toBe(precipitationRandom(i, PRECIPITATION_SEED));
			sum += r;
		}
		expect(sum / 2000).toBeGreaterThan(0.45);
		expect(sum / 2000).toBeLessThan(0.55);
	});
	it("drift stays inside the volume and starts at zero", () => {
		const p = { fallSpeed: 9, wind: [3, -2] as [number, number], volumeM: 400 };
		expect(precipitationDrift(p, 0)).toEqual([0, 0, 0]);
		for (const t of [1, 17.3, 1e5]) {
			const [x, y, z] = precipitationDrift(p, t);
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThan(400);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThan(400);
			expect(z).toBeGreaterThanOrEqual(0);
			expect(z).toBeLessThan(240);
		}
	});
	it("places every particle within half a volume of the camera centre", () => {
		const size: [number, number, number] = [300, 300, 180];
		const center: [number, number, number] = [1234, -987, 55];
		for (let id = 0; id < 300; id++) {
			const p = precipitationPosition(id, center, size, [10, 20, 30]);
			for (let k = 0; k < 3; k++)
				expect(Math.abs(p[k] - center[k])).toBeLessThanOrEqual(
					size[k] / 2 + 1e-9,
				);
		}
	});
	it("a world-anchored lattice: moving the camera by one volume gives the same particle", () => {
		const size: [number, number, number] = [300, 300, 180];
		const a = precipitationPosition(7, [0, 0, 0], size, [0, 0, 0]);
		const b = precipitationPosition(7, [300, 0, 0], size, [0, 0, 0]);
		expect(b[0] - a[0]).toBeCloseTo(300, 9);
		expect(b[1]).toBeCloseTo(a[1], 9);
	});
});

describe("flow wind helpers", () => {
	it("flowWindFor is null unless on with positive speed and density", () => {
		const on = { on: true, direction: 90, speed: 5, density: 0.3 };
		expect(flowWindFor(on)).toEqual({ direction: 90, speed: 5, density: 0.3 });
		expect(flowWindFor({ ...on, on: false })).toBeNull();
		expect(flowWindFor({ ...on, speed: 0 })).toBeNull();
		expect(flowWindFor({ ...on, density: 0 })).toBeNull();
		expect(flowWindFor(undefined as never)).toBeNull();
	});
	it("flowParticleCount clamps density to [1, max]", () => {
		expect(flowParticleCount(0)).toBe(1);
		expect(flowParticleCount(5)).toBe(FLOW_MAX_PARTICLES);
		expect(flowParticleCount(0.5)).toBe(FLOW_MAX_PARTICLES / 2);
	});
	it("windVector blows toward the opposite of the FROM direction", () => {
		const [e, n] = windVector(180, 10); // from the south, blows north
		expect(e).toBeCloseTo(0, 9);
		expect(n).toBeCloseTo(10, 9);
		const [e2, n2] = windVector(90, 4); // from the east, blows west
		expect(e2).toBeCloseTo(-4, 9);
		expect(n2).toBeCloseTo(0, 9);
	});
	it("deflectWind is the identity on flat ground and removes the uphill component", () => {
		expect(deflectWind(3, 4, 0, 0)).toEqual([3, 4]);
		const [vx, vy] = deflectWind(5, 0, 1, 0);
		// tangent to the surface z = x: v . (-gx, -gy, 1)-normal condition vz = gx*vx
		expect(vx).toBeCloseTo(2.5, 12);
		expect(vy).toBe(0);
	});
	it("flowHash is in [0,1) and deterministic", () => {
		const rand = seededRandom(9);
		for (let i = 0; i < 200; i++) {
			const x = Math.floor(rand() * 4294967296);
			const h = flowHash(x);
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThan(1);
			expect(h).toBe(flowHash(x));
		}
	});
	it("packFlowParams is 8 floats", () => {
		const p = flowStepFor(0.1, 5, 7, 3);
		expect(p).not.toBeNull();
		if (!p) return;
		const packed = packFlowParams(p);
		expect(packed.length).toBe(FLOW_PARAM_FLOATS);
		expect(packed[0]).toBe(5);
		expect(packed[5]).toBe(7);
		expect(packed[6]).toBe(3);
	});
});

describe("flowStepFor", () => {
	it("is null for no time and clamps to the substep cap", () => {
		expect(flowStepFor(0, 10, 0)).toBeNull();
		expect(flowStepFor(-1, 10, 0)).toBeNull();
		const long = flowStepFor(100, 10, 70000);
		expect(long?.substeps).toBe(FLOW_MAX_SUBSTEPS);
		expect((long?.dt ?? 0) * (long?.substeps ?? 0)).toBeCloseTo(
			FLOW_TIME_STEP * FLOW_MAX_SUBSTEPS,
			12,
		);
		expect(long?.frame).toBe(70000 % 65536);
	});
	it("flowCoarseStep keeps total simulated time in one substep", () => {
		const s = flowStepFor(0.1, 10, 0);
		if (!s) throw new Error("no step");
		const c = flowCoarseStep(s);
		expect(c.substeps).toBe(1);
		expect(c.dt).toBeCloseTo(s.dt * s.substeps, 12);
	});
});

// A small uniform-wind grid over a flat plane.
const DIM = 8;
const EXTENT = 1000;
const flatGrid = (dir = 270, speed = 100) =>
	buildFlowGrid(new Float32Array(DIM * DIM).fill(50), DIM, EXTENT, {
		direction: dir,
		speed,
	});

describe("buildFlowGrid / sampleFlowVelocity", () => {
	it("flat terrain keeps the wind vector and stores the height", () => {
		const g = flatGrid(270, 10); // from the west, blows east
		expect(g.length).toBe(DIM * DIM * 4);
		expect(g[0]).toBeCloseTo(10, 5);
		expect(g[1]).toBeCloseTo(0, 5);
		expect(g[2]).toBe(1);
		expect(g[3]).toBe(50);
	});
	it("marks texels with NaN height or NaN neighbours invalid", () => {
		const h = new Float32Array(DIM * DIM).fill(0);
		h[3 * DIM + 3] = Number.NaN;
		const g = buildFlowGrid(h, DIM, EXTENT, { direction: 0, speed: 5 });
		expect(g[(3 * DIM + 3) * 4 + 2]).toBe(0);
		expect(g[(3 * DIM + 4) * 4 + 2]).toBe(0);
		expect(g[(5 * DIM + 5) * 4 + 2]).toBe(1);
	});
	it("samples in domain-fraction units and rejects outside or invalid", () => {
		const g = flatGrid(270, 10);
		const s = sampleFlowVelocity(g, DIM, EXTENT, 0.5, 0.5);
		expect(s.ok).toBe(true);
		expect(s.x).toBeCloseTo(10 / (2 * EXTENT), 6);
		expect(sampleFlowVelocity(g, DIM, EXTENT, 1.1, 0.5).ok).toBe(false);
		expect(sampleFlowVelocity(g, DIM, EXTENT, -0.1, 0.5).ok).toBe(false);
	});
});

describe("sampleFlowHeights", () => {
	it("walks the grid south-west first and gives NaN where heightAt has none", () => {
		const frame = {
			toGeo: (e: number, n: number) => ({ lat: n, lon: e }),
			fromGeo: (_la: number, _lo: number, h: number) =>
				[0, 0, h] as [number, number, number],
		};
		const out = sampleFlowHeights(
			frame as never,
			(lat, lon) => (lon > 0 ? null : lat),
			4,
			30,
		);
		expect(out.length).toBe(16);
		expect(out[0]).toBeCloseTo(-30, 5); // lat of the first row
		expect(out[3]).toBeNaN(); // east column, no height
		expect(out[4 * 3]).toBeCloseTo(30, 5);
	});
});

describe("stepFlowParticles", () => {
	const params = (over = {}) => ({
		count: 64,
		dt: 0.05,
		substeps: 4,
		lifetime: FLOW_LIFETIME,
		extentM: EXTENT,
		dim: DIM,
		frame: 0,
		seed: 1,
		...over,
	});
	it("newFlowParticles starts unspawned", () => {
		const s = newFlowParticles(3);
		expect(Array.from(s)).toEqual([0, 0, -1, 0, 0, 0, -1, 0, 0, 0, -1, 0]);
	});
	it("spawns every particle on a valid grid and keeps positions in the domain", () => {
		const grid = flatGrid();
		const state = newFlowParticles(64);
		for (let k = 0; k < 20; k++) {
			stepFlowParticles(state, grid, params({ frame: k }));
			for (let i = 0; i < 64; i++) {
				expect(state[i * 4]).toBeGreaterThanOrEqual(0);
				expect(state[i * 4]).toBeLessThanOrEqual(1);
				expect(state[i * 4 + 1]).toBeGreaterThanOrEqual(0);
				expect(state[i * 4 + 1]).toBeLessThanOrEqual(1);
				expect(state[i * 4 + 2]).toBeGreaterThanOrEqual(0);
			}
		}
	});
	it("is deterministic and advects downwind (east) on a westerly", () => {
		const grid = flatGrid(270, 100);
		const a = newFlowParticles(64);
		const b = newFlowParticles(64);
		stepFlowParticles(a, grid, params());
		stepFlowParticles(b, grid, params());
		expect(Array.from(a)).toEqual(Array.from(b));
		const before = Float32Array.from(a);
		stepFlowParticles(a, grid, params({ frame: 1, substeps: 1 }));
		let moved = 0;
		for (let i = 0; i < 64; i++)
			if (
				a[i * 4 + 3] === before[i * 4 + 3] &&
				a[i * 4 + 2] > before[i * 4 + 2]
			) {
				expect(a[i * 4]).toBeGreaterThan(before[i * 4]);
				expect(a[i * 4 + 1]).toBeCloseTo(before[i * 4 + 1], 5);
				moved++;
			}
		expect(moved).toBeGreaterThan(0);
	});
	it("stays unspawned (age -1) on an all-invalid grid", () => {
		const state = newFlowParticles(8);
		stepFlowParticles(
			state,
			new Float32Array(DIM * DIM * 4),
			params({ count: 8 }),
		);
		for (let i = 0; i < 8; i++) expect(state[i * 4 + 2]).toBe(-1);
	});
});

describe("FlowSim", () => {
	const wind = { direction: 270, speed: 50, density: 0.001 };
	it("is inactive without wind or grid and steps nothing", () => {
		const sim = new FlowSim();
		expect(sim.active).toBe(false);
		expect(sim.step()).toBe(false);
		sim.setWind(wind);
		expect(sim.count).toBe(flowParticleCount(0.001));
		expect(sim.active).toBe(false);
		sim.setWind(null);
		expect(sim.count).toBe(0);
	});
	it("bumps grid version only on change, warms once, then steps pending time", () => {
		const sim = new FlowSim();
		const grid = new Float32Array(FLOW_GRID_DIM * FLOW_GRID_DIM * 4);
		for (let i = 0; i < FLOW_GRID_DIM * FLOW_GRID_DIM; i++) grid[i * 4 + 2] = 1;
		sim.setWind(wind);
		sim.setGrid(grid);
		sim.setGrid(grid);
		expect(sim.gridVersion).toBe(1);
		expect(sim.active).toBe(true);
		expect(sim.isWarm).toBe(false);
		expect(sim.step()).toBe(true);
		expect(sim.isWarm).toBe(true);
		const runsAfterWarm = sim.runs;
		expect(sim.step()).toBe(false); // nothing pending
		sim.advance(10); // clamped to the cap
		expect(sim.step()).toBe(true);
		expect(sim.runs).toBe(runsAfterWarm + 1);
		expect(sim.stateVersion).toBe(2);
		expect(FLOW_MAX_ADVANCE_S).toBeLessThan(10);
	});
});
