// EGM2008 geoid undulation N (m): h_ellipsoid = H_msl + N. Rigi's ENU frame carries the DEM's MSL
// heights as if they were ellipsoidal (export/camera.ts), so ellipsoidal ECEF tilesets must be
// lowered by N (47–55 m in Switzerland) to sit on the DEM. Grids: scripts/tiles3d/make-geoid.py.
import { GEOID_ALPS, GEOID_GLOBAL, type GeoidGrid } from "./geoid-data";

type Decoded = GeoidGrid & { cm: Int16Array };
const cache = new Map<GeoidGrid, Decoded>();

function decode(g: GeoidGrid): Decoded {
	let d = cache.get(g);
	if (!d) {
		const bin =
			typeof atob === "function"
				? Uint8Array.from(atob(g.b64), (c) => c.charCodeAt(0))
				: new Uint8Array(Buffer.from(g.b64, "base64"));
		d = {
			...g,
			cm: new Int16Array(bin.buffer, bin.byteOffset, g.rows * g.cols),
		};
		cache.set(g, d);
	}
	return d;
}

function bilinear(g: Decoded, lat: number, lon: number): number | null {
	const fy = (lat - g.lat0) / g.step;
	let fx = (lon - g.lon0) / g.step;
	if (g === cache.get(GEOID_GLOBAL))
		fx = ((fx % (g.cols - 1)) + (g.cols - 1)) % (g.cols - 1);
	const y = Math.floor(fy);
	const x = Math.floor(fx);
	if (y < 0 || x < 0 || y >= g.rows - 1 || x >= g.cols - 1) return null;
	const dy = fy - y;
	const dx = fx - x;
	const i = y * g.cols + x;
	const c = g.cm;
	return (
		(c[i] * (1 - dx) * (1 - dy) +
			c[i + 1] * dx * (1 - dy) +
			c[i + g.cols] * (1 - dx) * dy +
			c[i + g.cols + 1] * dx * dy) /
		100
	);
}

/** EGM2008 N (m) at a WGS84 position: 0.1° grid in the Alps (≤ 0.16 m), else 1° global (≤ ~3 m). */
export function geoidUndulation(lat: number, lon: number): number {
	return (
		bilinear(decode(GEOID_ALPS), lat, lon) ??
		bilinear(
			decode(GEOID_GLOBAL),
			Math.min(Math.max(lat, -89.999), 89.999),
			lon,
		) ??
		0
	);
}
