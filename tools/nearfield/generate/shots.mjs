#!/usr/bin/env node
// Screenshots + summary for /lab/generate (Step Inside P3, DEM-conditioned generation). Run under the render lock:
//   node scripts/gpu/with-render-lock.mjs -- node tools/nearfield/generate/shots.mjs [--photos IMG_7131,IMG_7086] [--query step=10]
// Needs the near-field service with /inpaint (tools/nearfield/run.sh) and the private vite on :3110.
// Writes tools/nearfield/shots/gen-<photo>-page.png, gen-<photo>-<panel>.png and gen-<photo>.summary.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const arg = (k, d) => {
	const i = process.argv.indexOf(k);
	return i >= 0 ? process.argv[i + 1] : d;
};
const URL0 = process.env.APP_URL ?? "http://localhost:3110";
const photos = arg("--photos", "IMG_7131,IMG_7086").split(",");
const extra = arg("--query", "") ? `&${arg("--query", "")}` : "";
const OUT = resolve(import.meta.dirname, "../shots");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
let bad = 0;
try {
	for (const id of photos) {
		const page = await browser.newPage({
			viewport: { width: 1600, height: 1000 },
			deviceScaleFactor: 1,
		});
		const errors = [];
		page.on("pageerror", (e) => errors.push(e.message));
		page.on("console", (m) => {
			if (m.type() === "error") errors.push(m.text());
		});
		const t0 = Date.now();
		await page.goto(`${URL0}/lab/generate?photo=${id}&nearfield=gen${extra}`);
		await page.waitForFunction(() => window.__genLab?.done, null, {
			timeout: 900000,
			polling: 1000,
		});
		const lab = await page.evaluate(() => window.__genLab);
		if (lab.error) {
			console.log(`${id}: ERROR ${lab.error}`);
			bad++;
		}
		for (const p of lab.panels ?? []) {
			const b64 = p.url.replace(/^data:image\/png;base64,/, "");
			writeFileSync(
				`${OUT}/gen-${id}-${p.name}.png`,
				Buffer.from(b64, "base64"),
			);
		}
		await page.screenshot({
			path: `${OUT}/gen-${id}-page.png`,
			fullPage: true,
		});
		writeFileSync(
			`${OUT}/gen-${id}.summary.json`,
			JSON.stringify({ ...lab.summary, pageErrors: errors }, null, 1),
		);
		const s = lab.summary ?? {};
		console.log(
			`${id}: ${((Date.now() - t0) / 1000).toFixed(0)} s · observed ${s.observedSplats} · generated ${s.generatedSplats} · export ${JSON.stringify(s.exportAudit)} · readout ${JSON.stringify(s.readoutAudit)}`,
		);
		for (const v of s.views ?? [])
			console.log(
				`  ${v.name}: holes ${(100 * v.holes.holeFrac).toFixed(1)}% (DEM ${(100 * v.holes.demBacked).toFixed(0)}%) +${v.added} reproj cov ${(100 * v.reproj.covered).toFixed(1)}% |d| ${v.reproj.meanAbsDiff.toFixed(1)} mono ${v.mono ? `${v.mono.mode} ${v.mono.scale.toFixed(2)}` : "-"}`,
			);
		if (errors.length)
			console.log(`  page errors: ${errors.slice(0, 5).join(" | ")}`);
		await page.close();
	}
} finally {
	await browser.close();
}
process.exit(bad ? 1 : 0);
