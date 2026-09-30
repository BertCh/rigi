#!/usr/bin/env node
// Browser check of the photo page's opt-in eye-position suggestion (src/components/EyeSuggestion.tsx).
//
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/eye-ui-check.mjs [IMG_7063]
//
// 1. Flag off vs ?eyesearch=on (no saved pose): no button without the flag; the load pose is identical.
// 2. Saved pose = ground truth (the W6 bench's pose0), ?eyesearch=on: click "Check camera position" and
//    compare the suggestion with out/gpu/w6/eye-bench.json gpuBatch (and ?gpu=off with cpuBatch).
// 3. Apply: the engine re-opens at the moved eye with the re-fitted pose; the saved pose is untouched
//    (bundled photo: session only). Revert: back to the GPS eye and the saved pose.
// Env: APP_URL (default http://localhost:3110), CPU=0 skips the ?gpu=off run. Screenshots: out/gpu/eye-ui/.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = process.env.APP_URL ?? "http://localhost:3110";
const OUT = path.join(ROOT, "out/gpu/eye-ui");
const id = process.argv[2] ?? "IMG_7063";
const gt = JSON.parse(
	fs.readFileSync(path.join(ROOT, "data/ground-truth.json"), "utf8"),
)[id];
const bench = JSON.parse(
	fs.readFileSync(path.join(ROOT, "out/gpu/w6/eye-bench.json"), "utf8"),
).find((r) => r.id === id);
const lead = JSON.parse(
	fs.readFileSync(path.join(ROOT, "out/lead/eye/results.json"), "utf8"),
).rows.find((r) => r.dem === "mapterhorn" && r.name === id);
fs.mkdirSync(OUT, { recursive: true });

const gtPose = {
	yaw: gt.yaw,
	pitch: gt.pitch,
	roll: gt.roll,
	vfov: (2 * Math.atan(gt.height / 2 / gt.f) * 180) / Math.PI,
};
const KEY = `mt-image:pose:${id}`;
const log = (...a) => console.log(...a);
const r3 = (x) => Math.round(x * 1000) / 1000;

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const ok = [];
const check = (name, cond, extra = "") => {
	ok.push(!!cond);
	log(`${cond ? "PASS" : "FAIL"} ${name} ${extra}`);
};
try {
	const ctx = await browser.newContext({
		viewport: { width: 1400, height: 900 },
	});
	const page = await ctx.newPage();
	page.on("console", (m) => {
		if (m.type() === "error") log("[page error]", m.text().slice(0, 300));
	});
	const open = async (q, saved) => {
		await page.goto(`${BASE}/favicon.svg`);
		await page.evaluate(
			([k, v]) => {
				if (v) localStorage.setItem(k, v);
				else localStorage.removeItem(k);
			},
			[KEY, saved ? JSON.stringify(saved) : null],
		);
		await page.goto(`${BASE}/photo/${id}${q}`);
		await page.waitForSelector("[data-ready]", { timeout: 180_000 });
		await page.waitForFunction(
			() => document.querySelector("[data-verify=pending]") == null,
			null,
			{ timeout: 180_000 },
		);
	};
	const poseNow = () =>
		page.evaluate(() => {
			const p = window.__engine.pose;
			return { yaw: p.yaw, pitch: p.pitch, roll: p.roll, vfov: p.vfov };
		});

	// 1. flag off vs on, no saved pose
	await open("", null);
	const offPose = await poseNow();
	const offBtn = await page.getByText("Check camera position").count();
	const offEl = await page.locator("[data-eye-search]").count();
	check("flag off: no button / card", offBtn === 0 && offEl === 0);
	await open("?eyesearch=on", null);
	const onPose = await poseNow();
	check(
		"flag on: load pose identical to flag off",
		JSON.stringify(onPose) === JSON.stringify(offPose),
		JSON.stringify({ offPose, onPose }),
	);
	check(
		"flag on: button shown, idle",
		(await page.locator("[data-eye-search=idle]").count()) === 1,
	);

	// 2. saved pose = GT, run the search
	const runSearch = async (q) => {
		await open(q, gtPose);
		const before = await poseNow();
		const t0 = Date.now();
		await page.getByText("Check camera position").click();
		await page.waitForSelector(
			"[data-eye-search=result], [data-eye-search=error]",
			{ timeout: 300_000 },
		);
		const r = await page.evaluate(() => window.__eyeSearch);
		const after = await poseNow();
		check(
			`${q}: search did not change the pose`,
			JSON.stringify(before) === JSON.stringify(after),
		);
		check(
			`${q}: saved pose untouched`,
			(await page.evaluate((k) => localStorage.getItem(k), KEY)) ===
				JSON.stringify(gtPose),
		);
		log(
			`${q}: ${((Date.now() - t0) / 1000).toFixed(1)} s wall, gpu ${r?.gpu}, moved ${r?.moved}, shift ${r?.shift.map(r3)}, cost ${r3(r?.before.cost)} → ${r3(r?.after.cost)}, meanClipped ${r3(r?.before.meanClippedPx)} → ${r3(r?.after.meanClippedPx)} px, eye0U ${r3(r?.eye0U)}, ${r?.eyesMarched} eyes, ${Math.round(r?.ms)} ms`,
		);
		return r;
	};
	const cmp = (r, b, name, tolM = 0.01) => {
		if (!b) return log(`no bench row ${name}`);
		const dShift = Math.hypot(
			...r.shift.map(
				(x, i) =>
					x - (b.eye[i] - (i === 2 ? r.eye0U : 0)) /* bench eye is ENU abs */,
			),
		);
		log(
			`  bench ${name}: shift ${b.shift.map(r3)} (refined eye ${b.eye.map(r3)}) moved ${b.moved} cost ${r3(b.beforeCost)} → ${r3(b.afterCost)} meanClipped ${r3(b.meanClippedPx)}`,
		);
		check(
			`matches bench ${name}`,
			r.moved === b.moved &&
				dShift < tolM &&
				(tolM > 0.01 ||
					(Math.abs(r.before.cost - b.beforeCost) < 1e-3 &&
						Math.abs(r.after.cost - b.afterCost) < 1e-3)),
			`Δeye ${dShift.toExponential(2)} m`,
		);
	};
	// The same worker with the bench's eye0 (the lead experiment's 2-dp eye0): exact parity. The UI's own
	// eye0 (eyeAltitude on the mosaic DEM, unrounded) differs by mm, and the search's own sensitivity
	// (bench: GPU vs CPU horizon ≈ 1e-4° → 0.86 m) turns that into decimetres.
	const parity = (name) =>
		page
			.evaluate(
				async ([pose, eye0U]) => {
					const c = await import("/src/lib/gpu/eye/client.ts");
					const input = {
						...c.eyeSearchInput(window.__engine.photo, pose),
						eye0U,
					};
					return c.startEyeSearch(input, () => {});
				},
				[gtPose, lead.eye0],
			)
			.then((x) => {
				log(
					`${name} parity run (eye0U ${lead.eye0}): shift ${x.shift.map(r3)} cost ${r3(x.before.cost)} → ${r3(x.after.cost)}, ${x.samples} samples`,
				);
				return x;
			});
	const r = await runSearch("?eyesearch=on");
	cmp(r, bench?.gpuBatch, "gpuBatch (UI eye0)", 1);
	cmp(await parity("gpu"), bench?.gpuBatch, "gpuBatch (bench eye0)");
	await page
		.locator("aside")
		.locator("[data-eye-search]")
		.screenshot({ path: path.join(OUT, `${id}-suggestion.png`) });

	// 3. Apply, then Revert
	if (r?.moved) {
		const eye0 = await page.evaluate(() => ({
			lat: window.__engine.photo.lat,
			lon: window.__engine.photo.lon,
			eyeAlt: window.__engine.eyeAlt,
		}));
		await page.getByRole("button", { name: "Apply" }).click();
		await page.waitForFunction(
			(lat) => window.__engine?.photo.lat !== lat,
			eye0.lat,
			{ timeout: 60_000 },
		);
		await page.waitForSelector("[data-ready]", { timeout: 180_000 });
		const applied = await page.evaluate(() => ({
			lat: window.__engine.photo.lat,
			lon: window.__engine.photo.lon,
			eyeAlt: window.__engine.eyeAlt,
			pose: window.__engine.pose,
		}));
		const mPerLat = (6371008.8 * Math.PI) / 180;
		const dN = (applied.lat - eye0.lat) * mPerLat;
		const dE =
			(applied.lon - eye0.lon) * mPerLat * Math.cos((eye0.lat * Math.PI) / 180);
		log(
			`applied: engine eye moved E ${r3(dE)} N ${r3(dN)} m, eyeAlt ${r3(eye0.eyeAlt)} → ${r3(applied.eyeAlt)} (suggested h ${r3(r.eye.h)}); pose ${JSON.stringify(applied.pose)}`,
		);
		check(
			"apply: engine at the suggested eye with the re-fitted pose",
			Math.abs(dE - r.shift[0]) < 0.1 &&
				Math.abs(dN - r.shift[1]) < 0.1 &&
				Math.abs(applied.eyeAlt - Math.max(r.eye.h, applied.eyeAlt)) < 1e-6 &&
				Math.abs(applied.pose.yaw - r.pose.yaw) < 1e-9 &&
				Math.abs(applied.pose.pitch - r.pose.pitch) < 1e-9,
		);
		check(
			"apply (bundled): saved pose untouched",
			(await page.evaluate((k) => localStorage.getItem(k), KEY)) ===
				JSON.stringify(gtPose),
		);
		await page
			.locator("aside section")
			.filter({ hasText: "GPS accuracy" })
			.screenshot({ path: path.join(OUT, `${id}-applied.png`) });
		await page.getByText("Revert position").click();
		await page.waitForFunction(
			(lat) => window.__engine?.photo.lat === lat,
			eye0.lat,
			{ timeout: 60_000 },
		);
		await page.waitForSelector("[data-ready]", { timeout: 180_000 });
		const back = await page.evaluate(() => ({
			eyeAlt: window.__engine.eyeAlt,
			pose: window.__engine.pose,
		}));
		check(
			"revert: GPS eye and saved pose back",
			back.eyeAlt === eye0.eyeAlt &&
				Math.abs(back.pose.yaw - gtPose.yaw) < 1e-9 &&
				Math.abs(back.pose.pitch - gtPose.pitch) < 1e-9,
		);
	}

	if (process.env.CPU !== "0") {
		const rc = await runSearch("?eyesearch=on&gpu=off");
		check("gpu=off ran on the CPU", rc?.gpu === false);
		cmp(rc, bench?.cpuBatch, "cpuBatch (UI eye0)", 2);
		cmp(await parity("cpu"), bench?.cpuBatch, "cpuBatch (bench eye0)");
	}
} finally {
	await browser.close();
}
log(`${ok.filter(Boolean).length}/${ok.length} checks passed`);
process.exit(ok.every(Boolean) ? 0 : 1);
