#!/usr/bin/env node
// W4b: imagery-style pixel parity, batched terrain (imagery texture arrays) vs the per-tile path,
// on the SAME streamed tiles and the SAME imagery bitmaps in one page (__RIGI_TERRAIN_BOTH__
// builds both representations; __RIGI_FLAGS__.terrain flips the drawing path live).
// Per photo: autoAlign → settle the stream → for each case (photo view "replace" with the
// satellite / topo drape, rendered offscreen through compositor.renderImage = the colour pass;
// the 3D world view with the satellite drape = the canvas pass) wait for every tile's imagery,
// render tiles, batched, tiles again (noise floor), and compare RGBA8 pixels. Also counts draws
// and times each render, and reports the batched layer's map-pool capacity (GPU memory).
//
// Usage (under the render lock):
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/w4b-imagery-parity.mjs \
//     [--url http://localhost:3110] [--photos IMG_6958,...] [--out out/gpu/w4b/imagery-parity.json]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", "http://localhost:3110");
const IDS = arg("photos", "IMG_6958,IMG_7018,IMG_7155").split(",");
const CASES = arg(
	"cases",
	"replace-satellite,replace-topo,world-satellite",
).split(",");
const OUT = resolve(ROOT, arg("out", "out/gpu/w4b/imagery-parity.json"));
mkdirSync(dirname(OUT), { recursive: true });

const browser = await chromium.launch({
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});

async function run(id) {
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const logs = [];
	page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
	page.on(
		"console",
		(m) =>
			m.type() === "error" && logs.push(`error: ${m.text().slice(0, 300)}`),
	);
	await page.addInitScript(() => {
		localStorage.clear();
		globalThis.__RIGI_TERRAIN_BOTH__ = true;
		globalThis.__RIGI_FLAGS__ = {
			...globalThis.__RIGI_FLAGS__,
			terrain: "tiles",
		};
	});
	try {
		await page.goto(`${BASE}/photo/${id}?renderer=deck`);
		await page.waitForSelector("[data-ready]", { timeout: 240_000 });
		const r = await page.evaluate(async (cases) => {
			const e = window.__engine;
			const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
			const res = await e.autoAlign(true);
			const pose = res?.pose ?? e.pose;
			e.setPose(pose);
			for (let i = 0; i < 100; i++) {
				await sleep(200);
				const s = e.renderSet?.stats;
				if (i > 5 && s && s.pending === 0 && s.loadMs >= 0) break;
			}
			await sleep(400);
			const set = e.renderSet;
			const draws = globalThis.__rigiTerrainStats;
			const waitImagery = async () => {
				const t = performance.now();
				for (let i = 0; i < 600; i++) {
					e.updateLayers();
					await sleep(250);
					if (i > 3 && !e.imagery.abort) break;
				}
				await sleep(500);
				return {
					ms: Math.round(performance.now() - t),
					images: e.imagery.map.size,
					tiles: e.renderSet.tiles.length,
				};
			};
			const decode = async (blob) => {
				const bmp = await createImageBitmap(blob);
				const c = new OffscreenCanvas(bmp.width, bmp.height);
				const ctx = c.getContext("2d");
				ctx.drawImage(bmp, 0, 0);
				return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
			};
			const W = 1024;
			const rw = e.aspect >= 1 ? W : Math.round(W * e.aspect);
			const rh = e.aspect >= 1 ? Math.round(W / e.aspect) : W;
			const render = async (mode, world) => {
				globalThis.__RIGI_FLAGS__ = {
					...globalThis.__RIGI_FLAGS__,
					terrain: mode,
				};
				e.updateLayers();
				e.flushLayers();
				await sleep(300);
				// warm: the first draw after a mode flip (re)builds the layer's GPU store
				if (world) await e.exportImage(false);
				else
					await e.compositor.renderImage(
						e.liveLayers(),
						pose,
						e.eyeArr,
						rw,
						rh,
					);
				const d0 = draws.draws;
				const t = performance.now();
				let px;
				if (world) px = await decode(await e.exportImage(false));
				else
					px = await e.compositor.renderImage(
						e.liveLayers(),
						pose,
						e.eyeArr,
						rw,
						rh,
					);
				return { px, ms: performance.now() - t, draws: draws.draws - d0 };
			};
			const cmp = (a, b) => {
				const n = a.length / 4;
				let sum = 0;
				let over2 = 0;
				let over16 = 0;
				let max = 0;
				const hist = new Uint32Array(256);
				for (let i = 0; i < n; i++) {
					let m = 0;
					for (let c = 0; c < 3; c++) {
						const d = Math.abs(a[i * 4 + c] - b[i * 4 + c]);
						sum += d;
						if (d > m) m = d;
					}
					hist[m]++;
					if (m > 2) over2++;
					if (m > 16) over16++;
					if (m > max) max = m;
				}
				let acc = 0;
				let p99 = 0;
				for (let v = 0; v < 256; v++) {
					acc += hist[v];
					if (acc >= 0.99 * n) {
						p99 = v;
						break;
					}
				}
				return {
					meanAbs: sum / (3 * n),
					identicalFrac: hist[0] / n,
					over2Frac: over2 / n,
					over16Frac: over16 / n,
					p99,
					max,
				};
			};
			const pools = () => {
				const l = e
					.liveLayers()
					.find((x) => x.constructor.layerName === "BatchedTerrainTileLayer");
				const s = l?.state?.store;
				if (!s) return null;
				let bytes = 0;
				const out = {};
				for (const [k, p] of s.mapPools) {
					const [w, h] = k.split("x").map(Number);
					out[k] = { used: p.used, cap: p.cap };
					bytes += w * h * 4 * (4 / 3) * p.cap;
				}
				return { pools: out, mb: Math.round(bytes / 1e6) };
			};
			const out = {};
			for (const c of cases) {
				const [mode, src] = c.split("-");
				const world = mode === "world";
				e.setSettings(
					world
						? { mode: "world", worldStyle: src }
						: { mode: "replace", mapStyle: src },
				);
				await sleep(world ? 3000 : 500);
				const im = await waitImagery();
				const t1 = await render("tiles", world);
				const b1 = await render("batched", world);
				const pool = pools();
				const t2 = await render("tiles", world);
				const b2 = await render("batched", world);
				out[c] = {
					imagery: im,
					size: world ? null : [rw, rh],
					tilesVsBatched: cmp(t1.px, b1.px),
					tilesVsTiles: cmp(t1.px, t2.px),
					batchedVsBatched: cmp(b1.px, b2.px),
					draws: { tiles: t2.draws, batched: b2.draws },
					ms: { tiles: t2.ms, batched: b2.ms },
					pool,
				};
				globalThis.__RIGI_FLAGS__ = {
					...globalThis.__RIGI_FLAGS__,
					terrain: "tiles",
				};
			}
			return {
				pose,
				tiles: set.tiles.length,
				sameSet: e.renderSet === set,
				cases: out,
			};
		}, CASES);
		return { id, ...r, logs };
	} finally {
		await page.close();
	}
}

const rows = [];
try {
	for (const id of IDS) {
		const r = await run(id).catch((e) => ({ id, error: String(e) }));
		rows.push(r);
		if (r.error) {
			console.log(`${id}: ERROR ${r.error}`);
			continue;
		}
		for (const [c, v] of Object.entries(r.cases)) {
			const d = v.tilesVsBatched;
			const f = v.tilesVsTiles;
			console.log(
				`${id} ${c}: ${v.imagery.images}/${v.imagery.tiles} images | batched vs tiles mean|Δ| ${d.meanAbs.toFixed(4)} identical ${(d.identicalFrac * 100).toFixed(3)}% >2 ${(d.over2Frac * 100).toFixed(4)}% >16 ${(d.over16Frac * 100).toFixed(4)}% p99 ${d.p99} max ${d.max} | floor mean ${f.meanAbs.toFixed(4)} max ${f.max} | draws ${v.draws.tiles} vs ${v.draws.batched} | ms ${v.ms.tiles.toFixed(1)} vs ${v.ms.batched.toFixed(1)} | pools ${JSON.stringify(v.pool)}`,
			);
		}
		if (r.logs.length)
			console.log(
				`  ${r.logs.length} console errors: ${r.logs.slice(0, 3).join(" / ")}`,
			);
	}
} finally {
	await browser.close();
}
writeFileSync(
	OUT,
	JSON.stringify({ at: new Date().toISOString(), base: BASE, rows }, null, 1),
);
console.log(`wrote ${OUT}`);
