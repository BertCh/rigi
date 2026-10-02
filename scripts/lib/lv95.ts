// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Rigorous WGS84 <-> LV95 (EPSG:2056) for the build scripts, through @math.gl/proj4: Swiss oblique
// Mercator on Bessel plus the EPSG 3-parameter Helmert. It replaces the swisstopo approximate
// polynomials (about 0.7 m forward, 4 m inverse) that terroir and the gipfelbuch sheet used to copy.
// Every name states its axis order: lon/lat in degrees, E/N in metres.
import { Projection } from "@math.gl/proj4";

const LV95_DEFINITION =
	"+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs";

export type LonLat = [lon: number, lat: number];
export type EastNorth = [easting: number, northing: number];

const lv95Projection = new Projection({
	from: "EPSG:4326",
	to: LV95_DEFINITION,
});

export function lonLatToLv95(lon: number, lat: number): EastNorth {
	const [easting, northing] = lv95Projection.project([lon, lat]);
	return [easting, northing];
}

export function lv95ToLonLat(easting: number, northing: number): LonLat {
	const [lon, lat] = lv95Projection.unproject([easting, northing]);
	return [lon, lat];
}
