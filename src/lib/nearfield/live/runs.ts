// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pose bookkeeping of the live Step Inside session (pure, no GPU). A depth run started at frame t is lifted
// at frame t + k. The splats are ENU, so they are right by construction only when the lift uses the camera of
// the frame the net SAW (t), not the one of the frame it runs on (t + k): `DepthRunLedger` stamps every run
// with that camera and the video time when it begins and hands both back with the finished outputs.
// `shouldRecalibrate` decides when the focal / shift / anchor solve and the DEM grid are stale because the
// camera moved or turned too far since the last calibration.
import type { LiveCameraState } from "./types";

export type DepthRunStamp = {
	id: number;
	/** The camera of the video frame the run was started on (a copy: later setCamera calls do not touch it). */
	camera: LiveCameraState;
	/** `HTMLVideoElement.currentTime` (s) of that frame; `startedAt` is the wall clock (ms) at the start. */
	videoTime: number;
	startedAt: number;
};

export type FinishedDepthRun<T> = DepthRunStamp & { outputs: T };

const copyCamera = (c: LiveCameraState): LiveCameraState => ({
	camToEnu: [...c.camToEnu],
	eye: [c.eye[0], c.eye[1], c.eye[2]],
	K: { ...c.K },
});

/**
 * Stamps depth runs and keeps the newest finished one. A run that finishes after a newer one already did
 * is dropped (its pose is older than the one in hand); `take()` consumes the ready run so it is lifted
 * once. `outputs` is whatever the caller needs to lift (the net's GPU buffers).
 */
export class DepthRunLedger<T> {
	private nextId = 0;
	private newestFinished = -1;
	private ready: FinishedDepthRun<T> | null = null;

	/** Begin a run on the camera of this frame. */
	begin(
		camera: LiveCameraState,
		videoTime: number,
		startedAt = 0,
	): DepthRunStamp {
		return {
			id: this.nextId++,
			camera: copyCamera(camera),
			videoTime,
			startedAt,
		};
	}

	/** A run finished; false when a newer run already did (the outputs are stale and are not kept). */
	finish(stamp: DepthRunStamp, outputs: T): boolean {
		if (stamp.id <= this.newestFinished) return false;
		this.newestFinished = stamp.id;
		this.ready = { ...stamp, outputs };
		return true;
	}

	peek(): FinishedDepthRun<T> | null {
		return this.ready;
	}

	/** The finished run to lift, once. */
	take(): FinishedDepthRun<T> | null {
		const r = this.ready;
		this.ready = null;
		return r;
	}

	/** Drop the ready run (e.g. its calibration was replaced). */
	discard() {
		this.ready = null;
	}
}

export type CalibrationPose = {
	eye: readonly [number, number, number];
	/** degrees */
	yaw: number;
};

export type RecalibrationLimits = {
	/** Eye moved farther than this (ENU metres) since the calibration. */
	moveMetres: number;
	/** Yaw changed by more than this (degrees) since the calibration. */
	yawDegrees: number;
};

export const RECALIBRATION_LIMITS: RecalibrationLimits = {
	moveMetres: 25,
	yawDegrees: 30,
};

/** Smallest absolute difference of two headings in degrees, 0..180. */
export function yawDifference(a: number, b: number): number {
	const d = (((a - b) % 360) + 540) % 360;
	return Math.abs(d - 180);
}

/** Why the calibration is stale (the eye moved, or the camera turned), or null while it still holds. */
export function shouldRecalibrate(
	calibrated: CalibrationPose,
	now: CalibrationPose,
	limits: RecalibrationLimits = RECALIBRATION_LIMITS,
): "moved" | "turned" | null {
	const dx = now.eye[0] - calibrated.eye[0];
	const dy = now.eye[1] - calibrated.eye[1];
	const dz = now.eye[2] - calibrated.eye[2];
	if (Math.hypot(dx, dy, dz) > limits.moveMetres) return "moved";
	if (yawDifference(now.yaw, calibrated.yaw) > limits.yawDegrees)
		return "turned";
	return null;
}
