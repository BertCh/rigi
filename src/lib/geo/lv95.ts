// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The Swiss LV95 (EPSG:2056) coordinate system as a PROJ definition for @math.gl/proj4: Swiss
// oblique Mercator on Bessel plus the EPSG 3-parameter Helmert. One copy for the app and the scripts.

/** EPSG code of CH1903+ / LV95. */
export const LV95_EPSG_CODE = 2056;

/** PROJ definition of LV95 (use as the `to` of a WGS84 `EPSG:4326` projection; project takes [lon, lat]). */
export const LV95_PROJ_DEFINITION =
	"+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs";
