#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Bake the sample trip's people masks into public/demo/masks/people-masks.bin, so the landing's live
// map (src/components/site/LiveRollMap.tsx) never downloads MediaPipe. Each mask is made exactly as
// the roll map makes it (src/lib/roll/map/roll-map.ts loadPhotos + segmentAll): the full-size photo
// downscaled to 1024 px with createImageBitmap(resizeQuality "high"), then
// src/lib/segment.ts segmentForeground. The file layout is src/lib/demo/people-masks.ts, gzipped.
//
// Then, unless --no-verify, it opens /roll/demo?view=map (the live path, full-size photos) and
// compares the engine's own masks (window.__roll) with the bake, byte for byte.
//
// MediaPipe needs a browser and the dev server (:3100); run under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/demo/bake-people-masks.mjs \
//     [--url http://localhost:3100] [--renderer webgpu|deck] [--no-verify] [--verify-only]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { GPU_ARGS } from "../deck-webgpu/gpu-args.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 ? argv[i + 1] : d;
};
const BASE = arg("url", process.env.APP_URL ?? "http://localhost:3100");
const RENDERER = arg("renderer", "webgpu");
const OUT = "public/demo/masks/people-masks.bin";
const verifyOnly = argv.includes("--verify-only");
const verify = verifyOnly || !argv.includes("--no-verify");

const manifest = JSON.parse(readFileSync("public/demo/manifest.json", "utf8"));
const photos = manifest.photos.map((p) => ({ id: p.id, src: p.src }));

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });

/** id → { width, height, data: base64 } | null, from the page. */
async function bakeInPage() {
	const page = await browser.newPage();
	page.on(
		"console",
		(m) => m.type() === "warning" && console.log("[page]", m.text()),
	);
	// any same-origin document can import the dev server's modules
	await page.goto(`${BASE}/demo/manifest.json`);
	const out = await page.evaluate(async (list) => {
		const { segmentForeground } = await import("/src/lib/segment.ts");
		const { encodePeopleMasks } = await import("/src/lib/demo/people-masks.ts");
		// roll-map.ts scaled(), verbatim
		const scaled = (img, long) => {
			const w = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
			const h =
				img instanceof HTMLImageElement ? img.naturalHeight : img.height;
			const s = Math.min(1, long / Math.max(w, h));
			return createImageBitmap(img, {
				resizeWidth: Math.max(1, Math.round(w * s)),
				resizeHeight: Math.max(1, Math.round(h * s)),
				resizeQuality: "high",
			});
		};
		const masks = new Map();
		for (const p of list) {
			const img = await new Promise((resolve, reject) => {
				const i = new Image();
				i.crossOrigin = "anonymous";
				i.onload = () => resolve(i);
				i.onerror = () => reject(new Error(`load ${p.src}`));
				i.src = p.src;
			});
			const px = await scaled(img, 1024);
			masks.set(p.id, await segmentForeground(px));
			px.close();
		}
		const bytes = encodePeopleMasks(masks);
		let bin = "";
		for (let i = 0; i < bytes.length; i += 0x8000)
			bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return btoa(bin);
	}, photos);
	await page.close();
	return Buffer.from(out, "base64");
}

/** The engine's masks from /roll/demo?view=map, in the same layout. */
async function liveInPage() {
	const page = await browser.newPage();
	await page.goto(`${BASE}/roll/demo?view=map&renderer=${RENDERER}`);
	await page.waitForFunction(
		(n) => window.__roll?.masks?.size >= n,
		photos.length,
		{ timeout: 300_000, polling: 500 },
	);
	const out = await page.evaluate(
		async (ids) => {
			const { encodePeopleMasks } = await import(
				"/src/lib/demo/people-masks.ts"
			);
			const masks = new Map(
				ids.map((id) => [id, window.__roll.peopleMaskOf(id)]),
			);
			const bytes = encodePeopleMasks(masks);
			let bin = "";
			for (let i = 0; i < bytes.length; i += 0x8000)
				bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			return btoa(bin);
		},
		photos.map((p) => p.id),
	);
	await page.close();
	return Buffer.from(out, "base64");
}

/** Per-mask comparison of two raw layouts (same ids in the same order). */
function compare(a, b) {
	const read = (buf) => {
		const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
		const n = v.getUint32(4, true);
		const out = [];
		let at = 8;
		for (let i = 0; i < n; i++) {
			const len = buf[at++];
			const id = buf.subarray(at, at + len).toString("latin1");
			at += len;
			const w = v.getUint16(at, true);
			const h = v.getUint16(at + 2, true);
			at += 4;
			out.push({ id, w, h, data: buf.subarray(at, at + w * h) });
			at += w * h;
		}
		return out;
	};
	const A = read(a);
	const B = read(b);
	let identical = true;
	for (const [i, x] of A.entries()) {
		const y = B[i];
		let diff = 0;
		let max = 0;
		let fg = 0;
		for (let k = 0; k < x.data.length; k++) {
			const d = Math.abs(x.data[k] - (y?.data[k] ?? 0));
			if (d) diff++;
			if (d > max) max = d;
			if (x.data[k] > 127) fg++;
		}
		const same = y && y.id === x.id && y.w === x.w && y.h === x.h && !diff;
		identical &&= !!same;
		console.log(
			`${x.id} ${x.w}x${x.h} fg>127 ${fg}px: ${same ? "identical" : `DIFFERS (${diff} bytes, max |Δ| ${max}, live ${y?.w}x${y?.h})`}`,
		);
	}
	return identical;
}

try {
	let raw;
	if (verifyOnly) raw = gunzipSync(readFileSync(OUT));
	else {
		raw = await bakeInPage();
		mkdirSync(dirname(OUT), { recursive: true });
		const gz = gzipSync(raw, { level: 9 });
		writeFileSync(OUT, gz);
		console.log(
			`wrote ${join(OUT)}: ${photos.length} masks, ${raw.length} B raw, ${gz.length} B gzipped`,
		);
	}
	if (verify) {
		const live = await liveInPage();
		const ok = compare(raw, live);
		console.log(
			ok
				? "bake == live roll-map masks, bit for bit"
				: "bake != live masks (see above)",
		);
		process.exitCode = ok ? 0 : 1;
	}
} finally {
	await browser.close();
}
