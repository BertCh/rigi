// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { smooth } from "./model";

// The staging clock of the "how it works" scene, as pure data: when each beat starts, which
// stretches of time something on screen is actually moving, and a "visual epoch" that lets the
// stage skip commits while nothing changes.

export const BEAT_T0 = [0, 4.5, 8, 12.5, 15.5, 23] as const;
export const END = 28;
// Inside "correct": out to the left edge, sweep across, settle on the coarse minimum, fine solve.
export const T_SWEEP0 = 16.1;
export const T_SWEEP1 = 19.1;
export const T_COARSE = 20.2;
export const T_FINE = 22.4;

export const ramp = (t: number, t0: number, dur: number) =>
	smooth((t - t0) / dur);

/** Every [start, duration] over which a time-driven value changes (all clamp to constants outside). */
export const RAMPS = {
	photoLine: [BEAT_T0[1] + 0.4, 2],
	demLine: [BEAT_T0[2] + 1.6, 1.8],
	ticks: [BEAT_T0[3] + 0.2, 1.4],
	eyeSnap: [BEAT_T0[2] + 0.3, 1.2],
	labelsSolid: [BEAT_T0[5] + 0.2, 0.8],
	accepted: [BEAT_T0[5] + 2.2, 0.6],
	surround: [BEAT_T0[5] + 0.6, 1.4],
	curve: [T_SWEEP0, T_SWEEP1 - T_SWEEP0],
	wedge: [0.3, 0.9],
	uncertaintyIn: [0.8, 1.2],
	uncertaintyOut: [T_COARSE, 1.4],
	footprint: [BEAT_T0[2] + 1.8, 1.6],
	peaks: [BEAT_T0[5] + 0.4, 1],
	labelsIn: [1.2, 0.8],
	labelsDim: [BEAT_T0[1], 0.6],
	pose: [BEAT_T0[4], T_FINE - BEAT_T0[4]],
} as const satisfies Record<string, readonly [number, number]>;

const WINDOWS = Object.values(RAMPS).map(
	([t0, dur]) => [t0, t0 + dur] as const,
);
// Window ends and beat starts split the quiet time into stretches of constant look.
const CUTS = [...WINDOWS.flat(), ...BEAT_T0, END].sort((a, b) => a - b);

/**
 * -1 while a time-driven value is moving (render every tick); otherwise an id of the quiet
 * stretch (between ramps, within one beat) that `t` is in. Equal ids mean an identical picture.
 */
export function visualEpoch(t: number): number {
	if (WINDOWS.some(([a, b]) => t > a && t < b)) return -1;
	let n = 0;
	for (const c of CUTS) if (t >= c) n++;
	return n;
}

/** The time the camera pose depends on: constant before the solve starts and after it settles. */
export function poseTime(t: number): number {
	return t < BEAT_T0[4] ? 0 : Math.min(t, T_FINE);
}

export const beatAt = (t: number) =>
	BEAT_T0.reduce<number>((cur, t0, i) => (t >= t0 ? i : cur), 0);
