#!/usr/bin/env node

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { GPU_ARGS } from "../deck-webgpu/gpu-args.mjs";
// Bake the landing's live 3D map (src/components/site/LiveRollMap.tsx) into public/demo/roll-map/,
// so a visitor's browser downloads ~30 MB of compact files instead of ~80 MB of Mapterhorn and WMTS
// tiles, and skips the range-map readbacks and clear-air fits. The data comes from a run of the
// live path itself: src/lib/roll/map/roll-map.ts RollMapEngine on the sample trip with the
// landing's inputs (1024 px photos, the baked people masks, the "muted" basemap, no seed), left to
// settle (every tile's imagery in, every range map and fit done, the exposure gains solved). Then:
//   terrain.bin  every terrain tile's DEM raster, lossless (src/lib/roll/map/roll-seed.ts), gzip
//   imagery.bin  every tile's basemap mosaic as WebP (--quality, default 0.8; lossy, reported)
//   photos.bin   per photo: its coarse range grid and clear-air + exposure texels, gzip
// The layouts are src/lib/roll/map/roll-seed.ts; src/lib/demo/roll-map-seed.ts loads them.
//
// Then, unless --no-verify, it compares a seeded engine (the files just written, as the landing
// loads them) with a fresh live engine: the tile set, every tile's heights, mesh, normals and batch
// grid (hashes), the photo placements, the coarse grids and the clear-air texels, and counts the
// Mapterhorn / WMTS requests of the seeded run (should be 0).
//
// Needs a browser and the dev server; run under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/demo/bake-roll-map.mjs \
//     [--url http://localhost:3100] [--quality 0.8] [--no-verify] [--verify-only]
import { APP_URL } from "../lib/harness.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 ? argv[i + 1] : d;
};
const BASE = arg("url", APP_URL);
const QUALITY = Number(arg("quality", "0.8"));
const OUT = "public/demo/roll-map";
const verifyOnly = argv.includes("--verify-only");
const verify = verifyOnly || !argv.includes("--no-verify");

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });

/**
 * In the page: run the landing's engine (LiveRollMap's options; `seeded` = with the demo seed),
 * wait until it has settled, and leave it on window.__engine.
 */
async function runEngine(page, seeded) {
	await page.goto(`${BASE}/demo/manifest.json`);
	await page.evaluate(async (seeded) => {
		const canvas = document.createElement("canvas");
		canvas.style.cssText = "width:1200px;height:750px;display:block";
		document.body.replaceChildren(canvas);
		const [
			{ loadDemoRoll },
			{ loadDemoPeopleMasks },
			seedMod,
			{ RollMapEngine },
		] = await Promise.all([
			import("/src/lib/demo/index.ts"),
			import("/src/lib/demo/people-masks.ts"),
			import("/src/lib/demo/roll-map-seed.ts"),
			import("/src/lib/roll/map/roll-map.ts"),
		]);
		const roll = await loadDemoRoll({ core: true, smallPhotos: true });
		let ready = false;
		// LiveRollMap's options and settings (OVERVIEW_M, NO_REACH_M); none of them changes the data
		const engine = new RollMapEngine(canvas, roll, {
			overviewM: 3200,
			peopleMasks: loadDemoPeopleMasks,
			...(seeded && { seed: seedMod.demoRollMapSeed }),
			onStatus: (s) => {
				if (s.stage === "ready") ready = true;
			},
		});
		engine.setSettings({ basemap: "muted", gizmos: true, reachM: 1e6 });
		window.__engine = engine;
		await engine.init();
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		while (!ready) await sleep(100);
		// settled: every tile's imagery in, no range work or fit left, the gains solved (their
		// debounce is 700 ms), nothing changing for 3 s
		const e = engine;
		let last = "";
		let stable = 0;
		for (let i = 0; i < 600 && stable < 6; i++) {
			await sleep(500);
			const k = [
				e.clear.version,
				e.imagery.size,
				!!e.imageryAbort,
				e.rangeQueue.length,
				e.rangeWorkers,
				e.clear.pumping,
				e.clear.queue.length,
			].join("|");
			const done =
				e.imagery.size >= e.renderSet.tiles.length &&
				!e.imageryAbort &&
				!e.rangeWorkers;
			stable = k === last && done ? stable + 1 : 0;
			last = k;
		}
		if (stable < 6) throw new Error("roll map never settled");
	}, seeded);
}

/** Bytes from a page global (a Uint8Array) to Node, in base64 chunks. */
async function pull(page, name) {
	const n = await page.evaluate((name) => window[name].length, name);
	const out = Buffer.alloc(n);
	const CHUNK = 8 << 20;
	for (let i = 0; i < n; i += CHUNK) {
		const s = await page.evaluate(
			([name, i, CHUNK]) => {
				const a = window[name].subarray(i, i + CHUNK);
				let x = "";
				for (let k = 0; k < a.length; k += 32768)
					x += String.fromCharCode(...a.subarray(k, k + 32768));
				return btoa(x);
			},
			[name, i, CHUNK],
		);
		Buffer.from(s, "base64").copy(out, i);
	}
	return out;
}

/** The settled engine's terrain / imagery / photo data in the seed layouts (page globals). */
async function extract(page, quality) {
	return page.evaluate(async (quality) => {
		const seed = await import("/src/lib/roll/map/roll-seed.ts");
		const e = window.__engine;
		const rasters = new Map();
		for (const t of e.renderSet.tiles) {
			const d = t.key.z - t.sourceZ;
			rasters.set(t.id, {
				key: t.key,
				source: { z: t.sourceZ, x: t.key.x >> d, y: t.key.y >> d },
				size: t.size,
				heights: t.heights,
			});
		}
		window.__terrain = seed.encodeTerrainSeed(rasters);
		// imagery: WebP per tile, and how far each decoded WebP is from the live mosaic
		const tiles = new Map();
		const err = { px: 0, sumSq: 0, sumAbs: 0, max: 0, over8: 0 };
		const pixels = (img) => {
			const c = new OffscreenCanvas(img.width, img.height);
			const x = c.getContext("2d", { willReadFrequently: true });
			x.drawImage(img, 0, 0);
			return { c, d: x.getImageData(0, 0, img.width, img.height).data };
		};
		for (const [id, bmp] of e.imagery) {
			const a = pixels(bmp);
			const blob = await a.c.convertToBlob({ type: "image/webp", quality });
			tiles.set(id, new Uint8Array(await blob.arrayBuffer()));
			const back = await createImageBitmap(blob);
			const b = pixels(back).d;
			back.close();
			for (let i = 0; i < a.d.length; i += 4) {
				let m = 0;
				for (let ch = 0; ch < 3; ch++) {
					const v = Math.abs(a.d[i + ch] - b[i + ch]);
					err.sumSq += v * v;
					err.sumAbs += v;
					if (v > m) m = v;
				}
				if (m > err.max) err.max = m;
				if (m > 8) err.over8++;
				err.px++;
			}
		}
		window.__imagery = seed.encodeImagerySeed(e.imagerySrc, tiles);
		const photos = new Map();
		for (const p of e.debugPlaced()) {
			const k = e.slot.get(p.id);
			photos.set(p.id, {
				pose: p.pose,
				eye: p.eye,
				coarse: e.atlas.coarse[k],
				clear: e.clear.texels(p.id),
			});
		}
		window.__photos = seed.encodePhotoSeeds(photos);
		const mse = err.sumSq / (err.px * 3);
		return {
			tiles: rasters.size,
			imagery: tiles.size,
			source: e.imagerySrc,
			photos: photos.size,
			imageryError: {
				megapixels: err.px / 1e6,
				meanAbs: err.sumAbs / (err.px * 3),
				psnr: 10 * Math.log10((255 * 255) / mse),
				maxChannel: err.max,
				pctOver8: (100 * err.over8) / err.px,
			},
		};
	}, quality);
}

/** What the comparison looks at, from a settled engine (hashes for the big arrays). */
async function snapshot(page) {
	return page.evaluate(() => {
		const e = window.__engine;
		const fnv = (arr) => {
			if (!arr) return null;
			const b = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
			let h = 0x811c9dc5;
			for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193);
			return (h >>> 0).toString(16);
		};
		const tiles = {};
		for (const t of e.renderSet.tiles)
			tiles[t.id] = {
				seg: t.seg,
				size: t.size,
				sourceZ: t.sourceZ,
				distance: t.distance,
				heights: fnv(t.heights),
				positions: fnv(t.positions),
				normals: fnv(t.normals),
				elev: fnv(t.elev),
				grid: t.grid
					? JSON.stringify(t.grid, (_k, v) =>
							ArrayBuffer.isView(v) ? fnv(v) : v,
						)
					: null,
			};
		const photos = {};
		for (const p of e.debugPlaced()) {
			const k = e.slot.get(p.id);
			const c = e.atlas.coarse[k];
			photos[p.id] = {
				pose: p.pose,
				eye: p.eye,
				coarse: c && { w: c.width, h: c.height, data: Array.from(c.data) },
				clear: Array.from(e.clear.texels(p.id) ?? []),
			};
		}
		const imagery = {};
		for (const [id, b] of e.imagery) imagery[id] = `${b.width}x${b.height}`;
		return {
			tiles,
			photos,
			imagery,
			ranges: e.debugDrape()?.ranges,
			baked: e.debugPlaced().filter((p) => e.clear.isBaked(p.id)).length,
		};
	});
}

/** Requests by host while `run` goes. */
async function withRequests(page, run) {
	const hosts = {};
	const on = (r) => {
		let h = "";
		try {
			h = new URL(r.url()).host;
		} catch {}
		hosts[h] = (hosts[h] ?? 0) + 1;
	};
	page.on("request", on);
	try {
		await run();
	} finally {
		page.off("request", on);
	}
	return hosts;
}

function compare(seeded, live) {
	const report = [];
	let ok = true;
	const ids = (o) => Object.keys(o).sort().join();
	const sameSet = ids(seeded.tiles) === ids(live.tiles);
	ok &&= sameSet;
	report.push(
		`tile set: ${sameSet ? "identical" : "DIFFERS"} (${Object.keys(seeded.tiles).length} seeded, ${Object.keys(live.tiles).length} live)`,
	);
	for (const f of [
		"seg",
		"size",
		"sourceZ",
		"distance",
		"heights",
		"positions",
		"normals",
		"elev",
		"grid",
	]) {
		const bad = Object.keys(live.tiles).filter(
			(id) => seeded.tiles[id]?.[f] !== live.tiles[id][f],
		);
		ok &&= !bad.length;
		report.push(
			`  ${f}: ${bad.length ? `${bad.length} tiles DIFFER (${bad.slice(0, 4).join(", ")})` : "identical"}`,
		);
	}
	let poseOk = true;
	let coarseMax = 0;
	let coarseDiff = 0;
	let clearMax = 0;
	for (const [id, l] of Object.entries(live.photos)) {
		const s = seeded.photos[id];
		poseOk &&=
			!!s &&
			JSON.stringify(s.pose) === JSON.stringify(l.pose) &&
			JSON.stringify(s.eye) === JSON.stringify(l.eye);
		for (const [i, v] of (l.coarse?.data ?? []).entries()) {
			const d = Math.abs(v - (s?.coarse?.data[i] ?? Number.NaN));
			if (!(d <= 0)) coarseDiff++;
			if (d > coarseMax || Number.isNaN(d))
				coarseMax = Number.isNaN(d) ? Infinity : d;
		}
		for (const [i, v] of l.clear.entries()) {
			const d = Math.abs(v - (s?.clear[i] ?? Number.NaN));
			if (d > clearMax || Number.isNaN(d))
				clearMax = Number.isNaN(d) ? Infinity : d;
		}
	}
	ok &&= poseOk && coarseMax === 0 && clearMax === 0;
	report.push(`photo poses and eyes: ${poseOk ? "identical" : "DIFFER"}`);
	report.push(
		`coarse range grids: ${coarseDiff ? `${coarseDiff} cells differ, max |Δ| ${coarseMax} m` : "identical"}`,
	);
	report.push(
		`clear-air + exposure texels: ${clearMax ? `max |Δ| ${clearMax}` : "identical"} (${seeded.baked} photos baked)`,
	);
	const imgSame =
		ids(seeded.imagery) === ids(live.imagery) &&
		Object.keys(live.imagery).every(
			(id) => seeded.imagery[id] === live.imagery[id],
		);
	report.push(`imagery tiles and sizes: ${imgSame ? "identical" : "DIFFER"}`);
	ok &&= imgSame;
	return { ok, report };
}

const page = await browser.newPage({ viewport: { width: 1200, height: 750 } });
page.on("pageerror", (e) => console.log("[page] error:", e.message));
try {
	if (!verifyOnly) {
		const t0 = Date.now();
		await runEngine(page, false);
		const info = await extract(page, QUALITY);
		mkdirSync(OUT, { recursive: true });
		const files = {
			"terrain.bin": gzipSync(await pull(page, "__terrain"), { level: 9 }),
			"imagery.bin": await pull(page, "__imagery"),
			"photos.bin": gzipSync(await pull(page, "__photos"), { level: 9 }),
		};
		for (const [f, b] of Object.entries(files)) writeFileSync(join(OUT, f), b);
		const e = info.imageryError;
		console.log(
			`baked in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${info.tiles} terrain tiles, ${info.imagery} ${info.source} imagery tiles (${e.megapixels.toFixed(1)} MP), ${info.photos} photos`,
		);
		for (const f of Object.keys(files))
			console.log(
				`  ${join(OUT, f)}: ${(statSync(join(OUT, f)).size / 2 ** 20).toFixed(2)} MB`,
			);
		console.log(
			`  imagery WebP q${QUALITY} vs the live mosaics: mean |Δ| ${e.meanAbs.toFixed(2)}, PSNR ${e.psnr.toFixed(1)} dB, max channel |Δ| ${e.maxChannel}, ${e.pctOver8.toFixed(2)} % px with a channel off by > 8`,
		);
	}
	if (verify) {
		const seededHosts = await withRequests(page, () => runEngine(page, true));
		const seeded = await snapshot(page);
		const livePage = await browser.newPage({
			viewport: { width: 1200, height: 750 },
		});
		await runEngine(livePage, false);
		const live = await snapshot(livePage);
		await livePage.close();
		const { ok, report } = compare(seeded, live);
		for (const l of report) console.log(l);
		console.log(
			`seeded run requests: ${Object.entries(seededHosts)
				.map(([h, n]) => `${h} ${n}`)
				.join(", ")}`,
		);
		console.log(`seeded range hand-off: ${JSON.stringify(seeded.ranges)}`);
		console.log(
			ok
				? "seeded engine == live engine (imagery aside: lossy WebP, see above)"
				: "seeded != live (see above)",
		);
		process.exitCode = ok ? 0 : 1;
	}
} finally {
	await browser.close();
}
