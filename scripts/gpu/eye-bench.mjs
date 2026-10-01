#!/usr/bin/env node
// W6: pose6dof eye search (refineEyeFromSkyline) on the batched GPU horizon vs the batched CPU horizon vs
// the original per-eye path. Runs src/lib/gpu/eye/bench.ts in headless Chromium (WebGPU) against the
// dev server, on the photos of the lead's eye experiment (out/lead/eye/results.json, Mapterhorn rows:
// eye0 and GPS σ from there; start rotation = ground truth).
//
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/eye-bench.mjs [IMG_xxxx ...]
//
// Env: APP_URL (default http://localhost:3110), MODES (comma list of gpuBatch,gpuSeq,cpuBatch,cpuSeq,cpuJitter;
// default all but cpuJitter = the CPU horizon ±1e-4° noise, to measure the search's own sensitivity).
// Writes out/gpu/w6/eye-bench.json and prints a summary.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = process.env.APP_URL ?? "http://localhost:3110";
const OUT = path.join(ROOT, "out/gpu/w6");
const MODES = process.env.MODES?.split(",");
const gt = JSON.parse(
	fs.readFileSync(path.join(ROOT, "data/ground-truth.json"), "utf8"),
);
const lead = JSON.parse(
	fs.readFileSync(path.join(ROOT, "out/lead/eye/results.json"), "utf8"),
).rows.filter((r) => r.dem === "mapterhorn");
const ids = process.argv.slice(2).length
	? process.argv.slice(2)
	: lead.map((r) => r.name);

const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
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
		const g = gt[id];
		const l = lead.find((r) => r.name === id);
		if (!g?.lat || !g?.f || !l) {
			console.error(`skip ${id}: no GT pose or lead eye row`);
			continue;
		}
		const t0 = Date.now();
		const r = await page.evaluate(
			async (a) => {
				const m = await import("/src/lib/gpu/eye/bench.ts");
				return m.benchEye(a);
			},
			{
				id,
				lat: g.lat,
				lon: g.lon,
				eyeU: l.eye0,
				sigmaH: l.gpsError,
				pose: {
					yaw: g.yaw,
					pitch: g.pitch,
					roll: g.roll,
					f: g.f,
					width: g.width,
					height: g.height,
				},
				img: `/photos/${id}.jpg`,
				modes: MODES,
				// HGRAPH=0: the GPU horizon on the pooled path (A/B against the default command graph)
				graph: process.env.HGRAPH !== "0",
			},
		);
		r.lead = { refinedShift: l.refinedShift, moved: l.moved, ms: l.ms };
		rows.push(r);
		console.log(
			`${id}: ${r.samples} samples, sector ${r.sector.join("..")}°, horizon Δel max ${r.horizonParity.maxDElDeg.toExponential(2)}° (empty≠ ${r.horizonParity.emptyMismatch}); warmup ${r.gpuWarmupMs} ms, cpu horizon ${r.cpuHorizonMs} ms [${((Date.now() - t0) / 1000).toFixed(0)} s]`,
		);
		for (const k of ["gpuBatch", "gpuSeq", "cpuBatch", "cpuSeq", "cpuJitter"]) {
			const x = r[k];
			if (!x) continue;
			const v = r.vsCpuSeq?.[k];
			console.log(
				`  ${k.padEnd(8)} ${String(x.ms).padStart(6)} ms  calls ${x.horizonCalls} hits ${x.cacheHits} batches ${x.provider.batches} (max ${x.provider.maxBatch}) hz ${x.provider.horizonMs} ms | shift ${x.eye.map((e, i) => f(e - (i === 2 ? l.eye0 : 0))).join(",")} moved ${x.moved} cost ${f(x.beforeCost)}→${f(x.afterCost)} rms ${f(x.rmsInlierPx)} px` +
					(v
						? ` | Δeye ${v.dEyeM.toExponential(2)} m Δypr ${v.dYaw.toExponential(1)}/${v.dPitch.toExponential(1)}/${v.dRoll.toExponential(1)}° Δcost ${v.dAfterCost.toExponential(1)} ${v.identical ? "IDENTICAL" : ""}`
						: ""),
			);
		}
		for (const [k, c] of Object.entries(r.crossEval ?? {}))
			console.log(
				`  ${k} eye re-fit: cost gpu-hz ${f(c.gpuCost)} / cpu-hz ${f(c.cpuCost)}`,
			);
		console.log(`  gpu batch ms by size ${JSON.stringify(r.gpuBatchMs)}`);
	}
} finally {
	await browser.close();
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
	path.join(OUT, "eye-bench.json"),
	JSON.stringify(rows, null, 1),
);
console.log(`wrote ${path.join(OUT, "eye-bench.json")}`);
