// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Frame governor: keeps live mode inside a frame budget. Pure (no timers, no DOM): feed it the measured frame
// times, it answers with a pixel ratio, a render-rate target and a thermal flag.
//
// Every `windowMs` it compares the mean frame time to the budget (1000 / targetFps):
//   - over budget (> 1.15 ×) for `downWindows` windows in a row: step the pixel ratio down;
//   - at the minimum pixel ratio and still over budget for `thermalMs`: assume thermal throttling and lower
//     the target fps one notch (the render rate), flagging `thermal`;
//   - under 0.7 × the budget for `upWindows` windows: raise the pixel ratio, and once it is back at the
//     maximum, restore the target fps one notch.

import type { LiveBudget } from "./contract";

export type GovernorOptions = {
	targetFps: number;
	maxPixelRatio: number;
	minPixelRatio?: number;
	pixelRatioStep?: number;
	windowMs?: number;
	downWindows?: number;
	upWindows?: number;
	thermalMs?: number;
	/** Target fps notches below the configured target, tried in order while throttled. */
	fpsNotches?: readonly number[];
};

export type GovernorState = LiveBudget & {
	/** The frame-time budget in ms at the current target. */
	budgetMs: number;
	thermal: boolean;
	/** Mean frame time over the last full window. */
	frameMs: number;
};

export class FrameGovernor {
	private readonly configuredFps: number;
	private readonly maxPixelRatio: number;
	private readonly minPixelRatio: number;
	private readonly step: number;
	private readonly windowMs: number;
	private readonly downWindows: number;
	private readonly upWindows: number;
	private readonly thermalMs: number;
	private readonly notches: number[];

	private pixelRatio: number;
	private notch = 0;
	private windowStart = Number.NaN;
	private sum = 0;
	private count = 0;
	private over = 0;
	private under = 0;
	private overAtMinMs = 0;
	private lastMean = 0;
	private lastRender = Number.NEGATIVE_INFINITY;

	constructor(options: GovernorOptions) {
		this.configuredFps = options.targetFps;
		this.maxPixelRatio = options.maxPixelRatio;
		this.minPixelRatio = Math.min(
			options.minPixelRatio ?? 0.5,
			options.maxPixelRatio,
		);
		this.step = options.pixelRatioStep ?? 0.25;
		this.windowMs = options.windowMs ?? 500;
		this.downWindows = options.downWindows ?? 2;
		this.upWindows = options.upWindows ?? 6;
		this.thermalMs = options.thermalMs ?? 5000;
		this.notches = [
			options.targetFps,
			...(options.fpsNotches ?? [24, 20, 15]).filter(
				(f) => f < options.targetFps,
			),
		];
		this.pixelRatio = options.maxPixelRatio;
	}

	get state(): GovernorState {
		const targetFps = this.notches[this.notch];
		return {
			targetFps,
			maxPixelRatio: this.pixelRatio,
			budgetMs: 1000 / targetFps,
			thermal: this.notch > 0,
			frameMs: this.lastMean,
		};
	}

	/**
	 * True when a frame should be rendered at `now` (ms): rate-limits to the target fps with half a frame of
	 * slack so a 60 Hz display with target 30 renders every second vsync. Call `markRendered` after rendering.
	 */
	shouldRender(now: number): boolean {
		return now - this.lastRender >= (1000 / this.notches[this.notch]) * 0.9;
	}

	markRendered(now: number) {
		this.lastRender = now;
	}

	/**
	 * Record the cost of one rendered frame (ms of work, or the interval between rendered frames).
	 * Returns true when the pixel ratio or the target changed.
	 */
	record(frameMs: number, now: number): boolean {
		if (Number.isNaN(this.windowStart)) this.windowStart = now;
		this.sum += frameMs;
		this.count++;
		if (now - this.windowStart < this.windowMs) return false;
		const mean = this.sum / this.count;
		this.lastMean = mean;
		const elapsed = now - this.windowStart;
		this.windowStart = now;
		this.sum = 0;
		this.count = 0;
		const budget = 1000 / this.notches[this.notch];
		let changed = false;
		if (mean > budget * 1.15) {
			this.under = 0;
			this.over++;
			if (this.pixelRatio > this.minPixelRatio) {
				if (this.over >= this.downWindows) {
					this.pixelRatio = Math.max(
						this.minPixelRatio,
						this.pixelRatio - this.step,
					);
					this.over = 0;
					changed = true;
				}
			} else {
				this.overAtMinMs += elapsed;
				if (
					this.overAtMinMs >= this.thermalMs &&
					this.notch < this.notches.length - 1
				) {
					this.notch++;
					this.overAtMinMs = 0;
					changed = true;
				}
			}
		} else {
			this.over = 0;
			this.overAtMinMs = 0;
			if (mean < budget * 0.7) {
				this.under++;
				if (this.under >= this.upWindows) {
					this.under = 0;
					if (this.pixelRatio < this.maxPixelRatio) {
						this.pixelRatio = Math.min(
							this.maxPixelRatio,
							this.pixelRatio + this.step,
						);
						changed = true;
					} else if (this.notch > 0) {
						this.notch--;
						changed = true;
					}
				}
			} else this.under = 0;
		}
		return changed;
	}

	/** Back to the configured target and the maximum pixel ratio. */
	reset() {
		this.pixelRatio = this.maxPixelRatio;
		this.notch = 0;
		this.over = this.under = 0;
		this.overAtMinMs = 0;
	}

	get configuredTargetFps() {
		return this.configuredFps;
	}
}
