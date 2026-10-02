// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Dev tool: compile every nn kernel spec defined so far on a Dawn device and print WGSL errors.
//   DAWN_DIR=/tmp/dawn npx tsx scripts/nn/wgsl-lint.ts
import { definedKernels } from "../../src/lib/gpu/core/kernel";
import { nativeWebGPUDevice } from "../../src/lib/gpu/core/luma";
import { attentionKernel } from "../../src/lib/nn/gpu/k-attention";
import { convGemmKernel, matmulKernel } from "../../src/lib/nn/gpu/k-gemm";
import { topkPlan } from "../../src/lib/nn/gpu/k-topk";
import { convParams } from "../../src/lib/nn/shape";
import { dawnDevice } from "./dawn";

const device = await dawnDevice();
if (!device) process.exit(0);
const gd = nativeWebGPUDevice(device);
matmulKernel(
	{
		batch: [],
		aBatchStrides: [],
		bBatchStrides: [],
		M: 4,
		N: 4,
		K: 4,
		transB: false,
	},
	"f32",
	"f32",
	null,
	null,
);
const p = convParams([1, 8, 9, 9], [16, 8, 3, 3], { padding: 1 });
convGemmKernel("conv", p, { x: "f32", w: "f32", b: null }, null);
convGemmKernel(
	"deform",
	p,
	{ x: "f32", w: "f32", b: null, off: "f32", mask: "f32" },
	null,
);
attentionKernel(
	{ B: 1, H: 1, Nq: 4, Nk: 4, D: 64, Dv: 64, scale: 1, maskStrides: null },
	"f32",
	"f32",
	"f32",
	null,
);
topkPlan("f32", 1, 5000, 10);
let bad = 0;
for (const s of definedKernels("nn")) {
	const m = gd.createShaderModule({ code: s.source });
	const info = await m.getCompilationInfo();
	const errs = info.messages.filter((x) => x.type === "error");
	if (errs.length) {
		bad++;
		console.log(`== ${s.id}`);
		for (const e of errs) {
			console.log(`  ${e.lineNum}:${e.linePos} ${e.message}`);
			console.log(`    ${s.source.split("\n")[e.lineNum - 1]}`);
		}
	}
}
console.log(`${bad} bad of ${definedKernels("nn").length}`);
process.exit(0);
