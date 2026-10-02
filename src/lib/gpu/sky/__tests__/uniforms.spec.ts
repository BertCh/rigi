// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	packSkyPrepParams,
	packSkyRefineParams,
	SKY_PREP_P,
	SKY_REFINE_P,
} from "../uniforms";

const bytes = (b: ArrayBuffer) => Array.from(new Uint8Array(b));

/** Reference: the former hand packer of prep.ts runPrep. */
function oldPrep(
	W: number,
	H: number,
	lw: number,
	lh: number,
	rowBytes: number,
) {
	const words = new Uint32Array(8);
	words.set([W, H, lw, lh, rowBytes / 4]);
	return words.buffer;
}

/** Reference: the former hand packer of refine-graph.ts. */
function oldRefine(
	lw: number,
	lh: number,
	W: number,
	H: number,
	radius: number,
	band: number,
	eps: number,
) {
	const words = new ArrayBuffer(32);
	new Uint32Array(words, 0, 6).set([lw, lh, W, H, radius, band]);
	new Float32Array(words, 24, 1)[0] = eps;
	return words;
}

const nanPayload = Array.from(
	new Float32Array(new Uint32Array([0x7fc00001, 0xffc12345]).buffer),
);
const f32s = [
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
const u32s = [0, 1, 7, 0x7ffffffe, 0xffffffff, 2, 480, 1080, 4096, 65535];

function mulberry32(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("sky uniform blocks", () => {
	it("keeps the 32 B binding sizes", () => {
		expect(SKY_PREP_P.byteLength).toBe(32);
		expect(SKY_REFINE_P.byteLength).toBe(32);
	});

	it("packSkyPrepParams matches the hand packer", () => {
		for (const W of u32s)
			for (const rowBytes of [0, 4, 256, 1920, 4096, 262144]) {
				expect(bytes(packSkyPrepParams(W, 7, 480, 2, rowBytes))).toEqual(
					bytes(oldPrep(W, 7, 480, 2, rowBytes)),
				);
				expect(bytes(packSkyPrepParams(1, W, 1, W, rowBytes))).toEqual(
					bytes(oldPrep(1, W, 1, W, rowBytes)),
				);
			}
		const rand = mulberry32(1);
		for (let i = 0; i < 200; i++) {
			const a = Array.from({ length: 4 }, () => Math.floor(rand() * 8192));
			const rowBytes = Math.ceil((a[0] * 4) / 256) * 256;
			expect(
				bytes(packSkyPrepParams(a[0], a[1], a[2], a[3], rowBytes)),
			).toEqual(bytes(oldPrep(a[0], a[1], a[2], a[3], rowBytes)));
		}
	});

	it("packSkyRefineParams matches the hand packer", () => {
		for (const eps of f32s)
			for (const u of u32s) {
				expect(
					bytes(
						packSkyRefineParams({
							lw: u,
							lh: 2,
							W: 480,
							H: u,
							r: 3,
							br: u,
							eps,
						}),
					),
				).toEqual(bytes(oldRefine(u, 2, 480, u, 3, u, eps)));
			}
		const rand = mulberry32(2);
		for (let i = 0; i < 200; i++) {
			const v = Array.from({ length: 6 }, () => Math.floor(rand() * 8192));
			const eps = (rand() - 0.5) * 10 ** Math.floor(rand() * 20 - 10);
			expect(
				bytes(
					packSkyRefineParams({
						lw: v[0],
						lh: v[1],
						W: v[2],
						H: v[3],
						r: v[4],
						br: v[5],
						eps,
					}),
				),
			).toEqual(bytes(oldRefine(v[0], v[1], v[2], v[3], v[4], v[5], eps)));
		}
	});
});
