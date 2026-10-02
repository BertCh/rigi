// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// wgsl/reduce.ts: the generated trees are deterministic, well-formed WGSL, and the combine order they
// describe (run here by a tiny WGSL→JS rewrite of the generated per-level body) equals a reference
// halving tree, including the first-index tie-break of arg-min / arg-max.
import { describe, expect, it } from "vitest";
import { deriveLayout } from "../kernel";
import {
	argStep,
	keyMinStep,
	maxStep,
	minStep,
	sumRowStep,
	sumStep,
	wgslSubgroupReduce,
	wgslTreeReduce,
} from "../wgsl/reduce";

type Arrays = Record<string, unknown>;

/** Run the generated tree on JS arrays: each level's `if (lane < stride) { body }` once per lane. */
function runTree(
	code: string,
	size: number,
	arrays: Arrays,
	lane = "lid",
	stride = "s",
) {
	const m = code.match(
		new RegExp(
			`if \\(${lane} < ${stride}\\) \\{([\\s\\S]*)\\n\\s*\\}\\n\\s*workgroupBarrier\\(\\);\\n\\s*\\}$`,
		),
	);
	if (!m) throw new Error(`unexpected tree shape:\n${code}`);
	const js = m[1]
		.replace(/\b(\d+|0x[0-9a-f]+)u\b/gi, "$1")
		.replace(/\bvar\b/g, "let")
		.replace(/\bmin\(/g, "Math.min(")
		.replace(/\bmax\(/g, "Math.max(");
	const names = Object.keys(arrays);
	const body = new Function(...names, lane, stride, js);
	for (let s = size / 2; s > 0; s >>= 1) {
		for (let l = 0; l < size; l++)
			if (l < s) body(...names.map((n) => arrays[n]), l, s);
	}
}

const rand = (n: number, seed = 7) => {
	let x = seed;
	return Array.from({ length: n }, () => {
		x = (x * 1664525 + 1013904223) >>> 0;
		return (x % 2000) / 10 - 100;
	});
};

describe("wgslTreeReduce", () => {
	it("is deterministic and emits the halving loop with barriers", () => {
		const a = wgslTreeReduce({
			size: 64,
			lane: "li",
			steps: [sumStep("sc"), sumStep("sf")],
		});
		expect(a).toBe(
			wgslTreeReduce({
				size: 64,
				lane: "li",
				steps: [sumStep("sc"), sumStep("sf")],
			}),
		);
		expect(a).toContain("for (var s = 32u; s > 0u; s >>= 1u)");
		expect(a).toContain("if (li < s)");
		expect(a).toContain("sc[li] += sc[li + s];");
		expect(a).toContain("sf[li] += sf[li + s];");
		expect(a.match(/workgroupBarrier\(\)/g)).toHaveLength(2);
		const noEntry = wgslTreeReduce({
			size: 8,
			steps: [minStep("m")],
			entryBarrier: false,
		});
		expect(noEntry.match(/workgroupBarrier\(\)/g)).toHaveLength(1);
	});

	it("rejects a non power-of-two size", () => {
		expect(() => wgslTreeReduce({ size: 48, steps: [sumStep("a")] })).toThrow(
			/power of two/,
		);
	});

	it("parses as WGSL inside a compute entry", () => {
		const tree = wgslTreeReduce({
			size: 64,
			steps: [
				sumStep("a"),
				minStep("b"),
				maxStep("c"),
				argStep({ value: "v", index: "i", mode: "min", none: "0xffffffffu" }),
				keyMinStep({ key: "k", payloads: ["p"] }),
			],
		});
		const source = `
var<workgroup> a: array<f32, 64>; var<workgroup> b: array<f32, 64>; var<workgroup> c: array<f32, 64>;
var<workgroup> v: array<f32, 64>; var<workgroup> i: array<u32, 64>;
var<workgroup> k: array<u32, 64>; var<workgroup> p: array<u32, 64>;
@group(0) @binding(0) var<storage, read_write> out: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) lid: u32) {
  a[lid] = 1.0; b[lid] = 1.0; c[lid] = 1.0; v[lid] = 1.0; i[lid] = lid; k[lid] = lid; p[lid] = lid;
${tree}
  if (lid == 0u) { out[0] = a[0] + b[0] + c[0] + v[0] + f32(i[0] + k[0] + p[0]); }
}`;
		expect(deriveLayout(source)).toEqual([["out", "storage"]]);
	});

	it("sum equals the reference halving tree bit for bit", () => {
		const size = 64;
		const data = rand(size).map(Math.fround);
		// a Float32Array rounds to f32 after every add, as the GPU does
		const sc = Float32Array.from(data);
		const code = wgslTreeReduce({ size, steps: [sumStep("sc")] });
		runTree(code, size, { sc });
		const ref = data.slice();
		for (let s = size / 2; s > 0; s >>= 1)
			for (let l = 0; l < s; l++) ref[l] = Math.fround(ref[l] + ref[l + s]);
		expect(sc[0]).toBe(ref[0]);
	});

	it("min / max / row sum", () => {
		const size = 32;
		const lo = rand(size, 3);
		const hi = lo.slice();
		const rows = Array.from({ length: size }, (_, l) => [l, 2 * l, 1]);
		runTree(
			wgslTreeReduce({ size, steps: [minStep("lo"), maxStep("hi")] }),
			size,
			{ lo, hi },
		);
		expect(lo[0]).toBe(Math.min(...rand(size, 3)));
		expect(hi[0]).toBe(Math.max(...rand(size, 3)));
		runTree(wgslTreeReduce({ size, steps: [sumRowStep("rows", 3)] }), size, {
			rows,
		});
		expect(rows[0]).toEqual([(size * (size - 1)) / 2, size * (size - 1), size]);
	});

	it.each([
		"max",
		"min",
	] as const)("arg%s: first index wins ties, with and without a none sentinel", (mode) => {
		const size = 16;
		const NONE = 0xffffffff;
		for (const withNone of [false, true]) {
			// heavy ties: values from {1,2,3}, lanes 3 and 9 empty when withNone
			const values = Array.from({ length: size }, (_, l) => ((l * 7) % 3) + 1);
			const idx = Array.from({ length: size }, (_, l) => l);
			if (withNone) {
				idx[3] = NONE;
				idx[9] = NONE;
				idx[0] = NONE;
			}
			const best = mode === "max" ? Math.max : Math.min;
			const target = best(...values.filter((_, l) => idx[l] !== NONE));
			const firstWithTarget = idx.find(
				(x, l) => x !== NONE && values[l] === target,
			);
			const code = wgslTreeReduce({
				size,
				steps: [
					argStep({
						value: "v",
						index: "i",
						mode,
						...(withNone ? { none: "0xffffffffu" } : {}),
					}),
				],
			});
			runTree(code, size, { v: values, i: idx });
			expect(idx[0]).toBe(firstWithTarget);
			expect(values[0]).toBe(target);
		}
	});

	it("key-min carries payloads and keeps the lower lane on a tie", () => {
		const size = 8;
		const key = [5, 2, 9, 2, 7, 1, 1, 8];
		const payload = [10, 11, 12, 13, 14, 15, 16, 17];
		runTree(
			wgslTreeReduce({
				size,
				steps: [keyMinStep({ key: "k", payloads: ["p"] })],
			}),
			size,
			{ k: key, p: payload },
		);
		expect(key[0]).toBe(1);
		// tree order: lanes 5 and 6 tie on key 1; the one that reached lane 0 first (lane 6, payload 16) stays
		expect(payload[0]).toBe(16);
	});
});

describe("wgslSubgroupReduce", () => {
	const base = {
		type: "f32",
		value: "x",
		shared: "sgv",
		result: "r",
		size: 64,
	} as const;
	it("emits subgroup ops with one value per subgroup", () => {
		const min = wgslSubgroupReduce({ ...base, op: "min" });
		expect(min).toContain("subgroupMin(x)");
		expect(min).toContain("sgv[lid / ssz]");
		expect(wgslSubgroupReduce({ ...base, op: "max" })).toContain(
			"subgroupMax(x)",
		);
	});
	it("refuses a reordering f32 sum unless allowed", () => {
		expect(() => wgslSubgroupReduce({ ...base, op: "sum" })).toThrow(
			/allowReorder/,
		);
		expect(
			wgslSubgroupReduce({ ...base, op: "sum", allowReorder: true }),
		).toContain("subgroupAdd(x)");
		expect(wgslSubgroupReduce({ ...base, type: "u32", op: "sum" })).toContain(
			"subgroupAdd(x)",
		);
	});
});
