#!/usr/bin/env node

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "../deck-webgpu/gpu-args.mjs";
// The sky worker's GPU prep (src/lib/sky/prep.ts, gpu/sky/prep.ts) against the CPU prep, end to end in
// headless Chromium (WebGPU, Tint): segmentSky() through the real worker on every photo, once with
// { gpuPrep: false } and once with { gpuPrep: true }, each in a fresh page (fresh worker, so the GPU arm
// pays its per-device verification on its first 3 photos and runs the pure GPU prep after that).
// Reports per photo: where the prep ran (prepOn), the mask bytes that differ, the sky IoU (P ≥ 128) and
// the worker's ms. A mismatch in the runtime guard shows as prepOn "cpu" on every later photo.
// Always under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/sky-prep-ab.mjs [--url http://localhost:3100]
//     [--photos IMG_6958,wc_0034,…] [--reps 2] [--out out/gpu/sky-prep-ab.json]
import { APP_URL } from "../lib/harness.mjs";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", APP_URL);
const PHOTOS = arg(
	"photos",
	"IMG_6958,IMG_7053,IMG_7086,IMG_7108,IMG_7131,IMG_7155",
).split(",");
const REPS = Number(arg("reps", "2"));
const OUT = arg("out", "out/gpu/sky-prep-ab.json");

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });

async function arm(gpuPrep) {
	const ctx = await browser.newContext();
	// no HMR socket: the tree may be edited while this runs
	await ctx.routeWebSocket(
		(u) => u.origin === new URL(BASE).origin.replace(/^http/, "ws"),
		() => {},
	);
	const page = await ctx.newPage();
	const warnings = [];
	page.on("console", (m) => {
		if (m.type() === "warning" || m.type() === "error")
			warnings.push(`${m.type()}: ${m.text().slice(0, 300)}`);
	});
	page.on("pageerror", (e) => warnings.push(`pageerror: ${e.message}`));
	await page.goto(`${BASE}/photos/${PHOTOS[0]}.jpg`);
	const res = await page.evaluate(
		async ({ names, reps, gpuPrep }) => {
			const sky = await import("/src/lib/sky/index.ts");
			const ready = await sky.preloadSkyModel();
			const photos = [];
			for (const name of names) {
				const img = new Image();
				img.src = `/photos/${name}.jpg`;
				await img.decode();
				const runs = [];
				let m;
				for (let r = 0; r < reps; r++) {
					const t0 = performance.now();
					m = await sky.segmentSky(img, { gpuPrep });
					runs.push({
						total: performance.now() - t0,
						...m.ms,
						prepOn: m.prepOn,
						refineOn: m.refineOn,
					});
				}
				let bin = "";
				for (let i = 0; i < m.data.length; i += 0x8000)
					bin += String.fromCharCode(...m.data.subarray(i, i + 0x8000));
				photos.push({
					name,
					size: `${m.width}x${m.height}`,
					source: m.source,
					backend: m.backend,
					ortDevice: m.ortDevice,
					runs,
					mask: btoa(bin),
				});
			}
			return { ready, photos };
		},
		{ names: PHOTOS, reps: REPS, gpuPrep },
	);
	await ctx.close();
	return { ...res, warnings };
}

const med = (xs) => {
	const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
	return s.length ? s[s.length >> 1] : Number.NaN;
};
const bytes = (b64) => Buffer.from(b64, "base64");

try {
	const cpu = await arm(false);
	const gpu = await arm(true);
	const rows = PHOTOS.map((name, i) => {
		const c = cpu.photos[i];
		const g = gpu.photos[i];
		const a = bytes(c.mask);
		const b = bytes(g.mask);
		let diff = 0;
		let maxAbs = 0;
		let inter = 0;
		let uni = 0;
		for (let k = 0; k < a.length; k++) {
			if (a[k] !== b[k]) diff++;
			maxAbs = Math.max(maxAbs, Math.abs(a[k] - b[k]));
			const sa = a[k] >= 128;
			const sb = b[k] >= 128;
			if (sa && sb) inter++;
			if (sa || sb) uni++;
		}
		// every rep of a photo must give the same mask (the worker is deterministic per arm)
		return {
			name,
			size: c.size,
			source: [c.source, g.source],
			prepOn: [c.runs.map((r) => r.prepOn), g.runs.map((r) => r.prepOn)],
			bytesDiff: a.length === b.length ? diff : -1,
			maxAbs,
			iou: uni ? inter / uni : 1,
			// the first rep of the GPU arm's first 3 photos also pays the CPU comparison
			msCpu: +med(c.runs.map((r) => r.total)).toFixed(1),
			msGpu: +med(g.runs.map((r) => r.total)).toFixed(1),
			msCpuStages: c.runs.at(-1),
			msGpuStages: g.runs.at(-1),
		};
	});
	for (const r of rows)
		console.log(
			`${r.name.padEnd(9)} ${r.size.padEnd(9)} ${r.source.join("/")} prep ${r.prepOn[0].join(",")} | ${r.prepOn[1].join(",")}  bytes≠ ${r.bytesDiff} (max ${r.maxAbs}) IoU ${r.iou.toFixed(6)}  ms cpu ${r.msCpu} gpu ${r.msGpu}`,
		);
	const gpuPhotos = rows.filter((r) => r.prepOn[1].includes("gpu")).length;
	const identical = rows.filter((r) => r.bytesDiff === 0).length;
	const summary = {
		url: BASE,
		reps: REPS,
		photos: rows.length,
		identical,
		gpuPrepPhotos: gpuPhotos,
		meanIoU: rows.reduce((s, r) => s + r.iou, 0) / rows.length,
		minIoU: Math.min(...rows.map((r) => r.iou)),
		medianMs: {
			cpu: med(rows.map((r) => r.msCpu)),
			gpu: med(rows.map((r) => r.msGpu)),
		},
		preload: { cpu: cpu.ready, gpu: gpu.ready },
		warnings: { cpu: cpu.warnings, gpu: gpu.warnings },
		rows,
	};
	console.log(
		`identical masks ${identical}/${rows.length}; GPU prep ran on ${gpuPhotos}/${rows.length}; IoU mean ${summary.meanIoU.toFixed(6)} min ${summary.minIoU.toFixed(6)}; median ms cpu ${summary.medianMs.cpu} gpu ${summary.medianMs.gpu}`,
	);
	for (const [k, w] of Object.entries(summary.warnings))
		if (w.length) console.log(`${k} warnings:\n  ${w.join("\n  ")}`);
	mkdirSync(dirname(OUT), { recursive: true });
	writeFileSync(OUT, JSON.stringify(summary, null, 1));
	console.log(`wrote ${OUT}`);
} finally {
	await browser.close();
}
