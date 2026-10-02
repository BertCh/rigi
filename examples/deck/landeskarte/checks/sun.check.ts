// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU check for geo/sun.ts. The repo values in the spec are outputs of the same family of code, so
// they only guard against regressions; the real evidence is `meeusIndependent` below, a fresh
// Meeus chapter 25 (+ 12, 13, 13.x) implementation that shares no code and a different route:
// Julian day from the calendar date, sidereal time and right ascension instead of equation of
// time, Bennett (apparent-altitude) instead of Saemundsson refraction, plus physical anchors
// (solstice declination, November equation of time) that do not depend on any shared coefficient.

import assert from 'node:assert/strict';
import {
  airMass,
  buildSunTable,
  formatCest,
  sunColor,
  sunDirection,
  sunPosition,
  sunriseSunset
} from '../geo/sun';

const DAY_UTC_MS = Date.UTC(2026, 8, 7);
const LAT = 46.7102;
const LON = 7.7733;
const RAD = Math.PI / 180;

function pass(message: string): void {
  console.log(`PASS ${message}`);
}

function wrap360(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** Smallest signed difference of two angles in degrees. */
function angleDifference(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180;
}

/** Meeus, Astronomical Algorithms 2nd ed.: ch. 7 (JD), 25 (sun), 13 (coordinates), 12 (GST). */
function meeusIndependent(
  year: number,
  month: number,
  day: number,
  utcHours: number,
  lat: number,
  lon: number
): {azimuth: number; elevation: number; apparentElevation: number} {
  // Ch. 7, Gregorian calendar.
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  const jd =
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    day +
    utcHours / 24 +
    b -
    1524.5;
  const t = (jd - 2451545) / 36525;

  // Ch. 25: geometric mean longitude and anomaly, equation of centre, true longitude.
  const l0 = wrap360(280.46646 + 36000.76983 * t + 0.0003032 * t * t);
  const mAnomaly = wrap360(357.52911 + 35999.05029 * t - 0.0001537 * t * t) * RAD;
  const c =
    (1.914602 - 0.004817 * t - 0.000014 * t * t) * Math.sin(mAnomaly) +
    (0.019993 - 0.000101 * t) * Math.sin(2 * mAnomaly) +
    0.000289 * Math.sin(3 * mAnomaly);
  const omega = (125.04 - 1934.136 * t) * RAD;
  const lambda = (l0 + c - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
  const eps =
    (23.439291 - 0.0130042 * t - 1.64e-7 * t * t + 5.04e-7 * t ** 3 + 0.00256 * Math.cos(omega)) *
    RAD;

  // Ch. 13: right ascension and declination from the ecliptic longitude.
  const alpha = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const delta = Math.asin(Math.sin(eps) * Math.sin(lambda));

  // Ch. 12: mean sidereal time at Greenwich, then the local hour angle (east longitude positive).
  const gst = wrap360(
    280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * t * t - (t * t * t) / 38710000
  );
  const hourAngle = (gst + lon) * RAD - alpha;

  const phi = lat * RAD;
  const sinAltitude =
    Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(hourAngle);
  const altitude = Math.asin(sinAltitude) / RAD;
  // Meeus measures azimuth from the south, westward; shift by 180 to get north-clockwise.
  const southAzimuth =
    Math.atan2(
      Math.sin(hourAngle),
      Math.cos(hourAngle) * Math.sin(phi) - Math.tan(delta) * Math.cos(phi)
    ) / RAD;
  const azimuth = wrap360(southAzimuth + 180);

  // Bennett refraction (Meeus 16.3) is a function of the APPARENT altitude, so solve
  // h_apparent = h_true + R(h_apparent) by fixed-point iteration (a different formula from sun.ts).
  let apparent = altitude;
  for (let i = 0; i < 20; i++) {
    apparent = altitude + 1 / Math.tan((apparent + 7.31 / (apparent + 4.4)) * RAD) / 60;
  }
  return {azimuth, elevation: altitude, apparentElevation: apparent};
}

// 1. The spec's repo values (regression guard, 0.05 degrees).
{
  const cases = [
    {t: Date.UTC(2026, 8, 7, 13, 28, 4), az: 222.14, el: 41.63},
    {t: Date.UTC(2026, 8, 7, 13, 48, 8), az: 227.86, el: 39.2},
    {t: Date.UTC(2026, 8, 7, 17, 0, 0), az: 269.16, el: 8.98}
  ];
  let worst = 0;
  for (const c of cases) {
    const p = sunPosition(new Date(c.t), LAT, LON);
    const dAz = Math.abs(angleDifference(p.azimuth, c.az));
    const dEl = Math.abs(p.elevation - c.el);
    worst = Math.max(worst, dAz, dEl);
    assert.ok(dAz <= 0.05, `azimuth ${p.azimuth} vs ${c.az}`);
    assert.ok(dEl <= 0.05, `elevation ${p.elevation} vs ${c.el}`);
  }
  pass(`repo values (3 instants) within 0.05 deg, worst ${worst.toFixed(4)} deg`);
}

// 2. Independent Meeus formulation over the whole day and several sites/dates (0.3 degrees).
{
  const sites = [
    {lat: LAT, lon: LON},
    {lat: 0, lon: 0},
    {lat: -33.9, lon: 151.2},
    {lat: 64.1, lon: -21.9}
  ];
  const days = [
    [2026, 9, 7],
    [2026, 3, 20],
    [2026, 12, 21],
    [2026, 6, 21]
  ];
  let worstAz = 0;
  let worstEl = 0;
  let count = 0;
  for (const site of sites) {
    for (const [year, month, day] of days) {
      for (let minutes = 0; minutes < 1440; minutes += 30) {
        const reference = meeusIndependent(year, month, day, minutes / 60, site.lat, site.lon);
        const date = new Date(Date.UTC(year, month - 1, day, 0, minutes));
        const p = sunPosition(date, site.lat, site.lon);
        // Bennett applies above -1 degrees and nothing below -2; the fade band in between is
        // covered by the continuity check, so only bound it here.
        const g = reference.elevation;
        if (g > -2 && g <= -1) {
          assert.ok(p.elevation >= g && p.elevation <= g + 0.66, `fade band ${p.elevation} ${g}`);
        } else {
          const expected = g > -1 ? reference.apparentElevation : g;
          const dEl = Math.abs(p.elevation - expected);
          worstEl = Math.max(worstEl, dEl);
          assert.ok(
            dEl <= 0.3,
            `elevation ${dEl} at ${site.lat} ${year}-${month}-${day} ${minutes}`
          );
        }
        // Azimuth is ill-conditioned for a sun near the zenith.
        if (reference.elevation < 85) {
          const dAz = Math.abs(angleDifference(p.azimuth, reference.azimuth));
          worstAz = Math.max(worstAz, dAz);
          assert.ok(dAz <= 0.3, `azimuth ${dAz} at ${site.lat} ${year}-${month}-${day} ${minutes}`);
        }
        count++;
      }
    }
  }
  pass(
    `independent Meeus ch.25: ${count} instants, max |d az| ${worstAz.toFixed(4)} deg, ` +
      `max |d el| ${worstEl.toFixed(4)} deg (limit 0.3)`
  );
}

// 3. Sanity from first principles: solar noon elevation is 90 - lat + declination. The azimuth
//    tolerance absorbs the equation of time (about -7 minutes in March), which this ignores.
{
  const equinoxNoon = sunPosition(
    new Date(Date.UTC(2026, 2, 20, 12, 0) - 4 * LON * 60000),
    LAT,
    LON
  );
  const expected = 90 - LAT;
  assert.ok(Math.abs(equinoxNoon.elevation - expected) < 1, `noon el ${equinoxNoon.elevation}`);
  assert.ok(
    Math.abs(angleDifference(equinoxNoon.azimuth, 180)) < 4,
    `noon az ${equinoxNoon.azimuth}`
  );
  pass(
    `equinox solar noon el ${equinoxNoon.elevation.toFixed(2)} (90-lat ${expected.toFixed(2)}), ` +
      `az ${equinoxNoon.azimuth.toFixed(2)}`
  );
}

// 4. Refraction is continuous across -1 degrees and the elevation is not clamped.
{
  let maxStep = 0;
  let previous = sunPosition(new Date(DAY_UTC_MS + 17 * 3600000), LAT, LON).elevation;
  let minElevation = Infinity;
  for (let s = 1; s <= 24 * 60; s++) {
    const e = sunPosition(new Date(DAY_UTC_MS + 17 * 3600000 + s * 60000), LAT, LON).elevation;
    maxStep = Math.max(maxStep, Math.abs(e - previous));
    minElevation = Math.min(minElevation, e);
    previous = e;
  }
  assert.ok(maxStep < 0.3, `elevation jumps by ${maxStep} deg per minute`);
  assert.ok(minElevation < -20, `elevation clamped at ${minElevation}`);
  pass(
    `minute-to-minute elevation step max ${maxStep.toFixed(4)} deg; night minimum ${minElevation.toFixed(1)} deg`
  );
}

// 5. sunDirection: unit length, cardinal directions.
{
  const east = sunDirection(90, 0);
  const north = sunDirection(0, 0);
  const up = sunDirection(123, 90);
  assert.ok(
    Math.abs(east[0] - 1) < 1e-12 && Math.abs(east[1]) < 1e-12 && Math.abs(east[2]) < 1e-12
  );
  assert.ok(Math.abs(north[1] - 1) < 1e-12 && Math.abs(north[0]) < 1e-12);
  assert.ok(Math.abs(up[2] - 1) < 1e-12);
  const d = sunDirection(222.14, 41.63);
  assert.ok(Math.abs(Math.hypot(d[0], d[1], d[2]) - 1) < 1e-12);
  assert.ok(d[0] < 0 && d[1] < 0 && d[2] > 0, 'SW sun');
  pass('sunDirection: unit length, E/N/zenith, south-west afternoon sun');
}

// 6. Air mass and colour.
{
  assert.ok(Math.abs(airMass(90) - 1) < 1e-3, `airMass(90) ${airMass(90)}`);
  assert.ok(Math.abs(airMass(30) - 2) < 0.01, `airMass(30) ${airMass(30)}`);
  assert.ok(Math.abs(airMass(0) - 38) < 0.5, `airMass(0) ${airMass(0)}`);
  const noon = sunColor(65);
  const low = sunColor(5);
  const horizon = sunColor(0);
  assert.ok(
    noon.every(v => v > 0.85 && v <= 1.0001),
    `noon ${noon}`
  );
  assert.ok(low[0] > low[1] && low[1] > low[2], `low sun not warm ${low}`);
  assert.ok(
    horizon[2] < 0.01 * horizon[0] + 1e-9 || horizon[2] < low[2],
    'horizon bluer than 5 deg'
  );
  assert.deepEqual(sunColor(-10), [0, 0, 0]);
  pass(
    `airMass 90/30/0 = ${airMass(90).toFixed(3)}/${airMass(30).toFixed(3)}/${airMass(0).toFixed(2)}; ` +
      `colour 65 deg ${noon.map(v => v.toFixed(2))}, 5 deg ${low.map(v => v.toFixed(2))}`
  );
}

// 7. Table, sunrise/sunset and CEST formatting.
{
  const table = buildSunTable(DAY_UTC_MS, LAT, LON);
  assert.equal(table.length, 288);
  assert.equal(table[0].minutes, 0);
  assert.equal(table[287].minutes, 1435);
  assert.equal(buildSunTable(DAY_UTC_MS, LAT, LON, 15).length, 96);
  const sample = table[13 * 12 + 6]; // 13:30 UTC
  assert.ok(Math.abs(Math.hypot(...sample.direction) - 1) < 1e-12);
  assert.ok(sample.color.every(v => v >= 0 && v <= 1));
  const {rise, set} = sunriseSunset(table);
  // Independent check of the crossing: bisect the geometric/refracted elevation to -0.833.
  const bisect = (lo: number, hi: number): number => {
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const rising = sunPosition(new Date(DAY_UTC_MS + lo * 60000), LAT, LON).elevation < -0.833;
      const below = sunPosition(new Date(DAY_UTC_MS + mid * 60000), LAT, LON).elevation < -0.833;
      if (below === rising) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const riseExact = bisect(Math.floor(rise / 5) * 5, Math.floor(rise / 5) * 5 + 5);
  const setExact = bisect(Math.floor(set / 5) * 5, Math.floor(set / 5) * 5 + 5);
  assert.ok(Math.abs(rise - riseExact) < 0.2, `rise ${rise} vs ${riseExact}`);
  assert.ok(Math.abs(set - setExact) < 0.2, `set ${set} vs ${setExact}`);
  // The spec says sunset about 17:50 UTC; the day is 13.x hours long in early September.
  assert.ok(set > 17 * 60 + 30 && set < 18 * 60 + 15, `set ${set}`);
  assert.ok(rise > 4 * 60 && rise < 5 * 60 + 30, `rise ${rise}`);
  assert.equal(formatCest(0), '02:00');
  assert.equal(formatCest(13 * 60 + 28), '15:28');
  assert.equal(formatCest(22 * 60 + 30), '00:30');
  assert.equal(formatCest(-120), '00:00');
  pass(
    `table 288 samples; sunrise ${formatCest(rise)} CEST (${rise.toFixed(2)} UTC min), ` +
      `sunset ${formatCest(set)} CEST (${set.toFixed(2)} UTC min); bisection agrees <0.2 min`
  );
}

// 8. Physical anchors that share no coefficients with the implementation.
{
  // June solstice 2026 (declination +23.436 deg): at the tropic the sun passes the zenith.
  let peak = -90;
  for (let m = 0; m < 1440; m++) {
    const e = sunPosition(new Date(Date.UTC(2026, 5, 21) + m * 60000), 23.4362, 0).elevation;
    peak = Math.max(peak, e);
  }
  assert.ok(peak > 89.9, `solstice tropic peak ${peak}`);
  // Equation of time peaks at +16m25s about 3 November: solar noon on the Greenwich meridian is
  // then at 11:43:35 UTC. The elevation maximum (flat near noon) is found from the azimuth
  // crossing 180 degrees instead, which is sharp.
  const tNov = Date.UTC(2026, 10, 3);
  let crossing = NaN;
  let previous = sunPosition(new Date(tNov + 11 * 3600000), 40, 0).azimuth;
  for (let m = 661; m <= 780; m++) {
    const az = sunPosition(new Date(tNov + m * 60000), 40, 0).azimuth;
    if (previous < 180 && az >= 180) crossing = m - (az - 180) / (az - previous);
    previous = az;
  }
  const expectedNoon = 12 * 60 - 16.4;
  assert.ok(Math.abs(crossing - expectedNoon) < 0.5, `3 Nov noon ${crossing} vs ${expectedNoon}`);
  pass(
    `anchors: solstice tropic peak ${peak.toFixed(3)} deg; 3 Nov transit ${crossing.toFixed(2)} ` +
      `UTC min (almanac ${expectedNoon.toFixed(2)})`
  );
}
