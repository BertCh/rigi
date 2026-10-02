// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Geodesy for the Landeskarte example: the local east/north/up frame at the summit, the one
// curvature + refraction convention used by every module, and a few closed-form helpers.
//
// Convention (CPU, shaders and compute kernels all agree):
//   up = elevation - (1 - k) (east^2 + north^2) / (2 R)
// with R = EARTH_R and k the coefficient of refraction. The terrain stays planar in `Frame.toEnu`
// (up = h - origin.h); the drop is applied separately so it can be switched off or varied live.

import type {ENU, Frame, GeoPoint} from '../types';

/** Mean Earth radius (IUGG), metres. */
export const EARTH_R = 6371008.8;

/** Coefficient of terrestrial refraction. Real values are about 0.08 to 0.20 (a parameter, not a fact). */
export const REFRACTION_K = 0.13;

const DEG = Math.PI / 180;
const WGS84_A = 6378137;
const WGS84_E2 = 0.00669437999014;

// Small-angle series. Offsets stay below ~1 degree (150 km), where the truncation error is
// below a millimetre, and the shaders need them because large-argument sin/cos lose f32 digits.
const smallSine = (x: number): number => x - (x * x * x) / 6;
const smallVersine = (x: number): number => {
  const x2 = x * x;
  return x2 / 2 - (x2 * x2) / 24;
};

/**
 * Local ENU frame at (lat, lon, h). Same polynomials as summit-view's dem-tiles.ts, which the
 * terrain vertex shaders reproduce, so CPU queries land on the rendered surface.
 */
export function makeFrame(lat: number, lon: number, h: number): Frame {
  const sinLat = Math.sin(lat * DEG);
  const cosLat = Math.cos(lat * DEG);
  const w = 1 - WGS84_E2 * sinLat * sinLat;
  const primeVerticalRadius = WGS84_A / Math.sqrt(w);
  const meridionalRadius = (WGS84_A * (1 - WGS84_E2)) / w ** 1.5;
  const origin: GeoPoint = {lat, lon, h};

  // East/north for offsets in radians at height h (heights scale the ground distances by
  // (R + h) / R: a point 3 km up sits that much further from the Earth's axis).
  const forward = (dLat: number, dLon: number, h: number): [number, number] => {
    const cosLatAt = cosLat * (1 - smallVersine(dLat)) - sinLat * smallSine(dLat);
    const heightScale = 1 + h / EARTH_R;
    const east = primeVerticalRadius * cosLatAt * smallSine(dLon) * heightScale;
    const north =
      (meridionalRadius * smallSine(dLat) +
        primeVerticalRadius * cosLatAt * sinLat * smallVersine(dLon)) *
      heightScale;
    return [east, north];
  };

  return {
    origin,
    sinLat,
    cosLat,
    meridionalRadius,
    primeVerticalRadius,
    earthRadius: EARTH_R,
    toEnu(pLat, pLon, pH): ENU {
      const [east, north] = forward((pLat - lat) * DEG, (pLon - lon) * DEG, pH);
      return [east, north, pH - h];
    },
    toGeo(enu): GeoPoint {
      const pH = h + enu[2];
      const heightScale = 1 + pH / EARTH_R;
      // The forward map is a smooth near-identity of the linear one, so a fixed-point iteration
      // on the linear Jacobian converges to sub-micrometre in a handful of steps.
      const metresPerLon = primeVerticalRadius * cosLat * heightScale;
      const metresPerLat = meridionalRadius * heightScale;
      let dLat = enu[1] / metresPerLat;
      let dLon = enu[0] / metresPerLon;
      for (let i = 0; i < 6; i++) {
        const [east, north] = forward(dLat, dLon, pH);
        dLat += (enu[1] - north) / metresPerLat;
        dLon += (enu[0] - east) / metresPerLon;
      }
      return {lat: lat + dLat / DEG, lon: lon + dLon / DEG, h: pH};
    }
  };
}

/** Height drop of the line of sight's reference surface at planar distance d, metres. */
export function curvatureDrop(d: number, k: number = REFRACTION_K): number {
  return ((1 - k) * d * d) / (2 * EARTH_R);
}

/** Distance to the geometric horizon from an eye h metres up, metres: sqrt(2 R h / (1 - k)). */
export function geometricHorizon(h: number, k: number = REFRACTION_K): number {
  return Math.sqrt((2 * EARTH_R * Math.max(h, 0)) / (1 - k));
}

/**
 * Great-circle distance (metres, on the mean sphere) and initial bearing (degrees clockwise from
 * north, 0..360) from a to b.
 */
export function haversine(
  a: {lat: number; lon: number},
  b: {lat: number; lon: number}
): {distance: number; bearing: number} {
  const phi1 = a.lat * DEG;
  const phi2 = b.lat * DEG;
  const dPhi = phi2 - phi1;
  const dLambda = (b.lon - a.lon) * DEG;
  const s = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  const distance = 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const bearing = (((Math.atan2(y, x) / DEG) % 360) + 360) % 360;
  return {distance, bearing};
}

/**
 * Apparent elevation angle of `to` seen from `from`, degrees. Uses the planar distance and
 * subtracts the curvature drop, the same tangent the horizon kernels maximise:
 * (dUp - drop) / d. Returns 0 for coincident points in plan.
 */
export function elevationAngle(from: ENU, to: ENU, k: number = REFRACTION_K): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const d = Math.hypot(dx, dy);
  const dUp = to[2] - from[2];
  if (d === 0) return dUp === 0 ? 0 : dUp > 0 ? 90 : -90;
  return Math.atan2(dUp - curvatureDrop(d, k), d) / DEG;
}
