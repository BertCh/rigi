#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WAG W2.4 probe: what the WebGPU photo view's synchronous CPU height readers cost under the GPU
// terrain decode. Per photo it loads /photo/<id>?renderer=webgpu&<query>, waits for [data-ready]
// plus --settle ms, pans the view through a few yaws (peaks entering view), and reports the
// GPU decode counters (tiles per path, lazy tiles materialised on the main thread and their ms),
// the height-gather counters (GPU gathers, samples, bytes, fallbacks) and the height-atlas stats.
//   node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/height-gathers-probe.mjs \
//     --url http://localhost:3151 --save out/height-gathers/on.json
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "./gpu-args.mjs";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", process.env.APP_URL ?? "http://localhost:3151");
const QUERY = arg("query", "");
const IDS = arg("photos", "IMG_7086,IMG_6958,IMG_3304").split(",");
const SETTLE = Number(arg("settle", "8000"));
const SAVE = resolve(arg("save", "out/height-gathers/probe.json"));
mkdirSync(dirname(SAVE), { recursive: true });

const YAWS = [30, 60, -60, 0];

async function runPhoto(browser, id) {
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.addInitScript(() => {
		try {
			localStorage.clear();
		} catch {}
	});
	const t0 = Date.now();
	await page.goto(
		`${BASE}/photo/${id}?renderer=webgpu${QUERY ? `&${QUERY}` : ""}`,
	);
	await page.waitForSelector("[data-ready]", {
		timeout: 240_000,
		state: "attached",
	});
	const readyMs = Date.now() - t0;
	await page.waitForTimeout(SETTLE);
	const snap = () =>
		page.evaluate(() => {
			const e = window.__engine;
			const st = e?.gpu?.terrain?.store;
			const a = (x) => (x?.stats ? { ...x.stats, capacity: x.capacity } : null);
			return JSON.parse(
				JSON.stringify({
					backend: e?.backend,
					gpuDecode: window.__rigiTerrainGpuDecode ?? null,
					gathers: window.__rigiHeightGathers ?? null,
					atlas: { small: a(st?.small), big: a(st?.big) },
					labels: e?.peakLabels?.().length ?? null,
					trails: e?.trails?.count ?? null,
				}),
			);
		});
	const atReady = await snap();
	// pan: peaks entering view snap now
	for (const yaw of YAWS) {
		await page.evaluate(
			async ({ yaw }) => {
				const e = window.__engine;
				window.__p0 ??= { ...e.pose };
				e.setPose({ ...window.__p0, yaw: window.__p0.yaw + yaw });
				for (let i = 0; i < 20; i++) await e.nextFrame("all");
			},
			{ yaw },
		);
		await page.waitForTimeout(1500);
	}
	const afterPan = await snap();
	// parity with the CPU readers (after the counters: these heightAt calls materialise tiles):
	// camera DEM height, every snapped peak, the trail segments, recomputed on the CPU, bit for bit
	const parity = await page.evaluate(async () => {
		const e = window.__engine;
		const t = e.terrain;
		if (!t) return null;
		const { buildTrailSegments } = await import("/src/lib/deck/trail-layer.ts");
		const { distanceM } = await import("/src/lib/geodesy.ts");
		const dem = t.heightAt(e.photo.lat, e.photo.lon);
		let peaks = 0;
		let peakDiff = 0;
		for (const [p, s] of e.snaps) {
			if (!s) continue;
			const d = distanceM(e.photo, p);
			const m = t.localMax(p.lat, p.lon, Math.min(250, 60 + d * 0.004));
			const w = t.frame.fromGeo(m.lat, m.lon, m.h);
			peaks++;
			if (w.some((v, i) => !Object.is(v, s.position[i]))) peakDiff++;
		}
		let trailDiff = -1;
		if (e.region && e.trails) {
			const cpu = buildTrailSegments(e.region, e.frame, e.photo, (la, lo) =>
				t.heightAt(la, lo),
			);
			const a = cpu.positions;
			const b = e.trails.positions;
			trailDiff = a.length === b.length ? 0 : Math.abs(a.length - b.length);
			if (!trailDiff)
				for (let i = 0; i < a.length; i++)
					if (!Object.is(a[i], b[i])) trailDiff++;
		}
		return {
			camera: e.demAtCamera === (dem ?? e.photo.alt ?? 0),
			peaks,
			peakDiff,
			trailSegments: e.trails?.count ?? 0,
			trailDiff,
		};
	});
	await page.close();
	return { id, readyMs, errors, atReady, afterPan, parity };
}

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const results = [];
try {
	for (const id of IDS) {
		const r = await runPhoto(browser, id);
		results.push(r);
		const c = (s) => s.gpuDecode?.cpuHeights;
		console.log(
			`${id} ${r.atReady.backend} ready ${r.readyMs} ms | +${SETTLE} ms: materialised ${c(r.atReady)?.materialized} (${c(r.atReady)?.ms?.toFixed(0)} ms) | after pan: ${c(r.afterPan)?.materialized} (${c(r.afterPan)?.ms?.toFixed(0)} ms) | tiles ${JSON.stringify(r.afterPan.gpuDecode?.tiles)} | gathers ${JSON.stringify(r.afterPan.gathers)} | labels ${r.afterPan.labels} trails ${r.afterPan.trails} | parity ${JSON.stringify(r.parity)}${r.errors.length ? ` | errors ${r.errors.join("; ")}` : ""}`,
		);
	}
} finally {
	await browser.close();
}
writeFileSync(SAVE, JSON.stringify(results, null, 2));
console.log(SAVE);
