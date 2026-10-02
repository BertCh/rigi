// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Live pose tracker: `createTracker(options)` implements the `Tracker` contract of
// src/lib/live/contract.ts. See tracker.ts for the loop and reports/tracker-gate-draft.md for how it
// is meant to be validated. Output stays a suggestion.
import type { Pose } from "../camera";
import type { HorizonProfile } from "../geo/horizon";
import type { SensorSample, TrackedPose, Tracker } from "../live/contract";
import { prepareTrackerHorizon } from "./horizon";
import { type RgbaImage, scanColumnsCpu } from "./skyline-cpu";
import { GpuColumnScanner } from "./skyline-gpu";
import { createTrackerCore } from "./tracker";
import type { ColumnScanner, TrackerOptions } from "./types";

export { prepareTrackerHorizon } from "./horizon";
export { createSkylineRelocaliser, searchSkyline } from "./search";
export type { RgbaImage, ScanResult } from "./skyline-cpu";
export { scanColumnsCpu } from "./skyline-cpu";
export { GpuColumnScanner } from "./skyline-gpu";
export { createTrackerCore, DEFAULT_TUNING } from "./tracker";
export type * from "./types";

/** CPU scanner over a pixel reader (tests, WebGL2 fallback, no compute device). */
export function createCpuScanner(
	outWidth: number,
	readPixels: (frame: Parameters<ColumnScanner["scan"]>[0]) => RgbaImage | null,
): ColumnScanner {
	return {
		inFlight: 0,
		scan(frame) {
			const img = readPixels(frame);
			return Promise.resolve(img ? scanColumnsCpu(img, outWidth) : null);
		},
		dispose() {},
	};
}

/** Default pixel reader: the frame drawn into an OffscreenCanvas at the scan width. */
function canvasPixelReader(outWidth: number) {
	let canvas: OffscreenCanvas | null = null;
	return (frame: Parameters<ColumnScanner["scan"]>[0]): RgbaImage | null => {
		if (typeof OffscreenCanvas === "undefined") return null;
		const width = outWidth * 2;
		const height = Math.max(
			8,
			Math.round((width * frame.height) / frame.width),
		);
		if (!canvas || canvas.width !== width || canvas.height !== height)
			canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) return null;
		ctx.drawImage(
			frame.source as unknown as CanvasImageSource,
			0,
			0,
			width,
			height,
		);
		const data = ctx.getImageData(0, 0, width, height);
		return { width, height, data: data.data };
	};
}

export type LiveTracker = Tracker & { setYawOffset(deg: number): void };

/**
 * The live tracker. Pass `horizon` (resident profile) or just `eye`: then the horizon is loaded in
 * the background (prepareTrackerHorizon unless `loadHorizon` is given) and, until it is ready (or if
 * it fails), poses are the sensor's own with phase "init". `yawOffset` / setYawOffset add a manual
 * compass correction to every heading.
 */
export function createTracker(options: TrackerOptions): LiveTracker {
	const outWidth = options.workingWidth ?? 320;
	let yawOffset = options.yawOffset ?? 0;
	const listeners = new Set<(p: TrackedPose) => void>();
	let core: Tracker | null = null;
	let disposed = false;
	let loading = false;
	let pendingReset: Partial<Pose> | undefined;
	const forward = (p: TrackedPose) => {
		for (const cb of listeners) cb(p);
	};
	const build = (horizon: HorizonProfile) => {
		const scanner =
			options.scanner ??
			(options.device
				? new GpuColumnScanner(options.device, outWidth, options.uploadFrame)
				: createCpuScanner(
						outWidth,
						options.readPixels ?? canvasPixelReader(outWidth),
					));
		core = createTrackerCore({ ...options, horizon, scanner });
		core.onPose(forward);
		if (pendingReset) core.reset(pendingReset);
	};
	if (options.horizon) build(options.horizon);
	const start = () => {
		if (core || loading || disposed || !options.eye) return;
		loading = true;
		(options.loadHorizon ?? prepareTrackerHorizon)(options.eye).then(
			(h) => {
				if (!disposed) build(h);
			},
			(e) => console.warn("[track] horizon unavailable, sensor-only", e),
		);
	};
	const shift = (s: SensorSample | undefined): SensorSample | undefined =>
		s && s.yaw !== null
			? { ...s, yaw: (((s.yaw + yawOffset) % 360) + 360) % 360 }
			: s;
	return {
		get phase() {
			return core?.phase ?? "init";
		},
		setYawOffset(deg) {
			yawOffset = deg;
		},
		pushFrame(frame) {
			if (disposed) return;
			const sensor = shift(frame.sensor);
			if (core) return core.pushFrame({ ...frame, sensor });
			start();
			if (!sensor) return;
			const heading = sensor.yaw ?? sensor.yawRelative;
			if (heading === undefined || heading === null) return;
			forward({
				time: frame.time,
				pose: {
					yaw:
						(((heading + (sensor.yaw === null ? yawOffset : 0)) % 360) + 360) %
						360,
					pitch: sensor.pitch,
					roll: sensor.roll,
					vfov: options.vfov,
				},
				phase: "init",
				residualDeg: Number.NaN,
				source: "sensor",
				suggestion: true,
			});
		},
		onPose(cb) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		reset(prior) {
			pendingReset = prior;
			core?.reset(prior);
		},
		dispose() {
			disposed = true;
			listeners.clear();
			core?.dispose();
		},
	};
}
