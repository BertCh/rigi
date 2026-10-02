// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	LabelThrottle,
	liveFrameScope,
	liveSourceSize,
	PoseLatency,
} from "../renderer-live";

const POSE = { yaw: 10, pitch: 0, roll: 0, vfov: 50 };

describe("liveFrameScope", () => {
	it("a pose change needs the whole frame", () => {
		expect(
			liveFrameScope({
				poseChanged: true,
				photoChanged: true,
				worldView: false,
			}),
		).toBe("all");
	});
	it("a video frame alone is a screen pass in the photo view, colour in the world view", () => {
		expect(
			liveFrameScope({
				poseChanged: false,
				photoChanged: true,
				worldView: false,
			}),
		).toBe("screen");
		expect(
			liveFrameScope({
				poseChanged: false,
				photoChanged: true,
				worldView: true,
			}),
		).toBe("color");
	});
	it("nothing changed draws nothing", () => {
		expect(
			liveFrameScope({
				poseChanged: false,
				photoChanged: false,
				worldView: false,
			}),
		).toBeNull();
	});
});

describe("liveSourceSize", () => {
	it("reads videoWidth for a video and displayWidth for a VideoFrame", () => {
		expect(
			liveSourceSize({ videoWidth: 640, videoHeight: 480 } as never),
		).toEqual({ width: 640, height: 480 });
		expect(
			liveSourceSize({ displayWidth: 1280, displayHeight: 720 } as never),
		).toEqual({ width: 1280, height: 720 });
	});
});

describe("LabelThrottle", () => {
	it("passes the first emit, then limits the rate", () => {
		const t = new LabelThrottle(100, 0.05);
		expect(t.allow(0, POSE)).toBe(true);
		expect(t.allow(50, { ...POSE, yaw: 20 })).toBe(false);
		expect(t.waitMs(50)).toBe(50);
		expect(t.allow(100, { ...POSE, yaw: 20 })).toBe(true);
	});
	it("skips an emit when the pose barely moved", () => {
		const t = new LabelThrottle(100, 0.05);
		t.allow(0, POSE);
		expect(t.allow(200, { ...POSE, yaw: 10.01 })).toBe(false);
		expect(t.allow(200, { ...POSE, pitch: 0.2 })).toBe(true);
	});
	it("wraps the yaw difference at north", () => {
		const t = new LabelThrottle(0, 0.05);
		t.allow(0, { ...POSE, yaw: 359.99 });
		expect(t.allow(1, { ...POSE, yaw: 0.01 })).toBe(false);
	});
	it("reset reopens the gate", () => {
		const t = new LabelThrottle(100, 0.05);
		t.allow(0, POSE);
		t.reset();
		expect(t.allow(1, POSE)).toBe(true);
	});
});

describe("PoseLatency", () => {
	it("measures from the first pending pose to the next frame", () => {
		const l = new PoseLatency();
		expect(l.summary()).toBeNull();
		l.notePose(10);
		l.notePose(14);
		l.noteFrame(30);
		l.noteFrame(40); // no pending pose: ignored
		l.notePose(100);
		l.noteFrame(110);
		const s = l.summary();
		expect(l.samples).toBe(2);
		expect(s?.max).toBe(20);
		expect(s?.mean).toBe(15);
	});
	it("keeps a bounded window", () => {
		const l = new PoseLatency(3);
		for (let i = 0; i < 10; i++) {
			l.notePose(i * 10);
			l.noteFrame(i * 10 + 1);
		}
		expect(l.samples).toBe(3);
	});
});
