// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The tracker /live runs when src/lib/track is absent (or fails to load): the pose is the phone's own
// sensor reading, nothing more. It satisfies the same Tracker contract, so the page treats both alike.
// `loadTracker` loads the skyline tracker (createTracker from src/lib/track/index.ts); this one is its fallback.

import type { Pose } from "../camera";
import { getFlag } from "../flags";
import type { HorizonProfile } from "../geo/horizon";
import { adoptedRenderDevice, gpuEnabled } from "../gpu/device";
import type {
	EyeFix,
	TrackedPose,
	Tracker,
	TrackerPhase,
	TrackFrame,
} from "./contract";

/** What loadTracker adds on top of the sensor tracker's options (all optional; the sensor tracker ignores them). */
export type LoadTrackerOptions = LiveTrackerOptions & {
	/**
	 * The live engine is WebGPU: give the tracker the render device (the GPU column scanner, frames
	 * uploaded with copyExternalImageToTexture). False / absent keeps the CPU pixel reader (WebGL2).
	 */
	gpu?: boolean;
	/** Shares an early horizon load with the tracker (src/lib/live/horizon-warm.ts `load`). */
	loadHorizon?: (eye: EyeFix) => Promise<HorizonProfile>;
	/** Run the sky segmenter as the heavy skyline; undefined = flag `liveSky` (auto: on with the GPU). */
	sky?: boolean;
};

export type LiveTrackerOptions = {
	eye: EyeFix;
	/** Vertical field of view of the camera in degrees. */
	vfov: number;
	/** Extra yaw in degrees added to every heading (manual compass calibration). */
	yawOffset?: number;
};

export function createSensorTracker(
	options: LiveTrackerOptions,
): Tracker & { setYawOffset(deg: number): void } {
	const listeners = new Set<(p: TrackedPose) => void>();
	let phase: TrackerPhase = "init";
	let yawOffset = options.yawOffset ?? 0;
	let last: Pose | null = null;
	return {
		get phase() {
			return phase;
		},
		setYawOffset(deg) {
			yawOffset = deg;
		},
		pushFrame(frame: TrackFrame) {
			const s = frame.sensor;
			if (!s) {
				phase = last ? "lost" : "init";
				return;
			}
			const yaw = s.yaw ?? s.yawRelative ?? last?.yaw ?? 0;
			const pose: Pose = {
				yaw: (((yaw + yawOffset) % 360) + 360) % 360,
				pitch: s.pitch,
				roll: s.roll,
				vfov: options.vfov,
			};
			last = pose;
			// a relative-only heading is not a compass: stay in "init" until the platform gives true north
			phase = s.yaw == null ? "init" : "track";
			const out: TrackedPose = {
				time: frame.time,
				pose,
				phase,
				residualDeg: Number.NaN,
				source: "sensor",
				suggestion: true,
			};
			for (const cb of listeners) cb(out);
		},
		onPose(cb) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		reset(prior) {
			if (prior?.yaw != null && last) yawOffset += prior.yaw - last.yaw;
			phase = "init";
		},
		dispose() {
			listeners.clear();
		},
	};
}

/** The skyline tracker (src/lib/track), falling back to the sensor-only tracker when it fails to load. `real` says which one you got. */
export async function loadTracker(options: LoadTrackerOptions): Promise<{
	tracker: Tracker & {
		setYawOffset?(deg: number): void;
		setEye?(eye: EyeFix): void;
	};
	real: boolean;
}> {
	try {
		const { createTracker } = await import("../track/index");
		const device = options.gpu && gpuEnabled() ? adoptedRenderDevice() : null;
		const liveSky = getFlag("liveSky");
		const sky =
			options.sky ?? (liveSky === "auto" ? !!device : liveSky === "on");
		const heavySkyline = sky
			? (await import("./heavy-skyline")).createHeavySkyline()
			: undefined;
		const { gpu: _gpu, sky: _sky, ...rest } = options;
		return {
			tracker: createTracker({ ...rest, device, heavySkyline }),
			real: true,
		};
	} catch (e) {
		console.warn("[live] tracker failed to load; using sensors only", e);
	}
	return { tracker: createSensorTracker(options), real: false };
}
