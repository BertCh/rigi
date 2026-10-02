#!/usr/bin/env node

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
// WAG W2.3 gate: is the GPU Terrarium decode (src/lib/gpu/ingest) bit-identical to the CPU path?
// Runs src/lib/gpu/ingest/selftest.ts in headless Chromium (WebGPU) over every Terrarium tile in the
// local tile caches, and per tile compares
//  a. the RGBA bytes copyExternalImageToTexture puts in an rgba8unorm texture with the canvas
//     getImageData bytes of the same ImageBitmap (colour conversion, premultiply): decides BIT;
//  b. the GPU heights with bitmapHeights (dem/image.ts), bit for bit, and with decodeTerrarium of the
//     GPU's own texel bytes;
//  c. the r32float copy round trip and the one-shot decodeTerrariumTileGpu;
//  d. the app's worker-pool decode against the page decode, and the terrainGpuDecode path
//     (terrarium-tile.ts: load-time stats, the layer writer, the lazy CPU view) against the CPU path.
//
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/terrarium-ingest-check.mjs \
//     [--cache DIR]... [--limit N] [--fetch]
//
// Tiles: every .png / .webp under each --cache DIR (default .cache/dem-mapterhorn and
// .cache/terrarium of this tree), served to the page through a Playwright route. With no local
// tiles (or --fetch) a fixed list of Mapterhorn tiles around the Niederhorn is fetched instead.
// Env: APP_URL (default http://localhost:3100), a Vite dev server on this tree. Writes
// out/gpu/ingest/terrarium-ingest.json; exit 1 on any difference or error.
import { APP_URL } from "../lib/harness.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = APP_URL;
const OUT = path.join(ROOT, "out/gpu/ingest");
const ROUTE = "/__ingest-tiles/";
const CHUNK = 40;

const argv = process.argv.slice(2);
const caches = [];
let limit = Infinity;
let forceFetch = false;
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--cache") caches.push(path.resolve(argv[++i]));
	else if (argv[i] === "--limit") limit = Number(argv[++i]);
	else if (argv[i] === "--fetch") forceFetch = true;
	else throw new Error(`unknown argument ${argv[i]}`);
}
if (!caches.length)
	caches.push(
		path.join(ROOT, ".cache/dem-mapterhorn"),
		path.join(ROOT, ".cache/terrarium"),
	);

function walk(dir, out = []) {
	if (!fs.existsSync(dir)) return out;
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (/\.(png|webp)$/i.test(e.name)) out.push(p);
	}
	return out;
}

/** Mapterhorn z12–z14 tiles covering the Niederhorn (46.7107 N, 7.7713 E), 3 × 3 at each zoom. */
function niederhornTiles() {
	const lat = (46.7107 * Math.PI) / 180;
	const lon = 7.7713;
	const urls = [];
	for (const z of [12, 13, 14]) {
		const n = 2 ** z;
		const x = Math.floor(((lon + 180) / 360) * n);
		const y = Math.floor(
			((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n,
		);
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++)
				urls.push(`https://tiles.mapterhorn.com/${z}/${x + dx}/${y + dy}.webp`);
	}
	return urls;
}

const files = forceFetch ? [] : caches.flatMap((d) => walk(d)).sort();
const local = new Map();
let urls;
if (files.length) {
	urls = files.slice(0, limit).map((f, i) => {
		const u = `${ROUTE}${i}${path.extname(f).toLowerCase()}`;
		local.set(u, f);
		return u;
	});
} else urls = niederhornTiles().slice(0, limit);
console.log(
	`${urls.length} tiles (${files.length ? `local: ${caches.join(", ")}` : "fetched: Mapterhorn around the Niederhorn"})`,
);

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const tiles = [];
let device = null;
try {
	const page = await browser.newPage();
	page.on("console", (m) => {
		if (m.type() === "error" || m.type() === "warning")
			console.error(`[page ${m.type()}]`, m.text().slice(0, 300));
	});
	await page.route(`**${ROUTE}*`, (route) => {
		const f = local.get(new URL(route.request().url()).pathname);
		if (!f) return route.fulfill({ status: 404 });
		return route.fulfill({
			status: 200,
			contentType: f.endsWith(".webp") ? "image/webp" : "image/png",
			body: fs.readFileSync(f),
		});
	});
	// a static file: no app, no router; Vite still serves /src modules to it (as core-selftest)
	await page.goto(`${BASE}/favicon.svg`);
	for (let i = 0; i < urls.length; i += CHUNK) {
		const r = await page.evaluate(
			async (chunk) => {
				const m = await import("/src/lib/gpu/ingest/selftest.ts");
				return m.terrariumIngestSelftest(chunk);
			},
			urls.slice(i, i + CHUNK),
		);
		if (!r.device) throw new Error("no WebGPU compute device in the page");
		device = r.device;
		tiles.push(...r.tiles);
		process.stdout.write(`\r${tiles.length}/${urls.length}`);
	}
	process.stdout.write("\n");
} finally {
	await browser.close();
}

for (const t of tiles) if (local.has(t.url)) t.file = local.get(t.url);
const sum = (k) => tiles.reduce((s, t) => s + Math.max(0, t[k]), 0);
const tilesWith = (k) => tiles.filter((t) => t[k] > 0).length;
const errors = tiles.filter((t) => t.error);
const pixels = tiles.reduce((s, t) => s + t.width * t.height, 0);
const bySize = {};
for (const t of tiles) {
	const k = `${t.width}x${t.height}${path.extname(t.file ?? t.url)}`;
	bySize[k] = (bySize[k] ?? 0) + 1;
}
const summary = {
	device,
	tiles: tiles.length,
	bySize,
	pixels,
	errors: errors.length,
	rgba: {
		bytesDiffering: sum("rgbaDiff"),
		tilesDiffering: tilesWith("rgbaDiff"),
	},
	alphaNot255: { pixels: sum("alphaNot255"), tiles: tilesWith("alphaNot255") },
	heights: {
		vsBitmapHeights: {
			differing: sum("heightDiff"),
			tiles: tilesWith("heightDiff"),
		},
		vsDecodeOfGpuBytes: {
			differing: sum("kernelDiff"),
			tiles: tilesWith("kernelDiff"),
		},
		r32floatRoundTrip: {
			differing: sum("textureDiff"),
			tiles: tilesWith("textureDiff"),
		},
		decodeTerrariumTileGpu: {
			differing: sum("apiDiff"),
			tiles: tilesWith("apiDiff"),
		},
		cpuRepeat: {
			differing: sum("cpuRepeatDiff"),
			tiles: tilesWith("cpuRepeatDiff"),
		},
		workerVsPage: {
			differing: sum("workerDiff"),
			tiles: tilesWith("workerDiff"),
		},
	},
	terrainGpuDecode: {
		statsFieldsDiffering: sum("tileStatsDiff"),
		invalidCountDiffering: sum("tileInvalidDiff"),
		layerTexelsDiffering: sum("tileLayerDiff"),
		lazyHeightsDiffering: sum("tileLazyDiff"),
		tilesDiffering: tiles.filter(
			(t) =>
				t.tileStatsDiff ||
				t.tileInvalidDiff ||
				t.tileLayerDiff ||
				t.tileLazyDiff,
		).length,
	},
	validateTile: {
		tilesRepaired: tiles.filter((t) => t.validate.repaired > 0).length,
		tilesFilled: tiles.filter((t) => t.validate.filled > 0).length,
		pixelsRepaired: tiles.reduce((s, t) => s + t.validate.repaired, 0),
		pixelsFilled: tiles.reduce((s, t) => s + t.validate.filled, 0),
	},
};
const bad = tiles.filter(
	(t) =>
		t.error ||
		t.rgbaDiff ||
		t.heightDiff ||
		t.kernelDiff ||
		t.textureDiff ||
		t.apiDiff ||
		t.workerDiff ||
		t.tileStatsDiff ||
		t.tileInvalidDiff ||
		t.tileLayerDiff ||
		t.tileLazyDiff,
);
console.log(JSON.stringify(summary, null, 1));
for (const t of bad.slice(0, 10))
	console.log(
		`FAIL ${t.file ?? t.url}: rgba ${t.rgbaDiff} h ${t.heightDiff} kernel ${t.kernelDiff} tex ${t.textureDiff} api ${t.apiDiff} worker ${t.workerDiff} tile stats ${t.tileStatsDiff} invalid ${t.tileInvalidDiff} layer ${t.tileLayerDiff} lazy ${t.tileLazyDiff}${t.first ? ` (${t.first})` : ""}${t.error ? ` ${t.error}` : ""}`,
	);
const ok = tiles.length > 0 && bad.length === 0;
console.log(
	ok
		? `PASS: ${tiles.length} tiles, ${pixels} px: RGBA bytes, heights and the terrainGpuDecode layers / stats / lazy CPU heights bit-identical to the canvas + decodeTerrarium path`
		: `FAIL: ${bad.length}/${tiles.length} tiles differ or errored`,
);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
	path.join(OUT, "terrarium-ingest.json"),
	JSON.stringify({ summary, bad, tiles }, null, 1),
);
process.exit(ok ? 0 : 1);
