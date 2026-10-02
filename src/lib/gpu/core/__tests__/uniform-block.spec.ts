// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	CERT_U,
	POSE_BOUND_U,
	POSE_GRID_U,
	packCertProbeUniform,
	packCertUniform,
	packPoseBoundUniform,
	packPoseGridUniform,
} from "../../align/uniforms";
import {
	CERT_HORIZON_U,
	MOSAIC_MIP_P,
	packCertHorizonUniform,
	packRidgesUniform,
	RIDGES_U,
} from "../../horizon/uniforms";
import * as lookBlocks from "../../look/uniform-blocks";
import { FOLD_U } from "../../solve/uniforms";
import { defineUniformBlock } from "../uniform-block";

describe("defineUniformBlock", () => {
	it("lays out scalars in order (offsets are in 32-bit words) and rounds the size to 16 B", () => {
		const b = defineUniformBlock({ a: "u32", b: "f32", c: "i32" });
		expect(b.byteLength).toBe(16);
		expect([b.offsetOf("a"), b.offsetOf("b"), b.offsetOf("c")]).toEqual([
			0, 1, 2,
		]);
	});
	it("an empty-ish block is at least 16 B", () => {
		expect(defineUniformBlock({ a: "u32" }).byteLength).toBe(16);
	});
	it("aligns vec3 to 16 B and lets a following scalar fill its 4th word", () => {
		const b = defineUniformBlock({ a: "u32", v: "vec3<f32>", s: "f32" });
		expect(b.offsetOf("v")).toBe(4); // words: 16 B aligned
		expect(b.offsetOf("s")).toBe(7);
		expect(b.byteLength).toBe(32);
	});
	it("packs typed values at their offsets and zeroes unlisted fields", () => {
		const b = defineUniformBlock({ n: "u32", x: "f32", i: "i32", z: "u32" });
		const buf = b.pack({ n: 7, x: 1.5, i: -3 });
		expect(buf.byteLength).toBe(b.byteLength);
		expect(new Uint32Array(buf)[b.offsetOf("n")]).toBe(7);
		expect(new Float32Array(buf)[b.offsetOf("x")]).toBe(1.5);
		expect(new Int32Array(buf)[b.offsetOf("i")]).toBe(-3);
		expect(new Uint32Array(buf)[b.offsetOf("z")]).toBe(0);
	});
	it("packs vec and mat fields from flat arrays", () => {
		const b = defineUniformBlock({ v: "vec2<f32>", m: "mat4x4<f32>" });
		const m = Array.from({ length: 16 }, (_, i) => i + 1);
		const buf = b.pack({ v: [2, 3], m });
		const f = new Float32Array(buf);
		expect([f[b.offsetOf("v")], f[b.offsetOf("v") + 1]]).toEqual([2, 3]);
		expect(Array.from(f.slice(b.offsetOf("m"), b.offsetOf("m") + 16))).toEqual(
			m,
		);
		expect(b.byteLength).toBe(80);
	});
	it("returns a fresh buffer per pack", () => {
		const b = defineUniformBlock({ n: "u32" });
		expect(b.pack({ n: 1 })).not.toBe(b.pack({ n: 1 }));
	});
	it("rejects an unknown field name", () => {
		const b = defineUniformBlock({ n: "u32" });
		expect(() => (b.offsetOf as (n: string) => number)("nope")).toThrow(
			/no field/,
		);
	});
});

describe("declared kernel uniform blocks", () => {
	const blocks: [string, { byteLength: number }][] = [
		["CERT_U", CERT_U],
		["POSE_BOUND_U", POSE_BOUND_U],
		["POSE_GRID_U", POSE_GRID_U],
		["CERT_HORIZON_U", CERT_HORIZON_U],
		["RIDGES_U", RIDGES_U],
		["MOSAIC_MIP_P", MOSAIC_MIP_P],
		["FOLD_U", FOLD_U],
		...Object.entries(lookBlocks).map(
			([k, v]) =>
				[k, v as { byteLength: number }] as [string, { byteLength: number }],
		),
	];
	it.each(blocks)("%s is a multiple of 16 B", (_n, b) => {
		expect(b.byteLength % 16).toBe(0);
		expect(b.byteLength).toBeGreaterThanOrEqual(16);
	});
	it("pins the documented sizes", () => {
		expect(CERT_U.byteLength).toBe(128);
		expect(POSE_BOUND_U.byteLength).toBe(48);
		expect(POSE_GRID_U.byteLength).toBe(32);
		expect(CERT_HORIZON_U.byteLength).toBe(32);
		expect(RIDGES_U.byteLength).toBe(64);
		expect(MOSAIC_MIP_P.byteLength).toBe(32);
		expect(FOLD_U.byteLength).toBe(16);
	});
});

describe("align packers", () => {
	const base = { w: 1000, h: 400, nDirs: 33, nPoses: 5, aspect: 2.5, nonce: 9 };
	it("pose-bound derives band and gaps from the height like scorePose", () => {
		const u = packPoseBoundUniform(base);
		const i32 = new Int32Array(u);
		expect(i32[POSE_BOUND_U.offsetOf("band")]).toBe(14); // round(400 * 0.035)
		expect(i32[POSE_BOUND_U.offsetOf("gapCoarse")]).toBe(5);
		expect(i32[POSE_BOUND_U.offsetOf("gapFine")]).toBe(2);
		expect(new Float32Array(u)[POSE_BOUND_U.offsetOf("aspect")]).toBe(2.5);
		expect(new Uint32Array(u)[POSE_BOUND_U.offsetOf("nonce")]).toBe(9);
	});
	it("band and gaps have floors for tiny heights", () => {
		const u = new Int32Array(packPoseBoundUniform({ ...base, h: 1 }));
		expect(u[POSE_BOUND_U.offsetOf("band")]).toBe(2);
		expect(u[POSE_BOUND_U.offsetOf("gapCoarse")]).toBe(1);
		expect(u[POSE_BOUND_U.offsetOf("gapFine")]).toBe(1);
	});
	it("pose-grid carries nDirs as the float total", () => {
		const u = packPoseGridUniform(base);
		expect(new Float32Array(u)[POSE_GRID_U.offsetOf("total")]).toBe(33);
		expect(new Int32Array(u)[POSE_GRID_U.offsetOf("gap")]).toBe(5);
	});
	it("cert uniform zeroes the opaque zero and padding", () => {
		const u = packCertUniform({
			w: 100,
			h: 200,
			nDirs: 10,
			nLanes: 4,
			aspect: 1.5,
			window: 8,
			nonce: 3,
			eCoef: 0.1,
			logCap: 5,
			dB: 0.2,
			relT: 0.3,
			relV: 0.4,
			pen: 0.5,
			e2Coef: 0.6,
			aspectHi: 1.5,
			aspectLo: 0,
			fault: 0,
		});
		const w = new Uint32Array(u);
		expect(w[CERT_U.offsetOf("zero")]).toBe(0);
		expect(w[CERT_U.offsetOf("W")]).toBe(8);
		expect(new Float32Array(u)[CERT_U.offsetOf("total")]).toBe(10);
		expect(new Float32Array(u)[CERT_U.offsetOf("penSlack")]).toBeCloseTo(
			0.5,
			6,
		);
		for (let i = CERT_U.offsetOf("pad1"); i < w.length; i++)
			expect(w[i]).toBe(0);
	});
	it("cert probe sets only nDirs", () => {
		const w = new Uint32Array(packCertProbeUniform(77));
		expect(w[CERT_U.offsetOf("nDirs")]).toBe(77);
		expect(w.reduce((a, b) => a + b, 0)).toBe(77);
	});
});

describe("horizon packers", () => {
	it("cert horizon uniform", () => {
		const u = packCertHorizonUniform({
			n: 5,
			nCols: 6,
			noHit: -3e38,
			lumpEnu: 0.5,
			lumpEnuRel: 0.25,
		});
		expect(new Uint32Array(u)[CERT_HORIZON_U.offsetOf("n")]).toBe(5);
		expect(new Uint32Array(u)[CERT_HORIZON_U.offsetOf("zero")]).toBe(0);
		expect(new Float32Array(u)[CERT_HORIZON_U.offsetOf("noHit")]).toBe(
			Math.fround(-3e38),
		);
	});
	it("ridges uniform splits the eye height into an f32 pair", () => {
		const eyeH = 1234.56789012345;
		const u = packRidgesUniform({
			nCols: 1,
			nSlabs: 2,
			nDist: 3,
			nRings: 4,
			azOff: 5,
			distOff: 6,
			ringOff: 7,
			slabOff: 8,
			inv2R: 1e-8,
			eyeH,
			sinP1: 0.5,
			cosP1: 0.8,
		});
		const f = new Float32Array(u);
		expect(
			f[RIDGES_U.offsetOf("h0")] + f[RIDGES_U.offsetOf("h0lo")],
		).toBeCloseTo(eyeH, 9);
		expect(new Uint32Array(u)[RIDGES_U.offsetOf("slabOff")]).toBe(8);
	});
});
