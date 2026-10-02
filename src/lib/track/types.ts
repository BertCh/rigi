// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Tracker option and hook types (the Tracker contract itself is src/lib/live/contract.ts).
import type { Pose } from "../camera";
import type { HorizonProfile } from "../geo/horizon";
import type { EyeFix, TrackFrame } from "../live/contract";
import type { Column, Geometry } from "../refine/model";
import type { RgbaImage, ScanResult } from "./skyline-cpu";

/** Reduces a frame to one skyline observation. Never holds `frame.source` past the call that starts it. */
export interface ColumnScanner {
	/** Starts a scan and resolves later (GPU: one ring readback); null when the frame is skipped. */
	scan(frame: TrackFrame): Promise<ScanResult | null>;
	/** Scans in flight (the tracker drops frames beyond its budget instead of queueing). */
	readonly inFlight: number;
	dispose(): void;
}

/** What a relocaliser gets: the skyline of a keyframe, never the live video element. */
export interface RelocaliseRequest {
	time: number;
	columns: Column[];
	geom: Geometry;
	/** Sensor pose or last good pose; angles may be missing. */
	prior: Partial<Pose>;
	/** The tracker's horizon (resident 360° at the eye). */
	horizon: HorizonProfile;
	vfov: number;
	/** Set when the tracker moved on (reset, dispose, newer request); stop work when true. */
	cancelled: () => boolean;
	/** A bitmap of the keyframe, only when TrackerOptions.keyframeBitmap is set and the platform can make one. */
	keyframe?: ImageBitmap;
}

export interface RelocaliseResult {
	pose: Pose;
	/** 0..1 confidence; the tracker accepts at or above TrackerTuning.relocaliseMinConfidence. */
	confidence: number;
}

/** The live UI wires the full engine path (autoAlign, unknown-pose search) here. */
export type Relocaliser = (
	request: RelocaliseRequest,
) => Promise<RelocaliseResult | null>;

/** Optional heavy skyline (sky segmentation) used every N frames as a drift-correction source. */
export type HeavySkyline = (frame: TrackFrame) => Promise<ScanResult | null>;

export interface TrackerTuning {
	/** Consecutive failed image solves before LOST. */
	lostAfterFailures: number;
	/** Solve is a failure under this weighted inlier fraction. */
	minInlierFraction: number;
	/** ... or above this residual, degrees. */
	maxResidualDeg: number;
	/** Fewer usable columns than this: the frame is unobserved (no failure counted). */
	minColumns: number;
	/** Prior σ of the per-frame solve, degrees (regularises weakly observed axes). */
	priorSigmaDeg: { yaw: number; pitch: number; roll: number };
	/** Skyline detector noise at the working resolution, px. */
	sigmaPx: number;
	/** Data term counts as at most this many independent columns. */
	effectiveColumns: number;
	/** Process noise of the sensor offset (angle error random walk), degrees per sqrt(second). */
	offsetNoiseDeg: { yaw: number; pitch: number; roll: number };
	/** Acceleration σ of the constant-velocity filter used on axes without a sensor, deg/s^2. */
	accelerationDeg: number;
	/** Floor on the measurement σ passed to the filter, degrees. */
	measurementFloorDeg: number;
	/** Relocalise accepts at or above this confidence. */
	relocaliseMinConfidence: number;
	/** Seconds between relocalise attempts while LOST. */
	relocaliseRetrySeconds: number;
	/** A sensor sample older than this (seconds) is not used to propagate. */
	maxSensorAgeSeconds: number;
}

export interface TrackerOptions {
	/**
	 * The 360° horizon at the eye (resident). Optional: without it the tracker loads one for `eye`
	 * (prepareTrackerHorizon, or `loadHorizon`) and runs sensor-only until it is ready.
	 */
	horizon?: HorizonProfile;
	/** Where the eye is; needed when `horizon` is absent. */
	eye?: EyeFix;
	/** Replaces prepareTrackerHorizon (tests, a worker, a cached profile). */
	loadHorizon?: (eye: EyeFix) => Promise<HorizonProfile>;
	/** Degrees added to every compass heading (manual calibration). */
	yawOffset?: number;
	/** Vertical FOV of the camera, degrees; held fixed. */
	vfov: number;
	/** Compute device for the GPU column scan; null / undefined = CPU scan through `readPixels`. */
	device?: import("@luma.gl/core").Device | null;
	/** Reduced scan width in columns (default 320). */
	workingWidth?: number;
	relocalise?: Relocaliser;
	/** CPU path: frame pixels (default: OffscreenCanvas drawImage; absent where unavailable). */
	readPixels?: (frame: TrackFrame) => RgbaImage | null;
	/** GPU path: copy the frame into the scan texture (default Texture.copyExternalImage). */
	uploadFrame?: (
		texture: import("@luma.gl/core").Texture,
		frame: TrackFrame,
	) => void;
	/** Replaces the scanner entirely (tests). */
	scanner?: ColumnScanner;
	/**
	 * Sky-model skyline, run beside the cheap scan at a low rate (never blocks pushFrame). It must read
	 * `frame.source` synchronously (the pixels are snapshotted at the call), then resolve later.
	 */
	heavySkyline?: HeavySkyline;
	/** Start a `heavySkyline` run at most this often, ms of frame time (default 2000); one in flight at a time. */
	heavySkylineEveryMs?: number;
	/** Drop a heavy result that is older than this when it lands, ms of frame time (default 1000). */
	heavySkylineMaxAgeMs?: number;
	/** The heavy observation counts as this many times the information of a cheap solve (default 4). */
	heavySkylineWeight?: number;
	/** Hand relocalise a createImageBitmap of the keyframe. */
	keyframeBitmap?: boolean;
	/** Scans allowed in flight (default 2). */
	maxInFlight?: number;
	tuning?: Partial<TrackerTuning>;
}
