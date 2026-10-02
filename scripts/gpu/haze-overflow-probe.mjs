#!/usr/bin/env node

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
// How often does the GPU haze fit's first read ("head") overflow, forcing a second tail read?
// Counted from the outside: src/lib/gpu/look/haze-graph.ts publishes hazeGraphStats {head,total,tail,
// cacheHit}; this probe imports that module in the running app page (same module instance as the app's)
// and replaces the stats object's properties with recording accessors, so no src change is needed.
// Two parts:
//   observed   per photo (fresh page, so the device's adaptive fraction starts empty): every haze fit
//              the app runs while the photo opens and while the yaw is nudged to force more settles
//   simulated  from the observed total/N of each photo, the head the adaptive rule (headFor:
//              1.5·fraction·N + 1024, first run 0.27·N + 512) would give for every ordered photo
//              switch on one device, and whether it overflows; N is the first fit's own N (head/total
//              are in list slots, N = pixels of the fit's input, recovered from the first-run head)
// Always under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/haze-overflow-probe.mjs [--url http://localhost:3100]
//     [--renderer webgpu] [--nudges 6] [--out out/baseline/haze-overflow.json] [IMG_7086 …]  (no ids = 19 ground-truth photos)
import { APP_URL } from "../lib/harness.mjs";
import { launch, makeArg, openPhoto, photoIds } from "./probe-common.mjs";

const arg = makeArg();
const BASE = arg("url", APP_URL);
const RENDERER = arg("renderer", "webgpu");
const NUDGES = Number(arg("nudges", "6"));
const OUT = arg("out", "out/baseline/haze-overflow.json");
const ids = photoIds();

const browser = await launch();
const rows = [];
for (const id of ids) {
	const ctx = await browser.newContext({
		viewport: { width: 1400, height: 900 },
	});
	// Record from the very first fit: the page is served haze-graph.ts with a recorder appended (a
	// Playwright route; the repo file is untouched). It wraps hazeGraphStats' four properties in
	// accessors; cacheHit is assigned last in both of the module's Object.assign calls.
	await ctx.route(/\/src\/lib\/gpu\/look\/haze-graph\.ts/, async (route) => {
		const resp = await route.fetch();
		const body = await resp.text();
		await route.fulfill({
			response: resp,
			body: `${body}
;(() => { const o = hazeGraphStats; globalThis.__hz = []; for (const k of ["head","total","tail","cacheHit"]) { let v = o[k];
 Object.defineProperty(o, k, { configurable: true, enumerable: true, get: () => v, set: (x) => { v = x;
 if (k === "cacheHit") globalThis.__hz.push({ head: o.head, total: o.total, tail: o.tail, cacheHit: x, t: performance.now() }); } }); } })();
`,
		});
	});
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.addInitScript(() => {
		localStorage.clear();
	});
	const o = await openPhoto(page, BASE, id, RENDERER);
	// the haze fit only runs when the style's atmosphere is physical + fitted airlight (preset
	// photo-matched), in a look that draws it: switch to that, then nudge the pose to refit
	await page.evaluate(async () => {
		const { presetStyle } = await import("/src/lib/style/presets.ts");
		window.__engine.setStyle(presetStyle("photo-matched")); // airlight "fitted"
		window.__engine.setSettings({ mode: "replace", mapStyle: "satellite" });
		await window.__engine.readback();
	});
	await page.waitForTimeout(4000);
	await page.evaluate(async (n) => {
		const e = window.__engine;
		const p0 = e.pose;
		for (let i = 1; i <= n; i++) {
			e.setPose({ ...p0, yaw: p0.yaw + 0.4 * (i % 2 ? 1 : -1) * i });
			await new Promise((r) => setTimeout(r, 1500));
		}
		e.setPose(p0);
		await new Promise((r) => setTimeout(r, 1500));
	}, NUDGES);
	const fits = (await page.evaluate(() => window.__hz)) ?? [];
	rows.push({ id, ...o, errors, fits });
	console.log(
		id,
		`fits seen ${fits.length}`,
		fits.map((f) => `${f.total}/${f.head}${f.tail ? "!" : ""}`).join(" "),
	);
	await ctx.close();
}
await browser.close();

// per photo: N recovered from the first fit's head (first-run rule head = ceil(0.27 N) + 512; the
// accessor sees the fit's own N only through it) and the median total of its fits
const per = rows
	.filter((r) => r.fits.length)
	.map((r) => ({
		id: r.id,
		N: Math.round((r.fits[0].head - 512) / 0.27),
		firstHead: r.fits[0].head,
		firstTotal: r.fits[0].total,
		firstTail: r.fits[0].tail,
		total: r.fits.at(-1).total,
	}));
const fitsFlat = rows.flatMap((r) => r.fits.map((f) => ({ id: r.id, ...f })));
const observedOverflow = fitsFlat.filter((f) => f.tail).length;
// every ordered switch a -> b on one device: head = min(3N, ceil(1.5 (totalA / NA) NB) + 1024)
const sim = [];
for (const a of per)
	for (const b of per) {
		if (a.id === b.id) continue;
		const head = Math.min(
			3 * b.N,
			Math.ceil(1.5 * (a.total / a.N) * b.N) + 1024,
		);
		sim.push({
			from: a.id,
			to: b.id,
			head,
			total: b.total,
			overflow: b.total > head,
		});
	}
const summary = {
	photos: rows.length,
	photosWithFits: per.length,
	fitsObserved: fitsFlat.length,
	observedOverflows: observedOverflow,
	observedOverflowRate: fitsFlat.length
		? observedOverflow / fitsFlat.length
		: null,
	simulatedSwitches: sim.length,
	simulatedOverflows: sim.filter((x) => x.overflow).length,
	simulatedOverflowRate: sim.length
		? sim.filter((x) => x.overflow).length / sim.length
		: null,
	totalFractionRange: per.length
		? [
				Math.min(...per.map((p) => p.total / p.N)),
				Math.max(...per.map((p) => p.total / p.N)),
			]
		: null,
};
console.log(JSON.stringify(summary));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
	OUT,
	JSON.stringify(
		{ url: BASE, renderer: RENDERER, summary, per, rows, sim },
		null,
		1,
	),
);
console.log(`wrote ${OUT}`);
