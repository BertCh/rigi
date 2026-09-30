// Per-source attribution for everything the app draws from third-party data (roadmap N2).
// One registry feeds the UI credit line and the export footer, so they cannot drift.
//
// Mapterhorn: the tile service's own TileJSON (tiles.mapterhorn.com/tilejson.json) asks for
// `<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>`; that page lists the underlying
// national DEMs, most of them CC BY 4.0 / OGD, which require naming the producer. Mapterhorn does
// not expose which source fed which pixel, so producers are listed when their coverage bbox
// (hand-drawn, generous) intersects the area the view can see. Over-crediting is harmless;
// under-crediting is not. Records mirror download.mapterhorn.com/attribution.json (fetched
// 2026-09-29, v0.0.13); Alpine sources only. See reports/licences.md.
import { attributionMode } from "./config";
import {
	customAttribution,
	type ImageryKind,
	type ImageryProviderId,
	imageryProvider,
	inSwissBBox,
} from "./imagery";

export type CreditKind = "dem" | "imagery" | "map" | "osm";

export interface Credit {
	id: string;
	kind: CreditKind;
	/** Short text for the one-line credit (no leading ©). */
	label: string;
	/** Producer abbreviation for tight footers (image exports). */
	short?: string;
	href: string;
	licence: string;
}

/** [west, south, east, north] */
type BBox = [number, number, number, number];

interface DemSourceCredit extends Credit {
	bbox: BBox | null; // null = global
}

const MT = "https://github.com/mapterhorn/mapterhorn/blob/main/source-catalog";

export const MAPTERHORN_CREDIT: Credit = {
	id: "mapterhorn",
	kind: "dem",
	label: "Mapterhorn",
	href: "https://mapterhorn.com/attribution",
	licence: "Tiles BSD-3 code; data under each source's licence",
};

/** Mapterhorn sources that can appear in an Alpine view (subset of attribution.json). */
export const MAPTERHORN_SOURCES: readonly DemSourceCredit[] = [
	{
		id: "glo30",
		short: "Copernicus",
		kind: "dem",
		bbox: null,
		label: "Copernicus GLO-30 (DLR, Airbus, EU/ESA)",
		licence: "Copernicus free and open",
		href: `${MT}/glo30/LICENSE.pdf`,
	},
	{
		id: "swissalti3d",
		short: "swisstopo",
		kind: "dem",
		bbox: [5.95, 45.81, 10.5, 47.81],
		label: "swisstopo swissALTI3D",
		licence: "OGD (swisstopo)",
		href: `${MT}/swissalti3d/LICENSE.pdf`,
	},
	{
		id: "chzh",
		short: "Kt. Zürich",
		kind: "dem",
		bbox: [8.35, 47.15, 8.99, 47.7],
		label: "Kanton Zürich DTM",
		licence: "CC0",
		href: `${MT}/chzh/LICENSE.pdf`,
	},
	{
		id: "ign",
		short: "IGN",
		kind: "dem",
		bbox: [-5.2, 41.3, 9.6, 51.1],
		label: "IGN RGE ALTI / LiDAR HD",
		licence: "Licence Ouverte 2.0",
		href: `${MT}/frrgealti1metro/LICENSE.pdf`,
	},
	{
		id: "tinitaly",
		short: "INGV",
		kind: "dem",
		bbox: [6.6, 35.5, 18.6, 47.1],
		label: "INGV TINITALY",
		licence: "CC BY 4.0",
		href: `${MT}/tinitaly/LICENSE.pdf`,
	},
	{
		id: "itaosta",
		short: "RAVA",
		kind: "dem",
		bbox: [6.8, 45.45, 7.95, 45.99],
		label: "Regione Autonoma Valle d'Aosta DTM",
		licence: "CC BY 4.0",
		href: `${MT}/itaosta/LICENSE.pdf`,
	},
	{
		id: "itpiemonte",
		short: "Reg. Piemonte",
		kind: "dem",
		bbox: [6.6, 44.05, 9.25, 46.47],
		label: "Regione Piemonte DTM 5",
		licence: "CC BY 4.0",
		href: `${MT}/itpiemonte/LICENSE.pdf`,
	},
	{
		id: "itlombardia",
		short: "Reg. Lombardia",
		kind: "dem",
		bbox: [8.49, 44.68, 11.43, 46.64],
		label: "Regione Lombardia DTM 5x5",
		licence: "CC BY 4.0",
		href: `${MT}/itlombardia/LICENSE.pdf`,
	},
	{
		id: "ittrentino",
		short: "PAT Trento",
		kind: "dem",
		bbox: [10.45, 45.67, 11.97, 46.54],
		label: "Provincia Autonoma di Trento LiDAR",
		licence: "CC BY 2.5",
		href: `${MT}/ittrentino/LICENSE.pdf`,
	},
	{
		id: "itbozen",
		short: "Prov. Bozen",
		kind: "dem",
		bbox: [10.38, 46.22, 12.48, 47.09],
		label: "Autonome Provinz Bozen DGM",
		licence: "CC0",
		href: `${MT}/itbozen/LICENSE.pdf`,
	},
	{
		id: "at",
		short: "BEV/geoland.at",
		kind: "dem",
		bbox: [9.53, 46.37, 17.16, 49.02],
		label: "BEV / geoland.at DGM",
		licence: "CC BY 4.0",
		href: `${MT}/at1/LICENSE.pdf`,
	},
	{
		id: "atkaernten",
		short: "Land Kärnten",
		kind: "dem",
		bbox: [12.65, 46.37, 15.07, 47.13],
		label: "Land Kärnten DGM",
		licence: "CC BY 4.0",
		href: `${MT}/atkaernten/LICENSE.pdf`,
	},
	{
		id: "atsalzburg",
		short: "Land Salzburg",
		kind: "dem",
		bbox: [12.08, 46.94, 13.99, 48.04],
		label: "Land Salzburg DGM",
		licence: "CC BY 4.0",
		href: `${MT}/atsalzburg/LICENSE.pdf`,
	},
	{
		id: "debayern",
		short: "LDBV Bayern",
		kind: "dem",
		bbox: [8.97, 47.27, 13.84, 50.56],
		label: "Bayerische Vermessungsverwaltung DGM1",
		licence: "CC BY 4.0",
		href: `${MT}/debayern/LICENSE.pdf`,
	},
	{
		id: "debw",
		short: "LGL-BW",
		kind: "dem",
		bbox: [7.51, 47.53, 10.5, 49.79],
		label: "LGL Baden-Württemberg, dl-de/by-2-0",
		licence: "DL-DE-BY-2.0",
		href: `${MT}/debw/LICENSE.pdf`,
	},
	{
		id: "si",
		short: "ARSO",
		kind: "dem",
		bbox: [13.37, 45.42, 16.61, 46.88],
		label: "ARSO Slovenia DMR",
		licence: "CC BY 4.0",
		href: `${MT}/si/LICENSE.pdf`,
	},
];

export const OSM_CREDIT: Credit = {
	id: "osm",
	kind: "osm",
	label: "OpenStreetMap contributors",
	href: "https://www.openstreetmap.org/copyright",
	licence: "ODbL 1.0",
};

export const SWISSTOPO_CREDIT: Credit = {
	id: "swisstopo",
	kind: "imagery",
	label: "swisstopo",
	href: "https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices",
	licence: "OGD, commercial use with attribution",
};

export const ESRI_CREDIT: Credit = {
	id: "esri",
	kind: "imagery",
	// Esri's required World Imagery credit
	label: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
	href: "https://www.esri.com/en-us/legal/terms/full-master-agreement",
	licence: "Esri Master Agreement (ArcGIS account required)",
};

/** The credit line the app has always shown (kept verbatim for the classic mode). */
export const CLASSIC_UI_LINE =
	"Terrain © Mapterhorn · Imagery © swisstopo, Esri · Peaks & trails © OpenStreetMap contributors";

export interface AttributionQuery {
	lat: number;
	lon: number;
	/** How far the view reaches (terrain radius), km. Default 150. */
	radiusKm?: number;
	/** Imagery currently draped; undefined/"none" = no imagery credit. */
	imagery?: ImageryKind | "none";
	provider?: ImageryProviderId;
	/** OSM-derived labels / trails shown. Default true. */
	osm?: boolean;
}

function viewBBox(lat: number, lon: number, km: number): BBox {
	const dLat = km / 111.32;
	const dLon = km / (111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
	return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

const intersects = (a: BBox, b: BBox) =>
	a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/** Every credit the current view needs, DEM first. */
export function attributionFor(q: AttributionQuery): Credit[] {
	const box = viewBBox(q.lat, q.lon, q.radiusKm ?? 150);
	const out: Credit[] = [MAPTERHORN_CREDIT];
	for (const s of MAPTERHORN_SOURCES)
		if (!s.bbox || intersects(s.bbox, box)) {
			const { bbox: _b, ...c } = s;
			out.push(c);
		}
	const provider = q.provider ?? imageryProvider();
	// the view box can straddle the border even when the photo does not
	const nearCH =
		intersects(box, [5.9, 45.8, 10.55, 47.85]) || inSwissBBox(q.lat, q.lon);
	if (q.imagery === "satellite") {
		if (provider === "custom")
			out.push({
				id: "custom",
				kind: "imagery",
				label: customAttribution(),
				href: "",
				licence: "per provider",
			});
		else {
			if (provider !== "esri" && nearCH) out.push(SWISSTOPO_CREDIT);
			// default: Esri outside CH, below z8 and as the in-CH fallback, so always credited
			if (provider === "esri" || provider === "default") out.push(ESRI_CREDIT);
		}
	} else if (q.imagery === "topo") {
		if (nearCH) out.push({ ...SWISSTOPO_CREDIT, kind: "map" });
		out.push({ ...OSM_CREDIT, kind: "map" });
	}
	if (q.osm !== false && !out.some((c) => c.id === "osm")) out.push(OSM_CREDIT);
	return out;
}

/** One line for a UI footer or image export: "Terrain © Mapterhorn (…) · Imagery © … · © OSM contributors". */
export function attributionLine(
	q: AttributionQuery,
	o: { compact?: boolean } = {},
): string {
	const cs = attributionFor(q);
	const dem = cs.filter((c) => c.kind === "dem" && c.id !== "mapterhorn");
	const img = cs.filter((c) => c.kind === "imagery" || c.kind === "map");
	const parts = [
		`Terrain © Mapterhorn${dem.length ? ` (${[...new Set(dem.map((c) => (o.compact && c.short) || c.label))].join(", ")})` : ""}`,
	];
	const names = [
		...new Set(img.filter((c) => c.id !== "osm").map((c) => c.label)),
	];
	if (names.length)
		parts.push(
			`${img.some((c) => c.kind === "map") ? "Map" : "Imagery"} © ${names.join(", ")}`,
		);
	if (cs.some((c) => c.id === "osm"))
		parts.push("© OpenStreetMap contributors");
	return parts.join(" · ");
}

/** Plain-text credits block for sidecar/zip exports (one credit per line with licence and link). */
export function attributionText(q: AttributionQuery): string {
	return attributionFor(q)
		.map((c) => `© ${c.label} — ${c.licence}${c.href ? ` — ${c.href}` : ""}`)
		.join("\n");
}

/** True when the per-source credit should replace the classic fixed line (`?attrib=full`). */
export const fullAttribution = () => attributionMode() === "full";
