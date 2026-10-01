#!/usr/bin/env node
// autoAlign refine A/B: GPU-bound-screened refine (gpu/align autoAlignAsync, refine "gpu") vs the
// plain CPU refine, per photo, in headless Chromium. Exactness gate: every alternative's pose
// (all fields) and score, plus the confidence, compared with Object.is. 0 diffs required.
//  - ref:  align.autoAlign (CPU grid + CPU refine), the reference
//  - cpu:  autoAlignAsync {refine: "cpu"} (GPU grid + CPU refine: the app before this change)
//  - gpu:  autoAlignAsync {refine: "gpu"} (GPU grid + bound-screened refine)
// Each photo runs at its prior and at `--perturb N` deterministic perturbed priors (more descent
// trajectories). With --check-bounds every certified bound is checked against the exact CPU score
// (bound ≥ score; violations must be 0) and the slack is summarised. Timing: median of REPS
// alternating cpu/gpu runs at the photo's own prior.
// `--graph on|off` (default on) selects the GPU kernels' path (alignGpuOptions.graph: core ComputeGraph
// or the pooled single dispatches); with --check-bounds every bound batch is also run on the OTHER path
// and compared with Object.is (graph vs pooled bounds must be identical: pathDiffs 0), and the gpu
// refine is re-run on the other path (diffOtherPath: 0 diffs required).
// Usage (under the render lock, own dev server):
//   node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/align-refine-ab.mjs [--url http://localhost:3123]
//     [--renderer three|deck] [--perturb 6] [--check-bounds] [--graph on|off] [--out out/gpu/align/refine-ab.json] [IMG_xxxx ...]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const opt = (k, d) => {
	const i = argv.indexOf(k);
	return i >= 0 ? argv.splice(i, 2)[1] : d;
};
const flag = (k) => {
	const i = argv.indexOf(k);
	if (i >= 0) argv.splice(i, 1);
	return i >= 0;
};
const BASE = opt("--url", process.env.APP_URL ?? "http://localhost:3110");
const RENDERER = opt("--renderer", "three");
const PERTURB = Number(opt("--perturb", "6"));
const OUT = opt("--out", "out/gpu/align/refine-ab.json");
const CHECK = flag("--check-bounds");
const GRAPH = opt("--graph", "on") !== "off";
const REPS = 5;
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
				m.type() === "error" && logs.push(`error: ${m.text().slice(0, 200)}`),
		);
		await page.addInitScript(() => localStorage.clear());
		// the app loads with the GPU off (nothing else on the device); the test turns it on
		await page.goto(`${BASE}/photo/${id}?gpu=off&renderer=${RENDERER}`);
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
			async ({ REPS, PERTURB, CHECK, GRAPH }) => {
				const A = await import("/src/lib/align.ts");
				const G = await import("/src/lib/gpu/align/index.ts");
				const PB = await import("/src/lib/gpu/align/pose-bound.ts");
				const DEV = await import("/src/lib/gpu/device.ts");
				const e = window.__engine;
				const { horizonDirs: dirs, edge, aspect } = e;
				const prior0 = e.prior;
				globalThis.__RIGI_FLAGS__ = { ...globalThis.__RIGI_FLAGS__, gpu: "on" };
				const dev = await DEV.getComputeDevice();
				if (!dev) return { error: "no WebGPU device" };
				await G.warmAlignGpu();
				G.alignGpuOptions.graph = GRAPH;
				const other = { graph: !GRAPH };
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
						const keys = new Set([
							...Object.keys(x.pose),
							...Object.keys(y.pose),
						]);
						for (const k of keys)
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
				const runs = [];
				const bc = {
					eps: [],
					checked: 0,
					violations: 0,
					minSlack: Infinity,
					slacks: [],
					pathDiffs: 0,
				};
				for (const prior of priors) {
					const rsRef = A.newRefineStats();
					const ref = A.autoAlign(
						prior,
						aspect,
						dirs,
						edge,
						25,
						undefined,
						rsRef,
					);
					const cpu = await G.autoAlignAsync(prior, aspect, dirs, edge, 25, {
						refine: "cpu",
					});
					const tCpu = G.lastAlignTiming;
					const gpu = await G.autoAlignAsync(prior, aspect, dirs, edge, 25, {
						refine: "gpu",
					});
					const tGpu = G.lastAlignTiming;
					const run = {
						prior: {
							yaw: prior.yaw,
							pitch: prior.pitch,
							roll: prior.roll,
							vfov: prior.vfov,
						},
						refPose: ref.pose,
						refScore: ref.score,
						diffGpuVsCpu: diffs(cpu, gpu),
						diffGpuVsRef: diffs(ref, gpu),
						diffCpuVsRef: diffs(ref, cpu),
						refStats: rsRef,
						cpuStats: tCpu.refineStats,
						gpuStats: tGpu.refineStats,
						gpuPath: tGpu.refine,
						bound: tGpu.boundStats,
						error: tGpu.error,
					};
					if (CHECK) {
						// re-run the bounded refine with a checking provider: each bound vs the exact score
						const session = PB.poseBoundSession(
							dev,
							aspect,
							dirs,
							edge,
							undefined,
							{
								graph: GRAPH,
							},
						);
						const twin = PB.poseBoundSession(
							dev,
							aspect,
							dirs,
							edge,
							undefined,
							other,
						);
						const checked = async (probes) => {
							const ub = await session(probes);
							// the same batch on the other path (graph vs pooled): identical bounds
							const ub2 = await twin(probes);
							probes.forEach((_, i) => {
								const a = ub[i];
								const b = ub2[i];
								if (
									!a !== !b ||
									(a && (!Object.is(a.ub, b.ub) || !Object.is(a.eps, b.eps)))
								)
									bc.pathDiffs++;
							});
							probes.forEach((q, i) => {
								if (ub[i] === undefined) return;
								bc.eps.push(ub[i].eps);
								const s = A.scorePose(q.pose, aspect, dirs, edge, q.fine, 1);
								bc.checked++;
								const slack = ub[i].ub - s;
								if (!(slack >= 0)) bc.violations++;
								bc.minSlack = Math.min(bc.minSlack, slack);
								if (bc.slacks.length < 200000) bc.slacks.push(slack);
							});
							return ub;
						};
						A.fitPriorSky(prior, aspect, dirs, edge);
						const { poses } = A.coarseGridPoses(prior, 25);
						const PG = await import("/src/lib/gpu/align/pose-grid.ts");
						const scores = await PG.scorePoseGridGpu(
							dev,
							poses,
							aspect,
							dirs,
							edge,
							3,
							undefined,
							{ graph: GRAPH },
						);
						const chk = await A.autoAlignRefined(
							prior,
							aspect,
							dirs,
							edge,
							25,
							{ scores, tol: G.GRID_TOL, skyFitted: true },
							checked,
						);
						run.diffCheckedVsCpu = diffs(cpu, chk);
						const oth = await G.autoAlignAsync(prior, aspect, dirs, edge, 25, {
							refine: "gpu",
							...other,
						});
						run.diffOtherPath = diffs(gpu, oth);
					}
					runs.push(run);
				}
				// timing at the photo's own prior, alternating
				const ms = {
					cpu: [],
					gpu: [],
					cpuSearch: [],
					gpuSearch: [],
					gpuWait: [],
					verified: [],
					verifyMs: [],
				};
				for (let i = 0; i < REPS; i++)
					for (const mode of i % 2 ? ["gpu", "cpu"] : ["cpu", "gpu"]) {
						const t = performance.now();
						await G.autoAlignAsync(prior0, aspect, dirs, edge, 25, {
							refine: mode,
						});
						ms[mode].push(performance.now() - t);
						ms[`${mode}Search`].push(G.lastAlignTiming.searchMs);
						if (mode === "gpu") {
							ms.gpuWait.push(G.lastAlignTiming.boundStats.gpuMs);
							ms.verified.push(G.lastAlignTiming.refineStats.verified);
							ms.verifyMs.push(G.lastAlignTiming.refineStats.verifyMs);
						}
					}
				// fault injection: every GPU bound deflated by 1 → a verified skip must expose it; the
				// call must still return the exact CPU result and the device's GPU refine must stay off
				G.resetGpuRefine(dev);
				const fref = A.autoAlign(prior0, aspect, dirs, edge, 25);
				G.alignGpuOptions.faultDeflate = 1;
				let f1;
				let t1;
				try {
					f1 = await G.autoAlignAsync(prior0, aspect, dirs, edge, 25, {
						refine: "gpu",
					});
					t1 = G.lastAlignTiming;
				} finally {
					G.alignGpuOptions.faultDeflate = 0;
				}
				const f2 = await G.autoAlignAsync(prior0, aspect, dirs, edge, 25, {
					refine: "gpu",
				});
				const t2 = G.lastAlignTiming;
				const fault = {
					diffFaulted: diffs(fref, f1),
					diffAfter: diffs(fref, f2),
					violation: t1.violation ?? null,
					pathFaulted: t1.refine,
					disabledAfter: G.gpuRefineDisabled(dev),
					pathAfter: t2.refine,
				};
				G.resetGpuRefine(dev);
				G.alignGpuOptions.graph = true;
				globalThis.__RIGI_FLAGS__ = {
					...globalThis.__RIGI_FLAGS__,
					gpu: undefined,
				};
				const slacks = bc.slacks.sort((a, b) => a - b);
				return {
					nDirs: dirs.length / 3,
					edge: [edge.w, edge.h],
					runs,
					fault,
					// verification cost: the device's first refine (its first VERIFY_FIRST skips) and steady state
					firstVerify: {
						verified: runs[0].gpuStats.verified,
						ms: runs[0].gpuStats.verifyMs,
					},
					timing: Object.fromEntries(
						Object.entries(ms).map(([k, v]) => [k, med(v)]),
					),
					boundCheck: CHECK
						? {
								checked: bc.checked,
								violations: bc.violations,
								minSlack: bc.minSlack,
								medSlack: slacks[slacks.length >> 1],
								p10Slack: slacks[Math.floor(slacks.length * 0.1)],
								pathDiffs: bc.pathDiffs,
								medEps: bc.eps.sort((a, b) => a - b)[bc.eps.length >> 1],
							}
						: undefined,
				};
			},
			{ REPS, PERTURB, CHECK, GRAPH },
		);
		rows.push({ id, ...r, logs: logs.slice(0, 5) });
		if (r.error) {
			console.log(`${id} ERROR ${r.error}`);
		} else {
			const nd = r.runs.reduce(
				(a, x) =>
					a +
					x.diffGpuVsCpu.length +
					x.diffGpuVsRef.length +
					(x.diffCheckedVsCpu?.length ?? 0) +
					(x.diffOtherPath?.length ?? 0),
				0,
			);
			const sum = (k, f) => r.runs.reduce((a, x) => a + (x[k]?.[f] ?? 0), 0);
			console.log(
				`${id} runs ${r.runs.length} diffs ${nd} | iters cpu ${sum("cpuStats", "iters")} gpu ${sum("gpuStats", "iters")} | cpu scorePose ${sum("cpuStats", "cpuEvals")} → ${sum("gpuStats", "cpuEvals")} (skipped ${sum("gpuStats", "skipped")}, rounds ${sum("gpuStats", "rounds")}) | autoAlign cpu-refine ${r.timing.cpu.toFixed(1)} ms → gpu-refine ${r.timing.gpu.toFixed(1)} ms (search ${r.timing.cpuSearch.toFixed(1)} → ${r.timing.gpuSearch.toFixed(1)}, gpu wait ${r.timing.gpuWait.toFixed(1)})| verify first ${r.firstVerify.verified} (${r.firstVerify.ms.toFixed(2)} ms) steady ${r.timing.verified} (${r.timing.verifyMs.toFixed(2)} ms) | fault diffs ${r.fault.diffFaulted.length}+${r.fault.diffAfter.length} viol ${!!r.fault.violation} sticks ${r.fault.disabledAfter && r.fault.pathAfter === "cpu"}${r.boundCheck ? ` | bounds ${r.boundCheck.checked} viol ${r.boundCheck.violations} pathDiffs ${r.boundCheck.pathDiffs} minSlack ${r.boundCheck.minSlack.toExponential(2)} med ${r.boundCheck.medSlack?.toExponential(2)}` : ""}`,
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
		{ at: new Date().toISOString(), renderer: RENDERER, rows },
		null,
		1,
	),
);
const bad = rows.filter(
	(r) =>
		r.error ||
		r.runs.some(
			(x) =>
				x.diffGpuVsCpu.length ||
				x.diffGpuVsRef.length ||
				x.diffCheckedVsCpu?.length ||
				x.diffOtherPath?.length ||
				x.gpuPath !== "gpu",
		) ||
		r.boundCheck?.violations ||
		r.boundCheck?.pathDiffs ||
		r.fault.diffFaulted.length ||
		r.fault.diffAfter.length ||
		!r.fault.violation ||
		r.fault.pathFaulted !== "cpu" ||
		!r.fault.disabledAfter ||
		r.fault.pathAfter !== "cpu",
);
console.log(
	`${bad.length ? "FAIL" : "PASS"} (${rows.length} photos); wrote ${OUT}`,
);
process.exit(bad.length ? 3 : 0);
