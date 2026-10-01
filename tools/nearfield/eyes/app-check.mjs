#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// In-app check of the refineEyes step (src/lib/nearfield/roll: spot.refineSpotEyes + roll-spot.buildRollSpot):
// the real /roll map, the measured IMG_7059/IMG_7063 pair from tools/nearfield/eyes/results.json, per-photo
// MoGe-2 depth. Compares the app's refined eyes with the Python solution and reports the anchor quality and
// near-field fraction at the GPS vs the refined eyes. Also checks that the step is a no-op when off.
//
//   node scripts/gpu/with-render-lock.mjs -- node tools/nearfield/eyes/app-check.mjs
// Needs the private vite (:3110) and the near-field service (:8767). Writes tools/nearfield/eyes/app-check.json.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const URL0 = process.env.APP_URL ?? "http://localhost:3110";
const HERE = import.meta.dirname;
const res = JSON.parse(readFileSync(resolve(HERE, "results.json"), "utf8"));
const it = res.iterations.at(-1);
const pairs = it.pairs
	.filter((p) => p.ok)
	.map((p) => ({
		a: p.A,
		b: p.B,
		ok: true,
		t: p.t,
		info: p.info.flat(),
		baselineM: p.baselineM,
		used: p.used,
		inliers: p.inliers,
		nearInliers: p.nearInliers,
		medPx: p.medPx,
		relRotCorrDeg: p.relRotCorrDeg,
		focalScale: p.focalScale,
		gpsDist: p.gpsDist,
	}));
const ids = ["IMG_7059", "IMG_7063"];
const browser = await chromium.launch({
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const t0 = Date.now();
const log = (...a) =>
	console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
try {
	const page = await browser.newPage({
		viewport: { width: 1200, height: 800 },
	});
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(`${URL0}/roll/region-0?view=map&photo=IMG_7063`);
	await page.waitForSelector('[data-testid="roll-map"][data-stage="ready"]', {
		timeout: 600_000,
	});
	log("map ready");
	const out = await page.evaluate(
		async ({ ids, pairs }) => {
			const m = await import("/src/lib/nearfield/roll/roll-spot.ts");
			const e = window.__roll;
			const run = async (refine) => {
				const s = await m.buildRollSpot(e, ids, {
					depth: "moge2",
					refineEyes: refine,
					eyePairs: pairs.map((p) => ({ ...p })),
				});
				return {
					eyes: s.inputs.map((v) => v.eye),
					views: s.views.map((v) => ({
						id: v.id,
						q: v.anchor.quality,
						counts: v.split.counts,
						splats: v.splats,
						skipped: v.skipped ?? null,
					})),
					nearFrac: s.inputs.map((v) => {
						let n = 0;
						for (const r of v.range.data) if (r > 0 && r <= 150) n++;
						return n / v.range.data.length;
					}),
					count: s.cloud.count,
					solve: s.eyes
						? {
								offsets: s.eyes.offsets,
								pairsUsed: s.eyes.pairsUsed,
								gates: s.eyes.pairs.map((p) => [
									p.a,
									p.b,
									p.gate,
									p.why ?? null,
								]),
							}
						: null,
				};
			};
			return { off: await run(false), on: await run(true) };
		},
		{ ids, pairs },
	);
	const py = it.solution.eyes;
	out.pythonEyes = Object.fromEntries(ids.map((k) => [k, py[k]]));
	out.eyeDiffM = out.on.eyes.map((e, k) => {
		const p = py[ids[k]];
		return Math.hypot(e[0] - p[0], e[1] - p[1], e[2] - p[2]);
	});
	out.errors = errors.slice(0, 10);
	writeFileSync(resolve(HERE, "app-check.json"), JSON.stringify(out, null, 1));
	log(JSON.stringify(out, null, 1));
} finally {
	await browser.close();
}
