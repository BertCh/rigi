// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import type { HorizonProfile } from "../../geo/horizon";
import { createHorizonWarmer } from "../horizon-warm";

const profile = {} as HorizonProfile;
const fix = (lat: number, lon: number, accuracy = 10) => ({
	lat,
	lon,
	accuracy,
	time: 0,
});

describe("horizon warmer", () => {
	it("starts at the first fix and shares the load with the tracker", async () => {
		const prepare = vi.fn(async () => profile);
		const warmer = createHorizonWarmer({ prepare });
		warmer.offer(fix(46.7, 7.8));
		const loaded = warmer.load(fix(46.7001, 7.8001));
		expect(prepare).toHaveBeenCalledTimes(1);
		await expect(loaded).resolves.toBe(profile);
	});

	it("re-prepares past 100 m and aborts the old load", async () => {
		const signals: AbortSignal[] = [];
		const prepare = vi.fn(async (_eye, signal?: AbortSignal) => {
			if (signal) signals.push(signal);
			return profile;
		});
		const warmer = createHorizonWarmer({ prepare });
		warmer.warm(fix(46.7, 7.8));
		warmer.warm(fix(46.7, 7.8005)); // ~38 m
		expect(prepare).toHaveBeenCalledTimes(1);
		warmer.warm(fix(46.7, 7.802)); // ~155 m
		expect(prepare).toHaveBeenCalledTimes(2);
		expect(signals[0].aborted).toBe(true);
		expect(signals[1].aborted).toBe(false);
	});

	it("ignores coarse fixes after the first, and retries after a failure", async () => {
		let fail = true;
		const prepare = vi.fn(async () => {
			if (fail) throw new Error("tiles");
			return profile;
		});
		const warmer = createHorizonWarmer({ prepare });
		warmer.offer(fix(46.7, 7.8, 500));
		await Promise.resolve();
		await Promise.resolve();
		expect(warmer.anchor).toBeNull();
		fail = false;
		warmer.offer(fix(46.7, 7.8, 500));
		expect(prepare).toHaveBeenCalledTimes(2);
		warmer.offer(fix(47.5, 7.8, 500)); // far but coarse: no re-anchor
		expect(prepare).toHaveBeenCalledTimes(2);
		warmer.offer(fix(47.5, 7.8, 20));
		expect(prepare).toHaveBeenCalledTimes(3);
	});
});
