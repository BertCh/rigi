// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The band-stats fold (src/lib/gpu/look/color-stats-fold.ts: luma GPUProgramSpMV + BAND_FINALIZE) on
// real luma WebGPU devices in node (Dawn): the per-workgroup partials of the 12 synthetic scenes of
// color-stats-fold.fixtures.ts (CPU emulation of BAND_STATS / BAND_STATS_SG) are copied into the
// program's `partial` vector by a trivial producer kernel, folded and finalized on the GPU, and the
// ColorStats read back is compared with reduceBands (f64) and the emulated f32 fold (|d| <= 2e-5).
// Two devices: "default" (every COMPUTE_FEATURE the adapter has, so subgroups when it has them) and
// "core" (no features, no subgroups). The SpMV strategy luma picked is read from the compilation's
// lowering report: webgpu-spmv:subgroup-row on the first (if the adapter has subgroups and the
// subgroup_id WGSL feature; otherwise reported), webgpu-spmv:workgroup-row on the second. Also feeds
// partials with BAND_STATS_SG's -1e20 layout-failure marker and asserts subgroupLayoutFailed.
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/stats-fold-dawn.ts [scenes]
//
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on any mismatch.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Buffer, type Device } from "@luma.gl/core";
import { COMPUTE_FEATURES } from "../../src/lib/gpu/core/device";
import { attachWebGPUDevice } from "../../src/lib/gpu/core/luma";
import { statsParamWords } from "../../src/lib/gpu/look/color-stats";
import { STATS_VALUES } from "../../src/lib/gpu/look/color-stats.wgsl";
import {
	buildFoldGraph,
	foldSelectionCsr,
	STATS_BYTES,
	statsFromWords,
	subgroupLayoutFailed,
} from "../../src/lib/gpu/look/color-stats-fold";
import {
	emulateFinalize,
	emulatePartials,
	emulateSpmv,
	GROUPS,
	gpuFold,
	makeScene,
	maxDelta,
	sameCounts,
} from "../../src/lib/gpu/look/color-stats-fold.fixtures";
import { defineKernel } from "../../src/lib/gpu/look/kernel";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP stats-fold-dawn: DAWN_DIR not set");
	process.exit(0);
}
const SCENES = Number(process.argv[2] ?? 12);
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
	console.log("SKIP stats-fold-dawn: no adapter");
	process.exit(0);
}
console.log(
	`adapter ${JSON.stringify(adapter.info ?? {})} subgroups: ${adapter.features.has("subgroups")}`,
);

let failed = 0;
const fail = (message: string) => {
	failed++;
	console.log(`FAIL ${message}`);
};

/** The producer: copies the imported partials into the program's `partial` vector. */
const K_COPY = defineKernel(
	"stats-fold-dawn-copy",
	/* wgsl */ `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
	if (id.x < ${GROUPS * STATS_VALUES}u) { dst[id.x] = src[id.x]; }
}
`,
	[
		["src", "read-only-storage"],
		["dst", "storage"],
	],
	{ group: "stats-fold-dawn" },
);

const PARTIAL_BYTES = GROUPS * STATS_VALUES * 4;
const csr = foldSelectionCsr(GROUPS);

async function checkDevice(
	label: string,
	features: string[],
	expectStrategy: (subgroupRowPossible: boolean) => string,
) {
	// an adapter yields one device (a second requestDevice resolves already lost): one adapter each
	const own = (await gpu.requestAdapter()) ?? adapter;
	const handle = await own.requestDevice({ requiredFeatures: features });
	const device = (await attachWebGPUDevice(
		handle,
		{ id: `stats-fold-dawn-${label}` },
		true,
	)) as Device;
	const hasSubgroups = device.features.has("subgroups");
	const hasSubgroupId = !!(
		device as unknown as { wgslLanguageFeatures?: Set<string> }
	).wgslLanguageFeatures?.has("subgroup_id");
	console.log(
		`\n[${label}] features: ${[...device.features].join(",") || "(none)"}; subgroups ${hasSubgroups}, wgsl subgroup_id ${hasSubgroupId}`,
	);
	const { graph, compilation, stats } = buildFoldGraph<undefined>(
		device,
		`stats-fold-dawn-${label}`,
		GROUPS,
		{
			params: (g) =>
				g.importBuffer("prm", 24, undefined, Buffer.UNIFORM | Buffer.COPY_DST),
			produce: (g, partial) => {
				const src = g.importBuffer("src", PARTIAL_BYTES);
				g.addKernel({
					id: "copy-partials",
					spec: K_COPY,
					bindings: { src, dst: partial },
					workgroups: [Math.ceil((GROUPS * STATS_VALUES) / 64)],
				});
			},
			output: (g) => g.transientBuffer("stats", STATS_BYTES),
		},
	);
	graph.readNode("stats", [stats]);
	await graph.compileAsync();
	const decisions = compilation.lowering.decisions;
	for (const d of decisions)
		console.log(`  ${d.operationId.padEnd(10)} ${d.lowering}  (${d.reason})`);
	const spmv = decisions.find((d) => d.lowering.startsWith("webgpu-spmv:"));
	const want = expectStrategy(hasSubgroups && hasSubgroupId);
	console.log(`  SpMV decision: ${spmv?.lowering} (expected ${want})`);
	if (spmv?.lowering !== want)
		fail(`[${label}] SpMV decision ${spmv?.lowering}`);

	const partialBuffer = device.createBuffer({
		id: "src",
		usage: Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST,
		byteLength: PARTIAL_BYTES,
	});
	const prm = device.createBuffer({
		id: "prm",
		usage: Buffer.UNIFORM | Buffer.COPY_DST,
		byteLength: 24,
	});
	prm.write(statsParamWords(0, 0, false, 0, 60));
	const fold = async (p: Float32Array) => {
		partialBuffer.write(p);
		const { reads } = await graph.run(undefined, {
			buffers: { src: partialBuffer, prm },
		});
		return reads.stats[0];
	};

	let worstRef = 0;
	let worstF32 = 0;
	let compared = 0;
	for (let seed = 1; seed <= SCENES; seed++) {
		const { px, ref } = makeScene(seed);
		for (const sg of [false, 32] as const) {
			const p = emulatePartials(px, sg);
			const words = await fold(p);
			const got = statsFromWords(words);
			const emulated = gpuFold(p, 60, csr);
			const tag = `[${label}] scene ${seed}${sg ? " sg" : ""}`;
			compared++;
			if (subgroupLayoutFailed(words)) fail(`${tag}: flagged layout failure`);
			if (!sameCounts(ref, got)) {
				fail(`${tag}: count / valid ref=${ref.count} gpu=${got.count}`);
				continue;
			}
			const dr = maxDelta(ref, got);
			const de = maxDelta(emulated, got);
			worstRef = Math.max(worstRef, dr);
			worstF32 = Math.max(worstF32, de);
			if (dr > 2e-5) fail(`${tag}: |d| vs reduceBands ${dr.toExponential(2)}`);
			if (de > 2e-5) fail(`${tag}: |d| vs f32 fold ${de.toExponential(2)}`);
		}
	}
	console.log(
		`  ${compared} runs: max |d| vs reduceBands (f64) ${worstRef.toExponential(2)}, vs CPU f32 fold ${worstF32.toExponential(2)} (limit 2e-5)`,
	);

	// BAND_STATS_SG's layout-failure marker in one workgroup's partials must survive the fold
	const marked = new Float32Array(GROUPS * STATS_VALUES).fill(3);
	for (let k = 0; k < STATS_VALUES; k++) marked[5 * STATS_VALUES + k] = -1e20;
	for (let g = 0; g < GROUPS; g++) marked[g * STATS_VALUES] = 1000;
	const markedWords = await fold(marked);
	const cpuMarked = emulateFinalize(emulateSpmv(marked, csr), 60);
	if (!subgroupLayoutFailed(markedWords)) fail(`[${label}] marker not seen`);
	if (!subgroupLayoutFailed(cpuMarked)) fail(`[${label}] marker: CPU twin`);
	if (statsFromWords(markedWords).valid) fail(`[${label}] marker: stats valid`);
	console.log(
		`  layout-failure marker (-1e20): subgroupLayoutFailed ${subgroupLayoutFailed(markedWords)}`,
	);
	partialBuffer.destroy();
	prm.destroy();
	graph.destroy();
	return { subgroupRow: spmv?.lowering === "webgpu-spmv:subgroup-row" };
}

const featuresOf = (all: boolean) =>
	all ? COMPUTE_FEATURES.filter((f) => adapter.features.has(f)) : [];
const first = await checkDevice("default", featuresOf(true), (possible) =>
	possible ? "webgpu-spmv:subgroup-row" : "webgpu-spmv:workgroup-row",
);
if (!first.subgroupRow)
	console.log(
		"NOTE [default]: subgroup-row NOT exercised: luma needs the subgroup_id WGSL language feature (Dawn webgpu@0.3.0 lists none), so workgroup-row ran on both devices; the subgroup-row path stays browser-only",
	);
await checkDevice("core", featuresOf(false), () => "webgpu-spmv:workgroup-row");
console.log(
	failed ? `\nFAIL stats-fold-dawn: ${failed}` : "\nPASS stats-fold-dawn",
);
process.exit(failed ? 1 : 0);
