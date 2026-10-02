// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { TrackedPose, TrackFrame } from "../contract";
import {
	equivalentFocalLength,
	makeEyePhoto,
	nearestRegion,
} from "../eye-photo";
import { createSensorTracker } from "../sensor-tracker";

const eye = { lat: 46.7, lon: 7.8, accuracy: 10, time: 0 };
const frame = (sensor?: TrackFrame["sensor"]): TrackFrame => ({
	time: 1,
	width: 1280,
	height: 720,
	source: {} as HTMLVideoElement,
	sensor,
});

describe("createSensorTracker", () => {
	it("emits the sensor pose as a suggestion and tracks once a true heading exists", () => {
		const tracker = createSensorTracker({ eye, vfov: 45 });
		const out: TrackedPose[] = [];
		tracker.onPose((p) => out.push(p));
		tracker.pushFrame(frame({ time: 1, yaw: 120, pitch: 4, roll: -2 }));
		expect(out[0]).toMatchObject({
			pose: { yaw: 120, pitch: 4, roll: -2, vfov: 45 },
			phase: "track",
			source: "sensor",
			suggestion: true,
		});
		expect(tracker.phase).toBe("track");
	});

	it("stays in init on a relative-only heading, and goes lost when the sensor stops", () => {
		const tracker = createSensorTracker({ eye, vfov: 45 });
		tracker.pushFrame(
			frame({ time: 1, yaw: null, yawRelative: 30, pitch: 0, roll: 0 }),
		);
		expect(tracker.phase).toBe("init");
		tracker.pushFrame(frame());
		expect(tracker.phase).toBe("lost");
	});

	it("applies the calibration offset and wraps", () => {
		const tracker = createSensorTracker({ eye, vfov: 45 });
		const out: TrackedPose[] = [];
		tracker.onPose((p) => out.push(p));
		tracker.setYawOffset(-15);
		tracker.pushFrame(frame({ time: 1, yaw: 10, pitch: 0, roll: 0 }));
		expect(out[0].pose.yaw).toBeCloseTo(355, 9);
	});

	it("unsubscribes and disposes", () => {
		const tracker = createSensorTracker({ eye, vfov: 45 });
		const out: TrackedPose[] = [];
		const off = tracker.onPose((p) => out.push(p));
		off();
		tracker.pushFrame(frame({ time: 1, yaw: 1, pitch: 0, roll: 0 }));
		expect(out.length).toBe(0);
	});
});

describe("eye photo", () => {
	it("builds a PhotoMeta at the eye with the frame size and no altitude", () => {
		const meta = makeEyePhoto(
			eye,
			{ width: 1280, height: 720 },
			40,
			"region-0",
			new Date("2026-10-02T10:00:00Z"),
		);
		expect(meta).toMatchObject({
			id: "live",
			lat: 46.7,
			lon: 7.8,
			width: 1280,
			height: 720,
			vfov: 40,
			region: "region-0",
			alt: null,
		});
		expect(meta.takenAt).toBe("2026-10-02T10:00:00.000Z");
	});

	it("derives the 35 mm equivalent focal length from the field of view", () => {
		// a 26 mm lens: long-side half angle atan(18 / 26)
		const longFov = 2 * Math.atan(18 / 26);
		const vfov =
			(2 * Math.atan(Math.tan(longFov / 2) * (720 / 1280)) * 180) / Math.PI;
		expect(
			equivalentFocalLength(vfov, { width: 1280, height: 720 }),
		).toBeCloseTo(26, 6);
		const portraitVfov = (longFov * 180) / Math.PI;
		expect(
			equivalentFocalLength(portraitVfov, { width: 720, height: 1280 }),
		).toBeCloseTo(26, 6);
	});

	it("picks the nearest region within 80 km, else none", () => {
		const photos = [
			{ lat: 46.7, lon: 7.8, region: "a" },
			{ lat: 47.5, lon: 8.5, region: "b" },
		];
		expect(nearestRegion({ lat: 46.71, lon: 7.81 }, photos)).toBe("a");
		expect(nearestRegion({ lat: 47.45, lon: 8.5 }, photos)).toBe("b");
		expect(nearestRegion({ lat: 10, lon: 10 }, photos)).toBeNull();
	});
});
