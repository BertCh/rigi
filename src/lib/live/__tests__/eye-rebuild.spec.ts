// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { EyeFix } from "../contract";
import {
	createRebuildScheduler,
	decideRebuild,
	REBUILD_MIN_INTERVAL_MS,
	type RebuildRequest,
} from "../eye-rebuild";

const fix = (lat: number, lon: number, accuracy = 10): EyeFix => ({
	lat,
	lon,
	accuracy,
	time: 0,
});
const HOME = fix(46.7, 7.8);
// 0.002 deg of latitude is about 222 m; 0.02 about 2.2 km
const NEAR = fix(46.702, 7.8);
const FAR = fix(46.72, 7.8);
const base = { engineEye: HOME, lastRebuildAt: null, inFlight: false, now: 0 };

describe("decideRebuild", () => {
	it("rebuilds after a real move", () => {
		expect(decideRebuild({ ...base, candidate: NEAR }).action).toBe("rebuild");
	});
	it("skips a coarse fix and a fix still near the engine's eye", () => {
		expect(
			decideRebuild({ ...base, candidate: fix(46.702, 7.8, 400) }).action,
		).toBe("skip");
		expect(
			decideRebuild({ ...base, candidate: fix(46.7003, 7.8) }).action,
		).toBe("skip");
	});
	it("waits while one is in flight", () => {
		expect(
			decideRebuild({ ...base, candidate: NEAR, inFlight: true }).action,
		).toBe("wait");
	});
	it("debounces short moves but not moves over 1 km", () => {
		const recent = { ...base, lastRebuildAt: 1000, now: 5000 };
		expect(decideRebuild({ ...recent, candidate: NEAR }).action).toBe("wait");
		expect(decideRebuild({ ...recent, candidate: FAR }).action).toBe("rebuild");
		expect(
			decideRebuild({
				...recent,
				now: 1000 + REBUILD_MIN_INTERVAL_MS,
				candidate: NEAR,
			}).action,
		).toBe("rebuild");
	});
});

describe("createRebuildScheduler", () => {
	const photos = [
		{ lat: 46.7, lon: 7.8, region: "niederhorn" },
		{ lat: 47.4, lon: 8.5, region: "zurich" },
	];
	it("hands out one rebuild at a time and keeps a debounced move for later", () => {
		const s = createRebuildScheduler(HOME, photos);
		expect(s.next(0)).toBeNull();
		s.offer(NEAR);
		const first = s.next(100);
		expect(first).toMatchObject({ regionChanged: false, region: "niederhorn" });
		expect(s.inFlight).toBe(true);
		s.offer(fix(46.704, 7.8));
		expect(s.next(200)).toBeNull();
		s.complete(first as RebuildRequest, 300);
		expect(s.engineEye).toBe(NEAR);
		expect(s.next(400)).toBeNull(); // debounced, still pending
		expect(s.next(300 + REBUILD_MIN_INTERVAL_MS)?.eye.lat).toBe(46.704);
	});
	it("reports a region change", () => {
		const s = createRebuildScheduler(HOME, photos);
		s.offer(fix(47.4, 8.5));
		const r = s.next(0);
		expect(r).toMatchObject({ regionChanged: true, region: "zurich" });
		s.complete(r as RebuildRequest, 10);
		expect(s.region).toBe("zurich");
	});
	it("drops a move that came back and delays the retry after a failure", () => {
		const s = createRebuildScheduler(HOME, photos);
		s.offer(HOME);
		expect(s.next(0)).toBeNull();
		s.offer(NEAR);
		s.next(0);
		s.fail(50);
		expect(s.inFlight).toBe(false);
		s.offer(NEAR);
		expect(s.next(60)).toBeNull();
		expect(s.next(50 + REBUILD_MIN_INTERVAL_MS)).not.toBeNull();
	});
});
