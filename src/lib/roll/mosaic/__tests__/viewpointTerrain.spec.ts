// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PhotoMeta } from "../../../photos";
import type { Roll, RollPhoto, Viewpoint } from "../../types";
import type { ViewpointTerrain } from "../ridgelines";
import { terrainKey } from "../terrainCodec";
import {
	setBakedTerrain,
	viewpointEye,
	viewpointTerrain,
} from "../viewpointTerrain";

const photo = (
	id: string,
	eyeAlt: number | null,
	region: string | null,
): RollPhoto =>
	({
		meta: { id, region } as unknown as PhotoMeta,
		pose: { yaw: 0, pitch: 0, roll: 0, vfov: 50 },
		poseSource: "prior",
		confidence: null,
		eyeAlt,
		t: 0,
		viewpoint: 0,
	}) as RollPhoto;

describe("viewpointEye", () => {
	const roll = {
		photos: [
			photo("a", 1500, "alps"),
			photo("b", 1520, "alps"),
			photo("c", 1490, "jura"),
			photo("d", null, null),
			photo("other", 3000, "elsewhere"),
		],
	} as unknown as Roll;
	const vp = (ids: string[]): Viewpoint => ({
		lat: 46.7,
		lon: 7.7,
		photoIds: ids,
	});

	it("uses the viewpoint centroid and the median known eye altitude of its photos", () => {
		const r = viewpointEye(roll, vp(["a", "b", "c", "d"]));
		expect(r.lat).toBe(46.7);
		expect(r.lon).toBe(7.7);
		expect(r.eyeAlt).toBe(1500); // known: 1490, 1500, 1520
	});
	it("takes the upper middle altitude for an even count", () => {
		expect(viewpointEye(roll, vp(["a", "b"])).eyeAlt).toBe(1520);
	});
	it("has no altitude when none is known, and lists each region once without blanks", () => {
		const r = viewpointEye(roll, vp(["d"]));
		expect(r.eyeAlt).toBeNull();
		expect(r.regions).toEqual([]);
		expect(viewpointEye(roll, vp(["a", "b", "c"])).regions.sort()).toEqual([
			"alps",
			"jura",
		]);
	});
	it("ignores photos that are not in the viewpoint", () => {
		expect(viewpointEye(roll, vp(["a"])).eyeAlt).toBe(1500);
		expect(viewpointEye(roll, vp(["a"])).regions).toEqual(["alps"]);
	});
});

describe("viewpointTerrain (baked lookup)", () => {
	const terrain = (tag: number) =>
		({ slabs: tag }) as unknown as ViewpointTerrain;
	const req = (lat: number) => ({ lat, lon: 7.7, eyeAlt: 1500, regions: [] });
	beforeEach(() => vi.resetModules());

	it("serves a baked terrain by its key and memoises the promise per eye", async () => {
		const lookup = vi.fn(async (_k: string) => terrain(1));
		setBakedTerrain(lookup);
		const r = req(46.1);
		const a = viewpointTerrain(r);
		const b = viewpointTerrain({ ...r });
		expect(a).toBe(b);
		expect((await a).slabs).toBe(1);
		expect(lookup).toHaveBeenCalledTimes(1);
		expect(lookup).toHaveBeenCalledWith(terrainKey(r));
	});

	it("looks each distinct eye up separately", async () => {
		const lookup = vi.fn(async (k: string) => terrain(k.length));
		setBakedTerrain(lookup);
		await viewpointTerrain(req(46.2));
		await viewpointTerrain(req(46.3));
		expect(lookup).toHaveBeenCalledTimes(2);
	});
});
