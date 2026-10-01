#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Does /photo/<id>?renderer=deck[&extra] load (data-ready) without page errors? Run under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/deck-load-check.mjs [IMG_7086] [--query terrain=batched]
import { chromium } from "playwright";

const qi = process.argv.indexOf("--query");
const extra = qi >= 0 ? `&${process.argv[qi + 1]}` : "";
const id =
	process.argv
		.slice(2)
		.find((a, i, a2) => !a.startsWith("--") && a2[i - 1] !== "--query") ??
	"IMG_7086";
const URL0 = process.env.APP_URL ?? "http://localhost:3110";
const browser = await chromium.launch({
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
try {
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	const t0 = Date.now();
	await page.goto(`${URL0}/photo/${id}?renderer=deck${extra}`);
	let ready = true;
	await page
		.waitForSelector("[data-ready]", { state: "attached", timeout: 120000 })
		.catch(() => (ready = false));
	const failed = await page.getByText(/failed to load/i).count();
	console.log(
		JSON.stringify({
			id,
			extra,
			ready,
			failedBanner: failed,
			ms: Date.now() - t0,
			errors: errors.slice(0, 5),
		}),
	);
} finally {
	await browser.close();
}
