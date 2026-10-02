#!/usr/bin/env node

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
// Imagery-array VRAM on the WebGPU engine (deck-webgpu/imagery.ts). Per photo, one fresh page
// (/photo/<id>?renderer=webgpu): luma "GPU Memory" and the imagery / height atlas stats at
//   1. the photo view (ready + settle),
//   2. the matcher's drape (loadFullTerrain → loadSatellite(--drape-m) → renderPoseView(prior)),
//   3. back to the photo look after --idle ms (an atlas that compacts on idle shows it here),
// and, on a second fresh page, 4. world mode with its imagery drape, then 5. the photo view again
// after --idle ms. The source bitmap sizes of the drape (256 / 512 / 1024 px) are histogrammed.
// Always under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/imagery-vram-probe.mjs \
//     [--url http://localhost:3100] [--drape-m 40000] [--idle 14000] [--out out/vram/imagery.json] \
//     [IMG_7155 IMG_6958 IMG_7018]
import { APP_URL } from "../lib/harness.mjs";
import { launch, makeArg, openPhoto } from "./probe-common.mjs";

const arg = makeArg();
const BASE = arg("url", APP_URL);
const DRAPE_M = Number(arg("drape-m", "40000"));
const IDLE = Number(arg("idle", "14000"));
const OUT = arg("out", "out/vram/imagery.json");
const given = process.argv.filter(
	(a, i) => a.startsWith("IMG_") && !process.argv[i - 1]?.startsWith("--"),
);
const ids = given.length ? given : ["IMG_7155", "IMG_6958", "IMG_7018"];

const SNAP = () => {
	const e = window.__engine;
	const m = e?.metrics?.();
	const mem = m?.luma?.memory?.["GPU Memory"];
	const a = (x) => (x?.stats ? { ...x.stats, capacity: x.capacity } : null);
	const im = e?.gpu?.imagery;
	const sizes = {};
	for (const b of e?.imagery?.map?.values?.() ?? [])
		sizes[b.width] = (sizes[b.width] ?? 0) + 1;
	return JSON.parse(
		JSON.stringify({
			gpuMemoryMiB: (mem?.count ?? mem?.value ?? 0) / 2 ** 20,
			imagery: m?.imagery ?? null,
			imageryAtlases: im?.atlases
				? Object.fromEntries(
						Object.entries(im.atlases).map(([k, v]) => [k, a(v)]),
					)
				: { 512: a(im?.atlas) },
			heights: {
				small: a(e?.gpu?.terrain?.store?.small),
				big: a(e?.gpu?.terrain?.store?.big),
			},
			bitmapSizes: sizes,
			tiles: e?.gpu?.terrain?.stats?.tiles ?? null,
		}),
	);
};

const settle = (page, ms) => page.waitForTimeout(ms);

async function photoArm(browser, id) {
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
	await openPhoto(page, BASE, id, "webgpu");
	await settle(page, 2000);
	const photo = await page.evaluate(SNAP);
	await page.evaluate(
		async ({ drapeM }) => {
			const e = window.__engine;
			await e.loadFullTerrain();
			await e.loadSatellite(drapeM, 2);
			await e.renderPoseView({ ...e.prior });
		},
		{ drapeM: DRAPE_M },
	);
	const drape = await page.evaluate(SNAP);
	await page.evaluate(() => {
		const e = window.__engine;
		e.setPose({ ...e.pose });
	});
	await settle(page, IDLE);
	const drapeIdle = await page.evaluate(SNAP);
	await page.close();
	return { photo, drape, drapeIdle, errors };
}

async function worldArm(browser, id) {
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
	await openPhoto(page, BASE, id, "webgpu");
	await page.evaluate(() => window.__engine.setSettings({ mode: "world" }));
	// world mode streams its own tiles + imagery: wait until the imagery stops changing
	let last = -1;
	for (let i = 0; i < 60; i++) {
		await settle(page, 1000);
		const n = await page.evaluate(
			() => window.__engine?.gpu?.imagery?.stats?.uploads ?? 0,
		);
		if (n === last) break;
		last = n;
	}
	const world = await page.evaluate(SNAP);
	await page.evaluate(() => window.__engine.setSettings({ mode: "photo" }));
	await settle(page, IDLE);
	const worldBack = await page.evaluate(SNAP);
	await page.close();
	return { world, worldBack, errors };
}

const browser = await launch();
const rows = [];
try {
	for (const id of ids) {
		const r = {
			id,
			...(await photoArm(browser, id)),
			...(await worldArm(browser, id)),
		};
		rows.push(r);
		const f = (s) => s.gpuMemoryMiB.toFixed(0);
		console.log(
			`${id} MiB photo ${f(r.photo)} drape ${f(r.drape)} drape+idle ${f(r.drapeIdle)} world ${f(r.world)} world→photo+idle ${f(r.worldBack)} | drape sizes ${JSON.stringify(r.drape.bitmapSizes)} imagery ${JSON.stringify(r.drape.imageryAtlases)} | world sizes ${JSON.stringify(r.world.bitmapSizes)} ${JSON.stringify(r.world.imageryAtlases)}${r.errors.length ? ` | errors ${r.errors.slice(0, 2).join("; ")}` : ""}`,
		);
	}
} finally {
	await browser.close();
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(rows, null, 1));
console.log(OUT);
