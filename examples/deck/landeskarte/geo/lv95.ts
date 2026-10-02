// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Swiss LV95 (CH1903+ / EPSG:2056) coordinates, for the sheet's kilometre grid. These are
// swisstopo's published approximate formulas ("Näherungslösungen für die direkte Transformation
// WGS84 <-> LV95"), good to about 1 m inside Switzerland: ample for grid lines and labels.

/** Bern, old observatory: the datum origin of LV95. */
export const LV95_ORIGIN = {e: 2600000, n: 1200000};

/** WGS84 degrees to LV95 metres (E ~2 600 000, N ~1 200 000 at Bern). */
export function wgs84ToLv95(lat: number, lon: number): {e: number; n: number} {
  // Auxiliary values: offsets from Bern in units of 10 000 arc seconds.
  const phi = (lat * 3600 - 169028.66) / 10000;
  const lambda = (lon * 3600 - 26782.5) / 10000;
  const e =
    2600072.37 +
    211455.93 * lambda -
    10938.51 * lambda * phi -
    0.36 * lambda * phi * phi -
    44.54 * lambda ** 3;
  const n =
    1200147.07 +
    308807.95 * phi +
    3745.25 * lambda * lambda +
    76.63 * phi * phi -
    194.56 * lambda * lambda * phi +
    119.79 * phi ** 3;
  return {e, n};
}

/** LV95 metres to WGS84 degrees. */
export function lv95ToWgs84(e: number, n: number): {lat: number; lon: number} {
  // Auxiliary values: offsets from Bern in units of 1000 km.
  const y = (e - LV95_ORIGIN.e) / 1e6;
  const x = (n - LV95_ORIGIN.n) / 1e6;
  const lambda = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3;
  const phi =
    16.9023892 +
    3.238272 * x -
    0.270978 * y * y -
    0.002528 * x * x -
    0.0447 * y * y * x -
    0.014 * x ** 3;
  // Units of 10 000 arc seconds to degrees.
  return {lat: (phi * 100) / 36, lon: (lambda * 100) / 36};
}
