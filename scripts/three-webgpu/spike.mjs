#!/usr/bin/env node
// three.js on WebGPU spike (src/lib/three-webgpu/spike.ts) in headless Chromium: the classic hillshade
// with WebGPURenderer + TSL for one ground-truth pose, the MRT geometry target read back async, a core
// compute kernel on the shared device, and a pixel comparison against the WebGL2 path (the engine's
// ShaderMaterial on the same meshes).
//
//   npx vite dev --config scripts/gpu/vite.gpu.config.ts --port 3157 &
//   APP_URL=http://localhost:3157 node scripts/gpu/with-render-lock.mjs -- node scripts/three-webgpu/spike.mjs [IMG_7053] [modes=luma-first,sidecar,three-first,own]
//
// Writes out/gpu/followups/three-webgpu/{spike.json, webgpu.jpg, webgl.jpg, diff.png}.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = process.env.APP_URL ?? "http://localhost:3157";
const OUT = path.join(ROOT, "out/gpu/followups/three-webgpu");
const argv = process.argv.slice(2);
const id = argv.find((a) => a.startsWith("IMG_")) ?? "IMG_7053";
const modes = (
	argv.find((a) => a.startsWith("modes="))?.slice(6) ??
	"luma-first,sidecar,three-first,own"
).split(",");

const gt = JSON.parse(
	fs.readFileSync(path.join(ROOT, "data/ground-truth.json"), "utf8"),
)[id];
if (!gt?.f) throw new Error(`${id}: no solved pose in data/ground-truth.json`);
const input = {
	lat: gt.lat,
	lon: gt.lon,
	eye: gt.eye,
	aspect: gt.width / gt.height,
	pose: {
		yaw: gt.yaw,
		pitch: gt.pitch,
		roll: gt.roll,
		vfov: (2 * Math.atan(gt.height / 2 / gt.f) * 180) / Math.PI,
	},
};

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const runs = [];
try {
	const page = await browser.newPage();
	let pageErrors = [];
	page.on("console", (m) => {
		if (m.type() === "error" || m.type() === "warning") {
			pageErrors.push(`${m.type()}: ${m.text().slice(0, 300)}`);
			console.error(`[page ${m.type()}]`, m.text().slice(0, 300));
		}
	});
	page.on("pageerror", (e) => console.error("[pageerror]", e.message));
	await page.goto(`${BASE}/favicon.svg`);
	// the first import of three/webgpu + three/tsl can make Vite re-optimise its deps and reload; a
	// page that already holds the old three chunk then gets a second three core ("Multiple instances")
	await page.evaluate(() => import("/src/lib/three-webgpu/spike.ts"));
	await page.goto(`${BASE}/favicon.svg`);
	for (const [k, mode] of modes.entries()) {
		const t0 = Date.now();
		pageErrors = [];
		const r = await page
			.evaluate(
				async (a) => {
					const m = await import("/src/lib/three-webgpu/spike.ts");
					return m.runSpike(a);
				},
				{ ...input, mode, webgl: k === 0 },
			)
			.catch((e) => ({ mode, error: String(e).slice(0, 500) }));
		r.pageErrors = pageErrors.slice(0, 20);
		const imgs = r.images ?? {};
		for (const [name, url] of Object.entries(imgs)) {
			if (k > 0) continue;
			const ext = url.startsWith("data:image/png") ? "png" : "jpg";
			fs.writeFileSync(
				path.join(OUT, `${name}.${ext}`),
				Buffer.from(url.split(",")[1], "base64"),
			);
		}
		delete r.images;
		r.wallMs = Date.now() - t0;
		runs.push(r);
		console.log(`\n== ${mode} (${r.wallMs} ms wall)`);
		console.log(JSON.stringify({ ...r, deviceFeatures: undefined }, null, 1));
	}
} finally {
	await browser.close();
}
fs.writeFileSync(
	path.join(OUT, "spike.json"),
	JSON.stringify({ id, input, date: new Date().toISOString(), runs }, null, 1),
);
console.log(`\nwrote ${path.relative(ROOT, OUT)}/spike.json`);
