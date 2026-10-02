// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { expectArrayClose } from "#/test/helpers";
import { buildCameraModel, colmapLines } from "../camera";
import { buildColmapZip, colmapFiles } from "../colmap";
import { buildPoseJson, POSE_SCHEMA, POSE_SCHEMA_VERSION } from "../pose-json";
import { FIXTURE, readZip, SOUTH } from "./fixtures";

describe("buildPoseJson", () => {
	const m = buildCameraModel(FIXTURE);
	const j = buildPoseJson(FIXTURE, { exportedAt: "2026-01-01T00:00:00.000Z" });
	it("tags schema and version", () => {
		expect(j.schema).toBe(POSE_SCHEMA);
		expect(j.version).toBe(POSE_SCHEMA_VERSION);
		expect(j.exportedAt).toBe("2026-01-01T00:00:00.000Z");
	});
	it("survives a JSON round trip unchanged", () => {
		expect(JSON.parse(JSON.stringify(j))).toEqual(j);
	});
	it("defaults exportedAt to a parseable ISO instant", () => {
		const t = buildPoseJson(FIXTURE).exportedAt;
		expect(new Date(t).toISOString()).toBe(t);
	});
	it("records photo and orientation", () => {
		expect(j.photo).toEqual({
			id: "IMG_7131",
			imageName: "IMG_7131.jpg",
			width: 4032,
			height: 3024,
			takenAt: "2023-07-01T10:20:30Z",
		});
		expect(j.orientation.yaw).toBe(20.84);
		expect(j.orientation.vfov).toBeCloseTo(53.06, 6);
	});
	it("takenAt and eyeOffset are null when unknown", () => {
		const s = buildPoseJson(SOUTH);
		expect(s.photo.takenAt).toBeNull();
		expect(s.position.eyeOffset).toBeNull();
		expect(s.position.demAtCamera).toBeNull();
		expect(j.position.demAtCamera).toBe(1350);
	});
	it("keeps intrinsics and K consistent", () => {
		expect(j.intrinsics.K).toHaveLength(9);
		expect(j.intrinsics.fx).toBeCloseTo(m.f, 5);
		expect(j.intrinsics.cx).toBe(m.K[2]);
		expect(j.intrinsics.K[0]).toBeCloseTo(j.intrinsics.fx, 5);
		expect(j.intrinsics.K_opencv[2]).toBe(2015.5);
	});
	it("serialises rotations to 12 decimals, orthonormal", () => {
		const R = j.extrinsics.R_cam2ecef;
		expect(R).toHaveLength(9);
		for (let i = 0; i < 3; i++)
			for (let k = 0; k < 3; k++) {
				const dot =
					R[i * 3] * R[k * 3] +
					R[i * 3 + 1] * R[k * 3 + 1] +
					R[i * 3 + 2] * R[k * 3 + 2];
				expect(dot).toBeCloseTo(i === k ? 1 : 0, 10);
			}
	});
	it("embeds the same COLMAP lines the colmap export uses", () => {
		const col = colmapLines(m);
		expect(j.extrinsics.colmap.camerasTxt).toBe(col.camera);
		expect(j.extrinsics.colmap.imagesTxt).toBe(col.image);
		expect(j.extrinsics.colmap.qvec).toHaveLength(4);
	});
	it("w2c ECEF round trips C", () => {
		const { R, t } = j.extrinsics.opencv_ecef;
		const C = j.extrinsics.C_ecef;
		const rc = [0, 1, 2].map(
			(i) => R[i * 3] * C[0] + R[i * 3 + 1] * C[1] + R[i * 3 + 2] * C[2] + t[i],
		);
		// C is rounded to 0.1 mm and t to 0.1 mm: a few cm of slack at 6.4e6 m radius
		expectArrayClose(rc, [0, 0, 0], 1e-3);
	});
	it("matches a prebuilt model", () => {
		expect(buildPoseJson(m, { exportedAt: j.exportedAt })).toEqual(j);
	});
});

describe("colmapFiles", () => {
	const f = colmapFiles(FIXTURE);
	it("writes one camera and one image", () => {
		const cam = f["cameras.txt"]
			.split("\n")
			.filter((l) => l && !l.startsWith("#"));
		expect(cam).toHaveLength(1);
		expect(cam[0].split(" ")).toHaveLength(8);
	});
	it("emits the POINTS2D line after the image line", () => {
		const lines = f["images.txt"].split("\n");
		const i = lines.findIndex((l) => l.endsWith(" IMG_7131.jpg"));
		expect(i).toBeGreaterThan(0);
		expect(lines[i + 1]).toBe("");
		expect(lines.length).toBeGreaterThan(i + 1);
	});
	it("declares an empty points3D list", () => {
		expect(
			f["points3D.txt"].split("\n").filter((l) => l && !l.startsWith("#")),
		).toEqual([]);
	});
	it("names the world frame in the images header", () => {
		expect(f["images.txt"]).toContain("WGS84 ECEF");
		expect(colmapFiles(FIXTURE, { world: "enu" })["images.txt"]).toContain(
			"ENU frame at lat 46.97",
		);
	});
	it("honours camera and image ids", () => {
		const g = colmapFiles(FIXTURE, { cameraId: 5, imageId: 9 });
		expect(g["cameras.txt"]).toContain("\n5 PINHOLE");
		expect(g["images.txt"]).toMatch(/\n9 .* 5 IMG_7131\.jpg\n/);
	});
	it("accepts a prebuilt model", () => {
		expect(colmapFiles(buildCameraModel(FIXTURE))).toEqual(f);
	});
});

describe("buildColmapZip", () => {
	it("defaults to sparse/0 and carries the three files", () => {
		const z = readZip(buildColmapZip(FIXTURE));
		expect(z.map((e) => e.name)).toEqual([
			"sparse/0/cameras.txt",
			"sparse/0/images.txt",
			"sparse/0/points3D.txt",
		]);
		expect(new TextDecoder().decode(z[0].data)).toBe(
			colmapFiles(FIXTURE)["cameras.txt"],
		);
	});
	it("trims trailing slashes and supports a flat layout", () => {
		expect(readZip(buildColmapZip(FIXTURE, { dir: "model//" }))[0].name).toBe(
			"model/cameras.txt",
		);
		expect(readZip(buildColmapZip(FIXTURE, { dir: "" }))[0].name).toBe(
			"cameras.txt",
		);
	});
});
