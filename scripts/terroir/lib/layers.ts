// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Glaciers (GLAMOS SGI), lithology (swisstopo GK500) and land cover (swisstopo VECTOR25 + OSM + DEM).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	BBox,
	GlacierExtent,
	LithologyUnit,
	LonLat,
} from "../../../src/lib/terroir/types";
import type { Dem } from "./dem";
import { cached, cachedZip, getBuf } from "./fetch";
import { lv95ToWgs84, simplify, wgs84ToLv95 } from "./geo";
import { decodePng } from "./png";
import { clipRing, fillRings, type Grid, joinWays } from "./raster";
import { groupRings, readDbf, readShp } from "./shp";

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

export const lvBox = (bbox: BBox): [number, number, number, number] => {
	const c = [
		wgs84ToLv95(bbox[1], bbox[0]),
		wgs84ToLv95(bbox[1], bbox[2]),
		wgs84ToLv95(bbox[3], bbox[0]),
		wgs84ToLv95(bbox[3], bbox[2]),
	];
	return [
		Math.min(...c.map((p) => p[0])) - 2000,
		Math.min(...c.map((p) => p[1])) - 2000,
		Math.max(...c.map((p) => p[0])) + 2000,
		Math.max(...c.map((p) => p[1])) + 2000,
	];
};

// ---------------------------------------------------------------------------------------------
// Glaciers
const GLAMOS = [
	{
		year: 1850,
		zip: "inventory_sgi1850_r1992",
		file: "SGI_1850",
		lv03: false,
		tol: 20,
		label: "GLAMOS SGI 1850 (reconstructed Little Ice Age maximum)",
	},
	{
		year: 1931,
		zip: "inventory_sgi1931_r2022",
		file: "SGI_1931",
		lv03: true,
		tol: 20,
		label: "GLAMOS SGI 1931",
	},
	{
		year: 1973,
		zip: "inventory_sgi1973_r1976",
		file: "SGI_1973",
		lv03: false,
		tol: 15,
		label: "GLAMOS SGI 1973",
	},
	{
		year: 2016,
		zip: "inventory_sgi2016_r2020",
		file: "SGI_2016_glaciers",
		lv03: false,
		tol: 15,
		label: "GLAMOS SGI 2016 (images 2013-2018)",
	},
	{
		year: 2023,
		zip: "inventory_sgi2023_r2026",
		file: "SGI_2023_glaciers",
		lv03: false,
		tol: 15,
		label: "GLAMOS SGI 2023",
	},
];

export async function buildGlaciers(
	bbox: BBox,
	_cacheDir: string,
	dem: Dem,
): Promise<{ glaciers: GlacierExtent[]; ice: [number, number][][][] }> {
	const lv = lvBox(bbox);
	const dirs: Record<string, string> = {};
	for (const g of GLAMOS)
		dirs[g.file] = join(
			await cachedZip(
				`glamos/${g.zip}`,
				`https://doi.glamos.ch/data/inventory/${g.zip}.zip`,
			),
			g.file,
		);
	// names by SGI id from the recent inventories
	const nameById = new Map<string, string>();
	for (const g of GLAMOS.filter((x) => x.year >= 2016)) {
		for (const r of readDbf(`${dirs[g.file]}.dbf`))
			if (r.name && r["sgi-id"])
				nameById.set(String(r["sgi-id"]), String(r.name));
	}
	const out: GlacierExtent[] = [];
	const ice: [number, number][][][] = [];
	for (const g of GLAMOS) {
		const dbf = readDbf(`${dirs[g.file]}.dbf`);
		const off = g.lv03 ? 1 : 0;
		const lvq: [number, number, number, number] = g.lv03
			? [lv[0] - 2e6, lv[1] - 1e6, lv[2] - 2e6, lv[3] - 1e6]
			: lv;
		const shp = readShp(`${dirs[g.file]}.shp`, lvq);
		const polygons: LonLat[][][] = [],
			heights: number[][][] = [],
			names: (string | null)[] = [];
		const rawPolys: [number, number][][][] = [];
		for (let i = 0; i < shp.length; i++) {
			const s = shp[i];
			if (!s) continue;
			const id = String(dbf[i].SGI ?? dbf[i]["sgi-id"] ?? "");
			for (const poly of groupRings(s.parts)) {
				const rings: LonLat[][] = [];
				for (const ring of poly) {
					let pts = ring.map(
						([x, y]) => [x + off * 2e6, y + off * 1e6] as [number, number],
					);
					pts = simplify(pts, g.tol, true);
					let ll = pts.map(([x, y]) => lv95ToWgs84(x, y) as [number, number]);
					ll = clipRing(ll, bbox);
					if (ll.length >= 4)
						rings.push(ll.map(([x, y]) => [r5(x), r5(y)] as LonLat));
					else if (ring === poly[0]) break; // outer ring clipped away: drop the polygon
				}
				if (!rings.length) continue;
				polygons.push(rings);
				heights.push(
					rings.map((rg) =>
						rg.map(([x, y]) => Math.round(dem.sample(y, x) ?? 0)),
					),
				);
				names.push(nameById.get(id) ?? null);
				rawPolys.push(rings);
			}
		}
		if (g.year >= 2016) ice.push(...rawPolys);
		out.push({ year: g.year, source: g.label, polygons, heights, names });
		console.log(`  glaciers ${g.year}: ${polygons.length} polygons`);
	}
	return { glaciers: out, ice };
}

// ---------------------------------------------------------------------------------------------
// Lithology (GK500 aggregated lithology, LV03)
const LITH: [RegExp, LithologyUnit["cls"] | null][] = [
	[/^(Gew|Gletscher)/, null],
	[/Dolomit- und Kalkmarmore|Kalksteine|Dolomite/, "limestone"],
	[/Mergelschiefer|Kalkphyllite/, "marl-shale"],
	[/Mergel|Tongesteine|Tone, Rauw|Radiolarit/, "marl-shale"],
	[/Sandsteine|Konglomerate/, "sandstone-conglomerate"],
	[
		/Gneise|Glimmerschiefer|Granite|Amphibolite|Porphyr|Quarzit|Quarzphyllit/,
		"crystalline",
	],
	[/Basische|Ultrabasische|Vulkanit/, "ophiolite"],
	[/Tone, Silte|Sande, Kiese|Bl.cke/, "quaternary"],
];

export async function buildLithology(
	bbox: BBox,
	_cacheDir: string,
): Promise<LithologyUnit[] | null> {
	const dir = await cachedZip(
		"gk500",
		"https://data.geo.admin.ch/ch.swisstopo.geologie-geotechnik-gk500-lithologie_hauptgruppen/geologie-geotechnik-gk500-lithologie_hauptgruppen/geologie-geotechnik-gk500-lithologie_hauptgruppen_2056.shp.zip",
		["Lithologie_Aggregiert.*"],
	);
	const base = join(dir, "Lithologie_Aggregiert");
	const dbf = readDbf(`${base}.dbf`, "latin1");
	const lv = lvBox(bbox);
	const lq: [number, number, number, number] = [
		lv[0] - 2e6,
		lv[1] - 1e6,
		lv[2] - 2e6,
		lv[3] - 1e6,
	];
	const shp = readShp(`${base}.shp`, lq);
	const units = new Map<string, LithologyUnit>();
	for (let i = 0; i < shp.length; i++) {
		const s = shp[i];
		if (!s) continue;
		const label = String(dbf[i].LITHO_DE ?? "");
		const cls = LITH.find(([re]) => re.test(label))?.[1];
		if (cls === null) continue;
		const key = label;
		let u = units.get(key);
		if (!u) {
			u = { cls: cls ?? "other", label, polygons: [] };
			units.set(key, u);
		}
		for (const poly of groupRings(s.parts)) {
			const rings: LonLat[][] = [];
			for (const ring of poly) {
				const pts = simplify(
					ring.map(([x, y]) => [x + 2e6, y + 1e6] as [number, number]),
					120,
					true,
				);
				let ll = pts.map(([x, y]) => lv95ToWgs84(x, y) as [number, number]);
				ll = clipRing(ll, bbox);
				if (ll.length >= 4)
					rings.push(
						ll.map(
							([x, y]) =>
								[
									Math.round(x * 1e4) / 1e4,
									Math.round(y * 1e4) / 1e4,
								] as LonLat,
						),
					);
			}
			if (rings.length) u.polygons.push(rings);
		}
	}
	const out = [...units.values()].filter((u) => u.polygons.length);
	return out.length ? out : null;
}

// ---------------------------------------------------------------------------------------------
// Land cover
const PALETTE: { rgb: [number, number, number]; cls: number }[] = [
	{ rgb: [0xff, 0xf7, 0xeb], cls: 9 }, // open land
	{ rgb: [0xd0, 0xff, 0xd0], cls: 5 }, // forest
	{ rgb: [0xd2, 0xd2, 0xd2], cls: 3 }, // rock / debris
	{ rgb: [0xf0, 0xff, 0xff], cls: 1 }, // ice
	{ rgb: [0xd2, 0xff, 0xff], cls: 1 }, // ice (variant)
	{ rgb: [0xff, 0xbe, 0xbe], cls: 13 }, // built
	{ rgb: [0xbb, 0xfc, 0xff], cls: 12 }, // water
	{ rgb: [0x80, 0xb4, 0x00], cls: 7 }, // shrub forest / dwarf pine
];

export type OsmCover = {
	kind: "scree" | "vineyard" | "orchard" | "broadleaf" | "conifer";
	rings: [number, number][][];
}[];

export async function fetchOsmCover(
	bbox: BBox,
	cacheDir: string,
): Promise<OsmCover> {
	const f = join(cacheDir, "osm-cover.json");
	type OsmEl = {
		type?: string;
		tags?: Record<string, string>;
		geometry?: { lat: number; lon: number }[];
		members?: {
			type?: string;
			role?: string;
			geometry?: { lat: number; lon: number }[];
		}[];
	};
	let json: { elements: OsmEl[] };
	if (existsSync(f)) json = JSON.parse(readFileSync(f, "utf8"));
	else {
		const b = `(${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]})`;
		const q = `[out:json][timeout:180];(nwr["natural"~"^(scree|shingle)$"]${b};nwr["landuse"~"^(vineyard|orchard)$"]${b};nwr["leaf_type"]["natural"="wood"]${b};nwr["leaf_type"]["landuse"="forest"]${b};);out geom;`;
		console.log("  overpass query");
		const buf = await getBuf("https://overpass-api.de/api/interpreter", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: `data=${encodeURIComponent(q)}`,
		});
		writeFileSync(f, buf);
		json = JSON.parse(buf.toString("utf8"));
	}
	const out: OsmCover = [];
	for (const el of json.elements) {
		const t = el.tags ?? {};
		let kind: OsmCover[number]["kind"] | null = null;
		if (t.natural === "scree" || t.natural === "shingle") kind = "scree";
		else if (t.landuse === "vineyard") kind = "vineyard";
		else if (t.landuse === "orchard") kind = "orchard";
		else if (t.leaf_type)
			kind =
				t.leaf_type === "needleleaved"
					? "conifer"
					: t.leaf_type === "broadleaved" || t.leaf_type === "mixed"
						? "broadleaf"
						: null;
		if (!kind) continue;
		let rings: [number, number][][] = [];
		const ll = (g: { lat: number; lon: number }[]) =>
			g.map((p) => [p.lon, p.lat] as [number, number]);
		if (el.type === "way" && el.geometry) {
			const g = ll(el.geometry);
			if (
				g.length >= 4 &&
				g[0][0] === g[g.length - 1][0] &&
				g[0][1] === g[g.length - 1][1]
			)
				rings = [g];
		} else if (el.type === "relation") {
			rings = joinWays(
				(el.members ?? [])
					.filter(
						(m) =>
							m.type === "way" &&
							m.geometry &&
							(m.role === "outer" || m.role === "inner"),
					)
					.map((m) => ll(m.geometry ?? [])),
			);
		}
		if (rings.length) out.push({ kind, rings });
	}
	return out;
}

async function wmsBase(
	bbox: BBox,
	g: Grid,
	_cacheDir: string,
): Promise<Uint8Array> {
	const cls = new Uint8Array(g.W * g.H);
	const NX = 2,
		NY = 2,
		tw = g.W / NX,
		th = g.H / NY;
	for (let ty = 0; ty < NY; ty++)
		for (let tx = 0; tx < NX; tx++) {
			const w = bbox[0] + ((bbox[2] - bbox[0]) * tx) / NX,
				e = bbox[0] + ((bbox[2] - bbox[0]) * (tx + 1)) / NX;
			const n = bbox[3] - ((bbox[3] - bbox[1]) * ty) / NY,
				s = bbox[3] - ((bbox[3] - bbox[1]) * (ty + 1)) / NY;
			const url = `https://wms.geo.admin.ch/?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ch.swisstopo.vec25-primaerflaechen&STYLES=&CRS=EPSG:4326&BBOX=${s},${w},${n},${e}&WIDTH=${tw}&HEIGHT=${th}&FORMAT=image/png&TRANSPARENT=false`;
			const f = await cached(
				`vec25/${g.W}x${g.H}_${tx}_${ty}_${bbox.join("_")}.png`,
				url,
			);
			const img = decodePng(readFileSync(f));
			for (let y = 0; y < th; y++)
				for (let x = 0; x < tw; x++) {
					const i = (y * tw + x) * img.channels;
					const r = img.data[i],
						gg = img.data[i + 1],
						b = img.data[i + 2];
					let c = 0;
					if (!(r >= 253 && gg >= 253 && b >= 253)) {
						let bd = Infinity;
						for (const p of PALETTE) {
							const d =
								(r - p.rgb[0]) ** 2 +
								(gg - p.rgb[1]) ** 2 +
								(b - p.rgb[2]) ** 2;
							if (d < bd) {
								bd = d;
								c = p.cls;
							}
						}
					}
					cls[(ty * th + y) * g.W + tx * tw + x] = c;
				}
		}
	return cls;
}

export async function buildCover(opts: {
	bbox: BBox;
	cacheDir: string;
	dem: Dem;
	W: number;
	H: number;
	ice: [number, number][][][];
	osm: OsmCover;
}): Promise<{
	png: Uint8Array;
	histogram: Record<string, number>;
	notes: Record<string, number>;
}> {
	const { bbox, dem, W, H } = opts;
	const g: Grid = { w: bbox[0], s: bbox[1], e: bbox[2], n: bbox[3], W, H };
	const cls = await wmsBase(bbox, g, opts.cacheDir);
	// separate masks (never mixed into one geometry store): OSM overlays + SGI ice
	const mask = (polys: [number, number][][][] | OsmCover, kinds?: string) => {
		const m = new Uint8Array(W * H);
		for (const p of polys) {
			let rings: [number, number][][];
			if (Array.isArray(p)) rings = p;
			else {
				if (kinds && p.kind !== kinds) continue;
				rings = p.rings;
			}
			fillRings(g, rings, (i) => (m[i] = 1));
		}
		return m;
	};
	const iceM = mask(opts.ice);
	const scree = mask(opts.osm, "scree"),
		vine = mask(opts.osm, "vineyard"),
		orch = mask(opts.osm, "orchard");
	const broad = mask(opts.osm, "broadleaf"),
		conif = mask(opts.osm, "conifer");
	const notes: Record<string, number> = {};
	const bump = (k: string) => (notes[k] = (notes[k] ?? 0) + 1);
	for (let y = 0; y < H; y++) {
		const lat = bbox[3] - ((y + 0.5) / H) * (bbox[3] - bbox[1]);
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			let c = cls[i];
			if (c === 0 || c === 12 || c === 13) continue;
			const needEle = c === 9 || c === 5 || c === 1 || c === 3;
			const ele = needEle
				? (dem.sample(lat, bbox[0] + ((x + 0.5) / W) * (bbox[2] - bbox[0])) ??
					0)
				: 0;
			if (c === 5) {
				c = conif[i] ? 5 : broad[i] ? 6 : ele < 750 ? 6 : 5;
				if (c === 6) bump("forest-broadleaf");
			} else if (c === 9) {
				if (vine[i]) c = 10;
				else if (orch[i]) c = 11;
				else if (ele >= 2500) c = 4;
				else if (ele >= 1400) c = 8;
			} else if (c === 3) {
				if (scree[i]) c = 4;
			} else if (c === 1) {
				c = iceM[i] ? 1 : ele >= 2400 ? 2 : 1;
			}
			cls[i] = c;
		}
	}
	const histogram: Record<string, number> = {};
	for (const v of cls) histogram[v] = (histogram[v] ?? 0) + 1;
	return { png: cls, histogram, notes };
}
