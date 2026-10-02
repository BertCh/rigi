// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// nn.compile (persistent forward) on Dawn: a compiled block replays with new inputs and matches the CPU
// reference and the plain forward(); runs launched back to back without awaiting (a frame loop) each
// read their own result; ready-tensor inputs rebind; the same key and shapes is the same compiled
// forward; scope() labels reach the profiler. SKIP (exit 0) without DAWN_DIR or an adapter.
//   DAWN_DIR=/tmp/dawn npx tsx scripts/nn/compile.check.ts

import { CpuNn } from "../../src/lib/nn/cpu";
import { GpuNn } from "../../src/lib/nn/gpu/gpu-nn";
import type { Nn, Tensor } from "../../src/lib/nn/types";
import { dawnDevice } from "./dawn";

const device = await dawnDevice("nn-compile");
if (!device) {
	console.log("SKIP nn-compile: DAWN_DIR not set or no adapter");
	process.exit(0);
}
const gpu = new GpuNn(device);
const cpu = new CpuNn();
let seed = 99;
const rand = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 4294967296;
};
const randn = (n: number) =>
	Float32Array.from({ length: n }, () => rand() * 2 - 1);

const T = 20;
const C = 32;
const wData = randn(C * C);
const bData = randn(C);
const gData = randn(C);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
};
const maxErr = (a: Float32Array, b: Float32Array) => {
	let m = 0;
	for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
	return m;
};

/** x [T, C], r [T, C]: bias + gelu, a layer-scaled residual, then layerNorm of it (kept) */
const network = (nn: Nn) => {
	const w = nn.fromArray(wData, [C, C]);
	const b = nn.fromArray(bData, [C]);
	const g = nn.fromArray(gData, [C]);
	return (x: Tensor, r: Tensor) =>
		nn.scope("block", () => {
			const h = nn.gelu(nn.add(nn.matmul(x, w, { transposeB: true }), b));
			const s = nn.add(r, nn.mul(h, g));
			return { s, n: nn.layerNorm(s, g, b), pooled: nn.mean(s, 0) };
		});
};
const cpuNet = network(cpu);
const gpuNet = network(gpu);
const reference = async (x: Float32Array, r: Float32Array) => {
	const o = cpuNet(cpu.fromArray(x, [T, C]), cpu.fromArray(r, [T, C]));
	return {
		s: await cpu.read(o.s),
		n: await cpu.read(o.n),
		pooled: await cpu.read(o.pooled),
	};
};

const compiled = await gpu.compile(
	"check-block",
	[
		[T, C],
		[T, C],
	],
	(i) => gpuNet(i[0], i[1]),
);
check(
	"same key and shapes returns the same compiled forward",
	compiled ===
		(await gpu.compile(
			"check-block",
			[
				[T, C],
				[T, C],
			],
			() => {
				throw new Error("fn must not run again");
			},
		)),
);
const graphsBefore = gpu.runtime.stats.graphs + gpu.runtime.stats.graphHits;

// replay with new inputs, compare to CPU
for (let k = 0; k < 3; k++) {
	const x = randn(T * C);
	const r = randn(T * C);
	const got = await compiled.run([x, r]);
	const want = await reference(x, r);
	const e = Math.max(
		maxErr(got.s, want.s),
		maxErr(got.n, want.n),
		maxErr(got.pooled, want.pooled),
	);
	check(`replay ${k} vs CPU`, e < 1e-4, `maxAbs ${e.toExponential(2)}`);
}
check(
	"replays record no new graph",
	gpu.runtime.stats.graphs + gpu.runtime.stats.graphHits === graphsBefore,
);

// pipelined: 8 runs launched without awaiting, each with its own inputs
{
	const inputs = Array.from({ length: 8 }, () => [randn(T * C), randn(T * C)]);
	const pending = inputs.map(([x, r]) => compiled.run([x, r]));
	const results = await Promise.all(pending);
	let worst = 0;
	for (let i = 0; i < inputs.length; i++) {
		const want = await reference(inputs[i][0], inputs[i][1]);
		worst = Math.max(
			worst,
			maxErr(results[i].s, want.s),
			maxErr(results[i].n, want.n),
		);
	}
	check(
		"8 pipelined runs each read their own frame",
		worst < 1e-4,
		`maxAbs ${worst.toExponential(2)}`,
	);
}

// a ready tensor as input (rebound for the run)
{
	const x = randn(T * C);
	const r = randn(T * C);
	const xt = gpu.fromArray(x, [T, C]);
	const got = await compiled.run([xt, r]);
	const want = await reference(x, r);
	check("ready tensor input", maxErr(got.n, want.n) < 1e-4);
	gpu.dispose(xt);
}

// outputs stay on the GPU: submit, then read the persistent tensor
{
	const x = randn(T * C);
	const r = randn(T * C);
	await compiled.submit([x, r]);
	const n = await gpu.readLater(compiled.outputs.n);
	const into = new Float32Array(T * C);
	await gpu.readLater(compiled.outputs.n, into);
	const want = await reference(x, r);
	check(
		"submit + readLater of an output",
		maxErr(n, want.n) < 1e-4 && maxErr(into, n) === 0,
	);
}

// scope labels reach the graph's node ids
{
	const labels = (
		compiled as unknown as {
			graph: { compiled: { stats: { nodeOrder: string[] } } | null };
		}
	).graph.compiled?.stats.nodeOrder;
	check(
		"node ids carry the scope and op name",
		!!labels?.some((l) => l.includes("block/n") && l.includes(":")),
		labels?.slice(0, 3).join(" "),
	);
}

compiled.dispose();
check(
	"dispose forgets the compiled forward",
	(await gpu.compile(
		"check-block",
		[
			[T, C],
			[T, C],
		],
		(i) => gpuNet(i[0], i[1]),
	)) !== compiled,
);
console.log(failed ? `nn-compile: ${failed} FAILED` : "nn-compile: all pass");
process.exit(failed ? 1 : 0);
