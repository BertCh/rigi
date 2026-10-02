// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { Pose } from "../../../camera";
import {
	azExtent,
	buildMesh,
	dirOf,
	hitsPhoto,
	type PanoMesh,
	wrapOffsets,
} from "../panorama";

const pose = (yaw: number, pitch = 0, roll = 0, vfov = 50): Pose => ({
	yaw,
	pitch,
	roll,
	vfov,
});
const meshSpan = (azMin: number, azMax: number) =>
	({ azMin, azMax }) as PanoMesh;

describe("dirOf", () => {
	it("is a unit vector with east/north/up axes", () => {
		const n = dirOf(0, 0);
		expect(n[0]).toBeCloseTo(0);
		expect(n[1]).toBeCloseTo(1);
		const e = dirOf(90, 0);
		expect(e[0]).toBeCloseTo(1);
		expect(dirOf(0, 90)[2]).toBeCloseTo(1);
		const v = dirOf(37, 21);
		expect(Math.hypot(...v)).toBeCloseTo(1, 12);
	});
});

describe("buildMesh", () => {
	it("has the requested vertex, uv, index and outline counts", () => {
		const m = buildMesh(pose(100), 4 / 3, 6, 4);
		expect(m.pos.length).toBe(7 * 5 * 2);
		expect(m.uv.length).toBe(m.pos.length);
		expect(m.idx.length).toBe(6 * 4 * 6);
		expect(m.outline.length).toBe(32 * 4 * 2);
		expect(Math.max(...m.idx)).toBe(7 * 5 - 1);
	});

	it("is centred on the pose and spans about the horizontal fov", () => {
		const m = buildMesh(pose(100), 4 / 3);
		const hfov =
			2 * Math.atan(Math.tan((50 * Math.PI) / 360) * (4 / 3)) * (180 / Math.PI);
		expect((m.azMin + m.azMax) / 2).toBeCloseTo(100, 1);
		expect(m.azMax - m.azMin).toBeGreaterThan(hfov - 1);
		expect(m.azMax - m.azMin).toBeLessThan(hfov + 8); // cylindrical stretch at the corners
		expect((m.elMin + m.elMax) / 2).toBeCloseTo(0, 1);
	});

	it("keeps azimuths continuous across north (unwrapped about the yaw)", () => {
		const m = buildMesh(pose(358), 4 / 3);
		expect(m.azMax).toBeGreaterThan(360);
		expect(m.azMax - m.azMin).toBeLessThan(120);
		const w = buildMesh(pose(-2), 4 / 3); // yaw is wrapped to 0..360 first
		expect(w.azMin).toBeCloseTo(m.azMin, 6);
	});

	it("tilts the mesh up with pitch", () => {
		const m = buildMesh(pose(0, 20), 1.5);
		expect((m.elMin + m.elMax) / 2).toBeCloseTo(20, 0);
	});

	it("maps u,v corners to the mesh corners (v down means elevation down)", () => {
		const m = buildMesh(pose(0), 1.5, 2, 2);
		// vertex (u=0, v=0) is top-left: smallest az, largest el
		expect(m.pos[0]).toBeLessThan(0);
		expect(m.pos[1]).toBeGreaterThan(0);
		const last = m.pos.length - 2;
		expect(m.pos[last]).toBeGreaterThan(0);
		expect(m.pos[last + 1]).toBeLessThan(0);
	});
});

describe("hitsPhoto", () => {
	it("is true inside the frame and false outside or behind", () => {
		const p = pose(90);
		expect(hitsPhoto(p, 1.5, 90, 0)).toBe(true);
		expect(hitsPhoto(p, 1.5, 95, 5)).toBe(true);
		expect(hitsPhoto(p, 1.5, 140, 0)).toBe(false);
		expect(hitsPhoto(p, 1.5, 90, 60)).toBe(false);
		expect(hitsPhoto(p, 1.5, 270, 0)).toBe(false);
	});
});

describe("wrapOffsets", () => {
	it("returns 0 for a mesh inside the view", () => {
		const r = wrapOffsets(10, 50, 0, 360);
		expect(r).toHaveLength(1);
		expect(Math.abs(r[0])).toBe(0);
	});
	it("repeats a mesh that wraps around the view's far edge", () => {
		expect(wrapOffsets(350, 380, 0, 360)).toEqual([-360, 0]);
		expect(wrapOffsets(350, 380, 360, 720).map((k) => k + 0)).toEqual([0, 360]);
	});
	it("returns copies on both sides for a wide view", () => {
		expect(wrapOffsets(10, 50, -400, 400)).toEqual([-360, 0, 360]);
	});
	it("is empty when nothing intersects", () => {
		expect(wrapOffsets(10, 20, 100, 200)).toEqual([]);
	});
});

describe("azExtent", () => {
	it("is the full circle with no meshes", () => {
		expect(azExtent([])).toEqual([0, 360]);
	});
	it("starts after the largest gap and spans the covered arc", () => {
		const [start, span] = azExtent([meshSpan(100, 140), meshSpan(140, 200)]);
		expect(start).toBe(100);
		expect(span).toBe(100);
	});
	it("handles coverage that wraps through north", () => {
		const [start, span] = azExtent([meshSpan(350, 380)]);
		expect(start).toBe(350);
		expect(span).toBe(30);
	});
	it("returns the full circle when every degree is covered", () => {
		expect(azExtent([meshSpan(0, 360)])).toEqual([0, 360]);
	});
	it("joins two photos around the largest uncovered gap", () => {
		// covered 0..30 and 200..230: the biggest gap is 30..200, so the strip starts at 200 and wraps
		const [start, span] = azExtent([meshSpan(0, 30), meshSpan(200, 230)]);
		expect(start).toBe(200);
		expect(span).toBe(190);
	});
});
