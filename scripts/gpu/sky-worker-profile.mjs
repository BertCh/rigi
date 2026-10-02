#!/usr/bin/env node

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "../deck-webgpu/gpu-args.mjs";
// Where do the sky worker's ~67 ms "refine" stage go (ORT inference vs refine vs readback)? The
// worker (src/lib/sky/sky.worker.ts) reports only load / infer / refine. This probe serves an
// instrumented COPY of the worker through a Playwright route (the repo source is not touched): every
// call that segmentWith makes (prepareGpu, inferSkyModelGpu / inferSkyModel, inf.download,
// rgbPlanes, resamplePlanes, refineSkyGpu, refineToWorking, toBytes) is wrapped with a timer and the
// list rides back on the response's ms.sub. Two variants per photo:
//   plain  the worker as is; sub-stage ms add up to the refine stage, plus a remainder
//   drain  `await queue.onSubmittedWorkDone()` is inserted just before refineSkyGpu, so GPU work
//          still in flight from ORT's inference (its run() resolves before the GPU finishes) is
//          charged to "drain", not to refine; then refine = what the refine itself costs.
// Always under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/sky-worker-profile.mjs [--url http://localhost:3100]
//     [--photos IMG_6958,IMG_7086,IMG_7155] [--reps 7] [--out out/baseline/sky-worker-profile.json]
import { APP_URL } from "../lib/harness.mjs";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", APP_URL);
const PHOTOS = arg("photos", "IMG_6958,IMG_7086,IMG_7155").split(",");
const REPS = Number(arg("reps", "7"));
const OUT = arg("out", "out/baseline/sky-worker-profile.json");

const PRELUDE = `globalThis.__sub = [];
const __W = (n, f) => (...a) => { const t = performance.now(); const r = f(...a);
  if (r && typeof r.then === "function") return r.then((v) => { __sub.push([n, performance.now() - t]); return v; });
  __sub.push([n, performance.now() - t]); return r; };
`;
const WRAPPED = [
	"prepareGpu",
	"inferSkyModelGpu",
	"inferSkyModel",
	"rgbPlanes",
	"resamplePlanes",
	"refineSkyGpu",
	"refineToWorking",
	"toBytes",
	"classicalSky",
];
function instrument(src, drain) {
	let s = src;
	for (const n of WRAPPED)
		s = s.replace(new RegExp(`(?<![\\w.])${n}\\(`, "g"), (m, off) =>
			// leave `function name(` declarations and import lists alone
			s.slice(Math.max(0, off - 9), off) === "function "
				? m
				: `__W("${n}", ${n})(`,
		);
	s = s.replace(
		/(?<![\w.])inf\.download\(\)/g,
		'__W("inf.download", () => inf.download())()',
	);
	if (drain)
		s = s.replace(
			/(\s)const out = await __W\("refineSkyGpu"/,
			'$1await __W("drain", () => refineDev.handle?.queue?.onSubmittedWorkDone?.())();\n$1const out = await __W("refineSkyGpu"',
		);
	s = s.replace(
		/refine: t3 - t2/,
		"refine: t3 - t2, sub: globalThis.__sub.splice(0)",
	);
	return PRELUDE + s;
}

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const med = (xs) => {
	const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
	return s.length ? s[s.length >> 1] : Number.NaN;
};
const p90 = (xs) => {
	const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
	return s.length
		? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]
		: Number.NaN;
};
const results = { url: BASE, photos: PHOTOS, reps: REPS, variants: {} };
for (const variant of ["plain", "drain"]) {
	const ctx = await browser.newContext();
	await ctx.routeWebSocket(
		(u) => u.origin === new URL(BASE).origin.replace(/^http/, "ws"),
		() => {},
	);
	let instrumented = 0;
	await ctx.route(/sky\.worker\.ts/, async (route) => {
		const resp = await route.fetch();
		const body = await resp.text();
		const out = instrument(body, variant === "drain");
		instrumented++;
		await route.fulfill({ response: resp, body: out });
	});
	const page = await ctx.newPage();
	page.on("pageerror", (e) => console.log("pageerror", e.message));
	await page.goto(`${BASE}/photos/${PHOTOS[0]}.jpg`);
	const res = await page.evaluate(
		async ({ names, reps }) => {
			const sky = await import("/src/lib/sky/index.ts");
			const pre = await sky.preloadSkyModel();
			const photos = [];
			for (const name of names) {
				const img = new Image();
				img.src = `/photos/${name}.jpg`;
				await img.decode();
				const runs = [];
				for (let r = 0; r < reps + 1; r++) {
					const t0 = performance.now();
					const m = await sky.segmentSky(img);
					runs.push({
						total: performance.now() - t0,
						...m.ms,
						refineOn: m.refineOn,
						source: m.source,
						backend: m.backend,
					});
				}
				photos.push({
					name,
					size: `${img.naturalWidth}x${img.naturalHeight}`,
					runs,
				});
			}
			return { pre, photos };
		},
		{ names: PHOTOS, reps: REPS },
	);
	await ctx.close();
	results.variants[variant] = { instrumented, ...res };
	// summarise: drop each photo's first (warm-up) run
	for (const p of res.photos) {
		p.runs.shift();
		const names = new Set(p.runs.flatMap((r) => (r.sub ?? []).map(([n]) => n)));
		const sub = {};
		for (const n of names) {
			const xs = p.runs.map((r) =>
				(r.sub ?? []).filter(([k]) => k === n).reduce((a, [, v]) => a + v, 0),
			);
			sub[n] = { median: +med(xs).toFixed(2), p90: +p90(xs).toFixed(2) };
		}
		p.summary = {
			n: p.runs.length,
			total: +med(p.runs.map((r) => r.total)).toFixed(1),
			load: +med(p.runs.map((r) => r.load)).toFixed(1),
			infer: +med(p.runs.map((r) => r.infer)).toFixed(1),
			refine: +med(p.runs.map((r) => r.refine)).toFixed(1),
			refineP90: +p90(p.runs.map((r) => r.refine)).toFixed(1),
			sub,
			refineOn: p.runs.at(-1).refineOn,
		};
		console.log(variant, p.name, p.size, JSON.stringify(p.summary));
	}
}
await browser.close();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(results, null, 1));
console.log(`wrote ${OUT}`);
