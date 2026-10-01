#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Load a lab URL, wait for ready, evaluate a JS expression in the page and print the result.
//   node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/eval.mjs "<url>" "<expr>"
import { chromium } from "playwright";
import { GPU_ARGS } from "./gpu-args.mjs";

const [url, expr] = process.argv.slice(2);
const browser = await chromium.launch({ args: GPU_ARGS });
try {
	const page = await browser.newPage({
		viewport: { width: 1280, height: 800 },
	});
	await page.goto(url);
	await page.waitForFunction(() => window.__deckWebgpuLab?.ready, null, {
		timeout: 90_000,
	});
	await page.waitForTimeout(2000);
	console.log(JSON.stringify(await page.evaluate(expr), null, 1));
} finally {
	await browser.close();
}
