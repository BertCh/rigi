// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	columnsFromSkyline,
	DEG,
	type HorizonTable,
	horizonTable,
} from "../../refine/model";
import { scanColumnsCpu } from "../skyline-cpu";
import { invert3, solvePose } from "../solve";
import {
	makeRidgeProfile,
	renderFrame,
	rng,
	rotationErrorDeg,
} from "../synthetic";

const pose = { yaw: 200, pitch: 5, roll: 2, vfov: 50 };

function setup(noise = 0.02) {
	const profile = makeRidgeProfile(2);
	const img = renderFrame(
		profile,
		pose,
		320,
		180,
		{ noise, clouds: true, occluders: true },
		rng(4),
		1,
	);
	const scan = scanColumnsCpu(img, 320);
	const cols = columnsFromSkyline({
		rows: scan.rows,
		weight: scan.weights,
		width: 320,
	});
	const geom = {
		width: 320,
		height: scan.height,
		cx: 160,
		cy: scan.height / 2,
		f0: scan.height / 2 / Math.tan((50 * DEG) / 2),
	};
	return { profile, cols, geom, table: horizonTable(profile, 0) };
}
const options = (prior: { yaw: number; pitch: number; roll: number }) => ({
	prior,
	priorSigmaDeg: { yaw: 5, pitch: 3, roll: 3 },
	sigmaPx: 1.2,
	effectiveColumns: 60,
});

describe("solvePose", () => {
	it("inverts a symmetric 3x3", () => {
		const a = [4, 1, 0, 1, 3, 1, 0, 1, 2];
		const inv = invert3(a) as Float64Array;
		const id = [0, 1, 2].map((i) =>
			[0, 1, 2].map((j) =>
				[0, 1, 2].reduce((s, k) => s + a[i * 3 + k] * inv[k * 3 + j], 0),
			),
		);
		expect(id[0][0]).toBeCloseTo(1, 9);
		expect(id[1][0]).toBeCloseTo(0, 9);
		expect(invert3([0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
	});

	it("recovers the pose from a perturbed prior", () => {
		const { cols, geom, table } = setup();
		const r = solvePose(
			table,
			geom,
			cols,
			options({ yaw: 203, pitch: 6, roll: 1 }),
		);
		expect(r).not.toBeNull();
		const solved = { ...(r as NonNullable<typeof r>).angles, vfov: 50 };
		expect(rotationErrorDeg(solved, pose)).toBeLessThan(0.5);
		expect((r as NonNullable<typeof r>).inlierFraction).toBeGreaterThan(0.85);
		expect((r as NonNullable<typeof r>).residualDeg).toBeLessThan(0.3);
	});

	it("stays accurate with a fifth of the columns replaced by outliers", () => {
		const { cols, geom, table } = setup();
		const bad = cols.map((c, i) =>
			i % 5 === 0 ? { ...c, y: c.y - 25 + (i % 3) * 3 } : c,
		);
		const r = solvePose(
			table,
			geom,
			bad,
			options({ yaw: 201, pitch: 5.5, roll: 2.5 }),
		);
		const solved = { ...(r as NonNullable<typeof r>).angles, vfov: 50 };
		expect(rotationErrorDeg(solved, pose)).toBeLessThan(0.7);
	});

	it("reports a bad fit for a wrong horizon", () => {
		const { cols, geom } = setup();
		const other: HorizonTable = horizonTable(makeRidgeProfile(9), 0);
		const r = solvePose(
			other,
			geom,
			cols,
			options({ yaw: 200, pitch: 5, roll: 2 }),
		) as NonNullable<ReturnType<typeof solvePose>>;
		expect(r.inlierFraction).toBeLessThan(0.6);
	});

	it("falls back on the prior along an unobservable axis (flat horizon)", () => {
		const { cols, geom } = setup();
		const flat = makeRidgeProfile(2);
		flat.elevation.fill(3);
		const r = solvePose(
			horizonTable(flat, 0),
			geom,
			cols.map((c) => ({ ...c, y: geom.height / 2 + 5 })),
			options({ yaw: 10, pitch: 3, roll: 0 }),
		) as NonNullable<ReturnType<typeof solvePose>>;
		// yaw has no information: posterior σ stays at the prior's 5 degrees
		expect(r.sigmaDeg.yaw).toBeGreaterThan(4);
		expect(r.sigmaDeg.pitch).toBeLessThan(0.5);
	});

	it("returns null with fewer than three columns", () => {
		const { geom, table } = setup();
		expect(
			solvePose(
				table,
				geom,
				[{ x: 1, y: 2, w: 1 }],
				options({ yaw: 0, pitch: 0, roll: 0 }),
			),
		).toBeNull();
	});
});
