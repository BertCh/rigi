// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	BEAT_T0,
	beatAt,
	END,
	poseTime,
	RAMPS,
	ramp,
	T_FINE,
	visualEpoch,
} from "../timeline";

const sample = (t: number) =>
	JSON.stringify([
		beatAt(t),
		poseTime(t) > 0 ? ramp(poseTime(t), RAMPS.pose[0], RAMPS.pose[1]) : 0,
		...Object.values(RAMPS).map(([t0, dur]) => ramp(t, t0, dur)),
	]);

describe("visualEpoch", () => {
	it("identical epochs mean identical visuals", () => {
		const seen = new Map<number, string>();
		for (let t = 0; t <= END; t += 0.01) {
			const e = visualEpoch(t);
			if (e < 0) continue;
			const s = sample(t);
			expect(seen.get(e) ?? s).toBe(s);
			seen.set(e, s);
		}
		expect(seen.size).toBeGreaterThan(3);
	});

	it("is moving during the solve and quiet before the first ramp and at the end", () => {
		expect(visualEpoch(18)).toBe(-1);
		expect(visualEpoch(0)).toBeGreaterThanOrEqual(0);
		expect(visualEpoch(END - 1)).toBe(visualEpoch(END - 0.1));
		expect(visualEpoch(3)).toBeGreaterThanOrEqual(0);
	});

	it("changes epoch at a beat start inside a quiet stretch", () => {
		expect(visualEpoch(BEAT_T0[3] - 0.01)).not.toBe(visualEpoch(BEAT_T0[3]));
	});
});

describe("poseTime", () => {
	it("is constant outside the solve", () => {
		expect(poseTime(3)).toBe(poseTime(15));
		expect(poseTime(T_FINE)).toBe(poseTime(END));
		expect(poseTime(18)).toBe(18);
	});
});
