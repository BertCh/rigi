#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Screenshot a Gipfelbuch page in 1000-px slices for visual review (with every <details> opened),
// and report console errors.
// Usage (through the render lock):
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gipfelbuch/shot.mjs <concept-id|index> <outPrefix> [width=1400] [maxSlices=12]
// Writes <outPrefix>-0.png, -1.png, … and prints the page height and any console errors.

import { chromium } from "playwright";

const [concept, outPrefix, width = "1400", maxSlices = "12"] =
	process.argv.slice(2);
if (!concept || !outPrefix) {
	console.error(
		"usage: shot.mjs <concept-id|index> <outPrefix> [width] [maxSlices]",
	);
	process.exit(1);
}
const base = process.env.RIGI_URL ?? "http://localhost:3100";
const url =
	concept === "index" ? `${base}/gipfelbuch` : `${base}/gipfelbuch/${concept}`;
const browser = await chromium.launch();
const page = await browser.newPage({
	viewport: { width: Number(width), height: 1000 },
});
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on(
	"console",
	(message) => message.type() === "error" && errors.push(message.text()),
);
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
// Open every collapsed <details> so figures inside them are captured too.
await page.evaluate(() => {
	for (const details of document.querySelectorAll("details"))
		details.open = true;
});
await page.waitForTimeout(2500);
const height = await page.evaluate(() => document.documentElement.scrollHeight);
let slice = 0;
for (let y = 0; y < height && slice < Number(maxSlices); y += 1000, slice++) {
	await page.evaluate((top) => window.scrollTo(0, top), y);
	await page.waitForTimeout(600);
	await page.screenshot({ path: `${outPrefix}-${slice}.png` });
}
console.log(
	JSON.stringify({ url, height, slices: slice, errors: errors.slice(0, 10) }),
);
await browser.close();
