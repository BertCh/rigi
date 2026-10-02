// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { gridDemRange } from "../geom";
import {
	cellAt,
	groundObjects,
	isFarComponent,
	placedDepth,
	placedRange,
	promoteFarObjects,
} from "../ground";
import { type NearFieldDepth, PixelClass, type SplitResult } from "../types";

const K = { fx: 1e6, fy: 1e6, cx: 0.5, cy: 0.5 }; // ray length == z
const identity = { scale: 1, shift: 0 };

type Cell = { cls: PixelClass; z: number; dem: number };

function build(W: number, H: number, f: (i: number, j: number) => Cell) {
	const depth = new Float32Array(W * H);
	const valid = new Uint8Array(W * H);
	const cls = new Uint8Array(W * H);
	const dem = new Float32Array(W * H).fill(Number.NaN);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const c = f(i, j);
			const k = j * W + i;
			cls[k] = c.cls;
			depth[k] = c.z;
			valid[k] = c.z > 0 ? 1 : 0;
			dem[k] = c.dem > 0 ? c.dem : Number.NaN;
		}
	const d: NearFieldDepth = {
		width: W,
		height: H,
		depth,
		valid,
		model: "t",
		seconds: 0,
	};
	const counts = [0, 0, 0, 0, 0];
	for (const c of cls) counts[c]++;
	const split: SplitResult = { width: W, height: H, cls, counts };
	return { depth: d, split, demAt: gridDemRange(dem, W, H) };
}

/** Terrain at 30 m everywhere; a person (model depth 25 m, wrong by 1.2) standing in columns 15..24, rows 8..19. */
function personScene(
	opts: { objZ?: (j: number) => number; cols?: [number, number] } = {},
) {
	const [c0, c1] = opts.cols ?? [15, 24];
	return build(40, 40, (i, j) => {
		if (i >= c0 && i <= c1 && j >= 8 && j <= 19)
			return {
				cls: PixelClass.Object,
				z: opts.objZ ? opts.objZ(j) : 25,
				dem: 100,
			};
		return { cls: PixelClass.Terrain, z: 30, dem: 30 };
	});
}

describe("groundObjects", () => {
	it("scales a standing object by DEM range / model ray at its contacts", () => {
		const { depth, split, demAt } = personScene();
		const g = groundObjects(depth, split, identity, demAt, K);
		expect(g.components).toHaveLength(1);
		const c = g.components[0];
		expect(c.cells).toBe(10 * 12);
		expect(c.bbox).toEqual([15, 8, 24, 19]);
		expect(c.contacts).toBe(10);
		expect(c.factor).toBeCloseTo(30 / 25, 5);
		expect(c.contactDem).toBeCloseTo(30, 4);
		expect(c.contactModel).toBeCloseTo(25, 4);
		expect(c.recede).toBeCloseTo(1, 5);
		expect(g.dropped).toBeNull();
		expect(g.split).toBe(split);
		expect(g.labels[10 * 40 + 20]).toBe(0);
		expect(g.labels[0]).toBe(-1);
	});
	it("placedRange / placedDepth use the factor for object cells and the curve elsewhere", () => {
		const { depth, split, demAt } = personScene();
		const g = groundObjects(depth, split, identity, demAt, K);
		const kObj = 10 * 40 + 20;
		expect(placedRange(g, identity, kObj, 25)).toBeCloseTo(30, 4);
		expect(placedRange(g, { scale: 2, shift: 1 }, 0, 25)).toBe(51);
		expect(placedRange(null, identity, 5, 25)).toBe(25);
		expect(placedRange(g, identity, -1, 25)).toBe(25);
		const pd = placedDepth(depth, g, identity, K);
		expect(pd.model).toBe("t+placed");
		expect(pd.depth[kObj]).toBeCloseTo(30, 3);
		expect(pd.depth[0]).toBeCloseTo(30, 3);
		depth.valid[3] = 0;
		expect(placedDepth(depth, g, identity, K).depth[3]).toBeNaN();
	});
	it("an object with no terrain contact keeps the curve (factor null)", () => {
		// floating: terrain below is far deeper than the object, so continuity fails
		const { depth, split, demAt } = build(40, 40, (i, j) =>
			i >= 15 && i <= 24 && j >= 8 && j <= 19
				? { cls: PixelClass.Object, z: 5, dem: 100 }
				: { cls: PixelClass.Terrain, z: 30, dem: 30 },
		);
		const g = groundObjects(depth, split, identity, demAt, K);
		expect(g.components[0].contacts).toBe(0);
		expect(g.components[0].factor).toBeNull();
		expect(placedRange(g, identity, 10 * 40 + 20, 5)).toBe(5);
	});
	it("components that touch the frame bottom have no ground below and stay curve-placed", () => {
		const { depth, split, demAt } = build(20, 20, (_i, j) =>
			j >= 8
				? { cls: PixelClass.Object, z: 10, dem: 50 }
				: { cls: PixelClass.Terrain, z: 30, dem: 30 },
		);
		expect(
			groundObjects(depth, split, identity, demAt, K).components[0].factor,
		).toBeNull();
	});
	it("tiny components are listed but never grounded", () => {
		const { depth, split, demAt } = personScene({ cols: [20, 21] }); // 2x12 = 24 cells
		const small = groundObjects(depth, split, identity, demAt, K, {
			minPixels: 100,
		});
		expect(small.components[0].factor).toBeNull();
		expect(small.components[0].contacts).toBe(0);
	});
	it("splits components where model depth jumps and labels them separately", () => {
		const { depth, split, demAt } = build(40, 40, (i, j) => {
			if (j >= 8 && j <= 19 && i >= 5 && i <= 24)
				return { cls: PixelClass.Object, z: i < 15 ? 10 : 25, dem: 100 };
			return { cls: PixelClass.Terrain, z: 30, dem: 30 };
		});
		const g = groundObjects(depth, split, identity, demAt, K);
		expect(g.components).toHaveLength(2);
		expect(g.labels[10 * 40 + 6]).not.toBe(g.labels[10 * 40 + 20]);
	});
	it("reclassifies receding terrain bands (top far, bottom near) as Terrain", () => {
		// 12 rows going from 50 m (top) to 10 m (bottom): recede 5
		const { depth, split, demAt } = personScene({
			objZ: (j) => 10 * 5 ** ((19 - j) / 11),
		});
		const g = groundObjects(depth, split, identity, demAt, K);
		expect(g.components[0].dropped).toBe("notUpright");
		expect(g.components[0].recede).toBeGreaterThan(2);
		expect(g.dropped?.[10 * 40 + 20]).toBe(1);
		expect(g.split).not.toBe(split);
		expect(g.split.cls[10 * 40 + 20]).toBe(PixelClass.Terrain);
		expect(g.split.counts[PixelClass.Object]).toBe(0);
		expect(split.cls[10 * 40 + 20]).toBe(PixelClass.Object); // input untouched
		expect(g.labels[10 * 40 + 20]).toBe(-1);
		// disabled: kept
		const kept = groundObjects(depth, split, identity, demAt, K, {
			upright: 0,
		});
		expect(kept.components[0].dropped).toBeUndefined();
	});
	it("throws on mismatched grids", () => {
		const a = personScene();
		const b = build(10, 10, () => ({ cls: PixelClass.Terrain, z: 1, dem: 1 }));
		expect(() =>
			groundObjects(a.depth, b.split, identity, a.demAt, K),
		).toThrow();
	});
});

describe("cellAt", () => {
	it("maps and clamps normalised coords", () => {
		const g = { width: 10, height: 4 };
		expect(cellAt(g, 0, 0)).toBe(0);
		expect(cellAt(g, 0.55, 0.3)).toBe(1 * 10 + 5);
		expect(cellAt(g, 5, 5)).toBe(3 * 10 + 9);
		expect(cellAt(g, -1, -1)).toBe(0);
	});
});

describe("promoteFarObjects", () => {
	const splitP = { objectMargin: 0.5, nearRadius: 150, minGapM: 3 };
	/** Sky above row 10; a 4-wide, 20-tall far tree at 300 m in front of 1200 m terrain; 300 m terrain from row 30. */
	function treeScene(treeZ: (j: number) => number = () => 300) {
		return build(40, 40, (i, j) => {
			if (j < 10) return { cls: PixelClass.Sky, z: 0, dem: 0 };
			if (i >= 18 && i <= 21 && j < 30)
				return { cls: PixelClass.Far, z: treeZ(j), dem: 1200 };
			return { cls: PixelClass.Terrain, z: 300, dem: 300 };
		});
	}
	it("promotes a skyline tree standing in front of far terrain and places it at the contact range", () => {
		const { depth, split, demAt } = treeScene();
		const g0 = groundObjects(depth, split, identity, demAt, K);
		const g = promoteFarObjects(depth, g0, identity, demAt, K, splitP);
		expect(g).not.toBe(g0);
		const far = g.components.at(-1);
		expect(isFarComponent(far)).toBe(true);
		expect(far?.cells).toBe(4 * 20);
		expect(far?.factor).toBeCloseTo(1, 5);
		expect((far as unknown as { skyline: boolean }).skyline).toBe(true);
		expect((far as unknown as { demRatio: number }).demRatio).toBeCloseTo(4, 3);
		expect(g.split.cls[20 * 40 + 19]).toBe(PixelClass.Object);
		expect(g.labels[20 * 40 + 19]).toBe(far?.id);
		expect(g.split.counts[PixelClass.Object]).toBe(80);
		expect(g.split.counts[PixelClass.Far]).toBe(0);
		expect(split.cls[20 * 40 + 19]).toBe(PixelClass.Far); // input unchanged
		expect(isFarComponent(g0.components[0])).toBe(false);
	});
	it("leaves receding bands, tiny blobs and a too-small farRadius alone", () => {
		const reced = treeScene((j) => 300 * 2 ** ((29 - j) / 19));
		const g0 = groundObjects(
			reced.depth,
			reced.split,
			identity,
			reced.demAt,
			K,
		);
		expect(
			promoteFarObjects(reced.depth, g0, identity, reced.demAt, K, splitP),
		).toBe(g0);
		const t = treeScene();
		const g1 = groundObjects(t.depth, t.split, identity, t.demAt, K);
		expect(
			promoteFarObjects(t.depth, g1, identity, t.demAt, K, splitP, {
				minPixels: 500,
			}),
		).toBe(g1);
		expect(
			promoteFarObjects(t.depth, g1, identity, t.demAt, K, splitP, {
				farRadius: 100,
			}),
		).toBe(g1);
		expect(
			promoteFarObjects(t.depth, g1, identity, t.demAt, K, splitP, {
				farRadius: 250,
			}),
		).toBe(g1);
	});
	it("does not promote when nothing stands out from the DEM behind", () => {
		// DEM behind equals the tree range: not in front of the terrain
		const { depth, split, demAt } = build(40, 40, (i, j) => {
			if (j < 10) return { cls: PixelClass.Sky, z: 0, dem: 0 };
			if (i >= 18 && i <= 21 && j < 30)
				return { cls: PixelClass.Far, z: 300, dem: 300 };
			return { cls: PixelClass.Terrain, z: 300, dem: 300 };
		});
		const g0 = groundObjects(depth, split, identity, demAt, K);
		expect(promoteFarObjects(depth, g0, identity, demAt, K, splitP)).toBe(g0);
	});
});
