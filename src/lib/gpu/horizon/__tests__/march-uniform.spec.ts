// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { MARCH_U, packMarchUniform } from "../uniforms";

type Args = Parameters<typeof packMarchUniform>[0];

// the former hand packing (index.ts), verbatim
const oldPack = (a: Args) => {
	const ub = new ArrayBuffer(64);
	const uu = new Uint32Array(ub);
	const uf = new Float32Array(ub);
	uu[0] = a.nAz;
	uu[1] = a.nEyes;
	uu[2] = a.eyeStride;
	uu[3] = a.azOff;
	uu[4] = a.eyeOff;
	uu[5] = a.ringOff;
	uu[6] = a.nRings;
	uu[7] = a.mipSkip ? 1 : 0;
	uf[8] = a.stepFactor;
	uf[9] = a.nearFactor;
	uf[10] = a.inv2R;
	uu[11] = 1_000_000;
	uu[12] = 0;
	return ub;
};
const bytes = (b: ArrayBuffer) => Array.from(new Uint8Array(b));

const nanPayload = Array.from(
	new Float32Array(new Uint32Array([0x7fc00001, 0xffc12345]).buffer),
);
const floats = [
	0,
	-0,
	1e-40,
	-1e-45,
	3.4028234663852886e38,
	-3.4e38,
	1 / 3,
	NaN,
	Infinity,
	...nanPayload,
];
const ints = [0, 1, 7, 0x7ffffffe, 0xffffffff, 2, 480, 1080, 4096, 65535];

const mulberry32 = (seed: number) => () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("MARCH_U", () => {
	it("is 64 bytes", () => {
		expect(MARCH_U.byteLength).toBe(64);
		expect(packMarchUniform(base()).byteLength).toBe(64);
	});

	it("matches the old packing over edge values", () => {
		for (const f of floats)
			for (const n of ints) {
				const a = {
					...base(),
					stepFactor: f,
					nearFactor: f,
					inv2R: f,
					nAz: n,
					nEyes: n,
					ringOff: n,
				};
				expect(bytes(packMarchUniform(a))).toEqual(bytes(oldPack(a)));
				const b = {
					...a,
					mipSkip: false,
					eyeStride: n,
					azOff: n,
					eyeOff: n,
					nRings: n,
				};
				expect(bytes(packMarchUniform(b))).toEqual(bytes(oldPack(b)));
			}
	});

	it("matches the old packing over a seeded sweep", () => {
		const r = mulberry32(42);
		for (let i = 0; i < 200; i++) {
			const u = () => Math.floor(r() * 2 ** 32);
			const a: Args = {
				nAz: u(),
				nEyes: u(),
				eyeStride: u(),
				azOff: u(),
				eyeOff: u(),
				ringOff: u(),
				nRings: u(),
				mipSkip: r() < 0.5,
				stepFactor: (r() - 0.5) * 10 ** (r() * 20 - 10),
				nearFactor: (r() - 0.5) * 10 ** (r() * 20 - 10),
				inv2R: r() * 1e-7,
			};
			expect(bytes(packMarchUniform(a))).toEqual(bytes(oldPack(a)));
		}
	});
});

function base(): Args {
	return {
		nAz: 1080,
		nEyes: 7,
		eyeStride: 12,
		azOff: 3,
		eyeOff: 4,
		ringOff: 5,
		nRings: 2,
		mipSkip: true,
		stepFactor: 3.5e-4,
		nearFactor: 0.01,
		inv2R: 6.2e-8,
	};
}
