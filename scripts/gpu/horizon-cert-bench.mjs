#!/usr/bin/env node

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
// Certified-f32 horizon stages (src/lib/gpu/horizon/certified.ts) vs the f64 path on the dev photos:
// output bits (identical required), tie-path share, the device probe, timing. Runs
// src/lib/gpu/horizon/certified-bench.ts in headless Chromium (WebGPU) against a dev server.
//
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/horizon-cert-bench.mjs [IMG_xxxx ...]
//
// Env: APP_URL (default http://localhost:3100). Exits 1 when any output bit differs, the probe fails
// or no WebGPU device was used. Writes out/gpu/horizon-cert/bench.json.
import { APP_URL } from "../lib/harness.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = APP_URL;
const OUT = path.join(ROOT, "out/gpu/horizon-cert");
const gt = JSON.parse(
	fs.readFileSync(path.join(ROOT, "data/ground-truth.json"), "utf8"),
);
const ids = process.argv.slice(2).length
	? process.argv.slice(2)
	: Object.keys(gt).filter((id) => gt[id]?.lat != null && gt[id]?.eye != null);

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const rows = [];
let bad = 0;
try {
	const page = await browser.newPage();
	page.on("console", (m) => {
		if (m.type() === "error" || m.type() === "warning")
			console.error(`[page ${m.type()}]`, m.text().slice(0, 300));
	});
	// a static file (no app; the engine pin is moot, kept for the harness convention); Vite serves /src
	await page.goto(`${BASE}/favicon.svg?renderer=webgpu`);
	const hasGpu = await page.evaluate(() => !!navigator.gpu);
	if (!hasGpu)
		throw new Error("navigator.gpu is missing: no WebGPU in this browser");
	for (const id of ids) {
		const g = gt[id];
		const t0 = Date.now();
		let r;
		try {
			r = await page.evaluate(
				async (a) => {
					const m = await import("/src/lib/gpu/horizon/certified-bench.ts");
					return m.benchCertified(a);
				},
				{ id, lat: g.lat, lon: g.lon, h: g.eye },
			);
		} catch (e) {
			console.log(`${id}: ERROR ${String(e).slice(0, 400)}`);
			bad++;
			continue;
		}
		rows.push(r);
		const A = r.stageA;
		const B = r.stageBC;
		const v = r.gpuVsEmulation;
		const differ =
			A.elevationBitsDiffer + A.distanceBitsDiffer + B.dirsBitsDiffer;
		if (differ || !r.probe.ok || A.fellBack || B.fellBack) bad++;
		console.log(
			`${id}: probe ${r.probe.ok ? "ok" : `FAILED ${JSON.stringify(r.probe.failures)} ${r.probe.error ?? ""}`} | ` +
				`A: ${A.samples} samples, bits ≠ ${A.elevationBitsDiffer}/${A.distanceBitsDiffer}, ties ${A.ties}${A.fellBack ? ` FELL BACK (${A.fellBack})` : ""}, march f64 ${A.marchF64Ms.toFixed(1)} ms vs certified ${A.marchCertifiedMs.toFixed(1)} ms (cert GPU ${A.certGpuMs.toFixed(1)}, cold ${A.certGpuColdMs.toFixed(1)}) | ` +
				`B+C: ${B.kept}/${B.columns} kept, bits ≠ ${B.dirsBitsDiffer}, ties ${B.ties} (${((100 * B.ties) / B.columns).toFixed(1)}%)${B.fellBack ? ` FELL BACK (${B.fellBack})` : ""}, f64 ${B.f64Ms.toFixed(1)} ms vs certified ${B.certifiedMs.toFixed(1)} ms (GPU ${B.certGpuMs.toFixed(1)} + finish ${B.certFinishMs.toFixed(1)}) | ` +
				`spot-checked A ${A.spotChecked} C ${B.spotChecked} | ` +
				`GPU vs emulation: A ${JSON.stringify(v.stageA)} C ${JSON.stringify(v.stageC)} [${((Date.now() - t0) / 1000).toFixed(0)} s]`,
		);
		if (v.stageA.bothBitsDiffer || v.stageC.bothBitsDiffer) bad++;
	}
} finally {
	await browser.close();
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "bench.json"), JSON.stringify(rows, null, 1));
console.log(
	`${bad ? "FAIL" : "PASS"}: ${rows.length} photos; wrote ${path.relative(ROOT, path.join(OUT, "bench.json"))}`,
);
process.exit(bad ? 1 : 0);
