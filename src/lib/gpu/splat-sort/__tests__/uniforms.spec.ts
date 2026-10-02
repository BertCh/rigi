// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { packSplatSortParams, SPLAT_SORT_PARAMS } from "../uniforms";

type Row = readonly [number, number, number, number];

/** The former inline packing of GpuSplatSorter.sort, verbatim. */
function oldPack(row: Row, count: number, blocks: number): ArrayBuffer {
	const w = new ArrayBuffer(32);
	const fl = new Float32Array(w);
	const u = new Uint32Array(w);
	fl.set(row, 0);
	fl[4] = 0;
	u[5] = count;
	u[6] = blocks;
	return w;
}

const bytes = (b: ArrayBuffer) => Array.from(new Uint8Array(b));
const payloadNaNs = Array.from(
	new Float32Array(new Uint32Array([0x7fc00001, 0xffc12345]).buffer),
);
const floats = [
	0,
	-0,
	1,
	1e-40,
	-1e-45,
	3.4028234663852886e38,
	-3.4e38,
	1 / 3,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	...payloadNaNs,
];
const words = [0, 1, 7, 0x7ffffffe, 0xffffffff, 65535, 4096, 480, 1080, 2];

function mulberry32(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("SPLAT_SORT_PARAMS", () => {
	it("is 32 B with near at byte 16", () => {
		expect(SPLAT_SORT_PARAMS.byteLength).toBe(32);
		expect(SPLAT_SORT_PARAMS.offsetOf("row")).toBe(0);
		expect(SPLAT_SORT_PARAMS.offsetOf("near")).toBe(4);
		expect(SPLAT_SORT_PARAMS.offsetOf("n")).toBe(5);
		expect(SPLAT_SORT_PARAMS.offsetOf("blocks")).toBe(6);
	});

	it("matches the old packing over edge values", () => {
		for (const f of floats)
			for (const [i, j] of [
				[0, 1],
				[1, 65535],
				[0xffffffff, 0],
			]) {
				const row: Row = [
					f,
					-f,
					floats[(floats.indexOf(f) + 3) % floats.length],
					1,
				];
				const got = packSplatSortParams(row, i, j);
				expect(got.byteLength).toBe(32);
				expect(bytes(got)).toEqual(bytes(oldPack(row, i, j)));
			}
		for (const n of words)
			for (const b of words) {
				const row: Row = [0, -0, 1e-40, 3.4e38];
				expect(bytes(packSplatSortParams(row, n, b))).toEqual(
					bytes(oldPack(row, n, b)),
				);
			}
	});

	it("matches the old packing over a seeded sweep", () => {
		const rnd = mulberry32(1234);
		for (let k = 0; k < 200; k++) {
			const pick = () =>
				rnd() < 0.3
					? floats[Math.floor(rnd() * floats.length)]
					: (rnd() - 0.5) * 10 ** Math.floor(rnd() * 20 - 10);
			const row: Row = [pick(), pick(), pick(), pick()];
			const n = Math.floor(rnd() * 0x100000000);
			const b = Math.floor(rnd() * 70000);
			expect(bytes(packSplatSortParams(row, n, b))).toEqual(
				bytes(oldPack(row, n, b)),
			);
		}
	});
});
