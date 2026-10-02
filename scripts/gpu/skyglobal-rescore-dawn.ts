// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU re-score of the skyglobal candidates (gridGpu rescore: "gpu": RESCORE + PICK on the compute
// graph, float32) against the CPU twin (SkyGlobal.gridCpu, float64) on the synthetic ridge scenes of
// skyglobal-compaction-dawn.ts. Reports the arg agreement fraction, the max relative |d best| and
// whether searchGpu's top hypotheses (after polish) match SkyGlobal.search's. Asserts: arg agreement
// >= 0.99, top-1 hypothesis within 0.05 deg yaw / pitch / roll, max relative |d best| <= 1e-4, no
// fallback, and that only the count + per-yaw results are read back.
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/skyglobal-rescore-dawn.ts
//
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on any failure.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gridGpu, searchGpu } from "../../src/lib/gpu/skyglobal";
import {
	camera,
	type EdgeInputs,
	type GridPlan,
	SkyGlobal,
} from "../../src/lib/gpu/skyglobal/cpu";

const ID = "skyglobal-rescore-dawn";
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
	// subgroups (REDUCE_SG) when the adapter has them
	requestedFeatures: adapter.features.has("subgroups") ? ["subgroups"] : [],
} as never);
console.log(
	`adapter ${JSON.stringify(adapter.info ?? {})} subgroups: ${adapter.features.has("subgroups")} maxWG/dim ${device.limits.maxComputeWorkgroupsPerDimension}`,
);

let failed = 0;
const fail = (m: string) => {
	failed++;
	console.log(`  FAIL ${m}`);
};

// seeded synthetic ridge scenes (the scene() of __tests__/cpu.spec.ts, with a seed and a size)
const D = Math.PI / 180;
function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}
function scene(seed: number, W: number, H: number, truthYaw: number) {
	const rand = rng(seed);
	const ph = [rand() * 6, rand() * 6, rand() * 6];
	const ridge = (az: number) =>
		4 +
		3 * Math.sin(az * 5 * D + ph[0]) +
		2 * Math.sin(az * 13 * D + ph[1]) +
		1.2 * Math.sin(az * 31 * D + ph[2]);
	const truth = { yaw: truthYaw, pitch: 2, roll: 0, vfov: 40 };
	const aspect = W / H;
	const n = 1440;
	const dirs = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		const az = (i / n) * 360;
		const el = ridge(az) * D;
		dirs[i * 3] = Math.sin(az * D) * Math.cos(el);
		dirs[i * 3 + 1] = Math.cos(az * D) * Math.cos(el);
		dirs[i * 3 + 2] = Math.sin(el);
	}
	const c = camera(truth.pitch, truth.roll, truth.vfov, aspect);
	const rows = new Float32Array(W).fill(-1);
	for (let i = 0; i < n; i++) {
		const a = ((i / n) * 360 - truth.yaw) * D;
		const el = ridge((i / n) * 360) * D;
		const dx = Math.sin(a) * Math.cos(el);
		const dy = Math.cos(a) * Math.cos(el);
		const dz = Math.sin(el);
		const z = dx * c.fx + dy * c.fy + dz * c.fz;
		if (z <= 0.1) continue;
		const u = 0.5 + (dx * c.rx + dy * c.ry + dz * c.rz) / z / c.ta / 2;
		const v = 0.5 - (dx * c.ux + dy * c.uy + dz * c.uz) / z / c.t / 2;
		const col = Math.floor(u * W);
		if (col >= 0 && col < W) rows[col] = v * H;
	}
	const rgb = new Uint8Array(W * H * 3);
	const fine = new Float32Array(W * H);
	const coarse = new Float32Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			const r = rows[x] < 0 ? H / 2 : rows[x];
			rgb.set(y < r ? [110, 150, 230] : [90, 80, 60], i * 3);
			const d = y - r;
			fine[i] = Math.exp(-(d * d) / 3);
			coarse[i] = Math.exp(-(d * d) / 30);
		}
	const ed: EdgeInputs = {
		w: W,
		h: H,
		dirs,
		fine,
		coarse,
		fg: new Float32Array(W * H),
		rgb,
	};
	return { ed, aspect, truth };
}

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
type Case = {
	name: string;
	seed: number;
	W: number;
	H: number;
	yaw: number;
	focalKnown: boolean;
	pitchRange?: number;
	rollRange?: number;
	ystep?: number;
};
const CASES: Case[] = [
	{ name: "known-focal", seed: 1, W: 64, H: 40, yaw: 120, focalKnown: true },
	{ name: "unknown-focal", seed: 2, W: 96, H: 48, yaw: 250, focalKnown: false },
	{ name: "wide", seed: 3, W: 128, H: 48, yaw: 20, focalKnown: true },
	// tiny plan: nCells far below any workgroup multiple (edge: capCells small, many padding cells)
	{
		name: "tiny-plan",
		seed: 4,
		W: 64,
		H: 40,
		yaw: 300,
		focalKnown: true,
		pitchRange: 3,
		rollRange: 1.5,
		ystep: 5,
	},
];

let worstAgree = 1;
for (const cs of CASES) {
	const { ed, aspect, truth } = scene(cs.seed, cs.W, cs.H, cs.yaw);
	const sg = new SkyGlobal(ed, aspect);
	const g: GridPlan | null = sg.plan(
		truth.vfov,
		cs.focalKnown,
		cs.pitchRange,
		cs.rollRange,
		cs.ystep,
	);
	if (!g) {
		fail(`${cs.name}: no plan`);
		continue;
	}
	const nYaw = g.nYaw;
	const cpu = sg.gridCpu(g);
	const r = await gridGpu(device, sg, g, { rescore: "gpu" });
	const st = r.stats;
	console.log(
		`${cs.name}: nYaw ${nYaw} combos ${g.combos.length} cand ${st.nCand} fellBack ${st.fellBack} rescore ${st.rescore} reads ${st.reads} readBytes ${st.readBytes}`,
	);
	if (st.fellBack) fail(`${cs.name}: fell back to the CPU grid`);
	if (st.rescore !== "gpu") fail(`${cs.name}: stats.rescore ${st.rescore}`);
	let relErr = 0;
	let agree = 0;
	for (let iy = 0; iy < nYaw; iy++) {
		const d = Math.abs(r.best[iy] - cpu.best[iy]);
		relErr = Math.max(relErr, d / Math.max(Math.abs(cpu.best[iy]), 1e-12));
		if (r.arg[iy] === cpu.arg[iy]) agree++;
	}
	const frac = agree / nYaw;
	worstAgree = Math.min(worstAgree, frac);
	console.log(
		`  arg agreement ${agree}/${nYaw} = ${frac.toFixed(4)}, max rel |d best| ${relErr.toExponential(2)}`,
	);
	if (frac < 0.99) fail(`${cs.name}: arg agreement ${frac}`);
	if (relErr > 1e-4) fail(`${cs.name}: best rel err ${relErr}`);
	if (st.readBytes !== 4 + nYaw * 8)
		fail(`${cs.name}: readBytes ${st.readBytes} != ${4 + nYaw * 8}`);
	// the cpu path is unchanged
	const rc = await gridGpu(device, sg, g, {});
	if (rc.stats.rescore !== "cpu" || rc.arg.some((v, i) => v !== cpu.arg[i]))
		fail(`${cs.name}: default cpu rescore changed`);
	// cap overflow falls back
	const ro = await gridGpu(device, sg, g, { rescore: "gpu", cap: 4 });
	if (!ro.stats.fellBack || ro.arg.some((v, i) => v !== cpu.arg[i]))
		fail(`${cs.name}: gpu-rescore overflow path`);
	// search level
	const s = await searchGpu(sg, truth.vfov, cs.focalKnown, 3, {
		device,
		rescore: "gpu",
	});
	const c = sg.search(truth.vfov, cs.focalKnown, 3);
	const dp = (a: number, b: number) => Math.abs(a - b);
	const n = Math.min(s.hyps.length, c.hyps.length);
	const dk: number[] = [];
	for (let i = 0; i < n; i++) {
		const a = s.hyps[i].pose;
		const b = c.hyps[i].pose;
		dk.push(
			Math.max(dp(a.yaw, b.yaw), dp(a.pitch, b.pitch), dp(a.roll, b.roll)),
		);
	}
	console.log(
		`  searchGpu vs search: ${s.hyps.length}/${c.hyps.length} hyps, per-rank max |d| yaw/pitch/roll [${dk.map((x) => x.toFixed(4)).join(", ")}] deg (gpu ${s.gpu})`,
	);
	if (!n || !(dk[0] <= 0.05) || !s.gpu)
		fail(`${cs.name}: top-1 hypothesis differs`);
	if (s.hyps.length !== c.hyps.length)
		console.log("  note: hypothesis counts differ");
	// warm timing, cpu vs gpu rescore
	const time = async (o: { rescore?: "cpu" | "gpu" }) => {
		const ts: number[] = [];
		for (let i = 0; i < 5; i++) {
			const t = performance.now();
			await gridGpu(device, sg, g, o);
			ts.push(performance.now() - t);
		}
		return med(ts);
	};
	await gridGpu(device, sg, g, { rescore: "gpu" });
	console.log(
		`  warm gridGpu wall median: cpu-rescore ${(await time({})).toFixed(1)} ms, gpu-rescore ${(await time({ rescore: "gpu" })).toFixed(1)} ms (info)`,
	);
}

if (failed) {
	console.log(`FAIL ${ID}: ${failed} failure(s)`);
	process.exit(1);
}
console.log(`PASS ${ID} (worst arg agreement ${worstAgree.toFixed(4)})`);
process.exit(0);
