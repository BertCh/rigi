#!/usr/bin/env node

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Screenshots + fps for /lab/deck-splats (DeckSplatLayer on its own, via window.__splatLab). Run under the
// render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/nearfield/deck-splat-lab-check.mjs [--n 0,200000] [--no-shots] [--size 1280x800] [--url http://localhost:3100]
// Shots land in tools/nearfield/shots/ (gitignored). The lab is WebGL2 only (GLSL layer, no WGSL path), so
// the engine is pinned by asserting the Deck's device type is "webgl"; --renderer deck is accepted, anything
// else fails. Exit code is non-zero on a page error, a missing/empty canvas, a wrong backend or 0 drawn splats.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { APP_URL } from "../lib/harness.mjs";

const arg = (k, d) => {
	const i = process.argv.indexOf(k);
	return i >= 0 ? process.argv[i + 1] : d;
};
const BASE = arg("--url", APP_URL);
const renderer = arg("--renderer", "deck");
if (renderer !== "deck") {
	console.error(
		`/lab/deck-splats runs on WebGL2 only (--renderer deck); got --renderer ${renderer}`,
	);
	process.exit(2);
}
const ns = arg("--n", "0,200000").split(",").map(Number);
const shots = !process.argv.includes("--no-shots");
const [VW, VH] = arg("--size", "1280x800").split("x").map(Number);
const OUT = resolve(import.meta.dirname, "../../tools/nearfield/shots");
mkdirSync(OUT, { recursive: true });

// fixed views: first-person (default), orbit, truth, nodepth (the hidden red ball shows through the hill)
const VIEWS = [
	{ name: "fp", query: "mode=fp" },
	{ name: "orbit", query: "mode=orbit" },
	{ name: "truth", query: "mode=fp&truth=1" },
	{ name: "nodepth", query: "mode=fp&nodepth=1" },
];

const failures = [];
const fail = (msg) => {
	failures.push(msg);
	console.error(`FAIL ${msg}`);
};

const browser = await chromium.launch({
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});

async function open(query) {
	const page = await browser.newPage({
		viewport: { width: VW, height: VH },
		deviceScaleFactor: 1,
	});
	const errors = [];
	page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(`console: ${m.text()}`);
	});
	await page.goto(`${BASE}/lab/deck-splats?${query}`);
	await page.waitForFunction(
		() => window.__splatLab && document.querySelector("canvas")?.dataset.ready,
		null,
		{ timeout: 120000 },
	);
	await page.waitForTimeout(2000);
	return { page, errors };
}

async function inspect(label, page, errors) {
	const info = await page.evaluate(() => {
		const c = document.querySelector("canvas");
		return {
			canvas: c ? [c.width, c.height] : null,
			backend: window.__splatLab.backend(),
			stats: window.__splatLab.stats(),
		};
	});
	if (!info.canvas || !info.canvas[0] || !info.canvas[1])
		fail(`${label}: missing or empty canvas`);
	if (info.backend !== "webgl")
		fail(`${label}: expected the webgl device, got ${info.backend}`);
	if (!(Number(info.stats.drawn) > 0))
		fail(`${label}: stats show 0 drawn splats`);
	for (const e of errors.slice(0, 5)) fail(`${label}: ${e}`);
	return info;
}

try {
	if (shots) {
		for (const v of VIEWS) {
			const { page, errors } = await open(v.query);
			const info = await inspect(`view ${v.name}`, page, errors);
			await page.screenshot({ path: `${OUT}/deck-splats-${v.name}.png` });
			console.log(JSON.stringify({ view: v.name, ...info }));
			await page.close();
		}
	}
	for (const n of ns) {
		const { page, errors } = await open(`mode=fp&n=${n}`);
		const m = await page.evaluate(() => window.__splatLab.measureFps(4000));
		const info = await inspect(`fps n=${n}`, page, errors);
		if (!(m.frames > 0)) fail(`fps n=${n}: no frames rendered`);
		console.log(
			JSON.stringify({ n, size: `${VW}x${VH}`, renderer, ...m, ...info }),
		);
		await page.close();
	}
} finally {
	await browser.close();
}
if (failures.length) {
	console.error(`${failures.length} failure(s)`);
	process.exit(1);
}
console.log("deck-splat-lab-check: PASS");
