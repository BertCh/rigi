#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Parity / speed bench of the texture-input look passes (src/lib/gpu/look/textures.ts) against the
// array path: for each photo it opens /photo/<id> in headless Chromium with WebGPU, captures the
// real look inputs from window.__engine (WebGL deck, ground-truth pose; no band-stats input on deck), re-creates the engine's
// targets as textures on the compute device and runs runTexturesBench (textures-bench.ts): masks,
// band stats and haze prep, bit-exact checks and ms. Always run it under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/textures-bench.mjs [--photos IMG_7086,IMG_6958]
//     [--url http://localhost:3110] [--reps 5] [--settings JSON] [--query …] [--tag …]
// Writes out/gpu/core/textures-bench[-tag].json (small). Exit code 1 if any pass is not exact.
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
const MOD = "/src/lib/gpu/look/textures-bench.ts";
const FN = "runTexturesBench";
// extra page query, e.g. "lookgpu=1&style=swiss&renderer=deck" (lookSmoke checks the hooks)
// renderer=deck (WebGL) unless the query names one (webgpu / auto work too: captureLookInputs reads either deck engine)
const QUERY_ARG = arg("query", "");
const QUERY = /(^|&)renderer=/.test(QUERY_ARG)
	? QUERY_ARG
	: ["renderer=deck", QUERY_ARG].filter(Boolean).join("&");
const TAG = arg("tag", "");
const SETTINGS = JSON.parse(
	arg("settings", '{"mode":"replace","mapStyle":"hillshade"}'),
);
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
		`[textures-bench ${((Date.now() - t0) / 1000).toFixed(1)}s]`,
		...m,
	);

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
				[`rigi.pose.${id}`, JSON.stringify(pose)],
			);
		// no HMR: the tree is edited concurrently; a hot update mid-run would remount the workspace
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
		await page.goto(`${URL0}/photo/${id}?${QUERY}`, {
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
const name = `textures-bench${TAG ? `-${TAG}` : ""}.json`;
writeFileSync(join(OUT, name), JSON.stringify(results, null, 1));
log(`wrote out/gpu/core/${name}`);
const bad = Object.entries(results).filter(
	([, r]) =>
		r.error ||
		(r.masks && !r.masks.exact) ||
		(r.stats && !(r.stats.subgroups.exact && r.stats.plain.exact)) ||
		(r.haze && !r.haze.exact) ||
		(r.variants?.masks && !r.variants.masks.exact) ||
		(r.variants?.haze && !r.variants.haze.exact) ||
		(r.adopted &&
			!(r.adopted.returned && r.adopted.exact && r.adopted.afterDestroy)),
);
for (const [id] of bad) log(`${id}: NOT EXACT`);
process.exitCode = bad.length ? 1 : 0;
