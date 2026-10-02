// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Bench of the sky refine graph (refine-graph.ts, the only GPU refine) against the CPU twin (sky/core.ts
// refineToWorking + toBytes), run in the page realm by scripts/gpu/sky-graph-bench.mjs. Checks:
// - CPU parity: float mask max |Δ| and byte mask differences vs the CPU refine (the tolerance of
//   scripts/gpu/sky-bench.mjs: f32 vs f64 sums, ≤ ~1e-5, a few bytes off by 1), for model-buffer
//   P(sky) (shared device) at several working sizes up to 24 Mpx, plus the uploaded-floats branches
//   (classical fallback, downsample); and the bytes-only run equal to the floats run bit for bit;
// - the graph run repeatedly with different data: a shape sequence that hits, misses and evicts the
//   shape cache, every run compared to the CPU (stale transients would show as large differences);
// - the clear rule: a partial-write kernel on an aliased transient (lint must throw without a clear;
//   with the clear the stale bytes are gone; without it (lint bypassed) the stale bytes show);
// - VRAM: transient bytes as pooled slots would hold them (logical and pow2 capacity) vs the graph's
//   (physical after aliasing);
// - timing: bytes-only refines (cache hit) and one cache miss, medians.

import type { Device } from "@luma.gl/core";
import { ComputeGraph, cachedGraphCount } from "#/lib/gpu/core/graph";
import { defineKernel } from "#/lib/gpu/core/kernel";
import { capacityFor, pooledStorage, withLease } from "#/lib/gpu/core/pool";
import { getComputeDevice } from "#/lib/gpu/device";
import { publicUrl } from "#/lib/public-url";
import {
	classicalSky,
	refineToWorking,
	resamplePlanes,
	rgbPlanes,
	toBytes,
	workingSize,
} from "#/lib/sky/core";
import { createSkyModel, inferSkyModel } from "#/lib/sky/model";
import {
	axisTable,
	refineSkyGpu,
	type SkyProb,
	warmSkyKernels,
} from "./refine";
import {
	lastSkyGraphRun,
	releaseSkyGraphs,
	SKY_GRAPH_GROUP,
	skyScratchBytes,
} from "./refine-graph";

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

async function rasterise(name: string, W: number, H: number) {
	const img = new Image();
	img.src = publicUrl(`/photos/${name}.jpg`);
	await img.decode();
	const c = new OffscreenCanvas(W, H);
	const ctx = c.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("no 2d context");
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(img, 0, 0, W, H);
	return new Uint8Array(ctx.getImageData(0, 0, W, H).data);
}

/** Count differing elements (bytes, or f32 as u32 bits). */
function differ(a: ArrayBufferView, b: ArrayBufferView, u32: boolean) {
	const x = u32
		? new Uint32Array(a.buffer, a.byteOffset, a.byteLength / 4)
		: new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
	const y = u32
		? new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4)
		: new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
	if (x.length !== y.length) return -1;
	let n = 0;
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) n++;
	return n;
}

type Input = Parameters<typeof refineSkyGpu>[1];

/** Validation / OOM error scopes on every submit (a failed submit then rejects, not a stale read). */
const checks = (on: boolean) => {
	(globalThis as { __RIGI_GPU_CHECKS__?: boolean }).__RIGI_GPU_CHECKS__ = on;
};

/**
 * GPU (graph) vs the CPU refine of the same P(sky) (`cpuProb`: input.prob as floats): float max |Δ|,
 * byte mask differences (count, max); the bytes-only run must equal the floats run bit for bit.
 */
async function parity(device: Device, input: Input, cpuProb: Float32Array) {
	checks(true);
	let g: Awaited<ReturnType<typeof refineSkyGpu>>;
	let gb: Awaited<ReturnType<typeof refineSkyGpu>>;
	let run: typeof lastSkyGraphRun;
	try {
		g = await refineSkyGpu(device, { ...input, floats: true });
		run = lastSkyGraphRun;
		// bytes-only run too (the read node's other branch)
		gb = await refineSkyGpu(device, input);
	} finally {
		checks(false);
	}
	const { W, H } = input;
	// the bench inputs are host arrays
	const rgb = rgbPlanes({
		width: W,
		height: H,
		data: input.rgba as Uint8Array,
	});
	const cq = refineToWorking(
		rgb,
		W,
		H,
		{ prob: cpuProb, width: input.lw, height: input.lh },
		true,
		{ radius: input.radius, eps: input.eps, band: input.band },
	);
	const cb = toBytes(cq);
	const q = g.q as Float32Array;
	let maxAbs = 0;
	for (let i = 0; i < q.length; i++) {
		const d = Math.abs(q[i] - cq[i]);
		if (!(d <= maxAbs)) maxAbs = d;
	}
	let bytesMax = 0;
	for (let i = 0; i < cb.length; i++)
		bytesMax = Math.max(bytesMax, Math.abs(g.bytes[i] - cb[i]));
	return {
		bytes: g.bytes.length,
		cpuFloatMaxAbs: maxAbs,
		cpuBytesDiff: differ(cb, g.bytes, false),
		cpuBytesMax: bytesMax,
		bytesOnlyDiff: differ(g.bytes, gb.bytes, false),
		cacheHit: run?.hit,
	};
}

function vram(lw: number, lh: number, W: number, H: number) {
	const s = skyScratchBytes(lw, lh, W, H);
	const vals = Object.values(s);
	const st = lastSkyGraphRun?.stats;
	return {
		pooledLogical: vals.reduce((a, b) => a + b, 0),
		pooledCapacity: vals.reduce((a, b) => a + capacityFor(b), 0),
		newLogical: st?.logicalTransientBytes,
		newPhysical: st?.physicalTransientBytes,
		newPhysicalCount: st?.physicalTransientBufferCount,
	};
}

/** The clear-node / lint test on a tiny aliased graph. */
async function clearTest(device: Device) {
	const n = 1000;
	const FILL = defineKernel(
		"t-fill",
		/* wgsl */ `
@group(0) @binding(0) var<storage, read_write> a: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < ${n}u) { a[id.x] = 0xDEADBEEFu; }
}`,
		[["a", "storage"]],
		{ group: "sky-graph-test", label: "t-fill" },
	);
	const SUM = defineKernel(
		"t-copy",
		/* wgsl */ `
@group(0) @binding(0) var<storage, read> a: array<u32>;
@group(0) @binding(1) var<storage, read_write> o: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < ${n}u) { o[id.x] = a[id.x]; }
}`,
		[
			["a", "read-only-storage"],
			["o", "storage"],
		],
		{ group: "sky-graph-test", label: "t-copy" },
	);
	const HALF = defineKernel(
		"t-half",
		/* wgsl */ `
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < ${n}u && (id.x & 1u) == 0u) { b[id.x] = id.x; }
}`,
		[["b", "storage"]],
		{ group: "sky-graph-test", label: "t-half" },
	);
	const build = (mode: "clear" | "lint" | "lie") => {
		const g = new ComputeGraph(device, `sky-graph-test/${mode}`);
		const A = g.transientBuffer("A", n * 4);
		const B = g.transientBuffer("B", n * 4);
		const out = g.importBuffer("out", n * 4);
		g.addKernel({
			id: "fill",
			spec: FILL,
			bindings: { a: A },
			workgroups: [Math.ceil(n / 64)],
		}).addKernel({
			id: "copy",
			spec: SUM,
			bindings: { a: A, o: out },
			workgroups: [Math.ceil(n / 64)],
		});
		// B only starts after copy has read A, so the planner aliases B onto A's allocation
		if (mode === "clear") g.clearNode("clear-B", B, { dependsOn: ["copy"] });
		g.addKernel({
			id: "half",
			dependsOn: ["copy"],
			spec: HALF,
			bindings: { b: B },
			workgroups: [Math.ceil(n / 64)],
			writes: mode === "lie" ? undefined : { b: "partial" },
		}).readNode("read", [B]);
		g.compile();
		return { g, stats: g.stats as NonNullable<typeof g.stats> };
	};
	const run = async (mode: "clear" | "lie") => {
		const { g, stats } = build(mode);
		// the pooled slot is held from acquire to readback (core/pool.ts: unleased growth is unsafe)
		const [b] = await withLease("sky-graph-test", async () => {
			const out = pooledStorage(device, "sky-graph-test/out", n * 4);
			const { reads } = await g.run(undefined, { buffers: { out } });
			return reads.read;
		});
		g.destroy();
		const u = new Uint32Array(b);
		let oddZero = 0;
		let oddStale = 0;
		let evenOk = 0;
		for (let i = 0; i < n; i++)
			if (i & 1) {
				if (u[i] === 0) oddZero++;
				if (u[i] === 0xdeadbeef) oddStale++;
			} else if (u[i] === i) evenOk++;
		return {
			physicalTransientBufferCount: stats.physicalTransientBufferCount,
			logicalTransientBufferCount: stats.logicalTransientBufferCount,
			nodeOrder: stats.nodeOrder,
			evenOk,
			oddZero,
			oddStale,
		};
	};
	let lintError: string | undefined;
	try {
		build("lint");
	} catch (e) {
		lintError = String(e);
	}
	return {
		lintWithoutClear: lintError ?? "DID NOT THROW",
		withClear: await run("clear"),
		withoutClearLintBypassed: await run("lie"),
	};
}

export async function runSkyGraphBench(opts: {
	names: string[];
	reps?: number;
	sizes?: [number, number][];
}) {
	const reps = opts.reps ?? 7;
	const device = await getComputeDevice();
	if (!device) return { error: "no compute device" };
	await warmSkyKernels(device);
	const model = await createSkyModel({ device, backends: ["webgpu"] });
	const out = {
		device: { shared: model.device === device },
		clear: await clearTest(device),
		cases: [] as unknown[],
		sequence: [] as unknown[],
		extra: [] as unknown[],
	};
	// working sizes: the worker default (1024 long side), an N % 4 ≠ 0 size, native 3 Mpx, 12 and 24 Mpx
	const sizes = opts.sizes ?? [
		[1024, 768],
		[1021, 766],
		[2048, 1536],
		[4032, 3024],
		[4608, 3456],
	];
	const prep = async (name: string, W: number, H: number) => {
		const rgba = await rasterise(name, W, H);
		const rgb = rgbPlanes({ width: W, height: H, data: rgba });
		const inf = await inferSkyModel(model, rgb, W, H);
		const input: Input = {
			W,
			H,
			rgba,
			lw: inf.width,
			lh: inf.height,
			guideLo: inf.rgbLo,
			prob: (inf.gpuBuffer ?? (await inf.download())) as SkyProb,
		};
		const cpuProb = await inf.download();
		return { input, inf, cpuProb, gpuBuffer: !!inf.gpuBuffer };
	};

	for (const [W, H] of sizes)
		for (const name of opts.names) {
			const { input, inf, cpuProb, gpuBuffer } = await prep(name, W, H);
			try {
				const par = await parity(device, input, cpuProb);
				const v = vram(input.lw, input.lh, W, H);
				// imports (P(sky) is the model's own buffer)
				const imports =
					32 +
					3 * input.lw * input.lh * 4 +
					W * H * 4 +
					axisTable(input.lw, input.lh, W, H).byteLength +
					2048;
				const ms: number[] = [];
				// a cache miss (graph build + compile + transient allocation) on this shape
				await releaseSkyGraphs(device);
				let t = performance.now();
				await refineSkyGpu(device, input);
				const graphMiss = performance.now() - t;
				for (let r = 0; r < reps; r++) {
					t = performance.now();
					await refineSkyGpu(device, input);
					ms.push(performance.now() - t);
				}
				out.cases.push({
					name,
					size: `${W}x${H}`,
					lo: `${input.lw}x${input.lh}`,
					ortBuffer: gpuBuffer,
					...par,
					vram: { ...v, importsApprox: imports },
					ms: { graph: med(ms), graphMiss, reps },
				});
			} finally {
				inf.release();
			}
		}

	// past the 1-D dispatch limit (27 Mpx): the graph path refuses before encoding (the worker then
	// takes the CPU refine)
	{
		const { input, inf } = await prep(opts.names[0], 6000, 4500);
		const outcome = async () => {
			checks(true);
			try {
				await refineSkyGpu(device, input);
				return "resolved";
			} catch (e) {
				return `rejected: ${String(e).slice(0, 160)}`;
			} finally {
				checks(false);
			}
		};
		try {
			out.extra.push({
				case: "6000x4500 (over the dispatch limit)",
				graph: await outcome(),
			});
		} finally {
			inf.release();
		}
	}

	// the same compiled graphs driven with different data, across cache hits / misses / evictions
	await releaseSkyGraphs(device);
	const seq: [string, number, number][] = [
		[opts.names[0], 1024, 768],
		[opts.names[1] ?? opts.names[0], 1024, 768],
		[opts.names[2] ?? opts.names[0], 2048, 1536],
		[opts.names[0], 1024, 768],
		[opts.names[1] ?? opts.names[0], 4032, 3024],
		[opts.names[2] ?? opts.names[0], 2048, 1536],
		[opts.names[3] ?? opts.names[0], 1024, 768],
		[opts.names[0], 1024, 768],
	];
	for (const [name, W, H] of seq) {
		const { input, inf, cpuProb } = await prep(name, W, H);
		try {
			out.sequence.push({
				name,
				size: `${W}x${H}`,
				...(await parity(device, input, cpuProb)),
				cachedKey: lastSkyGraphRun?.key,
				cachedCount: cachedGraphCount(device, SKY_GRAPH_GROUP),
			});
		} finally {
			inf.release();
		}
	}

	// uploaded-floats branches (classical fallback P(sky); model 640 over a 512 working image)
	{
		const { width: W, height: H } = { width: 1024, height: 768 };
		const rgba = await rasterise(opts.names[0], W, H);
		const rgb = rgbPlanes({ width: W, height: H, data: rgba });
		const low = classicalSky(rgb, W, H);
		out.extra.push({
			case: `classical ${low.width}x${low.height} → ${W}x${H}`,
			...(await parity(
				device,
				{
					W,
					H,
					rgba,
					lw: low.width,
					lh: low.height,
					guideLo: resamplePlanes(rgb, W, H, 3, low.width, low.height),
					prob: low.prob,
					radius: 5,
					eps: 1e-3,
					band: 2,
				},
				low.prob,
			)),
		});
	}
	{
		const { width: W, height: H } = workingSize(2048, 1536, 512);
		const rgba = await rasterise(opts.names[0], W, H);
		const rgb = rgbPlanes({ width: W, height: H, data: rgba });
		const inf = await inferSkyModel(model, rgb, W, H, 640);
		try {
			const prob = await inf.download();
			out.extra.push({
				case: `model ${inf.width}x${inf.height} → ${W}x${H} (downsample, floats)`,
				...(await parity(
					device,
					{
						W,
						H,
						rgba,
						lw: inf.width,
						lh: inf.height,
						guideLo: inf.rgbLo,
						prob,
					},
					prob,
				)),
			});
		} finally {
			inf.release();
		}
	}
	return out;
}
