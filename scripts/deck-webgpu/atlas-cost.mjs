#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WAG W2.2 measure-first: what a TextureArrayAtlas (HeightPool + ImageryArray, uv-window ancestor
// fallback instead of the CPU ancestorCrop) could save, in the live app (/photo/<id>?renderer=webgpu).
// Reads globalThis.__atlasProbe, a per-stage {n, ms, bytes, max} accumulator that only exists with
// the measurement probe applied (out-of-tree patch atlas-probe.patch: timers around ancestorCrop,
// decode, validate and downsample2 in dem/load.ts + deck/terrain-stream.ts, HeightPool write /
// reserve and TileStore.sync in layers/batched-terrain.ts, ImageryArray grow / resize /
// copyExternalImage / mips in deck-webgpu/imagery.ts). Without the probe it prints only the
// engine's own stats (terrain uploadMs, imagery stats) and the frame-gap figures.
// Phases per photo: load (to data-ready + tile set quiet), pan (yaw +30, +60, +90, -60, pitch -10,
// zoom-out 1.6, each to quiet), world (mode world, imagery drape, to quiet). Frame gaps: rAF
// intervals over each phase (max, count > 50 ms) and long tasks (PerformanceObserver).
// Run (own dev server, render lock):
//   npx vite dev --port 3131 --strictPort &
//   node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/atlas-cost.mjs \
//     --url http://localhost:3131 --photos IMG_7086,IMG_6958,IMG_3304
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "./gpu-args.mjs";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", process.env.APP_URL ?? "http://localhost:3131");
const IDS = arg("photos", "IMG_7086,IMG_6958,IMG_3304").split(",");
const OUT = resolve(arg("out", "out/deck-webgpu/atlas-cost"));
mkdirSync(OUT, { recursive: true });

const INIT = () => {
	const w = window;
	w.__frames = { gaps: [], long: [] };
	let last = 0;
	const tick = (t) => {
		if (last) w.__frames.gaps.push(t - last);
		last = t;
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	try {
		new PerformanceObserver((l) => {
			for (const e of l.getEntries()) w.__frames.long.push(e.duration);
		}).observe({ type: "longtask", buffered: true });
	} catch {}
};

const INSTALL = () => {
	const w = window;
	const e = w.__engine;
	w.__ac = {
		quiet: async () => {
			let last = null;
			let since = performance.now();
			const t0 = performance.now();
			while (performance.now() - t0 < 60_000) {
				await e.nextFrame("all");
				const set = e.renderSet;
				const im = e.gpu?.imagery?.stats;
				const key = `${set?.tiles?.length}|${set?.stats?.pending ?? 0}|${e.gpu?.terrain?.stats?.tiles}|${im?.uploads}`;
				if (key !== last || (set?.stats?.pending ?? 0) > 0) {
					last = key;
					since = performance.now();
				} else if (performance.now() - since > 1500) return true;
				await new Promise((r) => setTimeout(r, 100));
			}
			return false;
		},
		snap: () => {
			const probe = JSON.parse(JSON.stringify(w.__atlasProbe ?? {}));
			const f = w.__frames;
			const gaps = f.gaps;
			const out = {
				probe,
				terrainUploadMs: e.gpu?.terrain?.stats?.uploadMs ?? null,
				terrainTiles: e.gpu?.terrain?.stats?.tiles ?? null,
				imagery: e.gpu?.imagery?.stats ? { ...e.gpu.imagery.stats } : null,
				setStats: e.renderSet?.stats
					? JSON.parse(JSON.stringify(e.renderSet.stats))
					: null,
				frames: {
					n: gaps.length,
					maxGapMs: gaps.length ? Math.max(...gaps) : 0,
					over50: gaps.filter((g) => g > 50).length,
					longTasks: f.long.length,
					longMaxMs: f.long.length ? Math.max(...f.long) : 0,
				},
			};
			return out;
		},
		reset: () => {
			for (const k of Object.keys(w.__atlasProbe ?? {}))
				delete w.__atlasProbe[k];
			w.__frames.gaps = [];
			w.__frames.long = [];
			if (e.gpu?.terrain?.stats) e.gpu.terrain.stats.uploadMs = 0;
		},
	};
};

const PAN = [
	{ yaw: 30 },
	{ yaw: 60 },
	{ yaw: 90 },
	{ yaw: -60 },
	{ pitch: -10 },
	{ vfovScale: 1.6 },
];

async function runPhoto(browser, id) {
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.addInitScript(() => {
		try {
			localStorage.clear();
		} catch {}
	});
	await page.addInitScript(INIT);
	const t0 = Date.now();
	await page.goto(`${BASE}/photo/${id}?renderer=webgpu`);
	await page.waitForSelector("[data-ready]", {
		timeout: 240_000,
		state: "attached",
	});
	const engine = await page.evaluate(() => ({
		backend: window.__engine?.backend,
		terrain: window.__engine?.gpu?.terrain?.constructor?.name,
	}));
	await page.evaluate(INSTALL);
	const r = { id, engine, errors, phases: {} };
	r.loadQuiet = await page.evaluate(() => window.__ac.quiet());
	r.loadWallMs = Date.now() - t0;
	r.phases.load = await page.evaluate(() => window.__ac.snap());
	await page.evaluate(() => window.__ac.reset());
	const p0 = await page.evaluate(() => ({ ...window.__engine.pose }));
	for (const d of PAN) {
		await page.evaluate(
			({ p0, d }) =>
				window.__engine.setPose({
					...p0,
					yaw: p0.yaw + (d.yaw ?? 0),
					pitch: p0.pitch + (d.pitch ?? 0),
					vfov: p0.vfov * (d.vfovScale ?? 1),
				}),
			{ p0, d },
		);
		await page.evaluate(() => window.__ac.quiet());
	}
	r.phases.pan = await page.evaluate(() => window.__ac.snap());
	r.phases.pan.steps = PAN.length;
	await page.evaluate(() => window.__ac.reset());
	await page.evaluate((p0) => window.__engine.setPose(p0), p0);
	await page.evaluate(() => window.__engine.setSettings({ mode: "world" }));
	await page.evaluate(() => window.__ac.quiet());
	r.phases.world = await page.evaluate(() => window.__ac.snap());
	await page.close();
	return r;
}

const fmt = (e) =>
	e
		? `${e.ms.toFixed(1)} ms / n ${e.n} / ${(e.bytes / 2 ** 20).toFixed(1)} MiB (max ${e.max.toFixed(1)})`
		: "-";

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const results = [];
try {
	for (const id of IDS) {
		const r = await runPhoto(browser, id);
		results.push(r);
		console.log(
			`\n${id} ${JSON.stringify(r.engine)} load wall ${r.loadWallMs} ms quiet=${r.loadQuiet}`,
		);
		for (const [name, p] of Object.entries(r.phases)) {
			console.log(
				`  ${name}: tiles ${p.terrainTiles} fallbacks ${p.setStats?.fallbacks} terrain.uploadMs ${p.terrainUploadMs?.toFixed?.(1)} imagery ${JSON.stringify(p.imagery)} frames ${JSON.stringify(p.frames)}`,
			);
			for (const [k, v] of Object.entries(p.probe))
				console.log(`    ${k.padEnd(24)} ${fmt(v)}`);
		}
		if (r.errors.length)
			console.log(`  errors: ${r.errors.slice(0, 3).join(" | ")}`);
	}
} finally {
	await browser.close();
}
writeFileSync(resolve(OUT, "result.json"), JSON.stringify(results, null, 2));
console.log(`\n${resolve(OUT, "result.json")}`);
