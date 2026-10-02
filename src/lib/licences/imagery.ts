// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Draped-imagery provider abstraction (roadmap N2). The terrain path (src/lib/deck/terrain-data.ts) asks this module for a tile's URL list, tried in order.
//
// Providers (`?imagery=<id>` or VITE_IMAGERY_PROVIDER=<id>; the default is "default"):
//   default   : exactly the app's historic behaviour, byte-identical URLs. Satellite = swisstopo
//               SWISSIMAGE inside Switzerland at z >= 8 with Esri World Imagery as fallback, Esri
//               elsewhere. Topo = swisstopo Pixelkarte in CH with OSM fallback, OSM elsewhere.
//   esri      : Esri World Imagery everywhere for satellite (topo unchanged).
//   swisstopo : licence-clean satellite. SWISSIMAGE inside Switzerland only (OGD, commercial use OK
//               with "© swisstopo"); no Esri pixels anywhere, so tiles outside CH stay undraped.
//   custom    : VITE_IMAGERY_URL template ({z},{x},{y}; {-y} for TMS) for a licensed provider,
//               credited with VITE_IMAGERY_ATTRIBUTION. Topo unchanged.
// Esri stays the global default until the owner decides (reports/licences.md).
import { readSetting } from "./config";

export type ImageryKind = "satellite" | "topo";
export type ImageryProviderId = "default" | "esri" | "swisstopo" | "custom";

export const SWISS_BBOX = { west: 5.9, east: 10.55, south: 45.8, north: 47.85 };

export const inSwissBBox = (lat: number, lon: number) =>
	lon > SWISS_BBOX.west &&
	lon < SWISS_BBOX.east &&
	lat > SWISS_BBOX.south &&
	lat < SWISS_BBOX.north;

export const esriUrl = (z: number, x: number, y: number) =>
	`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
export const swissimageUrl = (z: number, x: number, y: number) =>
	`https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/${z}/${x}/${y}.jpeg`;
export const pixelkarteUrl = (z: number, x: number, y: number) =>
	`https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/${z}/${x}/${y}.jpeg`;
export const osmTileUrl = (z: number, x: number, y: number) =>
	`https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

const PROVIDERS: readonly ImageryProviderId[] = [
	"default",
	"esri",
	"swisstopo",
	"custom",
];

/** The configured provider; unknown values (and "custom" without a URL) fall back to "default". */
export function imageryProvider(): ImageryProviderId {
	const v = readSetting("imagery", "IMAGERY_PROVIDER") as
		| ImageryProviderId
		| undefined;
	if (!v || !PROVIDERS.includes(v)) return "default";
	if (v === "custom" && !customTemplate()) return "default";
	return v;
}

export const customTemplate = () => readSetting(null, "IMAGERY_URL");
export const customAttribution = () =>
	readSetting(null, "IMAGERY_ATTRIBUTION") ??
	"Imagery provider (set VITE_IMAGERY_ATTRIBUTION)";

function fillTemplate(t: string, z: number, x: number, y: number) {
	return t
		.replace("{z}", String(z))
		.replace("{x}", String(x))
		.replace("{-y}", String(2 ** z - 1 - y))
		.replace("{y}", String(y));
}

/**
 * URLs for one 256 px web-mercator imagery tile, tried in order. `lat`/`lon` are the tile centre
 * (the caller's inside-Switzerland test point). With provider "default" this returns exactly what
 * terrain.ts / deck/terrain-data.ts returned before the abstraction existed.
 */
export function imageryTileUrls(
	kind: ImageryKind,
	z: number,
	x: number,
	y: number,
	lat: number,
	lon: number,
	provider: ImageryProviderId = imageryProvider(),
): string[] {
	const inCH = inSwissBBox(lat, lon);
	if (kind === "satellite") {
		switch (provider) {
			case "esri":
				return [esriUrl(z, x, y)];
			case "swisstopo":
				return inCH ? [swissimageUrl(z, x, y)] : [];
			case "custom": {
				const t = customTemplate();
				return t ? [fillTemplate(t, z, x, y)] : [];
			}
			default:
				return inCH && z >= 8
					? [swissimageUrl(z, x, y), esriUrl(z, x, y)]
					: [esriUrl(z, x, y)];
		}
	}
	return inCH
		? [pixelkarteUrl(z, x, y), osmTileUrl(z, x, y)]
		: [osmTileUrl(z, x, y)];
}
