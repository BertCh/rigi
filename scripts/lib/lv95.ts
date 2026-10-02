// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Rigorous WGS84 <-> LV95 (EPSG:2056) for the build scripts, through @math.gl/proj4: Swiss oblique
// Mercator on Bessel plus the EPSG 3-parameter Helmert. It replaces the swisstopo approximate
// polynomials (about 0.7 m forward, 4 m inverse) that terroir and the gipfelbuch sheet used to copy.
// Every name states its axis order: lon/lat in degrees, E/N in metres.
import { Projection } from "@math.gl/proj4";
import { LV95_PROJ_DEFINITION } from "../../src/lib/geo/lv95";

export type LonLat = [lon: number, lat: number];
export type EastNorth = [easting: number, northing: number];

const lv95Projection = new Projection({
	from: "EPSG:4326",
	to: LV95_PROJ_DEFINITION,
});

export function lonLatToLv95(lon: number, lat: number): EastNorth {
	const [easting, northing] = lv95Projection.project([lon, lat]);
	return [easting, northing];
}

export function lv95ToLonLat(easting: number, northing: number): LonLat {
	const [lon, lat] = lv95Projection.unproject([easting, northing]);
	return [lon, lat];
}
