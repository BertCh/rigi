// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "#/test/helpers";
import {
	GEO_UNPACK_WGSL,
	UNPACK_RANGE,
	UNPACK_WG,
	UNPACK_XYZ,
	unpackGeometryCpu,
	unpackGeometryReference,
} from "../geo-unpack";

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const bitsOf = (v: number) => {
	f32[0] = v;
	return u32[0];
};
const floatOf = (b: number) => {
	u32[0] = b;
	return f32[0];
};

function texels(rows: number[][]) {
	const f = new Float32Array(rows.flat());
	return { f, u: new Uint32Array(f.buffer) };
}

describe("unpackGeometryCpu", () => {
	it("range only: positive w is kept, w <= 0 / NaN becomes +Infinity", () => {
		const { f } = texels([
			[1, 2, 3, 10],
			[1, 2, 3, 0],
			[1, 2, 3, -5],
			[1, 2, 3, Number.NaN],
		]);
		const range = new Float32Array(4);
		unpackGeometryCpu(f, range);
		expect(range[0]).toBe(10);
		expect(range[1]).toBe(Number.POSITIVE_INFINITY);
		expect(range[2]).toBe(Number.POSITIVE_INFINITY);
		expect(range[3]).toBe(Number.POSITIVE_INFINITY);
	});

	it("with xyz: terrain texels copy xyz, sky texels get NaN xyz", () => {
		const { f } = texels([
			[1, 2, 3, 10],
			[4, 5, 6, 0],
		]);
		const range = new Float32Array(2);
		const xyz = new Float32Array(6);
		unpackGeometryCpu(f, range, xyz);
		expect(Array.from(xyz.subarray(0, 3))).toEqual([1, 2, 3]);
		expect(Array.from(xyz.subarray(3))).toEqual([
			Number.NaN,
			Number.NaN,
			Number.NaN,
		]);
		expect(range[1]).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("unpackGeometryReference (the kernel's logic)", () => {
	it("is byte-identical to the CPU loop on random geometry with sky pixels", () => {
		const rand = seededRandom(7);
		const n = 500;
		const f = new Float32Array(n * 4);
		for (let i = 0; i < n; i++) {
			const sky = rand() < 0.3;
			f[i * 4] = (rand() - 0.5) * 1e4;
			f[i * 4 + 1] = (rand() - 0.5) * 1e4;
			f[i * 4 + 2] = rand() * 3000;
			f[i * 4 + 3] = sky ? 0 : 1 + rand() * 1e5;
		}
		const ref = unpackGeometryReference(
			new Uint32Array(f.buffer),
			n,
			UNPACK_RANGE | UNPACK_XYZ,
		);
		const range = new Float32Array(n);
		const xyz = new Float32Array(n * 3);
		unpackGeometryCpu(f, range, xyz);
		expect(Array.from(ref.rng)).toEqual(
			Array.from(new Uint32Array(range.buffer)),
		);
		expect(Array.from(ref.pos)).toEqual(
			Array.from(new Uint32Array(xyz.buffer)),
		);
		expect(ref.odd).toBe(false);
	});

	it("only allocates the planes the mode asks for", () => {
		const { u } = texels([[1, 2, 3, 4]]);
		const r = unpackGeometryReference(u, 1, UNPACK_RANGE);
		expect(r.rng).toHaveLength(1);
		expect(r.pos).toHaveLength(0);
		const x = unpackGeometryReference(u, 1, UNPACK_XYZ);
		expect(x.rng).toHaveLength(0);
		expect(x.pos).toHaveLength(3);
	});

	it("treats +Infinity as terrain, NaN and negatives as sky", () => {
		const mk = (w: number) => new Uint32Array([0, 0, 0, bitsOf(w)]);
		expect(
			unpackGeometryReference(mk(Number.POSITIVE_INFINITY), 1, 1).rng[0],
		).toBe(0x7f800000);
		for (const w of [Number.NaN, -1, -0, 0, Number.NEGATIVE_INFINITY]) {
			const r = unpackGeometryReference(mk(w), 1, UNPACK_RANGE | UNPACK_XYZ);
			expect(r.rng[0]).toBe(0x7f800000);
			expect(floatOf(r.pos[0])).toBeNaN();
			expect(r.odd).toBe(false);
		}
	});

	it("flags denormal / NaN / Infinity words copied from terrain texels", () => {
		const denormal = 0x00000001;
		// denormal range word: positive, terrain, odd
		expect(
			unpackGeometryReference(
				new Uint32Array([0, 0, 0, denormal]),
				1,
				UNPACK_RANGE,
			).odd,
		).toBe(true);
		// a normal w with a denormal x only counts when xyz is requested
		const t = new Uint32Array([denormal, 0, 0, bitsOf(5)]);
		expect(unpackGeometryReference(t, 1, UNPACK_RANGE).odd).toBe(false);
		expect(unpackGeometryReference(t, 1, UNPACK_XYZ).odd).toBe(true);
		// NaN payload in z
		const nan = new Uint32Array([0, 0, 0x7fc00001, bitsOf(5)]);
		expect(unpackGeometryReference(nan, 1, UNPACK_XYZ).odd).toBe(true);
		// +/-0 and Infinity (zero mantissa) are not odd
		const zeros = new Uint32Array([0x80000000, 0, 0x7f800000, bitsOf(5)]);
		expect(unpackGeometryReference(zeros, 1, UNPACK_XYZ).odd).toBe(false);
	});

	it("ignores odd words in sky texels (they are replaced by constants)", () => {
		const sky = new Uint32Array([0x00000001, 0x7fc00001, 0x7fc00001, 0]);
		expect(unpackGeometryReference(sky, 1, UNPACK_RANGE | UNPACK_XYZ).odd).toBe(
			false,
		);
	});
});

describe("GEO_UNPACK_WGSL", () => {
	it("bakes the shared constants into the kernel source", () => {
		expect(GEO_UNPACK_WGSL).toContain(`@workgroup_size(${UNPACK_WG})`);
		expect(GEO_UNPACK_WGSL).toContain("2139095040u"); // 0x7f800000
		expect(GEO_UNPACK_WGSL).toContain("2143289344u"); // 0x7fc00000
		expect(GEO_UNPACK_WGSL).toContain(`& ${UNPACK_RANGE}u`);
		expect(GEO_UNPACK_WGSL).toContain(`& ${UNPACK_XYZ}u`);
	});
});
