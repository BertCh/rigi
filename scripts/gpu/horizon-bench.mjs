#!/usr/bin/env node

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
// GPU horizon (src/lib/gpu/horizon) vs the CPU horizon-fast march: parity + timing on dev photos' eyes.
// Runs src/lib/gpu/horizon/bench.ts in headless Chromium (WebGPU) against the dev server.
//
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/horizon-bench.mjs [IMG_xxxx ...]
//
// Env: APP_URL (default http://localhost:3100), BATCH (eyes in the batch test, default 343).
// Writes out/gpu/w1/horizon-bench.json and prints a summary.
import { APP_URL } from "../lib/harness.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = APP_URL;
const BATCH = Number(process.env.BATCH ?? 343);
const OUT = path.join(ROOT, "out/gpu/w1");
const gt = JSON.parse(
	fs.readFileSync(path.join(ROOT, "data/ground-truth.json"), "utf8"),
);
const ids = process.argv.slice(2).length
	? process.argv.slice(2)
	: ["IMG_6958", "IMG_7018", "IMG_7063", "IMG_7155", "IMG_3304"];

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const rows = [];
try {
	const page = await browser.newPage();
	page.on("console", (m) => {
		if (m.type() === "error" || m.type() === "warning")
			console.error(`[page ${m.type()}]`, m.text().slice(0, 300));
	});
	// a static file: no app, no router navigations; Vite still serves /src modules to it
	await page.goto(`${BASE}/favicon.svg`);
	for (const id of ids) {
		const g = gt[id];
		if (!g?.lat || !g?.eye) {
			console.error(`skip ${id}: no lat/lon/eye in ground-truth.json`);
			continue;
		}
		const t0 = Date.now();
		const r = await page.evaluate(
			async (a) => {
				const m = await import("/src/lib/gpu/horizon/bench.ts");
				return m.benchPhoto(a);
			},
			{ id, lat: g.lat, lon: g.lon, h: g.eye, batch: BATCH },
		);
		rows.push(r);
		const a = r.app;
		console.log(
			`${id}: app parity max ${a.parity.maxDEl.toFixed(5)}° p99 ${a.parity.p99DEl.toExponential(2)}° ` +
				`med ${a.parity.medDEl.toExponential(2)}° empty≠ ${a.parity.emptyMismatch} dist±1% ${(100 * a.parity.dist1pct).toFixed(2)}% | ` +
				`cpu ${a.cpuMs.toFixed(0)} ms, gpu cold ${a.gpuColdMs.toFixed(0)} (upload ${r.firstCallUploadMs.toFixed(0)}) warm ${a.gpuWarmMs.toFixed(1)} ms | ` +
				`batch ${r.batch.eyes}: ${r.batch.gpuMs.toFixed(0)} ms (${r.batch.gpuMsPerEye.toFixed(2)}/eye) vs cpu ≈${(r.batch.cpuMsExtrapolated / 1000).toFixed(1)} s ×${r.batch.speedup.toFixed(0)} [${((Date.now() - t0) / 1000).toFixed(0)} s]`,
		);
		const x = r.batch.rerun;
		console.log(
			`   batch re-runs vs first: el≠ ${x.diff.el} dist≠ ${x.diff.dist} stats≠ ${x.diff.stats} (${x.diff.n} profiles) warm med ${x.warmMedMs.toFixed(1)} ms`,
		);
		if (x.diff.el || x.diff.dist || x.diff.stats) process.exitCode = 1;
		for (const k of ["defaults", "noMipSkip"])
			console.log(
				`   ${k}: max ${r[k].parity.maxDEl.toFixed(5)}° p99 ${r[k].parity.p99DEl.toExponential(2)}° empty≠ ${r[k].parity.emptyMismatch} dist±1% ${(100 * r[k].parity.dist1pct).toFixed(2)}% cpu ${r[k].cpuMs.toFixed(0)} gpu ${r[k].gpuWarmMs.toFixed(1)} ms`,
			);
	}
} finally {
	await browser.close();
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
	path.join(OUT, "horizon-bench.json"),
	JSON.stringify(rows, null, 1),
);
console.log(`wrote ${path.join(OUT, "horizon-bench.json")}`);
