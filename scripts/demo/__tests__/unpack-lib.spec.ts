// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { poseEntry } from "../unpack-lib.mjs";

describe("poseEntry", () => {
	const pose = { yaw: 10, pitch: 0, vfov: 40 };
	it("keeps a solved pose with its source and confidence", () => {
		expect(poseEntry({ pose, poseSource: "match", confidence: 0.9 })).toEqual({
			pose,
			source: "match",
			confidence: 0.9,
		});
	});
	it("returns null for a prior photo kept by --keep-prior", () => {
		expect(poseEntry({ pose, poseSource: "prior" })).toBeNull();
	});
	it("does not crash on a null or missing pose", () => {
		expect(poseEntry({ pose: null, poseSource: "match" })).toBeNull();
		expect(poseEntry({ poseSource: "eye" })).toBeNull();
	});
});
