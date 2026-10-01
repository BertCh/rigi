#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Runs the deck-on-WebGPU feasibility spike (/lab/deck-webgpu?spike=1) and prints its report.
// Needs deck's full build, i.e. the dev server from scripts/deck-webgpu/vite.webgpu.config.ts:
//   npx vite dev --config scripts/deck-webgpu/vite.webgpu.config.ts --port 3111
//   node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/spike.mjs
// Env: APP_URL (default http://localhost:3111). Screenshot + JSON → out/deck-webgpu/spike.*
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "./gpu-args.mjs";

const URL0 = process.env.APP_URL ?? "http://localhost:3111";
const OUT = resolve(import.meta.dirname, "../../out/deck-webgpu");
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: GPU_ARGS });
try {
	const page = await browser.newPage({
		viewport: { width: 1000, height: 640 },
	});
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => {
		if (
			(m.type() === "error" || m.type() === "warning") &&
			!/Module \w+ not found/.test(m.text())
		)
			errors.push(`${m.type()}: ${m.text().slice(0, 400)}`);
	});
	await page.goto(`${URL0}/lab/deck-webgpu?spike=1`);
	await page.waitForFunction(
		() =>
			/spike done|error/.test(
				document.querySelector("[data-testid=status]")?.textContent ?? "",
			),
		null,
		{ timeout: 90_000 },
	);
	const report = await page.evaluate(() => window.__deckWebgpuSpike ?? null);
	const status = await page.textContent("[data-testid=status]");
	await page.screenshot({ path: `${OUT}/spike.png` });
	const out = { status, report, pageErrors: errors.slice(0, 20) };
	writeFileSync(`${OUT}/spike.json`, JSON.stringify(out, null, 2));
	console.log(JSON.stringify(out, null, 2));
} finally {
	await browser.close();
}
