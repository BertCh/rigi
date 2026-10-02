// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The tracker /live runs when src/lib/track is absent (or fails to load): the pose is the phone's own
// sensor reading, nothing more. It satisfies the same Tracker contract, so the page treats both alike.
// `loadTracker` prefers the real tracker (createTracker from src/lib/track/index.ts) when that module exists.

import type { Pose } from "../camera";
import type {
	EyeFix,
	TrackedPose,
	Tracker,
	TrackerPhase,
	TrackFrame,
} from "./contract";

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

type TrackModule = {
	createTracker?: (options: LiveTrackerOptions) => Tracker | Promise<Tracker>;
};

// Matches nothing until unit `tracker` lands src/lib/track/index.ts; tsc and the build both accept that.
const trackerModules = import.meta.glob<TrackModule>("../track/index.ts");

/** The skyline tracker when it exists, else the sensor-only tracker. `real` says which one you got. */
export async function loadTracker(options: LiveTrackerOptions): Promise<{
	tracker: Tracker & { setYawOffset?(deg: number): void };
	real: boolean;
}> {
	const load = Object.values(trackerModules)[0];
	if (load) {
		try {
			const mod = await load();
			if (mod.createTracker)
				return { tracker: await mod.createTracker(options), real: true };
		} catch (e) {
			console.warn("[live] tracker failed to load; using sensors only", e);
		}
	}
	return { tracker: createSensorTracker(options), real: false };
}
