// Static OSM pre-extracts (roadmap N2): answer peak queries from a file under public/osm/ instead of
// the public Overpass API (~10k queries/day shared by everyone) when the query area lies wholly
// inside an extract. Built by tools/osm/extract-peaks.mjs; listed in public/osm/extracts.json.
//
// The answers reproduce what Overpass would return for the same query and the same OSM snapshot:
// the same nodes (bbox inclusive, regex tag match), the same order (ascending id, Overpass's `out`
// default) and the tags the app's parsers read. Anything outside every extract returns null so
// the caller falls back to Overpass. Opt-in: callers check osmExtractEnabled() (licences/config).
// Data: © OpenStreetMap contributors, ODbL 1.0.
import type { SWNE } from "../ontology/core/geometry";
import type { OsmElement } from "../overpass";

export const EXTRACT_FORMAT = "rigi-osm-extract/1";

/** [south, west, north, east], Overpass order (the canonical ontology SWNE). */
export type { SWNE };

/** One node: [id, lat, lon, tags]. Tags hold only EXTRACT_TAGS keys that are present. */
export type ExtractNode = [number, number, number, Record<string, string>];

export interface OsmExtract {
	format: typeof EXTRACT_FORMAT;
	bbox: SWNE;
	generated: string;
	/** Overpass osm3s.timestamp_osm_base of the (last) query. */
	osmBase?: string;
	licence: string;
	/** node["natural"~"peak|volcano"] in bbox, ascending id. */
	peaks: ExtractNode[];
	/** node["tourism"="viewpoint"] in bbox, ascending id. */
	viewpoints?: ExtractNode[];
}

export interface ExtractManifestEntry {
	file: string;
	bbox: SWNE;
	peaks: number;
	viewpoints?: number;
	bytes: number;
	generated: string;
}

/** Tags kept per node: everything src/lib/geo/peaks.ts and src/lib/upload/region.ts read. */
export const EXTRACT_TAGS = [
	"natural",
	"tourism",
	"name",
	"name:de",
	"name:en",
	"ele",
	"prominence",
	"wikidata",
] as const;

function baseUrl(): string {
	try {
		const b = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL;
		return b ?? "/";
	} catch {
		return "/";
	}
}

let manifestP: Promise<ExtractManifestEntry[]> | null = null;
const extracts = new Map<string, Promise<OsmExtract | null>>();

/** Injectable for Node checks (scripts/licences-check.ts). */
export type ExtractLoader = (file: string) => Promise<unknown>;
let loader: ExtractLoader = async (file) => {
	const res = await fetch(`${baseUrl()}osm/${file}`);
	if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
	return res.json();
};
export function setExtractLoader(l: ExtractLoader) {
	loader = l;
	manifestP = null;
	extracts.clear();
}

export function extractManifest(): Promise<ExtractManifestEntry[]> {
	manifestP ??= loader("extracts.json")
		.then((m) => (m as { extracts?: ExtractManifestEntry[] })?.extracts ?? [])
		.catch(() => {
			manifestP = null; // retry next time (dev server may not have the file yet)
			return [];
		});
	return manifestP;
}

const contains = (outer: SWNE, inner: SWNE) =>
	outer[0] <= inner[0] &&
	outer[1] <= inner[1] &&
	outer[2] >= inner[2] &&
	outer[3] >= inner[3];

/** The first listed extract that fully covers `bbox`, or null. */
export async function extractCovering(bbox: SWNE): Promise<OsmExtract | null> {
	const entry = (await extractManifest()).find((e) => contains(e.bbox, bbox));
	if (!entry) return null;
	let p = extracts.get(entry.file);
	if (!p) {
		p = loader(entry.file)
			.then((j) => {
				const x = j as OsmExtract;
				return x?.format === EXTRACT_FORMAT && Array.isArray(x.peaks)
					? x
					: null;
			})
			.catch(() => null);
		extracts.set(entry.file, p);
		p.then((x) => {
			if (!x) extracts.delete(entry.file);
		});
	}
	const x = await p;
	// the file's own bbox is authoritative (a stale manifest must not widen coverage)
	return x && contains(x.bbox, bbox) ? x : null;
}

const toElement = ([id, lat, lon, tags]: ExtractNode): OsmElement & {
	id: number;
} => ({
	type: "node",
	id,
	lat,
	lon,
	tags: { ...tags },
});

const inBox = (b: SWNE, lat: number, lon: number) =>
	lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];

/**
 * Same result as `[out:json];node["natural"~"peak|volcano"]["name"](s,w,n,e);out;`
 * (src/lib/upload/region.ts regionQueries().peaks), or null when no extract covers the bbox.
 */
export async function namedPeaksInBBox(
	bbox: SWNE,
): Promise<{ elements: OsmElement[] } | null> {
	const x = await extractCovering(bbox);
	if (!x) return null;
	const re = /peak|volcano/;
	return {
		elements: x.peaks
			.filter(
				([, lat, lon, t]) =>
					t.name !== undefined &&
					re.test(t.natural ?? "") &&
					inBox(bbox, lat, lon),
			)
			.map(toElement),
	};
}

// Overpass `around` measures great-circle distance on a sphere whose half circumference is
// 20,000 km (R = 2e7/π m), not WGS84's 6378137 m
const R_OVERPASS = 20_000_000 / Math.PI;
function greatCircleM(lat0: number, lon0: number, lat1: number, lon1: number) {
	const D = Math.PI / 180;
	const a =
		Math.sin(((lat1 - lat0) * D) / 2) ** 2 +
		Math.cos(lat0 * D) *
			Math.cos(lat1 * D) *
			Math.sin(((lon1 - lon0) * D) / 2) ** 2;
	return 2 * R_OVERPASS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Same result as src/lib/geo/peaks.ts overpassPeaksQuery(lat, lon, radiusM) (natural=peak or
 * volcano, exact match, within `around`), or null when no extract covers the circle. The circle
 * test follows Overpass's spherical `around`; nodes within ~1 m of the rim can differ.
 */
export async function peaksAround(
	lat: number,
	lon: number,
	radiusM: number,
): Promise<{ elements: OsmElement[] } | null> {
	const la = Number(lat.toFixed(5));
	const lo = Number(lon.toFixed(5));
	const r = Math.round(radiusM);
	const dLat = (r / R_OVERPASS) * (180 / Math.PI) * 1.001;
	const dLon =
		dLat / Math.max(0.01, Math.cos((Math.abs(la) + dLat) * (Math.PI / 180)));
	const x = await extractCovering([la - dLat, lo - dLon, la + dLat, lo + dLon]);
	if (!x) return null;
	return {
		elements: x.peaks
			.filter(
				([, plat, plon, t]) =>
					(t.natural === "peak" || t.natural === "volcano") &&
					greatCircleM(la, lo, plat, plon) <= r,
			)
			.map(toElement),
	};
}

/** Parse the numeric bbox out of an Overpass `(s,w,n,e)` filter string, as Overpass would read it. */
export function parseBBox(s: string): SWNE {
	const v = s.split(",").map(Number);
	if (v.length !== 4 || v.some((n) => !Number.isFinite(n)))
		throw new Error(`bad bbox ${s}`);
	return v as SWNE;
}
