// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Terroir pack builder (reports/terroir-cartography.md §4 phase 1). Contract: src/lib/terroir/types.ts.
//   npx tsx scripts/terroir/build-pack.ts --id thunersee --bbox 7.35,46.45,8.25,46.95 --name "Thunersee · Bernese Oberland"
// Env: TERROIR_CACHE = download cache dir (default ~/.cache/rigi/terroir). Everything is fetched by node at build time.
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { M_PER_DEG_LAT } from "../../src/lib/geodesy";
import type {
	BBox,
	TerroirPack,
	TerroirPackIndex,
	TerroirSource,
} from "../../src/lib/terroir/types";
import { Dem } from "./lib/dem";
import { CACHE, cachedZip } from "./lib/fetch";
import {
	buildCover,
	buildGlaciers,
	buildLithology,
	fetchOsmCover,
} from "./lib/layers";
import { buildNames, type OsmPeak } from "./lib/names";
import { encodePng } from "./lib/png";

const arg = (k: string, d?: string) => {
	const i = process.argv.indexOf(`--${k}`);
	return i >= 0 ? process.argv[i + 1] : d;
};
const id = arg("id", "thunersee") ?? "thunersee";
const bbox = (arg("bbox", "7.35,46.45,8.25,46.95") ?? "")
	.split(",")
	.map(Number) as BBox;
const name = arg("name", id) ?? id;
const cellM = Number(arg("cell", "25"));
const REPO = resolve(import.meta.dirname, "../..");
const OUT = join(REPO, "public/terroir");

function loadOsmPeaks(): OsmPeak[] {
	const files = [join(REPO, "public/demo/manifest.json")];
	const pdir = join(REPO, "public/photos");
	if (existsSync(pdir))
		for (const f of readdirSync(pdir))
			if (/^region-\d+\.json$/.test(f)) files.push(join(pdir, f));
	const seen = new Map<string, OsmPeak>();
	for (const f of files) {
		if (!existsSync(f)) continue;
		const j = JSON.parse(readFileSync(f, "utf8"));
		const peaks = (j.region?.peaks ?? j.peaks ?? []) as OsmPeak[];
		for (const p of peaks) {
			if (
				!(
					p.lon >= bbox[0] &&
					p.lon <= bbox[2] &&
					p.lat >= bbox[1] &&
					p.lat <= bbox[3]
				)
			)
				continue;
			const k = `${p.name}|${p.lat.toFixed(3)}|${p.lon.toFixed(3)}`;
			const o = seen.get(k);
			if (!o || (o.prominence == null && p.prominence != null))
				seen.set(k, {
					name: p.name,
					lat: p.lat,
					lon: p.lon,
					ele: p.ele ?? null,
					prominence: p.prominence ?? null,
				});
		}
	}
	return [...seen.values()];
}

async function main() {
	console.log(`terroir pack ${id} bbox=${bbox} cache=${CACHE}`);
	mkdirSync(join(OUT, id), { recursive: true });
	const dem = new Dem(CACHE);
	console.log("DEM tiles");
	await dem.prefetch(bbox);

	console.log("swissNAMES3D");
	await cachedZip(
		"sn3d",
		"https://data.geo.admin.ch/ch.swisstopo.swissnames3d/swissnames3d_2026/swissnames3d_2026_2056.csv.zip",
	);
	await cachedZip(
		"sn3d-shp",
		"https://data.geo.admin.ch/ch.swisstopo.swissnames3d/swissnames3d_2026/swissnames3d_2026_2056.shp.zip",
		["swissNAMES3D_LIN.*", "swissNAMES3D_PLY.*"],
	);
	const osmPeaks = loadOsmPeaks();
	console.log(`  OSM peaks in bbox (bundled region JSON): ${osmPeaks.length}`);
	const { names, stats } = await buildNames({
		bbox,
		cacheDir: CACHE,
		dem,
		osmPeaks,
	});
	console.log("  names", names.length, JSON.stringify(stats));

	console.log("glaciers (GLAMOS SGI)");
	const { glaciers, ice } = await buildGlaciers(bbox, CACHE, dem);

	console.log("lithology (GK500)");
	const lithology = await buildLithology(bbox, CACHE);

	console.log("land cover");
	const W =
		Math.round(
			((bbox[2] - bbox[0]) *
				M_PER_DEG_LAT *
				Math.cos((((bbox[1] + bbox[3]) / 2) * Math.PI) / 180)) /
				cellM /
				2,
		) * 2;
	const H = Math.round(((bbox[3] - bbox[1]) * 110574) / cellM / 2) * 2;
	const osm = await fetchOsmCover(bbox, CACHE);
	console.log(`  OSM cover features: ${osm.length}`);
	const cover = await buildCover({
		bbox,
		cacheDir: CACHE,
		dem,
		W,
		H,
		ice,
		osm,
	});
	writeFileSync(join(OUT, id, "cover.png"), encodePng(W, H, 1, cover.png));

	const sources: TerroirSource[] = [
		{
			id: "swissnames3d",
			label: "swissNAMES3D 2026",
			licence: "swisstopo OGD (free use, attribution)",
			url: "https://www.swisstopo.admin.ch/en/landscape-model-swissnames3d",
			credit: "© swisstopo",
		},
		{
			id: "swisstopo-vec25",
			label: "VECTOR25 primary surfaces (WMS render, classified)",
			licence: "swisstopo OGD (free use, attribution)",
			url: "https://www.swisstopo.admin.ch/en/landscape-model-vector25",
			credit: "© swisstopo",
		},
		{
			id: "swisstopo-gk500",
			label: "GK500 lithology (aggregated main groups)",
			licence: "swisstopo OGD (free use, attribution)",
			url: "https://www.swisstopo.admin.ch/en/geological-map-of-switzerland-1-500-000",
			credit: "© swisstopo",
		},
		{
			id: "glamos-sgi",
			label: "Swiss Glacier Inventory 1850 / 1931 / 1973 / 2016 / 2023",
			licence: "CC BY 4.0",
			url: "https://doi.glamos.ch/",
			credit: "GLAMOS Swiss Glacier Inventory (CC BY 4.0)",
		},
		{
			id: "osm",
			label:
				"OpenStreetMap: scree, vineyard, orchard and leaf-type polygons (cover raster refinement); peak names/prominence from the bundled region data",
			licence: "ODbL 1.0",
			url: "https://www.openstreetmap.org/copyright",
			credit: "© OpenStreetMap contributors (ODbL)",
		},
		{
			id: "terrarium",
			label:
				"Terrarium elevation tiles (z12) for name, glacier-vertex and cover elevations",
			licence:
				"Mapzen / open DEM mix (SRTM, swissALTI3D-derived where available; attribution required)",
			url: "https://registry.opendata.aws/terrain-tiles/",
			credit:
				"Terrain tiles: Mapzen, AWS Open Data (see registry.opendata.aws/terrain-tiles)",
		},
	];

	const pack: TerroirPack = {
		v: 1,
		id,
		name,
		bbox,
		created: new Date().toISOString(),
		sources,
		names,
		glaciers,
		cover: {
			url: "cover.png",
			width: W,
			height: H,
			bbox,
			cellM,
			histogram: cover.histogram,
		},
		lithology,
	};
	writeFileSync(join(OUT, id, "pack.json"), JSON.stringify(pack));

	const idxPath = join(OUT, "index.json");
	const idx: TerroirPackIndex = existsSync(idxPath)
		? JSON.parse(readFileSync(idxPath, "utf8"))
		: { v: 1, packs: [] };
	idx.packs = idx.packs
		.filter((p) => p.id !== id)
		.concat([{ id, name, bbox, path: id }]);
	writeFileSync(idxPath, `${JSON.stringify(idx, null, "\t")}\n`);
	console.log("done", join(OUT, id));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
