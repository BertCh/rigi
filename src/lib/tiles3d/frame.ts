// Placing an ECEF (ellipsoidal) 3D Tiles tileset in the photo's ENU frame (geodesy.ts EnuFrame, origin
// at the photo's lat/lon, h = 0, MSL heights used as-is). float64 on the CPU: the tile meshes reach the
// GPU relative to their own centres, so ECEF magnitudes never lose precision.
import * as THREE from "three";
import { DEG, toEcef } from "../geodesy";

/**
 * ENU(Rigi) ← ECEF: the east/north/up rotation at (lat, lon) about the ellipsoid point at h = 0, then
 * down by the geoid undulation N so ellipsoidal heights land on the DEM's MSL heights.
 */
export function enuFromEcef(
	lat: number,
	lon: number,
	geoidN: number,
): THREE.Matrix4 {
	const [ox, oy, oz] = toEcef(lat, lon, 0);
	const sp = Math.sin(lat * DEG);
	const cp = Math.cos(lat * DEG);
	const sl = Math.sin(lon * DEG);
	const cl = Math.cos(lon * DEG);
	// rows: east, north, up (geodesy.ts EnuFrame)
	const r = [-sl, cl, 0, -sp * cl, -sp * sl, cp, cp * cl, cp * sl, sp];
	const t = (row: number) =>
		-(r[row * 3] * ox + r[row * 3 + 1] * oy + r[row * 3 + 2] * oz);
	// biome-ignore format: a 4×4 matrix reads best as rows
	return new THREE.Matrix4().set(
		r[0], r[1], r[2], t(0),
		r[3], r[4], r[5], t(1),
		r[6], r[7], r[8], t(2) - geoidN,
		0, 0, 0, 1,
	);
}
