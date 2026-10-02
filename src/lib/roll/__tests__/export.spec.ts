// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhotoMeta } from "../../photos";
import { downloadRollGeoJSON } from "../export";
import { saveSolvedPose } from "../roll";
import type { Roll, RollPhoto } from "../types";

function photo(
	id: string,
	lat: number,
	lon: number,
	o: Partial<RollPhoto> = {},
): RollPhoto {
	return {
		meta: {
			id,
			takenAt: "2026-09-07T10:00:00Z",
			lat,
			lon,
			width: 4000,
			height: 3000,
			alt: 1234,
		} as unknown as PhotoMeta,
		pose: { yaw: 90.123456, pitch: 2.5, roll: -0.004, vfov: 55 },
		poseSource: "prior",
		confidence: null,
		eyeAlt: null,
		t: 0,
		viewpoint: 0,
		...o,
	};
}

let blobs: Blob[];
let clicked: { href: string; download: string }[];
function stubBrowser() {
	blobs = [];
	clicked = [];
	vi.stubGlobal("URL", {
		createObjectURL: (b: Blob) => {
			blobs.push(b);
			return "blob:x";
		},
		revokeObjectURL: vi.fn(),
	});
	vi.stubGlobal("document", {
		createElement: () => {
			const a = {
				href: "",
				download: "",
				click() {
					clicked.push({ href: a.href, download: a.download });
				},
			};
			return a;
		},
	});
}
afterEach(() => vi.unstubAllGlobals());

async function exported(roll: Roll) {
	downloadRollGeoJSON(roll);
	return JSON.parse(await blobs[0].text());
}

describe("downloadRollGeoJSON", () => {
	it("downloads <roll id>.geojson as geo+json", async () => {
		stubBrowser();
		const roll = {
			id: "niederhorn",
			name: "Niederhorn",
			photos: [photo("a", 46.7, 7.7)],
		} as unknown as Roll;
		await exported(roll);
		expect(clicked).toEqual([
			{ href: "blob:x", download: "niederhorn.geojson" },
		]);
		expect(blobs[0].type).toBe("application/geo+json");
	});

	it("writes a camera point and a view wedge per photo, no track for one photo", async () => {
		stubBrowser();
		const fc = await exported({
			id: "r",
			name: "R",
			photos: [photo("a", 46.7, 7.7)],
		} as unknown as Roll);
		expect(fc.type).toBe("FeatureCollection");
		expect(fc.name).toBe("R");
		expect(
			fc.features.map(
				(f: { properties: { kind: string } }) => f.properties.kind,
			),
		).toEqual(["camera", "view"]);
		const [cam, view] = fc.features;
		expect(cam.geometry).toEqual({ type: "Point", coordinates: [7.7, 46.7] });
		expect(cam.properties).toMatchObject({
			id: "a",
			yaw: 90.12,
			pitch: 2.5,
			roll: 0,
			vfov: 55,
			poseSource: "prior",
			altitude: 1234,
		});
		expect(cam.properties.hfov).toBeGreaterThan(55);
		expect(cam.properties).not.toHaveProperty("poseMethod");
		// wedge: apex, 13 arc points, apex again
		const ring = view.geometry.coordinates[0];
		expect(ring).toHaveLength(15);
		expect(ring[0]).toEqual(ring[14]);
		expect(ring[0]).toEqual([7.7, 46.7]);
	});

	it("centres the wedge on the yaw: the middle arc point lies due east for yaw 90", async () => {
		stubBrowser();
		const fc = await exported({
			id: "r",
			name: "R",
			photos: [
				photo("a", 46.7, 7.7, {
					pose: { yaw: 90, pitch: 0, roll: 0, vfov: 55 },
				}),
			],
		} as unknown as Roll);
		const mid = fc.features[1].geometry.coordinates[0][7];
		expect(mid[0]).toBeGreaterThan(7.7);
		expect(Math.abs(mid[1] - 46.7)).toBeLessThan(1e-3);
	});

	it("adds the track for two or more photos, in photo order", async () => {
		stubBrowser();
		const fc = await exported({
			id: "r",
			name: "R",
			photos: [photo("a", 46.7, 7.7), photo("b", 46.71, 7.71)],
		} as unknown as Roll);
		const track = fc.features[fc.features.length - 1];
		expect(track.properties).toEqual({ kind: "track", name: "R" });
		expect(track.geometry).toEqual({
			type: "LineString",
			coordinates: [
				[7.7, 46.7],
				[7.71, 46.71],
			],
		});
	});

	it("caps very wide wedges below 180 degrees", async () => {
		stubBrowser();
		const fc = await exported({
			id: "r",
			name: "R",
			photos: [
				photo("a", 46.7, 7.7, {
					pose: { yaw: 0, pitch: 0, roll: 0, vfov: 179.5 },
				}),
			],
		} as unknown as Roll);
		expect(fc.features[0].properties.hfov).toBeGreaterThan(179);
		// arc spans hf = 179 degrees: first and last points are 179 apart in bearing, not a closed ring
		const ring = fc.features[1].geometry.coordinates[0];
		expect(ring[1]).not.toEqual(ring[13]);
	});

	it("labels a user-accepted propagated suggestion", async () => {
		stubBrowser();
		const store = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k),
		});
		saveSolvedPose("a", {
			pose: { yaw: 1, pitch: 0, roll: 0, vfov: 50 },
			confidence: 0,
			method: "propagated-suggestion",
			at: "x",
		});
		saveSolvedPose("b", {
			pose: { yaw: 1, pitch: 0, roll: 0, vfov: 50 },
			confidence: 0.9,
			method: "cascade",
			at: "x",
		});
		const fc = await exported({
			id: "r",
			name: "R",
			photos: [
				photo("a", 46.7, 7.7, { poseSource: "solved" }),
				photo("b", 46.7, 7.7, { poseSource: "solved" }),
			],
		} as unknown as Roll);
		const cams = fc.features.filter(
			(f: { properties: { kind: string } }) => f.properties.kind === "camera",
		);
		expect(cams[0].properties.poseMethod).toBe("propagated-suggestion");
		expect(cams[1].properties).not.toHaveProperty("poseMethod");
	});
});
