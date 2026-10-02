// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	followGeometry,
	matchPeaks,
	polarPoint,
	signedDegrees,
	wedgePath,
} from "../swiss/sheet-follow";

const vp = { x: 100, y: 100, yaw: 10, hfov: 60 };
const peaks = [
	{ name: "Niederhorn", x: 150, y: 20 },
	{ name: "Bärenpfad", x: 40, y: 60 },
];

describe("sheet-follow", () => {
	it("polar maths: north is up, east is right", () => {
		expect(polarPoint(0, 0, 0, 10)).toEqual([0, -10]);
		expect(polarPoint(0, 0, 90, 10)).toEqual([10, 0]);
	});

	it("wedge matches the cone path shape", () => {
		const d = wedgePath(100, 100, 0, 90, 100);
		expect(d.startsWith("M100 100L")).toBe(true);
		expect(d).toContain("A100 100 0 0 1");
		expect(d.endsWith("z")).toBe(true);
	});

	it("formats the signed correction with a true minus and one decimal", () => {
		expect(signedDegrees(3.44)).toBe("+3.4");
		expect(signedDegrees(-1)).toBe("−1.0");
		expect(signedDegrees(0.01)).toBe("0.0");
	});

	it("takes the short way round across 0/360", () => {
		const g = followGeometry(
			{ ...vp, yaw: 5 },
			{ guessYaw: 355, guessHfov: 60, names: [] },
			peaks,
			260,
		);
		expect(g.signedDeg).toBe("+10.0");
		expect(g.arc).toContain("0 0 1");
		const h = followGeometry(
			{ ...vp, yaw: 355 },
			{ guessYaw: 5, guessHfov: 60, names: [] },
			peaks,
			260,
		);
		expect(h.signedDeg).toBe("−10.0");
		expect(h.arc).toContain("0 0 0");
	});

	it("puts the arc at 0.42 r and its label outside the arc middle", () => {
		const g = followGeometry(
			vp,
			{ guessYaw: 0, guessHfov: 60, names: [] },
			peaks,
			200,
		);
		const start = polarPoint(100, 100, 0, 84);
		expect(g.arc.startsWith(`M${start[0]} ${start[1]}A84 84`)).toBe(true);
		const dist = Math.hypot(g.arcLabel.x - 100, g.arcLabel.y - 100);
		expect(dist).toBeGreaterThan(84);
		// label bearing is the midpoint of 0 and 10 degrees
		const bearing =
			(Math.atan2(g.arcLabel.x - 100, 100 - g.arcLabel.y) * 180) / Math.PI;
		expect(bearing).toBeCloseTo(5, 0);
	});

	it("matches names exactly, then case and accent-insensitively, once each", () => {
		expect(
			matchPeaks(peaks, ["Niederhorn", "niederhorn", "BARENPFAD", "Nope"]).map(
				(p) => p.name,
			),
		).toEqual(["Niederhorn", "Bärenpfad"]);
		const g = followGeometry(
			vp,
			{ guessYaw: 0, guessHfov: 60, names: ["bärenpfad"] },
			peaks,
			200,
		);
		expect(g.rays).toEqual([{ name: "Bärenpfad", to: [40, 60] }]);
		expect(g.guessWedge).not.toBe(g.solvedWedge);
	});
});
