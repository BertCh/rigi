// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// nn GPU ↔ CPU parity: every GPU op (WGSL kernels on one ComputeGraph per forward, src/lib/nn/gpu)
// against the CPU reference backend (src/lib/nn/cpu.ts) on seeded random tensors, on a real luma
// WebGPU device over Dawn in node. Prints max abs / rel error per case; exit 1 over tolerance.
// SKIP (exit 0) without DAWN_DIR (a dir with `npm i webgpu@0.3.0`) or an adapter.
//
//   DAWN_DIR=/tmp/dawn npx tsx scripts/nn/parity.check.ts [--only name,…] [--no-f16]
// The weight-taking cases run again with f16 weights on shader-f16 devices (--no-f16 skips).

import { CpuNn } from "../../src/lib/nn/cpu";
import { GpuNn } from "../../src/lib/nn/gpu/gpu-nn";
import { encodeSafetensors, floatToHalf } from "../../src/lib/nn/safetensors";
import type { Nn, Tensor } from "../../src/lib/nn/types";
import { dawnDevice } from "./dawn";

const argv = process.argv.slice(2);
const only = argv.includes("--only")
	? new Set(argv[argv.indexOf("--only") + 1].split(","))
	: null;

const device = await dawnDevice("nn-parity");
if (!device) {
	console.log("SKIP nn-parity: DAWN_DIR not set or no adapter");
	process.exit(0);
}
const gpu = new GpuNn(device);
const cpu = new CpuNn();
console.log(`nn-parity: f16 storage ${gpu.backend.f16 ? "yes" : "no"}`);

let seed = 12345;
const rand = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 4294967296;
};
const randn = (n: number, scale = 1) =>
	Float32Array.from({ length: n }, () => (rand() * 2 - 1) * scale);

type Case = {
	name: string;
	shapes: number[][];
	/** custom input data per shape (default uniform in [-1, 1]) */
	data?: (Float32Array | null)[];
	fn: (nn: Nn, ...t: Tensor[]) => Tensor | Tensor[] | { [k: string]: Tensor };
	/** max abs error allowed, relative to max |cpu| (default 1e-4) */
	tol?: number;
	/** inputs that are weights (uploaded as f16 in the --f16 pass) */
	weights?: number[];
};

const n = (s: number[]) => s.reduce((a, b) => a * b, 1);

const cases: Case[] = [
	// elementwise
	{
		name: "add-bcast",
		shapes: [
			[2, 3, 4, 5],
			[3, 1, 5],
		],
		fn: (nn, a, b) => nn.add(a, b),
	},
	{ name: "mul-scalar", shapes: [[7, 9]], fn: (nn, a) => nn.mul(a, 2.5) },
	{
		name: "div-scalar-left",
		shapes: [[7, 9]],
		fn: (nn, a) => nn.div(1, nn.add(nn.unary("abs", a), 0.5)),
	},
	{
		name: "sub-flat",
		shapes: [[1000], [1000]],
		fn: (nn, a, b) => nn.sub(a, b),
	},
	{
		name: "max-min",
		shapes: [
			[4, 8],
			[1, 8],
		],
		fn: (nn, a, b) => [nn.maximum(a, b), nn.minimum(a, b)],
	},
	{
		name: "pow",
		shapes: [[64], [64]],
		fn: (nn, a, b) => nn.binary("pow", nn.add(nn.unary("abs", a), 0.1), b),
	},
	{
		name: "compare-where",
		shapes: [[3, 16], [16]],
		fn: (nn, a, b) => nn.where(nn.compare("gt", a, b), a, nn.scale(b, -1)),
	},
	...(
		[
			"relu",
			"gelu",
			"geluTanh",
			"silu",
			"sigmoid",
			"tanh",
			"elu",
			"selu",
			"softplus",
			"logSigmoid",
			"exp",
			"abs",
			"neg",
			"square",
			"floor",
		] as const
	).map(
		(op): Case => ({
			name: `unary-${op}`,
			shapes: [[333]],
			data: [randn(333, 4)],
			fn: (nn, a) => nn.unary(op, a),
		}),
	),
	{
		name: "unary-log-sqrt-rsqrt",
		shapes: [[100]],
		fn: (nn, a) => {
			const p = nn.add(nn.unary("abs", a), 0.01);
			return [nn.unary("log", p), nn.unary("sqrt", p), nn.unary("rsqrt", p)];
		},
	},
	{
		name: "leaky-elu-clamp",
		shapes: [[200]],
		data: [randn(200, 3)],
		fn: (nn, a) => [
			nn.leakyRelu(a, 0.2),
			nn.elu(a, 0.7),
			nn.clamp(a, -0.5, 0.25),
		],
	},
	// products
	{
		name: "matmul-64",
		shapes: [
			[64, 64],
			[64, 64],
		],
		fn: (nn, a, b) => nn.matmul(a, b),
	},
	{
		name: "matmul-ragged",
		shapes: [
			[37, 71],
			[71, 19],
		],
		fn: (nn, a, b) => nn.matmul(a, b),
	},
	{
		name: "matmul-batch-bcast",
		shapes: [
			[2, 3, 33, 17],
			[3, 17, 45],
		],
		fn: (nn, a, b) => nn.matmul(a, b),
	},
	{
		name: "matmul-transB",
		shapes: [
			[4, 50, 64],
			[4, 70, 64],
		],
		fn: (nn, a, b) => nn.matmul(a, b, { transposeB: true }),
	},
	{
		name: "linear",
		shapes: [[2, 129, 96], [80, 96], [80]],
		weights: [1, 2],
		fn: (nn, x, w, b) => nn.linear(x, w, b),
	},
	{
		name: "linear-big",
		shapes: [[512, 256], [256, 256], [256]],
		weights: [1, 2],
		fn: (nn, x, w, b) => nn.linear(x, w, b),
	},
	// convolutions
	{
		name: "conv3x3",
		shapes: [[2, 8, 17, 19], [16, 8, 3, 3], [16]],
		weights: [1, 2],
		fn: (nn, x, w, b) => nn.conv2d(x, w, b, { padding: 1 }),
	},
	{
		name: "conv-stride-dil",
		shapes: [[1, 12, 23, 21], [24, 12, 3, 3], [24]],
		weights: [1, 2],
		fn: (nn, x, w, b) =>
			nn.conv2d(x, w, b, { stride: 2, padding: 2, dilation: 2 }),
	},
	{
		name: "conv-1x1",
		shapes: [
			[1, 64, 20, 20],
			[32, 64, 1, 1],
		],
		weights: [1],
		fn: (nn, x, w) => nn.conv2d(x, w),
	},
	{
		name: "conv-groups",
		shapes: [[1, 16, 11, 11], [32, 4, 3, 3], [32]],
		weights: [1, 2],
		fn: (nn, x, w, b) => nn.conv2d(x, w, b, { padding: 1, groups: 4 }),
	},
	{
		name: "conv-depthwise",
		shapes: [[2, 16, 13, 9], [16, 1, 3, 3], [16]],
		weights: [1, 2],
		fn: (nn, x, w, b) => nn.conv2d(x, w, b, { padding: 1, groups: 16 }),
	},
	{
		name: "conv-small-cout",
		shapes: [
			[1, 8, 15, 15],
			[3, 8, 5, 5],
		],
		weights: [1],
		fn: (nn, x, w) => nn.conv2d(x, w, null, { padding: 2 }),
	},
	{
		name: "conv-patch14",
		shapes: [[1, 3, 56, 42], [32, 3, 14, 14], [32]],
		weights: [1, 2],
		fn: (nn, x, w, b) => nn.conv2d(x, w, b, { stride: 14 }),
	},
	{
		name: "convT-2x",
		shapes: [[1, 16, 9, 7], [16, 8, 4, 4], [8]],
		weights: [1, 2],
		fn: (nn, x, w, b) => nn.convTranspose2d(x, w, b, { stride: 2, padding: 1 }),
	},
	{
		name: "convT-opad-groups",
		shapes: [
			[2, 8, 5, 6],
			[8, 8, 3, 3],
		],
		weights: [1],
		fn: (nn, x, w) =>
			nn.convTranspose2d(x, w, null, {
				stride: 2,
				padding: 1,
				outputPadding: 1,
				groups: 2,
			}),
	},
	{
		name: "deform-mask",
		shapes: [
			[1, 8, 12, 10],
			[1, 18, 12, 10],
			[1, 9, 12, 10],
			[16, 8, 3, 3],
			[16],
		],
		data: [null, randn(18 * 120, 2.5), null, null, null],
		weights: [3, 4],
		fn: (nn, x, off, m, w, b) =>
			nn.deformConv2d(x, off, nn.sigmoid(m), w, b, { padding: 1 }),
	},
	{
		name: "deform-nomask-dg2",
		shapes: [
			[1, 8, 9, 9],
			[1, 36, 9, 9],
			[8, 8, 3, 3],
		],
		data: [null, randn(36 * 81, 1.7), null],
		weights: [2],
		fn: (nn, x, off, w) =>
			nn.deformConv2d(x, off, null, w, null, { padding: 1, offsetGroups: 2 }),
	},
	// normalisation
	{
		name: "softmax-row",
		shapes: [[37, 300]],
		data: [randn(37 * 300, 6)],
		fn: (nn, a) => [nn.softmax(a), nn.logSoftmax(a)],
	},
	{
		name: "softmax-col",
		shapes: [[3, 50, 7]],
		data: [randn(3 * 50 * 7, 6)],
		fn: (nn, a) => [nn.softmax(a, 1), nn.logSoftmax(a, 1)],
	},
	{
		name: "layernorm",
		shapes: [[2, 70, 384], [384], [384]],
		weights: [1, 2],
		fn: (nn, x, w, b) => nn.layerNorm(x, w, b, 1e-6),
	},
	{
		name: "layernorm-plain",
		shapes: [[5, 33]],
		fn: (nn, x) => nn.layerNorm(x),
	},
	{
		name: "batchnorm",
		shapes: [[2, 6, 5, 5], [6], [6], [6], [6]],
		data: [
			null,
			null,
			Float32Array.from({ length: 6 }, () => 0.5 + rand()),
			null,
			null,
		],
		fn: (nn, x, m, v, w, b) => nn.batchNorm(x, m, v, w, b),
	},
	{
		name: "groupnorm",
		shapes: [[2, 32, 9, 11], [32], [32]],
		weights: [1, 2],
		fn: (nn, x, w, b) => nn.groupNorm(x, 8, w, b),
	},
	{
		name: "l2norm",
		shapes: [
			[2, 128, 6, 5],
			[300, 256],
		],
		fn: (nn, a, b) => [nn.l2Normalize(a, 1), nn.l2Normalize(b, -1)],
	},
	// attention
	{
		name: "attention-64",
		shapes: [
			[1, 4, 200, 64],
			[1, 4, 231, 64],
			[1, 4, 231, 64],
		],
		data: [randn(51200, 2), null, null],
		fn: (nn, q, k, v) => nn.attention(q, k, v),
	},
	{
		name: "attention-mask",
		shapes: [
			[2, 2, 33, 32],
			[2, 2, 47, 32],
			[2, 2, 47, 16],
			[1, 1, 33, 47],
		],
		fn: (nn, q, k, v, m) =>
			nn.attention(q, k, v, { mask: nn.scale(m, 3), scale: 0.3 }),
	},
	{
		name: "rotary",
		shapes: [
			[1, 4, 10, 32],
			[1, 1, 10, 32],
			[1, 1, 10, 32],
		],
		fn: (nn, x, c, s) => [
			nn.rotaryEmbed(x, c, s),
			nn.rotaryEmbed(x, c, s, { interleaved: false }),
		],
	},
	// spatial
	{
		name: "maxpool",
		shapes: [[2, 3, 17, 16]],
		fn: (nn, x) => [
			nn.maxPool2d(x, { kernel: 3, stride: 2, padding: 1 }),
			nn.maxPool2d(x, { kernel: 4 }),
		],
	},
	{
		name: "avgpool",
		shapes: [[1, 3, 11, 13]],
		fn: (nn, x) => [
			nn.avgPool2d(x, { kernel: 3, stride: 2, padding: 1 }),
			nn.avgPool2d(x, {
				kernel: 3,
				stride: 2,
				padding: 1,
				countIncludePad: false,
			}),
		],
	},
	{
		name: "interp-bilinear",
		shapes: [[1, 4, 7, 9]],
		fn: (nn, x) => [
			nn.interpolate(x, { size: [20, 13], mode: "bilinear" }),
			nn.interpolate(x, {
				size: [20, 13],
				mode: "bilinear",
				alignCorners: true,
			}),
			nn.interpolate(x, { scale: 4, mode: "bilinear" }),
		],
	},
	{
		name: "interp-nearest-bicubic",
		shapes: [[2, 3, 6, 5]],
		fn: (nn, x) => [
			nn.interpolate(x, { size: [13, 11], mode: "nearest" }),
			nn.interpolate(x, { size: [13, 11], mode: "bicubic" }),
			nn.interpolate(x, { size: [3, 3], mode: "bicubic", alignCorners: true }),
		],
	},
	{
		name: "gridsample",
		shapes: [
			[2, 5, 12, 14],
			[2, 7, 9, 2],
		],
		data: [null, randn(2 * 63 * 2, 1.2)],
		fn: (nn, x, g) => [
			nn.gridSample(x, g, { alignCorners: true }),
			nn.gridSample(x, g),
			nn.gridSample(x, g, { padding: "border" }),
		],
	},
	{ name: "nms", shapes: [[1, 1, 30, 40]], fn: (nn, x) => nn.nmsMaxPool(x, 2) },
	// layout
	{
		name: "permute",
		shapes: [[2, 3, 4, 5]],
		fn: (nn, x) => [nn.permute(x, [0, 2, 3, 1]), nn.transpose(x, 1, 3)],
	},
	{
		name: "slice-split",
		shapes: [[4, 10, 6]],
		fn: (nn, x) => [nn.slice(x, 1, 1, -2, 2), ...nn.split(x, 3, 1)],
	},
	{
		name: "concat",
		shapes: [
			[2, 3, 5],
			[2, 4, 5],
			[2, 1, 5],
		],
		fn: (nn, a, b, c) => [nn.concat([a, b, c], 1), nn.concat([a, a], -1)],
	},
	{
		name: "gather",
		shapes: [[6, 9, 4], [5]],
		data: [null, Float32Array.from([8, 0, 3, -1, 3])],
		fn: (nn, x, i) => nn.gather(x, i, 1),
	},
	{
		name: "pad",
		shapes: [[2, 3, 6, 5]],
		fn: (nn, x) => [
			nn.pad(x, [1, 2, 3, 0]),
			nn.pad(x, [2, 2, 1, 1], { mode: "reflect" }),
			nn.pad(x, [0, 3, 2, 1], { mode: "replicate" }),
			nn.pad(x, [1, 1, 0, 0, 1, 1], { value: 7 }),
		],
	},
	{
		name: "expand-reshape",
		shapes: [[3, 1, 4]],
		fn: (nn, x) => nn.reshape(nn.expand(x, [2, 3, 5, 4]), [6, -1]),
	},
	{
		name: "reduce-col",
		shapes: [[4, 7, 6]],
		fn: (nn, x) => [
			nn.sum(x, 1),
			nn.mean(x, 1, true),
			nn.max(x, 0),
			nn.min(x, 1),
			nn.argmax(x, 1),
		],
	},
	{
		name: "reduce-row",
		shapes: [[6, 1000]],
		fn: (nn, x) => [
			nn.sum(x, -1),
			nn.mean(x, -1),
			nn.max(x, -1),
			nn.min(x, -1),
			nn.argmax(x, -1),
		],
	},
	{
		name: "full",
		shapes: [[2]],
		fn: (nn) => [nn.full([3, 5], 2.5), nn.zeros([7])],
	},
	{ name: "topk-small", shapes: [[3, 100]], fn: (nn, x) => nn.topk(x, 10) },
	{ name: "topk-axis0", shapes: [[50, 3]], fn: (nn, x) => nn.topk(x, 5, 0) },
	{ name: "topk-large", shapes: [[1, 70000]], fn: (nn, x) => nn.topk(x, 2048) },
	// a transformer block in one forward (transients aliased across ~20 nodes)
	{
		name: "block",
		shapes: [
			[1, 50, 64],
			[192, 64],
			[192],
			[64, 64],
			[64],
			[64],
			[64],
			[128, 64],
			[128],
			[64, 128],
			[64],
		],
		weights: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
		fn: (nn, x, wqkv, bqkv, wo, bo, g, b, w1, b1, w2, b2) => {
			const h = nn.layerNorm(x, g, b);
			const qkv = nn.reshape(nn.linear(h, wqkv, bqkv), [1, 50, 3, 4, 16]);
			const [q, k, v] = [0, 1, 2].map((i) =>
				nn.permute(
					nn.reshape(nn.slice(qkv, 2, i, i + 1), [1, 50, 4, 16]),
					[0, 2, 1, 3],
				),
			);
			const a = nn.reshape(
				nn.permute(nn.attention(q, k, v), [0, 2, 1, 3]),
				[1, 50, 64],
			);
			const x1 = nn.add(x, nn.linear(a, wo, bo));
			const m = nn.linear(
				nn.gelu(nn.linear(nn.layerNorm(x1, g, b), w1, b1)),
				w2,
				b2,
			);
			return nn.add(x1, m);
		},
	},
];

const flat = (r: unknown): Tensor[] =>
	Array.isArray(r)
		? r.flatMap(flat)
		: r && typeof r === "object" && !("shape" in (r as object))
			? Object.values(r as object).flatMap(flat)
			: [r as Tensor];

let failed = 0;
const rows: string[] = [];
const runPass = async (f16: boolean, pick = only) => {
	for (const c of cases) {
		if (pick && !pick.has(c.name)) continue;
		if (f16 && !c.weights) continue;
		const datas = c.shapes.map((s, i) => c.data?.[i] ?? randn(n(s)));
		const cIn = datas.map((d, i) => cpu.fromArray(d, c.shapes[i]));
		const want = flat(c.fn(cpu, ...cIn));
		// f16 pass: weights go in as f16 safetensors on both sides (CPU widens the same halves)
		let gIn: Tensor[];
		if (f16 && c.weights) {
			const tensors: Record<string, { shape: number[]; data: Uint16Array }> =
				{};
			for (const wi of c.weights)
				tensors[`w${wi}`] = {
					shape: c.shapes[wi],
					data: Uint16Array.from(datas[wi], floatToHalf),
				};
			const bytes = encodeSafetensors(tensors);
			const gw = gpu.weightsFromBytes(bytes);
			const cw = cpu.weightsFromBytes(bytes);
			gIn = datas.map((d, i) =>
				c.weights?.includes(i)
					? gw.get(`w${i}`)
					: gpu.fromArray(d, c.shapes[i]),
			);
			const cIn2 = datas.map((_d, i) =>
				c.weights?.includes(i) ? cw.get(`w${i}`) : cIn[i],
			);
			want.splice(0, want.length, ...flat(c.fn(cpu, ...cIn2)));
		} else gIn = datas.map((d, i) => gpu.fromArray(d, c.shapes[i]));
		let got: Tensor[];
		try {
			got = flat(await gpu.forward(() => c.fn(gpu, ...gIn)));
		} catch (e) {
			failed++;
			rows.push(
				`FAIL ${c.name}${f16 ? " (f16)" : ""}: ${(e as Error).message}`,
			);
			continue;
		}
		let worstAbs = 0;
		let worstRel = 0;
		let bad = "";
		for (let o = 0; o < want.length; o++) {
			const a = await cpu.read(want[o]);
			const b = await gpu.read(got[o]);
			if (want[o].shape.join() !== got[o].shape.join())
				bad = `shape ${got[o].shape} vs ${want[o].shape}`;
			let mx = 0;
			for (const v of a) mx = Math.max(mx, Math.abs(v));
			for (let i = 0; i < a.length; i++) {
				const d = Math.abs(a[i] - b[i]);
				if (!(d <= worstAbs))
					worstAbs = Number.isNaN(d) ? Number.POSITIVE_INFINITY : d;
				worstRel = Math.max(worstRel, d / Math.max(mx, 1e-6));
			}
		}
		gpu.dispose(got);
		gpu.dispose(gIn);
		const tol = c.tol ?? 1e-4;
		const ok = !bad && worstRel <= tol;
		if (!ok) failed++;
		rows.push(
			`${ok ? "PASS" : "FAIL"} ${c.name}${f16 ? " (f16)" : ""}  maxAbs ${worstAbs.toExponential(2)}  maxRel ${worstRel.toExponential(2)}${bad ? `  ${bad}` : ""}`,
		);
	}
};
await runPass(false);
// the same block twice: the second forward re-encodes the cached graph
const before = gpu.runtime.stats.graphHits;
await runPass(false, new Set(["block"]));
if (gpu.runtime.stats.graphHits <= before) {
	failed++;
	rows.push(
		"FAIL graph cache: a repeated forward did not hit the cached graph",
	);
}
// eager ops outside forward() are recorded and flushed on read()
{
	const a = gpu.fromArray([1, 2, 3, 4], [2, 2]);
	const b = gpu.relu(gpu.sub(gpu.matmul(a, a), 10));
	const got = [...(await gpu.read(b))].join();
	const ok = got === "0,0,5,12";
	if (!ok) failed++;
	rows.push(`${ok ? "PASS" : "FAIL"} eager ops outside forward: ${got}`);
}
if (!argv.includes("--no-f16") && gpu.backend.f16) await runPass(true);
for (const r of rows) console.log(r);
console.log(
	`nn-parity: ${rows.length - failed}/${rows.length} pass; graphs ${gpu.runtime.stats.graphs}, nodes ${gpu.runtime.stats.nodes}`,
);
process.exit(failed ? 1 : 0);
