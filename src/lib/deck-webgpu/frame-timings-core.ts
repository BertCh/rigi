// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure logic of the per-render-pass GPU frame timings (frame-timings.ts), with no GPU or luma
// import so a node check can drive it. The design follows deck.gl PR #10778's FrameTimer (a small
// pool of timestamp query sets, a cap on timed passes, drop rather than stall, abort on a failed
// readback), written for Rigi's own passes: the geometry and colour passes run from an effect's
// preRender, which deck's own timer never sees.

/** Passes timed per frame (two query slots each). A frame with more passes is dropped whole. */
export const MAX_TIMED_PASSES = 32;
/** Query sets in the ring, i.e. frames whose timestamps may await readback at once. */
export const QUERY_RING_SIZE = 4;
/** Frames the rolling mean covers. */
export const MEAN_WINDOW = 60;

export type PassTiming = { name: string; gpuMs: number };
export type FrameTimings = {
	/** The host's frame counter when the frame was recorded. */
	frame: number;
	passes: PassTiming[];
	/** Sum of the timed passes (idle gaps between passes are not included). */
	totalGpuMs: number;
	/** Where the sample comes from: Rigi's own passes (default) or deck.gl's `_onFrameTimings`. */
	source?: "rigi" | "deck";
	/** Deck samples only: deck's CPU time for the draw. */
	cpuMs?: number;
};

/** A timed pass: where its two timestamps go. */
export type PassSlot<Q> = {
	querySet: Q;
	beginIndex: number;
	endIndex: number;
};

/** One in-flight frame: the claimed query set and the passes recorded into it. */
export type FrameLease<Q> = {
	frame: number;
	querySet: Q;
	passNames: string[];
	/** True once a pass beyond the cap was requested: the sample would under-report, so it is dropped. */
	overflowed: boolean;
};

/**
 * A ring of query sets. `begin` claims a free one (creating up to `size`) or returns null while
 * every set still awaits readback, so a frame is dropped instead of a frame stalling on a map.
 */
export class QueryRing<Q> {
	private free: Q[] = [];
	private created = 0;
	private readonly size: number;
	private readonly maxPasses: number;

	constructor(
		private readonly create: () => Q,
		private readonly destroy: (querySet: Q) => void,
		options: { size?: number; maxPasses?: number } = {},
	) {
		this.size = options.size ?? QUERY_RING_SIZE;
		this.maxPasses = options.maxPasses ?? MAX_TIMED_PASSES;
	}

	begin(frame: number): FrameLease<Q> | null {
		let querySet = this.free.pop();
		if (querySet === undefined) {
			if (this.created >= this.size) return null;
			querySet = this.create();
			this.created++;
		}
		return { frame, querySet, passNames: [], overflowed: false };
	}

	/** The slot for the frame's next pass, or null past the cap (the frame is then dropped). */
	nextPass(lease: FrameLease<Q>, name: string): PassSlot<Q> | null {
		if (lease.overflowed) return null;
		if (lease.passNames.length >= this.maxPasses) {
			lease.overflowed = true;
			return null;
		}
		const beginIndex = lease.passNames.length * 2;
		lease.passNames.push(name);
		return { querySet: lease.querySet, beginIndex, endIndex: beginIndex + 1 };
	}

	/** Give the set back after a completed readback (or an unused frame). */
	release(lease: FrameLease<Q>) {
		this.free.push(lease.querySet);
	}

	/** Destroy a set whose readback failed: unread results may still be queued in it. */
	discard(lease: FrameLease<Q>) {
		this.destroy(lease.querySet);
		this.created--;
	}

	destroyAll() {
		for (const querySet of this.free) this.destroy(querySet);
		this.free = [];
	}

	/** Sets created and not currently free (in flight), for the check. */
	get inFlight() {
		return this.created - this.free.length;
	}
}

/** Pass durations for a lease, in pass order; sets frame totals. Non-finite or negative durations are 0. */
export function buildFrameTimings(
	lease: { frame: number; passNames: readonly string[] },
	durationsMs: readonly number[],
): FrameTimings {
	const passes = lease.passNames.map((name, i) => {
		const ms = durationsMs[i];
		return { name, gpuMs: Number.isFinite(ms) && ms > 0 ? ms : 0 };
	});
	return {
		frame: lease.frame,
		passes,
		totalGpuMs: passes.reduce((sum, p) => sum + p.gpuMs, 0),
	};
}

/** Rolling mean per pass name (over the last `window` frames each name appeared in) and for the total. */
export class RollingFrameMean {
	private perPass = new Map<string, number[]>();
	private totals: number[] = [];

	constructor(private readonly window = MEAN_WINDOW) {}

	add(timings: FrameTimings) {
		push(this.totals, timings.totalGpuMs, this.window);
		// the same name twice in a frame (two passes of one kind) counts as one summed sample
		const sums = new Map<string, number>();
		for (const p of timings.passes)
			sums.set(p.name, (sums.get(p.name) ?? 0) + p.gpuMs);
		for (const [name, ms] of sums) {
			let samples = this.perPass.get(name);
			if (!samples) {
				samples = [];
				this.perPass.set(name, samples);
			}
			push(samples, ms, this.window);
		}
	}

	/** A per-pass sample from another source (deck's layers pass); totals and `frames` are untouched. */
	addPass(name: string, ms: number) {
		let samples = this.perPass.get(name);
		if (!samples) {
			samples = [];
			this.perPass.set(name, samples);
		}
		push(samples, Number.isFinite(ms) && ms > 0 ? ms : 0, this.window);
	}

	mean(): { passes: PassTiming[]; totalGpuMs: number; frames: number } {
		return {
			passes: [...this.perPass].map(([name, samples]) => ({
				name,
				gpuMs: average(samples),
			})),
			totalGpuMs: average(this.totals),
			frames: this.totals.length,
		};
	}

	reset() {
		this.perPass.clear();
		this.totals = [];
	}
}

/** Rolling mean of one scalar over the last `window` samples (deck's CPU time per draw). */
export class RollingMean {
	private samples: number[] = [];

	constructor(private readonly window = MEAN_WINDOW) {}

	add(value: number) {
		push(
			this.samples,
			Number.isFinite(value) && value > 0 ? value : 0,
			this.window,
		);
	}

	mean() {
		return average(this.samples);
	}

	get count() {
		return this.samples.length;
	}

	reset() {
		this.samples = [];
	}
}

function push(samples: number[], value: number, window: number) {
	samples.push(value);
	if (samples.length > window) samples.shift();
}

function average(samples: readonly number[]) {
	return samples.length
		? samples.reduce((a, b) => a + b, 0) / samples.length
		: 0;
}
