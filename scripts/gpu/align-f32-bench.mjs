#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WAG W3.3 bench: autoAlign with alignPrecision "f64" (the default: GPU grid + bound-screened f64
// refine) vs "certified-f32" (the opt-in GPU-driven refine, src/lib/gpu/align/cert-refine.ts), per dev
// photo, in headless Chromium on the WebGPU engine (?renderer=webgpu, pinned).
// Decision identity gate: for the photo's prior and `--perturb N` deterministic perturbed priors,
// every alternative's pose (all fields) and score and the confidence of the certified result equal
// the f64 path's AND align.ts autoAlign's (CPU reference) with Object.is; the certified path must have
// run (cert.path "certified-f32"); 0 diffs required.
// Timing: median of REPS alternating f64 / certified-f32 autoAligns at the photo's own prior (whole
// autoAlignAsync, and the part after the grid), with the certified path's submits, double-f32
// re-checks, CPU tie-path decisions and audit re-scores.
// Fault: with alignGpuOptions.certFault (dev builds) every GPU neighbour interval is shifted down by
// 0.05: the runtime checks must catch it (cert.reason "violation"), the call must still return the f64
// result, and the device's certified path must stay off until reset.
// Usage (under the render lock, own dev server on this tree):
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/align-f32-bench.mjs [--url http://localhost:3110]
//     [--perturb 4] [--reps 5] [--out out/gpu/align/f32-bench.json] [IMG_xxxx ...]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const opt = (k, d) => {
	const i = argv.indexOf(k);
	return i >= 0 ? argv.splice(i, 2)[1] : d;
};
const BASE = opt("--url", process.env.APP_URL ?? "http://localhost:3110");
const PERTURB = Number(opt("--perturb", "4"));
const REPS = Number(opt("--reps", "5"));
const OUT = opt("--out", "out/gpu/align/f32-bench.json");
const ROOT = resolve(import.meta.dirname, "../..");
const IDS = argv.length
	? argv
	: Object.keys(
			JSON.parse(
				readFileSync(resolve(ROOT, "data/control-points.json"), "utf8"),
			),
		);

const browser = await chromium.launch({
	headless: true,
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const rows = [];
try {
	for (const id of IDS) {
		const page = await browser.newPage({
			viewport: { width: 1400, height: 900 },
		});
		const logs = [];
		page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
		page.on(
			"console",
			(m) =>
				(m.type() === "error" || m.text().includes("[gpu]")) &&
				logs.push(`${m.type()}: ${m.text().slice(0, 240)}`),
		);
		await page.addInitScript(() => localStorage.clear());
		await page.goto(`${BASE}/photo/${id}?renderer=webgpu`);
		await page.waitForSelector("[data-ready]", {
			state: "attached",
			timeout: 240000,
		});
		await page.waitForFunction(
			() =>
				document.querySelector("[data-ready]")?.getAttribute("data-verify") !==
				"pending",
			null,
			{ timeout: 240000 },
		);
		const r = await page.evaluate(
			async ({ REPS, PERTURB }) => {
				const A = await import("/src/lib/align.ts");
				const G = await import("/src/lib/gpu/align/index.ts");
				const DEV = await import("/src/lib/gpu/core/device.ts");
				const PR = await import("/src/lib/gpu/precision/ieee-probe.ts");
				const e = window.__engine;
				const renderer = document
					.querySelector("[data-renderer]")
					?.getAttribute("data-renderer");
				const dev = await DEV.getComputeDevice();
				if (!dev) return { renderer, error: "no WebGPU device" };
				const { horizonDirs: dirs, aspect } = e;
				const prior0 = e.prior;
				const edge = e.photoPrep ? await e.photoPrep.cpu() : e.edge;
				if (!dirs || !edge) return { renderer, error: "engine not ready" };
				const probe = await PR.probeStrictIeee(dev);
				await G.warmAlignGpu();
				const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
				const diffs = (a, b) => {
					const out = [];
					if (!Object.is(a.confidence, b.confidence)) out.push("confidence");
					if (!Object.is(a.score, b.score)) out.push("score");
					const aa = a.alternatives ?? [];
					const bb = b.alternatives ?? [];
					if (aa.length !== bb.length)
						out.push(`alts ${aa.length}/${bb.length}`);
					aa.forEach((x, i) => {
						const y = bb[i];
						if (!y) return;
						if (!Object.is(x.score, y.score)) out.push(`alt${i}.score`);
						for (const k of ["yaw", "pitch", "roll", "vfov"])
							if (!Object.is(x.pose[k], y.pose[k])) out.push(`alt${i}.${k}`);
					});
					return out;
				};
				// deterministic perturbations (compass ±8°, gravity ±2°, roll ±3°, fov ±6%)
				let seed = 12345;
				const rnd = () => {
					seed = (seed * 1103515245 + 12345) & 0x7fffffff;
					return seed / 0x7fffffff - 0.5;
				};
				const priors = [prior0];
				for (let i = 0; i < PERTURB; i++)
					priors.push({
						...prior0,
						yaw: prior0.yaw + 16 * rnd(),
						pitch: prior0.pitch + 4 * rnd(),
						roll: prior0.roll + 6 * rnd(),
						vfov: prior0.vfov * (1 + 0.12 * rnd()),
					});
				const pick = (c) =>
					c && {
						path: c.path,
						reason: c.reason,
						detail: c.detail,
						ms: c.ms,
						submits: c.stats?.submits,
						decisions: c.stats
							? c.stats.certAccepts +
								c.stats.certRejects +
								c.stats.ties +
								c.stats.unbounded
							: undefined,
						df32: c.stats?.tier2Decided,
						cpuTies: c.stats ? c.stats.ties + c.stats.unbounded : undefined,
						starts: c.stats?.starts,
						windows: c.stats?.windows,
						evals: c.stats?.evals,
						evals2: c.stats?.tier2Evals,
						cpuEvals: c.stats?.cpuEvals,
						audited: c.stats?.audited,
						forced: c.stats?.forced,
						verified: c.stats?.verified,
						gpuMs: c.gpu?.gpuMs,
						uploadBytes: c.gpu?.uploadBytes,
						readBytes: c.gpu?.readBytes,
					};
				G.resetCertified(dev);
				const runs = [];
				for (const prior of priors) {
					const ref = A.autoAlign(prior, aspect, dirs, edge, 25);
					const f64 = await G.autoAlignAsync(prior, aspect, dirs, edge, 25, {
						alignPrecision: "f64",
					});
					const tF = G.lastAlignTiming;
					const cert = await G.autoAlignAsync(prior, aspect, dirs, edge, 25, {
						alignPrecision: "certified-f32",
					});
					const tC = G.lastAlignTiming;
					runs.push({
						prior: {
							yaw: prior.yaw,
							pitch: prior.pitch,
							roll: prior.roll,
							vfov: prior.vfov,
						},
						pose: cert.pose,
						score: cert.score,
						diffCertVsF64: diffs(f64, cert),
						diffCertVsRef: diffs(ref, cert),
						diffF64VsRef: diffs(ref, f64),
						f64Refine: tF.refine,
						certRefine: tC.refine,
						cert: pick(tC.cert),
						error: tC.error,
					});
				}
				// timing at the photo's own prior, alternating
				const ms = {
					f64: [],
					cert: [],
					f64Search: [],
					certSearch: [],
					certGpu: [],
					submits: [],
				};
				for (let i = 0; i < REPS; i++)
					for (const mode of i % 2
						? ["certified-f32", "f64"]
						: ["f64", "certified-f32"]) {
						const t = performance.now();
						await G.autoAlignAsync(prior0, aspect, dirs, edge, 25, {
							alignPrecision: mode,
						});
						const dt = performance.now() - t;
						const tt = G.lastAlignTiming;
						if (mode === "f64") {
							ms.f64.push(dt);
							ms.f64Search.push(tt.searchMs);
						} else {
							ms.cert.push(dt);
							ms.certSearch.push(tt.searchMs);
							ms.certGpu.push(tt.cert?.gpu?.gpuMs ?? Number.NaN);
							ms.submits.push(tt.cert?.stats?.submits ?? Number.NaN);
						}
					}
				// fault injection: every GPU neighbour interval shifted down by 0.05
				const fref = await G.autoAlignAsync(prior0, aspect, dirs, edge, 25, {
					alignPrecision: "f64",
				});
				let fault;
				if (G.alignGpuOptions.certFault === undefined)
					fault = { skipped: "not a dev build" };
				else {
					G.resetCertified(dev);
					G.alignGpuOptions.certFault = 0.05;
					let f1;
					let t1;
					try {
						f1 = await G.autoAlignAsync(prior0, aspect, dirs, edge, 25, {
							alignPrecision: "certified-f32",
						});
						t1 = G.lastAlignTiming;
					} finally {
						G.alignGpuOptions.certFault = 0;
					}
					const f2 = await G.autoAlignAsync(prior0, aspect, dirs, edge, 25, {
						alignPrecision: "certified-f32",
					});
					const t2 = G.lastAlignTiming;
					fault = {
						diffFaulted: diffs(fref, f1),
						diffAfter: diffs(fref, f2),
						reason: t1.cert?.reason ?? null,
						detail: t1.cert?.detail,
						disabledAfter: G.certifiedDisabled(dev),
						reasonAfter: t2.cert?.reason ?? null,
					};
					G.resetCertified(dev);
				}
				return {
					renderer,
					probe: { ok: probe.ok, failures: probe.failures, ms: probe.ms },
					nDirs: dirs.length / 3,
					edge: [edge.w, edge.h],
					runs,
					fault,
					timing: Object.fromEntries(
						Object.entries(ms).map(([k, v]) => [k, med(v)]),
					),
				};
			},
			{ REPS, PERTURB },
		);
		rows.push({ id, ...r, logs: logs.slice(0, 8) });
		if (r.error) console.log(`${id} [${r.renderer}] ERROR ${r.error}`);
		else {
			const nd = r.runs.reduce(
				(a, x) =>
					a +
					x.diffCertVsF64.length +
					x.diffCertVsRef.length +
					x.diffF64VsRef.length,
				0,
			);
			const sum = (f) => r.runs.reduce((a, x) => a + (x.cert?.[f] ?? 0), 0);
			const paths = [...new Set(r.runs.map((x) => x.cert?.path))].join("/");
			console.log(
				`${id} [${r.renderer}] probe ${r.probe.ok} | runs ${r.runs.length} diffs ${nd} path ${paths} | decisions ${sum("decisions")} df32 ${sum("df32")} cpuTies ${sum("cpuTies")} submits ${sum("submits")} cpuEvals ${sum("cpuEvals")} (forced ${sum("forced")}, audited ${sum("audited")}) | autoAlign f64 ${r.timing.f64.toFixed(1)} ms → certified ${r.timing.cert.toFixed(1)} ms (after grid ${r.timing.f64Search.toFixed(1)} → ${r.timing.certSearch.toFixed(1)}, gpu wait ${r.timing.certGpu.toFixed(1)}, submits ${r.timing.submits}) | fault ${r.fault.skipped ?? `reason ${r.fault.reason} diffs ${r.fault.diffFaulted.length}+${r.fault.diffAfter.length} sticks ${r.fault.disabledAfter && r.fault.reasonAfter === "disabled"}`}`,
			);
		}
		await page.close();
	}
} finally {
	await browser.close();
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
	OUT,
	JSON.stringify(
		{ at: new Date().toISOString(), renderer: "webgpu", rows },
		null,
		1,
	),
);
const bad = rows.filter(
	(r) =>
		r.error ||
		r.renderer !== "webgpu" ||
		r.runs.some(
			(x) =>
				x.diffCertVsF64.length ||
				x.diffCertVsRef.length ||
				x.diffF64VsRef.length ||
				x.cert?.path !== "certified-f32",
		) ||
		(!r.fault.skipped &&
			(r.fault.diffFaulted.length ||
				r.fault.diffAfter.length ||
				r.fault.reason !== "violation" ||
				!r.fault.disabledAfter ||
				r.fault.reasonAfter !== "disabled")),
);
console.log(
	`${bad.length ? "FAIL" : "PASS"} (${rows.length} photos); wrote ${OUT}`,
);
process.exit(bad.length ? 3 : 0);
