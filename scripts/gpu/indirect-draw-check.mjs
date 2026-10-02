#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// luma.gl 10.0.0-alpha.2-rigi.3 (#3328) Model.setIndirectBuffer on WebGPU: N instances drawn from a
// GPU-written indirect record (a compute pass counts flags and writes the args; the CPU instance
// count is 0) must equal a direct draw of the same count, byte for byte. Runs
// scripts/gpu/indirect-draw-page.ts in headless Chromium against the dev server.
//
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/indirect-draw-check.mjs
//
// Env: APP_URL (default http://localhost:3110). Exit 1 on failure.
import { chromium } from "playwright";

const BASE = process.env.APP_URL ?? "http://localhost:3110";
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
	// a static file: no app, no router; Vite still serves /src and /scripts modules to it
	await page.goto(`${BASE}/favicon.svg`);
	r = await page.evaluate(async () => {
		const m = await import("/scripts/gpu/indirect-draw-page.ts");
		return m.indirectDrawCheck();
	});
} finally {
	await browser.close();
}
console.log(`Model.setIndirectBuffer present: ${r.hasApi}`);
for (const c of r.cases)
	console.log(
		`${c.equal ? "ok  " : "FAIL"} live=${c.live} gpuCount=${c.counted} pixels=${c.nonBlankPixels} differingBytes=${c.differingBytes}`,
	);
console.log(r.ok ? "PASS" : "FAIL");
process.exit(r.ok ? 0 : 1);
