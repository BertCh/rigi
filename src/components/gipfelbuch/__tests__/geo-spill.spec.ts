// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TafelBake } from "../tafel/useTafelBake";
import { horizonEl, horizonPoints, spillNote } from "../viz/GeoSpill";
import type { PhotoLayer } from "../viz/inks";
import type { GipfelbuchPhotoData } from "../viz/real";
import { poseAt } from "../viz/story";

const DEMO = path.resolve(__dirname, "../../../../public/demo/gipfelbuch");
const read = <T>(file: string) =>
	JSON.parse(fs.readFileSync(path.join(DEMO, file), "utf8")) as T;

/** A bake with only the fields the echo reads. */
const flatBake = (az0: number, el: number[]) =>
	({ horizon: { az0, step: 0.5, el } }) as unknown as TafelBake;

describe("spill horizon", () => {
	it("interpolates the horizon and wraps through north", () => {
		const bake = flatBake(359, [0, 1, 2, 3, 4]);
		expect(horizonEl(bake, 359)).toBe(0);
		expect(horizonEl(bake, 359.75)).toBeCloseTo(1.5);
		expect(horizonEl(bake, 0.25)).toBeCloseTo(2.5);
		expect(horizonEl(bake, 2)).toBeNull();
		expect(horizonEl({} as TafelBake, 0)).toBeNull();
	});

	it("puts a level horizon on the middle row at zero pitch", () => {
		const bake = flatBake(
			0,
			Array.from({ length: 721 }, () => 0),
		);
		const cam = { yaw: 90, pitch: 0, roll: 0, f: 500, hfov: 77 };
		const data = {
			photo: { width: 800, height: 600 },
			prior: cam,
			solved: cam,
		} as unknown as GipfelbuchPhotoData;
		const pts = horizonPoints(bake, data, poseAt(data, 1)) ?? [];
		expect(pts.length).toBeGreaterThan(100);
		for (const [, y] of pts) expect(y).toBeCloseTo(300, 6);
		// never further than the pinhole's safe angle off the axis
		const xs = pts.map((q) => q[0]);
		expect(Math.min(...xs)).toBeGreaterThan(400 - 500 * Math.tan(1.4));
		expect(Math.max(...xs)).toBeLessThan(400 + 500 * Math.tan(1.4));
	});

	// The bake's wide horizon is traced as build-data.ts traces horizon.profile, so at the prior and
	// the solved pose it lies on priorRows / solvedRows: the echo meets the photo's line at the frame.
	it.each([
		"demo-01",
		"demo-07",
		"demo-09",
		"demo-11",
	])("%s: the echo meets priorRows and solvedRows inside the frame", (id) => {
		const data = read<GipfelbuchPhotoData>(`${id}.json`);
		const bake = read<TafelBake>(`tafel/${id}.json`);
		for (const [t, rows] of [
			[0, data.priorRows],
			[1, data.solvedRows],
		] as const) {
			const errs: number[] = [];
			for (const [x, y] of horizonPoints(bake, data, poseAt(data, t)) ?? []) {
				const c = Math.round(x - 0.5);
				const row = rows[c];
				if (row != null) errs.push(Math.abs(y - row));
			}
			errs.sort((a, b) => a - b);
			expect(errs.length).toBeGreaterThan(100);
			expect(errs[errs.length >> 1]).toBeLessThan(0.5);
			expect(errs[Math.floor(errs.length * 0.9)]).toBeLessThan(1.5);
		}
	});
});

describe("spill note", () => {
	const with_ = (...layers: PhotoLayer[]) =>
		spillNote((l) => layers.includes(l));
	it("names what the spill carries", () => {
		expect(with_()).toMatch(/ridges/);
		expect(with_("sky")).toMatch(/sky/);
		expect(with_("skyline")).toMatch(/map's, not the eye's/);
		expect(with_("prior")).toMatch(/guess/);
		expect(with_("prior", "solved", "skyline")).toMatch(/turn/);
	});
});
