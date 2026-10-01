#!/usr/bin/env node
// /baseline's pipeline worker: Auto-align poses with the CPU cascade (solveGpu off) vs the GPU coarse
// grid (solveGpu on), headless Chromium against a dev server on this tree. Drives the real worker
// (src/baseline-ui/pipeline.worker.ts) with the messages BaselinePage sends: run, skyline (800 px),
// align (prior from the sample's EXIF). Dumps the poses as JSON and compares them with Object.is.
//
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/baseline-worker-check.mjs [IMG_xxxx ...]
//
// Env: APP_URL (default http://localhost:3171), OUT (json path), MODES (default cpu,gpu,gpu,cpu: one
// align per entry, in order; a mode the worker does not know, e.g. the pre-change worker, runs CPU).
// Writes out/gpu/baseline-worker-check.json (small).
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = process.env.APP_URL ?? "http://localhost:3171";
const OUT =
	process.env.OUT ?? path.join(ROOT, "out/gpu/baseline-worker-check.json");
const modes = (process.env.MODES ?? "cpu,gpu,gpu,cpu").split(",");
const argv = process.argv.slice(2).filter((a) => a.startsWith("IMG_"));
const ids = argv.length
	? argv
	: ["IMG_6958", "IMG_7018", "IMG_7053", "IMG_7068", "IMG_7108"];

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const results = [];
try {
	const page = await browser.newPage();
	page.on("pageerror", (e) => console.error("[pageerror]", e.message));
	await page.goto(`${BASE}/favicon.svg`);
	for (const id of ids) {
		const r = await page.evaluate(
			async ({ id, modes }) => {
				const cam = await import("/src/lib/geo/camera.ts");
				const index = await (await fetch("/baseline/index.json")).json();
				const entry = index.find((e) => e.name === id);
				const meta = entry.meta;
				const img = new Image();
				img.src = `/baseline/${entry.file}`;
				await img.decode();
				const w = img.naturalWidth;
				const h = img.naturalHeight;
				// BaselinePage.priorCamera
				let prior;
				if (meta.gravity && meta.heading !== undefined && meta.focal35) {
					const ds = cam.displaySize(meta);
					prior = cam.resizeCamera(cam.cameraFromMeta(meta), w);
					if (Math.abs(ds.width / ds.height - w / h) > 0.01)
						prior = { ...prior, height: h, cy: h / 2 };
				} else {
					prior = cam.cameraFromAngles({
						width: w,
						height: h,
						f: cam.focalPx(meta.focal35 ?? 26, w, h),
						yaw: meta.heading ?? 0,
						pitch: 0,
						roll: 0,
					});
				}
				const sw = Math.min(800, w);
				const sh = Math.round((h * sw) / w);
				const c = document.createElement("canvas");
				c.width = sw;
				c.height = sh;
				const cx = c.getContext("2d", { willReadFrequently: true });
				cx.drawImage(img, 0, 0, sw, sh);
				const image = cx.getImageData(0, 0, sw, sh);
				const worker = new Worker("/src/baseline-ui/pipeline.worker.ts", {
					type: "module",
				});
				let n = 1;
				const waiters = new Map();
				worker.onmessage = (ev) => {
					const m = ev.data;
					waiters.get(`${m.type}:${m.id}`)?.(m);
				};
				const call = (msg, wait) =>
					new Promise((resolve, reject) => {
						const mid = n++;
						const t = performance.now();
						const done = (m) => {
							waiters.delete(`${wait}:${mid}`);
							waiters.delete(`error:${mid}`);
							m.type === "error"
								? reject(new Error(m.message))
								: resolve({ m, ms: performance.now() - t });
						};
						waiters.set(`${wait}:${mid}`, done);
						waiters.set(`error:${mid}`, done);
						worker.postMessage({ ...msg, id: mid });
					});
				const t0 = performance.now();
				await call(
					{
						type: "run",
						lat: meta.lat,
						lon: meta.lon,
						altitude: meta.altitude,
					},
					"horizon",
				);
				const tScene = performance.now() - t0;
				await call(
					{
						type: "skyline",
						image: { width: sw, height: sh, data: image.data },
					},
					"skyline",
				);
				const aligns = [];
				for (const mode of modes) {
					const { m, ms } = await call(
						{ type: "align", prior, solveGpu: mode === "gpu" },
						"align",
					);
					aligns.push({ mode, ms, result: m.result });
				}
				worker.terminate();
				return { id, tScene, aligns };
			},
			{ id, modes },
		);
		results.push(r);
		console.log(
			id,
			`scene ${(r.tScene / 1000).toFixed(1)} s`,
			r.aligns
				.map(
					(a) =>
						`${a.mode}${a.result.solveOn ? `(${a.result.solveOn})` : ""} ${a.ms.toFixed(0)} ms`,
				)
				.join("  "),
		);
	}
} finally {
	await browser.close();
}
// identical = every align of a photo equals its first one, field by field (Object.is on numbers)
const same = (a, b) =>
	typeof a === "number" && typeof b === "number"
		? Object.is(a, b)
		: a && b && typeof a === "object" && typeof b === "object"
			? Object.keys({ ...a, ...b }).every((k) => same(a[k], b[k]))
			: a === b;
let bad = 0;
for (const r of results) {
	const strip = ({ solveOn: _s, ...rest }) => rest;
	const ref = strip(r.aligns[0].result);
	for (const a of r.aligns.slice(1))
		if (!same(ref, strip(a.result))) {
			bad++;
			console.log(`DIFF ${r.id} ${a.mode}`);
		}
}
fs.writeFileSync(OUT, `${JSON.stringify({ modes, results }, null, 1)}\n`);
console.log(bad ? `${bad} DIFFERENT` : "all identical (Object.is)");
process.exit(bad ? 1 : 0);
