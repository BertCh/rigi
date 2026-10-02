// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// deriveLayout / defineKernel's derived-layout form: the layout comes from the WGSL (luma's
// getShaderLayoutFromWGSL), and a hand-written layout must equal it.
import { describe, expect, it } from "vitest";
import { defineKernel, deriveLayout } from "../kernel";

const SOURCE = `
struct P { n: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
@group(0) @binding(3) var tex: texture_2d<f32>;
@group(0) @binding(4) var layers: texture_2d_array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let t = textureLoad(tex, vec2<i32>(0), 0);
  let l = textureLoad(layers, vec2<i32>(0), 0, 0);
  dst[id.x] = src[id.x] + f32(p.n) + t.x + l.x;
}`;

describe("deriveLayout", () => {
	it("reads kinds and order from the WGSL", () => {
		expect(deriveLayout(SOURCE)).toEqual([
			["p", "uniform"],
			["src", "read-only-storage"],
			["dst", "storage"],
			["tex", "texture"],
			["layers", "texture-array"],
		]);
	});

	it("refuses a binding gap and a non-zero group", () => {
		expect(() =>
			deriveLayout(
				"@group(0) @binding(1) var<storage, read_write> a: array<f32>;",
			),
		).toThrow(/@binding\(0\)/);
		expect(() =>
			deriveLayout(
				"@group(1) @binding(0) var<storage, read_write> a: array<f32>;",
			),
		).toThrow(/@group\(1\)/);
	});
});

describe("defineKernel layout forms", () => {
	it("derives the layout when none is given", () => {
		const spec = defineKernel("derive-test-a", SOURCE, { group: "test" });
		expect(spec.layout.map(([n]) => n)).toEqual([
			"p",
			"src",
			"dst",
			"tex",
			"layers",
		]);
		expect(spec.group).toBe("test");
	});

	it("accepts an explicit layout equal to the derived one", () => {
		const spec = defineKernel("derive-test-b", SOURCE, deriveLayout(SOURCE));
		expect(spec.layout).toHaveLength(5);
	});

	it("rejects an explicit layout that disagrees with the WGSL (dev and tests)", () => {
		const wrong = deriveLayout(SOURCE).map(
			([n, k]) => [n, n === "dst" ? "read-only-storage" : k] as const,
		);
		expect(() => defineKernel("derive-test-c", SOURCE, wrong as never)).toThrow(
			/does not match the WGSL/,
		);
	});
});
