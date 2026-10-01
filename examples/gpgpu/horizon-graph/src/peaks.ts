// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {EARTH_RADIUS_METERS, type GeographicPosition} from './terrain-mosaic';

/** Niederhorn summit-ridge viewpoint above Lake Thun (phone GPS fix, altitude in metres). */
export const NIEDERHORN = {latitude: 46.710169, longitude: 7.773319, altitude: 1919};

export type Peak = GeographicPosition & {name: string; elevation: number};

/** Summit positions and elevations from OpenStreetMap (© OpenStreetMap contributors, ODbL). */
export const PEAKS: Peak[] = [
  {name: 'Eiger', latitude: 46.5776321, longitude: 8.0054694, elevation: 3970},
  {name: 'Mönch', latitude: 46.558506, longitude: 7.997271, elevation: 4107},
  {name: 'Jungfrau', latitude: 46.5367739, longitude: 7.9625907, elevation: 4158},
  {name: 'Niesen', latitude: 46.6461936, longitude: 7.6523674, elevation: 2362},
  {name: 'Stockhorn', latitude: 46.6940109, longitude: 7.5377356, elevation: 2190}
];

/** Great-circle initial bearing (degrees clockwise from north) and distance (metres). */
export function getBearingAndDistance(
  from: GeographicPosition,
  to: GeographicPosition
): {azimuth: number; distance: number} {
  const toRadians = Math.PI / 180;
  const latitude1 = from.latitude * toRadians;
  const latitude2 = to.latitude * toRadians;
  const deltaLongitude = (to.longitude - from.longitude) * toRadians;
  const y = Math.sin(deltaLongitude) * Math.cos(latitude2);
  const x =
    Math.cos(latitude1) * Math.sin(latitude2) -
    Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(deltaLongitude);
  const azimuth = (((Math.atan2(y, x) / toRadians) % 360) + 360) % 360;
  const halfChord =
    Math.sin((latitude2 - latitude1) / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;
  const distance = 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(halfChord));
  return {azimuth, distance};
}
