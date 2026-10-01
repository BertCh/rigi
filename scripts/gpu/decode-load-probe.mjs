#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Photo open time with the WebGPU engine's GPU Terrarium decode on vs off (flag terrainGpuDecode). Per
// photo and run, one fresh page per arm, the arms interleaved (on, off, on, off, …) so machine drift
// hits both: navigation → [data-ready] (readyMs) and → data-verify settled (settledMs), the terrain
// stream's own generation time (TerrainSet.stats.loadMs: every wanted tile loaded and meshed), the
// height-atlas upload bytes and the decode path counters, then a pan of four yaws and the same
// counters again (tiles re-entering the atlas). One discarded warm-up open per arm comes first. Always under the render lock, exclusive for timings:
//   RENDER_LOCK_EXCLUSIVE=1 node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/decode-load-probe.mjs \
//     [--url http://localhost:3211] [--runs 3] [--arms on,off] [--out out/decode-load/probe.json] \
//     [IMG_7086 IMG_6958 IMG_7018]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { launch, makeArg, median, openPhoto, p90Of } from "./probe-common.mjs";

const arg = makeArg();
const BASE = arg("url", process.env.APP_URL ?? "http://localhost:3211");
const RUNS = Number(arg("runs", "3"));
const ARMS = arg("arms", "on,off").split(",");
const OUT = arg("out", "out/decode-load/probe.json");
const PAN = arg("pan", "on") !== "off";
const given = process.argv.filter(
	(a, i) => a.startsWith("IMG_") && !process.argv[i - 1]?.startsWith("--"),
);
const ids = given.length ? given : ["IMG_7086", "IMG_6958", "IMG_7018"];
const YAWS = [30, 60, -60, 0];

const SNAP = () => {
	const e = window.__engine;
	const st = e?.gpu?.terrain?.store;
	const a = (x) => (x?.stats ? { ...x.stats, capacity: x.capacity } : null);
	const mem = e?.metrics?.()?.luma?.memory?.["GPU Memory"];
	return JSON.parse(
		JSON.stringify({
			backend: e?.backend,
			terrain: e?.terrain?.stats ?? null,
			gpuDecode: window.__rigiTerrainGpuDecode ?? null,
			atlas: { small: a(st?.small), big: a(st?.big) },
			gpuMemoryBytes: mem?.count ?? mem?.value ?? mem ?? null,
		}),
	);
};

async function runOne(browser, id, arm) {
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
	const t = await openPhoto(
		page,
		BASE,
		id,
		"webgpu",
		`&terrainGpuDecode=${arm}`,
	);
	// the full generation (stats.loadMs) may finish after data-ready: wait for it (≤ 20 s)
	await page
		.waitForFunction(
			() => (window.__engine?.terrain?.stats?.loadMs ?? -1) >= 0,
			null,
			{ timeout: 20_000 },
		)
		.catch(() => {});
	const atReady = await page.evaluate(SNAP);
	let afterPan = null;
	if (PAN) {
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
		afterPan = await page.evaluate(SNAP);
	}
	await page.close();
	return { id, arm, ...t, errors, atReady, afterPan };
}

const browser = await launch();
const rows = [];
try {
	// one discarded open per arm first: Vite's transforms and the browser caches warm for both
	for (const arm of ARMS) await runOne(browser, ids[0], arm);
	for (let run = 1; run <= RUNS; run++)
		for (const id of ids)
			for (const arm of run % 2 ? ARMS : [...ARMS].reverse()) {
				const r = await runOne(browser, id, arm);
				r.run = run;
				rows.push(r);
				// every GPU upload of heights / sources: atlas writes + the stats-only graph's sources
				const bytes = (s) =>
					s
						? (s.atlas.small?.writeBytes ?? 0) +
							(s.atlas.big?.writeBytes ?? 0) +
							(s.gpuDecode?.tiles?.statsOnlyBytes ?? 0)
						: 0;
				console.log(
					`run ${run} ${id} decode=${arm} ${r.atReady.backend} ready ${r.readyMs} settled ${r.settledMs} genLoad ${r.atReady.terrain?.loadMs} ms | atlas MB ready ${(bytes(r.atReady) / 1e6).toFixed(1)} pan ${(bytes(r.afterPan) / 1e6).toFixed(1)} | tiles ${JSON.stringify(r.atReady.gpuDecode?.tiles ?? null)}${r.errors.length ? ` | errors ${r.errors.slice(0, 2).join("; ")}` : ""}`,
				);
			}
} finally {
	await browser.close();
}
const summary = {};
for (const arm of ARMS) {
	const xs = rows.filter((r) => r.arm === arm);
	const pick = (f) => ({ median: median(xs.map(f)), p90: p90Of(xs.map(f)) });
	summary[arm] = {
		n: xs.length,
		readyMs: pick((r) => r.readyMs),
		settledMs: pick((r) => r.settledMs),
		genLoadMs: pick((r) => r.atReady.terrain?.loadMs ?? Number.NaN),
	};
}
console.log(JSON.stringify(summary));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 1));
console.log(OUT);
