#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WAG W1.6 gate: WebGpuEngine releases the silhouette re-rank's 384 px sources SIL_IDLE_MS (2 s)
// after the last autoAlign; the next autoAlign re-creates them. This checks that the re-created
// sources give the same result, bit for bit. Per photo (/photo/<id>?renderer=webgpu, after the
// open's own align and verify):
//   A = autoAlign(true), B = autoAlign(true) right after (sources kept: the control; A ≠ B would
//   mean autoAlign itself is not deterministic and the comparison below means nothing),
//   wait 2.5 s (the sources must be gone: engine.silSources is empty),
//   C = autoAlign(true) (sources re-created).
// PASS when B and C are identical: pose, score, confidence and every alternative's pose, score,
// silhouette score and total (JSON of the doubles, which round-trips exactly).
// Under the render lock, with a dev server of the tree under test:
//   node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/sil-release-check.mjs \
//     --url http://localhost:3131 --photos IMG_7086,IMG_6958
import { chromium } from "playwright";
import { openPhoto } from "../gpu/probe-common.mjs";
import { GPU_ARGS } from "./gpu-args.mjs";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", process.env.APP_URL ?? "http://localhost:3131");
const IDS = arg("photos", "IMG_7086,IMG_6958").split(",");

const RUN = async () => {
	const e = window.__engine;
	const pick = (r) =>
		r && {
			pose: r.pose,
			score: r.score,
			confidence: r.confidence,
			alternatives: (r.alternatives ?? []).map((a) => ({
				pose: a.pose,
				score: a.score,
				sil: a.sil,
				total: a.total,
			})),
		};
	const a = pick(await e.autoAlign(true));
	const kept = e.silSources?.length ?? -1;
	const b = pick(await e.autoAlign(true));
	const t0 = performance.now();
	await new Promise((r) => setTimeout(r, 2500));
	const released = e.silSources?.length ?? -1;
	const c = pick(await e.autoAlign(true));
	return {
		a: JSON.stringify(a),
		b: JSON.stringify(b),
		c: JSON.stringify(c),
		kept,
		released,
		waitedMs: performance.now() - t0,
		alternatives: c?.alternatives.length ?? 0,
		silTiming: e.metrics?.().engine?.silhouette ?? null,
	};
};

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
let failures = 0;
try {
	for (const id of IDS) {
		const ctx = await browser.newContext({
			viewport: { width: 1400, height: 900 },
		});
		const page = await ctx.newPage();
		const o = await openPhoto(page, BASE, id, "webgpu");
		const backend = await page.evaluate(() => window.__engine?.backend);
		if (!o.ready || backend !== "webgpu") {
			console.log(`FAIL ${id}: not ready on webgpu (${backend})`);
			failures++;
			await ctx.close();
			continue;
		}
		await page.waitForTimeout(3000);
		const r = await page.evaluate(RUN);
		const control = r.a === r.b;
		const same = r.b === r.c;
		const ok = control && same && r.kept > 0 && r.released === 0;
		if (!ok) failures++;
		console.log(
			`${ok ? "PASS" : "FAIL"} ${id}: ${r.alternatives} alternatives, sources kept ${r.kept} → after 2.5 s ${r.released}; control A=B ${control}; B=C (re-created) ${same}`,
		);
		if (!same) console.log(`  B ${r.b}\n  C ${r.c}`);
		await ctx.close();
	}
} finally {
	await browser.close();
}
console.log(failures ? `FAIL (${failures})` : "PASS sil-release-check");
process.exit(failures ? 1 : 0);
