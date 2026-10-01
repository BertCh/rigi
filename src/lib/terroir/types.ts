// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Terroir pack: per-region, pre-baked place data (reports/terroir-cartography.md §4 phase 1).
// Built by scripts/terroir/build-pack.ts into public/terroir/<id>/; loaded by ./pack.ts.
// Display-only: nothing here feeds the matcher, pose, confidence, benchmarks or measurement exports.
//
// Sources are kept separate (swisstopo vs OSM) and composited at render time, never merged into one
// database (the ODbL derivative-database trap, reports/terroir-cartography.md §6).

/** [west, south, east, north] in degrees (WGS84). */
export type BBox = [number, number, number, number];
export type LonLat = [number, number];

/** Land-cover class ids (the cover raster's R channel). 0 = no data. See ./classes.ts for labels and colours. */
export type CoverClassId =
	| 0 // no data
	| 1 // glacier
	| 2 // firn / perennial snow
	| 3 // bare rock
	| 4 // scree / debris
	| 5 // forest, conifer
	| 6 // forest, broadleaf / mixed
	| 7 // shrub / dwarf pine / heath
	| 8 // alpine pasture / grassland
	| 9 // meadow / farmland
	| 10 // vineyard
	| 11 // orchard
	| 12 // water
	| 13 // built-up
	| 14; // wetland

/** Name classes, mapped from swissNAMES3D OBJEKTART or OSM tags. Typography lives in ./classes.ts. */
export type NameClass =
	| "peak-major"
	| "peak"
	| "peak-minor"
	| "ridge"
	| "massif"
	| "pass"
	| "glacier"
	| "lake"
	| "river"
	| "waterfall"
	| "valley"
	| "region"
	| "city"
	| "town"
	| "village"
	| "hamlet"
	| "alp"
	| "hut"
	| "field"
	| "lift"
	| "other";

export type NameLang = "de" | "fr" | "it" | "rm" | "multi";
/** swissNAMES3D STATUS: offiziell / üblich / informell. */
export type NameStatus = "official" | "usual" | "informal";

export type TerroirName = {
	/** The name as shown by default (official, local-language form). */
	name: string;
	/** Usual / paired / exonym form, shown as a second line under 'local+usual' (e.g. "Bienne"). */
	alt?: string;
	cls: NameClass;
	/** Anchor: a peak's summit, a lake's label point, a ridge's midpoint… */
	lat: number;
	lon: number;
	/** Metres above sea level at the anchor, when known (swissNAMES3D Z, OSM ele). */
	ele: number | null;
	lang: NameLang | null;
	status: NameStatus | null;
	src: "swissnames3d" | "osm";
	/** Optional polyline for line features (ridges, rivers, valleys), downsampled. */
	line?: LonLat[];
	/** Polygon area in km² for areal features (lakes, glaciers, regions), used for ranking. */
	areaKm2?: number;
	/** Topographic prominence in metres for peaks, when known. */
	prominence?: number | null;
};

/** One dated glacier extent (GLAMOS SGI, RGI, or the swisstopo historic extent layer). */
export type GlacierExtent = {
	year: number;
	source: string;
	/** MultiPolygon: polygons → rings → [lon, lat]. Rings closed or open; outer ring first. */
	polygons: LonLat[][][];
	/** Terrain height (m, MSL) per ring vertex, parallel to `polygons` (sampled from the DEM at build). */
	heights?: number[][][];
	/** Glacier names per polygon index, when known. */
	names?: (string | null)[];
};

/** Simplified lithology polygon (GeoCover → 6–10 display classes). */
export type LithologyUnit = {
	cls:
		| "limestone"
		| "marl-shale"
		| "sandstone-conglomerate"
		| "flysch"
		| "crystalline"
		| "ophiolite"
		| "quaternary"
		| "other";
	label: string;
	polygons: LonLat[][][];
};

/** The land-cover raster: an 8-bit class PNG (R = CoverClassId) in plain lon/lat over `bbox`. */
export type CoverRasterMeta = {
	url: string;
	width: number;
	height: number;
	bbox: BBox;
	/** approximate cell size in metres */
	cellM: number;
	/** per-class counts (sanity / legend) */
	histogram?: Record<string, number>;
};

export type TerroirSource = {
	id: string;
	label: string;
	licence: string;
	url: string;
	/** The credit line to show (swisstopo OGD / Copernicus / OSM require attribution). */
	credit: string;
};

export type TerroirPack = {
	v: 1;
	id: string;
	name: string;
	bbox: BBox;
	created: string;
	sources: TerroirSource[];
	names: TerroirName[];
	glaciers: GlacierExtent[];
	cover: CoverRasterMeta | null;
	lithology: LithologyUnit[] | null;
};

export type TerroirPackIndex = {
	v: 1;
	packs: { id: string; name: string; bbox: BBox; path: string }[];
};
