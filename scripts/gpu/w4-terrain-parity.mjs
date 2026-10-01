#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// W4 parity: the batched terrain path (src/lib/deck/batched-terrain-layer.ts) vs the per-tile path,
// on the SAME streamed tiles in one page (globalThis.__RIGI_TERRAIN_BOTH__ builds both
// representations; __RIGI_FLAGS__.terrain flips the drawing path live).
// Per photo: autoAlign → settle the stream at that pose → render the geometry (range) pass at
// 1024 px in both modes (and tiles twice, the noise floor), compare, time the submit, count draw
// calls, and save small JPEG screenshots of the overlay and the 3D world view in both modes.
//
// Usage (under the render lock):
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/w4-terrain-parity.mjs \
//     [--url http://localhost:3110] [--photos IMG_6958,...] [--out out/gpu/w4/parity.json] [--shots]
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
const IDS = arg("photos", "IMG_6958,IMG_7018,IMG_7063,IMG_7155").split(",");
const OUT = resolve(ROOT, arg("out", "out/gpu/w4/parity.json"));
const SHOTS = process.argv.includes("--shots");
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
	let loads = 0;
	page.on("load", () => loads++);
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
		const r = await page.evaluate(async () => {
			const e = window.__engine;
			const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
			const res = await e.autoAlign(true);
			const pose = res?.pose ?? e.pose;
			e.setPose(pose);
			// let the wedge follow the pose and the stream finish
			for (let i = 0; i < 100; i++) {
				await sleep(200);
				const s = e.renderSet?.stats;
				if (i > 5 && s && s.pending === 0 && s.loadMs >= 0) break;
			}
			await sleep(400);
			const set = e.renderSet;
			const draws = globalThis.__rigiTerrainStats;
			const render = async (mode, reps = 1) => {
				globalThis.__RIGI_FLAGS__ = {
					...globalThis.__RIGI_FLAGS__,
					terrain: mode,
				};
				e.updateLayers();
				e.flushLayers();
				const made = e.makeSource(
					e.aspect >= 1 ? 1024 : Math.round(1024 * e.aspect),
					e.aspect >= 1 ? Math.round(1024 / e.aspect) : 1024,
					false,
				);
				const src = made.src;
				const sub = [];
				const tot = [];
				let d = 0;
				for (let k = 0; k < reps; k++) {
					const d0 = draws.draws;
					await src.render(pose);
					d = draws.draws - d0;
					sub.push(src.timing.submitMs);
					tot.push(src.timing.totalMs);
				}
				const range = src.range.slice();
				src.dispose();
				const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
				return {
					range,
					w: src.width,
					h: src.height,
					submitMs: med(sub),
					totalMs: med(tot),
					draws: d,
				};
			};
			const cmp = (a, b) => {
				const rel = [];
				let flips = 0;
				let skyA = 0;
				for (let i = 0; i < a.length; i++) {
					const fa = Number.isFinite(a[i]);
					const fb = Number.isFinite(b[i]);
					if (!fa) skyA++;
					if (fa !== fb) flips++;
					else if (fa) rel.push(Math.abs(a[i] - b[i]) / a[i]);
				}
				rel.sort((x, y) => x - y);
				const q = (p) =>
					rel[Math.min(rel.length - 1, Math.floor(p * rel.length))] ?? 0;
				// signed bias on terrain pixels
				let bias = 0;
				let n = 0;
				for (let i = 0; i < a.length; i++)
					if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
						bias += (b[i] - a[i]) / a[i];
						n++;
					}
				return {
					median: q(0.5),
					p99: q(0.99),
					p999: q(0.999),
					max: rel[rel.length - 1] ?? 0,
					meanSigned: n ? bias / n : 0,
					flipFrac: flips / a.length,
					flips,
					skyFrac: skyA / a.length,
				};
			};
			const t1 = await render("tiles", 7);
			const b1 = await render("batched", 7);
			const t2 = await render("tiles", 1);
			const sameSet = e.renderSet === set;
			return {
				pose,
				tiles: set.tiles.length,
				stats: set.stats,
				sameSet,
				size: [t1.w, t1.h],
				tilesVsBatched: cmp(t1.range, b1.range),
				tilesVsTiles: cmp(t1.range, t2.range),
				timing: {
					tiles: {
						submitMs: t1.submitMs,
						totalMs: t1.totalMs,
						draws: t1.draws,
					},
					batched: {
						submitMs: b1.submitMs,
						totalMs: b1.totalMs,
						draws: b1.draws,
					},
				},
			};
		});
		if (SHOTS)
			await shots(page, id, r.pose).catch((e) =>
				logs.push(`shots failed: ${String(e).slice(0, 200)}`),
			);
		return { id, ...r, loads, logs };
	} finally {
		await page.close();
	}
}

/** Overlay + 3D world screenshots in both modes (re-waits if a dev-server reload hit the page). */
async function shots(page, id, pose) {
	const ensure = async () => {
		if (await page.evaluate(() => !!window.__engine?.terrain)) return;
		await page.waitForSelector("[data-ready]", { timeout: 240_000 });
		await page.evaluate((p) => window.__engine.setPose(p), pose);
		await page.waitForTimeout(3000);
	};
	{
		const shot = async (name) => {
			await page.waitForTimeout(600);
			await page.screenshot({
				path: resolve(dirname(OUT), `${id}-${name}.jpg`),
				type: "jpeg",
				quality: 55,
				clip: { x: 0, y: 45, width: 1080, height: 810 },
			});
		};
		for (const mode of ["tiles", "batched"]) {
			await ensure();
			await page.evaluate((m) => {
				globalThis.__RIGI_FLAGS__ = {
					...globalThis.__RIGI_FLAGS__,
					terrain: m,
				};
				window.__engine.updateLayers();
			}, mode);
			await shot(`overlay-${mode}`);
		}
		await ensure();
		await page.evaluate(() => window.__engine.setSettings({ mode: "world" }));
		await page.waitForTimeout(3000);
		for (const mode of ["tiles", "batched"]) {
			await page.evaluate((m) => {
				globalThis.__RIGI_FLAGS__ = {
					...globalThis.__RIGI_FLAGS__,
					terrain: m,
				};
				window.__engine.updateLayers();
			}, mode);
			await shot(`world-${mode}`);
		}
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
		const c = r.tilesVsBatched;
		console.log(
			`${id}: ${r.tiles} tiles ${r.size.join("×")} | batched vs tiles |Δr|/r median ${c.median.toExponential(2)} p99 ${c.p99.toExponential(2)} p99.9 ${c.p999.toExponential(2)} bias ${c.meanSigned.toExponential(2)} flips ${(c.flipFrac * 100).toFixed(4)}% (${c.flips} px) | noise floor p99 ${r.tilesVsTiles.p99.toExponential(2)} | submit tiles ${r.timing.tiles.submitMs.toFixed(2)} ms/${r.timing.tiles.draws} draws, batched ${r.timing.batched.submitMs.toFixed(2)} ms/${r.timing.batched.draws} draws | total ${r.timing.tiles.totalMs.toFixed(1)} vs ${r.timing.batched.totalMs.toFixed(1)} ms${r.sameSet ? "" : " (tile set changed!)"}${r.logs.length ? ` | ${r.logs.length} console errors` : ""}`,
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
