// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { CpuNn, encodeSafetensors } from "#/lib/nn";
import { expectArrayClose } from "#/test/helpers";
import { bindU2netp, runU2netp } from "../u2netp";

// a miniature program using every op the exported graph uses: dilated 3x3 conv, 1x1 convs, relu, pool,
// bilinear up to a partner's size, concat, residual add, sigmoid
const program = [
	["conv", "a_pre", "input", "Conv_0", 2, 2],
	["relu", "a", "a_pre"],
	["pool", "p", "a"],
	["conv", "q", "p", "Conv_1", 1, 0],
	["up", "u", "q", "a"],
	["cat", "c", ["u", "a"]],
	["conv", "d", "c", "Conv_2", 1, 0],
	["add", "e", "d", "input"],
	["sigmoid", "out", "e"],
];

function weights() {
	const nn = new CpuNn();
	const k3 = new Float32Array(9);
	k3[4] = 2; // centre tap
	const bytes = encodeSafetensors(
		{
			"Conv_0.w": { shape: [1, 1, 3, 3], data: k3 },
			"Conv_0.b": { shape: [1], data: Float32Array.of(0.5) },
			"Conv_1.w": { shape: [1, 1, 1, 1], data: Float32Array.of(3) },
			"Conv_1.b": { shape: [1], data: Float32Array.of(0) },
			"Conv_2.w": { shape: [1, 2, 1, 1], data: Float32Array.of(1, -1) },
			"Conv_2.b": { shape: [1], data: Float32Array.of(0) },
		},
		{
			layout: "rigi-u2netp-1",
			input: "input",
			output: "out",
			program: JSON.stringify(program),
		},
	);
	return { nn, w: nn.weightsFromBytes(bytes) };
}

describe("runU2netp", () => {
	it("runs the exported program (dilated conv, pool, resize, concat, add, sigmoid)", async () => {
		const { nn, w } = weights();
		const m = bindU2netp(w);
		expect(m.stages).toEqual(["e"]);
		const src = Float32Array.from({ length: 16 }, (_, i) => (i % 5) - 2);
		const x = nn.fromArray(src, [1, 1, 4, 4]);
		const { prob, taps } = runU2netp(nn, m, x, new Set(["a", "u"]));
		// centre-tap-only dilated conv: a = relu(2x + 0.5)
		const a = Array.from(src, (v) => Math.max(0, 2 * v + 0.5));
		expect(Array.from(await nn.read(taps.a))).toEqual(a);
		// 2x2 max pool, then x3, then bilinear back up (half-pixel, align_corners=false)
		const pooled = [0, 1].flatMap((py) =>
			[0, 1].map((px) =>
				Math.max(
					a[2 * py * 4 + 2 * px],
					a[2 * py * 4 + 2 * px + 1],
					a[(2 * py + 1) * 4 + 2 * px],
					a[(2 * py + 1) * 4 + 2 * px + 1],
				),
			),
		);
		const q = pooled.map((v) => 3 * v);
		const at = (y: number, x: number) =>
			q[Math.min(1, Math.max(0, y)) * 2 + Math.min(1, Math.max(0, x))];
		const up = (y: number, x: number) => {
			const sy = (y + 0.5) / 2 - 0.5;
			const sx = (x + 0.5) / 2 - 0.5;
			const y0 = Math.floor(sy);
			const x0 = Math.floor(sx);
			const fy = sy - y0;
			const fx = sx - x0;
			return (
				at(y0, x0) * (1 - fy) * (1 - fx) +
				at(y0, x0 + 1) * (1 - fy) * fx +
				at(y0 + 1, x0) * fy * (1 - fx) +
				at(y0 + 1, x0 + 1) * fy * fx
			);
		};
		const uu = Array.from({ length: 16 }, (_, i) =>
			up(Math.floor(i / 4), i % 4),
		);
		const got = Array.from(await nn.read(taps.u));
		expectArrayClose(got, uu, 1e-5);
		const want = uu.map((u, i) => 1 / (1 + Math.exp(-(u - a[i] + src[i]))));
		const out = Array.from(await nn.read(prob));
		expectArrayClose(out, want, 1e-5);
	});

	it("rejects a file that is not a u2netp program", () => {
		const nn = new CpuNn();
		const w = nn.weightsFromBytes(
			encodeSafetensors({ x: { shape: [1], data: Float32Array.of(1) } }),
		);
		expect(() => bindU2netp(w)).toThrow(/rigi-u2netp-1/);
	});
});
