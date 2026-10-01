// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Overlay exports of demo photos for the landing page: the workspace's own image export (photo
// resolution, the same frame as the photo, peak labels on) → public/demo/shots/<id>-overlay.jpg.
//   APP_URL=http://localhost:3161 node scripts/gpu/with-render-lock.mjs -- npx tsx scripts/demo/export-overlay.ts demo-01 [demo-NN…]
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.APP_URL ?? "http://localhost:3161";
const OUT = "public/demo/shots";
const ids = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
for (const id of ids) {
	const page = await browser.newPage({
		viewport: { width: 1440, height: 1000 },
	});
	page.on("pageerror", (e) => console.log(`[${id}] pageerror`, e.message));
	await page.goto(`${BASE}/photo/${id}`);
	await page.waitForSelector("[data-ready]", {
		state: "attached",
		timeout: 180_000,
	});
	await page.waitForFunction(
		() =>
			document.querySelector("[data-ready]")?.getAttribute("data-verify") !==
			"pending",
		null,
		{ timeout: 180_000 },
	);
	await page.waitForTimeout(2500);
	const b64 = await page.evaluate(async () => {
		const blob = await window.__engine?.exportImage(true);
		if (!blob) throw new Error("no export");
		const buf = new Uint8Array(await blob.arrayBuffer());
		let s = "";
		for (let i = 0; i < buf.length; i += 0x8000)
			s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
		return btoa(s);
	});
	const file = `${OUT}/${id}-overlay.jpg`;
	writeFileSync(file, Buffer.from(b64, "base64"));
	console.log("wrote", file);
	await page.close();
}
await browser.close();
