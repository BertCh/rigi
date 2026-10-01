#!/usr/bin/env node
// Step Inside 3D Tiles smoke check (src/lib/tiles3d): per photo and renderer, GT pose → step inside →
// wait for the tiles → screenshots at the photo camera and turned away from it; stats + errors → JSON.
// The tiles must be absent from every offscreen pass: sampleAt at the frame centre is compared with
// the tiles off vs on (same pose), and must be identical.
//   node scripts/gpu/with-render-lock.mjs -- node scripts/tiles3d/step-tiles-check.mjs \
//     --renderer=deck --tiles=swisstopo --blend=over IMG_7018
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "../..");
const BASE = process.env.APP_URL ?? "http://localhost:3110";
const OUT = join(ROOT, "out/tiles3d");
mkdirSync(OUT, { recursive: true });
const gt = JSON.parse(
	readFileSync(join(ROOT, "data/ground-truth.json"), "utf8"),
);
const arg = (k, d) =>
	process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const renderer = arg("renderer", "deck");
const tiles = arg("tiles", "swisstopo");
const blend = arg("blend", "fill");
const turns = arg("turns", "0,60,-60").split(",").map(Number);
let ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!ids.length) ids = ["IMG_7018"];

const fixedPose = (id) => {
	const g = gt[id];
	return {
		yaw: g.yaw,
		pitch: g.pitch,
		roll: g.roll,
		vfov: (2 * Math.atan(g.height / (2 * g.f)) * 180) / Math.PI,
	};
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const report = {};
for (const id of ids) {
	const r = { id, renderer, tiles, blend };
	report[id] = r;
	const ctx = await browser.newContext({
		viewport: { width: 1400, height: 900 },
		deviceScaleFactor: 1,
	});
	await ctx.addInitScript(
		([k, v]) => {
			try {
				localStorage.setItem(k, v);
			} catch {}
		},
		[`mt-image:pose:${id}`, JSON.stringify(fixedPose(id))],
	);
	await ctx.routeWebSocket(
		(u) => u.origin === new URL(BASE).origin.replace(/^http/, "ws"),
		() => {},
	);
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => {
		if (
			m.type() === "error" ||
			m.type() === "warning" ||
			/tiles3d/i.test(m.text())
		)
			errors.push(`[${m.type()}] ${m.text()}`.slice(0, 300));
	});
	const shot = (name) =>
		(process.argv.includes("--page")
			? page
			: page.locator("canvas").first()
		).screenshot({
			path: join(
				OUT,
				`${renderer}-${tiles}-${blend}${arg("bias") ? `-b${arg("bias")}` : ""}-${id}-${name}.png`,
			),
		});
	try {
		const q = new URLSearchParams({ tiles3d: tiles, tiles3dBlend: blend });
		if (process.argv.includes("--nearfield")) q.set("nearfield", "1");
		if (arg("bias")) q.set("tiles3dBias", arg("bias"));
		if (process.argv.includes("--debug")) q.set("tiles3dDebug", "on");
		q.set("renderer", renderer); // always explicit: the app default may be either
		await page.goto(`${BASE}/photo/${id}?${q}`);
		await page.waitForSelector("[data-ready]", {
			state: "attached",
			timeout: 180000,
		});
		await sleep(1500);
		r.sampleBefore = await page.evaluate(() =>
			window.__engine.sampleAt(0.5, 0.5),
		);
		if (process.argv.includes("--nearfield")) {
			// the real flow: near-field splats built by the service, then the panel's Step inside
			q.set("nearfield", "1");
			await page.waitForFunction(() => window.__nearfield, null, {
				timeout: 60000,
			});
			const built = await page.evaluate(async () => {
				const s = await window.__nearfield.build();
				return s ? { splats: s.splats.count, q: s.anchor.quality } : null;
			});
			r.nearfield = built;
			await page.evaluate(() => window.__nearfield.enter());
			if (process.argv.includes("--truth"))
				await page.evaluate(() => window.__nearfield.setTruth(true));
		} else
			await page.evaluate(() =>
				window.__engine.enterStepInside({ radius: 30 }),
			);
		const t0 = Date.now();
		let stats = null;
		for (let i = 0; i < 90; i++) {
			await sleep(1000);
			stats = await page.evaluate(() => {
				const t = window.__engine.tiles3d;
				const set = t?.tiles ?? t?.set ?? null;
				return set
					? {
							stats: set.stats(),
							n: set.geoidN,
							credit: window.__engine.tiles3dAttribution?.(),
							deck: window.__tiles3dDeck ?? null,
						}
					: null;
			});
			if (!stats && i > 4) break;
			const s = stats?.stats ?? [];
			if (
				s.length &&
				s.every((x) => x.loading === 0) &&
				s.some((x) => x.visible > 0) &&
				i > 5
			)
				break;
		}
		r.loadMs = Date.now() - t0;
		r.tiles = stats;
		await shot("0");
		for (const a of turns.filter((t) => t !== 0)) {
			await page.evaluate(
				(deg) => window.__engine.stepCamera?.orbit(deg, 0),
				a,
			);
			await sleep(6000);
			await shot(`turn${a}`);
			await page.evaluate(
				(deg) => window.__engine.stepCamera?.orbit(-deg, 0),
				a,
			);
			await sleep(1500);
		}
		if (process.argv.includes("--perf")) {
			// frames in 4 s while the step camera keeps orbiting (every frame re-renders + re-sorts)
			r.perf = await page.evaluate(
				() =>
					new Promise((res) => {
						const cam = window.__engine.stepCamera;
						let n = 0;
						const times = [];
						let last = performance.now();
						const t0 = last;
						const tick = (t) => {
							times.push(t - last);
							last = t;
							n++;
							cam?.orbit(n % 240 < 120 ? 0.25 : -0.25, 0);
							if (t - t0 < 4000) requestAnimationFrame(tick);
							else {
								times.sort((a, b) => a - b);
								res({
									fps: +((n * 1000) / (t - t0)).toFixed(1),
									p50ms: +times[Math.floor(times.length / 2)].toFixed(1),
									p95ms: +times[Math.floor(times.length * 0.95)].toFixed(1),
								});
							}
						};
						requestAnimationFrame(tick);
					}),
			);
		}
		r.creditDom = await page
			.locator("[data-tiles3d-credit]")
			.textContent()
			.catch(() => null);
		r.sampleAfter = await page.evaluate(() =>
			window.__engine.sampleAt(0.5, 0.5),
		);
		r.sampleSame =
			JSON.stringify(r.sampleBefore) === JSON.stringify(r.sampleAfter);
	} catch (e) {
		r.error = String(e);
	}
	r.errors = errors.slice(0, 40);
	console.log(JSON.stringify(r, null, 1));
	await ctx.close();
}
await browser.close();
writeFileSync(
	join(OUT, `report-${renderer}-${tiles}-${blend}.json`),
	JSON.stringify(report, null, 1),
);
