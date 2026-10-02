// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { Pose } from "../../../camera";
import { intrinsicsFromPose } from "../../geom";
import { camToEnuMatrix, toEnu } from "../../lift";
import { type GaussianCloud, PROVENANCE_CODE } from "../../types";
import { completePeople } from "../people";

const pose: Pose = { yaw: 40, pitch: -5, roll: 0, vfov: 50 };
const aspect = 4 / 3;
const K = intrinsicsFromPose(pose, aspect);
const eye = { x: 10, y: -3, z: 1900 };
const m = camToEnuMatrix(pose);

/** A front shell of a flat 0.4 m wide, 1.6 m tall board at z = 3 m, plus `strays` splats 1 m behind it. */
function board(strays = 0): GaussianCloud {
	const pos: number[] = [];
	for (let y = -0.8; y <= 0.8; y += 0.01)
		for (let x = -0.2; x <= 0.2; x += 0.01) pos.push(x, y, 3);
	for (let s = 0; s < strays; s++) pos.push(0.15, -0.5 + s * 0.01, 4);
	const n = pos.length / 3;
	const rotations = new Float32Array(4 * n);
	for (let i = 0; i < n; i++) rotations[4 * i] = 1;
	const colors = new Uint8Array(4 * n).fill(200);
	return toEnu(
		{
			count: n,
			frame: "camera",
			positions: Float32Array.from(pos),
			scales: new Float32Array(3 * n).fill(0.006),
			rotations,
			colors,
			provenance: new Uint8Array(n),
		},
		pose,
		eye,
	);
}

/** Camera-frame z of an ENU point. */
function camZ(c: GaussianCloud, i: number): number {
	const dx = c.positions[3 * i] - eye.x;
	const dy = c.positions[3 * i + 1] - eye.y;
	const dz = c.positions[3 * i + 2] - eye.z;
	return m[2] * dx + m[5] * dy + m[8] * dz;
}

const all = () => true;

describe("completePeople", () => {
	it("closes a front shell into a volume behind it, all generated", () => {
		const cloud = board();
		const res = completePeople({ cloud, pose, eye, K, aspect, select: all });
		expect(res.instances).toHaveLength(1);
		expect(res.added.count).toBeGreaterThan(100);
		expect(res.added.frame).toBe("enu");
		for (let i = 0; i < res.added.count; i++) {
			expect(res.added.provenance[i]).toBe(PROVENANCE_CODE.generated);
			// nothing comes in front of the observed front, and the back stays within the thickness cap
			const z = camZ(res.added, i);
			expect(z).toBeGreaterThan(3 - 1e-3);
			expect(z).toBeLessThan(3 + 2 * 0.2 + 0.05);
		}
		// a 0.4 m wide strip: circular cross-section radius 0.2 m, depth ratio 0.7 -> h ~ 0.14 m at the middle
		const h = res.instances[0].maxHalfThicknessM;
		expect(h).toBeGreaterThan(0.1);
		expect(h).toBeLessThan(0.19);
		// the photo-eye view is unchanged: every added splat projects inside the shell's silhouette
		for (let i = 0; i < res.added.count; i++) {
			const dx = res.added.positions[3 * i] - eye.x;
			const dy = res.added.positions[3 * i + 1] - eye.y;
			const dz = res.added.positions[3 * i + 2] - eye.z;
			const x = m[0] * dx + m[3] * dy + m[6] * dz;
			const z = m[2] * dx + m[5] * dy + m[8] * dz;
			expect(Math.abs(x / z)).toBeLessThan(0.21 / 3);
		}
	});

	it("flags observed splats far behind the inferred back as strays", () => {
		const cloud = board(30);
		const res = completePeople({ cloud, pose, eye, K, aspect, select: all });
		expect(res.strays.length).toBeGreaterThan(0);
		for (const i of res.strays) expect(camZ(cloud, i)).toBeGreaterThan(3.5);
	});

	it("does nothing without a mask or selector, and skips tiny instances", () => {
		const cloud = board();
		expect(completePeople({ cloud, pose, eye, K, aspect }).added.count).toBe(0);
		const tiny = completePeople(
			{ cloud, pose, eye, K, aspect, select: all },
			{ minCells: 1e6 },
		);
		expect(tiny.instances).toHaveLength(0);
		expect(tiny.added.count).toBe(0);
	});

	it("uses a learned back surface where the provider gives one", () => {
		const cloud = board();
		const res = completePeople(
			{ cloud, pose, eye, K, aspect, select: all },
			{
				backDepth: (inst) => {
					const out = new Float32Array(inst.gridWidth * inst.gridHeight).fill(
						Number.NaN,
					);
					for (const k of inst.cells) out[k] = 3.3;
					return out;
				},
			},
		);
		// the back sheet now sits at 3.3 m (the side seam layers lie between 3 and 3.3)
		let atBack = 0;
		for (let i = 0; i < res.added.count; i++) {
			const z = camZ(res.added, i);
			expect(z).toBeLessThan(3.3 + 1e-3);
			if (Math.abs(z - 3.3) < 1e-3) atBack++;
		}
		expect(atBack).toBeGreaterThan(100);
	});
});
