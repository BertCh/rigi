#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// solvePose coarse grid on the GPU (src/lib/gpu/solve) vs solvePose / its CPU twin, in headless
// Chromium (WebGPU) against a dev server on this tree.
//
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/solve-bench.mjs [IMG_xxxx ...]
//
// Per photo (default IMG_6958 IMG_7018 IMG_7063 IMG_7131 IMG_7068, from the ablation manifest) and per
// condition (the unknown-pose worker's options: known / nogravity / noheading / none): selected coarse
// pose, seeds and ambiguity GPU vs CPU (must be identical, also with ε × 100 to exercise the bounded
// selection), twin vs solvePose's own SolveResult, grid
// ms GPU (cold, warm) vs CPU, and the grid's share of solvePose's time.
//
// Env: APP_URL (default http://localhost:3110). Writes out/gpu/core/solve-bench.json (small).
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = process.env.APP_URL ?? "http://localhost:3110";
const OUT = path.join(ROOT, "out/gpu/core");
const argv = process.argv.slice(2);
const ids = argv.filter((a) => a.startsWith("IMG_"));
const pick = ids.length
	? ids
	: ["IMG_6958", "IMG_7018", "IMG_7063", "IMG_7131", "IMG_7068"];
const manifest = JSON.parse(
	fs.readFileSync(
		path.join(ROOT, "tools/bench/harness/out/ablation/manifest.json"),
		"utf8",
	),
).filter((e) => pick.includes(e.id));

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

let fail = 0;
try {
	const page = await browser.newPage();
	page.on("console", (m) => {
		if (m.type() === "error" || m.type() === "warning")
			console.error(`[page ${m.type()}]`, m.text().slice(0, 300));
	});
	page.on("pageerror", (e) => console.error("[pageerror]", e.message));
	await page.goto(`${BASE}/favicon.svg`);
	const out = [];
	for (const e of manifest) {
		const r = await page.evaluate(async (entry) => {
			const m = await import("/src/lib/gpu/solve/bench.ts");
			return m.benchPhoto(entry);
		}, e);
		out.push(r);
		if (r.error) {
			console.log(`${e.id}: ${r.error}`);
			fail++;
			continue;
		}
		console.log(
			`${e.id}: scene ${f(r.sceneMs, 0)} ms, pipeline warm ${f(r.warmMs, 0)} ms`,
		);
		for (const c of r.rows) {
			if (c.noSkyline) {
				console.log(`  ${c.cond}: no skyline (${c.solveReject})`);
				continue;
			}
			const ok =
				c.gpuVsCpu &&
				c.stressSame &&
				c.twinVsSolvePose &&
				!c.fellBack &&
				c.fold.same &&
				c.fold.sameStress &&
				c.fold.forcedCpuFold;
			if (!ok) fail++;
			const warm = c.gpu.slice(1).map((g) => g.ms);
			console.log(
				`  ${c.cond.padEnd(9)} ${ok ? "OK  " : "FAIL"} grid ${c.nYaw}×${c.nPitch} obs ${c.nObs} | ` +
					`coarse ${f(c.coarse.yaw, 3)}/${f(c.coarse.pitch, 3)} amb ${f(c.ambiguity, 4)} | ` +
					`gpu=cpu ${c.gpuVsCpu} twin=solvePose ${c.twinVsSolvePose} | rescored ${c.rescored}/${c.nYaw} rows (${c.rescoredCells} cells), ε×100 ${c.stressSame ? "same" : "DIFF"} ${c.stressRescored} rows ` +
					`maxErr/eps ${(c.maxErr / c.eps).toExponential(1)} | CPU grid ${f(c.gridCpuMs)} ms ` +
					`(${f(100 * c.gridFraction)}% of solvePose ${f(c.solvePoseMs)} ms) | ` +
					`GPU cold ${f(c.gpu[0].ms)} warm ${warm.map((x) => f(x)).join("/")} ms ` +
					`(gpu ${f(c.gpu.at(-1).gpuMs)} select ${f(c.gpu.at(-1).selectMs)}) | ` +
					`gpuFold=cpuFold ${c.fold.same} stress ${c.fold.sameStress} forced ${c.fold.forcedCpuFold} digest ${c.fold.digest} cpuFolds ${c.fold.cpuFolds} ` +
					`hz uploads ${c.fold.hzUploads.filter(Boolean).length}/${c.fold.hzUploads.length} read ${c.fold.readBytes} (cpu fold ${c.fold.cpuFoldReadBytes}) B ` +
					`med gpu fold ${f(c.fold.gpuFoldMedMs, 2)} cpu fold ${f(c.fold.cpuFoldMedMs, 2)} ms`,
			);
		}
	}
	const fold = await page.evaluate(async () => {
		const m = await import("/src/lib/gpu/solve/bench.ts");
		return m.benchFold();
	});
	console.log(
		`fold (adversarial blocks, GPU fold vs the CPU fold): ${JSON.stringify(fold)}`,
	);
	if (!fold.ok) fail++;
	out.push({ fold });
	fs.writeFileSync(
		path.join(OUT, "solve-bench.json"),
		JSON.stringify(out, null, 1),
	);
	console.log(fail ? `FAIL (${fail})` : "PASS");
} finally {
	await browser.close();
}
process.exit(fail ? 1 : 0);
