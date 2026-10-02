// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	interpolateEye,
	interpolateSample,
	loadReplay,
	parseSidecar,
} from "../replay";

const samples = [
	{ t: 0, yaw: 350, pitch: 0, roll: 0 },
	{ t: 2, yaw: 10, pitch: 10, roll: 4, yawAccuracy: 8 },
];

describe("parseSidecar", () => {
	it("keeps valid samples sorted and drops broken ones", () => {
		const parsed = parseSidecar({
			samples: [
				{ t: 2, yaw: 1, pitch: 0, roll: 0 },
				{ t: 1, yaw: 1, pitch: 0, roll: 0 },
				{ t: "x" },
			],
		});
		expect(parsed?.samples.map((s) => s.t)).toEqual([1, 2]);
	});

	it("returns null for nothing usable", () => {
		expect(parseSidecar(null)).toBeNull();
		expect(parseSidecar({ samples: [] })).toBeNull();
	});

	it("accepts an eye on its own", () => {
		expect(parseSidecar({ eye: { lat: 46, lon: 7 } })?.eye).toEqual({
			lat: 46,
			lon: 7,
		});
	});
});

describe("interpolateSample", () => {
	it("interpolates yaw the short way round the wrap", () => {
		const s = interpolateSample(samples, 1, 77);
		expect(s?.yaw).toBeCloseTo(0, 9);
		expect(s?.pitch).toBeCloseTo(5, 9);
		expect(s?.roll).toBeCloseTo(2, 9);
		expect(s?.time).toBe(77);
	});

	it("clamps outside the recorded range", () => {
		expect(interpolateSample(samples, -5, 0)?.yaw).toBeCloseTo(350, 9);
		expect(interpolateSample(samples, 99, 0)?.yaw).toBeCloseTo(10, 9);
	});

	it("is null with no samples", () => {
		expect(interpolateSample([], 0, 0)).toBeNull();
	});
});

describe("loadReplay", () => {
	it("reads <clip>.sensors.json and tolerates its absence", async () => {
		const ok = (async (url: string) => {
			expect(url).toBe("/clip.mp4.sensors.json");
			return {
				ok: true,
				json: async () => ({ samples, eye: { lat: 46.7, lon: 7.8 } }),
			};
		}) as unknown as typeof fetch;
		const feed = await loadReplay("/clip.mp4", ok);
		expect(feed.sidecar?.samples.length).toBe(2);
		expect(feed.eye(3)).toMatchObject({ lat: 46.7, time: 3 });
		expect(
			feed.sample({ currentTime: 1 } as HTMLVideoElement, 5)?.pitch,
		).toBeCloseTo(5, 9);

		const missing = await loadReplay("/clip.mp4", (async () => ({
			ok: false,
		})) as unknown as typeof fetch);
		expect(missing.sidecar).toBeNull();
		expect(
			missing.sample({ currentTime: 1 } as HTMLVideoElement, 5),
		).toBeNull();
		const broken = await loadReplay("/clip.mp4", (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch);
		expect(broken.sidecar).toBeNull();
	});
});

describe("eyes track", () => {
	const eyes = [
		{ t: 0, lat: 46, lon: 7, accuracy: 5 },
		{ t: 10, lat: 46.1, lon: 7.2, alt: 1000, accuracy: 20 },
	];
	it("parses, sorts, and defaults the eye to the first point", () => {
		const parsed = parseSidecar({
			eyes: [eyes[1], { t: "x" }, eyes[0], { t: 5, lat: 46, lon: 7 }],
		});
		expect(parsed?.eyes?.map((e) => e.t)).toEqual([0, 5, 10]);
		expect(parsed?.eyes?.[1].accuracy).toBe(5);
		expect(parsed?.eye).toMatchObject({ lat: 46, lon: 7 });
	});
	it("interpolates and holds at the ends", () => {
		expect(interpolateEye(eyes, 5, 9)).toMatchObject({
			lat: 46.05,
			lon: 7.1,
			accuracy: 20,
			time: 9,
		});
		expect(interpolateEye(eyes, 99, 0)?.lat).toBe(46.1);
		expect(interpolateEye([], 1, 0)).toBeNull();
	});
	it("feeds the track through eyeAt by the video clock", async () => {
		const fetchImpl = (async () => ({
			ok: true,
			json: async () => ({ samples: [], eyes }),
		})) as unknown as typeof fetch;
		const feed = await loadReplay("clip.mp4", fetchImpl);
		const video = { currentTime: 10 } as HTMLVideoElement;
		expect(feed.eyeAt(video, 1)?.lat).toBe(46.1);
		expect(feed.eye(1)?.lat).toBe(46);
	});
});
