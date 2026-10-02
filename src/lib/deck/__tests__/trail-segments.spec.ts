// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { distanceM, EnuFrame } from "../../geodesy";
import type { RegionData } from "../../photos";
import { buildTrailSegments, recolorTrailSegments } from "../trail-layer";

const LAT = 46.7;
const LON = 8;
const frame = new EnuFrame(LAT, LON, 1000);
const at = { lat: LAT, lon: LON };
const flat = () => 1000;

const PALETTE: [number, number, number][] = [
	[1, 0, 0],
	[0, 1, 0],
	[0, 0, 1],
	[1, 1, 1],
];

const region = (
	trails: { sac?: string | null; coords: [number, number][] }[],
): RegionData => ({ id: "t", trails }) as unknown as RegionData;

describe("buildTrailSegments", () => {
	// a trail 0.01 degrees of longitude east of the camera (about 760 m)
	const east: [number, number][] = [
		[LON + 0.01, LAT],
		[LON + 0.02, LAT],
	];

	it("densifies to <= 40 m segments", () => {
		const s = buildTrailSegments(
			region([{ sac: "hiking", coords: east }]),
			frame,
			at,
			flat,
			PALETTE,
		);
		const length = distanceM(
			{ lat: LAT, lon: LON + 0.01 },
			{ lat: LAT, lon: LON + 0.02 },
		);
		expect(s.count).toBe(Math.ceil(length / 40));
		expect(s.positions).toHaveLength(s.count * 6);
		expect(s.colors).toHaveLength(s.count * 3);
		expect(s.classes).toHaveLength(s.count);
		expect(s.dist).toHaveLength(s.count * 2);
		for (let i = 0; i < s.count; i++) {
			const len = Math.hypot(
				s.positions[i * 6 + 3] - s.positions[i * 6],
				s.positions[i * 6 + 4] - s.positions[i * 6 + 1],
			);
			expect(len).toBeLessThanOrEqual(40.5);
		}
	});

	it("chains segments end to start and accumulates metres along the trail", () => {
		const s = buildTrailSegments(
			region([{ sac: "hiking", coords: east }]),
			frame,
			at,
			flat,
			PALETTE,
		);
		for (let i = 1; i < s.count; i++) {
			for (let k = 0; k < 3; k++)
				expect(s.positions[i * 6 + k]).toBe(s.positions[(i - 1) * 6 + 3 + k]);
			expect(s.dist![i * 2]).toBe(s.dist![(i - 1) * 2 + 1]);
		}
		expect(s.dist![0]).toBe(0);
		const total = distanceM(
			{ lat: LAT, lon: LON + 0.01 },
			{ lat: LAT, lon: LON + 0.02 },
		);
		expect(s.dist![s.count * 2 - 1]).toBeCloseTo(total, 3);
	});

	it("drapes at DEM + 2 m + 0.06 % of the distance from the camera", () => {
		const s = buildTrailSegments(
			region([{ coords: east }]),
			frame,
			at,
			flat,
			PALETTE,
		);
		const p0 = frame.fromGeo(
			LAT,
			LON + 0.01,
			1000 + 2 + distanceM(at, { lat: LAT, lon: LON + 0.01 }) * 0.0006,
		);
		for (let k = 0; k < 3; k++) expect(s.positions[k]).toBeCloseTo(p0[k], 3);
	});

	it("colours each segment by SAC class from the palette", () => {
		const cases: [string | null | undefined, number][] = [
			["hiking", 0],
			["mountain_hiking", 1],
			["difficult_alpine_hiking", 2],
			[undefined, 3],
		];
		for (const [sac, k] of cases) {
			const s = buildTrailSegments(
				region([{ sac, coords: east }]),
				frame,
				at,
				flat,
				PALETTE,
			);
			expect(new Set(s.classes)).toEqual(new Set([k]));
			expect(Array.from(s.colors.subarray(0, 3))).toEqual(PALETTE[k]);
		}
	});

	it("drops segments whose ends are within 80 m of the camera", () => {
		const near: [number, number][] = [
			[LON, LAT],
			[LON + 0.0004, LAT], // about 30 m
		];
		expect(
			buildTrailSegments(region([{ coords: near }]), frame, at, flat, PALETTE)
				.count,
		).toBe(0);
		// a trail passing through the 80 m disc keeps only its far parts
		const through: [number, number][] = [
			[LON - 0.01, LAT],
			[LON + 0.01, LAT],
		];
		const s = buildTrailSegments(
			region([{ coords: through }]),
			frame,
			at,
			flat,
			PALETTE,
		);
		const full = Math.ceil(
			distanceM({ lat: LAT, lon: LON - 0.01 }, { lat: LAT, lon: LON + 0.01 }) /
				40,
		);
		expect(s.count).toBeGreaterThan(0);
		expect(s.count).toBeLessThan(full);
		for (let i = 0; i < s.count; i++) {
			expect(
				Math.hypot(s.positions[i * 6], s.positions[i * 6 + 1]),
			).toBeGreaterThan(80);
			expect(
				Math.hypot(s.positions[i * 6 + 3], s.positions[i * 6 + 4]),
			).toBeGreaterThan(80);
		}
	});

	it("breaks the chain where the DEM has no height", () => {
		const gap = (_lat: number, lon: number) =>
			lon > LON + 0.0145 && lon < LON + 0.0155 ? null : 1000;
		const s = buildTrailSegments(
			region([{ coords: east }]),
			frame,
			at,
			gap,
			PALETTE,
		);
		const whole = buildTrailSegments(
			region([{ coords: east }]),
			frame,
			at,
			flat,
			PALETTE,
		);
		expect(s.count).toBeLessThan(whole.count);
		// the along-trail counter keeps running over the hole
		expect(s.dist![s.count * 2 - 1]).toBeCloseTo(
			whole.dist![whole.count * 2 - 1],
			3,
		);
	});

	it("handles several trails and an empty region", () => {
		expect(buildTrailSegments(region([]), frame, at, flat, PALETTE).count).toBe(
			0,
		);
		const two = buildTrailSegments(
			region([
				{ sac: "hiking", coords: east },
				{ sac: "alpine_hiking", coords: east },
			]),
			frame,
			at,
			flat,
			PALETTE,
		);
		const one = buildTrailSegments(
			region([{ sac: "hiking", coords: east }]),
			frame,
			at,
			flat,
			PALETTE,
		);
		expect(two.count).toBe(one.count * 2);
		expect(two.dist![one.count * 2]).toBe(0);
	});
});

describe("recolorTrailSegments", () => {
	it("re-colours by class without touching geometry", () => {
		const s = buildTrailSegments(
			region([
				{
					sac: "hiking",
					coords: [
						[LON + 0.01, LAT],
						[LON + 0.012, LAT],
					],
				},
				{
					sac: "alpine_hiking",
					coords: [
						[LON + 0.01, LAT + 0.001],
						[LON + 0.012, LAT + 0.001],
					],
				},
			]),
			frame,
			at,
			flat,
			PALETTE,
		);
		const next: [number, number, number][] = [
			[0.1, 0.2, 0.3],
			[0, 0, 0],
			[0.9, 0.8, 0.7],
			[0.5, 0.5, 0.5],
		];
		const r = recolorTrailSegments(s, next);
		expect(r.positions).toBe(s.positions);
		expect(r.classes).toBe(s.classes);
		expect(r.dist).toBe(s.dist);
		expect(r.count).toBe(s.count);
		expect(
			Array.from(r.colors.subarray(0, 3)).map((v) => +v.toFixed(5)),
		).toEqual([0.1, 0.2, 0.3]);
		expect(Array.from(r.colors.subarray(-3)).map((v) => +v.toFixed(5))).toEqual(
			[0.9, 0.8, 0.7],
		);
		expect(s.colors[0]).toBe(1); // original untouched
	});
});
