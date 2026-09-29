#!/usr/bin/env node
// W5 parity / speed bench for the look passes on the GPU (src/lib/gpu/look/**). For each photo it
// opens /photo/<id> in headless Chromium with WebGPU, captures the real look-pass inputs from
// window.__engine (the three.js engine at the ground-truth pose), then runs every GPU twin against
// its CPU function (src/lib/gpu/look/bench.ts) and prints max / p99 / mean abs error and ms.
// Always run it under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/look-bench.mjs [--photos IMG_7086,IMG_6958]
//     [--url http://localhost:3110] [--reps 5] [--settings JSON] [--module /src/…] [--fn name]
// --settings (default {"mode":"replace","mapStyle":"hillshade"}) is pushed to the engine before the
// capture, so the band-stats layer is a fully covering map layer (the case LOOK_HARMONIZE serves).
// Writes out/gpu/w5/look-bench.json (small).
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
const PHOTOS = arg("photos", "IMG_7086,IMG_6958").split(",");
const REPS = Number(arg("reps", "5"));
const MOD = arg("module", "/src/lib/gpu/look/bench.ts");
const FN = arg("fn", "runLookBench");
// extra page query, e.g. "lookgpu=1&style=swiss&renderer=deck" (lookSmoke checks the hooks)
const QUERY = arg("query", "");
const TAG = arg("tag", "");
const SETTINGS = JSON.parse(
	arg("settings", '{"mode":"replace","mapStyle":"hillshade"}'),
);
const OUT = join(ROOT, "out/gpu/w5");

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
	console.log(`[look-bench ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);

async function runOne(browser, id) {
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
		// no HMR: other sessions edit the tree; a hot update mid-run would remount the workspace
		await ctx.routeWebSocket(
			(u) => u.origin === new URL(URL0).origin.replace(/^http/, "ws"),
			() => {},
		);
		const page = await ctx.newPage();
		page.on("pageerror", (e) => log(`[${id}] pageerror ${e.message}`));
		page.on("console", (m) => {
			const t = m.text();
			if (/lookgpu|\[gpu\]|WebGPU|wgsl|error/i.test(t) && !/favicon/.test(t))
				log(`[${id}] console.${m.type()} ${t.slice(0, 400)}`);
		});
		await page.goto(`${URL0}/photo/${id}${QUERY ? `?${QUERY}` : ""}`, {
			waitUntil: "load",
			timeout: 120000,
		});
		await page.waitForSelector("[data-ready]", {
			state: "attached",
			timeout: 300000,
		});
		await page.waitForFunction(
			() => {
				const e = window.__engine;
				return (
					e?.geometryReady?.() && e.photoElement && e.terrain?.tiles?.length > 0
				);
			},
			null,
			{ timeout: 180000, polling: 500 },
		);
		await page.evaluate((s) => window.__engine.setSettings(s), SETTINGS);
		// let tiles, the sky mask and the new layer settle
		await page.waitForTimeout(5000);
		return await page.evaluate(
			async ([mod, fn, reps, label]) => {
				const m = await import(mod);
				return m[fn](window.__engine, { reps, label });
			},
			[MOD, FN, REPS, id],
		);
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
	for (const id of PHOTOS) {
		log(`${id}: start`);
		try {
			results[id] = await runOne(browser, id);
		} catch (e) {
			results[id] = { error: String(e?.message ?? e) };
		}
		console.log(JSON.stringify(results[id], null, 1));
	}
} finally {
	await browser.close();
}
mkdirSync(OUT, { recursive: true });
const name = `${FN === "runLookBench" ? "look-bench" : FN}${TAG ? `-${TAG}` : ""}.json`;
writeFileSync(join(OUT, name), JSON.stringify(results, null, 1));
log(`wrote out/gpu/w5/${name}`);
