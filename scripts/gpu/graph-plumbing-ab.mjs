#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WAG graph plumbing A/B (silhouette-gpu, geo-query-gpu, splat-sort on core ComputeGraphs vs a replica
// of their former raw dispatches): byte-identical read-backs / order buffers and dispatch + readback
// timing, in one headless Chromium page on the WebGPU compute device. Page side:
// scripts/gpu/graph-plumbing-ab-page.ts. Always under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/graph-plumbing-ab.mjs [--reps 15]
//     [--url http://localhost:3110] [--renderer webgpu] [--out out/gpu/graph-plumbing-ab.json]
// The modules are WebGPU-only: --renderer webgpu is the only engine (pinned, as every browser check),
// and the run fails when the compute device is not WebGPU. --url overrides env APP_URL (default
// http://localhost:3110). Exit 1 on any byte difference or page error.
// Measured 2026-10-01 (Apple M-series, headless Chromium, --reps 30): every read-back and order buffer
// byte-identical; medians graph vs raw: silhouette 12 poses 7.2 vs 7.1 ms, verdicts + skyline (one
// submit vs two) 1.3 vs 1.1 ms, gather 0.8 vs 0.7 ms, splat sort 1M 9.0 vs 9.1 ms (encode 0.1 both).
// Re-run 2026-10-01 after geo-query-gpu moved to persistent pool slots + ComputeGraph.runNow (same
// machine, a quieter load state, --reps 30): every read-back and order buffer byte-identical (geo-query
// 32/32 per kind); medians graph vs raw: silhouette 1.9 vs 1.9 ms, verdicts + skyline 0.4 vs 0.5 ms,
// gather 0.3 vs 0.3 ms, splat sort 1M 3.2 vs 3.2 ms. Wall times are per call, so the 0.1 ms
// performance.now() granularity of the page dominates these small medians.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "../deck-webgpu/gpu-args.mjs";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", process.env.APP_URL ?? "http://localhost:3110");
const renderer = arg("renderer", "webgpu");
if (renderer !== "webgpu") {
	console.error(
		"graph-plumbing-ab measures WebGPU modules: --renderer webgpu only",
	);
	process.exit(2);
}
const REPS = Number(arg("reps", "15"));
const OUT = arg("out", "out/gpu/graph-plumbing-ab.json");

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
let result;
try {
	const ctx = await browser.newContext();
	await ctx.routeWebSocket(
		(u) => u.origin === new URL(BASE).origin.replace(/^http/, "ws"),
		() => {},
	);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => console.log("pageerror", e.message));
	page.on("console", (m) => {
		if (m.type() === "error" || m.type() === "warning")
			console.log(`[page ${m.type()}]`, m.text().slice(0, 600));
	});
	await page.goto(`${BASE}/favicon.svg`);
	result = await page.evaluate(async (reps) => {
		const m = await import("/scripts/gpu/graph-plumbing-ab-page.ts");
		return m.runGraphPlumbingAb(reps);
	}, REPS);
} finally {
	await browser.close();
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
	OUT,
	JSON.stringify({ url: BASE, reps: REPS, ...result }, null, 1),
);
console.log(JSON.stringify(result, null, 1));
console.log(`wrote ${OUT}`);
if (result.error || !result.ok || result.adapter?.type !== "webgpu")
	process.exit(1);
