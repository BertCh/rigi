// Web-Mercator (slippy map) tile math shared by every DEM consumer.
import { DEG, EARTH_R } from "../geodesy";

export type TileKey = { z: number; x: number; y: number };

export const tileId = (k: TileKey) => `${k.z}/${k.x}/${k.y}`;

export const parentKey = (k: TileKey): TileKey => ({
	z: k.z - 1,
	x: k.x >> 1,
	y: k.y >> 1,
});

/** Fractional tile coordinates. */
export function lonToTileX(lon: number, z: number) {
	return ((lon + 180) / 360) * 2 ** z;
}
export function latToTileY(lat: number, z: number) {
	const s = Math.sin(lat * DEG);
	return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
}
export function lonLatToTile(lon: number, lat: number, z: number) {
	return { x: lonToTileX(lon, z), y: latToTileY(lat, z) };
}
export function tileXToLon(x: number, z: number) {
	return (x / 2 ** z) * 360 - 180;
}
export function tileYToLat(y: number, z: number) {
	const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
	return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

export function tileBounds(t: TileKey) {
	return {
		west: tileXToLon(t.x, t.z),
		east: tileXToLon(t.x + 1, t.z),
		north: tileYToLat(t.y, t.z),
		south: tileYToLat(t.y + 1, t.z),
	};
}

/** All tiles at zoom z touching a circle of `radius` metres. */
export function tilesAround(
	lat: number,
	lon: number,
	radius: number,
	z: number,
): TileKey[] {
	const dLat = radius / EARTH_R / DEG;
	const dLon = dLat / Math.cos(lat * DEG);
	const a = lonLatToTile(lon - dLon, lat + dLat, z);
	const b = lonLatToTile(lon + dLon, lat - dLat, z);
	const keys: TileKey[] = [];
	for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++)
		for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++)
			keys.push({ z, x, y });
	return keys;
}
