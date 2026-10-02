// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU-side parts of the GPU backend: index coalescing, epilogue fusion planning, topk dispatch plan,
// kernel memoisation. The kernels themselves are checked on Dawn (scripts/nn/parity.check.ts).

import { describe, expect, it } from "vitest";
import { coalesce } from "../gpu/k-elementwise";
import { topkPlan } from "../gpu/k-topk";
import { fuseEpilogues, type Node, Storage } from "../gpu/runtime";
import { nnKernel } from "../gpu/wgsl";

describe("nn gpu planning", () => {
	it("coalesces contiguous dims and drops size-1 dims", () => {
		// [2,3,4] contiguous in both sets → one dim of 24
		expect(
			coalesce(
				[2, 3, 4],
				[
					[12, 4, 1],
					[12, 4, 1],
				],
			),
		).toEqual({
			shape: [24],
			sets: [[1], [1]],
		});
		// broadcast row ([1,4] → [3,4]): dims stay apart
		expect(
			coalesce(
				[3, 4],
				[
					[4, 1],
					[0, 1],
				],
			),
		).toEqual({
			shape: [3, 4],
			sets: [
				[4, 1],
				[0, 1],
			],
		});
		expect(coalesce([1, 1], [[1, 1]])).toEqual({ shape: [1], sets: [[0]] });
	});

	it("memoises kernel specs per (key, dtypes)", () => {
		const a = nnKernel("spec-test", [{ name: "x", dtype: "f32" }], ["out"], "");
		const b = nnKernel("spec-test", [{ name: "x", dtype: "f32" }], ["out"], "");
		const c = nnKernel("spec-test", [{ name: "x", dtype: "f16" }], ["out"], "");
		expect(a).toBe(b);
		expect(c).not.toBe(a);
		expect(c.source.startsWith("enable f16;")).toBe(true);
		expect(a.layout.map(([n]) => n)).toEqual(["M", "x", "out"]);
	});

	it("topk runs in-workgroup stages below the 512 block", () => {
		expect(topkPlan("f32", 1, 300, 5).steps).toHaveLength(1);
		const big = topkPlan("f32", 1, 2 ** 19, 2048);
		// one local sort, then per k in 2^10..2^19: (log2 k − 9) global steps + one local merge
		let want = 1;
		for (let s = 10; s <= 19; s++) want += s - 9 + 1;
		expect(big.P).toBe(2 ** 19);
		expect(big.steps).toHaveLength(want);
	});

	const spec = nnKernel("fuse-test", [], ["out"], "");
	const node = (
		inputs: Storage[],
		outputs: Storage[],
		extra: Partial<Node> = {},
	): Node => ({
		spec,
		inputs,
		outputs,
		meta: [],
		wg: [1, 1, 1],
		...extra,
	});

	it("folds a unary into its single-consumer producer", () => {
		const x = new Storage(4, "f32", null);
		const y = new Storage(4, "f32", null);
		const z = new Storage(4, "f32", null);
		const p = node([x], [y], {
			fuse: (a) => ({ spec, meta: [a.op === "relu" ? 1 : 0], wg: [1, 1, 1] }),
		});
		const u = node([y], [z], { act: { op: "relu", alpha: 0, beta: 0 } });
		const out = fuseEpilogues([p, u], new Set([z]));
		expect(out).toEqual([p]);
		expect(p.outputs).toEqual([z]);
		expect(p.meta).toEqual([1]);
	});

	it("keeps the unary when the pre-activation is used elsewhere or is an output", () => {
		const mk = () => {
			const x = new Storage(4, "f32", null);
			const y = new Storage(4, "f32", null);
			const z = new Storage(4, "f32", null);
			const p = node([x], [y], {
				fuse: () => ({ spec, meta: [9], wg: [1, 1, 1] }),
			});
			const u = node([y], [z], { act: { op: "relu", alpha: 0, beta: 0 } });
			return { y, z, p, u };
		};
		const a = mk();
		expect(fuseEpilogues([a.p, a.u], new Set([a.z, a.y]))).toHaveLength(2);
		const b = mk();
		const w = new Storage(4, "f32", null);
		const other = node([b.y], [w]);
		expect(fuseEpilogues([b.p, b.u, other], new Set([b.z, w]))).toHaveLength(3);
	});
});
