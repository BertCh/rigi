#!/usr/bin/env node
// W2 gate: GPU pose-grid scoring vs the CPU (align.ts), per photo, in headless Chromium.
//  - grid: max |GPU − CPU| over the 2525 coarse cells (after the prior's sky fit), CPU grid ms vs GPU ms
//  - search: align.autoAlign vs gpu/align autoAlignAsync, exact equality of every hypothesis, ms
//  - engine: engine autoAlign with GPU off vs on (three: autoAlign vs autoAlignAsync; deck: autoAlign
//    under __RIGI_FLAGS__.gpu off/on), final pose Δ and the silhouette re-rank timing (deck stats)
// Usage (under the render lock):
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/w2-align-parity.mjs [--renderer deck]
//     [--url http://localhost:3110] [--out out/gpu/w2/parity-three.json] [IMG_xxxx ...]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const opt = (k, d) => {
	const i = argv.indexOf(k);
	return i >= 0 ? argv.splice(i, 2)[1] : d;
};
const BASE = opt("--url", process.env.APP_URL ?? "http://localhost:3110");
const RENDERER = opt("--renderer", "three");
// --app-gpu on: load the app with the GPU on (other workstreams' kernels, e.g. the GPU horizon, active)
const APP_GPU = opt("--app-gpu", "off");
const OUT = opt("--out", `out/gpu/w2/parity-${RENDERER}.json`);
const IDS = argv.length
	? argv
	: ["IMG_6958", "IMG_7018", "IMG_7063", "IMG_7155"];
const REPS = 5;

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
				m.type() === "error" && logs.push(`error: ${m.text().slice(0, 200)}`),
		);
		await page.addInitScript(() => localStorage.clear());
		// the app itself loads with the GPU off; the test flips __RIGI_FLAGS__.gpu per measurement
		const qs = `?gpu=${APP_GPU}${RENDERER === "deck" ? "&renderer=deck" : ""}`;
		await page.goto(`${BASE}/photo/${id}${qs}`);
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
			async ({ REPS, RENDERER }) => {
				const A = await import("/src/lib/align.ts");
				const G = await import("/src/lib/gpu/align/index.ts");
				const PG = await import("/src/lib/gpu/align/pose-grid.ts");
				const DEV = await import("/src/lib/gpu/device.ts");
				const e = window.__engine;
				const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
				const { horizonDirs: dirs, edge, prior, aspect } = e;
				globalThis.__RIGI_FLAGS__ = { ...globalThis.__RIGI_FLAGS__, gpu: "on" };
				let dirsHash = 0;
				for (let i = 0; i < dirs.length; i++)
					dirsHash = (dirsHash * 31 + Math.round(dirs[i] * 1e6)) | 0;
				const out = {
					nDirs: dirs.length / 3,
					dirsHash,
					edge: [edge.w, edge.h],
				};
				// ---- grid ----
				let t = performance.now();
				const dev = await DEV.getComputeDevice();
				out.deviceMs = performance.now() - t;
				if (!dev) return { ...out, error: "no WebGPU device" };
				A.fitPriorSky(prior, aspect, dirs, edge);
				const { poses } = A.coarseGridPoses(prior, 25);
				t = performance.now();
				let gs = await PG.scorePoseGridGpu(dev, poses, aspect, dirs, edge, 3);
				out.gridGpuColdMs = performance.now() - t;
				const gpuMs = [];
				for (let i = 0; i < REPS; i++) {
					t = performance.now();
					gs = await PG.scorePoseGridGpu(dev, poses, aspect, dirs, edge, 3);
					gpuMs.push(performance.now() - t);
				}
				t = performance.now();
				const cs = poses.map((p) =>
					A.scorePose(p, aspect, dirs, edge, false, 3),
				);
				out.gridCpuMs = performance.now() - t;
				out.gridGpuMs = med(gpuMs);
				let maxErr = 0;
				let sumErr = 0;
				for (let i = 0; i < cs.length; i++) {
					const d = Math.abs(gs[i] - cs[i]);
					maxErr = Math.max(maxErr, d);
					sumErr += d;
				}
				out.grid = {
					cells: cs.length,
					maxAbsErr: maxErr,
					meanAbsErr: sumErr / cs.length,
					tol: G.GRID_TOL,
				};
				// ---- search (align.ts level) ----
				const cpuT = [];
				const gpuT = [];
				let rc;
				let rg;
				for (let i = 0; i < REPS; i++) {
					t = performance.now();
					rc = A.autoAlign(prior, aspect, dirs, edge, 25);
					cpuT.push(performance.now() - t);
					t = performance.now();
					rg = await G.autoAlignAsync(prior, aspect, dirs, edge, 25);
					gpuT.push(performance.now() - t);
				}
				const same = (a, b) =>
					a.length === b.length &&
					a.every(
						(x, i) =>
							x.score === b[i].score &&
							["yaw", "pitch", "roll", "vfov"].every(
								(k) => x.pose[k] === b[i].pose[k],
							),
					);
				out.search = {
					cpuMs: med(cpuT),
					gpuMs: med(gpuT),
					gpuTiming: G.lastAlignTiming,
					hyps: rc.alternatives.length,
					identical: same(rc.alternatives, rg.alternatives),
					confidence: [rc.confidence, rg.confidence],
					cpuPose: rc.pose,
					dYaw: rg.pose.yaw - rc.pose.yaw,
				};
				// ---- engine (search + silhouette re-rank) ----
				const run = async (mode) => {
					globalThis.__RIGI_FLAGS__ = {
						...globalThis.__RIGI_FLAGS__,
						gpu: mode,
					};
					const ts = [];
					let res;
					let sil = null;
					for (let i = 0; i < 3; i++) {
						const t0 = performance.now();
						res =
							RENDERER === "three" && mode === "on"
								? await e.autoAlignAsync(true)
								: await e.autoAlign(true);
						ts.push(performance.now() - t0);
						if (e.stats?.silhouette) sil = { ...e.stats.silhouette };
					}
					return { ms: med(ts), res, sil };
				};
				const off = await run("off");
				const on = await run("on");
				out.engine = {
					offMs: off.ms,
					onMs: on.ms,
					silOff: off.sil,
					silOn: on.sil,
					offPose: off.res.pose,
					onPose: on.res.pose,
					dYaw: on.res.pose.yaw - off.res.pose.yaw,
					dPitch: on.res.pose.pitch - off.res.pose.pitch,
					sameRanking:
						off.res.alternatives.length === on.res.alternatives.length &&
						off.res.alternatives.every(
							(a, i) =>
								a.pose.yaw === on.res.alternatives[i].pose.yaw &&
								a.score === on.res.alternatives[i].score,
						),
					confidence: [off.res.confidence, on.res.confidence],
				};
				globalThis.__RIGI_FLAGS__ = {
					...globalThis.__RIGI_FLAGS__,
					gpu: undefined,
				};
				return out;
			},
			{ REPS, RENDERER },
		);
		rows.push({ id, ...r, logs: logs.slice(0, 5) });
		const s = r.search;
		console.log(
			`${id} [${RENDERER}] dirs ${r.nDirs}#${r.dirsHash} grid cpu ${r.gridCpuMs?.toFixed(1)} ms gpu ${r.gridGpuMs?.toFixed(1)} ms (cold ${r.gridGpuColdMs?.toFixed(1)}, device ${r.deviceMs?.toFixed(1)}) maxErr ${r.grid?.maxAbsErr?.toExponential(2)} | search cpu ${s?.cpuMs.toFixed(1)} gpu ${s?.gpuMs.toFixed(1)} ms rescored ${s?.gpuTiming?.rescored} identical=${s?.identical} | engine off ${r.engine?.offMs.toFixed(1)} on ${r.engine?.onMs.toFixed(1)} ms Δyaw ${r.engine?.dYaw} sameRanking=${r.engine?.sameRanking}${r.error ? ` ERROR ${r.error}` : ""}`,
		);
		await page.close();
	}
} finally {
	await browser.close();
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
	OUT,
	JSON.stringify({ at: new Date().toISOString(), rows }, null, 1),
);
const pass = rows.every(
	(r) =>
		r.search?.identical &&
		Math.abs(r.engine?.dYaw ?? 1) <= 0.01 &&
		r.engine?.sameRanking,
);
console.log(`${pass ? "PASS" : "FAIL"}; wrote ${OUT}`);
process.exit(pass ? 0 : 3);
