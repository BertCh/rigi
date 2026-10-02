// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { TrackedPose, TrackFrame } from "../../live/contract";
import { createCpuScanner, createTracker, createTrackerCore } from "../index";
import type { RgbaImage } from "../skyline-cpu";
import {
	makeRidgeProfile,
	makeSensor,
	makeTrajectory,
	renderFrame,
	rng,
	rotationErrorDeg,
} from "../synthetic";

const W = 160;
const H = 90;
const flush = () => new Promise<void>((r) => setImmediate(r));
const profile = makeRidgeProfile(1);
const truth = makeTrajectory({ seed: 7 });

async function drive(
	tracker: ReturnType<typeof createTrackerCore>,
	current: { img: RgbaImage | null },
	seconds: number,
	opts: {
		sensor: boolean;
		blackout?: [number, number];
		compassJump?: [number, number, number];
	} = { sensor: true },
) {
	const poses: TrackedPose[] = [];
	tracker.onPose((p) => poses.push(p));
	const sensorOf = makeSensor({
		yawBias: 8,
		yawJumps: opts.compassJump ? [opts.compassJump] : [],
	});
	const rand = rng(3);
	const fps = 15;
	for (let k = 0; k < seconds * fps; k++) {
		const t = k / fps;
		const blackout =
			!!opts.blackout && t >= opts.blackout[0] && t < opts.blackout[1];
		current.img = renderFrame(
			profile,
			truth(t),
			W,
			H,
			{ clouds: true, occluders: true, blackout },
			rand,
			t,
		);
		const frame: TrackFrame = {
			time: t * 1000,
			width: W,
			height: H,
			source: {} as TrackFrame["source"],
			sensor: opts.sensor ? sensorOf(truth(t), t) : undefined,
		};
		tracker.pushFrame(frame);
		await flush();
	}
	await flush();
	return poses;
}

const errorOf = (p: TrackedPose) =>
	rotationErrorDeg(p.pose, truth(p.time / 1000));

describe("tracker", () => {
	it("localises from a biased compass, tracks within 1 degree, and only ever suggests", async () => {
		const current = { img: null as RgbaImage | null };
		const tracker = createTrackerCore({
			horizon: profile,
			vfov: 50,
			workingWidth: W,
			scanner: createCpuScanner(W, () => current.img),
		});
		expect(tracker.phase).toBe("init");
		const poses = await drive(tracker, current, 6);
		expect(tracker.phase).toBe("track");
		expect(poses.every((p) => p.suggestion === true)).toBe(true);
		const tracked = poses.filter((p) => p.phase === "track");
		expect(tracked.length).toBeGreaterThan(poses.length * 0.8);
		const late = tracked
			.filter((p) => p.time > 3000)
			.map(errorOf)
			.sort((a, b) => a - b);
		expect(late[late.length >> 1]).toBeLessThan(0.8);
		expect(late[Math.floor(late.length * 0.9)]).toBeLessThan(1.5);
		expect(tracked.some((p) => p.source === "skyline")).toBe(true);
		tracker.dispose();
	});

	it("works without any sensor (relocalise by skyline search, then constant velocity)", async () => {
		const current = { img: null as RgbaImage | null };
		const tracker = createTrackerCore({
			horizon: profile,
			vfov: 50,
			workingWidth: W,
			scanner: createCpuScanner(W, () => current.img),
		});
		const poses = await drive(tracker, current, 6, { sensor: false });
		const late = poses
			.filter((p) => p.phase === "track" && p.time > 3000)
			.map(errorOf);
		expect(late.length).toBeGreaterThan(30);
		expect(Math.max(...late)).toBeLessThan(2);
	});

	it("goes LOST when the lens is covered under a compass jump, then recovers", async () => {
		const current = { img: null as RgbaImage | null };
		const tracker = createTrackerCore({
			horizon: profile,
			vfov: 50,
			workingWidth: W,
			scanner: createCpuScanner(W, () => current.img),
			tuning: { relocaliseRetrySeconds: 0.5 },
		});
		const poses = await drive(tracker, current, 14, {
			sensor: true,
			blackout: [5, 7],
			compassJump: [5, 1e9, 40],
		});
		expect(poses.some((p) => p.phase === "lost")).toBe(true);
		const end = poses
			.filter((p) => p.time > 11000 && p.phase === "track")
			.map(errorOf);
		expect(end.length).toBeGreaterThan(20);
		expect(Math.max(...end)).toBeLessThan(2);
	});

	it("drops the scan (and emits the propagated pose) when the in-flight budget is full", async () => {
		let resolveScan: (() => void) | null = null;
		const scanner = {
			inFlight: 2,
			scan: () =>
				new Promise<null>((r) => {
					resolveScan = () => r(null);
				}),
			dispose() {},
		};
		const tracker = createTrackerCore({ horizon: profile, vfov: 50, scanner });
		const poses: TrackedPose[] = [];
		tracker.onPose((p) => poses.push(p));
		tracker.pushFrame({
			time: 0,
			width: W,
			height: H,
			source: {} as TrackFrame["source"],
			sensor: { time: 0, yaw: 100, pitch: 3, roll: 0 },
		});
		// INIT with a compass heading: the raw sensor pose is shown at once, synchronously
		expect(poses).toHaveLength(1);
		expect(poses[0].source).toBe("sensor");
		expect(poses[0].phase).toBe("init");
		expect(resolveScan).toBeNull();
	});

	it("reset returns to INIT and dispose silences listeners", async () => {
		const current = { img: null as RgbaImage | null };
		const tracker = createTrackerCore({
			horizon: profile,
			vfov: 50,
			workingWidth: W,
			scanner: createCpuScanner(W, () => current.img),
		});
		await drive(tracker, current, 3);
		expect(tracker.phase).toBe("track");
		tracker.reset();
		expect(tracker.phase).toBe("init");
		let n = 0;
		tracker.onPose(() => n++);
		tracker.dispose();
		tracker.pushFrame({
			time: 1,
			width: W,
			height: H,
			source: {} as TrackFrame["source"],
		});
		await flush();
		expect(n).toBe(0);
	});
});

describe("createTracker (live wrapper)", () => {
	it("is sensor-only until the horizon loads from the eye, then tracks; yawOffset applies", async () => {
		const current = { img: null as RgbaImage | null };
		let loads = 0;
		const tracker = createTracker({
			eye: { lat: 46.7, lon: 7.8, accuracy: 10, time: 0 },
			vfov: 50,
			yawOffset: 5,
			workingWidth: W,
			readPixels: () => current.img,
			loadHorizon: async () => {
				loads++;
				return profile;
			},
		});
		const poses: TrackedPose[] = [];
		tracker.onPose((p) => poses.push(p));
		current.img = renderFrame(profile, truth(0), W, H, {}, rng(1));
		tracker.pushFrame({
			time: 0,
			width: W,
			height: H,
			source: {} as TrackFrame["source"],
			sensor: { time: 0, yaw: 100, pitch: 3, roll: 0 },
		});
		expect(poses[0].pose.yaw).toBeCloseTo(105, 6);
		expect(poses[0].phase).toBe("init");
		await flush();
		await flush();
		expect(loads).toBe(1);
		// relative-only heading is shown before the horizon is ready too
		const p2 = createTracker({
			eye: { lat: 0, lon: 0, accuracy: 1, time: 0 },
			vfov: 50,
			loadHorizon: () => new Promise(() => {}),
		});
		const got: TrackedPose[] = [];
		p2.onPose((p) => got.push(p));
		p2.pushFrame({
			time: 0,
			width: W,
			height: H,
			source: {} as TrackFrame["source"],
			sensor: { time: 0, yaw: null, yawRelative: 30, pitch: 0, roll: 0 },
		});
		expect(got[0].pose.yaw).toBeCloseTo(30, 6);
		tracker.dispose();
		p2.dispose();
	});
});
