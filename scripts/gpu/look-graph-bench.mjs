#!/usr/bin/env node
// Look graphs (src/lib/gpu/look/{relief,guided-filter,color-stats}-graph.ts) vs the pooled default
// paths: bit-identity over photos × sizes (NaN inputs included), runs twice+ with different data,
// the clear lint, VRAM and interleaved median timings. Page realm, src/lib/gpu/look/bench-graph.ts.
// Always under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/look-graph-bench.mjs [--url http://localhost:3220]
//     [--photos IMG_6958,IMG_7086,IMG_7131,IMG_7155] [--reps 9] [--tag x]
// Writes out/gpu/core/look-graph/look-graph-bench[-tag].json. Exit code 1 unless every check passes.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i >= 0 ? process.argv[i + 1] : d;
};
const URL0 = arg("url", process.env.APP_URL ?? "http://localhost:3220");
const PHOTOS = arg("photos", "IMG_6958,IMG_7086,IMG_7131,IMG_7155").split(",");
const REPS = Number(arg("reps", "9"));
const TAG = arg("tag", "");
const OUT = join(ROOT, "out/gpu/core/look-graph");

const t0 = Date.now();
const log = (...m) =>
	console.log(`[look-graph ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);

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
			try {
				const b = await import("/src/lib/gpu/look/bench-graph.ts");
				return await b.runLookGraphBench({ names, reps });
			} catch (e) {
				return { error: String(e?.stack ?? e) };
			}
		},
		{ names: PHOTOS, reps: REPS },
	);
	await ctx.close();
} finally {
	await browser.close();
}
if (results.error) log("error", results.error);
for (const k of ["relief", "guided", "stats"]) {
	const rows = [...(results[k] ?? []), ...(results[`${k}Twice`] ?? [])];
	for (const r of rows) log(JSON.stringify(r));
}
log("lint", JSON.stringify(results.lint));
log("timings", JSON.stringify(results.timings));
log("vram", JSON.stringify(results.vram));
log(
	"cases",
	JSON.stringify(results.cases),
	"failures",
	JSON.stringify(results.failures),
);
mkdirSync(OUT, { recursive: true });
const file = join(OUT, `look-graph-bench${TAG ? `-${TAG}` : ""}.json`);
writeFileSync(
	file,
	JSON.stringify({ url: URL0, reps: REPS, ...results }, null, 1),
);
log(`wrote ${file}`);
process.exit(results.ok ? 0 : 1);
