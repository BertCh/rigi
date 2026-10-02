// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The planner's CPU half: elementwise chain fusion and layerNorm + residual fusion over a node list
// (no device), the kernel text they generate, and the labels / enqueue rules of the runtime. The
// kernels themselves run on Dawn (scripts/nn/parity.check.ts, compile.check.ts).

import type { Device } from "@luma.gl/core";
import { describe, expect, it } from "vitest";
import { absorb, fuseElementwise, fuseLayerNorm } from "../gpu/fusion";
import {
	type EwDesc,
	ewKernel,
	naryDesc,
	type Operand,
	unaryDesc,
	unaryKernel,
} from "../gpu/k-elementwise";
import { layerNormResidualKernel } from "../gpu/k-fused";
import { type Node, nodeLabel, Runtime, Storage } from "../gpu/runtime";
import { stridesOf } from "../shape";

const st = (bytes = 4) => new Storage(bytes, "f32", null);
const tensorOp = (shape: number[], strides = stridesOf(shape)): Operand => ({
	kind: "tensor",
	dtype: "f32",
	strides,
});

/** A binary node over `shape`: `a` and `b` are storages (b broadcast over the last dim when `bcast`). */
function binary(
	op: string,
	shape: number[],
	a: Storage,
	b: Storage,
	out: Storage,
	bcast = false,
): Node {
	const bStrides = bcast ? [...shape.slice(0, -1).map(() => 0), 1] : undefined;
	const desc = naryDesc(
		`bin-${op}`,
		["a", "b"],
		[tensorOp(shape), tensorOp(shape, bStrides)],
		shape,
		op === "add" ? "a + b" : "a * b",
	);
	return { ...ewKernel(desc), inputs: [a, b], outputs: [out], ew: desc };
}

function unary(op: "gelu" | "relu", shape: number[], x: Storage, out: Storage) {
	const desc = unaryDesc(op, "f32", shape, 0, 0);
	return {
		...unaryKernel(
			op,
			"f32",
			shape.reduce((p, q) => p * q, 1),
			0,
			0,
		),
		inputs: [x],
		outputs: [out],
		act: { op, alpha: 0, beta: 0 },
		ew: desc,
	} as Node;
}

describe("fuseElementwise", () => {
	const shape = [4, 8];
	it("folds bias add + gelu into one node", () => {
		const [x, bias, y, z] = [st(), st(), st(), st()];
		const add = binary("add", shape, x, bias, y, true);
		const gelu = unary("gelu", shape, y, z);
		const out = fuseElementwise([add, gelu], new Set([z]));
		expect(out).toHaveLength(1);
		expect(out[0].inputs).toEqual([x, bias]);
		expect(out[0].outputs).toEqual([z]);
		expect(out[0].spec?.id).toContain("u-gelu[0=bin-add]");
		// the kernel has the add's two tensor leaves and the unary's scalars
		expect(out[0].meta.length).toBeGreaterThan(8);
	});

	it("absorbs a whole tree and keeps a shared or forward-output intermediate", () => {
		const [a, b, c, d, m1, m2, s, shared, outA, outB] = Array.from(
			{ length: 10 },
			() => st(),
		);
		// s = a*b + c*d  (two producers absorbed into the add)
		const nodes = [
			binary("mul", shape, a, b, m1),
			binary("mul", shape, c, d, m2),
			binary("add", shape, m1, m2, s),
		];
		const fused = fuseElementwise(nodes, new Set([s]));
		expect(fused).toHaveLength(1);
		expect(fused[0].inputs).toEqual([a, b, c, d]);
		// a shared intermediate is not absorbed
		const p = binary("add", shape, a, b, shared);
		const u1 = unary("relu", shape, shared, outA);
		const u2 = unary("gelu", shape, shared, outB);
		expect(fuseElementwise([p, u1, u2], new Set([outA, outB]))).toHaveLength(3);
		// nor an intermediate that is a forward output
		const q = binary("add", shape, a, b, m1);
		const u3 = unary("relu", shape, m1, outA);
		expect(fuseElementwise([q, u3], new Set([m1, outA]))).toHaveLength(2);
	});

	it("does not fuse across a shape change or past the binding budget", () => {
		const [a, b, y, z] = [st(), st(), st(), st()];
		const add = binary("add", [4, 8], a, b, y);
		const relu = unary("relu", [32], y, z);
		expect(fuseElementwise([add, relu], new Set([z]))).toHaveLength(2);
		// 7 leaves would need 9 storage bindings
		const leaves = Array.from({ length: 7 }, () => st());
		let acc = binary("add", shape, leaves[0], leaves[1], st());
		const nodes: Node[] = [acc];
		for (let i = 2; i < 7; i++) {
			const next = binary("add", shape, acc.outputs[0], leaves[i], st());
			nodes.push(next);
			acc = next;
		}
		const fused = fuseElementwise(nodes, new Set([acc.outputs[0]]));
		expect(fused.length).toBeGreaterThan(1);
		for (const n of fused)
			expect(n.inputs.length + n.outputs.length + 1).toBeLessThanOrEqual(8);
	});

	it("a binary's chain operand must not be broadcast", () => {
		const [a, b, y, z] = [st(), st(), st(), st()];
		// y [8] is broadcast over rows in the consumer: absorbing would change the element count
		const prod = binary("add", [8], a, b, y);
		const cons = binary("mul", shape, y, b, z);
		cons.ew = {
			...(cons.ew as EwDesc),
			ops: [tensorOp(shape, [0, 1]), tensorOp(shape)],
		};
		expect(fuseElementwise([prod, cons], new Set([z]))).toHaveLength(2);
	});

	it("absorb composes keys and statements", () => {
		const add = naryDesc(
			"bin-add",
			["a", "b"],
			[tensorOp(shape), tensorOp(shape)],
			shape,
			"a + b",
		);
		const act = unaryDesc("relu", "f32", shape, 0, 0);
		const both = absorb(act, 0, add);
		expect(both.key).toBe("u-relu[0=bin-add]");
		expect(both.ops).toHaveLength(2 + 2);
		const text = both.stmt(["x0", "x1", "x2", "x3"], "acc", () => "u");
		expect(text).toContain("var pu = 0.0;");
		expect(text).toContain("let a = x0; let b = x1;");
		expect(text).toContain("let v = pu;");
	});
});

describe("fuseLayerNorm", () => {
	const shape = [3, 16];
	const ln = (x: Storage, w: Storage, out: Storage): Node => ({
		spec: unaryKernel("relu", "f32", 1, 0, 0).spec,
		meta: [],
		wg: [1, 1, 1],
		inputs: [x, w],
		outputs: [out],
		ln: { dw: "f32", db: null, rows: 3, C: 16, eps: 1e-5 },
	});

	it("evaluates the producer inside the norm and keeps a shared sum", () => {
		const [x, r, s, w, out, other] = Array.from({ length: 6 }, () => st());
		const add = binary("add", shape, x, r, s);
		const norm = ln(s, w, out);
		const use = unary("relu", shape, s, other);
		const fused = fuseLayerNorm([add, norm, use], new Set([out, other]));
		expect(fused).toHaveLength(2);
		expect(fused[0].inputs).toEqual([x, r, w]);
		// out first, then the residual stream (read later by `use`)
		expect(fused[0].outputs).toEqual([out, s]);
		expect(fused[0].spec?.id).toContain("lnres-bin-add");
		expect(fused[0].spec?.id).toContain("-s");
	});

	it("drops the sum output when nothing else reads it", () => {
		const [x, r, s, w, out] = Array.from({ length: 5 }, () => st());
		const fused = fuseLayerNorm(
			[binary("add", shape, x, r, s), ln(s, w, out)],
			new Set([out]),
		);
		expect(fused).toHaveLength(1);
		expect(fused[0].outputs).toEqual([out]);
	});

	it("leaves a norm whose producer is not elementwise", () => {
		const [x, w, out] = [st(), st(), st()];
		expect(fuseLayerNorm([ln(x, w, out)], new Set([out]))).toHaveLength(1);
	});

	it("generates a kernel reading broadcast operands through the shared decompose", () => {
		const add = naryDesc(
			"bin-mul",
			["a", "b"],
			[tensorOp(shape), tensorOp(shape, [0, 1])],
			shape,
			"a * b",
		);
		const k = layerNormResidualKernel(
			add,
			{ dw: null, db: null, rows: 3, C: 16, eps: 1e-5 },
			true,
		);
		expect(k.spec.source).toContain("fn xval(i: u32)");
		expect(k.spec.source).toContain("sum[base + i] = v;");
		expect(k.wg).toEqual([3, 1, 1]);
		// header: rows, C, eps, then the elementwise block
		expect(k.meta.slice(0, 2)).toEqual([3, 16]);
	});
});

describe("runtime helpers", () => {
	it("labels nodes with scope, position and op", () => {
		const [x, out] = [st(), st()];
		const n = unary("gelu", [4], x, out);
		n.scope = "encoder.block3";
		expect(nodeLabel(n, 7)).toBe("encoder.block3/n7:unary-gelu");
		n.scope = undefined;
		expect(nodeLabel(n, 0)).toBe("n0:unary-gelu");
	});

	it("starts a step at once on an idle runtime and queues behind a pending one", async () => {
		const rt = new Runtime({ limits: {} } as unknown as Device);
		const order: string[] = [];
		const p1 = rt.enqueue(() => {
			order.push("sync");
			return 1;
		});
		// ran before enqueue returned
		expect(order).toEqual(["sync"]);
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const slow = rt.enqueue(async () => {
			order.push("slow-start");
			await gate;
			order.push("slow-end");
		});
		const behind = rt.enqueue(() => {
			order.push("behind");
		});
		expect(order).toEqual(["sync", "slow-start"]);
		release();
		await Promise.all([p1, slow, behind]);
		expect(order).toEqual(["sync", "slow-start", "slow-end", "behind"]);
		// a failing step rejects its caller only
		await expect(
			rt.enqueue(() => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await expect(rt.enqueue(() => 2)).resolves.toBe(2);
	});
});
