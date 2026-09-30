// Checks for the N2 licence work (src/lib/licences, src/lib/osm). Run: npx tsx scripts/licences-check.ts
//   [--no-network]  skip the live Overpass identity comparison
// 1. imagery provider "default" returns byte-identical URL lists to the pre-N2 inline code (both paths)
// 2. MAPTERHORN.url is unchanged without MAPTERHORN_URL
// 3. attribution lists the expected sources for a few places
// 4. the OSM pre-extract answers the upload-region and baseline peak queries exactly as Overpass does
//    (needs a public/osm extract covering the test photos: tools/osm/extract-peaks.mjs)
import { readFile } from "node:fs/promises";
import path from "node:path";
import { MAPTERHORN } from "../src/lib/dem/sources";
import { overpassPeaksQuery, parseOverpassPeaks } from "../src/lib/geo/peaks";
import {
	attributionFor,
	attributionLine,
} from "../src/lib/licences/attribution";
import { imageryTileUrls } from "../src/lib/licences/imagery";
import {
	namedPeaksInBBox,
	parseBBox,
	peaksAround,
	setExtractLoader,
} from "../src/lib/osm/extract";
import { type OsmElement, OVERPASS, overpass } from "../src/lib/overpass";

// src/lib/upload/region.ts imports a Vite virtual module, so its pure helpers are mirrored here
// (PEAK_RADIUS_KM 60, REGION_SNAP_DEG 0.05, bboxAround, the peaks query, parsePeaks' tag reads).
const PEAK_RADIUS_KM = 60;
const snapCenter = (lat: number, lon: number) => {
	const s = (v: number) => Math.round(v / 0.05) * 0.05;
	return [Number(s(lat).toFixed(4)), Number(s(lon).toFixed(4))] as const;
};
const pkString = (lat: number, lon: number) => {
	const dLat = PEAK_RADIUS_KM / 111.32;
	const dLon = PEAK_RADIUS_KM / (111.32 * Math.cos((lat * Math.PI) / 180));
	return [lat - dLat, lon - dLon, lat + dLat, lon + dLon]
		.map((v) => v.toFixed(5))
		.join(",");
};
const regionPeaksQuery = (lat: number, lon: number) =>
	`[out:json][timeout:90];node["natural"~"peak|volcano"]["name"](${pkString(lat, lon)});out;`;
const peakBBox = (lat: number, lon: number) => parseBBox(pkString(lat, lon));
const parsePeaks = (els: OsmElement[]) =>
	els.map((e) => [
		(e as { id?: number }).id,
		e.lat,
		e.lon,
		e.tags?.name,
		e.tags?.ele,
		e.tags?.prominence,
	]);

let failures = 0;
const ok = (cond: boolean, msg: string) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
	if (!cond) failures++;
};

// ---- 1. imagery parity: verbatim copies of the code the provider replaced (git HEAD 71e846e) ----
const SWISS_BBOX = { west: 5.9, east: 10.55, south: 45.8, north: 47.85 };
function oldTerrainUrl(
	src: "satellite" | "topo",
	z: number,
	x: number,
	y: number,
	lat: number,
	lon: number,
): string[] {
	const inCH =
		lon > SWISS_BBOX.west &&
		lon < SWISS_BBOX.east &&
		lat > SWISS_BBOX.south &&
		lat < SWISS_BBOX.north;
	const esri = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
	if (src === "satellite") {
		return inCH && z >= 8
			? [
					`https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/${z}/${x}/${y}.jpeg`,
					esri,
				]
			: [esri];
	}
	const osm = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
	return inCH
		? [
				`https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/${z}/${x}/${y}.jpeg`,
				osm,
			]
		: [osm];
}
const tileXToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileYToLat = (y: number, z: number) => {
	const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
	return (180 / Math.PI) * Math.atan(Math.sinh(n));
};
{
	let n = 0;
	let bad = 0;
	let rnd = 12345;
	const rand = () => {
		rnd = (rnd * 1103515245 + 12345) % 2 ** 31;
		return rnd / 2 ** 31;
	};
	for (let z = 3; z <= 19; z++)
		for (let i = 0; i < 400; i++) {
			// half the samples in/around the Alps, half anywhere
			const lon = i % 2 ? 4 + rand() * 8 : -180 + rand() * 360;
			const lat = i % 2 ? 44.5 + rand() * 4.5 : -80 + rand() * 160;
			const x = Math.floor(((lon + 180) / 360) * 2 ** z);
			const y = Math.floor(
				((1 -
					Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) /
					2) *
					2 ** z,
			);
			const clat = tileYToLat(y + 0.5, z);
			const clon = tileXToLon(x + 0.5, z);
			for (const src of ["satellite", "topo"] as const) {
				n++;
				const a = JSON.stringify(oldTerrainUrl(src, z, x, y, clat, clon));
				const b = JSON.stringify(
					imageryTileUrls(src, z, x, y, clat, clon, "default"),
				);
				if (a !== b) bad++;
			}
		}
	ok(
		bad === 0,
		`imagery "default" provider identical to pre-N2 URLs (${n - bad}/${n} tile×kind cases)`,
	);
	const inCH = imageryTileUrls(
		"satellite",
		14,
		8580,
		5760,
		47.05,
		8.48,
		"swisstopo",
	);
	const outCH = imageryTileUrls(
		"satellite",
		14,
		8000,
		5760,
		47.05,
		3.0,
		"swisstopo",
	);
	ok(
		inCH.length === 1 && inCH[0].includes("swissimage") && outCH.length === 0,
		"swisstopo provider: SWISSIMAGE in CH only, no Esri",
	);
	ok(
		imageryTileUrls(
			"satellite",
			14,
			8580,
			5760,
			47.05,
			8.48,
			"esri",
		)[0].includes("arcgisonline"),
		"esri provider: Esri in CH",
	);
}

// ---- 2. DEM URL default ----
ok(
	MAPTERHORN.url({ z: 12, x: 2145, y: 1440 }) ===
		"https://tiles.mapterhorn.com/12/2145/1440.webp",
	`MAPTERHORN.url unchanged by default (${MAPTERHORN.url({ z: 12, x: 2145, y: 1440 })})`,
);

// ---- 3. attribution ----
{
	const rigi = attributionFor({
		lat: 47.0565,
		lon: 8.4852,
		imagery: "satellite",
	}).map((c) => c.id);
	for (const id of [
		"mapterhorn",
		"glo30",
		"swissalti3d",
		"swisstopo",
		"esri",
		"osm",
	])
		ok(rigi.includes(id), `Rigi view credits ${id}`);
	const nepal = attributionFor({
		lat: 27.99,
		lon: 86.93,
		imagery: "satellite",
	}).map((c) => c.id);
	ok(
		JSON.stringify(nepal) ===
			JSON.stringify(["mapterhorn", "glo30", "esri", "osm"]),
		`Everest view credits only global sources (${nepal.join(",")})`,
	);
	const clean = attributionFor({
		lat: 47.0565,
		lon: 8.4852,
		imagery: "satellite",
		provider: "swisstopo",
	}).map((c) => c.id);
	ok(!clean.includes("esri"), "swisstopo provider drops the Esri credit");
	console.log(
		`  line  : ${attributionLine({ lat: 47.0565, lon: 8.4852, imagery: "satellite" })}`,
	);
	console.log(
		`  export: ${attributionLine({ lat: 47.0565, lon: 8.4852, imagery: "satellite" }, { compact: true })}`,
	);
	console.log(
		`  topo  : ${attributionLine({ lat: 45.9763, lon: 7.6586, imagery: "topo" }, { compact: true })}`,
	);
}

// public instances shed load with 429/504: retry politely (30 s, 60 s, 90 s)
async function overpassPolite(q: string, o: Parameters<typeof overpass>[1]) {
	for (let i = 0; ; i++) {
		try {
			return await overpass(q, o);
		} catch (e) {
			if (i >= 3) throw e;
			console.log(`  (${(e as Error).message}; retry in ${30 * (i + 1)} s)`);
			await new Promise((r) => setTimeout(r, 30_000 * (i + 1)));
		}
	}
}

// ---- 4. OSM pre-extract identity ----
const OSM_DIR = path.resolve(import.meta.dirname ?? ".", "../public/osm");
setExtractLoader(async (file) =>
	JSON.parse(await readFile(path.join(OSM_DIR, file), "utf8")),
);
{
	const far = await namedPeaksInBBox([27.5, 86.5, 28.5, 87.5]);
	ok(
		far === null,
		"outside every extract → null (caller falls back to Overpass)",
	);
}
if (!process.argv.includes("--no-network")) {
	// photo spots inside public/osm/peaks-central-ch-test.json (46.4,7.4,47.65,9.35)
	const spots: [string, number, number][] = [
		["Rigi Kulm", 47.0565, 8.4852],
		["Pilatus", 46.9791, 8.2523],
	];
	// the extract came from overpass-api.de; mirrors lag it by minutes to days, so compare against it only
	const opts = {
		endpoints: [OVERPASS.main],
		timeoutMs: 120_000,
		userAgent: "Rigi licences-check (scripts/licences-check.ts)",
	};
	const extractBase = JSON.parse(
		await readFile(path.join(OSM_DIR, "peaks-central-ch-test.json"), "utf8"),
	).osmBase;
	console.log(`  extract osm_base ${extractBase}`);
	for (const [name, lat, lon] of spots) {
		const [clat, clon] = snapCenter(lat, lon);
		const fromExtract = await namedPeaksInBBox(peakBBox(clat, clon));
		if (!fromExtract) {
			ok(
				false,
				`${name}: extract does not cover the region bbox ${peakBBox(clat, clon)}`,
			);
			continue;
		}
		const live = await overpassPolite(regionPeaksQuery(clat, clon), opts);
		console.log(
			`  ${name}: live osm_base ${(live as { osm3s?: { timestamp_osm_base?: string } }).osm3s?.timestamp_osm_base}`,
		);
		const a = JSON.stringify(parsePeaks(live.elements));
		const b = JSON.stringify(parsePeaks(fromExtract.elements));
		const ids = (els: { id?: number }[]) => els.map((e) => e.id).join(",");
		ok(
			a === b,
			`${name}: region peaks identical (Overpass ${live.elements.length} vs extract ${fromExtract.elements.length} nodes; ids ${ids(live.elements as { id?: number }[]) === ids(fromExtract.elements as { id?: number }[]) ? "same order" : "DIFFER"})`,
		);
		if (a !== b) {
			const sa = new Set(
				(live.elements as unknown as { id: number }[]).map((e) => e.id),
			);
			const sb = new Set(
				(fromExtract.elements as unknown as { id: number }[]).map((e) => e.id),
			);
			console.log(
				`  only Overpass: ${[...sa].filter((i) => !sb.has(i)).slice(0, 10)}  only extract: ${[...sb].filter((i) => !sa.has(i)).slice(0, 10)}`,
			);
		}
		await new Promise((r) => setTimeout(r, 3000));
	}
	// baseline worker query shape (around), smaller radius so it fits inside the test extract
	const [lat, lon, r] = [47.0565, 8.4852, 40_000];
	const ex = await peaksAround(lat, lon, r);
	if (!ex) ok(false, "around: extract does not cover the circle");
	else {
		const live = await overpassPolite(overpassPeaksQuery(lat, lon, r), opts);
		const a = JSON.stringify(parseOverpassPeaks(live));
		const b = JSON.stringify(parseOverpassPeaks(ex));
		ok(
			a === b,
			`around ${r / 1000} km of Rigi: identical (Overpass ${live.elements.length} vs extract ${ex.elements.length})`,
		);
	}
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
