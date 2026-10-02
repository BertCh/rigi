// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure helpers behind the renderers' live mode (setLiveSource / setLiveMode, src/lib/live/contract.ts):
// the frame scope a live update needs, the label emit throttle, the source size and the
// setPose -> frame latency window. No GPU, no DOM, so they are unit-tested (__tests__/renderer-live.spec.ts).
import type { Pose } from "./camera";
import type { LiveSource } from "./live/contract";

export type LiveFrameScope = "all" | "color" | "screen";

/**
 * The frame a live update needs. A new pose invalidates the geometry pass ("all"); a new video frame
 * alone only changes the photo texture, which the photo view samples in the screen pass ("screen")
 * and the world view in the colour pass (drape, photo plane: "color"). null = nothing to draw.
 */
export function liveFrameScope(change: {
	poseChanged: boolean;
	photoChanged: boolean;
	worldView: boolean;
}): LiveFrameScope | null {
	if (change.poseChanged) return "all";
	if (!change.photoChanged) return null;
	return change.worldView ? "color" : "screen";
}

/** Pixel size of a live source (video element: intrinsic size; VideoFrame: display size). */
export function liveSourceSize(source: LiveSource): {
	width: number;
	height: number;
} {
	if ("videoWidth" in source)
		return { width: source.videoWidth, height: source.videoHeight };
	return { width: source.displayWidth, height: source.displayHeight };
}

/** Smallest angle between two headings, degrees. */
function angleDelta(a: number, b: number) {
	return Math.abs(((a - b + 540) % 360) - 180);
}

export const LIVE_LABEL_MIN_INTERVAL_MS = 1000 / 15;
export const LIVE_LABEL_MIN_DELTA_DEG = 0.05;

/**
 * Rate limit for the label emit in live mode: at most ~15 Hz, and skipped while the pose moved less
 * than `minDeltaDeg` since the last emit. `allow` is called with every candidate emit; a true result
 * records it. `waitMs` says how long until the next emit may pass (for a trailing timer).
 */
export class LabelThrottle {
	private lastAt = Number.NEGATIVE_INFINITY;
	private last: Pose | null = null;

	constructor(
		private readonly minIntervalMs = LIVE_LABEL_MIN_INTERVAL_MS,
		private readonly minDeltaDeg = LIVE_LABEL_MIN_DELTA_DEG,
	) {}

	allow(now: number, pose: Pose): boolean {
		if (now - this.lastAt < this.minIntervalMs) return false;
		const last = this.last;
		if (
			last &&
			angleDelta(pose.yaw, last.yaw) < this.minDeltaDeg &&
			Math.abs(pose.pitch - last.pitch) < this.minDeltaDeg &&
			Math.abs(pose.roll - last.roll) < this.minDeltaDeg &&
			Math.abs(pose.vfov - last.vfov) < this.minDeltaDeg
		)
			return false;
		this.lastAt = now;
		this.last = { ...pose };
		return true;
	}

	/** Milliseconds until the interval gate opens (0 when it is open). */
	waitMs(now: number): number {
		return Math.max(0, this.minIntervalMs - (now - this.lastAt));
	}

	/** Forget the last emit (the next candidate passes). */
	reset() {
		this.lastAt = Number.NEGATIVE_INFINITY;
		this.last = null;
	}
}

/** setPose -> rendered frame latency: the oldest pending setPose is resolved by the next frame. */
export class PoseLatency {
	private pendingAt: number | null = null;
	private readonly window: number[] = [];

	constructor(private readonly size = 120) {}

	/** A pose was applied (only the first one since the last frame counts: it waited longest). */
	notePose(now: number) {
		if (this.pendingAt === null) this.pendingAt = now;
	}

	/** A frame finished rendering. */
	noteFrame(now: number) {
		if (this.pendingAt === null) return;
		this.window.push(now - this.pendingAt);
		if (this.window.length > this.size) this.window.shift();
		this.pendingAt = null;
	}

	get samples() {
		return this.window.length;
	}

	/** { mean, p95, max } of the window in ms, null before the first frame. */
	summary(): { mean: number; p95: number; max: number } | null {
		const n = this.window.length;
		if (!n) return null;
		const sorted = [...this.window].sort((a, b) => a - b);
		const mean = sorted.reduce((s, v) => s + v, 0) / n;
		return {
			mean,
			p95: sorted[Math.min(n - 1, Math.floor(0.95 * n))],
			max: sorted[n - 1],
		};
	}
}

/** Geometry (peak verdict) refresh period while live mode runs: ~3 Hz. */
export const LIVE_REFRESH_MS = 330;

/**
 * Call `onFrame` once per new video frame (requestVideoFrameCallback; requestAnimationFrame where a
 * browser lacks it). Returns the stop function.
 */
export function startVideoLoop(
	video: HTMLVideoElement,
	onFrame: () => void,
): () => void {
	let stopped = false;
	if ("requestVideoFrameCallback" in video) {
		let handle = 0;
		const tick = () => {
			if (stopped) return;
			handle = video.requestVideoFrameCallback(tick);
			onFrame();
		};
		handle = video.requestVideoFrameCallback(tick);
		return () => {
			stopped = true;
			video.cancelVideoFrameCallback(handle);
		};
	}
	let handle = 0;
	const tick = () => {
		if (stopped) return;
		handle = requestAnimationFrame(tick);
		onFrame();
	};
	handle = requestAnimationFrame(tick);
	return () => {
		stopped = true;
		cancelAnimationFrame(handle);
	};
}
