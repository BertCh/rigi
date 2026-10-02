// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The basin-gap grid's GPU coarse rotation search (src/lib/matcher/basin-gpu.ts: SCORE + TOP3 on one
// compute graph, float32, only the winners read back) against rotSearchCpu (float64) on the 9 x 9 grid
// of the synthetic "agree" / "disagree" scenarios of basin.spec.ts. Reports the per-node agreement of
// the top-1 and of all 3 indices, the max |d score| of the top-1 and the warm wall time of both.
// Asserts: top-1 index equal on >= 79/81 nodes, max |d score| <= 1e-4, and basinGap(prob, { scorer:
// rotSearchGpu }) within 2 % of the CPU gap with the same best / second nodes.
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/basin-grid-dawn.ts
//
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on any failure.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Pose } from "../../src/lib/camera";
import {
	horizonElevationDeg,
	makeScenario,
	SCENARIOS,
} from "../../src/lib/matcher/__tests__/fixtures/synth";
import {
	arangeLen,
	type BasinDem,
	basinEye,
	basinGap,
	basinProblem,
	deltaDirs,
	GRID_N,
	GRID_R,
	rotCandidates,
	rotSearchCpu,
} from "../../src/lib/matcher/basin";
import { skylineFromArrays } from "../../src/lib/matcher/fusion";
import { DEG, focalPx } from "../../src/lib/matcher/geometry";

const ID = "basin-grid-dawn";
const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log(`SKIP ${ID}: DAWN_DIR not set`);
	process.exit(0);
}
const { create, globals } = await import(
	pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
// keep the instance referenced: Dawn drops pipelines of a collected instance
const gpu = create([]);
Object.defineProperty(globalThis, "navigator", {
	value: { gpu, userAgent: "node" },
	configurable: true,
});
const adapter = await gpu.requestAdapter();
if (!adapter) {
	console.log(`SKIP ${ID}: no adapter`);
	process.exit(0);
}
const { luma } = await import("@luma.gl/core");
const { webgpuAdapter } = await import("@luma.gl/webgpu");
const device = await luma.createDevice({
	type: "webgpu",
	adapters: [webgpuAdapter],
	createCanvasContext: false,
} as never);
const { rotSearchGpu, releaseBasinGpu } = await import(
	"../../src/lib/matcher/basin-gpu"
);
console.log(`adapter ${JSON.stringify(adapter.info ?? {})}`);

let failed = 0;
const fail = (m: string) => {
	failed++;
	console.log(`  FAIL ${m}`);
};

// make_basin_fixtures.py FakeDem (as basin.spec.ts)
const fakeDem: BasinDem = {
	ground: (e, n) =>
		1200.0 +
		0.05 * e -
		0.03 * n +
		20.0 * Math.sin(e / 300.0) * Math.cos(n / 400.0),
	async horizons(eyes, az0, az1, step) {
		const n = arangeLen(az0, az1 + step * 0.5, step);
		return eyes.map(([E, N, Z]) =>
			Float64Array.from({ length: n }, (_, k) => {
				const a = (az0 + k * step) * DEG;
				return (
					horizonElevationDeg(a) +
					0.002 * (E * Math.cos(3 * a) - N * Math.sin(2 * a)) +
					0.001 * (Z - 1500.0)
				);
			}),
		);
	},
};
const REF = JSON.parse(
	readFileSync(
		new URL(
			"../../src/lib/matcher/__tests__/fixtures/basin.json",
			import.meta.url,
		),
		"utf8",
	),
) as Record<string, { eye0: number[]; pose0: Pose }>;

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const scorer = rotSearchGpu(device);
let worstTop1 = 81;
let worstDs = 0;

for (const name of Object.keys(REF)) {
	const p = SCENARIOS.find((s) => s.name === name);
	if (!p) throw new Error(name);
	const s = makeScenario(p);
	const sk = skylineFromArrays(p.w, p.h, s.fine, s.fg, s.sky, s.dirs, {
		pose: p.appPose,
	});
	const ref = REF[name];
	const prob = await basinProblem({
		W: p.W,
		H: p.H,
		sk,
		corr: { x2d: s.x2d, X: s.X, W: p.W, H: p.H },
		eye0: ref.eye0,
		pose0: ref.pose0,
		focalKnown: true,
		regime: "manual",
		dem: fakeDem,
	});
	const step = (2 * GRID_R) / (GRID_N - 1);
	const eyes = [];
	for (let i = 0; i < GRID_N; i++)
		for (let j = 0; j < GRID_N; j++)
			eyes.push(
				basinEye(
					prob,
					prob.eye0[0] - GRID_R + i * step,
					prob.eye0[1] - GRID_R + j * step,
					prob.aglRef,
				),
			);
	const profs = await fakeDem.horizons(eyes, prob.az0, prob.az1, prob.azstep);
	const dirs = profs.map((py) => deltaDirs(prob, py));
	const cands = rotCandidates(prob, prob.pose0);
	const f = focalPx(prob.pose0.vfov, p.H);
	const args = [dirs, cands, prob.sk, p.W, p.H, f] as const;
	const cpu = await rotSearchCpu(...args);
	const gpuH = await scorer(...args);
	let top1 = 0;
	let all3 = 0;
	let dScore = 0;
	for (let n = 0; n < cpu.length; n++) {
		const a = cpu[n].map((h) => h.index);
		const b = gpuH[n].map((h) => h.index);
		if (a[0] === b[0]) top1++;
		if (a.length === b.length && a.every((v, i) => v === b[i])) all3++;
		if (cpu[n][0] && gpuH[n][0])
			dScore = Math.max(dScore, Math.abs(cpu[n][0].score - gpuH[n][0].score));
	}
	worstTop1 = Math.min(worstTop1, top1);
	worstDs = Math.max(worstDs, dScore);
	const time = async (fn: () => Promise<unknown>) => {
		const ts: number[] = [];
		for (let i = 0; i < 5; i++) {
			const t = performance.now();
			await fn();
			ts.push(performance.now() - t);
		}
		return med(ts);
	};
	const tCpu = await time(() => rotSearchCpu(...args));
	const tGpu = await time(() => scorer(...args));
	console.log(
		`${name}: ${cpu.length} nodes x ${cands.length} cands x ${dirs[0].length / 3} dirs; top-1 index ${top1}/${cpu.length}, all 3 ${all3}/${cpu.length}, max |d score| top-1 ${dScore.toExponential(2)}; warm CPU ${tCpu.toFixed(1)} ms, GPU ${tGpu.toFixed(1)} ms`,
	);
	if (top1 < cpu.length - 2)
		fail(`${name}: top-1 agreement ${top1}/${cpu.length}`);
	if (dScore > 1e-4) fail(`${name}: max |d score| ${dScore}`);
	const gc = await basinGap(prob);
	const gg = await basinGap(prob, { scorer, scorerName: "gpu" });
	const same = (
		a: { E: number; N: number } | null | undefined,
		b: { E: number; N: number } | null | undefined,
	) => a?.E === b?.E && a?.N === b?.N;
	const rel =
		gc.gap != null && gg.gap != null
			? Math.abs(gg.gap - gc.gap) / Math.max(Math.abs(gc.gap), 1e-9)
			: Number.NaN;
	console.log(
		`  basinGap cpu ${gc.gap?.toFixed(5)} (${gc.ms} ms) gpu ${gg.gap?.toFixed(5)} (${gg.ms} ms), rel ${rel.toExponential(2)}, best same ${same(gc.grid?.best, gg.grid?.best)}, second same ${same(gc.grid?.second, gg.grid?.second)}`,
	);
	if (!(rel <= 0.02)) fail(`${name}: gap rel diff ${rel}`);
	if (!same(gc.grid?.best, gg.grid?.best)) fail(`${name}: best node differs`);
	if (!same(gc.grid?.second, gg.grid?.second))
		fail(`${name}: second node differs`);
}

await releaseBasinGpu(device);
if (failed) {
	console.log(`FAIL ${ID}: ${failed} failure(s)`);
	process.exit(1);
}
console.log(
	`PASS ${ID} (worst top-1 agreement ${worstTop1}, max |d score| ${worstDs.toExponential(2)})`,
);
process.exit(0);
