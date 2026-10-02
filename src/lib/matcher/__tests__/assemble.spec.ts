// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { Pose } from "#/lib/camera";
import { assemble, Deadline, MATCHER_VERSION } from "../assemble";
import type { Correspondences } from "../core";
import { LOW_CONF } from "../fusion";

const prior: Pose = { yaw: 100, pitch: 2, roll: 0, vfov: 25 };
const views = [{ pose: prior }];
const eye = [0, 0, 1500];
/** No lifted matches at all: the legacy solve reports "too few lifted matches". */
const emptyCorr = (): Correspondences => ({
	x2d: new Float64Array(0),
	X: new Float64Array(0),
	W: 640,
	H: 480,
	perView: [],
	matchMs: 3,
});

describe("assemble", () => {
	it("returns the legacy render-match result when not fused", async () => {
		const r = await assemble(emptyCorr(), views, eye, prior, null, {
			fused: false,
			freeFocal: false,
		});
		expect(r.method).toBe("render-match");
		expect(r.version).toBe(MATCHER_VERSION);
		expect(r.pose).toBeNull();
		expect(r.confidence).toBe(0);
		expect(r.inliers).toBe(0);
		expect(r.inlierFrac).toBe(0);
		expect(r.reason).toBe("too few lifted matches");
	});

	it("without a skyline cue the fused verdict is LOW and says why", async () => {
		const r = await assemble(emptyCorr(), views, eye, prior, null, {
			fused: true,
			freeFocal: false,
		});
		expect(r.confidence).toBe(LOW_CONF);
		expect(r.confidenceLevel).toBe("low");
		expect(r.skylineUnavailable).toBe("no skyline cue");
		expect(r.cues?.skyline).toBeNull();
		expect(r.cues?.match).toBeNull();
		expect(r.confidenceChecks).toEqual({
			cueAgreeDeg: null,
			skylineMedPx: null,
			matchSupport: null,
		});
	});

	it("passes the caller's skyline note through", async () => {
		const r = await assemble(emptyCorr(), views, eye, prior, null, {
			fused: true,
			freeFocal: false,
			skyNote: "sky model not loaded",
		});
		expect(r.skylineUnavailable).toBe("sky model not loaded");
	});

	it("throws Deadline when the request budget is already spent (fused only)", async () => {
		const spent = performance.now() - 1;
		await expect(
			assemble(emptyCorr(), views, eye, prior, null, {
				fused: true,
				freeFocal: false,
				deadline: spent,
			}),
		).rejects.toBeInstanceOf(Deadline);
		// the legacy path ignores the deadline
		await expect(
			assemble(emptyCorr(), views, eye, prior, null, {
				fused: false,
				freeFocal: false,
				deadline: spent,
			}),
		).resolves.toMatchObject({ method: "render-match" });
	});

	it("Deadline is a named Error", () => {
		const d = new Deadline();
		expect(d).toBeInstanceOf(Error);
		expect(d.name).toBe("Deadline");
	});
});
