// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The CPU advection of the wind-drift particles, for the WebGL engine (deck/flow-layer.ts). The WebGPU
// engine advects on the GPU through a ComputeGraph kernel (deck-webgpu/layers/flow.ts); WebGL2 has no
// compute device, and 16384 particles at ~30 Hz is small enough for the CPU twin of that kernel
// (field.ts stepFlowParticles, allocation free), so this is the WebGL fallback for a GPU path, not a
// new CPU path: AGENTS.md wants GPU work in the graph, which a WebGL context cannot host.
//
// Cost (node, 16384 particles, the sine-hills grid of the check): one substep of the largest step
// takes about 1.6 ms, eight take about 12 ms. The ticked time therefore runs as ONE midpoint substep
// of the same total simulated seconds (at most 0.27 s of travel at ~10 m/s is under a fiftieth of a
// grid cell, so the integration error is nil); the one-off warm-up uses the exact WebGPU runs so the
// fixed webdriver / reduced-motion state matches between the engines.
//
// Same clock rules as the WebGPU core: advance() accumulates wall seconds (capped), nothing ticks under
// webdriver, and the first draw runs the fixed warm-up (FLOW_WARMUP_RUNS runs, deterministic).
import {
	FLOW_WARMUP_RUNS,
	type FlowStepParams,
	type FlowWind,
	flowParticleCount,
	flowStepFor,
	newFlowParticles,
	stepFlowParticles,
} from "./field";

/** Wall seconds one advance() may carry (a long pause must not teleport the particles). */
export const FLOW_MAX_ADVANCE_S = 0.25;

/** One ticked step collapsed into a single substep of the same total simulated time. */
export function flowCoarseStep(step: FlowStepParams): FlowStepParams {
	return { ...step, dt: step.dt * step.substeps, substeps: 1 };
}

export class FlowSim {
	/** Particle records: x, y (domain fractions), age (s; < 0 = unspawned), generation. */
	readonly state = newFlowParticles();
	count = 0;
	grid: Float32Array | null = null;
	/** Bumped when `state` changed / a new grid arrived (the layer re-uploads on a change). */
	stateVersion = 0;
	gridVersion = 0;
	/** Substeps the sim has run (checks and stats). */
	runs = 0;
	private wind: FlowWind | null = null;
	private warmed = false;
	private frameN = 0;
	private pendingS = 0;

	setWind(wind: FlowWind | null) {
		this.wind = wind;
		this.count = wind ? flowParticleCount(wind.density) : 0;
	}

	setGrid(grid: Float32Array | null) {
		if (grid === this.grid) return;
		this.grid = grid;
		this.gridVersion++;
	}

	get active() {
		return !!this.wind && !!this.grid && this.count > 0;
	}

	get isWarm() {
		return this.warmed;
	}

	/** Wall seconds since the last tick. */
	advance(dtSeconds: number) {
		this.pendingS = Math.min(this.pendingS + dtSeconds, FLOW_MAX_ADVANCE_S);
	}

	/**
	 * Run what is due: the fixed warm-up once (the same runs and frame counters as the WebGPU core's
	 * prepass), then the pending ticked time. True when `state` changed.
	 */
	step(): boolean {
		if (!this.active || !this.grid) return false;
		let changed = false;
		if (!this.warmed) {
			this.warmed = true;
			for (let i = 0; i < FLOW_WARMUP_RUNS; i++) {
				const warm = flowStepFor(1e3, this.count, this.frameN++);
				if (!warm) continue;
				this.frameN = (this.frameN + 1) % 65536; // as the WebGPU loop does per recorded run
				stepFlowParticles(this.state, this.grid, warm);
				this.runs++;
			}
			changed = true;
		}
		const due = flowStepFor(this.pendingS, this.count, this.frameN);
		this.pendingS = 0;
		if (due) {
			this.frameN = (this.frameN + 1) % 65536;
			stepFlowParticles(this.state, this.grid, flowCoarseStep(due));
			this.runs++;
			changed = true;
		}
		if (changed) this.stateVersion++;
		return changed;
	}
}
