#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Self-test of src/lib/gpu/core (device registry, pool + leases, ring readback, kernels, command
// graph + GPUReduction, timestamp profiling, adoptRenderDevice). Runs src/lib/gpu/core/selftest.ts
// in headless Chromium (WebGPU) against the dev server.
//
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/core-selftest.mjs
//
// Env: APP_URL (default http://localhost:3110). Writes out/gpu/core/selftest.json; exit 1 on failure.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = process.env.APP_URL ?? "http://localhost:3110";
const OUT = path.join(ROOT, "out/gpu/core");

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
let r;
try {
	const page = await browser.newPage();
	page.on("console", (m) => {
		if (m.type() === "error" || m.type() === "warning")
			console.error(`[page ${m.type()}]`, m.text().slice(0, 300));
	});
	// a static file: no app, no router navigations; Vite still serves /src modules to it
	await page.goto(`${BASE}/favicon.svg`);
	r = await page.evaluate(async () => {
		const m = await import("/src/lib/gpu/core/selftest.ts");
		return m.coreSelftest();
	});
} finally {
	await browser.close();
}
for (const c of r.checks)
	console.log(
		`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail === undefined ? "" : ` ${JSON.stringify(c.detail).slice(0, 400)}`}`,
	);
console.log(
	`${r.ok ? "PASS" : "FAIL"}: ${r.checks.filter((c) => c.ok).length}/${r.checks.length} in ${r.ms.toFixed(0)} ms`,
);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "selftest.json"), JSON.stringify(r, null, 1));
process.exit(r.ok ? 0 : 1);
