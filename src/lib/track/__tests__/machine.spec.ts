// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { TrackStateMachine } from "../machine";

const config = { lostAfterFailures: 3, relocaliseRetrySeconds: 1 };

describe("TrackStateMachine", () => {
	it("starts in INIT, relocalises, then tracks", () => {
		const m = new TrackStateMachine(config);
		expect(m.phase).toBe("init");
		expect(m.shouldRelocalise(0)).toBe(true);
		m.beginRelocalise(0);
		expect(m.shouldRelocalise(5)).toBe(false);
		m.endRelocalise(true);
		expect(m.phase).toBe("track");
		expect(m.shouldRelocalise(100)).toBe(false);
	});

	it("goes LOST after N consecutive bad solves; good and skip frames reset or hold the count", () => {
		const m = new TrackStateMachine(config);
		m.beginRelocalise(0);
		m.endRelocalise(true);
		m.observe("bad");
		m.observe("bad");
		m.observe("skip");
		expect(m.failureCount).toBe(2);
		m.observe("good");
		expect(m.failureCount).toBe(0);
		m.observe("bad");
		m.observe("bad");
		expect(m.phase).toBe("track");
		m.observe("bad");
		expect(m.phase).toBe("lost");
	});

	it("retries relocalisation on the interval while LOST and recovers on acceptance", () => {
		const m = new TrackStateMachine(config);
		m.beginRelocalise(0);
		m.endRelocalise(true);
		for (let i = 0; i < 3; i++) m.observe("bad");
		expect(m.phase).toBe("lost");
		expect(m.shouldRelocalise(0.5)).toBe(false);
		expect(m.shouldRelocalise(1.5)).toBe(true);
		m.beginRelocalise(1.5);
		m.endRelocalise(false);
		expect(m.phase).toBe("lost");
		expect(m.shouldRelocalise(2)).toBe(false);
		expect(m.shouldRelocalise(2.6)).toBe(true);
		m.beginRelocalise(2.6);
		m.endRelocalise(true);
		expect(m.phase).toBe("track");
		expect(m.failureCount).toBe(0);
	});

	it("ignores verdicts outside TRACK and resets to INIT", () => {
		const m = new TrackStateMachine(config);
		for (let i = 0; i < 5; i++) m.observe("bad");
		expect(m.phase).toBe("init");
		m.beginRelocalise(0);
		m.endRelocalise(true);
		m.reset();
		expect(m.phase).toBe("init");
		expect(m.shouldRelocalise(0)).toBe(true);
	});
});
