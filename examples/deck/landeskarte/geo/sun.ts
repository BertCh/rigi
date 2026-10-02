// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Solar position and sunlight colour for the Landeskarte clock: the NOAA / Meeus low-precision
// ephemeris (about 0.01 degrees over 1950..2050), Saemundsson refraction (the NOAA form), and a clear-sky extinction
// colour along the Kasten-Young air mass. Pure CPU; the time axis, the shadow field and the grade
// all read their sun from here, so there is exactly one sun in the example.

import type {RGB, SunSample, Vec3} from '../types';

const DEG = Math.PI / 180;

/** Elevation of the sun centre at which the table reports sunrise and sunset (NOAA convention). */
const HORIZON_ELEVATION = -0.833;

/**
 * Sun position for a UTC instant and a place.
 * `azimuth` is degrees clockwise from true north, `elevation` is the apparent (refracted) angle in
 * degrees and is deliberately not clamped: the shadow code wants to see the sun go below zero.
 */
export function sunPosition(
  date: Date,
  lat: number,
  lon: number
): {azimuth: number; elevation: number} {
  const julianDay = date.getTime() / 86400000 + 2440587.5;
  const T = (julianDay - 2451545) / 36525; // Julian centuries since J2000

  const meanLongitude = 280.46646 + T * (36000.76983 + T * 0.0003032);
  const meanAnomaly = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const eccentricity = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const M = meanAnomaly * DEG;
  const equationOfCentre =
    Math.sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M) * 0.000289;
  const trueLongitude = meanLongitude + equationOfCentre;
  const omega = (125.04 - 1934.136 * T) * DEG; // longitude of the Moon's node: nutation and aberration
  const apparentLongitude = (trueLongitude - 0.00569 - 0.00478 * Math.sin(omega)) * DEG;
  const meanObliquity =
    23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const obliquity = (meanObliquity + 0.00256 * Math.cos(omega)) * DEG;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLongitude));

  // Equation of time in minutes (Meeus 28.3).
  const y = Math.tan(obliquity / 2) ** 2;
  const L0 = meanLongitude * DEG;
  const equationOfTime =
    (4 / DEG) *
    (y * Math.sin(2 * L0) -
      2 * eccentricity * Math.sin(M) +
      4 * eccentricity * y * Math.sin(M) * Math.cos(2 * L0) -
      0.5 * y * y * Math.sin(4 * L0) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * M));

  const utcMinutes =
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60 +
    date.getUTCMilliseconds() / 60000;
  const trueSolarMinutes = (((utcMinutes + equationOfTime + 4 * lon) % 1440) + 1440) % 1440;
  const hourAngle = (trueSolarMinutes / 4 - 180) * DEG;

  const phi = lat * DEG;
  const cosZenith =
    Math.sin(phi) * Math.sin(declination) +
    Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle);
  const geometricElevation = 90 - Math.acos(Math.min(1, Math.max(-1, cosZenith))) / DEG;

  // Refraction of a true altitude (Saemundsson, as NOAA uses; Bennett's is the same curve for the
  // apparent altitude), arcminutes to degrees. It is only valid down to about -1 degrees, so below
  // that it is faded out over one more degree instead of jumping (0.65 degrees at -1).
  let elevation = geometricElevation;
  const refraction =
    1.02 / (60 * Math.tan((geometricElevation + 10.3 / (geometricElevation + 5.11)) * DEG));
  if (geometricElevation > -1) {
    elevation += refraction;
  } else if (geometricElevation > -2) {
    elevation += fadedRefraction(geometricElevation);
  }

  const azimuth =
    (Math.atan2(
      Math.sin(hourAngle),
      Math.cos(hourAngle) * Math.sin(phi) - Math.tan(declination) * Math.cos(phi)
    ) /
      DEG +
      540) %
    360;
  return {azimuth, elevation};
}

/** Refraction between -2 and -1 degrees: the value at -1 faded linearly to zero at -2. */
function fadedRefraction(geometricElevation: number): number {
  const atEdge = 1.02 / (60 * Math.tan((-1 + 10.3 / (-1 + 5.11)) * DEG));
  return atEdge * (geometricElevation + 2);
}

/** Unit vector towards the sun in ENU (east, north, up) from azimuth and elevation in degrees. */
export function sunDirection(azimuth: number, elevation: number): Vec3 {
  const horizontal = Math.cos(elevation * DEG);
  return [
    horizontal * Math.sin(azimuth * DEG),
    horizontal * Math.cos(azimuth * DEG),
    Math.sin(elevation * DEG)
  ];
}

/** Kasten-Young (1989) relative optical air mass for an apparent elevation in degrees. */
export function airMass(elevation: number): number {
  const clamped = Math.max(elevation, 0);
  return 1 / (Math.sin(clamped * DEG) + 0.50572 * (clamped + 6.07995) ** -1.6364);
}

// Sea-level Rayleigh coefficients (1/m) for R, G, B and an aerosol optical depth, the same
// numbers the atmosphere shader uses (see atmosphere.ts), over a scale height of 8 km.
const BETA_RAYLEIGH: RGB = [5.8e-6, 13.5e-6, 33.1e-6];
const RAYLEIGH_SCALE_HEIGHT = 8000;
const AEROSOL_OPTICAL_DEPTH = 0.06;

/**
 * Linear RGB of direct sunlight after extinction along the air mass, 0..1. Normalised so that the
 * sun at one air mass is white: only the relative reddening of a lower sun remains, and the
 * exposure of the scene stays the grade's job. Fades to black across the horizon.
 */
export function sunColor(elevation: number): RGB {
  const mass = airMass(Math.max(elevation, 0.5));
  const fade = Math.min(1, Math.max(0, (elevation + 1) / 4));
  const color: RGB = [0, 0, 0];
  for (let channel = 0; channel < 3; channel++) {
    const optical = BETA_RAYLEIGH[channel] * RAYLEIGH_SCALE_HEIGHT + AEROSOL_OPTICAL_DEPTH;
    color[channel] = Math.exp(-optical * (mass - 1)) * fade;
  }
  return color;
}

/** The day at `stepMin` resolution from 00:00 UTC (288 samples at the default 5 minutes). */
export function buildSunTable(
  dayUtcMs: number,
  lat: number,
  lon: number,
  stepMin: number = 5
): SunSample[] {
  const samples: SunSample[] = [];
  for (let minutes = 0; minutes < 1440; minutes += stepMin) {
    const {azimuth, elevation} = sunPosition(new Date(dayUtcMs + minutes * 60000), lat, lon);
    samples.push({
      minutes,
      azimuth,
      elevation,
      direction: sunDirection(azimuth, elevation),
      color: sunColor(elevation)
    });
  }
  return samples;
}

/**
 * First rise and last set of the day in UTC minutes, interpolated linearly where the apparent
 * elevation crosses -0.833 degrees. NaN when the sun never crosses (polar day or night).
 */
export function sunriseSunset(table: SunSample[]): {rise: number; set: number} {
  let rise = NaN;
  let set = NaN;
  for (let i = 1; i < table.length; i++) {
    const before = table[i - 1];
    const after = table[i];
    const crossesUp = before.elevation < HORIZON_ELEVATION && after.elevation >= HORIZON_ELEVATION;
    const crossesDown =
      before.elevation >= HORIZON_ELEVATION && after.elevation < HORIZON_ELEVATION;
    if (!crossesUp && !crossesDown) continue;
    const t = (HORIZON_ELEVATION - before.elevation) / (after.elevation - before.elevation);
    const minutes = before.minutes + t * (after.minutes - before.minutes);
    if (crossesUp && Number.isNaN(rise)) rise = minutes;
    if (crossesDown) set = minutes;
  }
  return {rise, set};
}

/** UTC minutes since midnight as 'HH:MM' in Central European Summer Time (UTC+2). */
export function formatCest(minutes: number): string {
  const total = ((Math.round(minutes + 120) % 1440) + 1440) % 1440;
  const hours = Math.floor(total / 60);
  return `${String(hours).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
