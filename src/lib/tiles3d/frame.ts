// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Placing an ECEF (ellipsoidal) 3D Tiles tileset in the photo's ENU frame (geodesy.ts EnuFrame, origin
// at the photo's lat/lon, h = 0, MSL heights used as-is). float64 on the CPU: the tile meshes reach the
// GPU relative to their own centres, so ECEF magnitudes never lose precision.
import { Matrix4 } from "@math.gl/core";
import { enuRotation, toEcef } from "../geodesy";

/**
 * ENU(Rigi) ← ECEF: the east/north/up rotation at (lat, lon) about the ellipsoid point at h = 0, then
 * down by the geoid undulation N so ellipsoidal heights land on the DEM's MSL heights.
 */
export function enuFromEcef(lat: number, lon: number, geoidN: number): Matrix4 {
	const [ox, oy, oz] = toEcef(lat, lon, 0);
	// rows: east, north, up (geodesy.ts enuRotation)
	const r = enuRotation(lat, lon);
	const t = (row: number) =>
		-(r[row * 3] * ox + r[row * 3 + 1] * oy + r[row * 3 + 2] * oz);
	// biome-ignore format: a 4×4 matrix reads best as rows
	return new Matrix4().setRowMajor(
		r[0], r[1], r[2], t(0),
		r[3], r[4], r[5], t(1),
		r[6], r[7], r[8], t(2) - geoidN,
		0, 0, 0, 1,
	);
}
