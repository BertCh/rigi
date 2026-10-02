// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { focalPxFromF35 } from "../../../camera/focal";
import { lensCorrectedVfov } from "../focal-table";

const W = 4032;
const H = 3024;
const vfovOf = (f: number) => (2 * Math.atan(H / 2 / f) * 180) / Math.PI;

describe("lensCorrectedVfov", () => {
	const fExif = focalPxFromF35(26, { width: W, height: H });
	const photo = { height: H, vfov: vfovOf(fExif), f35: 26 };

	it("scales the focal by the main-lens fScale when LensModel is known", () => {
		const v = lensCorrectedVfov({
			...photo,
			lensModel: "iPhone 11 Pro back triple camera 4.25mm f/1.8",
		});
		expect(v).toBeCloseTo(vfovOf(fExif * 1.0173), 10);
		expect(v).toBeLessThan(photo.vfov);
	});

	it("falls back to the camera Model when LensModel is missing", () => {
		const v = lensCorrectedVfov({ ...photo, model: "iPhone 11 Pro" });
		expect(v).toBeCloseTo(vfovOf(fExif * 1.0173), 10);
	});

	it("leaves uncalibrated or unknown lenses unchanged", () => {
		expect(lensCorrectedVfov(photo)).toBe(photo.vfov);
		expect(lensCorrectedVfov({ ...photo, model: "Pixel 8" })).toBe(photo.vfov);
		expect(
			lensCorrectedVfov({ ...photo, model: "iPhone 11 Pro", f35: 52 }),
		).toBe(photo.vfov);
	});
});
