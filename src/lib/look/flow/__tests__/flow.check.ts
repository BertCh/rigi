// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check for the wind-drift field math and the advection twin (look/flow/field.ts, no GPU).
// Run: npx tsx src/lib/look/flow/__tests__/flow.check.ts
//   1. wind vector: compass "from" bearings (180 = a south wind blows north)
//   2. deflection: flat ground keeps the wind, cross-slope wind is untouched, up-slope wind loses the
//      component the ground takes (never reversed), a steep wall nearly stops it
//   3. grid: a ridge across a southerly flow deflects it along the ridge flanks; NaN heights mask
//   4. advection: deterministic, stays in the domain and the grid's valid area, drifts downwind,
//      respawns reproducibly, ages out within the lifetime
//   5. kernel: the WGSL parses (luma reflection) with the kernel's binding layout
//   6. FlowSim (the WebGL engine's CPU advection): nothing runs when off, the warm-up equals the
//      WebGPU core's runs exactly, ticks collapse to one substep of the same simulated time, and a
//      16k-particle tick stays cheap
import { getShaderLayoutFromWGSL } from "@luma.gl/webgpu";
import { FLOW_KERNEL } from "../../../deck-webgpu/layers/flow";
import {
	buildFlowGrid,
	deflectWind,
	FLOW_ADVECT_WGSL,
	FLOW_EXTENT_M,
	FLOW_GRID_DIM,
	FLOW_LIFETIME,
	flowHash,
	flowStepFor,
	newFlowParticles,
	sampleFlowVelocity,
	stepFlowParticles,
	windVector,
} from "../field";
import { FlowSim, flowCoarseStep } from "../sim";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) <= e;

// 1. wind vector
{
	const [e, n] = windVector(180, 10);
	check("south wind blows north", near(e, 0, 1e-9) && near(n, 10, 1e-9));
	const [e2, n2] = windVector(270, 10);
	check("west wind blows east", near(e2, 10, 1e-9) && near(n2, 0, 1e-9));
}

// 2. deflection
{
	check("flat keeps wind", deflectWind(3, 4, 0, 0).join() === "3,4");
	const cross = deflectWind(0, 10, 1, 0); // wind north, slope rises east
	check("cross-slope untouched", near(cross[0], 0) && near(cross[1], 10));
	const up = deflectWind(10, 0, 0.5, 0); // wind east straight up a 0.5 slope
	check(
		"up-slope slowed, not reversed",
		up[0] > 0 && up[0] < 10,
		`${up[0].toFixed(2)}`,
	);
	const wall = deflectWind(10, 0, 50, 0);
	check(
		"wall nearly stops it",
		Math.abs(wall[0]) < 0.01,
		`${wall[0].toFixed(4)}`,
	);
	const diag = deflectWind(10, 0, 1, 1); // oblique: turned along the contour
	check(
		"oblique wind is turned, keeps a lateral part",
		diag[1] < 0,
		`${diag.map((v) => v.toFixed(2))}`,
	);
}

// 3. grid over an east-west ridge, wind from the south
const DIM = 33;
const EXTENT = 1600;
const heights = new Float32Array(DIM * DIM);
for (let iy = 0; iy < DIM; iy++)
	for (let ix = 0; ix < DIM; ix++) {
		const y = -EXTENT + (iy * 2 * EXTENT) / (DIM - 1);
		heights[iy * DIM + ix] = 1000 * Math.exp(-((y / 400) ** 2));
	}
{
	const grid = buildFlowGrid(heights, DIM, EXTENT, {
		direction: 180,
		speed: 10,
	});
	const mid = (iy: number) => (iy * DIM + 16) * 4;
	const crest = grid[mid(16) + 1];
	const flank = grid[mid(12) + 1];
	const plain = grid[mid(1) + 1];
	check(
		"north flow on the plain",
		near(plain, 10, 0.05),
		`${plain.toFixed(2)}`,
	);
	check(
		"flow slowed on the windward flank",
		flank < plain && flank > 0,
		`${flank.toFixed(2)}`,
	);
	check("flow recovers on the crest", crest > flank, `${crest.toFixed(2)}`);
	check(
		"valid flag and height carried",
		grid[mid(16) + 2] === 1 && near(grid[mid(16) + 3], 1000, 1e-3),
	);
	const masked = Float32Array.from(heights);
	masked[16 * DIM + 16] = Number.NaN;
	const g2 = buildFlowGrid(masked, DIM, EXTENT, { direction: 180, speed: 10 });
	check(
		"NaN masks the texel and its neighbours",
		g2[(16 * DIM + 16) * 4 + 2] === 0 &&
			g2[(16 * DIM + 17) * 4 + 2] === 0 &&
			g2[(16 * DIM + 20) * 4 + 2] === 1,
	);
	check(
		"masked velocity sample refuses",
		!sampleFlowVelocity(g2, DIM, EXTENT, 0.5, 0.5).ok,
	);
}

// 4. advection
{
	const grid = buildFlowGrid(heights, DIM, EXTENT, {
		direction: 180,
		speed: 10,
	});
	const count = 512;
	const run = () => {
		const s = newFlowParticles(count);
		for (let i = 0; i < 8; i++) {
			const p = flowStepFor(1e3, count, i);
			if (!p) throw new Error("no step");
			// the domain here is the test grid's
			stepFlowParticles(s, grid, { ...p, extentM: EXTENT, dim: DIM });
		}
		return s;
	};
	const a = run();
	const b = run();
	check(
		"deterministic",
		a.every((v, i) => v === b[i]),
	);
	let inside = 0;
	let alive = 0;
	let maxAge = 0;
	for (let i = 0; i < count; i++) {
		const x = a[i * 4];
		const y = a[i * 4 + 1];
		const age = a[i * 4 + 2];
		if (x >= 0 && x <= 1 && y >= 0 && y <= 1) inside++;
		if (age >= 0) alive++;
		maxAge = Math.max(maxAge, age);
	}
	check("all inside the domain", inside === count);
	check("spawned over valid ground", alive === count, `${alive}/${count}`);
	check(
		"ages stay below the lifetime",
		maxAge < FLOW_LIFETIME,
		`${maxAge.toFixed(1)}`,
	);
	// drift: a particle in a uniform northward flow moves +y and never x
	const flat = buildFlowGrid(new Float32Array(DIM * DIM), DIM, EXTENT, {
		direction: 180,
		speed: 10,
	});
	const s = newFlowParticles(1);
	s.set([0.5, 0.2, 0, 1]);
	const p = flowStepFor(0.1, 1, 0);
	if (!p) throw new Error("no step");
	stepFlowParticles(s, flat, { ...p, extentM: EXTENT, dim: DIM });
	const expected = (10 * p.dt * p.substeps) / (2 * EXTENT);
	check(
		"drifts downwind",
		near(s[1] - 0.2, expected, 1e-5) && near(s[0], 0.5, 1e-6),
		`${(s[1] - 0.2).toExponential(2)} vs ${expected.toExponential(2)}`,
	);
	// leaving the domain respawns with the next generation
	const t = newFlowParticles(1);
	t.set([0.5, 0.99999, 5, 3]);
	stepFlowParticles(t, flat, {
		...p,
		extentM: EXTENT,
		dim: DIM,
		substeps: 8,
		dt: 1,
	});
	check("outflow respawns (generation advances)", t[3] === 4, `gen ${t[3]}`);
	const h = flowHash(12345);
	check("hash in [0,1)", h >= 0 && h < 1);
	check("no step for no time", flowStepFor(0, 8, 0) === null);
}

// 5. kernel layout
{
	const layout = getShaderLayoutFromWGSL(FLOW_ADVECT_WGSL);
	const names = (layout?.bindings ?? []).map((b: { name: string }) => b.name);
	check(
		"WGSL parses with the kernel's bindings",
		["prm", "grid", "particles"].every((n) => names.includes(n)) &&
			FLOW_KERNEL.layout.map(([n]) => n).join() === "prm,grid,particles",
		names.join(),
	);
}

// 6. FlowSim
{
	const sim = new FlowSim();
	check("off sim does nothing", !sim.step() && sim.count === 0 && !sim.active);
	sim.setWind({ direction: 180, speed: 10, density: 0.05 });
	check("no grid, no run", !sim.step());
	const count = sim.count;
	// FlowSim runs on the production extent and grid size
	const simGrid = buildFlowGrid(
		new Float32Array(FLOW_GRID_DIM * FLOW_GRID_DIM).fill(1000),
		FLOW_GRID_DIM,
		FLOW_EXTENT_M,
		{ direction: 180, speed: 10 },
	);
	sim.setGrid(simGrid);
	// the WebGPU core's warm-up (layers/flow.ts prepass), replayed on the CPU twin
	const ref2 = newFlowParticles();
	let frameN = 0;
	for (let i = 0; i < 4; i++) {
		const p = flowStepFor(1e3, count, frameN++);
		if (!p) throw new Error("no step");
		frameN = (frameN + 1) % 65536;
		stepFlowParticles(ref2, simGrid, p);
	}
	const before = sim.stateVersion;
	check("warm-up runs on the first step", sim.step() && sim.isWarm);
	let same = true;
	for (let i = 0; i < count * 4; i++)
		if (sim.state[i] !== ref2[i]) same = false;
	check("warm-up equals the WebGPU runs", same);
	check("state version bumps", sim.stateVersion === before + 1);
	check("second step without time is a no-op", !sim.step());
	sim.advance(0.033);
	check("a tick advances", sim.step());
	const due = flowStepFor(0.033, count, 0);
	if (!due) throw new Error("no step");
	const coarse = flowCoarseStep(due);
	check(
		"coarse step keeps the simulated time",
		coarse.substeps === 1 && near(coarse.dt, due.dt * due.substeps, 1e-12),
	);
	sim.advance(100);
	sim.advance(100);
	check("advance is capped", sim.step());
	// cost of a full-density tick
	const big = new FlowSim();
	big.setWind({ direction: 180, speed: 10, density: 1 });
	big.setGrid(simGrid);
	big.step();
	const t0 = performance.now();
	for (let i = 0; i < 20; i++) {
		big.advance(0.033);
		big.step();
	}
	const ms = (performance.now() - t0) / 20;
	check("16k-particle tick is cheap", ms < 6, `${ms.toFixed(2)} ms`);
}

if (failures) {
	console.error(`${failures} check(s) failed`);
	process.exit(1);
}
console.log("flow checks passed");
