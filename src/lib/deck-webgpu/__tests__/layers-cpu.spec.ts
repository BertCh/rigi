// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { poseBasis } from "#/lib/camera";
import { photoViewProjection } from "#/lib/deck/photo-view";
import type { TileMesh } from "#/lib/deck/terrain-data";
import type { GaussianCloud } from "#/lib/nearfield/types";
import { COARSE } from "#/lib/roll/map/drape-atlas";
import { seededRandom } from "#/test/helpers";
import { cameraUniforms, photoCamera } from "../camera";
import {
	DEFAULT_DRAPE,
	drapeSlack,
	drapeVisibilityCpu,
	MIN_SIN_INC,
} from "../layers/drape";
import { gizmoCorners, linearRGBA } from "../layers/gizmo";
import {
	buildMultiDrapeTables,
	cellSize,
	DEPTH_SLACK,
	type DrapePhoto,
	MAX_PER_TILE,
	type MultiDrapeAtlas,
	meshBox,
	reaches,
	SLOT_W,
	slotData,
} from "../layers/multi-drape";
import { photoSkyUv } from "../layers/photo-sky";
import {
	DEFAULT_SPLATS_OPTIONS,
	packSplats,
	SPLAT_WORDS,
	splatDepthRow,
	splatUniforms,
} from "../layers/splats";

describe("drape CPU twins", () => {
	const W = 8;
	const H = 4;
	const range = new Float32Array(W * H).fill(1000);

	it("drapeSlack grows with range and with grazing incidence, floored at MIN_SIN_INC", () => {
		const a = drapeSlack(1000, 1, 0.36, 512);
		expect(drapeSlack(2000, 1, 0.36, 512)).toBeCloseTo(2 * a, 10);
		expect(drapeSlack(1000, 0.5, 0.36, 512)).toBeCloseTo(2 * a, 10);
		expect(drapeSlack(1000, 0, 0.36, 512)).toBeCloseTo(
			drapeSlack(1000, MIN_SIN_INC, 0.36, 512),
			10,
		);
		expect(drapeSlack(1000, 1, 0.36, 1024)).toBeCloseTo(a / 2, 10);
	});

	it("drapeVisibilityCpu: a point at the seen range is visible, one beyond is not", () => {
		expect(drapeVisibilityCpu(range, W, H, [0.5, 0.5], 1000, 0, false)).toBe(1);
		expect(drapeVisibilityCpu(range, W, H, [0.5, 0.5], 1100, 0, false)).toBe(0);
		// the slack tolerates a little more
		expect(drapeVisibilityCpu(range, W, H, [0.5, 0.5], 1050, 100, false)).toBe(
			1,
		);
		// sky (range 0) never drapes
		const sky = new Float32Array(W * H);
		expect(drapeVisibilityCpu(sky, W, H, [0.5, 0.5], 10, 0, false)).toBe(0);
	});

	it("vote form blends the four neighbours", () => {
		const r = new Float32Array(W * H).fill(1000);
		for (let y = 0; y < H; y++) for (let x = 4; x < W; x++) r[y * W + x] = 100; // right half near
		// midway between texel 3 (far, visible) and 4 (near, hides r=1000): half
		const v = drapeVisibilityCpu(r, W, H, [4 / W, 0.5], 1000, 0, true);
		expect(v).toBeCloseTo(0.5, 6);
		expect(drapeVisibilityCpu(r, W, H, [0.05, 0.5], 1000, 0, true)).toBeCloseTo(
			1,
			6,
		);
		// clamped at the border
		expect(drapeVisibilityCpu(r, W, H, [0, 0], 1000, 0, true)).toBeCloseTo(
			1,
			6,
		);
	});

	it("drape is off by default and the world view only", () => {
		expect(DEFAULT_DRAPE.projectPhoto).toBe(0);
		expect(DEFAULT_DRAPE.views).toEqual(["world"]);
	});
});

describe("splats", () => {
	it("packSplats lays out position, covariance, rgba and provenance", () => {
		const cloud = {
			count: 2,
			frame: "enu",
			positions: new Float32Array([1, 2, 3, 4, 5, 6]),
			scales: new Float32Array([1, 2, 3, 0.5, 0.5, 0.5]),
			rotations: new Float32Array([1, 0, 0, 0, 2, 0, 0, 0]), // identity (second unnormalised)
			colors: new Uint8Array([10, 20, 30, 255, 255, 0, 0, 128]),
			provenance: new Uint8Array([2, 3]),
		} as GaussianCloud;
		const u = packSplats(cloud);
		const f = new Float32Array(u.buffer);
		expect(u.length).toBe(2 * SPLAT_WORDS);
		expect([f[0], f[1], f[2], f[3]]).toEqual([1, 2, 3, 2]);
		// identity rotation: diagonal covariance s^2
		expect([f[4], f[5], f[6], f[7], f[8], f[9]]).toEqual([1, 0, 0, 4, 0, 9]);
		expect(u[10]).toBe((10 | (20 << 8) | (30 << 16) | (255 << 24)) >>> 0);
		const o = SPLAT_WORDS;
		expect(f[o + 4]).toBeCloseTo(0.25, 6); // normalised quaternion
		expect(u[o + 10]).toBe((255 | (128 << 24)) >>> 0);
	});

	it("covariance is symmetric positive semi-definite for random rotations", () => {
		const rnd = seededRandom(5);
		const n = 20;
		const cloud = {
			count: n,
			frame: "enu",
			positions: new Float32Array(3 * n),
			scales: Float32Array.from({ length: 3 * n }, () => 0.1 + rnd()),
			rotations: Float32Array.from({ length: 4 * n }, () => rnd() - 0.5),
			colors: new Uint8Array(4 * n),
			provenance: new Uint8Array(n),
		} as GaussianCloud;
		const f = new Float32Array(packSplats(cloud).buffer);
		for (let i = 0; i < n; i++) {
			const [xx, xy, xz, yy, yz, zz] = Array.from(
				f.slice(i * SPLAT_WORDS + 4, i * SPLAT_WORDS + 10),
			);
			expect(xx).toBeGreaterThan(0);
			expect(xx * yy).toBeGreaterThanOrEqual(xy * xy - 1e-5);
			const det =
				xx * (yy * zz - yz * yz) -
				xy * (xy * zz - yz * xz) +
				xz * (xy * yz - yy * xz);
			expect(det).toBeGreaterThan(0);
		}
	});

	it("empty cloud still allocates one splat of storage", () => {
		const u = packSplats({
			count: 0,
			positions: new Float32Array(),
			scales: new Float32Array(),
			rotations: new Float32Array(),
			colors: new Uint8Array(),
			provenance: new Uint8Array(),
		} as unknown as GaussianCloud);
		expect(u.length).toBe(SPLAT_WORDS);
	});

	it("splatUniforms follows the options", () => {
		const u = splatUniforms({
			...DEFAULT_SPLATS_OPTIONS,
			truth: true,
			opacity: 0.3,
			sigmas: 2,
		});
		expect(u.truth).toBe(1);
		expect(u.opacity).toBe(0.3);
		expect(u.sigmas).toBe(2);
		expect(splatUniforms(DEFAULT_SPLATS_OPTIONS).truth).toBe(0);
	});

	it("splatDepthRow is the view-z row for a camera looking down -z", () => {
		const cam = cameraUniforms(
			photoCamera({
				pose: { yaw: 40, pitch: 10, roll: 0, vfov: 50 },
				eye: [10, 20, 30],
				width: 100,
				height: 100,
			}),
		);
		const row = splatDepthRow(cam);
		const p = [13, 25, 33];
		const viewZ = row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + row[3];
		const fwd = cam.forward;
		const depth =
			fwd[0] * (p[0] - 10) + fwd[1] * (p[1] - 20) + fwd[2] * (p[2] - 30);
		expect(viewZ).toBeCloseTo(-depth, 9);
	});
});

describe("gizmo / sky helpers", () => {
	it("linearRGBA decodes sRGB bytes", () => {
		expect(linearRGBA([0, 255, 255])).toEqual([0, 1, 1, 1]);
		expect(linearRGBA([255, 255, 255, 51])[3]).toBeCloseTo(0.2);
		expect(linearRGBA([128, 0, 0])[0]).toBeCloseTo(0.2158, 3);
	});

	it("gizmoCorners makes a plane of the pose's frustum at dist", () => {
		const pose = { yaw: 25, pitch: 10, roll: 5, vfov: 40 };
		const eye = [1, 2, 3];
		const [tl, tr, br, bl] = gizmoCorners(pose, eye, 1.5, 100);
		const b = poseBasis(pose);
		const centre = tl.map((v, i) => (v + br[i]) / 2);
		const toC = centre.map((v, i) => v - eye[i]);
		expect(Math.hypot(...toC)).toBeCloseTo(100, 6);
		expect(toC[0]).toBeCloseTo(b.forward[0] * 100, 6);
		const w = Math.hypot(tr[0] - tl[0], tr[1] - tl[1], tr[2] - tl[2]);
		const h = Math.hypot(bl[0] - tl[0], bl[1] - tl[1], bl[2] - tl[2]);
		expect(w / h).toBeCloseTo(1.5, 6);
		expect(h).toBeCloseTo(2 * Math.tan((20 * Math.PI) / 180) * 100, 6);
	});

	it("photoSkyUv: forward is the centre, behind is null, right of centre has u > 0.5", () => {
		const pose = { yaw: 0, pitch: 0, roll: 0, vfov: 40 };
		const cam = cameraUniforms(
			photoCamera({ pose, eye: [0, 0, 0], width: 200, height: 100 }),
		);
		const c = photoSkyUv(cam, [0, 1, 0]);
		expect(c?.u).toBeCloseTo(0.5, 6);
		expect(c?.v).toBeCloseTo(0.5, 6);
		expect(photoSkyUv(cam, [0, -1, 0])).toBeNull();
		const r = photoSkyUv(cam, [0.1, 1, 0]);
		expect((r?.u ?? 0) > 0.5).toBe(true);
		const up = photoSkyUv(cam, [0, 1, 0.1]);
		expect((up?.v ?? 1) < 0.5).toBe(true);
	});
});

describe("multi-drape tables", () => {
	const pose = { yaw: 0, pitch: -10, roll: 0, vfov: 40 };
	const mkPhoto = (
		id: string,
		eye: [number, number, number],
		gain = 1,
	): DrapePhoto => ({
		id,
		viewProj: Array.from(photoViewProjection(pose, eye, 1.5, 1, 100_000)),
		eye,
		minRange: 5,
		gain,
		aspect: 1.5,
		vfov: 40,
	});
	const tile = (
		id: string,
		x0: number,
		y0: number,
		size = 100,
		seg = 2,
		indices = 6,
	): TileMesh => {
		const pos: number[] = [];
		for (const [dx, dy] of [
			[0, 0],
			[1, 0],
			[0, 1],
			[1, 1],
		])
			pos.push(x0 + dx * size, y0 + dy * size, 0);
		return {
			id,
			seg,
			positions: new Float32Array(pos),
			indices: new Uint32Array(indices),
		} as unknown as TileMesh;
	};
	const atlas = (
		ids: string[],
		ready: boolean[],
		coarse: MultiDrapeAtlas["coarse"] = ids.map(() => null),
	): MultiDrapeAtlas =>
		({
			ids,
			ready,
			coarse,
			version: 1,
			readyVersion: 1,
			cells: ids.map((_, k) => ({
				atlas: k,
				photo: [0.1 * k, 0, 0.5, 0.5],
				photoPx: [0, 0, 1, 1],
				range: [0, 0, 128, 64],
			})),
			photo: [],
			range: undefined as never,
			mask: undefined as never,
		}) as unknown as MultiDrapeAtlas;

	it("meshBox / cellSize", () => {
		const t = tile("a", 10, 20, 100, 4);
		expect(Array.from(meshBox(t))).toEqual([10, 20, 0, 110, 120, 0]);
		expect(meshBox(t)).toBe(meshBox(t)); // cached
		expect(cellSize(t)).toBe(25);
	});

	it("slotData packs the camera-relative matrix, eye+gain, rects and extras", () => {
		const p = mkPhoto("p", [0, -500, 300], 2);
		const a = atlas(["p"], [true]);
		const s = slotData(a, 0, p);
		expect(s.length).toBe(SLOT_W * 4);
		for (let i = 0; i < 12; i++) expect(s[i]).toBeCloseTo(p.viewProj[i], 5);
		// column 3 = M * (eye,1): the eye projects to w = 0 plane origin (x = y = 0, w = 0 at eye)
		const e = p.eye;
		const M = p.viewProj;
		const w = M[3] * e[0] + M[7] * e[1] + M[11] * e[2] + M[15];
		expect(s[15]).toBeCloseTo(w, 3);
		expect(Array.from(s.slice(16, 20))).toEqual([0, -500, 300, 2]);
		expect(s[28]).toBe(5);
		expect(s[29]).toBe(1.5);
		expect(s[30]).toBeCloseTo((40 * Math.PI) / 180 / 64, 8);
		expect(s[32]).toBe(0);
	});

	it("reaches: in front yes, behind no, beyond reach no, occluded by a near range map no", () => {
		const p = mkPhoto("p", [0, -500, 300]);
		const a = atlas(["p"], [true]);
		const front = new Float64Array([-50, 0, 0, 50, 100, 0]);
		expect(reaches(front, p, a, 0, 8000, 0.005)).toBe(true);
		const behind = new Float64Array([-50, -2000, 0, 50, -1500, 0]);
		expect(reaches(behind, p, a, 0, 8000, 0.005)).toBe(false);
		const far = new Float64Array([-50, 20000, 0, 50, 20100, 0]);
		expect(reaches(far, p, a, 0, 8000, 0.005)).toBe(false);
		// side: far to the east of a narrow frustum
		const side = new Float64Array([3000, 0, 0, 3100, 100, 0]);
		expect(reaches(side, p, a, 0, 8000, 0.005)).toBe(false);
		// a coarse range map that sees only 100 m: terrain 500+ m away is hidden
		const cw = Math.ceil(128 / COARSE);
		const ch = Math.ceil(64 / COARSE);
		const near = {
			width: cw,
			height: ch,
			data: new Float32Array(cw * ch).fill(100),
		};
		const occl = atlas(["p"], [true], [near]);
		expect(reaches(front, p, occl, 0, 8000, 0.005)).toBe(false);
		const farMap = {
			width: cw,
			height: ch,
			data: new Float32Array(cw * ch).fill(5000),
		};
		expect(
			reaches(front, p, atlas(["p"], [true], [farMap]), 0, 8000, 0.005),
		).toBe(true);
	});

	it("buildMultiDrapeTables lists ready photos with gain, nearest camera first, per reachable tile", () => {
		const near = mkPhoto("near", [0, -300, 300]);
		const farther = mkPhoto("far", [30, -900, 300]);
		const dim = mkPhoto("dim", [0, -300, 300], 0);
		const notReady = mkPhoto("nr", [0, -300, 300]);
		const unknown = mkPhoto("zzz", [0, -300, 300]);
		void unknown;
		const a = atlas(["far", "near", "dim", "nr"], [true, true, true, false]);
		const t1 = tile("t1", -50, 1500);
		const t2 = tile("t2", -50, -5000); // behind both
		const empty = tile("t3", -50, 1500, 100, 2, 0); // no indices: skipped
		const tabs = buildMultiDrapeTables(
			[t1, t2, empty],
			a,
			[near, farther, dim, notReady],
			8000,
		);
		expect(tabs.atlasIndex).toEqual([0, 1]); // ids order, only ready & gain > 0
		expect(tabs.slots.length).toBe(2 * SLOT_W * 4);
		expect(tabs.rows.has("t2")).toBe(false);
		expect(tabs.rows.has("t3")).toBe(false);
		const row = tabs.rows.get("t1");
		expect(row).toBeDefined();
		const [first, count] = row as [number, number];
		expect(count).toBe(2);
		// nearest camera (the "near" photo = list index 1) first
		expect(tabs.lists[first]).toBe(1);
		expect(tabs.lists[first + 1]).toBe(0);
	});

	it("caps candidates per tile at MAX_PER_TILE and returns a non-empty list buffer when nothing reaches", () => {
		const n = MAX_PER_TILE + 10;
		const ids = Array.from({ length: n }, (_, i) => `p${i}`);
		const photos = ids.map((id, i) => mkPhoto(id, [i * 0.5, -300 - i, 300]));
		const tabs = buildMultiDrapeTables(
			[tile("t", -50, 1500)],
			atlas(
				ids,
				ids.map(() => true),
			),
			photos,
			8000,
		);
		expect(tabs.rows.get("t")?.[1]).toBe(MAX_PER_TILE);
		const none = buildMultiDrapeTables([], atlas([], []), [], 8000);
		expect(none.lists.length).toBe(1);
		expect(none.slots.length).toBe(SLOT_W * 4);
		expect(DEPTH_SLACK).toBeGreaterThan(0);
	});
});
