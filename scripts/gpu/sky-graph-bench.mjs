#!/usr/bin/env node
// Sky refine on GPUCommandGraph (src/lib/gpu/sky/refine-graph.ts) vs the CPU refine (sky/core.ts):
// float / byte parity, bytes-only = floats run, repeated runs with different data across shape-cache
// hits / misses / evictions, the clear-node rule, transient VRAM and timings. Page realm,
// src/lib/gpu/sky/bench-graph.ts. Always under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/sky-graph-bench.mjs [--url http://localhost:3183]
//     [--photos IMG_6958,IMG_7086,IMG_7131,IMG_7155] [--reps 7] [--tag x]
// Writes out/gpu/followups/sky-graph/sky-graph-bench[-tag].json.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i >= 0 ? process.argv[i + 1] : d;
};
const URL0 = arg("url", process.env.APP_URL ?? "http://localhost:3183");
const PHOTOS = arg("photos", "IMG_6958,IMG_7086,IMG_7131,IMG_7155").split(",");
const REPS = Number(arg("reps", "7"));
const TAG = arg("tag", "");
const OUT = join(ROOT, "out/gpu/followups/sky-graph");

const t0 = Date.now();
const log = (...m) =>
	console.log(`[sky-graph ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
let results;
try {
	const ctx = await browser.newContext();
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
	results = await page.evaluate(
		async ({ names, reps }) => {
			const b = await import("/src/lib/gpu/sky/bench-graph.ts");
			return b.runSkyGraphBench({ names, reps });
		},
		{ names: PHOTOS, reps: REPS },
	);
	await ctx.close();
} finally {
	await browser.close();
}
if (results.error) log("error", results.error);
log("clear", JSON.stringify(results.clear));
for (const c of results.cases ?? [])
	log(
		c.name,
		c.size,
		`lo ${c.lo} ort=${c.ortBuffer}`,
		`vs cpu: float max|Δ| ${c.cpuFloatMaxAbs.toExponential(2)} bytes≠ ${c.cpuBytesDiff}/${c.bytes} (max ${c.cpuBytesMax}) | bytesOnly≠ ${c.bytesOnlyDiff}`,
		`| MB logical ${(c.vram.pooledLogical / 1e6).toFixed(1)} (pow2 ${(c.vram.pooledCapacity / 1e6).toFixed(1)}) graph ${(c.vram.newPhysical / 1e6).toFixed(1)} [${c.vram.newPhysicalCount} bufs]`,
		`| ms graph ${c.ms.graph.toFixed(2)} (miss ${c.ms.graphMiss.toFixed(1)})`,
	);
for (const s of results.sequence ?? []) log("seq", JSON.stringify(s));
for (const x of results.extra ?? []) log("extra", JSON.stringify(x));
mkdirSync(OUT, { recursive: true });
const file = join(OUT, `sky-graph-bench${TAG ? `-${TAG}` : ""}.json`);
writeFileSync(
	file,
	JSON.stringify({ url: URL0, reps: REPS, ...results }, null, 1),
);
log(`wrote ${file}`);
