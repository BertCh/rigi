// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { packSkylineParams, SKYLINE_P } from "../uniforms";

const bytes = (b: ArrayBuffer) => Array.from(new Uint8Array(b));
const mulberry32 = (a: number) => () => {
	a = (a + 0x6d2b79f5) | 0;
	let t = Math.imul(a ^ (a >>> 15), 1 | a);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const nanPayload = Array.from(
	new Float32Array(new Uint32Array([0x7fc00001, 0xffc12345]).buffer),
);
const F = [
	0,
	-0,
	1e-40,
	-1e-45,
	3.4028234663852886e38,
	-3.4e38,
	1 / 3,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	...nanPayload,
];
const U = [0, 1, 7, 0x7ffffffe, 0xffffffff, 2, 480, 1080, 4096, 65535];

function oldPack(w: number, h: number, sigma: number) {
	const words = new ArrayBuffer(32);
	new Uint32Array(words).set([w, h, w * h]);
	new Float32Array(words)[4] = sigma;
	return words;
}

describe("packSkylineParams", () => {
	it("is 32 bytes", () => {
		expect(SKYLINE_P.byteLength).toBe(32);
	});
	it("matches the old hand packing on edge values", () => {
		for (const w of U)
			for (const h of U)
				for (const f of F)
					expect(bytes(packSkylineParams(w, h, f))).toEqual(
						bytes(oldPack(w, h, f)),
					);
	});
	it("matches on a seeded random sweep", () => {
		const r = mulberry32(7);
		for (let i = 0; i < 200; i++) {
			const w = Math.floor(r() * 0x100000000);
			const h = Math.floor(r() * 5000);
			const s = (r() - 0.5) * 100;
			expect(bytes(packSkylineParams(w, h, s))).toEqual(
				bytes(oldPack(w, h, s)),
			);
		}
	});
});
