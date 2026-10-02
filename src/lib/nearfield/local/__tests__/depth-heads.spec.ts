// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { CpuNn, type Tensor, type Weights } from "#/lib/nn";
import { seededRandom } from "#/test/helpers";
import {
	DEPTH_LIVE_PRESETS,
	MOGE2_VITS,
	MogeDepthNet,
	tokenGrid,
} from "../depth-net";

const C = 4;
const HEADS = ["points_head", "mask_head", "normal_head"] as const;
const OUT_CHANNELS = { points_head: 3, mask_head: 1, normal_head: 3 };

/** A tiny synthetic ConvStack weight set (C channels everywhere) for the heads and a neck. */
function syntheticWeights(nn: CpuNn): Weights {
	const rand = seededRandom(7);
	const map = new Map<string, Tensor>();
	const put = (name: string, shape: number[]) => {
		const n = shape.reduce((a, b) => a * b, 1);
		map.set(
			name,
			nn.fromArray(
				Float32Array.from({ length: n }, () => rand() - 0.5),
				shape,
			),
		);
	};
	for (const prefix of ["neck", ...HEADS]) {
		for (let l = 0; l < 5; l++) {
			put(`${prefix}.input_blocks.${l}.weight`, [C, C, 1, 1]);
			put(`${prefix}.input_blocks.${l}.bias`, [C]);
			for (let r = 0; r < MOGE2_VITS.resBlocks[l]; r++)
				for (const k of [2, 5]) {
					put(`${prefix}.res_blocks.${l}.${r}.layers.${k}.weight`, [
						C,
						C,
						3,
						3,
					]);
					put(`${prefix}.res_blocks.${l}.${r}.layers.${k}.bias`, [C]);
				}
		}
		for (let l = 0; l < 4; l++) {
			if (l < 3) {
				put(`${prefix}.resamplers.${l}.0.weight`, [C, C, 2, 2]);
				put(`${prefix}.resamplers.${l}.0.bias`, [C]);
			}
			put(`${prefix}.resamplers.${l}.1.weight`, [C, C, 3, 3]);
			put(`${prefix}.resamplers.${l}.1.bias`, [C]);
		}
		if (prefix !== "neck") {
			const out = OUT_CHANNELS[prefix as (typeof HEADS)[number]];
			put(`${prefix}.output_blocks.4.weight`, [out, C, 1, 1]);
			put(`${prefix}.output_blocks.4.bias`, [out]);
		}
	}
	return {
		names: [...map.keys()],
		has: (name) => map.has(name),
		get: (name) => {
			const t = map.get(name);
			if (!t) throw new Error(name);
			return t;
		},
		metadata: {},
	};
}

describe("batched heads", () => {
	it("one grouped stack equals the three separate head stacks", async () => {
		const nn = new CpuNn();
		const net = new MogeDepthNet(nn, syntheticWeights(nn));
		const rand = seededRandom(3);
		for (const last8 of [false, true]) {
			// level l is 2 << l square; with last8 level 4 is at level 3's size
			const size = (l: number) => 2 << (last8 ? Math.min(l, 3) : l);
			const neck = [0, 1, 2, 3, 4].map((l) =>
				nn.fromArray(
					Float32Array.from({ length: C * size(l) ** 2 }, () => rand() - 0.5),
					[1, C, size(l), size(l)],
				),
			);
			const separate = await Promise.all(
				HEADS.map((h) => nn.read(net.convStack(h, neck, 4, last8)[4])),
			);
			const fused = await nn.read(net.convStack([...HEADS], neck, 4, last8)[4]);
			const area = fused.length / 9;
			// channels: points 0..2, mask 3 (padded to 3), normal 6..8
			const want = [0, 3, 6];
			HEADS.forEach((h, i) => {
				const ch = OUT_CHANNELS[h];
				for (let c = 0; c < ch; c++)
					for (let k = 0; k < area; k++)
						expect(fused[(want[i] + c) * area + k]).toBeCloseTo(
							separate[i][c * area + k],
							5,
						);
			});
		}
	});
});

describe("live presets", () => {
	it("name the weights, a token count and a valid head stop", () => {
		for (const preset of Object.values(DEPTH_LIVE_PRESETS)) {
			expect(preset.tokens).toBeLessThan(MOGE2_VITS.tokens[0]);
			expect([3, 4]).toContain(preset.headStopLevel);
			const [bh, bw] = tokenGrid(preset.tokens, 4 / 3);
			expect(Math.abs(bh * bw - preset.tokens) / preset.tokens).toBeLessThan(
				0.1,
			);
		}
	});
});
