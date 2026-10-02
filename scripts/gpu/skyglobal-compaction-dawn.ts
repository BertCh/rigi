// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The skyglobal candidate list (src/lib/gpu/skyglobal: FLAGS + luma GPUCompaction) on a real luma
// WebGPU device in node (Dawn), against the CPU twin (SkyGlobal.gridCpu) on synthetic ridge scenes:
//  - the final {best, arg} of gridGpu equals gridCpu's (arg exactly, best within 1e-9) and searchGpu's
//    top hypothesis equals SkyGlobal.search's;
//  - the candidate list is a sorted-ascending set of distinct cells, every one inside the certified
//    bound set computed from the debug grid (hi >= max lo of its yaw), covering every yaw, with a
//    set checksum printed so an old-vs-new run (base tree, where the list is atomicAdd-ordered and
//    only the set is stable) can be compared;
//  - a forced tiny `head` exercises the tail read; a capped `cap` the overflow fallback.
// Also prints NaN counts of the debug grid and the warm gridGpu wall time. Works on the base tree too
// (the public API is unchanged); "sorted ascending" is then reported, not asserted, via OLD=1.
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/skyglobal-compaction-dawn.ts
//
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on any mismatch.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gridGpu, searchGpu } from "../../src/lib/gpu/skyglobal";
import {
	camera,
	type EdgeInputs,
	type GridPlan,
	SkyGlobal,
} from "../../src/lib/gpu/skyglobal/cpu";

const ID = "skyglobal-compaction-dawn";
const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log(`SKIP ${ID}: DAWN_DIR not set`);
	process.exit(0);
}
const OLD = process.env.OLD === "1";
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
/** FNV-1a over the sorted candidate cells: equal across old / new when the set is equal. */
function setHash(cs: ArrayLike<number>) {
	const s = Array.from(cs).sort((a, b) => a - b);
	let h = 2166136261;
	for (const v of s) h = Math.imul(h ^ v, 16777619) >>> 0;
	return h.toString(16);
}

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
	const nCells = nYaw * g.combos.length;
	const cpu = sg.gridCpu(g);
	const r = await gridGpu(device, sg, g, { debugGrid: true });
	const st = r.stats;
	console.log(
		`${cs.name}: nYaw ${nYaw} combos ${g.combos.length} cells ${nCells} cand ${st.nCand} fellBack ${st.fellBack} reads ${st.reads} readBytes ${st.readBytes}`,
	);
	if (st.fellBack) fail(`${cs.name}: fell back to the CPU grid`);
	// final answer vs the CPU twin
	let bestErr = 0;
	let argMismatch = 0;
	for (let iy = 0; iy < nYaw; iy++) {
		bestErr = Math.max(bestErr, Math.abs(r.best[iy] - cpu.best[iy]));
		if (r.arg[iy] !== cpu.arg[iy]) argMismatch++;
	}
	console.log(
		`  best max|d| ${bestErr.toExponential(2)} arg mismatches ${argMismatch}/${nYaw}`,
	);
	if (bestErr > 1e-9 || argMismatch) fail(`${cs.name}: {best, arg} differ`);
	// debug grid sanity + the certified bound set
	const { mid, lo, hi } = r;
	let nan = 0;
	if (mid && lo && hi)
		for (let i = 0; i < nCells; i++)
			if (!Number.isFinite(mid[i] + lo[i] + hi[i])) nan++;
	console.log(`  NaN/Inf in debug grid: ${nan}`);
	if (nan) fail(`${cs.name}: non-finite grid values`);
	const cands = r.cands ?? new Uint32Array(0);
	let sorted = true;
	let distinct = true;
	for (let i = 1; i < cands.length; i++) {
		if (cands[i] < cands[i - 1]) sorted = false;
		if (cands[i] === cands[i - 1]) distinct = false;
	}
	console.log(
		`  list: ${cands.length} cells, ascending ${sorted}, set hash ${setHash(cands)}`,
	);
	if (!OLD && !sorted) fail(`${cs.name}: list is not ascending`);
	const seen = new Set(cands);
	if (seen.size !== cands.length) distinct = false;
	if (!distinct) fail(`${cs.name}: duplicate candidates`);
	if (cands.length !== st.nCand) fail(`${cs.name}: count != list length`);
	if (mid && lo && hi) {
		const maxLo = new Float64Array(nYaw).fill(Number.NEGATIVE_INFINITY);
		for (let i = 0; i < nCells; i++)
			maxLo[i % nYaw] = Math.max(maxLo[i % nYaw], lo[i]);
		let outside = 0;
		let missed = 0;
		let certainZeroSkips = 0;
		for (const c of cands) if (!(hi[c] >= maxLo[c % nYaw])) outside++;
		for (let i = 0; i < nCells; i++)
			if (hi[i] >= maxLo[i % nYaw] && !seen.has(i)) {
				// the only cells the bound set may drop: certain zeros beyond the first per yaw
				if (lo[i] === 0 && hi[i] === 0) certainZeroSkips++;
				else missed++;
			}
		const yawsCovered = new Set(Array.from(cands, (c) => c % nYaw)).size;
		console.log(
			`  vs bound set: outside ${outside}, missed ${missed}, dropped certain zeros ${certainZeroSkips}, yaws covered ${yawsCovered}/${nYaw}`,
		);
		if (outside || missed || yawsCovered !== nYaw)
			fail(`${cs.name}: candidate set differs from the predicate`);
	}
	// tail read: head forced below the count
	if (st.nCand > 16) {
		const rt = await gridGpu(device, sg, g, { head: 16 });
		const same =
			rt.cands?.length === cands.length &&
			rt.cands.every((v, i) => v === cands[i]);
		const argT = rt.arg.every((v, i) => v === cpu.arg[i]);
		console.log(
			`  tail read (head 16): reads ${rt.stats.reads} readBytes ${rt.stats.readBytes}, list ${same ? "equal" : "DIFFERENT"}, arg ${argT ? "equal" : "DIFFERENT"}`,
		);
		if (rt.stats.reads !== 2 || !same || !argT)
			fail(`${cs.name}: tail read mismatch`);
	}
	// overflow: cap below the count falls back to the CPU grid with the same answer
	if (st.nCand > 4) {
		const ro = await gridGpu(device, sg, g, { cap: 4 });
		const argO = ro.arg.every((v, i) => v === cpu.arg[i]);
		console.log(
			`  cap 4: fellBack ${ro.stats.fellBack}, arg ${argO ? "equal" : "DIFFERENT"}`,
		);
		if (!ro.stats.fellBack || !argO) fail(`${cs.name}: overflow path`);
	}
	// determinism: a second run gives the same list
	const r2 = await gridGpu(device, sg, g, {});
	const rep =
		r2.cands?.every((v, i) => v === cands[i]) &&
		r2.cands?.length === cands.length;
	console.log(`  second run list identical (order too): ${!!rep}`);
	if (!OLD && !rep) fail(`${cs.name}: list differs between runs`);
	// search level
	const s = await searchGpu(sg, truth.vfov, cs.focalKnown, 3, { device });
	const c = sg.search(truth.vfov, cs.focalKnown, 3);
	const dp = (a: number, b: number) => Math.abs(a - b);
	const h0 = s.hyps[0]?.pose;
	const c0 = c.hyps[0]?.pose;
	const d =
		h0 && c0
			? Math.max(
					dp(h0.yaw, c0.yaw),
					dp(h0.pitch, c0.pitch),
					dp(h0.roll, c0.roll),
					dp(h0.vfov, c0.vfov),
				)
			: Number.NaN;
	console.log(
		`  searchGpu vs search top hyp max pose |d| ${d.toExponential(2)} (gpu ${s.gpu})`,
	);
	if (!(d < 1e-6) || !s.gpu) fail(`${cs.name}: search result differs`);
	// warm timing
	const ts: number[] = [];
	for (let i = 0; i < 3; i++) {
		const t = performance.now();
		await gridGpu(device, sg, g, {});
		ts.push(performance.now() - t);
	}
	console.log(`  warm gridGpu wall median ${med(ts).toFixed(1)} ms (info)`);
}

if (failed) {
	console.log(`FAIL ${ID}: ${failed} failure(s)`);
	process.exit(1);
}
console.log(`PASS ${ID}`);
process.exit(0);
