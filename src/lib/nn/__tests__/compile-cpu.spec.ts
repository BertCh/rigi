// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// nn.compile / scope / readLater on the CPU backend (the eager fallback), and the result-tree helpers.

import { describe, expect, it } from "vitest";
import { collectTensors, mapTensors } from "../tree";
import { nn } from "./util";

describe("CpuNn.compile", () => {
	it("runs fn per call with fresh inputs and returns values in fn's structure", async () => {
		const c = await nn.compile("double-sum", [[2, 2], [2]], ([x, b]) => ({
			y: nn.add(nn.mul(x, 2), b),
			list: [nn.sum(x, 0)],
			note: "kept",
		}));
		const a = await c.run([
			Float32Array.of(1, 2, 3, 4),
			Float32Array.of(10, 20),
		]);
		expect(Array.from(a.y)).toEqual([12, 24, 16, 28]);
		expect(Array.from(a.list[0])).toEqual([4, 6]);
		expect(a.note).toBe("kept");
		const b = await c.run([Float32Array.of(0, 0, 0, 1), Float32Array.of(1, 1)]);
		expect(Array.from(b.y)).toEqual([1, 1, 1, 3]);
		await c.submit([Float32Array.of(1, 1, 1, 1), Float32Array.of(0, 0)]);
		c.dispose();
	});

	it("accepts a ready tensor as an input", async () => {
		const c = await nn.compile("neg", [[3]], ([x]) => nn.unary("neg", x));
		const t = nn.fromArray([1, -2, 3], [3]);
		expect(Array.from(await c.run([t]))).toEqual([-1, 2, -3]);
	});
});

describe("scope and readLater", () => {
	it("scope runs fn and returns its value", () => {
		expect(nn.scope("a", () => nn.scope("b", () => 7))).toBe(7);
	});
	it("readLater fills `into` when given", async () => {
		const t = nn.fromArray([1, 2, 3], [3]);
		const into = new Float32Array(3);
		const r = await nn.readLater(t, into);
		expect(r).toBe(into);
		expect(Array.from(into)).toEqual([1, 2, 3]);
		expect(Array.from(await nn.readLater(t))).toEqual([1, 2, 3]);
	});
});

describe("tree helpers", () => {
	it("collects each tensor once in walk order and maps the structure", () => {
		const a = nn.fromArray([1], [1]);
		const b = nn.fromArray([2], [1]);
		const tree = { x: [a, { y: b }], z: a, n: null, s: "k" };
		expect(collectTensors(tree)).toEqual([a, b]);
		const mapped = mapTensors(tree, (t) => (t === a ? "A" : "B"));
		expect(mapped).toEqual({ x: ["A", { y: "B" }], z: "A", n: null, s: "k" });
	});
});
