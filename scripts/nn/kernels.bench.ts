// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// nn kernel A/B on Dawn in node: GFLOP/s of the RT-1 kernels against the legacy ones (linear, conv,
// attention, topk), variants run in one process on a fresh GpuNn each. Each sample is one forward of
// R independent ops (one graph submission) timed to a 4-byte readback; the median of RUNS samples is
// reported (the GPU is shared and noisy: treat differences under ~10% as noise).
//   DAWN_DIR=/tmp/dawn npx tsx scripts/nn/kernels.bench.ts [--variants legacy,auto,tile:8x4,f16math]
//     [--runs 7] [--only linear,conv,attention,topk]
// Variants: legacy (old kernels), auto (autoselected), tile:<name> (pin a GEMM tile, see
// gpu/gemm-select.ts), attn:<threads>x<queriesPerThread>, f16math / f16acc (shader-f16 GEMM tiles, f32 / f16 accumulation).

import { GpuNn } from "../../src/lib/nn/gpu/gpu-nn";
import { setKernelCaps } from "../../src/lib/nn/gpu/kernel-caps";
import { encodeSafetensors, floatToHalf } from "../../src/lib/nn/safetensors";
import type { Tensor } from "../../src/lib/nn/types";
import { dawnDevice } from "./dawn";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) =>
	argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const variants = arg("--variants", "legacy,auto").split(",");
const RUNS = Number(arg("--runs", "7"));
const only = new Set(arg("--only", "linear,conv,attention,topk").split(","));

const device = await dawnDevice("nn-kernels-bench");
if (!device) {
	console.log("SKIP kernels.bench: DAWN_DIR not set or no adapter");
	process.exit(0);
}
console.log(
	`device features: shader-f16 ${device.features.has("shader-f16")}, subgroups ${device.features.has("subgroups")}`,
);
const rnd = (n: number) =>
	Float32Array.from({ length: n }, (_, i) => Math.sin(i * 12.9898) * 0.5);

type Ctx = {
	variant: string;
	nn: GpuNn;
	half: (shape: number[]) => Tensor;
};
const capsOf = (variant: string) => ({
	legacy: variant === "legacy",
	f16Math: variant.startsWith("f16"),
	f16Accumulate: variant === "f16acc",
	gemmTileOverride: variant.startsWith("tile:") ? variant.slice(5) : null,
	attentionTileOverride: variant.startsWith("attn:")
		? {
				threads: Number(variant.slice(5).split("x")[0]),
				queriesPerThread: Number(variant.slice(5).split("x")[1]),
			}
		: null,
});
const contexts: Ctx[] = variants.map((variant) => {
	const nn = new GpuNn(device);
	return {
		variant,
		nn,
		half: (shape) => {
			const n = shape.reduce((a, b) => a * b, 1);
			return nn
				.weightsFromBytes(
					encodeSafetensors({
						w: { shape, data: Uint16Array.from(rnd(n), floatToHalf) },
					}),
				)
				.get("w");
		},
	};
});
const table: { label: string; ms: number[][]; flops: number }[] = [];
const hasF16 = device.features.has("shader-f16");

/** Variants are interleaved sample by sample so background GPU load hits them equally. */
async function bench(
	label: string,
	flops: number,
	R: number,
	make: (c: Ctx) => () => Tensor,
) {
	const ops = contexts.map((c) => make(c));
	const run = async (i: number) => {
		const c = contexts[i];
		setKernelCaps(capsOf(c.variant));
		const outs = await c.nn.forward(() => Array.from({ length: R }, ops[i]));
		await c.nn.read(c.nn.slice(c.nn.reshape(outs[R - 1], [-1]), 0, 0, 1));
		c.nn.dispose(outs);
	};
	for (let i = 0; i < contexts.length; i++) await run(i);
	const ms: number[][] = contexts.map(() => []);
	for (let r = 0; r < RUNS; r++)
		for (let i = 0; i < contexts.length; i++) {
			const t0 = performance.now();
			await run(i);
			ms[i].push((performance.now() - t0) / R);
		}
	table.push({ label, ms, flops });
}
if (only.has("linear"))
	for (const [M, K, N] of [
		[1369, 768, 3072],
		[2048, 768, 768],
	]) {
		await bench(`linear ${M}x${K}x${N} f32`, 2 * M * N * K, 8, (c) => {
			const a = c.nn.fromArray(rnd(M * K), [M, K]);
			const w = c.nn.fromArray(rnd(N * K), [N, K]);
			return () => c.nn.linear(a, w);
		});
		if (hasF16)
			await bench(`linear ${M}x${K}x${N} f16 w`, 2 * M * N * K, 8, (c) => {
				const a = c.nn.fromArray(rnd(M * K), [M, K]);
				const w = c.half([N, K]);
				return () => c.nn.linear(a, w);
			});
	}
if (only.has("conv"))
	for (const [C, H, W, Co] of [
		[16, 768, 1024, 16],
		[3, 768, 1024, 16],
		[64, 120, 160, 64],
	])
		await bench(
			`conv ${C}->${Co} 3x3 @${H}x${W}`,
			2 * Co * H * W * C * 9,
			4,
			(c) => {
				const x = c.nn.fromArray(rnd(C * H * W), [1, C, H, W]);
				const w = c.nn.fromArray(rnd(Co * C * 9), [Co, C, 3, 3]);
				return () => c.nn.conv2d(x, w, null, { padding: 1 });
			},
		);
if (only.has("attention"))
	for (const [B, H, N, D] of [
		[1, 12, 1369, 64],
		[2, 4, 2048, 64],
	])
		await bench(
			`attention B${B} H${H} N${N} D${D}`,
			4 * B * H * N * N * D,
			4,
			(c) => {
				const mk = () => c.nn.fromArray(rnd(B * H * N * D), [B, H, N, D]);
				const [q, k, v] = [mk(), mk(), mk()];
				return () => c.nn.attention(q, k, v);
			},
		);
if (only.has("topk")) {
	const n = 786432;
	await bench("topk 4096 of 786k f32", 0, 1, (c) => {
		const x = c.nn.fromArray(rnd(n), [1, n]);
		return () => c.nn.topk(x, 4096).indices;
	});
	if (hasF16)
		await bench("topk 4096 of 786k f16", 0, 1, (c) => {
			const x = c.half([1, n]);
			return () => c.nn.topk(x, 4096).indices;
		});
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
console.log(
	`median of ${RUNS} interleaved samples: ms/op (GFLOP/s); min in []`,
);
console.log(
	["case".padEnd(34), ...variants.map((v) => v.padStart(26))].join(" "),
);
for (const { label, ms, flops } of table)
	console.log(
		[
			label.padEnd(34),
			...ms.map((m) => {
				const med = median(m);
				const min = Math.min(...m);
				return `${med.toFixed(2)}${flops ? ` (${(flops / (med * 1e6)).toFixed(0)})` : ""} [${min.toFixed(2)}]`.padStart(
					26,
				);
			}),
		].join(" "),
	);
process.exit(0);
