// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Per-render-pass GPU frame timings for the WebGPU engine (opt-in: `?gpuFrameTimings=on`).
//
// deck.gl's own `_onFrameTimings` (PR #10778, vendored) IS wired behind the same flag
// (deckFrameTimingsProps, spread into both engines' Deck props): deck's layers-pass GPU time shows up
// as the pass "deck-layers" and deck's CPU time is tracked separately (`deckCpuMs`). Rigi's geometry
// and colour passes still need this module: they run from an effect's preRender (hosts/deck.ts) and
// are invisible to deck's timer. Here every pass the hosts open through hosts/passes.ts asks
// `passProps(name)` for timestamp writes; the ring / cap / aggregation logic is in
// frame-timings-core.ts (pure, node-checked), and the query-set pooling follows deck's FrameTimer.
//
// Off (the default, or the device lacks 'timestamp-query'): nothing is attached, `getFrameTimings`
// returns undefined and render pass descriptors are exactly what they were. On: each host frame
// leases one 64-slot query set from a ring of 4; the passes recorded in that frame (geometry,
// colour, and, on the direct host, screen) write their begin / end timestamps into it, and one
// readback after `queue.onSubmittedWorkDone` turns them into a FrameTimings sample. If all four
// sets still await readback the frame is not timed (never a stall); on the first readback error
// the feature disables itself and logs once. The deck host's own canvas pass (CoreLayer inside
// deck's LayersPass) is deck's render pass and is not timed.
import type { Device, RenderPassProps } from "@luma.gl/core";
import { getFlag } from "#/lib/flags";
import {
	buildFrameTimings,
	type FrameLease,
	type FrameTimings,
	MAX_TIMED_PASSES,
	QueryRing,
	RollingFrameMean,
	RollingMean,
} from "./frame-timings-core";

export type { FrameTimings, PassTiming } from "./frame-timings-core";

export type FrameTimingsListener = (timings: FrameTimings) => void;

type TimestampProps = Pick<
	RenderPassProps,
	"timestampQuerySet" | "beginTimestampIndex" | "endTimestampIndex"
>;

const NO_PROPS: Partial<RenderPassProps> = Object.freeze({});

const timers = new WeakMap<Device, GpuFrameTimings>();
let current: GpuFrameTimings | null = null;

/** Whether `device` can time passes (WebGPU with 'timestamp-query'). */
export const frameTimingsSupported = (device: Device) =>
	device.type === "webgpu" && device.features.has("timestamp-query");

/**
 * Hosts call this once after creating their device. Returns the device's timer when the
 * `gpuFrameTimings` flag is on and the device supports timestamp queries, else null (and warns once
 * when it was asked for but unsupported); the same timer on repeated calls.
 */
export function attachFrameTimings(device: Device): GpuFrameTimings | null {
	if (getFlag("gpuFrameTimings") !== "on") return null;
	const existing = timers.get(device);
	if (existing) return existing;
	if (!frameTimingsSupported(device)) {
		console.warn(
			"[frame-timings] gpuFrameTimings=on but the device lacks 'timestamp-query'; no timings",
		);
		return null;
	}
	const timer = new GpuFrameTimings(device);
	timers.set(device, timer);
	current = timer;
	return timer;
}

/** The device's timer, if one was attached. Cheap enough for the per-pass path. */
export const getFrameTimings = (device: Device) => timers.get(device);

/**
 * Timestamp props for `device.beginRenderPass({...passTimestamps(device, "geometry"), ...})`:
 * an empty object when timings are off, no frame is open, or the frame is not being timed.
 */
export function passTimestamps(
	device: Device,
	name: string,
): Partial<RenderPassProps> {
	return timers.get(device)?.passProps(name) ?? NO_PROPS;
}

export type DeckTimingsSummary = {
	cpuMs: number;
	gpuMs: number | null;
	frames: number;
};
export type DeckTimingsSample = { cpuTime: number; gpuTime?: number };

/** Deck-only rolling means (no Rigi timer attached: the WebGL engine). */
const deckOnly = { cpu: new RollingMean(), gpu: new RollingMean() };

/** Props to spread into a Deck: deck's `_onFrameTimings` while `gpuFrameTimings` is on, else `{}`. */
export function deckFrameTimingsProps(device?: () => Device | undefined) {
	if (getFlag("gpuFrameTimings") !== "on") return {};
	return {
		_onFrameTimings: (timings: DeckTimingsSample) =>
			recordDeckFrameTimings(timings, device?.()),
	};
}

/** One deck draw's timings: into the device's timer when attached, else the deck-only mean. */
export function recordDeckFrameTimings(
	timings: DeckTimingsSample,
	device?: Device,
) {
	const timer = device ? timers.get(device) : undefined;
	if (timer) return timer.recordDeck(timings);
	deckOnly.cpu.add(timings.cpuTime);
	if (timings.gpuTime !== undefined) deckOnly.gpu.add(timings.gpuTime);
}

/** The latest sample and rolling mean of the attached timer (dev inspector). Null when none. */
export function currentFrameTimings() {
	const deck: DeckTimingsSummary | null = current
		? current.deckSummary()
		: deckOnly.cpu.count
			? {
					cpuMs: deckOnly.cpu.mean(),
					gpuMs: deckOnly.gpu.count ? deckOnly.gpu.mean() : null,
					frames: deckOnly.cpu.count,
				}
			: null;
	if (!current) {
		if (!deck) return null;
		return {
			latest: null,
			mean: { passes: [], totalGpuMs: 0, frames: 0 },
			disabledReason: null,
			deck,
		};
	}
	return {
		latest: current.latest,
		mean: current.mean(),
		disabledReason: current.disabledReason,
		deck,
	};
}

export class GpuFrameTimings {
	/** The most recent completed sample. */
	latest: FrameTimings | null = null;
	/** Set once the timer turned itself off (readback failure, device loss). */
	disabledReason: string | null = null;
	/** Frames not timed because every query set was in flight, or a pass cap overflowed. */
	droppedFrames = 0;

	private readonly ring: QueryRing<ReturnType<Device["createQuerySet"]>>;
	private readonly rolling = new RollingFrameMean();
	private readonly listeners = new Set<FrameTimingsListener>();
	private readonly deckCpu = new RollingMean();
	private readonly deckGpu = new RollingMean();
	private lastFrame = 0;
	private lease: FrameLease<ReturnType<Device["createQuerySet"]>> | null = null;
	private destroyed = false;

	constructor(private readonly device: Device) {
		this.ring = new QueryRing(
			() =>
				device.createQuerySet({
					id: "rigi-frame-timings",
					type: "timestamp",
					count: MAX_TIMED_PASSES * 2,
				}),
			(querySet) => querySet.destroy(),
		);
	}

	/** Start timing the frame about to be recorded. An unfinished frame is dropped. */
	beginFrame(frame: number) {
		this.lastFrame = frame;
		this.abortFrame();
		if (this.disabledReason || this.destroyed) return;
		this.lease = this.ring.begin(frame);
		if (!this.lease) this.droppedFrames++;
	}

	/** Timestamp writes for the next render pass of the open frame, else an empty object. */
	passProps(name: string): Partial<RenderPassProps> {
		const lease = this.lease;
		if (!lease) return NO_PROPS;
		const slot = this.ring.nextPass(lease, name);
		if (!slot) return NO_PROPS;
		return {
			timestampQuerySet: slot.querySet,
			beginTimestampIndex: slot.beginIndex,
			endTimestampIndex: slot.endIndex,
		} satisfies TimestampProps;
	}

	/**
	 * The frame's passes are recorded and submitted: read their timestamps once `submitted`
	 * (queue.onSubmittedWorkDone) settles. A frame with no timed pass, or past the pass cap, is dropped.
	 */
	endFrame(submitted: Promise<unknown>) {
		const lease = this.lease;
		this.lease = null;
		if (!lease) return;
		if (lease.overflowed) this.droppedFrames++;
		if (!lease.passNames.length || lease.overflowed) {
			this.ring.release(lease);
			return;
		}
		void submitted
			.then(() => lease.querySet.readResults())
			.then(
				(results) => {
					if (this.destroyed || this.disabledReason)
						return this.ring.discard(lease);
					const durations = lease.passNames.map(
						(_, i) => Number(results[i * 2 + 1] - results[i * 2]) / 1e6,
					);
					this.ring.release(lease);
					const timings = buildFrameTimings(lease, durations);
					this.latest = timings;
					this.rolling.add(timings);
					for (const listener of this.listeners) listener(timings);
				},
				(error) => {
					// unread results may remain queued in the set: do not reuse it
					this.ring.discard(lease);
					// a readback still in flight when the host is destroyed rejects: not a failure
					if (this.destroyed) return;
					this.disable(
						`readback failed: ${(error as Error)?.message ?? error}`,
					);
				},
			);
	}

	/** Drop the open frame without reading (the host failed mid-frame). */
	abortFrame() {
		if (!this.lease) return;
		this.ring.release(this.lease);
		this.lease = null;
	}

	/** Called with every completed sample. Returns the unsubscribe function. */
	onFrameTimings(listener: FrameTimingsListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Rolling mean of deck's own CPU time per draw (deck `_onFrameTimings`). */
	get deckCpuMs() {
		return this.deckCpu.mean();
	}

	/** Deck's CPU and layers-pass GPU means, null before the first deck sample. */
	deckSummary(): DeckTimingsSummary | null {
		if (!this.deckCpu.count) return null;
		return {
			cpuMs: this.deckCpu.mean(),
			gpuMs: this.deckGpu.count ? this.deckGpu.mean() : null,
			frames: this.deckCpu.count,
		};
	}

	/** Deck's `_onFrameTimings`: its layers pass joins the per-pass mean as "deck-layers". */
	recordDeck(timings: DeckTimingsSample) {
		this.deckCpu.add(timings.cpuTime);
		const gpuMs = timings.gpuTime;
		if (gpuMs === undefined) return;
		this.deckGpu.add(gpuMs);
		this.rolling.addPass("deck-layers", gpuMs);
		const sample: FrameTimings = {
			frame: this.lastFrame,
			passes: [{ name: "deck-layers", gpuMs }],
			totalGpuMs: gpuMs,
			source: "deck",
			cpuMs: timings.cpuTime,
		};
		for (const listener of this.listeners) listener(sample);
	}

	/** Rolling mean over the last 60 timed frames, per pass name and in total. */
	mean() {
		return this.rolling.mean();
	}

	private disable(reason: string) {
		if (this.disabledReason) return;
		this.disabledReason = reason;
		console.warn(`[frame-timings] disabled: ${reason}`);
		this.abortFrame();
		this.ring.destroyAll();
	}

	destroy() {
		this.destroyed = true;
		this.abortFrame();
		this.ring.destroyAll();
		this.listeners.clear();
		if (timers.get(this.device) === this) timers.delete(this.device);
		if (current === this) current = null;
	}
}
