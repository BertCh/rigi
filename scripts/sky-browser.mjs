// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { chromium } from "playwright";
/**
 * Runs src/lib/sky in headless Chromium against the dev server (Vite serves
 * the module source directly) and reports backend + timings per photo.
 *
 *   node scripts/sky-browser.mjs [--url http://localhost:3100] [--fallback] [--no-webgpu] [IMG_xxxx ...]
 */
import { APP_URL } from "./lib/harness.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => {
	const i = args.indexOf(k);
	if (i < 0) return d;
	const v = args[i + 1];
	args.splice(i, 2);
	return v;
};
const has = (k) => {
	const i = args.indexOf(k);
	if (i < 0) return false;
	args.splice(i, 1);
	return true;
};
const url = opt("--url", APP_URL);
const forceFallback = has("--fallback");
const noGpu = has("--no-webgpu");
const names = args.length
	? args
	: ["IMG_6958", "IMG_7053", "IMG_7086", "IMG_7108", "IMG_7131", "IMG_7155"];

const browser = await chromium.launch({ args: ["--enable-unsafe-webgpu"] });
const page = await browser.newPage();
page.on("console", (m) => {
	if (m.type() === "warning" || m.type() === "error")
		console.log(`[page ${m.type()}] ${m.text()}`);
});
await page.goto(`${url}/photos/${names[0]}.jpg`);
const res = await page.evaluate(
	async ({ names, forceFallback, noGpu }) => {
		const out = [];
		const hasGpu = !!(
			navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null))
		);
		const sky = await import("/src/lib/sky/index.ts");
		const tp = performance.now();
		const pre = sky.preloadSkyModel({ backend: noGpu ? "cpu" : undefined });
		const returnMs = performance.now() - tp; // must be ~0: non-blocking
		const ready = await pre;
		out.push({
			preload: ready,
			returnMs: +returnMs.toFixed(1),
			readyMs: Math.round(performance.now() - tp),
		});
		for (const name of names) {
			const img = new Image();
			img.src = `/photos/${name}.jpg`;
			await img.decode();
			const t0 = performance.now();
			const m = await sky.segmentSky(img, {
				forceFallback,
				backend: noGpu ? "cpu" : undefined,
			});
			const t1 = performance.now();
			const s = sky.skylineFromSky(m);
			let n = 0;
			for (const v of s.rows) if (Number.isFinite(v)) n++;
			let skyFrac = 0;
			for (const v of m.data) skyFrac += v;
			out.push({
				name,
				hasGpu,
				size: `${m.width}x${m.height}`,
				source: m.source,
				backend: m.backend,
				totalMs: Math.round(t1 - t0),
				ms:
					m.ms &&
					Object.fromEntries(
						Object.entries(m.ms).map(([k, v]) => [k, Math.round(v)]),
					),
				coverage: +(n / m.width).toFixed(2),
				skyFrac: +(skyFrac / 255 / m.data.length).toFixed(3),
			});
		}
		return out;
	},
	{ names, forceFallback, noGpu },
);
for (const r of res) console.log(JSON.stringify(r));
await browser.close();
