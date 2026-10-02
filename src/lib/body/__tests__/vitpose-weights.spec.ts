// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Nn } from "#/lib/nn";
import { VITPOSE_B, VITPOSE_WEIGHTS, VitPose } from "../vitpose";

const manifest = JSON.parse(
	readFileSync(
		path.resolve(
			import.meta.dirname,
			"../../../../scripts/models/manifest.json",
		),
		"utf8",
	),
) as { file: string; licence: string }[];

describe("VITPOSE_WEIGHTS", () => {
	it("lists files that are in the model manifest, both Apache-2.0", () => {
		for (const file of Object.values(VITPOSE_WEIGHTS)) {
			const row = manifest.find((r) => r.file === file);
			expect(row?.licence).toBe("Apache-2.0");
		}
	});
	it("keeps VITPOSE_B.file as the fp16 checkpoint", () => {
		expect(VITPOSE_B.file).toBe(VITPOSE_WEIGHTS.fp16);
	});
});

describe("VitPose.load", () => {
	const fakeNn = () => {
		const loadWeights = vi.fn(async () => ({}));
		return { nn: { loadWeights } as unknown as Nn, loadWeights };
	};
	it("loads the int8 file by default (peopleBodyWeights = q8)", async () => {
		const { nn, loadWeights } = fakeNn();
		await VitPose.load(nn);
		expect(loadWeights).toHaveBeenCalledWith(
			VITPOSE_WEIGHTS.q8,
			expect.anything(),
		);
	});
	it("takes an explicit choice over the flag", async () => {
		const { nn, loadWeights } = fakeNn();
		await VitPose.load(nn, { weights: "fp16" });
		expect(loadWeights).toHaveBeenCalledWith(
			VITPOSE_WEIGHTS.fp16,
			expect.anything(),
		);
	});
});
