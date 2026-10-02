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
import { setKernelCaps } from "../../src/lib/nn/gpu/kernel-caps";
import { quantize } from "../../src/lib/nn/quant";
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
let gpu = new GpuNn(device);
// the f32 passes check the f32 kernels; the f16 products pass below checks the shipped default (f16Math on)
setKernelCaps({ f16Math: false });
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
	/** tensors, or arrays / plain objects of them (nested) */
	fn: (nn: Nn, ...t: Tensor[]) => unknown;
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
	// conv fusion (fusion.ts fuseConv): a replicate pad folded into the loads, a residual add folded into the store
	{
		name: "conv-replicate-pad-residual",
		shapes: [[2, 16, 13, 17], [16, 16, 3, 3], [16], [16, 16, 3, 3], [16]],
		weights: [1, 2, 3, 4],
		fn: (nn, x, w, b, w2, b2) => {
			const pad = (t: Tensor) => nn.pad(t, [1, 1, 1, 1], { mode: "replicate" });
			const y = nn.relu(nn.conv2d(pad(nn.relu(x)), w, b));
			return nn.add(x, nn.conv2d(pad(y), w2, b2));
		},
	},
	{
		name: "conv-grouped-act-residual",
		shapes: [[1, 24, 11, 9], [24, 8, 3, 3], [24]],
		weights: [1, 2],
		fn: (nn, x, w, b) =>
			nn.add(
				nn.relu(
					nn.conv2d(nn.pad(x, [1, 1, 1, 1], { mode: "replicate" }), w, b, {
						groups: 3,
					}),
				),
				x,
			),
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
	// RT-1 kernels: vec4 operand loads, 8 × 4 tiles, gathering conv loader, wide attention, f16 topk
	{
		name: "matmul-vecA-scalarB",
		shapes: [
			[133, 64],
			[64, 19],
		],
		fn: (nn, a, b) => nn.matmul(a, b),
	},
	{
		name: "matmul-scalarA-vecB",
		shapes: [
			[133, 71],
			[71, 20],
		],
		fn: (nn, a, b) => nn.matmul(a, b),
	},
	{
		name: "matmul-vec-batch-8x4",
		shapes: [
			[3, 150, 96],
			[96, 132],
		],
		fn: (nn, a, b) => nn.matmul(a, b),
	},
	{
		name: "linear-8x4-bias-act",
		shapes: [[2, 140, 100], [196, 100], [196]],
		weights: [1, 2],
		fn: (nn, x, w, b) => nn.gelu(nn.linear(x, w, b)),
	},
	{
		name: "conv-g4-wrap",
		shapes: [[1, 16, 23, 37], [16, 16, 3, 3], [16]],
		weights: [1, 2],
		fn: (nn, x, w, b) => nn.conv2d(x, w, b, { padding: 1 }),
	},
	{
		name: "conv-g4-stride-nopad",
		shapes: [
			[2, 5, 31, 29],
			[12, 5, 3, 3],
		],
		weights: [1],
		fn: (nn, x, w) => nn.conv2d(x, w, null, { stride: 2 }),
	},
	{
		name: "conv-g4-1x1-big",
		shapes: [
			[1, 48, 33, 41],
			[96, 48, 1, 1],
		],
		weights: [1],
		fn: (nn, x, w) => nn.conv2d(x, w),
	},
	{
		name: "attention-long",
		shapes: [
			[1, 2, 530, 64],
			[1, 2, 301, 64],
			[1, 2, 301, 64],
		],
		fn: (nn, q, k, v) => nn.attention(q, k, v),
	},
	{
		name: "attention-d30",
		shapes: [
			[1, 2, 300, 30],
			[1, 2, 77, 30],
			[1, 2, 77, 30],
		],
		fn: (nn, q, k, v) => nn.attention(q, k, v),
	},
	{
		name: "topk-f16-luma",
		shapes: [[1, 70000]],
		weights: [0],
		fn: (nn, x) => nn.topk(x, 700),
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
	{
		name: "topk-k1",
		shapes: [[2, 300, 257]],
		fn: (nn, x) => [nn.topk(x, 1, 1), nn.topk(x, 1, 2), nn.topk(x, 1, 0)],
	},
	{ name: "topk-large", shapes: [[1, 70000]], fn: (nn, x) => nn.topk(x, 2048) },
	// luma GPUSort path: heavy ties (values on a 1/64 grid, signed zeros), ties go to the lower index
	{
		name: "topk-ties-luma",
		shapes: [[1, 70000]],
		data: [
			Float32Array.from({ length: 70000 }, (_, i) =>
				i % 7 === 0 ? -0 : Math.round(Math.sin(i * 0.37) * 8) / 64,
			),
		],
		fn: (nn, x) => nn.topk(x, 700),
	},
	// luma GPUReduction path (one long row) and the mean built on it
	{
		name: "reduce-huge",
		shapes: [[1, 300000]],
		fn: (nn, x) => [
			nn.sum(x, 1),
			nn.mean(x, 1),
			nn.max(x, 1),
			nn.min(x, 1, true),
		],
	},
	// luma GPUTranspose / GPUElementwise paths
	{
		name: "transpose-luma",
		shapes: [[37, 301]],
		fn: (nn, x) => [
			nn.transpose(x, 0, 1),
			nn.permute(nn.reshape(x, [1, 37, 301]), [0, 2, 1]),
		],
	},
	// epilogue fusion: unary after conv / linear / deform folds into the store, unless the pre-activation is also used
	{
		name: "fused-act",
		shapes: [
			[1, 8, 10, 12],
			[16, 8, 3, 3],
			[16],
			[2, 30, 16],
			[24, 16],
			[24],
			[1, 18, 10, 12],
		],
		weights: [1, 2, 4, 5],
		fn: (nn, x, w, b, s, lw, lb, off) => {
			const c = nn.conv2d(x, w, b, { padding: 1 });
			return [
				nn.selu(c),
				nn.silu(nn.conv2d(x, w, null, { padding: 1 })),
				nn.clamp(nn.linear(s, lw, lb), -0.3, 0.4),
				nn.leakyRelu(nn.matmul(s, nn.transpose(s, 1, 2)), 0.1),
				nn.relu(
					nn.deformConv2d(x, off, null, nn.slice(w, 0, 0, 4), null, {
						padding: 1,
					}),
				),
				nn.gelu(nn.conv2d(x, nn.slice(w, 0, 0, 2), null, { padding: 1 })),
			];
		},
	},
	{
		name: "fused-act-kept",
		shapes: [
			[3, 20],
			[7, 20],
		],
		fn: (nn, x, w) => {
			const y = nn.linear(x, w);
			return [y, nn.relu(y)];
		},
	},
	// a transformer block in one forward (transients aliased across ~20 nodes)
	// elementwise chain fusion (gpu/fusion.ts): bias + gelu, a * gamma + r, trees, scalars, a shared intermediate
	{
		name: "fuse-ew-chain",
		shapes: [[4, 30], [30], [4, 30], [30], [4, 1]],
		fn: (nn, x, bias, r, gamma, col) => {
			const shared = nn.add(x, 1.5);
			return [
				nn.gelu(nn.add(x, bias)),
				nn.add(nn.mul(x, gamma), r),
				nn.sub(nn.maximum(x, 0.1), nn.mul(r, 2)),
				nn.unary("neg", nn.unary("exp", nn.clamp(x, -1, 1))),
				nn.mul(nn.add(x, 1), 3),
				nn.where(nn.compare("gt", x, 0), nn.add(x, col), nn.mul(r, col)),
				nn.mul(shared, shared),
				nn.relu(nn.add(shared, r)),
			];
		},
	},
	// layerNorm over an elementwise expression, with and without the expression's value also read
	{
		name: "fuse-ln-residual",
		shapes: [[3, 50, 64], [3, 50, 64], [64], [64], [64]],
		fn: (nn, x, r, gamma, g, b) => {
			const s = nn.add(x, nn.mul(r, gamma));
			const kept = nn.layerNorm(s, g, b);
			const alone = nn.layerNorm(nn.add(x, r), null, null, 1e-6);
			const only = nn.layerNorm(nn.add(r, 0.5), g, null);
			return [kept, nn.add(s, nn.relu(kept)), alone, only];
		},
	},
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
if (only && !only.has("block")) await runPass(false, new Set(["block"]));
const before = gpu.runtime.stats.graphHits;
await runPass(false, new Set(["block"]));
if (gpu.runtime.stats.graphHits <= before) {
	failed++;
	rows.push(
		"FAIL graph cache: a repeated forward did not hit the cached graph",
	);
}
// fromTexture: an rgba8unorm texture resampled + normalised in a graph kernel vs CPU interpolate
{
	const { Texture } = await import("@luma.gl/core");
	const tw = 13;
	const th = 9;
	const px = Uint8Array.from({ length: tw * th * 4 }, () =>
		Math.floor(rand() * 256),
	);
	const tex = device.createTexture({
		format: "rgba8unorm",
		width: tw,
		height: th,
		usage: Texture.SAMPLE | Texture.COPY_DST,
		data: px,
	});
	const mean = [0.485, 0.456, 0.406];
	const std = [0.229, 0.224, 0.225];
	const planes = new Float32Array(3 * tw * th);
	for (let c = 0; c < 3; c++)
		for (let i = 0; i < tw * th; i++)
			planes[c * tw * th + i] = px[i * 4 + c] / 255;
	const ref = cpu.interpolate(cpu.fromArray(planes, [1, 3, th, tw]), {
		size: [20, 31],
		mode: "bilinear",
	});
	const norm = cpu.div(
		cpu.sub(ref, cpu.fromArray(mean, [3, 1, 1])),
		cpu.fromArray(std, [3, 1, 1]),
	);
	const a = await cpu.read(norm);
	const g = await gpu.forward(() =>
		gpu.fromTexture(tex, { shape: [1, 3, 20, 31], mean, std }),
	);
	const b = await gpu.read(g);
	let worst = 0;
	for (let i = 0; i < a.length; i++)
		worst = Math.max(worst, Math.abs(a[i] - b[i]));
	const ok = worst < 1e-4;
	if (!ok) failed++;
	rows.push(
		`${ok ? "PASS" : "FAIL"} fromTexture rgba8unorm 13x9 → [1,3,20,31] normalised  maxAbs ${worst.toExponential(2)}`,
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
// quantized weights (src/lib/nn/quant.ts): the GPU dequant kernel vs the CPU loader, read back and
// used by a linear inside a forward
{
	const specs: [number[], 4 | 8, number][] = [
		[[7, 64], 8, 64],
		[[5, 3, 3, 3], 8, 27],
		[[9, 96], 4, 32],
		[[3, 5], 4, 5],
	];
	const tensors: Parameters<typeof encodeSafetensors>[0] = {
		plain: { shape: [4], data: Uint16Array.from([1, 2, 3, 4], floatToHalf) },
	};
	const table: Record<string, unknown> = {};
	specs.forEach(([shape, bits, group], i) => {
		const { q, scale, info } = quantize(randn(n(shape)), shape, bits, group);
		tensors[`w${i}.qweight`] = { shape: [q.length], data: q };
		tensors[`w${i}.qscale`] = { shape: [scale.length], data: scale };
		table[`w${i}`] = info;
	});
	const bytes = encodeSafetensors(tensors, { quant: JSON.stringify(table) });
	// the load-time expansion path (quantResident off): the int8 tensors read back as f16 / f32
	const expandNn = new GpuNn(device, { quantResident: false });
	const gw = expandNn.weightsFromBytes(bytes);
	const cw = cpu.weightsFromBytes(bytes);
	for (let i = 0; i < specs.length; i++) {
		const a = await cpu.read(cw.get(`w${i}`));
		const b = await expandNn.read(gw.get(`w${i}`));
		let worst = 0;
		let amax = 0;
		for (let k = 0; k < a.length; k++) {
			worst = Math.max(worst, Math.abs(a[k] - b[k]));
			amax = Math.max(amax, Math.abs(a[k]));
		}
		// f16 storage rounds the expanded values (2^-11 relative)
		const ok = b.length === a.length && worst <= amax * 1e-3;
		if (!ok) failed++;
		const [shape, bits, group] = specs[i];
		rows.push(
			`${ok ? "PASS" : "FAIL"} dequant int${bits} g${group} [${shape}] ${gw.get(`w${i}`).dtype}  maxAbs ${worst.toExponential(2)}`,
		);
	}
	const x = randn(3 * 64);
	const ref = await cpu.read(
		cpu.linear(cpu.fromArray(x, [3, 64]), cw.get("w0"), null),
	);
	const out = await expandNn.forward(() =>
		expandNn.linear(expandNn.fromArray(x, [3, 64]), gw.get("w0"), null),
	);
	const got = await expandNn.read(out);
	let worst = 0;
	for (let k = 0; k < ref.length; k++)
		worst = Math.max(worst, Math.abs(ref[k] - got[k]));
	const plain = [...(await expandNn.read(gw.get("plain")))].join();
	const ok = worst < 1e-2 && plain === "1,2,3,4";
	if (!ok) failed++;
	rows.push(
		`${ok ? "PASS" : "FAIL"} dequant weights in a forward (linear) maxAbs ${worst.toExponential(2)}, plain fp16 alongside ${plain}`,
	);
	expandNn.dispose(gw);
}
// resident int8 weights (q8): kept packed on the GPU, dequantized inside the conv / linear / matmul
// weight loads, against the CPU ops on the expanded weights
{
	type Run = (nn: Nn, w: (name: string) => Tensor) => Tensor;
	const x = (shape: number[]) => ({ shape, data: randn(n(shape)) });
	const resident: {
		name: string;
		w: [number[], number];
		input: { shape: number[]; data: Float32Array };
		run: Run;
		bias?: number;
		eligible?: boolean;
	}[] = [
		{
			name: "linear K64",
			w: [[37, 64], 64],
			input: x([5, 64]),
			run: (nn, w) => nn.linear(nn.fromArray(cur.data, cur.shape), w("w")),
		},
		{
			name: "linear K36 g12",
			w: [[17, 36], 12],
			input: x([3, 7, 36]),
			run: (nn, w) => nn.linear(nn.fromArray(cur.data, cur.shape), w("w")),
		},
		{
			name: "matmul B [K,N]",
			w: [[64, 36], 36],
			input: x([6, 64]),
			run: (nn, w) => nn.matmul(nn.fromArray(cur.data, cur.shape), w("w")),
		},
		{
			name: "conv3x3 padded",
			w: [[16, 8, 3, 3], 72],
			input: x([1, 8, 11, 13]),
			run: (nn, w) =>
				nn.conv2d(nn.fromArray(cur.data, cur.shape), w("w"), null, {
					padding: 1,
				}),
		},
		{
			name: "conv3x3 g24 stride2",
			w: [[16, 8, 3, 3], 24],
			input: x([2, 8, 12, 12]),
			run: (nn, w) =>
				nn.conv2d(nn.fromArray(cur.data, cur.shape), w("w"), null, {
					padding: 1,
					stride: 2,
				}),
		},
		{
			name: "conv1x1",
			w: [[32, 16, 1, 1], 16],
			input: x([1, 16, 9, 10]),
			run: (nn, w) => nn.conv2d(nn.fromArray(cur.data, cur.shape), w("w")),
		},
		{
			name: "patch embed 14x14 s14",
			w: [[24, 3, 14, 14], 196],
			input: x([1, 3, 28, 42]),
			run: (nn, w) =>
				nn.conv2d(nn.fromArray(cur.data, cur.shape), w("w"), null, {
					stride: 14,
				}),
		},
		{
			name: "conv direct (Cout 4)",
			w: [[4, 8, 3, 3], 72],
			input: x([1, 8, 7, 9]),
			run: (nn, w) =>
				nn.conv2d(nn.fromArray(cur.data, cur.shape), w("w"), null, {
					padding: 1,
				}),
		},
		{
			name: "convTranspose2d s2",
			w: [[8, 16, 2, 2], 64],
			input: x([1, 8, 6, 5]),
			run: (nn, w) =>
				nn.convTranspose2d(nn.fromArray(cur.data, cur.shape), w("w"), null, {
					stride: 2,
				}),
		},
		{
			name: "deformConv2d",
			w: [[16, 8, 3, 3], 72],
			input: x([1, 8, 8, 8]),
			run: (nn, w) =>
				nn.deformConv2d(
					nn.fromArray(cur.data, cur.shape),
					nn.fromArray(offsets, [1, 18, 8, 8]),
					null,
					w("w"),
					null,
					{ padding: 1 },
				),
		},
		{
			name: "conv g27 (ineligible, expands)",
			w: [[8, 3, 3, 3], 27],
			input: x([1, 3, 6, 6]),
			run: (nn, w) => nn.conv2d(nn.fromArray(cur.data, cur.shape), w("w")),
			eligible: false,
		},
	];
	let cur = resident[0].input;
	const offsets = randn(18 * 64, 1.5);
	for (const c of resident) {
		const [shape, group] = c.w;
		const wq = quantize(randn(n(shape), 0.5), shape, 8, group);
		const bytes = encodeSafetensors(
			{
				"w.qweight": { shape: [wq.q.length], data: wq.q },
				"w.qscale": { shape: [wq.scale.length], data: wq.scale },
			},
			{ quant: JSON.stringify({ w: wq.info }) },
		);
		const rn = new GpuNn(device, { quantResident: true });
		const gw = rn.weightsFromBytes(bytes);
		const cw = cpu.weightsFromBytes(bytes);
		const isQ8 = gw.get("w").dtype === "q8";
		cur = c.input;
		const ref = await cpu.read(c.run(cpu, (k) => cw.get(k)));
		const got = await rn.read(
			await rn.forward(() => c.run(rn, (k) => gw.get(k))),
		);
		let worst = 0;
		let amax = 0;
		for (let k = 0; k < ref.length; k++) {
			worst = Math.max(worst, Math.abs(ref[k] - got[k]));
			amax = Math.max(amax, Math.abs(ref[k]));
		}
		// an ineligible tensor expands to f16 storage (2^-11 relative); resident is f32 arithmetic
		const tol = isQ8 ? 2e-4 : 3e-3;
		const ok =
			got.length === ref.length &&
			worst <= amax * tol &&
			isQ8 === (c.eligible ?? true);
		if (!ok) failed++;
		rows.push(
			`${ok ? "PASS" : "FAIL"} q8 resident ${c.name} ${isQ8 ? "q8" : "expanded"} maxAbs ${worst.toExponential(2)} (max|ref| ${amax.toFixed(2)})`,
		);
		rn.dispose(gw);
	}
	// a q8 weight on an op that cannot read it fails loudly
	{
		const wq = quantize(randn(64), [4, 16], 8, 16);
		const bytes = encodeSafetensors(
			{
				"w.qweight": { shape: [wq.q.length], data: wq.q },
				"w.qscale": { shape: [wq.scale.length], data: wq.scale },
			},
			{ quant: JSON.stringify({ w: wq.info }) },
		);
		const rn = new GpuNn(device, { quantResident: true });
		const gw = rn.weightsFromBytes(bytes);
		let threw = false;
		try {
			await rn.forward(() => rn.add(gw.get("w"), 1));
		} catch {
			threw = true;
		}
		if (!threw) failed++;
		rows.push(
			`${threw ? "PASS" : "FAIL"} q8 weight on an elementwise op throws`,
		);
	}
}
if (!argv.includes("--no-f16") && gpu.backend.f16) await runPass(true);
// kernel variants (src/lib/nn/gpu/kernel-caps.ts): each tile / option against the CPU, on a fresh
// backend so no cached graph from another variant is reused
{
	const variantCases = new Set([
		"matmul-ragged",
		"matmul-vecA-scalarB",
		"matmul-scalarA-vecB",
		"matmul-vec-batch-8x4",
		"matmul-transB",
		"linear-big",
		"conv3x3",
		"conv-g4-wrap",
		"conv-1x1",
		"attention-long",
		"attention-mask",
	]);
	const variants: [string, Parameters<typeof setKernelCaps>[0]][] = [
		["legacy", { legacy: true }],
		["tile 4x4", { gemmTileOverride: "4x4" }],
		["tile 8x8", { gemmTileOverride: "8x8" }],
		["tile 4x8", { gemmTileOverride: "4x8" }],
		["tile n4x4", { gemmTileOverride: "n4x4" }],
		["tile m4x4", { gemmTileOverride: "m4x4" }],
		["tile s8x4", { gemmTileOverride: "s8x4" }],
		[
			"attention 128x2",
			{ attentionTileOverride: { threads: 128, queriesPerThread: 2 } },
		],
		[
			"attention 64x1",
			{ attentionTileOverride: { threads: 64, queriesPerThread: 1 } },
		],
	];
	const baseCaps = {
		legacy: false,
		gemmTileOverride: null,
		attentionTileOverride: null,
		f16Math: false,
		f16Accumulate: false,
	};
	const f16Variants: [string, Parameters<typeof setKernelCaps>[0], number][] = [
		["f16 products, f32 accumulate", { f16Math: true }, 3e-3],
		[
			"f16 products and accumulate",
			{ f16Math: true, f16Accumulate: true },
			3e-2,
		],
	];
	for (const [label, caps] of variants) {
		gpu = new GpuNn(device);
		setKernelCaps({ ...baseCaps, ...caps });
		const first = rows.length;
		await runPass(false, variantCases);
		for (let i = first; i < rows.length; i++)
			rows[i] = rows[i].replace(/^(PASS|FAIL) /, `$1 [${label}] `);
	}
	if (gpu.backend.f16)
		for (const [label, caps, tol] of f16Variants) {
			gpu = new GpuNn(device);
			setKernelCaps({ ...baseCaps, ...caps });
			const first = rows.length;
			const saved = cases.map((c) => c.tol);
			for (const c of cases) c.tol = Math.max(c.tol ?? 0, tol);
			await runPass(
				true,
				new Set([
					"linear",
					"linear-big",
					"matmul-transB",
					"linear-8x4-bias-act",
					"conv3x3",
					"conv-stride-dil",
					"conv-g4-wrap",
					"conv-replicate-pad-residual",
					"conv-grouped-act-residual",
				]),
			);
			cases.forEach((c, i) => {
				c.tol = saved[i];
			});
			for (let i = first; i < rows.length; i++)
				rows[i] = rows[i].replace(/^(PASS|FAIL) /, `$1 [${label}] `);
		}
	setKernelCaps(baseCaps);
	gpu = new GpuNn(device);
}
for (const r of rows) console.log(r);
console.log(
	`nn-parity: ${rows.length - failed}/${rows.length} pass; graphs ${gpu.runtime.stats.graphs}, nodes ${gpu.runtime.stats.nodes}`,
);
process.exit(failed ? 1 : 0);
