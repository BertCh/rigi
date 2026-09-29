#!/usr/bin/env node
// Screenshots + fps for /lab/splats (the three.js Gaussian splat renderer). Run under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/nearfield/splat-lab-check.mjs [--n 200000,1000000] [--no-shots] [--query aa=0] [--size 1280x800]
// Shots land in tools/nearfield/shots/. APP_URL defaults to the private :3110 vite.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const arg = (k, d) => {
	const i = process.argv.indexOf(k);
	return i >= 0 ? process.argv[i + 1] : d;
};
const URL0 = process.env.APP_URL ?? "http://localhost:3110";
const ns = arg("--n", "200000,1000000").split(",").map(Number);
const shots = !process.argv.includes("--no-shots");
const extra = arg("--query", "") ? `&${arg("--query", "")}` : "";
const [VW, VH] = arg("--size", "1280x800").split("x").map(Number);
const views = arg("--views", "default,hill,far,needles,top").split(",");
const OUT = resolve(import.meta.dirname, "../../tools/nearfield/shots");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const results = [];
try {
	for (const n of ns) {
		for (const logdepth of n === ns[0] ? [1, 0] : [1]) {
			const page = await browser.newPage({
				viewport: { width: VW, height: VH },
				deviceScaleFactor: 1,
			});
			const errors = [];
			page.on("pageerror", (e) => errors.push(e.message));
			page.on("console", (m) => {
				if (m.type() === "error" || m.type() === "warning")
					errors.push(`${m.type()}: ${m.text()}`);
			});
			await page.goto(`${URL0}/lab/splats?n=${n}&logdepth=${logdepth}${extra}`);
			await page.waitForFunction(() => window.__splatLab?.ready, null, {
				timeout: 120000,
			});
			await page.waitForTimeout(1500);
			const renderer = await page.evaluate(() => {
				const gl = document.createElement("canvas").getContext("webgl2");
				const ext = gl?.getExtension("WEBGL_debug_renderer_info");
				return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "?";
			});
			if (shots && n === ns[0]) {
				for (const v of logdepth ? views : ["default", "hill"]) {
					await page.evaluate((v) => window.__splatLab.setView(v), v);
					await page.waitForTimeout(700);
					await page.screenshot({
						path: `${OUT}/lab-${v}${logdepth ? "" : "-nolog"}.png`,
					});
				}
				if (logdepth) {
					await page.getByLabel("Truth").check();
					await page.evaluate(() => window.__splatLab.setView("default"));
					await page.waitForTimeout(700);
					await page.screenshot({ path: `${OUT}/lab-default-truth.png` });
					await page.getByLabel("Truth").uncheck();
				}
			}
			await page.evaluate(() => window.__splatLab.setView("default"));
			const m = await page.evaluate(() => window.__splatLab.measure(4000));
			const stats = await page.evaluate(() => window.__splatLab.stats());
			const r = {
				n,
				logdepth,
				extra,
				size: `${VW}x${VH}`,
				renderer,
				...m,
				stats,
				errors: errors.slice(0, 5),
			};
			results.push(r);
			console.log(JSON.stringify(r));
			await page.close();
		}
	}
} finally {
	await browser.close();
}
