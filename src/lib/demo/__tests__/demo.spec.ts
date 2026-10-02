// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pose } from "../../camera";
import type { PhotoMeta } from "../../photos";
import type { Roll } from "../../roll/types";
import {
	DEMO_PREFIX,
	DEMO_ROLL_ID,
	DEMO_SMALL_LONG,
	isDemoPhotoId,
	loadDemoRoll,
	panoramaPxPerDeg,
} from "../index";
import {
	decodePeopleMasks,
	encodePeopleMasks,
	type PeopleMasks,
} from "../people-masks";

afterEach(() => vi.unstubAllGlobals());

describe("people masks codec", () => {
	const masks: PeopleMasks = new Map([
		[
			"demo-01",
			{ width: 3, height: 2, data: Uint8Array.from([0, 255, 128, 1, 2, 3]) },
		],
		["demo-02", null],
		["demo-03", { width: 1, height: 1, data: Uint8Array.from([255]) }],
	]);
	it("round-trips masks, nulls and ordering", () => {
		const back = decodePeopleMasks(encodePeopleMasks(masks));
		expect([...back.keys()]).toEqual(["demo-01", "demo-02", "demo-03"]);
		expect(back.get("demo-02")).toBeNull();
		expect(back.get("demo-01")).toEqual({
			width: 3,
			height: 2,
			data: Uint8Array.from([0, 255, 128, 1, 2, 3]),
		});
	});
	it("encodes the documented layout", () => {
		const bytes = encodePeopleMasks(
			new Map([["ab", { width: 2, height: 1, data: Uint8Array.from([7, 9]) }]]),
		);
		expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RPM1");
		expect([...bytes.subarray(4, 8)]).toEqual([1, 0, 0, 0]); // count, little-endian
		expect(bytes[8]).toBe(2); // id length
		expect(bytes.byteLength).toBe(8 + 1 + 2 + 4 + 2);
		expect([...bytes.subarray(bytes.length - 2)]).toEqual([7, 9]);
	});
	it("decodes from an offset view and copies the mask data out", () => {
		const enc = encodePeopleMasks(masks);
		const big = new Uint8Array(enc.length + 5);
		big.set(enc, 5);
		const back = decodePeopleMasks(big.subarray(5));
		expect(back.get("demo-03")?.data[0]).toBe(255);
		big.fill(0);
		expect(back.get("demo-03")?.data[0]).toBe(255); // independent copy
	});
	it("handles an empty set and rejects a wrong magic", () => {
		expect(decodePeopleMasks(encodePeopleMasks(new Map())).size).toBe(0);
		const bad = encodePeopleMasks(masks).slice();
		bad[0] = 0x58;
		expect(() => decodePeopleMasks(bad)).toThrow(/bad magic/);
	});
});

describe("demo ids", () => {
	it("recognises demo photo ids", () => {
		expect(DEMO_PREFIX).toBe("demo-");
		expect(isDemoPhotoId("demo-07")).toBe(true);
		expect(isDemoPhotoId("IMG_7059")).toBe(false);
		expect(isDemoPhotoId("local-demo-1")).toBe(false);
	});
});

const meta = (
	id: string,
	w = 4000,
	h = 3000,
	o: Partial<PhotoMeta> = {},
): PhotoMeta =>
	({
		id,
		src: `/demo/photos/${id}.jpg`,
		width: w,
		height: h,
		takenAt: "2025-08-01T10:00:00Z",
		lat: 46.7,
		lon: 7.7,
		alt: null,
		hAccuracy: null,
		heading: 0,
		f35: 26,
		vfov: 55,
		gravity: null,
		pitch: 0,
		roll: 0,
		holding: null,
		region: "demo-region",
		...o,
	}) as PhotoMeta;

function rollWithYaws(yaws: number[], vfov = 60, w = 4000, h = 3000): Roll {
	return {
		id: "r",
		name: "r",
		viewpoints: [],
		center: { lat: 0, lon: 0 },
		radiusM: 0,
		region: null,
		photos: yaws.map((yaw, i) => ({
			meta: meta(`p${i}`, w, h),
			pose: { yaw, pitch: 0, roll: 0, vfov } as Pose,
			poseSource: "prior" as const,
			confidence: null,
			eyeAlt: null,
			t: i,
			viewpoint: 0,
		})),
	};
}

describe("panoramaPxPerDeg", () => {
	// vfov 60 at 4:3 -> hfov = 2 atan(tan(30deg) * 4/3) ~ 75.2 deg
	const HFOV = (360 / Math.PI) * Math.atan(Math.tan(Math.PI / 6) * (4 / 3));
	it("spreads a single photo's span (x1.06) over the device width", () => {
		const px = panoramaPxPerDeg(rollWithYaws([0]), 1000);
		expect(px).toBeCloseTo(1000 / (HFOV * 1.06), 0);
	});
	it("two adjacent photos cover a wider span, lowering the density", () => {
		const one = panoramaPxPerDeg(rollWithYaws([0]), 1000);
		const two = panoramaPxPerDeg(rollWithYaws([0, 60]), 1000);
		expect(two).toBeLessThan(one);
		expect(two).toBeCloseTo(1000 / ((60 + HFOV) * 1.06), 0);
	});
	it("handles a span that wraps through north", () => {
		const wrapped = panoramaPxPerDeg(rollWithYaws([350, 20]), 1000);
		const plain = panoramaPxPerDeg(rollWithYaws([0, 30]), 1000);
		expect(wrapped).toBeCloseTo(plain, 0);
	});
	it("a full circle is capped at 360 degrees", () => {
		const yaws = Array.from({ length: 8 }, (_, i) => i * 45);
		expect(panoramaPxPerDeg(rollWithYaws(yaws), 720)).toBeCloseTo(720 / 360, 6);
	});
	it("scales linearly with device width", () => {
		const r = rollWithYaws([10, 50]);
		expect(panoramaPxPerDeg(r, 2000)).toBeCloseTo(
			2 * panoramaPxPerDeg(r, 1000),
			9,
		);
	});
});

describe("loadDemoRoll", () => {
	const manifest = {
		name: "Sample trip",
		place: "Niederhorn",
		photos: [
			{ ...meta("demo-01"), thumb: "t1" },
			{
				...meta("demo-02", 3000, 4000, { takenAt: "2025-08-01T10:05:00Z" }),
				thumb: "t2",
			},
		],
		poses: {
			"demo-01": {
				pose: { yaw: 33, pitch: 1, roll: 0, vfov: 50 },
				source: "solved",
				confidence: 0.9,
			},
		},
		region: { id: "demo-region", center: { lat: 46.7, lon: 7.7 }, peaks: [] },
	};
	function stubFetch() {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url === "/demo/manifest.json")
					return { ok: true, status: 200, json: async () => manifest };
				if (url === "/demo/pano/index.json")
					return { ok: true, status: 200, json: async () => ({}) };
				return { ok: false, status: 404, json: async () => null };
			}),
		);
	}

	it("builds the demo roll, applying the bundled pose, and uses small copies on request", async () => {
		stubFetch();
		const roll = await loadDemoRoll({ core: true, smallPhotos: true });
		expect(roll.id).toBe(DEMO_ROLL_ID);
		expect(roll.name).toBe("Sample trip");
		expect(roll.region).toBe("demo-region");
		const [a, b] = roll.photos;
		expect(a.poseSource).toBe("solved");
		expect(a.pose.yaw).toBe(33);
		expect(a.confidence).toBe(0.9);
		expect(b.poseSource).toBe("prior"); // no bundled pose: EXIF prior stays
		expect(a.meta.src).toBe(`/demo/photos-${DEMO_SMALL_LONG}/demo-01.jpg`);
		// registered metas keep the full-size source
		expect(manifest.photos[0].src).toBe("/demo/photos/demo-01.jpg");
	});

	it("only swaps in small copies whose texel density meets the required density", async () => {
		stubFetch();
		const lo = await loadDemoRoll({ core: true, smallPhotos: () => 1 });
		expect(lo.photos.every((p) => p.meta.src.includes("photos-1024"))).toBe(
			true,
		);
		const hi = await loadDemoRoll({ core: true, smallPhotos: () => 1e6 });
		expect(hi.photos.every((p) => p.meta.src.includes("/demo/photos/"))).toBe(
			true,
		);
	});
});
