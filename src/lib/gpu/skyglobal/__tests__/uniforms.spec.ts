// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { packSkyGlobalUniform, SKYGLOBAL_U } from "../uniforms";

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

function oldPack(a: Parameters<typeof packSkyGlobalUniform>[0]) {
	const ub = new ArrayBuffer(48);
	const uu = new Uint32Array(ub);
	const uf = new Float32Array(ub);
	uu.set([
		a.w,
		a.h,
		a.n,
		a.sy,
		a.nYaw,
		a.nCombo,
		Math.floor(a.cntMin) + 1,
		a.cap,
	]);
	uf.set([a.eps ?? 5e-3, a.zeps ?? 1e-5, a.smin, a.smax], 8);
	return ub;
}

describe("packSkyGlobalUniform", () => {
	it("is 48 bytes", () => {
		expect(SKYGLOBAL_U.byteLength).toBe(48);
	});
	it("matches the old hand packing on edge values", () => {
		for (const u of U)
			for (const f of F) {
				const a = {
					w: u,
					h: U[(U.indexOf(u) + 1) % U.length],
					n: u,
					sy: 1,
					nYaw: 7,
					nCombo: u,
					cntMin: 3.7,
					cap: u,
					eps: f,
					zeps: f,
					smin: f,
					smax: -f,
				};
				expect(bytes(packSkyGlobalUniform(a))).toEqual(bytes(oldPack(a)));
			}
		const d = {
			w: 1,
			h: 2,
			n: 3,
			sy: 4,
			nYaw: 5,
			nCombo: 6,
			cntMin: 0,
			cap: 8,
			smin: 0,
			smax: 1,
		};
		expect(bytes(packSkyGlobalUniform(d))).toEqual(bytes(oldPack(d)));
	});
	it("matches on a seeded random sweep", () => {
		const r = mulberry32(42);
		const ru = () => Math.floor(r() * 0x100000000);
		for (let i = 0; i < 200; i++) {
			const a = {
				w: ru(),
				h: ru(),
				n: ru(),
				sy: ru(),
				nYaw: ru(),
				nCombo: ru(),
				cntMin: r() * 1e6,
				cap: ru(),
				eps: (r() - 0.5) * 1e3,
				zeps: r() * 1e-3,
				smin: r() - 0.5,
				smax: r() * 1e5,
			};
			expect(bytes(packSkyGlobalUniform(a))).toEqual(bytes(oldPack(a)));
		}
	});
});
