#!/usr/bin/env node

// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
// T6 skyline global search: GPU grid (src/lib/gpu/skyglobal, on its core graph; run to run bit for
// bit) vs the TS CPU twin vs Python
// skyglobal.py, parity + timing on the dumped dev fixtures (out/gpu/skyglobal/<id>/, see
// tools/matcher/gpu_port/dump_skyglobal_fixtures.py). Runs src/lib/gpu/skyglobal/bench.ts in
// headless Chromium (WebGPU) against the private dev server.
//
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/skyglobal-bench.mjs [wc_0001 …]
//
// Env: APP_URL (default http://localhost:3100), REPS (default 3), EPS (px, default 5e-3).
// Writes out/gpu/skyglobal/bench.json and prints one line per photo.
import { APP_URL } from "../lib/harness.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = APP_URL;
const DIR = path.join(ROOT, "out/gpu/skyglobal");
const REPS = Number(process.env.REPS ?? 3);
const EPS = process.env.EPS ? Number(process.env.EPS) : undefined;
const ids = process.argv.slice(2).length
	? process.argv.slice(2)
	: fs
			.readdirSync(DIR)
			.filter((x) => fs.existsSync(path.join(DIR, x, "ref.json")))
			.sort();

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const rows = [];
try {
	const page = await browser.newPage();
	page.on("console", (m) => {
		if (m.type() === "error" || m.type() === "warning")
			console.error(`[page ${m.type()}]`, m.text().slice(0, 300));
	});
	await page.goto(`${BASE}/favicon.svg`);
	for (const id of ids) {
		const t0 = Date.now();
		let r;
		try {
			r = await page.evaluate(
				async (a) => {
					const m = await import("/src/lib/gpu/skyglobal/bench.ts");
					return m.benchPhoto(a);
				},
				{ id, base: `/@fs${DIR}`, reps: REPS, eps: EPS },
			);
		} catch (e) {
			console.error(`${id}: ${String(e).slice(0, 400)}`);
			continue;
		}
		if (r.cands) {
			fs.writeFileSync(
				path.join(DIR, id, "cands.u32"),
				Buffer.from(new Uint32Array(r.cands).buffer),
			);
			r.nCandsSaved = r.cands.length;
			delete r.cands;
		}
		rows.push(r);
		const g = r.gpu;
		if (!g) {
			console.log(`${id}: ${r.error}`);
			continue;
		}
		const gp = g.rerun;
		const gpOk = gp.grid && gp.cells && gp.stats && g.splitReadIdentical;
		if (!gpOk) process.exitCode = 1;
		const h = (x) =>
			x.identical ? "same" : `DIFF ${x.maxPoseDiff.toExponential(1)}`;
		console.log(
			`${id}: ${r.nCombo}×${r.nYaw} | cpu≡py best ${r.cpu.vsPython.bestMaxAbs.toExponential(1)} hyps ${h(r.cpu.vsPython.hyps)} | ` +
				`gpu exact: best ${g.bestMaxAbs.toExponential(1)} argFlips ${g.argFlips} hyps ${h(g.hyps)} cand ${g.nCand} (max ${g.maxCandPerYaw}/yaw) outside ${g.outsideInterval}${g.fellBack ? " FELLBACK" : ""} | ` +
				`plain f32: max ${g.midMaxAbs.toExponential(1)} cells>1e-5 ${g.midCellsOver1e5} winnerFlips ${g.midWinnerFlips} peaks ${g.midPeaksIdentical ? "same" : "DIFF"} hyps ${h(g.midHyps)} | ` +
				`ms: py grid ${r.py.grid} refine ${r.py.refine} · cpu ctor ${r.cpu.ctorMs.toFixed(0)} grid ${r.cpu.gridMs.toFixed(0)} polish ${r.cpu.polishMs.toFixed(0)} · ` +
				`gpu cold ${g.coldMs.toFixed(0)} warm ${g.warmMs.toFixed(1)} (gpu ${g.gpuMs.toFixed(1)} up ${g.uploadMs.toFixed(1)} rescore ${g.rescoreMs.toFixed(1)}) · ` +
				`rerun+split ${gpOk ? "same" : `DIFF ${JSON.stringify(gp)} split ${g.splitReadIdentical}`} [${((Date.now() - t0) / 1000).toFixed(0)} s]`,
		);
	}
} finally {
	await browser.close();
}
fs.writeFileSync(path.join(DIR, "bench.json"), JSON.stringify(rows, null, 1));
console.log(`wrote ${path.join(DIR, "bench.json")}`);
