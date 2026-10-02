#!/usr/bin/env node

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
// GPU memory of the photo view, WebGPU deck vs WebGL deck, by luma's statsManager ("GPU Time and
// Memory", the same instrument on both: window.__engine.metrics().luma). Per photo and renderer one
// fresh page: open, settle 2 s, sample; then an interaction (6 yaw nudges), settle, sample again.
// The full raw luma stat tables are kept in the JSON. Always under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/vram-probe.mjs [--url http://localhost:3100]
//     [--renderers webgpu,deck] [--out out/baseline/vram-probe.json] [IMG_7086 IMG_6958 IMG_7018]
import { APP_URL } from "../lib/harness.mjs";
import { launch, makeArg, openPhoto } from "./probe-common.mjs";

const arg = makeArg();
const BASE = arg("url", APP_URL);
const RENDERERS = arg("renderers", "webgpu,deck").split(",");
const OUT = arg("out", "out/baseline/vram-probe.json");
const given = process.argv.filter(
	(a, i) => a.startsWith("IMG_") && !process.argv[i - 1]?.startsWith("--"),
);
const ids = given.length ? given : ["IMG_7086", "IMG_6958", "IMG_7018"];

const SAMPLE = () => {
	const m = window.__engine?.metrics?.();
	const tab = (t) =>
		t
			? Object.fromEntries(
					Object.entries(t).map(([k, v]) => [
						k,
						typeof v === "object" && v
							? (v.count ?? v.value ?? v.total ?? null)
							: v,
					]),
				)
			: null;
	return {
		memory: tab(m?.luma?.memory),
		resources: tab(m?.luma?.resources),
		canvas: {
			w: window.__engine?.canvas?.width,
			h: window.__engine?.canvas?.height,
			dpr: devicePixelRatio,
		},
		jsHeapMiB: (performance.memory?.usedJSHeapSize ?? 0) / 2 ** 20,
		engine: document
			.querySelector("[data-renderer]")
			?.getAttribute("data-renderer"),
	};
};

const browser = await launch();
const rows = [];
for (const renderer of RENDERERS)
	for (const id of ids) {
		const ctx = await browser.newContext({
			viewport: { width: 1400, height: 900 },
		});
		const page = await ctx.newPage();
		const o = await openPhoto(page, BASE, id, renderer);
		await page.waitForTimeout(2000);
		const idle = await page.evaluate(SAMPLE);
		await page.evaluate(async () => {
			const e = window.__engine;
			const p0 = e.pose;
			for (let i = 1; i <= 6; i++) {
				e.setPose({ ...p0, yaw: p0.yaw + 0.3 * i });
				await new Promise((r) => setTimeout(r, 120));
			}
			e.setPose(p0);
		});
		await page.waitForTimeout(1500);
		const after = await page.evaluate(SAMPLE);
		rows.push({ renderer, id, ...o, idle, afterPan: after });
		console.log(
			renderer,
			id,
			"idle",
			JSON.stringify(idle.memory),
			"after",
			JSON.stringify(after.memory),
		);
		await ctx.close();
	}
await browser.close();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ url: BASE, rows }, null, 1));
console.log(`wrote ${OUT}`);
