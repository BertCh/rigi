#!/usr/bin/env node
// Smoke for the WebGPU engine lab (/lab/deck-webgpu, default mode = WebGpuEngine with every ported
// layer): loads the photo, waits for body[data-ready], then screenshots the photo view (overlay,
// replace) and the world view, checks labels / queries, and reports page + WebGPU errors.
//   node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/engine-lab.mjs [IMG_7086] [--host deck|direct] [--query k=v&…]
// Env APP_URL (default http://localhost:3111). Output: out/deck-webgpu/engine-lab-<id>-<host>.{json,png}
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "./gpu-args.mjs";

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : "");
const hostArg = opt("--host");
const extra = opt("--query");
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
const errors = [];
try {
	const page = await browser.newPage({
		viewport: { width: 1280, height: 860 },
	});
	page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
	page.on("console", (m) => {
		const t = m.text();
		if (
			m.type() === "error" ||
			(m.type() === "warning" && /WebGPU|luma|webgpu-engine/.test(t))
		)
			if (!/Module \w+ not found|Failed to load resource/.test(t))
				errors.push(`${m.type()}: ${t.slice(0, 600)}`);
	});
	const q = new URLSearchParams({ photo: id });
	if (hostArg) q.set("host", hostArg);
	for (const [k, v] of new URLSearchParams(extra)) q.set(k, v);
	const tag = [id, hostArg || "auto"].join("-");
	const t0 = Date.now();
	await page.goto(`${URL0}/lab/deck-webgpu?${q}`);
	// settles on ready OR on the lab's error (unavailable WebGPU, failed init): only ready counts
	await page
		.waitForFunction(
			() => document.body.dataset.ready || window.__deckWebgpuLab?.error,
			null,
			{ timeout: 240_000 },
		)
		.catch(() => {});
	const state = await page.evaluate(() => ({
		ready: document.body.dataset.ready === "1",
		error: window.__deckWebgpuLab?.error ?? null,
	}));
	const ready = state.ready && !state.error;
	const result = { id, ready, loadMs: Date.now() - t0 };
	if (state.error) {
		result.labError = state.error;
		errors.push(`lab error: ${state.error}`);
	}
	if (ready) {
		await page.waitForTimeout(4000); // imagery / horizon settle
		const shot = async (name) => {
			await page.evaluate(() => window.__engine.nextFrame());
			await page.waitForTimeout(300);
			await page.screenshot({ path: `${OUT}/engine-lab-${tag}-${name}.png` });
		};
		result.stats = await page.evaluate(() => window.__deckWebgpuLab.stats());
		result.labels = await page.evaluate(() =>
			window.__engine.peakLabels().map((l) => l.name),
		);
		result.skylineCols = await page.evaluate(
			() => window.__engine.skyline()?.length ?? 0,
		);
		await shot("overlay");
		await page.evaluate(() =>
			window.__deckWebgpuLab.setSettings({
				mode: "replace",
				mapStyle: "satellite",
			}),
		);
		await page.waitForTimeout(2500);
		await shot("replace");
		await page.evaluate(() =>
			window.__deckWebgpuLab.setSettings({ mode: "world" }),
		);
		await page.waitForTimeout(4000);
		await shot("world");
		// orbit drag
		const box = await page.locator("canvas").boundingBox();
		const cx = box.x + box.width / 2;
		const cy = box.y + box.height / 2;
		await page.mouse.move(cx, cy);
		await page.mouse.down();
		for (let i = 0; i < 30; i++) await page.mouse.move(cx + i * 8, cy + i);
		await page.mouse.up();
		await page.waitForTimeout(1500);
		await shot("world-orbit");
		result.world = await page.evaluate(() => window.__engine.stats);
		await page.evaluate(() =>
			window.__deckWebgpuLab.setSettings({ mode: "overlay" }),
		);
		await page.waitForTimeout(800);
		result.backToPhoto = await page.evaluate(() => window.__engine.stats.view);
		if (!result.labels.length || !result.skylineCols) failed = true;
	} else failed = true;
	result.errors = errors.slice(0, 30);
	if (errors.length) failed = true;
	writeFileSync(
		`${OUT}/engine-lab-${tag}.json`,
		JSON.stringify(result, null, 2),
	);
	console.log(JSON.stringify({ ...result, stats: undefined }, null, 2));
} finally {
	await browser.close();
}
process.exit(failed ? 1 : 0);
