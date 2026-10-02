// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// A miniature rigi-u2netp-1 weights file for the sky model specs (no real weights needed): one 3-channel
// 3x3 conv (dilation 2) + relu, a 2x2 pool, a 1x1 conv, a bilinear resize back to the conv's size, a
// concat, a 1x1 fuse, a residual add and a sigmoid. Output = a 1-channel P(sky)-like map of the input size.
import { encodeSafetensors } from "#/lib/nn";

export const TINY_PROGRAM = [
	["conv", "a_pre", "input", "Conv_0", 2, 2],
	["relu", "a", "a_pre"],
	["pool", "p", "a"],
	["conv", "q", "p", "Conv_1", 1, 0],
	["up", "u", "q", "a"],
	["cat", "c", ["u", "a"]],
	["conv", "d", "c", "Conv_2", 1, 0],
	["add", "e", "d", "d"],
	["sigmoid", "out", "e"],
];

export function tinyU2netpBytes(): Uint8Array {
	const k0 = new Float32Array(3 * 9);
	k0[4] = 0.5; // R centre tap
	k0[9 + 4] = 0.25;
	k0[18 + 4] = 0.25;
	return encodeSafetensors(
		{
			"Conv_0.w": { shape: [1, 3, 3, 3], data: k0 },
			"Conv_0.b": { shape: [1], data: Float32Array.of(0) },
			"Conv_1.w": { shape: [1, 1, 1, 1], data: Float32Array.of(1) },
			"Conv_1.b": { shape: [1], data: Float32Array.of(0) },
			"Conv_2.w": { shape: [1, 2, 1, 1], data: Float32Array.of(1, 1) },
			"Conv_2.b": { shape: [1], data: Float32Array.of(0) },
		},
		{
			layout: "rigi-u2netp-1",
			input: "input",
			output: "out",
			program: JSON.stringify(TINY_PROGRAM),
		},
	);
}
