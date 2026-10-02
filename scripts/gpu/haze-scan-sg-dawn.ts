// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// HZ_SCAN vs HZ_SCAN_SG (src/lib/gpu/look/haze.wgsl.ts) on Dawn in node: the radix-select scan step
// must give the same `state` words, bit for bit (u32 adds only). Also checks, with no GPU:
// a CPU emulation of the subgroup algorithm at every plausible subgroup size against the serial walk.
//   DAWN_DIR=<dir with webgpu@0.3.0> npx tsx scripts/gpu/haze-scan-sg-dawn.ts
// Without the "subgroups" adapter feature (or without Dawn) only the CPU emulation runs and the GPU
// half is reported as skipped (exit 0). Exit 1 on any mismatch.
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	BUCKETS,
	HZ_SCAN,
	HZ_SCAN_SG,
	SEL,
} from "../../src/lib/gpu/look/haze.wgsl";

// WebGPU flag values (node has no GPU globals typed here)
const BufferUsage = {
	MAP_READ: 1,
	COPY_SRC: 4,
	COPY_DST: 8,
	UNIFORM: 64,
	STORAGE: 128,
};

let failures = 0;
const fail = (message: string) => {
	failures++;
	console.error(`FAIL ${message}`);
};

let seed = 12345;
const rand = () => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 2 ** 32;
};

const bitsOf = (pass: number) => (pass === 2 ? 10 : 11);
type Case = { pass: number; hist: Uint32Array; state: Uint32Array };

function makeCase(pass: number, sparse: boolean): Case {
	const hist = new Uint32Array(SEL * BUCKETS);
	for (let i = 0; i < hist.length; i++)
		hist[i] = sparse
			? rand() < 0.02
				? Math.floor(rand() * 50)
				: 0
			: Math.floor(rand() * 30);
	const state = new Uint32Array(SEL * 2);
	const nb = 1 << bitsOf(pass);
	for (let s = 0; s < SEL; s++) {
		const base = (pass === 0 ? s & ~3 : s) * BUCKETS;
		let total = 0;
		for (let d = 0; d < nb; d++) total += hist[base + d];
		state[2 * s] = Math.floor(rand() * 7);
		// ranks inside the block, plus some past its end (the empty-bin branch)
		state[2 * s + 1] =
			rand() < 0.1
				? total + Math.floor(rand() * 3)
				: Math.floor(rand() * Math.max(1, total));
	}
	return { pass, hist, state };
}

/** The serial walk (what both kernels reproduce). */
function serial(c: Case): Uint32Array {
	const out = new Uint32Array(c.state);
	const bits = bitsOf(c.pass);
	const nb = 1 << bits;
	for (let s = 0; s < SEL; s++) {
		const base = (c.pass === 0 ? s & ~3 : s) * BUCKETS;
		const x = c.state[2 * s];
		const y = c.state[2 * s + 1];
		let cum = 0;
		let d = 0;
		for (; d < nb; d++) {
			if (cum + c.hist[base + d] > y) break;
			cum += c.hist[base + d];
		}
		out[2 * s] = ((x << bits) | (d === nb ? nb - 1 : d)) >>> 0;
		out[2 * s + 1] = (y - cum) >>> 0;
	}
	return out;
}

/** The subgroup algorithm: per-subgroup inclusive scan, totals, prefix of earlier subgroups. */
function emulateSubgroups(c: Case, subgroupSize: number): Uint32Array {
	const out = new Uint32Array(c.state);
	const bits = bitsOf(c.pass);
	const nb = 1 << bits;
	const per = nb >> 8;
	for (let s = 0; s < SEL; s++) {
		const base = (c.pass === 0 ? s & ~3 : s) * BUCKETS;
		const loc = new Uint32Array(256);
		for (let l = 0; l < 256; l++)
			for (let k = 0; k < per; k++) loc[l] += c.hist[base + l * per + k];
		const incl = new Uint32Array(256);
		const totals: number[] = [];
		for (let r = 0; r < 256 / subgroupSize; r++) {
			let acc = 0;
			for (let l = r * subgroupSize; l < (r + 1) * subgroupSize; l++) {
				acc = (acc + loc[l]) >>> 0;
				incl[l] = acc;
			}
			totals.push(acc);
		}
		for (let l = 0; l < 256; l++) {
			let before = 0;
			for (let r = 0; r < Math.floor(l / subgroupSize); r++)
				before += totals[r];
			incl[l] = (incl[l] + before) >>> 0;
		}
		const x = c.state[2 * s];
		const y = c.state[2 * s + 1];
		for (let l = 0; l < 256; l++) {
			const excl = (incl[l] - loc[l]) >>> 0;
			if (excl <= y && y < incl[l]) {
				let cum = excl;
				let d = 0;
				for (; d < per; d++) {
					const h = c.hist[base + l * per + d];
					if (cum + h > y) break;
					cum += h;
				}
				out[2 * s] = ((x << bits) | (l * per + d)) >>> 0;
				out[2 * s + 1] = (y - cum) >>> 0;
			} else if (l === 255 && incl[l] <= y) {
				out[2 * s] = ((x << bits) | (nb - 1)) >>> 0;
				out[2 * s + 1] = (y - incl[l]) >>> 0;
			}
		}
	}
	return out;
}

const cases: Case[] = [];
for (const pass of [0, 1, 2])
	for (const sparse of [false, true]) cases.push(makeCase(pass, sparse));

const same = (a: Uint32Array, b: Uint32Array) =>
	a.length === b.length && a.every((v, i) => v === b[i]);
for (const subgroupSize of [4, 8, 16, 32, 64, 128])
	for (const c of cases)
		if (!same(serial(c), emulateSubgroups(c, subgroupSize)))
			fail(`CPU emulation size ${subgroupSize} pass ${c.pass}`);
console.log(
	`CPU emulation: ${cases.length} cases x 6 subgroup sizes ${failures ? "FAIL" : "match the serial walk"}`,
);

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP GPU half: DAWN_DIR not set");
	process.exit(failures ? 1 : 0);
}
const { create, globals } = await import(
	pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
// keep the instance referenced: Dawn drops pipelines of a collected instance
const gpu = create([]);
const adapter = await gpu.requestAdapter();
if (!adapter) {
	console.log("SKIP GPU half: no adapter");
	process.exit(failures ? 1 : 0);
}
const hasSubgroups = adapter.features.has("subgroups");
console.log(
	`adapter ${JSON.stringify(adapter.info ?? {})} subgroups: ${hasSubgroups}`,
);
const device: GPUDevice = await adapter.requestDevice({
	requiredFeatures: hasSubgroups ? ["subgroups" as GPUFeatureName] : [],
});

async function run(source: string, c: Case): Promise<Uint32Array> {
	const module = device.createShaderModule({ code: source });
	for (const m of (await module.getCompilationInfo()).messages)
		console.error(`WGSL ${m.type} ${m.lineNum}: ${m.message}`);
	const pipeline = await device.createComputePipelineAsync({
		layout: "auto",
		compute: { module, entryPoint: "main" },
	});
	const make = (data: Uint32Array, usage: number) => {
		const buffer = device.createBuffer({
			size: data.byteLength,
			usage: usage | BufferUsage.COPY_DST,
		});
		device.queue.writeBuffer(buffer, 0, data);
		return buffer;
	};
	const prm = make(new Uint32Array([0, 0, c.pass, 0]), BufferUsage.UNIFORM);
	const hist = make(c.hist, BufferUsage.STORAGE);
	const state = make(c.state, BufferUsage.STORAGE | BufferUsage.COPY_SRC);
	const read = device.createBuffer({
		size: c.state.byteLength,
		usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
	});
	const bind = device.createBindGroup({
		layout: pipeline.getBindGroupLayout(0),
		entries: [prm, hist, state].map((buffer, binding) => ({
			binding,
			resource: { buffer },
		})),
	});
	const encoder = device.createCommandEncoder();
	const computePass = encoder.beginComputePass();
	computePass.setPipeline(pipeline);
	computePass.setBindGroup(0, bind);
	computePass.dispatchWorkgroups(SEL);
	computePass.end();
	encoder.copyBufferToBuffer(state, 0, read, 0, c.state.byteLength);
	device.queue.submit([encoder.finish()]);
	await read.mapAsync(1 /* GPUMapMode.READ */);
	const out = new Uint32Array(read.getMappedRange().slice(0));
	read.unmap();
	return out;
}

for (const c of cases) {
	const want = serial(c);
	if (!same(want, await run(HZ_SCAN, c)))
		fail(`HZ_SCAN vs serial pass ${c.pass}`);
	if (!hasSubgroups) continue;
	if (!same(want, await run(HZ_SCAN_SG, c)))
		fail(`HZ_SCAN_SG vs serial pass ${c.pass}`);
	// force the in-kernel layout-failure branch: the shared-memory redo must give the same words
	const forced = HZ_SCAN_SG.replace("ssz >= 4u &&", "false &&");
	if (forced === HZ_SCAN_SG) fail("forced-fallback patch did not apply");
	if (!same(want, await run(forced, c)))
		fail(`HZ_SCAN_SG forced fallback pass ${c.pass}`);
}
console.log(
	hasSubgroups
		? "GPU: HZ_SCAN, HZ_SCAN_SG and the forced fallback are bit-identical"
		: "GPU: HZ_SCAN only (no subgroups feature on this adapter); SG skipped",
);
process.exit(failures ? 1 : 0);
