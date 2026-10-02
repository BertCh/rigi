// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import { type Pose, poseBasis } from "../../camera";
import {
	buildGen3cRequest,
	buildLingbotRequest,
	encodeNpy,
	GEN3C_DEFAULT_PROMPT,
	GEN3C_SIZE,
	gen3cNpz,
	interpolatePath,
	invRigid,
	kPixels,
	w2cOpenCV,
	zipStore,
} from "../generate/remote";
import type { NovelCamera } from "../generate/trajectory";
import { intrinsicsFromPose } from "../geom";

const pose = (yaw: number, pitch = 0, roll = 0, vfov = 60): Pose => ({
	yaw,
	pitch,
	roll,
	vfov,
});

const mul4 = (a: number[], b: number[]) =>
	Array.from({ length: 16 }, (_, k) => {
		const i = Math.floor(k / 4);
		const j = k % 4;
		return (
			a[4 * i] * b[j] +
			a[4 * i + 1] * b[4 + j] +
			a[4 * i + 2] * b[8 + j] +
			a[4 * i + 3] * b[12 + j]
		);
	});

describe("w2cOpenCV / invRigid", () => {
	it("maps the eye to the origin and forward to +z in camera coordinates", () => {
		const p = pose(30, 10, 2);
		const eye = [5, -3, 12];
		const m = w2cOpenCV(p, eye);
		// camera centre -> 0
		const c = [0, 1, 2].map(
			(i) =>
				m[4 * i] * eye[0] +
				m[4 * i + 1] * eye[1] +
				m[4 * i + 2] * eye[2] +
				m[4 * i + 3],
		);
		c.forEach((v) => {
			expect(v).toBeCloseTo(0, 9);
		});
		// a point 10 m along forward lands at (0, 0, 10)
		const F = poseBasis(p).forward;
		const X = [eye[0] + 10 * F[0], eye[1] + 10 * F[1], eye[2] + 10 * F[2]];
		const x = [0, 1, 2].map(
			(i) =>
				m[4 * i] * X[0] +
				m[4 * i + 1] * X[1] +
				m[4 * i + 2] * X[2] +
				m[4 * i + 3],
		);
		expect(x[0]).toBeCloseTo(0, 9);
		expect(x[1]).toBeCloseTo(0, 9);
		expect(x[2]).toBeCloseTo(10, 9);
		expect(m.slice(12)).toEqual([0, 0, 0, 1]);
	});
	it("invRigid inverts a random rigid transform", () => {
		const r = seededRandom(4);
		for (let i = 0; i < 10; i++) {
			const m = w2cOpenCV(
				pose(uniform(r, 0, 360), uniform(r, -60, 60), uniform(r, -20, 20)),
				[uniform(r, -50, 50), uniform(r, -50, 50), uniform(r, 0, 90)],
			);
			const p = mul4(m, invRigid(m));
			p.forEach((v, k) => {
				expect(v).toBeCloseTo(k % 5 === 0 ? 1 : 0, 9);
			});
		}
	});
});

describe("kPixels", () => {
	it("scales normalised intrinsics to pixels with the principal point at the centre", () => {
		const k = kPixels(pose(0, 0, 0, 60), 800, 400);
		const n = intrinsicsFromPose(pose(0, 0, 0, 60), 2);
		expect(k[0]).toBeCloseTo(n.fx * 800, 9);
		expect(k[4]).toBeCloseTo(n.fy * 400, 9);
		expect(k[2]).toBe(400);
		expect(k[5]).toBe(200);
		expect(k[8]).toBe(1);
	});
});

describe("interpolatePath", () => {
	const photo = {
		pose: pose(350, 0, 0, 60),
		eye: [0, 0, 0] as [number, number, number],
	};
	const cams: NovelCamera[] = [
		{
			name: "a",
			pose: pose(10, 10, 0, 70),
			eye: [10, 0, 0],
			offset: [10, 0, 0],
		},
		{
			name: "b",
			pose: pose(10, 10, 0, 70),
			eye: [10, 20, 0],
			offset: [10, 20, 0],
		},
	];
	it("starts at the photo, ends at the last camera, and visits the keys", () => {
		const p = interpolatePath(photo, cams, 5);
		expect(p).toHaveLength(5);
		expect(p[0].eye).toEqual([0, 0, 0]);
		expect(p[2].eye).toEqual([10, 0, 0]);
		expect(p[4].eye).toEqual([10, 20, 0]);
		expect(p[4].pose.vfov).toBeCloseTo(70, 9);
	});
	it("interpolates yaw the short way across north", () => {
		const p = interpolatePath(photo, cams, 3);
		expect(p[0].pose.yaw).toBeCloseTo(350, 9);
		expect(p[1].pose.yaw).toBeCloseTo(10, 9);
		const mid = interpolatePath(
			{ ...photo, pose: pose(350) },
			[{ ...cams[0], pose: pose(10) }],
			3,
		);
		expect(mid[1].pose.yaw).toBeCloseTo(0, 9);
	});
	it("repeats the photo with no cameras or a single frame", () => {
		expect(interpolatePath(photo, [], 4)).toHaveLength(4);
		expect(interpolatePath(photo, cams, 1)).toEqual([photo]);
	});
});

describe("buildGen3cRequest", () => {
	const kw = 40;
	const kh = 20;
	const rgba = new Uint8Array(kw * kh * 4);
	const z = new Float32Array(kw * kh).fill(25);
	for (let k = 0; k < kw * kh; k++) rgba.set([255, 0, 128, 255], 4 * k);
	z[0] = Number.NaN;
	z[1] = 0;
	const key = {
		width: kw,
		height: kh,
		rgba,
		zDepth: z,
		pose: pose(0, 0, 0, 60),
		eye: [100, 200, 30] as [number, number, number],
	};
	const path = Array.from({ length: 10 }, (_, f) => ({
		pose: pose(f),
		eye: [100 + f, 200, 30] as [number, number, number],
	}));
	const req = buildGen3cRequest([key], path, [100, 200, 30]);
	const { width: GW, height: GH } = GEN3C_SIZE;

	it("produces the documented NPZ keys and shapes, T = 120N + 1", () => {
		expect(Object.keys(req.npz)).toEqual([
			"images_key_frames",
			"depth_key_frames",
			"mask_key_frames",
			"K_key_frames",
			"w2cs_key_frames",
			"w2cs_all",
			"Ks_all",
		]);
		expect(req.npz.images_key_frames.shape).toEqual([1, 3, GH, GW]);
		expect(req.npz.depth_key_frames.shape).toEqual([1, 1, GH, GW]);
		expect(req.npz.w2cs_all.shape).toEqual([121, 4, 4]);
		expect(req.npz.Ks_all.shape).toEqual([121, 3, 3]);
		for (const a of Object.values(req.npz))
			expect(a.data.length).toBe(a.shape.reduce((x, y) => x * y, 1));
		expect(req.argv).toContain("121");
		expect(req.argv).toContain(GEN3C_DEFAULT_PROMPT);
		expect(req.notes.length).toBeGreaterThan(0);
	});
	it("letterboxes: bars are -1 RGB with mask 0, content is mapped to [-1, 1] with depth and mask", () => {
		// 40x20 -> scale 32 -> 1280x640; bars 32 px top and bottom
		const img = req.npz.images_key_frames.data;
		const dep = req.npz.depth_key_frames.data;
		const msk = req.npz.mask_key_frames.data;
		expect(img[0]).toBe(-1);
		expect(msk[0]).toBe(0);
		const cy = GH >> 1;
		const idx = cy * GW + GW / 2;
		expect(msk[idx]).toBe(1);
		expect(dep[idx]).toBe(25);
		expect(img[0 * GH * GW + idx]).toBeCloseTo(1, 6); // R 255
		expect(img[1 * GH * GW + idx]).toBeCloseTo(-1, 6); // G 0
		expect(img[2 * GH * GW + idx]).toBeCloseTo((128 / 255) * 2 - 1, 6);
		// invalid source depth (NaN, 0) is masked out: top-left source pixels
		const oy = (GH - 640) >> 1;
		expect(msk[oy * GW + 0]).toBe(0);
		expect(msk[oy * GW + 31]).toBe(0);
		expect(msk[oy * GW + 64]).toBe(1);
	});
	it("shifts the principal point by the letterbox offset and subtracts the origin from eyes", () => {
		const K = req.npz.K_key_frames.data;
		expect(K[2]).toBeCloseTo(GW / 2, 6);
		expect(K[5]).toBeCloseTo(GH / 2, 6);
		const W = req.npz.w2cs_key_frames.data;
		// the key's eye equals origin -> translation part is 0
		expect(W[3]).toBeCloseTo(0, 6);
		expect(W[7]).toBeCloseTo(0, 6);
		expect(W[11]).toBeCloseTo(0, 6);
		// path frame 5 is 5 m east of the origin: yaw 5 deg
		const all = req.npz.w2cs_all.data;
		const m = Array.from(all.subarray(16 * 5, 16 * 6));
		const inv = invRigid(m);
		expect(inv[3]).toBeCloseTo(5, 4);
		// frames past the path end repeat the last pose
		expect(Array.from(all.subarray(16 * 9, 16 * 10))).toEqual(
			Array.from(all.subarray(16 * 120, 16 * 121)),
		);
	});
	it("rounds T up for long paths, passes prompt and foreground masking", () => {
		const long = Array.from({ length: 130 }, () => path[0]);
		const r = buildGen3cRequest([key], long, [0, 0, 0], {
			prompt: "hello",
			foregroundMasking: true,
		});
		expect(r.npz.w2cs_all.shape[0]).toBe(241);
		expect(r.argv).toContain("hello");
		expect(r.argv).toContain("--foreground_masking");
		expect(r.argv).toContain("--disable_prompt_upsampler");
	});
});

describe("buildLingbotRequest", () => {
	const path = Array.from({ length: 6 }, (_, f) => ({
		pose: pose(f),
		eye: [f, 0, 0] as [number, number, number],
	}));
	it("packs [fx, fy, cx, cy] and camera-to-world poses with T = 4n + 1", () => {
		const r = buildLingbotRequest(path, [0, 0, 0]);
		expect(r.files["intrinsics.npy"].shape).toEqual([9, 4]);
		expect(r.files["poses.npy"].shape).toEqual([9, 4, 4]);
		const i = r.files["intrinsics.npy"].data;
		// 480*832 = H*W: cx = 416, cy = 240
		expect(i[2]).toBeCloseTo(416, 6);
		expect(i[3]).toBeCloseTo(240, 6);
		const p = r.files["poses.npy"].data;
		expect(p[16 * 3 + 3]).toBeCloseTo(3, 5); // frame 3 centre x
		expect(r.argv).toContain("9");
	});
	it("honours size and prompt", () => {
		const r = buildLingbotRequest(path.slice(0, 2), [0, 0, 0], {
			size: "720*1280",
			prompt: "p",
		});
		expect(r.files["intrinsics.npy"].shape[0]).toBe(5); // minimum 5 frames
		expect(r.files["intrinsics.npy"].data[2]).toBeCloseTo(640, 6);
		expect(r.argv).toContain("p");
		expect(r.argv).toContain("720*1280");
	});
});

describe("encodeNpy", () => {
	it("writes a v1.0 header padded to 64 bytes followed by little-endian float32", () => {
		const a = { shape: [2, 3], data: Float32Array.from([1, 2, 3, 4, 5, 6]) };
		const b = encodeNpy(a);
		expect(Array.from(b.subarray(0, 8))).toEqual([
			0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0,
		]);
		const hl = b[8] | (b[9] << 8);
		expect((10 + hl) % 64).toBe(0);
		const header = new TextDecoder().decode(b.subarray(10, 10 + hl));
		expect(header).toContain("'descr': '<f4'");
		expect(header).toContain("'fortran_order': False");
		expect(header).toContain("'shape': (2, 3)");
		expect(header.endsWith("\n")).toBe(true);
		const data = new Float32Array(b.slice(10 + hl).buffer);
		expect(Array.from(data)).toEqual([1, 2, 3, 4, 5, 6]);
	});
	it("writes 1-D shapes with a trailing comma", () => {
		const b = encodeNpy({ shape: [3], data: new Float32Array(3) });
		expect(
			new TextDecoder().decode(b.subarray(10, 10 + (b[8] | (b[9] << 8)))),
		).toContain("'shape': (3,)");
	});
});

describe("zipStore / gen3cNpz", () => {
	/** Minimal zip reader (stored entries) via the end-of-central-directory record. */
	function readZip(b: Uint8Array) {
		const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
		const eocd = b.length - 22;
		expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
		const n = dv.getUint16(eocd + 10, true);
		let o = dv.getUint32(eocd + 16, true);
		const out: Record<string, Uint8Array> = {};
		for (let i = 0; i < n; i++) {
			expect(dv.getUint32(o, true)).toBe(0x02014b50);
			const crc = dv.getUint32(o + 16, true);
			const size = dv.getUint32(o + 24, true);
			const nl = dv.getUint16(o + 28, true);
			const lo = dv.getUint32(o + 42, true);
			const name = new TextDecoder().decode(b.subarray(o + 46, o + 46 + nl));
			expect(dv.getUint32(lo, true)).toBe(0x04034b50);
			const lnl = dv.getUint16(lo + 26, true);
			const data = b.subarray(lo + 30 + lnl, lo + 30 + lnl + size);
			expect(crc32(data)).toBe(crc);
			out[name] = data;
			o += 46 + nl;
		}
		return out;
	}
	it("round-trips stored files with valid CRCs", () => {
		const files = {
			"a.npy": Uint8Array.from([1, 2, 3]),
			"dir/b.bin": new Uint8Array(1000).map((_, i) => i % 251),
			empty: new Uint8Array(0),
		};
		const got = readZip(zipStore(files));
		expect(Object.keys(got)).toEqual(Object.keys(files));
		for (const [k, v] of Object.entries(files))
			expect(Array.from(got[k])).toEqual(Array.from(v));
	});
	it("gen3cNpz stores one .npy per key", () => {
		const npz = gen3cNpz({
			npz: {
				x: { shape: [2], data: Float32Array.from([1, 2]) },
				y: { shape: [1, 1], data: Float32Array.from([3]) },
			},
			argv: [],
			notes: [],
		});
		const got = readZip(npz);
		expect(Object.keys(got)).toEqual(["x.npy", "y.npy"]);
		expect(got["x.npy"][0]).toBe(0x93);
	});
});
