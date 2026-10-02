// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	type CameraX,
	IDENTITY_INTRINSICS,
	projectX,
	type Vec3,
} from "../../../concord/core";
import { DEG } from "../../../geodesy";
import {
	basisPx,
	cueResidualPx,
	focalPx1600,
	horizonEl,
	type JointCue,
} from "../joint-residual";

const cam: CameraX = {
	pose: { yaw: 20, pitch: 3, roll: 0, vfov: 40 },
	eye: [0, 0, 0],
	aspect: 1.5,
	intr: { ...IDENTITY_INTRINSICS },
};

describe("basisPx / focalPx1600", () => {
	it("long side is 1600 for landscape and portrait", () => {
		expect(basisPx(2)).toEqual({ W: 1600, H: 800 });
		expect(basisPx(0.5)).toEqual({ W: 800, H: 1600 });
		expect(basisPx(1)).toEqual({ W: 1600, H: 1600 });
	});
	it("matches the pinhole relation and scales with fScale", () => {
		const f = focalPx1600(cam);
		expect(f).toBeCloseTo(1600 / 1.5 / 2 / Math.tan(20 * DEG), 9);
		const f2 = focalPx1600({ ...cam, intr: { ...cam.intr, fScale: 1.25 } });
		expect(f2 / f).toBeCloseTo(1.25, 12);
	});
});

describe("horizonEl", () => {
	const h = {
		step: 1,
		elevation: Float64Array.from({ length: 360 }, (_, i) => i / 10),
	};
	it("interpolates linearly and wraps the azimuth", () => {
		expect(horizonEl(h, 10)).toBeCloseTo(1, 12);
		expect(horizonEl(h, 10.5)).toBeCloseTo(1.05, 12);
		expect(horizonEl(h, 370)).toBeCloseTo(1, 12);
		expect(horizonEl(h, -350)).toBeCloseTo(1, 12);
		// last bin interpolates toward bin 0 across the seam
		expect(horizonEl(h, 359.5)).toBeCloseTo((35.9 + 0) / 2, 12);
	});
	it("is NaN when either neighbouring bin has no data (<= -89)", () => {
		const g = {
			step: 1,
			elevation: Float64Array.from({ length: 360 }, (_, i) =>
				i === 5 ? -90 : 1,
			),
		};
		expect(Number.isNaN(horizonEl(g, 5))).toBe(true);
		expect(Number.isNaN(horizonEl(g, 4.5))).toBe(true);
		expect(Number.isNaN(horizonEl(g, 6.5))).toBe(false);
	});
});

describe("cueResidualPx", () => {
	const world: Vec3 = [300, 800, 60];
	const q = projectX(cam, world) as { u: number; v: number };
	const { W, H } = basisPx(cam.aspect);

	it("point: zero at the projection, (dx, dy) in px @1600 otherwise", () => {
		const c: JointCue = {
			kind: "point",
			u: q.u,
			v: q.v,
			world,
			depthM: 800,
			sigmaPx: 2,
			source: "a",
		};
		for (const r of cueResidualPx(cam, c))
			expect(Math.abs(r)).toBeLessThan(1e-9);
		const off = cueResidualPx(cam, { ...c, u: q.u - 5 / W, v: q.v + 3 / H });
		expect(off[0]).toBeCloseTo(5, 9);
		expect(off[1]).toBeCloseTo(-3, 9);
	});

	it("point/edge: NaN for a world point behind the camera", () => {
		const behind: Vec3 = [-300, -800, 0];
		const p: JointCue = {
			kind: "point",
			u: 0.5,
			v: 0.5,
			world: behind,
			depthM: 800,
			sigmaPx: 2,
			source: "a",
		};
		expect(cueResidualPx(cam, p).every(Number.isNaN)).toBe(true);
		const e: JointCue = {
			kind: "edge",
			u: 0.5,
			v: 0.5,
			nu: 1,
			nv: 0,
			world: behind,
			depthM: 800,
			sigmaPx: 2,
			source: "a",
		};
		expect(cueResidualPx(cam, e).every(Number.isNaN)).toBe(true);
	});

	it("edge: only the along-normal component counts, minus the bias; residualPx moves the observed edge", () => {
		const c: JointCue = {
			kind: "edge",
			u: q.u,
			v: q.v,
			nu: 0,
			nv: 1,
			world,
			depthM: 800,
			sigmaPx: 1,
			source: "a",
			residualPx: 0,
		};
		expect(cueResidualPx(cam, c)[0]).toBeCloseTo(0, 9);
		// the predicted point is displaced 4 px along the normal from the observed edge
		const shifted = { ...c, u: q.u + 10 / W, residualPx: 0 };
		expect(Math.abs(cueResidualPx(cam, shifted)[0])).toBeLessThan(1e-9); // tangential shift ignored
		expect(cueResidualPx(cam, c, 1.5)[0]).toBeCloseTo(-1.5, 9);
		// observed edge = (u, v) - residualPx * n: with residualPx = 4 the observed edge is 4 px above
		const r4 = cueResidualPx(cam, { ...c, residualPx: 4 })[0];
		expect(r4).toBeCloseTo(4, 9);
	});

	it("level: elevation difference times focal, preferring the cue's world point when given", () => {
		const elTrue = Math.atan2(world[2], Math.hypot(world[0], world[1])) / DEG;
		const c: JointCue = {
			kind: "level",
			u: q.u,
			v: q.v,
			el: elTrue,
			depthM: 800,
			sigmaPx: 2,
			source: "a",
		};
		expect(Math.abs(cueResidualPx(cam, c)[0])).toBeLessThan(1e-9);
		const r = cueResidualPx(cam, { ...c, el: elTrue - 0.1 })[0];
		expect(r).toBeCloseTo(focalPx1600(cam) * 0.1 * DEG, 9);
		// world overrides el
		expect(
			Math.abs(cueResidualPx(cam, { ...c, el: 99, world })[0]),
		).toBeLessThan(1e-9);
	});

	describe("shore", () => {
		const lakeZ = -12;
		// ground-plane shore at north = 150 m: signed distance grows to the north
		const shoreDist = (_e: number, n: number) => n - 150;
		const cue = (n: number, extra: Partial<JointCue> = {}): JointCue => {
			const p = projectX(cam, [0, n, lakeZ]) as { u: number; v: number };
			return {
				kind: "shore",
				u: p.u,
				v: p.v,
				lakeM: lakeZ,
				shoreDist,
				depthM: n,
				sigmaPx: 2,
				source: "a",
				...extra,
			} as JointCue;
		};
		it("is NaN without a lake level (no world, no frame)", () => {
			expect(cueResidualPx(cam, cue(150))[0]).toBeNaN();
		});
		it("is ~0 on the shore and signed (px to the predicted shore) off it, with a world point", () => {
			const w = (n: number): Vec3 => [0, n, lakeZ];
			expect(
				Math.abs(cueResidualPx(cam, cue(150, { world: w(150) }))[0]),
			).toBeLessThan(1e-3);
			const far = cueResidualPx(cam, cue(200, { world: w(200) }))[0];
			const near = cueResidualPx(cam, cue(100, { world: w(100) }))[0];
			expect(far).toBeGreaterThan(0);
			expect(near).toBeLessThan(0);
		});
		it("uses frame (alt0, rEff) to place the lake plane when no world point is given", () => {
			// alt0 = 0, tiny curvature drop: lz ~ lakeM
			const r = cueResidualPx(cam, cue(150), 0, { alt0: 0, rEff: 1e12 });
			expect(Math.abs(r[0])).toBeLessThan(1e-3);
		});
		it("is NaN when the pixel looks at or above the horizon (never hits the lake plane)", () => {
			const up: JointCue = {
				kind: "shore",
				u: 0.5,
				v: 0.05,
				lakeM: lakeZ,
				shoreDist,
				depthM: 500,
				sigmaPx: 2,
				source: "a",
				world: [0, 100, lakeZ],
			};
			expect(cueResidualPx(cam, up)[0]).toBeNaN();
		});
	});
});
