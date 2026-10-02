#!/usr/bin/env node

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
// Sky segmentation on the GPU (src/lib/gpu/sky/**): parity and timing of the GPU refine against the CPU
// refine (src/lib/sky/core.ts refineToWorking), and end-to-end timing of the real sky worker.
// Always run it under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/sky-bench.mjs [--url http://localhost:3100]
//     [--photos IMG_6958,IMG_7086] [--reps 3] [--only e2e|parity] [--tag before] [--module /src/…]
// Parts:
// - parity (page realm, src/lib/gpu/sky/bench.ts): U²-Net-P on ORT's WebGPU EP sharing the luma compute
//   device, model output kept on the GPU, GPU refine vs CPU refine of the same P(sky): max / p99 abs
//   diff of the float mask, differing mask bytes, and ms for model, GPU refine, CPU refine.
// - e2e: segmentSky() through the worker, once with the GPU on and once with ?gpu=off (flag override),
//   reporting the worker's own ms, the refine path it took, and the byte diff between the two masks.
// Writes out/gpu/followups/sky-device/sky-bench[-tag].json (small).
import { APP_URL } from "../lib/harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i >= 0 ? process.argv[i + 1] : d;
};
const URL0 = arg("url", APP_URL);
const PHOTOS = arg(
	"photos",
	"IMG_6958,IMG_7053,IMG_7086,IMG_7108,IMG_7131,IMG_7155",
).split(",");
const REPS = Number(arg("reps", "3"));
const ONLY = arg("only", "");
const TAG = arg("tag", "");
// the sky module the e2e part drives (a copy of the pre-change code for a BEFORE run)
const SKY_MODULE = arg("module", "/src/lib/sky/index.ts");
const OUT = join(ROOT, "out/gpu/followups/sky-device");

const t0 = Date.now();
const log = (...m) =>
	console.log(`[sky-bench ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});

async function withPage(gpuOff, fn) {
	const ctx = await browser.newContext();
	if (gpuOff)
		await ctx.addInitScript(() => {
			globalThis.__RIGI_FLAGS__ = { ...globalThis.__RIGI_FLAGS__, gpu: "off" };
		});
	// no HMR: the tree is edited concurrently
	await ctx.routeWebSocket(
		(u) => u.origin === new URL(URL0).origin.replace(/^http/, "ws"),
		() => {},
	);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => log(`pageerror ${e.message}`));
	page.on("console", (m) => {
		if (m.type() === "warning" || m.type() === "error")
			log(`console.${m.type()} ${m.text().slice(0, 400)}`);
	});
	await page.goto(`${URL0}/photos/${PHOTOS[0]}.jpg`);
	try {
		return await fn(page);
	} finally {
		await ctx.close();
	}
}

// segmentSky through the real worker; returns per-photo worker ms + the mask bytes (base64) of the
// last rep for the cross-run diff.
const e2e = (page) =>
	page.evaluate(
		async ({ names, reps, mod }) => {
			const sky = await import(mod);
			const tp = performance.now();
			const ready = await sky.preloadSkyModel();
			const out = {
				preload: { ...ready, ms: Math.round(performance.now() - tp) },
				photos: [],
			};
			for (const name of names) {
				const img = new Image();
				img.src = `/photos/${name}.jpg`;
				await img.decode();
				const runs = [];
				let m;
				for (let r = 0; r < reps; r++) {
					const t0 = performance.now();
					m = await sky.segmentSky(img);
					runs.push({
						total: performance.now() - t0,
						...m.ms,
						refineOn: m.refineOn,
						ortDevice: m.ortDevice,
					});
				}
				let bin = "";
				for (let i = 0; i < m.data.length; i += 0x8000)
					bin += String.fromCharCode(...m.data.subarray(i, i + 0x8000));
				out.photos.push({
					name,
					size: `${m.width}x${m.height}`,
					source: m.source,
					backend: m.backend,
					runs,
					mask: btoa(bin),
				});
			}
			return out;
		},
		{ names: PHOTOS, reps: REPS, mod: SKY_MODULE },
	);

const med = (xs) => {
	const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
	return s.length ? s[s.length >> 1] : Number.NaN;
};
const summarise = (runs) => {
	// the first rep of the first photo pays warm-up; report medians over reps
	const keys = ["total", "load", "infer", "refine"];
	return Object.fromEntries(
		keys.map((k) => [k, +med(runs.map((r) => r[k])).toFixed(1)]),
	);
};

const results = {
	url: URL0,
	photos: PHOTOS,
	reps: REPS,
	tag: TAG,
	module: SKY_MODULE,
};
try {
	if (ONLY !== "e2e") {
		log("parity (page realm, shared device)");
		results.parity = await withPage(false, (page) =>
			page.evaluate(
				async ({ names, reps }) => {
					const b = await import("/src/lib/gpu/sky/bench.ts");
					return b.runSkyBench(names, reps);
				},
				{ names: PHOTOS, reps: REPS },
			),
		);
		for (const p of results.parity.photos ?? [])
			log(
				p.name,
				p.size,
				`model ${p.lo} | max|Δ| ${p.maxAbs.toExponential(2)} p99 ${p.p99.toExponential(2)} | bytes≠ ${p.bytesDiff} (max ${p.bytesMax})`,
				`| ms model ${p.ms.model.toFixed(1)} gpuRefine ${p.ms.gpuRefine.toFixed(1)} (float read ${p.ms.gpuRefineFloat.toFixed(1)}) cpuRefine ${p.ms.cpuRefine.toFixed(1)} download ${p.ms.download.toFixed(1)}`,
			);
		for (const x of results.parity.extra ?? [])
			log(
				x.case,
				`| max|Δ| ${x.maxAbs.toExponential(2)} p99 ${x.p99.toExponential(2)} | bytes≠ ${x.bytesDiff} (max ${x.bytesMax})`,
			);
		if (results.parity.error) log("parity error", results.parity.error);
		log("device", JSON.stringify(results.parity.device));
	}
	if (ONLY !== "parity") {
		const runs = {};
		for (const [label, off] of [
			["gpu", false],
			["gpuOff", true],
		]) {
			log(`e2e ${label}`);
			runs[label] = await withPage(off, e2e);
			log(`  preload ${JSON.stringify(runs[label].preload)}`);
			for (const p of runs[label].photos)
				log(
					`  ${p.name} ${p.size} ${p.source}/${p.backend} refineOn=${p.runs.at(-1).refineOn} ortDevice=${p.runs.at(-1).ortDevice}`,
					JSON.stringify(summarise(p.runs)),
				);
		}
		results.e2e = {};
		for (const [label, r] of Object.entries(runs))
			results.e2e[label] = {
				preload: r.preload,
				photos: r.photos.map(({ mask, runs, ...p }) => ({
					...p,
					refineOn: runs.at(-1).refineOn,
					ortDevice: runs.at(-1).ortDevice,
					median: summarise(runs),
					runs: runs.map((x) =>
						Object.fromEntries(
							Object.entries(x).map(([k, v]) => [
								k,
								typeof v === "number" ? +v.toFixed(1) : v,
							]),
						),
					),
				})),
			};
		// gpu vs gpu-off masks (GPU refine vs CPU refine of the same model, end to end)
		results.e2e.maskDiff = runs.gpu.photos.map((p, i) => {
			const a = Buffer.from(p.mask, "base64");
			const b = Buffer.from(runs.gpuOff.photos[i].mask, "base64");
			let n = 0;
			let mx = 0;
			for (let k = 0; k < a.length; k++) {
				const d = Math.abs(a[k] - b[k]);
				if (d) n++;
				if (d > mx) mx = d;
			}
			return { name: p.name, bytes: a.length, differ: n, max: mx };
		});
		for (const d of results.e2e.maskDiff)
			log(
				`  mask gpu vs gpuOff ${d.name}: ${d.differ}/${d.bytes} differ, max ${d.max}`,
			);
	}
} finally {
	await browser.close();
}
mkdirSync(OUT, { recursive: true });
const file = join(OUT, `sky-bench${TAG ? `-${TAG}` : ""}.json`);
writeFileSync(file, JSON.stringify(results, null, 1));
log(`wrote ${file}`);
