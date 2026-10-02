// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { estimateIntrinsics, SensorHistory, startFramePump } from "../camera";
import type { SensorSample, TrackFrame } from "../contract";

const sample = (time: number): SensorSample => ({
	time,
	yaw: 0,
	pitch: 0,
	roll: 0,
});

describe("estimateIntrinsics", () => {
	it("a portrait frame has the long-side field of view vertically", () => {
		const i = estimateIntrinsics({ width: 720, height: 1280 });
		expect(i.vfov).toBeCloseTo(69.4, 6);
		expect(i.hfov).toBeLessThan(i.vfov);
		expect(i.source).toBe("default");
	});

	it("a landscape 16:9 frame has the long side horizontally", () => {
		const i = estimateIntrinsics({ width: 1280, height: 720 });
		expect(i.hfov).toBeCloseTo(69.4, 6);
		expect(i.vfov).toBeCloseTo(
			2 *
				Math.atan(Math.tan((69.4 * Math.PI) / 360) * (720 / 1280)) *
				(180 / Math.PI),
			6,
		);
	});

	it("an override wins and gives the matching horizontal field", () => {
		const i = estimateIntrinsics({
			width: 1280,
			height: 720,
			vfovOverride: 40,
		});
		expect(i.vfov).toBe(40);
		expect(i.source).toBe("override");
		expect(
			Math.tan((i.hfov * Math.PI) / 360) / Math.tan((40 * Math.PI) / 360),
		).toBeCloseTo(1280 / 720, 9);
	});

	it("zoom narrows the field", () => {
		const wide = estimateIntrinsics({ width: 1280, height: 720 });
		const zoomed = estimateIntrinsics({ width: 1280, height: 720, zoom: 2 });
		expect(zoomed.vfov).toBeLessThan(wide.vfov);
		expect(zoomed.source).toBe("zoomed-default");
	});
});

describe("SensorHistory", () => {
	it("returns the latest sample at or before the time", () => {
		const h = new SensorHistory();
		for (const t of [10, 20, 30]) h.push(sample(t));
		expect(h.at(25)?.time).toBe(20);
		expect(h.at(30)?.time).toBe(30);
		expect(h.at(5)).toBeUndefined();
	});

	it("drops samples older than the max age", () => {
		const h = new SensorHistory(8, 100);
		h.push(sample(10));
		expect(h.at(500)).toBeUndefined();
	});

	it("keeps only the newest `capacity` samples", () => {
		const h = new SensorHistory(2);
		for (const t of [1, 2, 3]) h.push(sample(t));
		expect(h.at(1)).toBeUndefined();
		expect(h.at(3)?.time).toBe(3);
	});

	it("restarts when the clock goes backwards", () => {
		const h = new SensorHistory();
		h.push(sample(100));
		h.push(sample(5));
		expect(h.at(100)?.time).toBe(5);
	});
});

type FakeVideo = {
	videoWidth: number;
	videoHeight: number;
	currentTime: number;
	readyState: number;
	callbacks: ((now: number, metadata: object) => void)[];
	requestVideoFrameCallback?: (
		cb: (now: number, metadata: object) => void,
	) => number;
	cancelVideoFrameCallback?: (id: number) => void;
};

function fakeVideo(withCallback: boolean): FakeVideo {
	const video: FakeVideo = {
		videoWidth: 1280,
		videoHeight: 720,
		currentTime: 0,
		readyState: 4,
		callbacks: [],
	};
	if (withCallback) {
		video.requestVideoFrameCallback = (cb) => video.callbacks.push(cb);
		video.cancelVideoFrameCallback = () => {
			video.callbacks.length = 0;
		};
	}
	return video;
}

describe("startFramePump", () => {
	it("delivers one frame per video frame callback, with the sensor at that time", () => {
		const video = fakeVideo(true);
		const frames: TrackFrame[] = [];
		const pump = startFramePump({
			video: video as unknown as HTMLVideoElement,
			onFrame: (f) => frames.push(f),
			sensorAt: (t) => sample(t - 1),
		});
		expect(pump.usesVideoFrameCallback).toBe(true);
		for (const t of [100, 133, 166]) video.callbacks.shift()?.(t, {});
		expect(frames.map((f) => f.time)).toEqual([100, 133, 166]);
		expect(frames[0].sensor?.time).toBe(99);
		expect(frames[0]).toMatchObject({ width: 1280, height: 720 });
		expect(pump.framesDelivered).toBe(3);
	});

	it("drops frames the gate refuses and keeps running", () => {
		const video = fakeVideo(true);
		const frames: TrackFrame[] = [];
		startFramePump({
			video: video as unknown as HTMLVideoElement,
			onFrame: (f) => frames.push(f),
			accept: (t) => t % 2 === 0,
		});
		for (const t of [1, 2, 3, 4]) video.callbacks.shift()?.(t, {});
		expect(frames.map((f) => f.time)).toEqual([2, 4]);
	});

	it("skips frames before the video has a size", () => {
		const video = fakeVideo(true);
		video.videoWidth = 0;
		const frames: TrackFrame[] = [];
		startFramePump({
			video: video as unknown as HTMLVideoElement,
			onFrame: (f) => frames.push(f),
		});
		video.callbacks.shift()?.(1, {});
		expect(frames).toEqual([]);
	});

	it("stop cancels the pending callback", () => {
		const video = fakeVideo(true);
		const pump = startFramePump({
			video: video as unknown as HTMLVideoElement,
			onFrame: () => {},
		});
		pump.stop();
		expect(video.callbacks.length).toBe(0);
	});

	it("falls back to animation frames deduplicated on currentTime", () => {
		const video = fakeVideo(false);
		const queue: ((t: number) => void)[] = [];
		const frames: TrackFrame[] = [];
		const pump = startFramePump({
			video: video as unknown as HTMLVideoElement,
			onFrame: (f) => frames.push(f),
			now: () => 42,
			requestFrame: (cb) => queue.push(cb),
			cancelFrame: () => {
				queue.length = 0;
			},
		});
		expect(pump.usesVideoFrameCallback).toBe(false);
		// a 60 Hz loop over a 30 fps clip: the media time advances every second tick
		for (let i = 0; i < 6; i++) {
			video.currentTime = Math.floor(i / 2) / 30;
			queue.shift()?.(i * 16);
		}
		expect(frames.length).toBe(3);
		expect(frames[0].time).toBe(42);
		pump.stop();
		expect(queue.length).toBe(0);
	});
});
