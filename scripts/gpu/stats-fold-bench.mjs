#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Band-stats fold bench (src/lib/gpu/look/stats-fold-bench.ts): per photo and engine, the ColorStats
// and composite deltas of the GPU fold (f32, GPUProgram) and the subgroup reduction against the f64
// CPU fold, plus ms per call. renderer=deck runs the ARRAY path (the engine's captured setStats input),
// renderer=webgpu the TEXTURE path (bandStatsTex on the engine's stats layer). Ground-truth pose, the
// photo-matched look (harmonize on), replace mode over satellite. Always under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/stats-fold-bench.mjs
//     [--photos IMG_7086,…] (default: the 19 control-point photos) [--renderers deck,webgpu]
//     [--url http://localhost:3110] [--reps 10] [--long 1024] [--preset photo-matched] [--tag …]
// Writes out/gpu/core/stats-fold-bench[-tag].json. Exit code 1 on an error, a valid / count mismatch,
// or a GPU-fold composite byte delta > 1.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i >= 0 ? process.argv[i + 1] : d;
};
const URL0 = arg("url", process.env.APP_URL ?? "http://localhost:3110");
const cps = JSON.parse(
	readFileSync(join(ROOT, "data/control-points.json"), "utf8"),
);
const PHOTOS = arg("photos", Object.keys(cps).join(",")).split(",");
const RENDERERS = arg("renderers", "deck,webgpu").split(",");
const REPS = Number(arg("reps", "10"));
const LONG = Number(arg("long", "1024"));
const PRESET = arg("preset", "photo-matched");
const TAG = arg("tag", "");
const OUT = join(ROOT, "out/gpu/core");

const gt = JSON.parse(
	readFileSync(join(ROOT, "data/ground-truth.json"), "utf8"),
);
function fixedPose(id) {
	const g = gt[id];
	if (!g) return null;
	const vfov = (2 * Math.atan(g.height / (2 * g.f)) * 180) / Math.PI;
	return { yaw: g.yaw, pitch: g.pitch, roll: g.roll, vfov };
}

const t0 = Date.now();
const log = (...m) =>
	console.log(
		`[stats-fold-bench ${((Date.now() - t0) / 1000).toFixed(1)}s]`,
		...m,
	);

async function runOne(browser, id, renderer) {
	const ctx = await browser.newContext({
		viewport: { width: 1000, height: 700 },
		deviceScaleFactor: 1,
	});
	try {
		const pose = fixedPose(id);
		if (pose)
			await ctx.addInitScript(
				([k, v]) => {
					try {
						localStorage.setItem(k, v);
					} catch {}
				},
				[`mt-image:pose:${id}`, JSON.stringify(pose)],
			);
		await ctx.routeWebSocket(
			(u) => u.origin === new URL(URL0).origin.replace(/^http/, "ws"),
			() => {},
		);
		const page = await ctx.newPage();
		page.on("pageerror", (e) => log(`[${id}] pageerror ${e.message}`));
		page.on("console", (m) => {
			const t = m.text();
			if (
				/lookgpu|\[gpu\]|wgsl|band stats|error/i.test(t) &&
				!/favicon/.test(t)
			)
				log(`[${id}/${renderer}] console.${m.type()} ${t.slice(0, 400)}`);
		});
		await page.goto(`${URL0}/photo/${id}?renderer=${renderer}`, {
			waitUntil: "load",
			timeout: 120000,
		});
		await page.waitForSelector("[data-ready]", {
			state: "attached",
			timeout: 300000,
		});
		const engine = await page.evaluate(() =>
			document.querySelector("[data-renderer]")?.getAttribute("data-renderer"),
		);
		await page.waitForFunction(
			() => {
				const e = window.__engine;
				return e?.geometryReady?.() && e.terrain?.tiles?.length > 0;
			},
			null,
			{ timeout: 180000, polling: 500 },
		);
		await page.evaluate(async (preset) => {
			const e = window.__engine;
			const { presetStyle } = await import("/src/lib/style/presets.ts");
			e.setSettings({ mode: "replace", mapStyle: "satellite" });
			e.setStyle(presetStyle(preset));
		}, PRESET);
		await page.waitForTimeout(6000);
		await page.evaluate(async () => {
			const { lookIdle } = await import("/src/lib/gpu/look/opt-in.ts");
			await lookIdle();
		});
		const r = await page.evaluate(
			async ([reps, long]) => {
				const m = await import("/src/lib/gpu/look/stats-fold-bench.ts");
				return m.runStatsFoldBench(window.__engine, { reps, long });
			},
			[REPS, LONG],
		);
		return { dataRenderer: engine, ...r };
	} finally {
		await ctx.close();
	}
}

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const results = {};
try {
	for (const id of PHOTOS)
		for (const renderer of RENDERERS) {
			const k = `${id}/${renderer}`;
			log(`${k}: start`);
			try {
				results[k] = await runOne(browser, id, renderer);
			} catch (e) {
				results[k] = { error: String(e?.message ?? e).slice(0, 500) };
			}
			const r = results[k];
			if (r.error) log(`${k}: ERROR ${r.error}`);
			else
				log(
					`${k}: valid ${r.valid} | stats max|Δ| ${Object.entries(r.stats)
						.map(([n, d]) => `${n} ${d.max.toExponential(1)}`)
						.join(", ")} | composite max ${Object.entries(r.composite)
						.map(
							([n, d]) =>
								`${n} ${d.max}/${d.differ}${d.drift?.differ ? ` (drift ${d.drift.max}/${d.drift.differ})` : ""}`,
						)
						.join(", ")} | ms ${Object.entries(r.ms)
						.map(([n, v]) => `${n} ${v.toFixed(2)}`)
						.join(", ")}`,
				);
		}
} finally {
	await browser.close();
}
mkdirSync(OUT, { recursive: true });
const name = `stats-fold-bench${TAG ? `-${TAG}` : ""}.json`;
writeFileSync(
	join(OUT, name),
	JSON.stringify({ at: new Date().toISOString(), results }, null, 1),
);
log(`wrote out/gpu/core/${name}`);
const bad = Object.entries(results).filter(
	([, r]) =>
		r.error ||
		Object.entries(r.stats).some(
			([n, d]) => n !== "cpu" && (!d.valid || !d.count),
		) ||
		Object.entries(r.composite).some(
			([n, d]) => n.startsWith("gpu") && d.max > 1,
		),
);
for (const [k] of bad) log(`${k}: FAIL`);
process.exitCode = bad.length ? 1 : 0;
