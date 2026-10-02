// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The lift from the map sheet to the summit: an interpolation of ViewPose, driven by rAF.

import type {ViewPose} from '../types';

/** Shift before taking the log of the eye height, so heights near or below the origin work. */
const ALTITUDE_OFFSET = 100;

const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const clonePose = (pose: ViewPose): ViewPose => ({...pose, eye: [...pose.eye]});

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Pose between `a` and `b` at linear time t in 0..1 (eased inside). Yaw takes the short way
 * round, the eye height and field of view move in log space so a 40 km descent and a 8 to 50
 * degree zoom both feel even, and t = 1 returns `b` exactly.
 */
export function interpolatePose(a: ViewPose, b: ViewPose, t: number): ViewPose {
  if (t <= 0) return clonePose(a);
  if (t >= 1) return clonePose(b);
  const e = easeInOutCubic(t);
  const yawDelta = ((((b.yaw - a.yaw) % 360) + 540) % 360) - 180;
  const logHeightA = Math.log(Math.max(a.eye[2] + ALTITUDE_OFFSET, 1));
  const logHeightB = Math.log(Math.max(b.eye[2] + ALTITUDE_OFFSET, 1));
  return {
    eye: [
      lerp(a.eye[0], b.eye[0], e),
      lerp(a.eye[1], b.eye[1], e),
      Math.exp(lerp(logHeightA, logHeightB, e)) - ALTITUDE_OFFSET
    ],
    yaw: a.yaw + yawDelta * e,
    pitch: lerp(a.pitch, b.pitch, e),
    roll: lerp(a.roll, b.roll, e),
    vfov: Math.exp(lerp(Math.log(a.vfov), Math.log(b.vfov), e)),
    near: b.near ?? a.near,
    far: b.far ?? a.far
  };
}

/**
 * Flies from `from` to `to` over `ms`, calling `onPose` every animation frame. The last pose
 * passed is `to` itself, so the end frame never depends on float rounding. `cancel` stops
 * the flight without calling `onDone`.
 */
export function createFlight(
  from: ViewPose,
  to: ViewPose,
  ms: number,
  onPose: (pose: ViewPose) => void,
  onDone: () => void
): {cancel(): void} {
  let cancelled = false;
  let frameId = 0;
  if (ms <= 0) {
    onPose(clonePose(to));
    onDone();
    return {cancel() {}};
  }
  const startTime = performance.now();
  const step = (now: number) => {
    if (cancelled) return;
    const t = (now - startTime) / ms;
    onPose(interpolatePose(from, to, t));
    if (t >= 1) {
      onDone();
      return;
    }
    frameId = requestAnimationFrame(step);
  };
  frameId = requestAnimationFrame(step);
  return {
    cancel() {
      cancelled = true;
      cancelAnimationFrame(frameId);
    }
  };
}
