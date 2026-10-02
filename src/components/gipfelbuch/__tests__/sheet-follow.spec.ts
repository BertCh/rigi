// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	followGeometry,
	matchPeaks,
	polarPoint,
	signedDegrees,
	wedgePath,
	wrap180,
} from "../swiss/sheet-follow";

const vp = { x: 100, y: 100 };
const solve = (guessYaw: number, solvedYaw: number, names: string[] = []) => ({
	guessYaw,
	guessHfov: 60,
	solvedYaw,
	solvedHfov: 60,
	accepted: true,
	names,
});
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
		const g = followGeometry(vp, solve(355, 5), peaks, 260);
		expect(g.signedDeg).toBe("+10.0");
		expect(g.arc).toContain("0 0 1");
		const h = followGeometry(vp, solve(5, 355), peaks, 260);
		expect(h.signedDeg).toBe("−10.0");
		expect(h.arc).toContain("0 0 0");
	});

	it("puts the arc at 0.42 r and its label outside the arc middle", () => {
		const g = followGeometry(vp, solve(0, 10), peaks, 200);
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
		const g = followGeometry(vp, solve(0, 10, ["bärenpfad"]), peaks, 200);
		expect(g.rays).toEqual([{ name: "Bärenpfad", to: [40, 60] }]);
		expect(g.guessWedge).not.toBe(g.solvedWedge);
	});
});

describe("sheet-follow on the real demo data", () => {
	const root = join(process.cwd(), "public/demo/gipfelbuch");
	const sheet = JSON.parse(
		readFileSync(join(root, "sheet/sheet.json"), "utf8"),
	);
	for (let n = 1; n <= 12; n++) {
		const id = `demo-${String(n).padStart(2, "0")}`;
		const d = JSON.parse(readFileSync(join(root, `${id}.json`), "utf8"));
		const vpt = sheet.viewpoints.find((v: { id: string }) => v.id === id);
		it(`${id}: signed turn equals the page number; rays are logged`, () => {
			expect(vpt).toBeTruthy();
			const names = d.peaks
				.filter(
					(p: { visible: boolean; solved: unknown }) => p.visible && p.solved,
				)
				.map((p: { name: string }) => p.name);
			const g = followGeometry(
				vpt,
				{
					guessYaw: d.prior.yaw,
					guessHfov: d.prior.hfov,
					solvedYaw: d.solved.yaw,
					solvedHfov: d.solved.hfov,
					accepted: d.solved.accepted,
					names,
				},
				sheet.peaks,
				260,
			);
			if (d.solved.accepted) {
				const want = wrap180(d.solved.yaw - d.prior.yaw);
				expect(
					Math.abs(Number(g.signedDeg.replace("−", "-")) - want),
				).toBeLessThan(0.05);
			}
			expect(g.rays.length).toBeLessThanOrEqual(sheet.peaks.length);
			console.info(
				`${id}: ${g.rays.length} rays (accepted ${d.solved.accepted})`,
			);
		});
	}
});
