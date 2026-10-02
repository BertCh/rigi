// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import type { Pose } from "#/lib/camera";
import type { Renderer } from "#/lib/renderer";

const scorePose = vi.hoisted(() => vi.fn());
vi.mock("#/lib/align", async (orig) => ({
	...(await orig<typeof import("#/lib/align")>()),
	scorePose,
}));

import { eyeOf, peakPool, skylineOf, skylineScore } from "../engine-access";

const pose = (over: Partial<Pose> = {}): Pose => ({
	yaw: 0,
	pitch: 0,
	roll: 0,
	vfov: 60,
	...over,
});
const engine = (extra: Record<string, unknown> = {}) =>
	({ eye: { x: 1, y: 2, z: 3 }, aspect: 1.5, ...extra }) as unknown as Renderer;

/** ENU unit direction at azimuth (deg from north) and elevation (deg). */
const dir = (az: number, el: number): [number, number, number] => {
	const a = (az * Math.PI) / 180;
	const e = (el * Math.PI) / 180;
	return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
};

describe("eyeOf", () => {
	it("reads the engine eye as a triple", () => {
		expect(eyeOf(engine())).toEqual([1, 2, 3]);
	});
});

describe("skylineScore", () => {
	it("passes the fine score through and is null without internals", () => {
		scorePose.mockReturnValue(0.42);
		const e = engine({ horizonDirs: new Float32Array(3), edge: {} });
		expect(skylineScore(e, pose())).toBe(0.42);
		expect(scorePose).toHaveBeenCalledWith(
			pose(),
			1.5,
			expect.any(Float32Array),
			{},
			true,
			1,
		);
		expect(
			skylineScore(engine({ horizonDirs: new Float32Array(3) }), pose()),
		).toBeNull();
		expect(skylineScore(engine({ edge: {} }), pose())).toBeNull();
	});

	it("is null when scoring throws", () => {
		scorePose.mockImplementation(() => {
			throw new Error("bad edge map");
		});
		expect(
			skylineScore(
				engine({ horizonDirs: new Float32Array(3), edge: {} }),
				pose(),
			),
		).toBeNull();
	});
});

describe("skylineOf", () => {
	const flat = (el: number) => {
		const d: number[] = [];
		for (let az = 0; az < 360; az += 1) d.push(...dir(az, el));
		return new Float32Array(d);
	};

	it("is null without a horizon", () => {
		expect(skylineOf(engine(), pose())).toBeNull();
	});

	it("places a level horizon at the frame centre and a 5 degree one above it", () => {
		const t = Math.tan((30 * Math.PI) / 180);
		const level = skylineOf(
			engine({ horizonDirs: flat(0) }),
			pose(),
			40,
		) as Float32Array;
		const mid = level[20];
		expect(mid).toBeCloseTo(0.5, 2);
		const up = skylineOf(
			engine({ horizonDirs: flat(5) }),
			pose(),
			40,
		) as Float32Array;
		expect(up[20]).toBeCloseTo(0.5 - Math.tan((5 * Math.PI) / 180) / t / 2, 2);
		expect(up[20]).toBeLessThan(mid);
	});

	it("leaves columns without horizon NaN and keeps the highest point per column", () => {
		const dirs = new Float32Array([...dir(0, -5), ...dir(0, 8), ...dir(0, 2)]);
		const out = skylineOf(
			engine({ horizonDirs: dirs }),
			pose(),
			40,
		) as Float32Array;
		const finite = Array.from(out).filter((v) => !Number.isNaN(v));
		expect(finite).toHaveLength(1);
		const t = Math.tan((30 * Math.PI) / 180);
		expect(finite[0]).toBeCloseTo(
			0.5 - Math.tan((8 * Math.PI) / 180) / t / 2,
			2,
		);
		expect(out[0]).toBeNaN();
	});

	it("ignores directions behind the camera and outside the field of view", () => {
		const dirs = new Float32Array([...dir(180, 0), ...dir(60, 0)]);
		const out = skylineOf(
			engine({ horizonDirs: dirs }),
			pose(),
			40,
		) as Float32Array;
		expect(Array.from(out).every(Number.isNaN)).toBe(true);
	});

	it("follows yaw: a horizon bump to the east appears when looking east", () => {
		const dirs = new Float32Array(dir(90, 3));
		expect(
			Array.from(
				skylineOf(
					engine({ horizonDirs: dirs }),
					pose({ yaw: 0 }),
					20,
				) as Float32Array,
			).every(Number.isNaN),
		).toBe(true);
		const east = skylineOf(
			engine({ horizonDirs: dirs }),
			pose({ yaw: 90 }),
			20,
		) as Float32Array;
		expect(Number.isNaN(east[10])).toBe(false);
	});
});

describe("peakPool", () => {
	it("is empty when the engine has no snapped() or when it throws", () => {
		expect(peakPool(engine(), [pose()])).toEqual([]);
		const throwing = engine({
			snapped: () => {
				throw new Error("terrain not ready");
			},
		});
		expect(peakPool(throwing, [pose()])).toEqual([]);
	});

	it("collects named peaks from each pose with a widened field of view, capped at 120 degrees", () => {
		const calls: Pose[] = [];
		const e = engine({
			snapped(p: Pose) {
				calls.push(p);
				return [
					{ name: "Eiger", ele: 3967, prominence: 356, position: [1, 2, 3] },
					{ name: "Jungfrau", position: { x: 4, y: 5, z: 6 } },
					{ ele: 1, position: [0, 0, 0] }, // unnamed: dropped
					{ name: "Nowhere" }, // no position: dropped
				];
			},
		});
		const out = peakPool(e, [pose({ vfov: 40 }), pose({ vfov: 100 })]);
		expect(calls.map((c) => c.vfov)).toEqual([64, 120]);
		expect(out).toHaveLength(4);
		expect(out[0]).toEqual({
			name: "Eiger",
			ele: 3967,
			prominence: 356,
			world: [1, 2, 3],
		});
		expect(out[1]).toEqual({
			name: "Jungfrau",
			ele: null,
			prominence: null,
			world: [4, 5, 6],
		});
	});
});
