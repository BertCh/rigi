#!/usr/bin/env node

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
// Bakes the landing page's Step Inside demo (src/components/site/StepInsideDemo.tsx): opens the photo in
// the real workspace with its ground-truth pose, builds the near-field scene in the page (MoGe-2 ViT-S
// depth + lift, src/lib/nearfield/local) exactly as the Step Inside button does, and writes the
// anchored scene so the landing page can show it without running the depth model:
//   public/demo/step/photo.jpg     the photo (copied from public/photos)
//   public/demo/step/scene.json    photo meta, pose, anchor fit, split (counts; the class grid is cls.bin), radius, pivot
//   public/demo/step/cls.bin       the split's class grid, raw bytes (width x height)
//   public/demo/step/splats.splat  the anchored ENU Gaussians (.splat-v1, nearfield/splat-io.ts)
//
//   node scripts/gpu/with-render-lock.mjs -- node scripts/demo/bake-step.mjs [IMG_7086] [--renderer=deck]
// Needs the dev server (APP_URL, default http://localhost:3100), WebGPU in the headless browser and the
// depth weights in public/models (node scripts/models/fetch.mjs --only moge2).
import { APP_URL } from "../lib/harness.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const BASE = APP_URL;
const OUT = join(ROOT, "public/demo/step");
const arg = (k, d) =>
	process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const renderer = arg("renderer", "deck");
const id = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "IMG_7086";

const gt = JSON.parse(
	readFileSync(join(ROOT, "data/ground-truth.json"), "utf8"),
)[id];
if (!gt)
	throw new Error(`${id}: no ground-truth pose in data/ground-truth.json`);
const pose = {
	yaw: gt.yaw,
	pitch: gt.pitch,
	roll: gt.roll,
	vfov: (2 * Math.atan(gt.height / (2 * gt.f)) * 180) / Math.PI,
};
const meta = JSON.parse(
	readFileSync(join(ROOT, "public/photos/photos.json"), "utf8"),
).find((p) => p.id === id);
if (!meta) throw new Error(`${id}: not in public/photos/photos.json`);

mkdirSync(OUT, { recursive: true });
copyFileSync(join(ROOT, "public", meta.src), join(OUT, "photo.jpg"));

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const ctx = await browser.newContext({
	viewport: { width: 1400, height: 900 },
	deviceScaleFactor: 1,
});
await ctx.addInitScript(
	([k, v]) => {
		try {
			localStorage.setItem(k, v);
		} catch {}
	},
	// The "mt-image" key predates the Rigi rename and is kept for saved-data compatibility.
	[`rigi.pose.${id}`, JSON.stringify(pose)],
);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("[page]", e.message));
page.on("console", (m) => {
	if (m.type() === "error" || /nearfield/i.test(m.text()))
		console.log(`[console.${m.type()}]`, m.text().slice(0, 300));
});
try {
	await page.goto(`${BASE}/photo/${id}?nearfield=on&renderer=${renderer}`);
	await page.waitForSelector("[data-ready]", {
		state: "attached",
		timeout: 180000,
	});
	await page.waitForSelector("[data-nearfield-status]", { timeout: 30000 });
	const baked = await page.evaluate(async () => {
		const nf = window.__nearfield;
		const s = await nf.build();
		if (!s) return { error: JSON.stringify(nf.state) };
		const { encodeSplatV1 } = await import("/src/lib/nearfield/splat-io.ts");
		const e = window.__engine;
		const g = e.frame.toGeo(0, 0, 0);
		const b64 = (u8) => {
			let t = "";
			for (let i = 0; i < u8.length; i += 0x8000)
				t += String.fromCharCode(...u8.subarray(i, i + 0x8000));
			return btoa(t);
		};
		const splats = new Uint8Array(
			encodeSplatV1(s.splats, { lat: g.lat, lon: g.lon, h: g.h ?? 0 }),
		);
		const range = s.measure?.range ?? [];
		const near = [];
		for (let i = 0; i < range.length; i++)
			if (range[i] > 0) near.push(range[i]);
		near.sort((a, b) => a - b);
		return {
			scene: {
				photoId: s.photoId,
				anchor: s.anchor,
				split: {
					width: s.split.width,
					height: s.split.height,
					counts: s.split.counts,
				},
				confidenceRadius: s.confidenceRadius,
				model: s.model,
				medianObjectRange: near.length ? near[near.length >> 1] : null,
				eye: { x: e.eye.x, y: e.eye.y, z: e.eye.z },
				splats: s.splats.count,
			},
			splats: b64(splats),
			cls: b64(s.split.cls),
		};
	});
	if (baked.error) throw new Error(`build failed: ${baked.error}`);
	const out = {
		...baked.scene,
		photo: { ...meta, src: "/demo/step/photo.jpg" },
		pose,
		bakedAt: new Date().toISOString(),
		renderer,
	};
	writeFileSync(join(OUT, "scene.json"), `${JSON.stringify(out)}\n`);
	writeFileSync(join(OUT, "cls.bin"), Buffer.from(baked.cls, "base64"));
	writeFileSync(join(OUT, "splats.splat"), Buffer.from(baked.splats, "base64"));
	console.log(
		`${id}: ${out.splats} splats, quality ${out.anchor.quality.toFixed(3)}, radius ${out.confidenceRadius.toFixed(1)} m, eye z ${out.eye.z.toFixed(1)} → ${OUT}`,
	);
} finally {
	await browser.close();
}
