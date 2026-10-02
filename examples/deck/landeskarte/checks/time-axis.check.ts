// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU check for ui/time-axis.ts: the piecewise-linear ruler is a monotone bijection with the
// advertised 12x magnification, and the twelve real photo times land inside the bracket.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {Station} from '../types';
import {
  DAY_END_MINUTES,
  DAY_START_MINUTES,
  GIPFELRAST_END_MINUTES,
  GIPFELRAST_MAGNIFICATION,
  GIPFELRAST_START_MINUTES,
  formatHoursMinutes,
  gipfelrastX,
  keyboardStep,
  minutesToX,
  photoTicks,
  rulerValueText,
  steppedMinutes,
  xToMinutes
} from '../ui/time-axis';

function pass(message: string): void {
  console.log(`PASS ${message}`);
}

// Endpoints and round trip.
assert.equal(minutesToX(DAY_START_MINUTES), 0);
assert.equal(minutesToX(DAY_END_MINUTES), 1);
assert.equal(minutesToX(-50), 0);
assert.equal(minutesToX(5000), 1);
assert.equal(xToMinutes(0), DAY_START_MINUTES);
assert.ok(Math.abs(xToMinutes(1) - DAY_END_MINUTES) < 1e-9);
let worstRoundTrip = 0;
let samples = 0;
for (let m = DAY_START_MINUTES; m <= DAY_END_MINUTES; m += 0.0625) {
  worstRoundTrip = Math.max(worstRoundTrip, Math.abs(xToMinutes(minutesToX(m)) - m));
  samples++;
}
for (let i = 0; i <= 10000; i++) {
  const x = i / 10000;
  worstRoundTrip = Math.max(worstRoundTrip, Math.abs(minutesToX(xToMinutes(x)) - x) * 900);
}
assert.ok(worstRoundTrip < 1e-9, `round trip ${worstRoundTrip}`);
pass(
  `round trip over ${samples} minutes + 10001 positions, worst ${worstRoundTrip.toExponential(2)} min`
);

// Strict monotonicity and slopes.
let previous = -1;
for (let m = DAY_START_MINUTES; m <= DAY_END_MINUTES; m += 0.25) {
  const x = minutesToX(m);
  assert.ok(x > previous, `not increasing at ${m}`);
  previous = x;
}
const outsideSlope = minutesToX(DAY_START_MINUTES + 61) - minutesToX(DAY_START_MINUTES + 60);
const insideSlope =
  minutesToX(GIPFELRAST_START_MINUTES + 11) - minutesToX(GIPFELRAST_START_MINUTES + 10);
const ratio = insideSlope / outsideSlope;
assert.ok(Math.abs(ratio - GIPFELRAST_MAGNIFICATION) < 1e-9);
pass(`strictly increasing on 03:00..18:00 UTC; bracket magnification ${ratio.toFixed(6)}x`);

// The bracket occupies a sensible share of the ruler.
const {start, end} = gipfelrastX();
assert.equal(start, minutesToX(GIPFELRAST_START_MINUTES));
assert.equal(end, minutesToX(GIPFELRAST_END_MINUTES));
assert.ok(end > start);
const share = end - start;
assert.ok(share > 0.18 && share < 0.25, `bracket share ${share}`);
pass(
  `Gipfelrast spans x ${start.toFixed(4)}..${end.toFixed(4)} (${(share * 100).toFixed(1)}% of ruler for 20 of 900 min)`
);

// Real photo ticks.
const stations = (
  JSON.parse(readFileSync(new URL('../data/stations.json', import.meta.url), 'utf8')) as {
    stations: Station[];
  }
).stations;
const ticks = photoTicks(stations);
assert.equal(ticks.length, stations.length);
assert.equal(ticks.length, 12);
for (let i = 0; i < ticks.length; i++) {
  assert.ok(ticks[i].x >= start && ticks[i].x <= end + 1e-3, `tick ${ticks[i].id} outside bracket`);
  if (i > 0) {
    assert.ok(ticks[i].x >= ticks[i - 1].x, 'ticks out of order');
  }
}
// Shuffled input still comes back in time order.
const shuffled = photoTicks([...stations].reverse());
assert.deepEqual(
  shuffled.map(t => t.id),
  ticks.map(t => t.id)
);
const spanPx = (ticks[11].x - ticks[0].x) * 800;
pass(`12 photo ticks in time order, spanning ${spanPx.toFixed(0)} px on an 800 px ruler`);

// Keyboard and text helpers.
assert.equal(keyboardStep(600, false), 5);
assert.equal(keyboardStep(810, false), 1);
assert.equal(keyboardStep(810, true), 10);
assert.equal(steppedMinutes(600, true, false), 605);
assert.equal(steppedMinutes(603, true, false), 605);
assert.equal(steppedMinutes(603, false, false), 600);
assert.equal(steppedMinutes(808.37, true, false), 809);
assert.equal(steppedMinutes(808.37, false, false), 808);
assert.equal(steppedMinutes(810, false, true), 800);
assert.equal(steppedMinutes(DAY_END_MINUTES, true, true), DAY_END_MINUTES);
assert.equal(steppedMinutes(DAY_START_MINUTES, false, false), DAY_START_MINUTES);
// Repeated presses cross the bracket and always make progress.
let walk = DAY_START_MINUTES;
for (let i = 0; i < 2000 && walk < DAY_END_MINUTES; i++) {
  const next = steppedMinutes(walk, true, false);
  assert.ok(next > walk, `stuck at ${walk}`);
  walk = next;
}
assert.equal(walk, DAY_END_MINUTES);
assert.equal(rulerValueText(808, 31.4), '15:28 Uhr MESZ, Sonne 31 Grad hoch');
assert.equal(rulerValueText(1080, -4), '20:00 Uhr MESZ, Sonne unter dem Horizont');
assert.equal(rulerValueText(808, null), '15:28 Uhr MESZ');
assert.equal(formatHoursMinutes(7.2), '7 h 12 min');
assert.equal(formatHoursMinutes(0.0833), '0 h 05 min');
pass('keyboard steps, aria-valuetext and duration formatting');
