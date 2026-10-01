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
  /** Photo width / height. */
  aspectRatio: number;
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

/** Lake Thun's surface, metres above sea level: the height the orbit camera pivots at. */
export const LAKE_THUN_ELEVATION = 558;
