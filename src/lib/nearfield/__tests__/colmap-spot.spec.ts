// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { Pose } from "../../camera";
import { spotColmap } from "../roll/colmap-spot";
import { type GaussianCloud, PROVENANCE_CODE } from "../types";

const pose: Pose = { yaw: 30, pitch: -5, roll: 2, vfov: 50 };
const frame = { lat: 46.7, lon: 7.7, h: 0 };

function cloud(prov: number[]): GaussianCloud {
	const n = prov.length;
	return {
		count: n,
		frame: "enu",
		positions: Float32Array.from(prov.flatMap((_, i) => [100 + i, 200, 1900])),
		scales: new Float32Array(3 * n).fill(0.1),
		rotations: Float32Array.from(prov.flatMap(() => [1, 0, 0, 0])),
		colors: new Uint8Array(4 * n).fill(200),
		provenance: Uint8Array.from(prov),
	};
}

describe("spotColmap", () => {
	const views = [
		{
			id: "A",
			pose,
			eye: [110, 220, 1930] as [number, number, number],
			width: 300,
			height: 200,
		},
		{
			id: "B",
			pose,
			eye: [120, 220, 1930] as [number, number, number],
			width: 300,
			height: 200,
			imageName: "b.jpg",
		},
	];
	it("writes one PINHOLE camera and one image per view, camera centres shifted by origin", () => {
		const m = spotColmap(views, null, [100, 200, 1900], frame);
		const cams = m["cameras.txt"]
			.split("\n")
			.filter((l) => l && !l.startsWith("#"));
		expect(cams).toHaveLength(2);
		expect(cams[0]).toMatch(/^1 PINHOLE 300 200 /);
		expect(m["cameras.txt"]).toContain("# Number of cameras: 2");
		const imgs = m["images.txt"]
			.split("\n")
			.filter((l) => l && !l.startsWith("#"));
		expect(imgs).toHaveLength(2);
		expect(imgs[0]).toMatch(/ 1 A\.png$/);
		expect(imgs[1]).toMatch(/ 2 b\.jpg$/);
		const q = imgs[0].split(" ").slice(1, 8).map(Number);
		const [qw, qx, qy, qz] = q;
		const R = [
			1 - 2 * (qy * qy + qz * qz),
			2 * (qx * qy - qw * qz),
			2 * (qx * qz + qw * qy),
			2 * (qx * qy + qw * qz),
			1 - 2 * (qx * qx + qz * qz),
			2 * (qy * qz - qw * qx),
			2 * (qx * qz - qw * qy),
			2 * (qy * qz + qw * qx),
			1 - 2 * (qx * qx + qy * qy),
		];
		const C = [0, 1, 2].map(
			(k) => -(R[k] * q[4] + R[3 + k] * q[5] + R[6 + k] * q[6]),
		);
		expect(C[0]).toBeCloseTo(10, 5);
		expect(C[1]).toBeCloseTo(20, 5);
		expect(C[2]).toBeCloseTo(30, 5);
		expect(m["points3D.txt"]).toContain("Number of points: 0");
		expect(m["images.txt"]).toContain(
			"shifted by -[100.000, 200.000, 1900.000]",
		);
		expect(m.initPly).toBeNull();
		expect(m.origin).toEqual([100, 200, 1900]);
	});
	it("encodes the cloud as an init .ply, excluding generated splats", () => {
		const m = spotColmap(
			views,
			cloud([
				PROVENANCE_CODE.observed,
				PROVENANCE_CODE.generated,
				PROVENANCE_CODE.reconstructed,
			]),
			[100, 200, 1900],
			frame,
		);
		expect(m.initPly).not.toBeNull();
		const head = new TextDecoder().decode(
			new Uint8Array(m.initPly as ArrayBuffer).subarray(0, 400),
		);
		expect(head.startsWith("ply")).toBe(true);
		expect(head).toMatch(/element vertex 2\b/);
		expect(head).toContain("Rigi roll spot init");
	});
	it("an empty cloud gives no ply", () => {
		expect(spotColmap(views, cloud([]), [0, 0, 0], frame).initPly).toBeNull();
	});
});
