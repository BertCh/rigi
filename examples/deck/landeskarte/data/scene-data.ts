// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Constants of the scene: where the eye is, which day it is, and which lakes are labelled.
// Everything here is traceable to `public/demo/manifest.json` in the Rigi repository (photo and
// pose `demo-01`) or to a stated public value.

import type {GeoPoint, LakeLabel} from '../types';

/** 2026-09-07T00:00:00Z. Every `minutes` value in the example counts from here. */
export const DAY_UTC_MS = Date.UTC(2026, 8, 7);

/** Central European Summer Time offset on that day, hours. */
export const CEST_OFFSET_HOURS = 2;

/**
 * The summit eye: the lens of photo `demo-01` (EXIF GPS position and altitude, taken 13:28 UTC).
 * The frame origin sits here, so the flight to `SUMMIT_FRAME_VIEW` ends exactly on that photo's
 * viewpoint. The Niederhorn top itself (OSM, 1963 m) is about 45 m higher and 30 m north-east.
 */
export const SUMMIT_EYE: GeoPoint = {
  lat: 46.710169444444446,
  lon: 7.773319444444445,
  h: 1918.8886827458257
};

/**
 * Pose Rigi's skyline matcher solved for `demo-01` against the Mapterhorn DEM
 * (`poses['demo-01']`, source `solved`, confidence 0.80). Solved, not verified. The photo is
 * 2048 x 1536, so the aspect ratio is 4:3. Angles in degrees; roll turns the image clockwise.
 */
export const SUMMIT_FRAME_VIEW = {
  yaw: 260.7210154739064,
  pitch: -3.525384238570591,
  roll: -2.4125504553581942,
  vfov: 52.11182410915413,
  aspect: 4 / 3
};

/** Surface of Thunersee and Brienzersee in metres above sea level (swisstopo, rounded). */
export const LAKE_THUN_ELEVATION = 558;
export const LAKE_BRIENZ_ELEVATION = 564;

/**
 * Lake label anchors (WGS84), checked against the Mapterhorn z12 DEM: both sit on cells at the
 * lake level (Thunersee at its widest, off Merligen; Brienzersee mid-lake). Not shorelines.
 */
export const LAKES: LakeLabel[] = [
  {id: 'thunersee', name: 'Thunersee', lat: 46.694, lon: 7.7, ele: LAKE_THUN_ELEVATION},
  {id: 'brienzersee', name: 'Brienzersee', lat: 46.7305, lon: 7.9715, ele: LAKE_BRIENZ_ELEVATION}
];

/**
 * Bounding box of the baked trail extract (WGS84 degrees). Keep in sync with
 * `scripts/bake-data.mjs`. About 17 km by 15 km around the summit.
 */
export const NIEDERHORN_BBOX = {west: 7.66, south: 46.64, east: 7.89, north: 46.78};
