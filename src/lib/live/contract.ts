// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared contract for the live (real-time) mode: camera feed → per-frame pose → overlay.
// The input pump (src/lib/live), the tracker (src/lib/track), the renderers (setLiveSource) and the
// live Step Inside (src/lib/nearfield/live) meet only through these types. Plan and numbers:
// reports/realtime-investigation-2026-10-02.md.
import type { Pose } from "../camera";

/** A frame source the renderers can copy into their photo texture each frame. */
export type LiveSource = HTMLVideoElement | VideoFrame;

/** One device-orientation reading, already converted to the camera ENU convention of `Pose`. */
export interface SensorSample {
	/** performance.now() milliseconds. */
	time: number;
	/** Heading clockwise from true north (declination applied), or null when the reading is relative only. */
	yaw: number | null;
	pitch: number;
	roll: number;
	/** Reported compass accuracy in degrees when the platform gives one. */
	yawAccuracy?: number;
}

/** Geolocation fix used to place the eye; the tracker treats the eye as fixed between fixes. */
export interface EyeFix {
	lat: number;
	lon: number;
	/** Metres above the ellipsoid if known; otherwise the DEM height plus `heightAboveGround` is used. */
	alt?: number;
	accuracy: number;
	time: number;
}

/** What the pump hands the tracker for each video frame. */
export interface TrackFrame {
	time: number;
	width: number;
	height: number;
	/** The frame itself; the tracker copies it into its own GPU planes and never holds it past the call. */
	source: LiveSource;
	/** Latest sensor reading at or before `time`, if any. */
	sensor?: SensorSample;
}

export type TrackerPhase = "init" | "track" | "lost";

/** Tracker output. `suggestion` stays true until the tracker gate in reports/ is preregistered and passed. */
export interface TrackedPose {
	time: number;
	pose: Pose;
	phase: TrackerPhase;
	/** Robust residual of the last solve in degrees (skyline vs horizon), NaN when no image solve ran. */
	residualDeg: number;
	/** Which evidence produced this pose. */
	source: "sensor" | "skyline" | "relocalise";
	suggestion: true;
}

export interface Tracker {
	readonly phase: TrackerPhase;
	/** Non-blocking: never awaits a GPU readback; results arrive through `onPose` one or more frames late. */
	pushFrame(frame: TrackFrame): void;
	onPose(cb: (p: TrackedPose) => void): () => void;
	/** Force re-localisation from scratch (e.g. after the eye moved more than ~100 m). */
	reset(prior?: Partial<Pose>): void;
	dispose(): void;
}

/** Renderer additions for live mode (both engines implement them; see src/lib/renderer.ts). */
export interface LiveRendererApi {
	/** Copy this source into the photo texture every frame (no mips, texture allocated once); null returns to the still photo. */
	setLiveSource(source: LiveSource | null): void;
	/** Live mode: skip per-pose photo fits (haze, masks), keep MSAA off, throttle label work. */
	setLiveMode(on: boolean): void;
}

/** Simple frame governor knobs shared by the pump and the engines. */
export interface LiveBudget {
	targetFps: number;
	maxPixelRatio: number;
}
