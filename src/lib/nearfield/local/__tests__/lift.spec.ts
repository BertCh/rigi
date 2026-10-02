// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import { PROVENANCE_CODE } from "../../types";
import {
	LIFT_RECORD_WORDS,
	type LiftInput,
	liftGaussiansCpu,
	liftGrid,
	liftRecordsCpu,
} from "../lift";
import { LIFT_PRM } from "../lift-gpu";

function plane(
	W: number,
	H: number,
	z: number,
	normal?: [number, number, number],
): LiftInput {
	const n = W * H;
	const nrm = normal ? new Float32Array(3 * n) : null;
	if (nrm && normal) for (let k = 0; k < n; k++) nrm.set(normal, 3 * k);
	const rgba = new Uint8Array(4 * n);
	for (let k = 0; k < n; k++) rgba.set([10, 20, 30, 255], 4 * k);
	return {
		width: W,
		height: H,
		depth: new Float32Array(n).fill(z),
		valid: new Uint8Array(n).fill(1),
		normal: nrm,
		rgba,
		K: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 },
	};
}

describe("liftGaussiansCpu (splat.py lift_gaussians)", () => {
	it("one camera-frame Gaussian per stride cell, on the cell centre's ray", () => {
		const inp = plane(8, 6, 4);
		const c = liftGaussiansCpu(inp, { stride: 2 });
		expect(c.count).toBe(liftGrid(8, 6, 2).cells);
		expect(c.frame).toBe("camera");
		expect(c.provenance.every((p) => p === PROVENANCE_CODE.reconstructed)).toBe(
			true,
		);
		// cell (0, 0): centre pixel (1, 1) → u = 1.5 px; fx = 8 px, cx = 4 px
		expect(c.positions[0]).toBeCloseTo(((1.5 - 4) / 8) * 4, 6);
		expect(c.positions[1]).toBeCloseTo(((1.5 - 3) / 6) * 4, 6);
		expect(c.positions[2]).toBe(4);
		// isotropic without normals: σ = 0.6 · stride · z / mean(fx, fy)
		const sig = (0.6 * 2 * 4) / 7;
		for (let a = 0; a < 3; a++) expect(c.scales[a]).toBeCloseTo(sig, 6);
		expect(Array.from(c.rotations.subarray(0, 4))).toEqual([1, 0, 0, 0]);
		expect(Array.from(c.colors.subarray(0, 4))).toEqual([10, 20, 30, 255]);
	});

	it("drops invalid cells and flying pixels at depth edges", () => {
		const inp = plane(16, 4, 10);
		for (let y = 0; y < 4; y++)
			for (let x = 8; x < 16; x++) inp.depth[y * 16 + x] = 2;
		inp.valid[1 * 16 + 1] = 0;
		const kept = liftGaussiansCpu(inp, { stride: 2 }).count;
		// 8 × 2 cells; the invalid one and the two columns either side of the step go
		expect(kept).toBe(16 - 1 - 2 * 2 + 0);
		expect(liftGaussiansCpu(inp, { stride: 2, edgeRatio: 0 }).count).toBe(15);
	});

	it("a normal facing the camera gives a flat disc; a grazing one is stretched (≤ maxStretch)", () => {
		const facing = liftGaussiansCpu(plane(2, 2, 5, [0, 0, -1]), { stride: 2 });
		const [sx, sy, sz] = facing.scales;
		expect(sz).toBeCloseTo(0.15 * sy, 6);
		expect(sx).toBeGreaterThanOrEqual(sy);
		const grazing = liftGaussiansCpu(plane(2, 2, 5, [1, 0, 0]), { stride: 2 });
		expect(grazing.scales[0] / grazing.scales[1]).toBeCloseTo(4, 3);
		// unit quaternions
		const q = grazing.rotations;
		expect(Math.hypot(q[0], q[1], q[2], q[3])).toBeCloseTo(1, 6);
	});

	it("colour is the block mean (rounded), alpha 255", () => {
		const inp = plane(2, 2, 3);
		inp.rgba.set([0, 0, 0, 255, 1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255]);
		const c = liftGaussiansCpu(inp, { stride: 2 });
		expect(Array.from(c.colors)).toEqual([2, 2, 2, 255]);
	});

	it("records are row-major with a kept flag; the cloud compacts them in order", () => {
		const r = seededRandom(5);
		const inp = plane(12, 10, 6);
		for (let k = 0; k < 120; k++) inp.valid[k] = r() > 0.3 ? 1 : 0;
		const { grid, records } = liftRecordsCpu(inp, { stride: 2 });
		const u = new Uint32Array(records.buffer);
		const kept: number[] = [];
		for (let c = 0; c < grid.cells; c++)
			if (u[c * LIFT_RECORD_WORDS + 11]) kept.push(c);
		const cloud = liftGaussiansCpu(inp, { stride: 2 });
		expect(cloud.count).toBe(kept.length);
		for (const [i, c] of kept.entries())
			expect(cloud.positions[3 * i + 2]).toBe(
				records[c * LIFT_RECORD_WORDS + 2],
			);
	});

	it("the GPU parameter block packs to whole 16-byte rows", () => {
		expect(LIFT_PRM.byteLength).toBe(64);
		expect(LIFT_PRM.offsetOf("cy")).toBe(13);
	});
});
