// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// nn microbenchmarks on Dawn in node (not a browser bench): GFLOP/s of matmul / linear, conv and
// fused attention on the src/lib/nn GPU backend. Each sample is one forward of R independent ops
// (one graph submission) timed to completion of a 4-byte readback, median of 7.
//   DAWN_DIR=/tmp/dawn npx tsx scripts/nn/bench.ts [--f16]

import { GpuNn } from "../../src/lib/nn/gpu/gpu-nn";
import { encodeSafetensors, floatToHalf } from "../../src/lib/nn/safetensors";
import type { Tensor } from "../../src/lib/nn/types";
import { dawnDevice } from "./dawn";

const device = await dawnDevice("nn-bench");
if (!device) {
	console.log("SKIP nn-bench: DAWN_DIR not set or no adapter");
	process.exit(0);
}
const F16 = process.argv.includes("--f16");
const nn = new GpuNn(device);
const rnd = (n: number) =>
	Float32Array.from({ length: n }, (_, i) => Math.sin(i * 12.9898) * 0.5);
const weight = (shape: number[]): Tensor => {
	const n = shape.reduce((a, b) => a * b, 1);
	if (!F16) return nn.fromArray(rnd(n), shape);
	const w = nn.weightsFromBytes(
		encodeSafetensors({
			w: { shape, data: Uint16Array.from(rnd(n), floatToHalf) },
		}),
	);
	return w.get("w");
};

async function time(label: string, flops: number, R: number, op: () => Tensor) {
	// warm-up (compiles the graph), then 7 timed samples
	const run = async () => {
		const outs = await nn.forward(() => Array.from({ length: R }, op));
		await nn.read(nn.slice(nn.reshape(outs[R - 1], [-1]), 0, 0, 1));
		nn.dispose(outs);
	};
	await run();
	const ms: number[] = [];
	for (let i = 0; i < 7; i++) {
		const t0 = performance.now();
		await run();
		ms.push(performance.now() - t0);
	}
	ms.sort((a, b) => a - b);
	const med = ms[3];
	console.log(
		`${label.padEnd(44)} ${(med / R).toFixed(3).padStart(8)} ms/op  ${((flops * R) / (med * 1e6)).toFixed(1).padStart(7)} GFLOP/s`,
	);
}

console.log(`nn-bench on Dawn, weights ${F16 ? "f16" : "f32"}`);
for (const [M, K, N] of [
	[256, 256, 256],
	[1024, 1024, 1024],
	[2048, 768, 768],
	[1369, 768, 3072],
	[4096, 256, 256],
]) {
	const a = nn.fromArray(rnd(M * K), [M, K]);
	const w = weight([N, K]);
	await time(`linear ${M}x${K} · (${N}x${K})ᵀ`, 2 * M * N * K, 8, () =>
		nn.linear(a, w),
	);
	nn.dispose(a);
}
{
	const a = nn.fromArray(rnd(1024 * 1024), [1024, 1024]);
	const b = nn.fromArray(rnd(1024 * 1024), [1024, 1024]);
	await time("matmul 1024³", 2 * 1024 ** 3, 8, () => nn.matmul(a, b));
}
for (const [C, H, W, Co, k] of [
	[3, 768, 1024, 16, 3],
	[16, 768, 1024, 16, 3],
	[16, 384, 512, 32, 3],
	[64, 120, 160, 64, 3],
	[128, 60, 80, 128, 3],
	[32, 240, 320, 32, 3],
]) {
	const x = nn.fromArray(rnd(C * H * W), [1, C, H, W]);
	const w = weight([Co, C, k, k]);
	await time(
		`conv ${C}→${Co} ${k}x${k} @ ${H}x${W}`,
		2 * Co * H * W * C * k * k,
		4,
		() => nn.conv2d(x, w, null, { padding: 1 }),
	);
}
for (const [B, H, N, D] of [
	[1, 12, 1369, 64],
	[1, 6, 1369, 64],
	[2, 4, 2048, 64],
	[1, 4, 512, 64],
]) {
	const q = nn.fromArray(rnd(B * H * N * D), [B, H, N, D]);
	const k = nn.fromArray(rnd(B * H * N * D), [B, H, N, D]);
	const v = nn.fromArray(rnd(B * H * N * D), [B, H, N, D]);
	await time(
		`attention B${B} H${H} N${N} D${D}`,
		4 * B * H * N * N * D,
		4,
		() => nn.attention(q, k, v),
	);
}
process.exit(0);
