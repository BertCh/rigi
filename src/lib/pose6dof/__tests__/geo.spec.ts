// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { EnuFrame } from "../../geodesy";
import {
	azimuthCorr,
	cameraFrame,
	dirCorr,
	engineFrame,
	levelCorr,
	pointCorr,
	priorsFromPhoto,
	pxToUV,
} from "../geo";
import { dirFromAzEl } from "../project";

describe("frames", () => {
	it("cameraFrame puts the origin at the eye; engineFrame at h = 0", () => {
		const cf = cameraFrame(46.5, 8.0, 1500);
		const ef = engineFrame(46.5, 8.0);
		expect(cf).toBeInstanceOf(EnuFrame);
		const a = cf.fromGeo(46.5, 8.0, 1500);
		const b = ef.fromGeo(46.5, 8.0, 1500);
		expect(Math.hypot(a[0], a[1], a[2])).toBeLessThan(1e-6);
		expect(b[2]).toBeCloseTo(1500, 6);
	});
});

describe("pxToUV", () => {
	it("normalises by width and by height = width / aspect", () => {
		expect(pxToUV(400, 150, 800, 4 / 3)).toEqual({ u: 0.5, v: 0.25 });
		expect(pxToUV(0, 0, 800, 2)).toEqual({ u: 0, v: 0 });
		expect(pxToUV(800, 400, 800, 2)).toEqual({ u: 1, v: 1 });
	});
});

describe("correspondence builders", () => {
	it("pointCorr converts geodetic to the frame's ENU", () => {
		const f = engineFrame(46.5, 8.0);
		const c = pointCorr(f, 46.5, 8.0 + 0.01, 2000, 0.3, 0.4, "Horn");
		expect(c.kind).toBe("point");
		expect(c.label).toBe("Horn");
		expect(c.u).toBe(0.3);
		expect(c.world[0]).toBeGreaterThan(700);
		expect(c.world[0]).toBeLessThan(800);
		expect(Math.abs(c.world[1])).toBeLessThan(1);
		expect(c.world[2]).toBeGreaterThan(1990);
	});
	it("dirCorr yields a unit az/el direction", () => {
		const c = dirCorr(90, 0, 0.1, 0.2);
		expect(c.kind).toBe("dir");
		expect(c.dir[0]).toBeCloseTo(1, 12);
		expect(Math.hypot(...c.dir)).toBeCloseTo(1, 12);
		expect(c.dir).toEqual(dirFromAzEl(90, 0));
	});
	it("level and azimuth constraints carry their angle", () => {
		expect(levelCorr(2.5, 0.5, 0.5)).toEqual({
			kind: "level",
			u: 0.5,
			v: 0.5,
			el: 2.5,
			label: undefined,
		});
		expect(azimuthCorr(210, 0.1, 0.9, "x")).toMatchObject({
			kind: "azimuth",
			az: 210,
			label: "x",
		});
	});
});

describe("priorsFromPhoto", () => {
	it("applies the documented defaults", () => {
		const p = priorsFromPhoto({ vfov: 40 });
		expect(p.position).toEqual({ value: [0, 0, 0], sigmaH: 15, sigmaV: 22.5 });
		expect(p.yaw).toEqual({ value: 0, sigma: undefined });
		expect(p.pitch.sigma).toBeUndefined();
		expect(p.roll.sigma).toBeUndefined();
		expect(p.vfov.value).toBe(40);
		expect(p.vfov.sigma).toBeCloseTo(1.2, 12);
	});
	it("enforces minimum sigmas for positions", () => {
		const p = priorsFromPhoto({ vfov: 40, hAccuracy: 1 });
		expect(p.position?.sigmaH).toBe(5);
		expect(p.position?.sigmaV).toBe(10);
	});
	it("uses heading/pitch/roll with their sigmas when known", () => {
		const p = priorsFromPhoto({
			vfov: 50,
			hAccuracy: 20,
			heading: 0,
			pitch: 5,
			roll: -1,
		});
		expect(p.yaw).toEqual({ value: 0, sigma: 10 });
		expect(p.pitch).toEqual({ value: 5, sigma: 2 });
		expect(p.roll).toEqual({ value: -1, sigma: 2 });
		expect(p.position?.sigmaV).toBe(30);
	});
	it("treats a null heading, pitch or roll (PhotoMeta) as unknown, not a prior at 0°", () => {
		const p = priorsFromPhoto({
			vfov: 50,
			hAccuracy: null,
			heading: null,
			pitch: null,
			roll: null,
		});
		expect(p.yaw).toEqual({ value: 0, sigma: undefined });
		expect(p.pitch).toEqual({ value: 0, sigma: undefined });
		expect(p.roll).toEqual({ value: 0, sigma: undefined });
		expect(p.position?.sigmaH).toBe(15);
	});
	it("honours overrides and copies the eye", () => {
		const eye = [1, 2, 3];
		const p = priorsFromPhoto(
			{ vfov: 100, heading: 30, pitch: 0, roll: 0 },
			{
				gravitySigma: 0.5,
				compassSigma: 4,
				vfovSigmaFrac: 0.1,
				sigmaV: 7,
				eye,
			},
		);
		expect(p.position?.value).toEqual([1, 2, 3]);
		expect(p.position?.value).not.toBe(eye);
		expect(p.position?.sigmaV).toBe(7);
		expect(p.yaw.sigma).toBe(4);
		expect(p.pitch.sigma).toBe(0.5);
		expect(p.vfov.sigma).toBeCloseTo(10, 12);
	});
});
