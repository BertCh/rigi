// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	anchorInputsAgree,
	canonicalDemGrid,
	compareDemGrids,
} from "../anchor-parity";
import { sampleDemGrid } from "../geom";

const W = 16;
const H = 12;
const base = (j: number) => 20 * 1.2 ** (H - 1 - j);
const gridOf = (f: (j: number) => number) => {
	const g = new Float32Array(W * H);
	for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) g[j * W + i] = f(j);
	return g;
};

describe("compareDemGrids / anchorInputsAgree", () => {
	it("agrees on identical grids", () => {
		const a = gridOf(base);
		const r = anchorInputsAgree(a, a.slice(), W, H);
		expect(r.agree).toBe(true);
		expect(r.diff.disagree).toBe(0);
		expect(r.diff.medianLogDiff).toBe(0);
	});
	it("flags the bottom-row mismatch of the old engines (6.8 m vs 31.7 m)", () => {
		const a = gridOf((j) => (j === H - 1 ? 6.8 : base(j)));
		const b = gridOf((j) => (j === H - 1 ? 31.7 : base(j)));
		const r = anchorInputsAgree(a, b, W, H, { maxDisagreeFrac: 0.01 });
		expect(r.agree).toBe(false);
		expect(r.diff.maxRow).toBe(H - 1);
		expect(r.diff.rowDisagree[H - 1]).toBe(1);
		expect(r.diff.rowDisagree[0]).toBe(0);
	});
	it("counts coverage mismatches and treats NaN / 0 as no terrain", () => {
		const a = gridOf(base);
		const b = gridOf((j) => (j === 0 ? Number.NaN : j === 1 ? 0 : base(j)));
		const d = compareDemGrids(a, b, W, H);
		expect(d.onlyOne).toBe(2 * W);
		expect(d.both).toBe((H - 2) * W);
		expect(anchorInputsAgree(a, b, W, H).agree).toBe(false);
	});
	it("detects a vertical flip", () => {
		const a = gridOf(base);
		const b = gridOf((j) => base(H - 1 - j));
		expect(anchorInputsAgree(a, b, W, H).agree).toBe(false);
	});
	it("tolerates small relative noise", () => {
		const a = gridOf(base);
		const b = gridOf((j) => base(j) * 1.03);
		expect(anchorInputsAgree(a, b, W, H).agree).toBe(true);
	});
	it("throws on a size mismatch", () => {
		expect(() =>
			compareDemGrids(new Float32Array(3), new Float32Array(3), W, H),
		).toThrow();
	});
});

describe("canonicalDemGrid", () => {
	const f = (u: number, v: number) =>
		v > 0.9 ? null : 10 + 100 * u + 1000 * v;
	it("matches geom.sampleDemGrid cell for cell", () => {
		const a = canonicalDemGrid(W, H, f);
		const b = sampleDemGrid(W, H, f);
		expect(Array.from(a).map(String)).toEqual(Array.from(b).map(String));
	});
	it("reuses a right-sized buffer and rebuilds a wrong-sized one", () => {
		const buf = new Float32Array(W * H);
		expect(canonicalDemGrid(W, H, f, buf)).toBe(buf);
		expect(canonicalDemGrid(W, H, f, new Float32Array(5))).toHaveLength(W * H);
	});
});
