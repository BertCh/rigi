// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { destination } from "../../../geodesy";
import type { PhotoMeta } from "../../../photos";
import {
	clusterPhotos,
	groupViewpoints,
	ROLL_LINK_M,
	uploadRolls,
	VIEWPOINT_RADIUS_M,
} from "../../roll";
import {
	clusterPhotosAsync,
	clusterPhotosHashed,
	groupViewpointsFast,
	uploadRollsAsync,
} from "../cluster";
import {
	neighbourPairsBrute,
	neighbourPairsCpu,
	paddedChordKm,
} from "../neighbours";
import { sortGroupsByTime, sortGroupsByTimeCpu } from "../sort";

/** mulberry32: deterministic */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const T0 = Date.parse("2025-08-01T10:00:00Z");
function meta(id: string, o: Partial<PhotoMeta> = {}): PhotoMeta {
	return {
		id,
		src: `${id}.jpg`,
		width: 4000,
		height: 3000,
		takenAt: new Date(T0).toISOString(),
		lat: 46.7,
		lon: 7.7,
		alt: 1500,
		hAccuracy: null,
		heading: 120,
		f35: 26,
		vfov: 55,
		gravity: null,
		pitch: 3,
		roll: -1,
		holding: null,
		region: "x",
		...o,
	} as PhotoMeta;
}

/** Hikes (dense blobs of a few km) around random places, plus a global scatter. */
function scene(seed: number, hikes: number, perHike: number, scatter: number) {
	const r = rng(seed);
	const out: PhotoMeta[] = [];
	const add = (lat: number, lon: number) => {
		const k = out.length;
		out.push(
			meta(`p${k}`, {
				lat,
				lon,
				takenAt: new Date(T0 + Math.floor(r() * 5) * 1000 * 600).toISOString(),
			}),
		);
	};
	for (let h = 0; h < hikes; h++) {
		const lat = (r() - 0.5) * 150;
		const lon = (r() - 0.5) * 360;
		for (let i = 0; i < perHike; i++) {
			const d = destination(lat, lon, r() * 360, r() * r() * 30_000);
			add(d.lat, d.lon);
		}
	}
	for (let i = 0; i < scatter; i++) add((r() - 0.5) * 180, (r() - 0.5) * 360);
	return out;
}

const idsOf = (g: PhotoMeta[][]) => g.map((x) => x.map((m) => m.id));

describe("neighbourPairsCpu (hashed grid) == brute force", () => {
	for (const radius of [250, 15_000, 120_000]) {
		it(`random hikes and scatter at ${radius} m`, () => {
			const ms = scene(radius, 6, 40, 60);
			expect(neighbourPairsCpu(ms, radius)).toEqual(
				neighbourPairsBrute(ms, radius),
			);
		});
	}
	it("handles the antimeridian, the poles, duplicates and NaN", () => {
		const ms: PhotoMeta[] = [];
		const add = (lat: number, lon: number) =>
			ms.push(meta(`q${ms.length}`, { lat, lon }));
		for (let i = 0; i < 12; i++) add(10 + i * 0.01, 179.99 + i * 0.002);
		for (let i = 0; i < 12; i++) add(10 + i * 0.01, -179.99 + i * 0.002);
		for (let i = 0; i < 20; i++) add(89.9 + i * 0.005, i * 23);
		for (let i = 0; i < 20; i++) add(-89.95 + i * 0.002, -i * 31);
		for (let i = 0; i < 6; i++) add(46.7, 7.7); // duplicates
		add(Number.NaN, 5);
		add(5, Number.NaN);
		add(Number.POSITIVE_INFINITY, 0);
		for (const radius of [250, 15_000, 400_000]) {
			expect(neighbourPairsCpu(ms, radius)).toEqual(
				neighbourPairsBrute(ms, radius),
			);
		}
	});
	it("matches brute force for radii above the indexed limit and for tiny inputs", () => {
		const ms = scene(5, 3, 10, 10);
		expect(neighbourPairsCpu(ms, 3_000_000)).toEqual(
			neighbourPairsBrute(ms, 3_000_000),
		);
		expect(neighbourPairsCpu([], 100)).toHaveLength(0);
		expect(neighbourPairsCpu([ms[0]], 100)).toHaveLength(0);
	});
	it("pads the chord above the radius it covers", () => {
		expect(paddedChordKm(250)).toBeGreaterThan(0.25);
	});
});

describe("clusterPhotosAsync == clusterPhotos", () => {
	it("deep-equals on random scenes (CPU twin)", async () => {
		for (const seed of [1, 2, 3]) {
			const ms = scene(seed, 5, 30, 40);
			ms.push(meta("bad", { lat: Number.NaN }));
			const expected = clusterPhotos(ms);
			expect(clusterPhotosHashed(ms)).toEqual(expected);
			expect(await clusterPhotosAsync(ms)).toEqual(expected);
			expect(idsOf(await clusterPhotosAsync(ms, 900))).toEqual(
				idsOf(clusterPhotos(ms, 900)),
			);
		}
		expect(await clusterPhotosAsync([])).toEqual([]);
	});
	it("keeps the size-then-first-member order on ties", async () => {
		const ms = [
			meta("a", { lat: 10, lon: 10 }),
			meta("b", { lat: 20, lon: 20 }),
			meta("c", { lat: 30, lon: 30 }),
		];
		expect(idsOf(await clusterPhotosAsync(ms))).toEqual(
			idsOf(clusterPhotos(ms)),
		);
	});
});

describe("groupViewpointsFast == groupViewpoints", () => {
	it("gives identical viewpoints on bursts, chains and scatter", () => {
		const r = rng(9);
		const ms: PhotoMeta[] = [];
		for (let i = 0; i < 150; i++) {
			// a chain with ~100 m steps so seeds' 250 m disks overlap: first-seed order matters
			const d = destination(46.7, 7.7, 90, i * 100 + r() * 60);
			ms.push(
				meta(`c${i}`, {
					lat: d.lat,
					lon: d.lon,
					takenAt: new Date(T0 + i * 1000).toISOString(),
				}),
			);
		}
		for (let i = 0; i < 40; i++)
			ms.push(meta(`s${i}`, { lat: 46.7 + r() * 0.01, lon: 7.7 + r() * 0.01 }));
		const sorted = [...ms].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
		expect(groupViewpointsFast(sorted)).toEqual(groupViewpoints(sorted));
		expect(VIEWPOINT_RADIUS_M).toBe(250);
	});
});

describe("sortGroupsByTime (CPU)", () => {
	it("equals the makeRoll comparator, stable on ties", async () => {
		const ms = scene(4, 3, 50, 10);
		const groups = clusterPhotos(ms);
		expect(await sortGroupsByTime(groups)).toEqual(sortGroupsByTimeCpu(groups));
		const manual = groups.map((g) =>
			[...g].sort((a, b) => a.takenAt.localeCompare(b.takenAt)),
		);
		expect(sortGroupsByTimeCpu(groups)).toEqual(manual);
	});
});

describe("uploadRollsAsync == uploadRolls", () => {
	it("deep-equals on synthetic uploads (CPU twin)", async () => {
		const ms = scene(11, 5, 60, 30);
		ms.push(meta("bad", { lat: Number.NaN }));
		expect(await uploadRollsAsync(ms)).toEqual(uploadRolls(ms));
	});
	it("deep-equals on one dense hike with bursts", async () => {
		const ms: PhotoMeta[] = [];
		for (let i = 0; i < 80; i++) {
			const d = destination(46.7, 7.7, 45, (i % 8) * 400 + (i % 3) * 5);
			ms.push(
				meta(`b${i}`, {
					lat: d.lat,
					lon: d.lon,
					takenAt: new Date(T0 + ((i * 7) % 50) * 60_000).toISOString(),
				}),
			);
		}
		const rolls = await uploadRollsAsync(ms);
		expect(rolls).toEqual(uploadRolls(ms));
		expect(rolls[0].photos.length).toBe(80);
	});
	it("handles the empty list", async () => {
		expect(await uploadRollsAsync([])).toEqual([]);
		expect(ROLL_LINK_M).toBe(15_000);
	});
});
