// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/** Camera orientation in a local east/north/up frame. Angles in degrees. */
export type CameraPose = {
  /** Heading of the optical axis, clockwise from true north. */
  yaw: number;
  /** Elevation of the optical axis above the horizontal plane. */
  pitch: number;
  /** Rotation about the optical axis; positive turns the image clockwise. */
  roll: number;
  /** Vertical field of view across the image height. */
  verticalFieldOfView: number;
};

/** Where the photo was taken and how the camera was pointed. */
export type PhotoCamera = CameraPose & {
  longitude: number;
  latitude: number;
  /** Lens height in metres above mean sea level. */
  altitude: number;
  /** Photo width / height, which the canvas must match for the pose to apply. */
  aspectRatio: number;
};

/** A named summit from OpenStreetMap. */
export type Peak = {
  name: string;
  longitude: number;
  latitude: number;
  /** Elevation in metres from the OSM `ele` tag. */
  elevation: number;
};

/**
 * Niederhorn above Lake Thun, 7 September 2026, 15:28 local time, looking west over the lake.
 *
 * Provenance: `public/demo/manifest.json` in the Rigi repository, photo `demo-01`. Position and
 * altitude are the photo's EXIF GPS; yaw, pitch, roll and field of view are the pose Rigi's
 * skyline matcher solved against the Mapterhorn DEM (`poses['demo-01']`, source `solved`,
 * confidence 0.80), so they already include curvature and refraction.
 */
export const NIEDERHORN_CAMERA: PhotoCamera = {
  longitude: 7.773319444444445,
  latitude: 46.710169444444446,
  altitude: 1918.89,
  yaw: 260.7210154739064,
  pitch: -3.525384238570591,
  roll: -2.4125504553581942,
  verticalFieldOfView: 52.11182410915413,
  aspectRatio: 2048 / 1536
};

/**
 * Summits in the photo's field of view, from OpenStreetMap `natural=peak` nodes
 * (© OpenStreetMap contributors, ODbL), as cached in `public/demo/manifest.json` `region.peaks`.
 */
export const PEAKS: readonly Peak[] = [
  {name: 'Niesen', longitude: 7.6523674, latitude: 46.6461936, elevation: 2362},
  {name: 'Triesthore', longitude: 7.62262, latitude: 46.6242959, elevation: 2321},
  {name: 'Seehorn', longitude: 7.4613209, latitude: 46.5668496, elevation: 2281},
  {name: 'Niderhorn', longitude: 7.4299643, latitude: 46.5929478, elevation: 2077},
  {name: 'Vanil Noir', longitude: 7.1483661, latitude: 46.5284985, elevation: 2389},
  {name: 'Bäderhore', longitude: 7.327378, latitude: 46.613273, elevation: 2009},
  {name: 'Kaiseregg', longitude: 7.3190559, latitude: 46.6524972, elevation: 2185},
  {name: 'Stockhorn', longitude: 7.5377356, latitude: 46.6940109, elevation: 2190},
  {name: 'Gantrisch', longitude: 7.450763, latitude: 46.7046865, elevation: 2175},
  {name: 'Selibüel', longitude: 7.438686, latitude: 46.7315829, elevation: 1750}
];
