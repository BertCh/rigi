#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pre-extract OSM peaks (natural~peak|volcano) and viewpoints (tourism=viewpoint) for a bbox into a
// compact static file that src/lib/osm/extract.ts serves instead of the public Overpass API
// (roadmap N2; reports/licences.md). Data © OpenStreetMap contributors, ODbL 1.0: the output is a
// Derivative Database, so publishing it means offering it under ODbL with attribution.
//
// Usage:
//   node tools/osm/extract-peaks.mjs                        # default: Switzerland + 60 km border
//   node tools/osm/extract-peaks.mjs --bbox 46.9,8.3,47.2,8.7 --name rigi-test
//   node tools/osm/extract-peaks.mjs --dry-run              # print the tile plan only
// Options: --bbox s,w,n,e  --name <id> (file peaks-<id>.json)  --out <dir> (default public/osm)
//          --tile <deg> (default 1; one Overpass query per tile, run sequentially)
//          --pause <ms> between queries (default 5000)  --no-viewpoints  --dry-run
// Env: OVERPASS_URL (one endpoint; default overpass-api.de then two mirrors).
//
// Size: CH + border is ~3.2° × 6.2°, about 20 tiles; expect a few MB of JSON (measure with a
// small bbox first; disk is tight). The file keeps only the tags the app reads.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const FORMAT = "rigi-osm-extract/1";
// keep in sync with EXTRACT_TAGS in src/lib/osm/extract.ts
const TAGS = [
	"natural",
	"tourism",
	"name",
	"name:de",
	"name:en",
	"ele",
	"prominence",
	"wikidata",
];
// CH (45.82–47.81 N, 5.96–10.49 E) + the upload region's 60 km peak radius + snap margin
const DEFAULT_BBOX = [45.2, 5.1, 48.4, 11.3];
const ENDPOINTS = process.env.OVERPASS_URL
	? [process.env.OVERPASS_URL]
	: [
			"https://overpass-api.de/api/interpreter",
			"https://overpass.private.coffee/api/interpreter",
			"https://overpass.kumi.systems/api/interpreter",
		];

function args(argv) {
	const o = {
		bbox: DEFAULT_BBOX,
		name: "ch",
		out: path.join(ROOT, "public/osm"),
		tile: 1,
		pause: 5000,
		viewpoints: true,
		dry: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === "--bbox") o.bbox = next().split(",").map(Number);
		else if (a === "--name") o.name = next();
		else if (a === "--out") o.out = path.resolve(next());
		else if (a === "--tile") o.tile = Number(next());
		else if (a === "--pause") o.pause = Number(next());
		else if (a === "--no-viewpoints") o.viewpoints = false;
		else if (a === "--dry-run") o.dry = true;
		else throw new Error(`unknown option ${a}`);
	}
	if (
		o.bbox.length !== 4 ||
		o.bbox.some((v) => !Number.isFinite(v)) ||
		o.bbox[0] >= o.bbox[2] ||
		o.bbox[1] >= o.bbox[3]
	)
		throw new Error("--bbox must be s,w,n,e");
	if (!/^[a-z0-9-]+$/.test(o.name))
		throw new Error("--name must be [a-z0-9-]+");
	return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tiles([s, w, n, e], step) {
	const out = [];
	for (let a = s; a < n - 1e-9; a += step)
		for (let b = w; b < e - 1e-9; b += step)
			out.push(
				[a, b, Math.min(n, a + step), Math.min(e, b + step)].map((v) =>
					Number(v.toFixed(5)),
				),
			);
	return out;
}

async function overpass(query) {
	let last = "";
	for (const [i, url] of ENDPOINTS.entries()) {
		if (i) await sleep(3000 * i);
		try {
			const res = await fetch(url, {
				method: "POST",
				body: new URLSearchParams({ data: query }),
				headers: {
					"User-Agent": "Rigi osm pre-extract (tools/osm/extract-peaks.mjs)",
				},
				signal: AbortSignal.timeout(300_000),
			});
			if (res.ok) {
				const j = await res.json();
				if (Array.isArray(j?.elements)) return j;
				last = `${url}: malformed`;
			} else last = `${url}: HTTP ${res.status}`;
		} catch (err) {
			last = `${url}: ${err.message}`;
		}
	}
	throw new Error(`Overpass failed (${last})`);
}

const keep = (tags = {}) => {
	const t = {};
	for (const k of TAGS) if (tags[k] !== undefined) t[k] = tags[k];
	return t;
};

async function main() {
	const o = args(process.argv.slice(2));
	const plan = tiles(o.bbox, o.tile);
	console.log(
		`bbox ${o.bbox.join(",")} → ${plan.length} tile queries (${o.tile}°)${o.viewpoints ? " incl. viewpoints" : ""}`,
	);
	if (o.dry) return;
	const peaks = new Map();
	const views = new Map();
	let osmBase;
	for (const [i, t] of plan.entries()) {
		if (i) await sleep(o.pause);
		const bb = t.join(",");
		// tile edges are shared: a node on an edge comes back twice and is deduped by id
		const q = `[out:json][timeout:240];(node["natural"~"peak|volcano"](${bb});${o.viewpoints ? `node["tourism"="viewpoint"](${bb});` : ""});out;`;
		const j = await overpass(q);
		osmBase = j.osm3s?.timestamp_osm_base ?? osmBase;
		for (const el of j.elements) {
			if (el.type !== "node") continue;
			const rec = [el.id, el.lat, el.lon, keep(el.tags)];
			if (/peak|volcano/.test(el.tags?.natural ?? "")) peaks.set(el.id, rec);
			if (el.tags?.tourism === "viewpoint") views.set(el.id, rec);
		}
		console.log(
			`  ${i + 1}/${plan.length} ${bb}: ${j.elements.length} elements (peaks ${peaks.size}, viewpoints ${views.size})`,
		);
	}
	const byId = (a, b) => a[0] - b[0];
	const doc = {
		format: FORMAT,
		bbox: o.bbox,
		generated: new Date().toISOString(),
		osmBase,
		licence:
			"© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)",
		peaks: [...peaks.values()].sort(byId),
		...(o.viewpoints ? { viewpoints: [...views.values()].sort(byId) } : {}),
	};
	await mkdir(o.out, { recursive: true });
	const file = `peaks-${o.name}.json`;
	const text = JSON.stringify(doc);
	await writeFile(path.join(o.out, file), text);
	const manifestPath = path.join(o.out, "extracts.json");
	let manifest = { extracts: [] };
	try {
		manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	} catch {}
	manifest.note =
		"OSM pre-extracts for src/lib/osm/extract.ts (tools/osm/extract-peaks.mjs). © OpenStreetMap contributors, ODbL 1.0.";
	manifest.extracts = (manifest.extracts ?? []).filter((e) => e.file !== file);
	manifest.extracts.push({
		file,
		bbox: o.bbox,
		peaks: doc.peaks.length,
		...(o.viewpoints ? { viewpoints: doc.viewpoints.length } : {}),
		bytes: Buffer.byteLength(text),
		generated: doc.generated,
	});
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	const { size } = await stat(path.join(o.out, file));
	console.log(
		`wrote ${path.relative(ROOT, path.join(o.out, file))}: ${doc.peaks.length} peaks, ${doc.viewpoints?.length ?? 0} viewpoints, ${(size / 1024).toFixed(0)} KiB; osm_base ${osmBase}`,
	);
}

main().catch((e) => {
	console.error(e.message ?? e);
	process.exit(1);
});
