// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU haze fit's 72-list compaction and radix-select histogram (src/lib/gpu/look/haze.ts
// addListCompaction, haze-graph.ts) on a real luma WebGPU device in node (Dawn), on synthetic scenes
// (haze-emulate.ts makeHazeScene):
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/haze-lists-dawn.ts [seeds] [reps]
//
// Per scene, submit 1 of fitHazeGpu (prepGraph) against the CPU emulation (emulatePrep): counts and
// the radix-selected order statistics exactly (integers, f32 bits), every list's pixel indices and
// values (the lists are stable, so exactly, in pixel order) and the list starts. Then the final HazeFit
// of the three graph paths (fitHazeGpu = prepGraph; hazePrepArrays + fitHazeFromPrep with the CPU band
// = compact graph; with the GPU band = band graph) against the CPU fitHaze (max relative difference)
// and against each other (the paths share the compaction, so these must agree to the bit). Timings
// are medians of `reps` runs (wall clock, one device, graphs warm).
// SKIP (exit 0) without DAWN_DIR; exit 1 on any mismatch, a non-finite fit number or a list mismatch.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Buffer } from "@luma.gl/core";
import { ComputeGraph } from "../../src/lib/gpu/core/graph";
import { attachWebGPUDevice, GPUHistogram } from "../../src/lib/gpu/core/luma";
import { pooledStorage, pooledUniform } from "../../src/lib/gpu/core/pool";
import { COMPUTE_FEATURES } from "../../src/lib/gpu/device";
import {
	addListCompaction,
	fitHazeGpu,
	K_HZ_HIST,
	NBINS,
} from "../../src/lib/gpu/look/haze";
import { BUCKETS, SEL } from "../../src/lib/gpu/look/haze.wgsl";
import {
	emulatePrep,
	lcg,
	makeHazeScene,
	sceneOptions,
} from "../../src/lib/gpu/look/haze-emulate";
import { fitHazeFromPrep, prepGraph } from "../../src/lib/gpu/look/haze-graph";
import { defineKernel } from "../../src/lib/gpu/look/kernel";
import { hazePrepArrays } from "../../src/lib/gpu/look/textures";
import {
	HAZE_COUNT_PARAMS,
	HAZE_PASS_PARAMS,
} from "../../src/lib/gpu/look/uniform-blocks";
import { fitHaze, type HazeFitInput } from "../../src/lib/look/haze-fit";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP haze-lists-dawn: DAWN_DIR not set");
	process.exit(0);
}
const SEEDS = Number(process.argv[2] ?? 6);
const REPS = Number(process.argv[3] ?? 5);
const { create, globals } = await import(
	pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
const gpu = create([]);
Object.defineProperty(globalThis, "navigator", {
	value: { gpu, userAgent: "node" },
	configurable: true,
});
const adapter = await gpu.requestAdapter();
if (!adapter) {
	console.log("SKIP haze-lists-dawn: no adapter");
	process.exit(0);
}
const device = await attachWebGPUDevice(
	await adapter.requestDevice({
		requiredFeatures: COMPUTE_FEATURES.filter((f) => adapter.features.has(f)),
	}),
	{ id: "haze-lists-dawn" },
	true,
);
console.log(`adapter ${JSON.stringify(adapter.info ?? {})}`);

let failed = 0;
const fail = (message: string) => {
	failed++;
	console.log(`FAIL ${message}`);
};
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

/** fitHazeGpu's CPU-built prep arrays (row 0 = top). */
function prepArrays(h: HazeFitInput) {
	const { geoW: W, geoH: H, sky, foreground: fg } = h;
	const N = W * H;
	const range = new Float32Array(N);
	const pSky = new Float32Array(N);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const gy = H - 1 - y;
			range[y * W + x] =
				h.geo.kind === "xyzr"
					? h.geo.data[(gy * W + x) * 4 + 3]
					: h.geo.data[gy * W + x];
		}
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			if (sky) {
				const mx = Math.min(
					sky.width - 1,
					Math.floor(((x + 0.5) * sky.width) / W),
				);
				const my = Math.min(
					sky.height - 1,
					Math.floor(((y + 0.5) * sky.height) / H),
				);
				pSky[i] = sky.data[my * sky.width + mx] / 255;
			} else pSky[i] = range[i] > 0 ? 0 : 1;
		}
	const fgBits = new Uint32Array(Math.ceil(N / 32));
	if (fg)
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const mx = Math.min(
					fg.width - 1,
					Math.floor(((x + 0.5) * fg.width) / W),
				);
				const my = Math.min(
					fg.height - 1,
					Math.floor(((y + 0.5) * fg.height) / H),
				);
				if (fg.data[my * fg.width + mx] > 64) {
					const i = y * W + x;
					fgBits[i >> 5] |= 1 << (i & 31);
				}
			}
	return { W, H, photo: h.photo, range, pSky, fgBits, hasFg: !!fg };
}

/** Max relative difference of every number in two values (and non-finite count of b). */
function maxRel(a: unknown, b: unknown, acc = { rel: 0, bad: 0 }) {
	if (typeof a === "number" && typeof b === "number") {
		if (!Number.isFinite(b)) acc.bad++;
		else
			acc.rel = Math.max(
				acc.rel,
				Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12),
			);
	} else if (a && b && typeof a === "object" && typeof b === "object")
		for (const k of Object.keys(a))
			maxRel((a as never)[k], (b as never)[k], acc);
	return acc;
}
const sameBits = (a: unknown, b: unknown): boolean =>
	JSON.stringify(a) === JSON.stringify(b);

const scenes: { name: string; input: HazeFitInput }[] = [];
for (let s = 0; s < SEEDS; s++) {
	const o = sceneOptions(s);
	scenes.push({
		name: `seed${s} ${o.width}x${o.height}`,
		input: makeHazeScene(o),
	});
}
for (const [w, h] of [
	[1024, 768],
	[1600, 1200],
] as const)
	scenes.push({
		name: `big ${w}x${h}`,
		input: makeHazeScene({
			...sceneOptions(3),
			width: w,
			height: h,
			skyMask: true,
			foreground: true,
			rangeOnly: false,
		}),
	});

for (const { name, input } of scenes) {
	const { W, H } = { W: input.geoW, H: input.geoH };
	const N = W * H;
	const a = prepArrays(input);
	const rad = Math.max(1, Math.round((3 * W) / 1024));
	const fgRad = a.hasFg ? Math.max(2, Math.round((8 * W) / 1024)) : 0;
	const { airlightBand } = await import("../../src/lib/gpu/look/haze");
	const skyIdx = airlightBand(a.range, a.pSky, W, H);
	// 1. submit 1 vs the CPU emulation
	const prepArgs = [
		device,
		a.photo,
		W,
		H,
		a.range,
		a.pSky,
		a.fgBits,
		rad,
		fgRad,
		skyIdx,
	] as const;
	const gp = await prepGraph(...prepArgs);
	const { prep: ep } = emulatePrep(input);
	// the GPU bins in f32 (a pixel on a bin edge may land one bin over: counts are reported), an
	// empty bin's statistics are NaN on the GPU (the tail never reads them); the order statistics of
	// every other bin whose count agrees must match to the bit
	const countDiffs: string[] = [];
	for (let k = 0; k < NBINS; k++)
		if (gp.counts[k] !== ep.counts[k])
			countDiffs.push(`[${k}] ${gp.counts[k]} vs ${ep.counts[k]}`);
	if (countDiffs.length)
		console.log(`   counts differ: ${countDiffs.join("; ")}`);
	let statBad = 0;
	for (let s0 = 0; s0 < NBINS * 12; s0++) {
		const bin = Math.floor(s0 / 12);
		if (ep.counts[bin] === 0 || gp.counts[bin] !== ep.counts[bin]) continue;
		if (!Object.is(gp.stat[s0], ep.stat[s0])) statBad++;
	}
	if (statBad) fail(`${name}: ${statBad} order statistics differ`);
	let listTotal = 0;
	let listBad = 0;
	for (let L = 0; L < NBINS * 3; L++) {
		const g = gp.list(L);
		const e = ep.list(L);
		if (gp.counts[Math.floor(L / 3)] !== ep.counts[Math.floor(L / 3)]) continue;
		listTotal += e.idx.length;
		let ok = g.idx.length === e.idx.length;
		for (let k = 0; ok && k < e.idx.length; k++)
			ok = g.idx[k] === e.idx[k] && Object.is(g.val[k], e.val[k]);
		if (!ok) listBad++;
	}
	if (listBad) fail(`${name}: ${listBad} of ${NBINS * 3} lists differ`);
	// 2. fits of the three graph paths
	const cpu = fitHaze(input);
	const fitA = await fitHazeGpu(device, input);
	const geom = { geo: input.geo, eyeAlt: input.eyeAlt, sunDir: input.sunDir };
	const prepB = await hazePrepArrays(device, a);
	const fitB = await fitHazeFromPrep(device, prepB, geom, { bandGpu: false });
	const prepC = await hazePrepArrays(device, a);
	const fitC = await fitHazeFromPrep(device, prepC, geom, { bandGpu: true });
	const dA = maxRel(cpu, fitA);
	const dB = maxRel(cpu, fitB);
	const dC = maxRel(cpu, fitC);
	if (dA.bad + dB.bad + dC.bad) fail(`${name}: non-finite fit numbers`);
	if (Math.max(dA.rel, dB.rel, dC.rel) > 0.05)
		fail(`${name}: fit vs CPU rel ${dA.rel} ${dB.rel} ${dC.rel}`);
	const bitsAB = sameBits(fitA, fitB);
	const bitsBC = sameBits(fitB, fitC);
	if (!bitsAB || !bitsBC)
		fail(`${name}: paths differ (A=B ${bitsAB}, B=C ${bitsBC})`);
	// 3. timings
	const time = async (run: () => Promise<unknown>) => {
		const t: number[] = [];
		for (let r = 0; r < REPS; r++) {
			const t0 = performance.now();
			await run();
			t.push(performance.now() - t0);
		}
		return median(t);
	};
	const tPrep = await time(() => prepGraph(...prepArgs));
	const tA = await time(() => fitHazeGpu(device, input));
	const tPrepB = await time(() => hazePrepArrays(device, a));
	const tB = await time(async () =>
		fitHazeFromPrep(device, await hazePrepArrays(device, a), geom, {
			bandGpu: false,
		}),
	);
	const tC = await time(async () =>
		fitHazeFromPrep(device, await hazePrepArrays(device, a), geom, {
			bandGpu: true,
		}),
	);
	console.log(
		`${name} N=${N} lists=${listTotal} listsBad=${listBad} vsCPU max rel ${Math.max(dA.rel, dB.rel, dC.rel).toExponential(2)} pathsIdentical=${bitsAB && bitsBC}\n` +
			`   median ms: prepGraph ${tPrep.toFixed(1)}  fitHazeGpu ${tA.toFixed(1)}  hazePrepArrays ${tPrepB.toFixed(1)}  fit(compact) ${tB.toFixed(1)}  fit(band) ${tC.toFixed(1)}`,
	);
}

/**
 * The rejected formulation's key kernel (kept here as evidence only): one key per (pixel, channel) in
 * pass 0, four per element (one per selection slot) in passes 1 and 2, key = selection * BUCKETS +
 * digit when the higher bits match the selection's prefix, else 0xffffffff (outside the histogram's
 * domain). Thread t = 4e + slot; 2-D dispatch (12N can pass 65 535 groups of 256).
 */
const HIST_KEY_WGSL = /* wgsl */ `
struct S { W: u32, H: u32, pass_: u32, pad: u32 };
fn shiftOf(p: u32) -> u32 { return select(select(0u, 10u, p == 1u), 21u, p == 0u); }
fn bitsOf(p: u32) -> u32 { return select(11u, 10u, p == 2u); }
@group(0) @binding(0) var<uniform> prm: S;
@group(0) @binding(1) var<storage, read> bins: array<i32>;
@group(0) @binding(2) var<storage, read> lin: array<f32>;
@group(0) @binding(3) var<storage, read> state: array<vec2<u32>>;
@group(0) @binding(4) var<storage, read_write> keys: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>,
        @builtin(local_invocation_index) lid: u32) {
  let t = (wg.y * nwg.x + wg.x) * 256u + lid;
  let p = prm.pass_;
  let n = prm.W * prm.H;
  if (t >= select(12u * n, 3u * n, p == 0u)) { return; }
  let e = select(t >> 2u, t, p == 0u);
  let i = e / 3u;
  let c = e - i * 3u;
  let b = bins[i];
  if (b < 0) { keys[t] = 0xffffffffu; return; }
  let sh = shiftOf(p);
  let bits = bitsOf(p);
  let v = bitcast<u32>(lin[e]);
  let d = (v >> sh) & ((1u << bits) - 1u);
  let s0 = (u32(b) * 3u + c) * 4u;
  if (p == 0u) {
    keys[t] = s0 * ${BUCKETS}u + d;
  } else {
    let s = s0 + (t & 3u);
    keys[t] = select(0xffffffffu, s * ${BUCKETS}u + d, (v >> (sh + bits)) == state[s].x);
  }
}
`;
const K_HZ_HIST_KEY = defineKernel("hz-hist-key", HIST_KEY_WGSL, [
	["prm", "uniform"],
	["bins", "read-only-storage"],
	["lin", "read-only-storage"],
	["state", "read-only-storage"],
	["keys", "storage"],
]);

// ---------- radix select's digit histogram: old atomics kernel vs key kernel + GPUHistogram ----------
// One pass (1: higher digits must match the selection's prefix) on synthetic bins / lin / state with
// ~1/8 of the elements matching; the two histograms must be equal (integers); timings are the GPU
// timestamps of the two nodes when the adapter has timestamp-query (else wall clock of the graph run).
{
	const N = 400_000;
	const rnd = lcg(7);
	const bins = new Int32Array(N);
	const lin = new Float32Array(3 * N);
	for (let i = 0; i < N; i++) {
		bins[i] = rnd() < 0.1 ? -1 : Math.floor(rnd() * NBINS);
		for (let c = 0; c < 3; c++) lin[3 * i + c] = 0.25 + 0.25 * rnd();
	}
	const state = new Uint32Array(SEL * 2);
	const prefix = new Uint32Array(new Float32Array([0.3]).buffer)[0] >>> 21;
	for (let s = 0; s < SEL; s++) state[2 * s] = prefix;
	const prm = HAZE_PASS_PARAMS.pack({ W: N, H: 1, pass_: 1 });
	type Variant = "old" | "new";
	const build = (variant: Variant) => {
		const g = new ComputeGraph<undefined>(device, `hist-ab-${variant}`);
		const U = Buffer.UNIFORM | Buffer.COPY_DST;
		const S = Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST;
		const hPrm = g.importBuffer("prm", 16, undefined, U);
		const hBins = g.importBuffer("bins", N * 4, undefined, S);
		const hLin = g.importBuffer("lin", N * 12, undefined, S);
		const hState = g.importBuffer("state", SEL * 8, undefined, S);
		const hHist = g.importBuffer("hist", SEL * BUCKETS * 4, undefined, S);
		if (variant === "old") {
			g.clearNode("clear-hist", hHist);
			g.addKernel({
				id: "hist",
				spec: K_HZ_HIST,
				bindings: {
					prm: hPrm,
					bins: hBins,
					lin: hLin,
					state: hState,
					hist: hHist,
				},
				workgroups: [Math.ceil(N / 256)],
				writes: { hist: "atomic" },
			});
		} else {
			const keys = g.transientBuffer("keys", 12 * N * 4);
			g.addKernel({
				id: "hist-key",
				spec: K_HZ_HIST_KEY,
				bindings: { prm: hPrm, bins: hBins, lin: hLin, state: hState, keys },
				workgroups: [
					Math.min(Math.ceil((12 * N) / 256), 65535),
					Math.ceil((12 * N) / 256 / 65535),
				],
			});
			g.add(
				new GPUHistogram({
					id: "hist",
					input: g.view(keys, "uint32", 12 * N),
					output: g.view(hHist, "uint32", SEL * BUCKETS),
					domain: [0, SEL * BUCKETS],
				}),
			);
		}
		g.compile();
		return g;
	};
	const key = (k: string) => `hist-ab/${k}`;
	const bufs = {
		prm: pooledUniform(device, key("prm"), prm),
		bins: pooledStorage(device, key("bins"), bins),
		lin: pooledStorage(device, key("lin"), lin),
		state: pooledStorage(device, key("state"), state),
		hist: pooledStorage(device, key("hist"), SEL * BUCKETS * 4, {
			zero: false,
		}),
	};
	const nodeMs: Record<string, Record<string, number[]>> = {};
	const results: Record<
		string,
		{ hist: Uint32Array; ms: number; gpuMs: number | null }
	> = {};
	for (const variant of ["old", "new"] as Variant[]) {
		const g = build(variant);
		const wall: number[] = [];
		const gpu: number[] = [];
		let hist = new Uint32Array(0);
		for (let r = 0; r < 25; r++) {
			const t0 = performance.now();
			const out = await g.run(undefined, {
				buffers: bufs,
				read: [{ buffer: bufs.hist, size: SEL * BUCKETS * 4 }],
				timings: true,
			});
			wall.push(performance.now() - t0);
			if (out.timings) gpu.push(out.timings.gpuTimeMilliseconds ?? 0);
			for (const n of out.timings?.nodes ?? []) {
				const byNode = nodeMs[variant] ?? {};
				nodeMs[variant] = byNode;
				const list = byNode[n.id] ?? [];
				byNode[n.id] = list;
				list.push(n.gpuTimeMilliseconds ?? 0);
			}
			hist = new Uint32Array(out.data[0].slice(0));
		}
		results[variant] = {
			hist,
			ms: median(wall),
			gpuMs: gpu.length ? median(gpu) : null,
		};
		g.destroy();
	}
	for (const [v, nodes] of Object.entries(nodeMs))
		console.log(
			`   ${v} nodes (GPU ms, median): ${Object.entries(nodes)
				.map(([id, t]) => `${id} ${median(t).toFixed(3)}`)
				.join(", ")}`,
		);
	let diff = 0;
	let total = 0;
	for (let k = 0; k < results.old.hist.length; k++) {
		if (results.old.hist[k] !== results.new.hist[k]) diff++;
		total += results.old.hist[k];
	}
	if (diff || total === 0)
		fail(`radix histogram: ${diff} bins differ (total ${total})`);
	console.log(
		`radix histogram pass 1, N=${N}: counted ${total}, bins differing ${diff}; GPU ms old ${results.old.gpuMs?.toFixed(3)} new ${results.new.gpuMs?.toFixed(3)}; wall incl. 2.3 MB read old ${results.old.ms.toFixed(1)} new ${results.new.ms.toFixed(1)}`,
	);
}

// ---------- the 72-list compaction alone: GPU timestamps per node (addListCompaction) ----------
// Synthetic bins / lin / state with ~40% of the elements inside their list; the packed lists are
// checked against a CPU stable compaction, and the nodes' GPU times are printed per N.
for (const N of [49_152, 196_608, 786_432, 1_920_000]) {
	const rnd = lcg(11);
	const bins = new Int32Array(N);
	const lin = new Float32Array(3 * N);
	for (let i = 0; i < N; i++) {
		bins[i] = rnd() < 0.1 ? -1 : Math.floor(rnd() * NBINS);
		for (let c = 0; c < 3; c++) lin[3 * i + c] = 0.25 + 0.25 * rnd();
	}
	const bitsOf = (f: number) =>
		new Uint32Array(new Float32Array([f]).buffer)[0];
	const state = new Uint32Array(SEL * 2);
	for (let L = 0; L < NBINS * 3; L++) {
		state[2 * (4 * L)] = bitsOf(Math.fround(0.3));
		state[2 * (4 * L + 3)] = bitsOf(Math.fround(0.4));
	}
	const g = new ComputeGraph<undefined>(device, "lists-bench");
	const U = Buffer.UNIFORM | Buffer.COPY_DST;
	const S = Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST;
	const cprm = g.importBuffer("cprm", 16, undefined, U);
	const hBins = g.importBuffer("bins", N * 4, undefined, S);
	const hLin = g.importBuffer("lin", N * 12, undefined, S);
	const hState = g.importBuffer("state", SEL * 8, undefined, S);
	const hIdx = g.importBuffer("outIdx", 3 * N * 4, undefined, S);
	const hVal = g.importBuffer("outVal", 3 * N * 4, undefined, S);
	const starts = g.transientBuffer("starts", (NBINS * 3 + 1) * 4);
	addListCompaction(
		g,
		{
			cprm,
			bins: hBins,
			state: hState,
			lin: hLin,
			outIdx: hIdx,
			outVal: hVal,
			starts,
		},
		N,
	);
	g.readNode("starts", [starts]);
	g.compile();
	const key = (k: string) => `lists-bench/${k}`;
	const bufs = {
		cprm: pooledUniform(
			device,
			key("cprm"),
			HAZE_COUNT_PARAMS.pack({ N, nBlk: 0, K: 0 }),
		),
		bins: pooledStorage(device, key("bins"), bins),
		lin: pooledStorage(device, key("lin"), lin),
		state: pooledStorage(device, key("state"), state),
		outIdx: pooledStorage(device, key("outIdx"), 3 * N * 4, { zero: false }),
		outVal: pooledStorage(device, key("outVal"), 3 * N * 4, { zero: false }),
	};
	const nodes: Record<string, number[]> = {};
	const total: number[] = [];
	let startsOut = new Uint32Array(0);
	for (let r = 0; r < 15; r++) {
		const out = await g.run(undefined, {
			buffers: bufs,
			timings: true,
		});
		total.push(out.timings?.gpuTimeMilliseconds ?? 0);
		for (const n of out.timings?.nodes ?? []) {
			const list = nodes[n.id] ?? [];
			nodes[n.id] = list;
			list.push(n.gpuTimeMilliseconds ?? 0);
		}
		startsOut = new Uint32Array(out.reads.starts[0].slice(0));
	}
	// CPU stable compaction
	const want: number[][] = Array.from({ length: NBINS * 3 }, () => []);
	for (let i = 0; i < N; i++)
		if (bins[i] >= 0)
			for (let c = 0; c < 3; c++) {
				const v = lin[3 * i + c];
				if (v >= Math.fround(0.3) && v <= Math.fround(0.4))
					want[bins[i] * 3 + c].push(i);
			}
	const wantStarts = [0];
	for (const l of want)
		wantStarts.push(wantStarts[wantStarts.length - 1] + l.length);
	const startsOk = wantStarts.every((v, k) => startsOut[k] === v);
	const idx = new Uint32Array(
		await readWords(bufs.outIdx, wantStarts[NBINS * 3]),
	);
	const val = new Float32Array(
		await readWords(bufs.outVal, wantStarts[NBINS * 3]),
	);
	let listsBad = 0;
	for (let L = 0; L < NBINS * 3; L++)
		for (let k = 0; k < want[L].length; k++) {
			const at = wantStarts[L] + k;
			if (idx[at] !== want[L][k] || val[at] !== lin[3 * want[L][k] + (L % 3)]) {
				listsBad++;
				break;
			}
		}
	if (!startsOk || listsBad)
		fail(
			`list compaction N=${N}: starts ok ${startsOk}, ${listsBad} lists differ`,
		);
	console.log(
		`list compaction N=${N}: total ${wantStarts[NBINS * 3]}, starts ok ${startsOk}, lists bad ${listsBad}; GPU ms median ${median(total).toFixed(3)} (${Object.entries(
			nodes,
		)
			.map(([id, t]) => `${id} ${median(t).toFixed(3)}`)
			.join(", ")})`,
	);
	g.destroy();
}
async function readWords(buffer: Buffer, words: number) {
	return (await buffer.readAsync(0, words * 4)).slice().buffer;
}
console.log(failed ? `${failed} FAILED` : "OK haze-lists-dawn");
process.exit(failed ? 1 : 0);
