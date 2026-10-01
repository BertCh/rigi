#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Smoke test for the WebGPU renderer foundation: loads /lab/deck-webgpu?core=1&photo=<id> under real-GPU
// Chromium flags, waits for the first terrain set, and reports first-frame time, steady frame
// times, geometry-target sanity (CPU re-projection of the read-back ENU points) and page errors.
// Screenshots (colour + geometry views) and JSON → out/deck-webgpu/smoke-<id>-<host>.*
//
//   node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/smoke.mjs [IMG_7086] [--host deck|direct] [--query plugin=footprint]
// Env: APP_URL (default http://localhost:3111, the full-deck-build server:
//   npx vite dev --config scripts/deck-webgpu/vite.webgpu.config.ts --port 3111).
// On the app's own server (:3110, deck webgl-only) the lab falls back to the direct host.
// Exit code 1 when the page errored, never became ready, or the geometry check failed.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "./gpu-args.mjs";

const args = process.argv.slice(2);
const hostArg = args.includes("--host") ? args[args.indexOf("--host") + 1] : "";
const extra = args.includes("--query") ? args[args.indexOf("--query") + 1] : "";
const id =
	args.find(
		(a, i) =>
			!a.startsWith("--") && !["--host", "--query"].includes(args[i - 1]),
	) ?? "IMG_7086";
const URL0 = process.env.APP_URL ?? "http://localhost:3111";
const OUT = resolve(import.meta.dirname, "../../out/deck-webgpu");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: GPU_ARGS });
let failed = false;
try {
	const page = await browser.newPage({
		viewport: { width: 1280, height: 800 },
	});
	const errors = [];
	page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
	page.on("console", (m) => {
		const t = m.text();
		if (
			m.type() === "error" ||
			(m.type() === "warning" && /WebGPU|luma/.test(t))
		)
			if (!/Module \w+ not found/.test(t))
				errors.push(`${m.type()}: ${t.slice(0, 500)}`);
	});
	const q = new URLSearchParams({ photo: id, core: "1" });
	if (hostArg) q.set("host", hostArg);
	for (const [k, v] of new URLSearchParams(extra)) q.set(k, v);
	const tag = [
		id,
		hostArg || "auto",
		...new URLSearchParams(extra).values(),
	].join("-");
	const t0 = Date.now();
	await page.goto(`${URL0}/lab/deck-webgpu?${q}`);
	const ready = await page
		.waitForFunction(
			() => window.__deckWebgpuLab?.ready || window.__deckWebgpuLab?.error,
			null,
			{
				timeout: 180_000,
			},
		)
		.then(() => true)
		.catch(() => false);
	const loadMs = Date.now() - t0;
	let result = { id, query: extra, ready, loadMs };
	if (ready) {
		const hook = await page.evaluate(() => ({
			host: window.__deckWebgpuLab.host,
			error: window.__deckWebgpuLab.error ?? null,
		}));
		result = { ...result, ...hook };
		if (!hook.error) {
			// let the imagery stream in (up to 20 s, until uploads stop growing)
			let last = -1;
			for (let i = 0; i < 20; i++) {
				await page.waitForTimeout(1000);
				const up = await page.evaluate(
					() => window.__deckWebgpuLab.stats().imagery?.uploads ?? 0,
				);
				if (up === last) break;
				last = up;
			}
			const frames = [];
			for (let i = 0; i < 20; i++)
				frames.push(await page.evaluate(() => window.__deckWebgpuLab.frame()));
			const screenFrames = [];
			for (let i = 0; i < 20; i++)
				screenFrames.push(
					await page.evaluate(() => window.__deckWebgpuLab.frame("screen")),
				);
			const sms = screenFrames.map((f) => f.ms).sort((a, b) => a - b);
			const ms = frames.map((f) => f.ms).sort((a, b) => a - b);
			const cpu = frames.map((f) => f.cpuMs).sort((a, b) => a - b);
			const med = (a) => a[Math.floor(a.length / 2)];
			const geometry = await page.evaluate(() =>
				window.__deckWebgpuLab.checkGeometry(),
			);
			const stats = await page.evaluate(() => window.__deckWebgpuLab.stats());
			await page.screenshot({
				path: `${OUT}/smoke-${tag}-color.png`,
			});
			await page.evaluate(() => window.__deckWebgpuLab.setView("geometry"));
			await page.screenshot({
				path: `${OUT}/smoke-${tag}-geometry.png`,
			});
			await page.evaluate(() => window.__deckWebgpuLab.setView("color"));
			// pan: a pose change re-renders both passes
			const t = Date.now();
			await page.evaluate(() =>
				window.__deckWebgpuLab.setPose({
					yaw: window.__deckWebgpuLab.stats().pose.yaw + 20,
				}),
			);
			const panMs = Date.now() - t;
			result = {
				...result,
				firstFrameMs: stats.host_.firstFrameMs,
				firstTerrainSetMs: stats.firstSetMs,
				frameMsMedian: med(ms),
				frameMsP90: ms[Math.floor(ms.length * 0.9)],
				cpuMsMedian: med(cpu),
				screenOnlyFrameMsMedian: med(sms),
				panFrameMs: panMs,
				geometry,
				stats,
			};
			if (!geometry || geometry.maxErrPx > 1.5 || geometry.samples < 100)
				failed = true;
		} else failed = true;
	} else failed = true;
	result.errors = errors.slice(0, 20);
	if (errors.length) failed = true;
	writeFileSync(`${OUT}/smoke-${tag}.json`, JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} finally {
	await browser.close();
}
process.exit(failed ? 1 : 0);
