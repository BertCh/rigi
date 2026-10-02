// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The non-linear time ruler as pure functions. The day is 03:00..18:00 UTC (05:00..20:00 CEST).
// All twelve photos were taken in 20 minutes, so a linear ruler would squeeze them into a single
// pixel column. Instead the ruler is piecewise linear with a 12x magnified "Gipfelrast" bracket.
// Position `x` is a fraction of the ruler width, 0 at the start of the day and 1 at its end.

import {formatCest} from '../geo/sun';
import type {Station} from '../types';

/** Ruler domain, UTC minutes since midnight. */
export const DAY_START_MINUTES = 3 * 60;
export const DAY_END_MINUTES = 18 * 60;

/** The summit rest, 15:28 to 15:48 CEST. */
export const GIPFELRAST_START_MINUTES = 13 * 60 + 28;
export const GIPFELRAST_END_MINUTES = 13 * 60 + 48;
/** Ruler length per minute inside the bracket relative to outside it. */
export const GIPFELRAST_MAGNIFICATION = 12;

// Ruler length is measured in "outside minutes": one unit per minute outside the bracket,
// MAGNIFICATION units per minute inside it. Both mappings are cumulative sums of that density.
const LENGTH_BEFORE = GIPFELRAST_START_MINUTES - DAY_START_MINUTES;
const LENGTH_INSIDE =
  (GIPFELRAST_END_MINUTES - GIPFELRAST_START_MINUTES) * GIPFELRAST_MAGNIFICATION;
const LENGTH_AFTER = DAY_END_MINUTES - GIPFELRAST_END_MINUTES;
const LENGTH_TOTAL = LENGTH_BEFORE + LENGTH_INSIDE + LENGTH_AFTER;

export function clampMinutes(minutes: number): number {
  return Math.min(DAY_END_MINUTES, Math.max(DAY_START_MINUTES, minutes));
}

/** UTC minutes to ruler position 0..1 (clamped to the day). Strictly increasing. */
export function minutesToX(utcMin: number): number {
  const m = clampMinutes(utcMin);
  let length: number;
  if (m <= GIPFELRAST_START_MINUTES) {
    length = m - DAY_START_MINUTES;
  } else if (m <= GIPFELRAST_END_MINUTES) {
    length = LENGTH_BEFORE + (m - GIPFELRAST_START_MINUTES) * GIPFELRAST_MAGNIFICATION;
  } else {
    length = LENGTH_BEFORE + LENGTH_INSIDE + (m - GIPFELRAST_END_MINUTES);
  }
  return length / LENGTH_TOTAL;
}

/** Ruler position 0..1 (clamped) to UTC minutes. Inverse of `minutesToX`. */
export function xToMinutes(x: number): number {
  const length = Math.min(1, Math.max(0, x)) * LENGTH_TOTAL;
  if (length <= LENGTH_BEFORE) {
    return DAY_START_MINUTES + length;
  }
  if (length <= LENGTH_BEFORE + LENGTH_INSIDE) {
    return GIPFELRAST_START_MINUTES + (length - LENGTH_BEFORE) / GIPFELRAST_MAGNIFICATION;
  }
  return GIPFELRAST_END_MINUTES + (length - LENGTH_BEFORE - LENGTH_INSIDE);
}

/** Ruler positions of the Gipfelrast bracket ends. */
export function gipfelrastX(): {start: number; end: number} {
  return {start: minutesToX(GIPFELRAST_START_MINUTES), end: minutesToX(GIPFELRAST_END_MINUTES)};
}

/** One tick per photo at its true takenAt, in time order. */
export function photoTicks(stations: Station[]): {x: number; id: string}[] {
  return stations
    .map(station => ({x: minutesToX(station.minutes), id: station.id, minutes: station.minutes}))
    .sort((a, b) => a.minutes - b.minutes)
    .map(({x, id}) => ({x, id}));
}

/**
 * Keyboard step in minutes: fine inside the bracket where the ruler is magnified, coarse outside,
 * ten times larger with `large` (Shift or Page keys).
 */
export function keyboardStep(minutes: number, large: boolean): number {
  const inside = minutes >= GIPFELRAST_START_MINUTES && minutes <= GIPFELRAST_END_MINUTES;
  const base = inside ? 1 : 5;
  return large ? base * 10 : base;
}

/**
 * Next minute for an arrow or Page key press: snaps to the step grid so repeated presses land on
 * round minutes even after a pointer drag left the thumb at 808.37. Clamped to the day.
 */
export function steppedMinutes(minutes: number, forward: boolean, large: boolean): number {
  const step = keyboardStep(minutes, large);
  const grid = minutes / step;
  // The epsilon keeps a value already on the grid from being counted as off it.
  const next = (forward ? Math.floor(grid + 1e-6) + 1 : Math.ceil(grid - 1e-6) - 1) * step;
  return clampMinutes(next);
}

/**
 * Screen-reader text for the ruler thumb: "15:28 Uhr MESZ" plus the sun state, so a keyboard user
 * hears what the picture shows. `elevation` is the apparent sun elevation in degrees.
 */
export function rulerValueText(minutes: number, elevation: number | null): string {
  const clock = `${formatCest(minutes)} Uhr MESZ`;
  if (elevation === null) {
    return clock;
  }
  const rounded = Math.round(elevation);
  return `${clock}, Sonne ${rounded < 0 ? 'unter dem Horizont' : `${rounded} Grad hoch`}`;
}

/** "7 h 12 min" for a duration in hours. */
export function formatHoursMinutes(hours: number): string {
  const total = Math.round(hours * 60);
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')} min`;
}
