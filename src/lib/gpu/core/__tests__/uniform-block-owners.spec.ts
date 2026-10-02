// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The packers that live beside their kernel's inputs (solve packCoarse, photoPrepDims,
// statsParamWords, haze prepUploads / gridUploads, bandWords, reliefWords) write the same bytes as
// the hand-packed words they replaced. The `old*` functions below are the former code, kept here
// only as references.
import { describe, expect, it } from "vitest";
import type { CoarsePlan } from "#/lib/geo/solve";
import { BETA_R0 } from "#/lib/look/atmosphere";
import { GROUPS, statsParamWords, WG } from "../../look/color-stats";
import { gridUploads, prepUploads } from "../../look/haze";
import { bandShape, bandWords, keyBelow } from "../../look/haze-band";
import { reliefWords } from "../../look/relief";
import { photoPrepDims } from "../../photoprep/plan";
import { costBound, packCoarse, profileHz } from "../../solve/index";

const bytes = (b: ArrayBuffer | ArrayBufferView) =>
	b instanceof ArrayBuffer
		? Array.from(new Uint8Array(b))
		: Array.from(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));

// seeded inputs (mulberry32)
function rng(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const SIZES = [1, 2, 3, 5, 7, 480, 1079, 4096, 65535];
const F32 = [
	0,
	-0,
	0.1,
	-3.4e38,
	3.4e38,
	1e-40,
	-1e-45,
	1 / 3,
	12345.678901234,
];

describe("photoPrepDims", () => {
	const old = (w: number, h: number, nonce: number) => {
		const n = w * h;
		const u = new Uint32Array(8);
		u[0] = w;
		u[1] = h;
		u[2] = n;
		u[3] = Math.floor(n * 0.97);
		u[4] = Math.round(h * 0.12);
		u[5] = Math.round(h * 0.06);
		u[6] = Math.round(h * 0.8);
		u[7] = nonce;
		return u;
	};
	it("is byte-identical", () => {
		for (const w of SIZES)
			for (const h of SIZES)
				for (const nonce of [0, 1, 7, 0xffffffff, -1, Number.NaN]) {
					const a = photoPrepDims(w, h, nonce);
					expect(a).toBeInstanceOf(Uint32Array);
					expect(bytes(a)).toEqual(bytes(old(w, h, nonce)));
				}
		expect(bytes(photoPrepDims(10, 20))).toEqual(bytes(old(10, 20, 1)));
	});
});

describe("statsParamWords", () => {
	const old = (
		w: number,
		h: number,
		hasFg: boolean,
		minRange: number,
		minCount: number,
	) => {
		const words = new ArrayBuffer(24);
		new Uint32Array(words, 0, 4).set([w, h, GROUPS * WG, hasFg ? 1 : 0]);
		new Float32Array(words, 16, 1)[0] = minRange;
		new Uint32Array(words, 20, 1)[0] = minCount;
		return words;
	};
	it("is byte-identical and 24 bytes", () => {
		for (const w of SIZES)
			for (const fg of [false, true])
				for (const mr of [...F32, Number.NaN, Number.POSITIVE_INFINITY])
					for (const mc of [0, 60, 0xffffffff]) {
						const a = statsParamWords(w, 3 * w, fg, mr, mc);
						expect(a.byteLength).toBe(24);
						expect(bytes(a)).toEqual(bytes(old(w, 3 * w, fg, mr, mc)));
					}
	});
});

describe("haze prepUploads / gridUploads / bandWords", () => {
	const DMIN = 200;
	const DMAX = 150000;
	const oldPrep = (
		W: number,
		H: number,
		pw: number,
		rad: number,
		fgRad: number,
	) => {
		const words = new ArrayBuffer(36);
		new Uint32Array(words, 0, 5).set([W, H, pw, rad, fgRad]);
		const lo = Math.log(DMIN);
		new Float32Array(words, 20, 4).set([
			lo,
			Math.log(DMAX) - lo,
			Math.max(150, DMIN),
			DMAX,
		]);
		return words;
	};
	it("prepUploads words are byte-identical (36 bytes)", () => {
		for (const W of [1, 7, 480, 4096])
			for (const pw of [1, 333, 6000])
				for (const rad of [0, 1, 9, 0xffffffff]) {
					const photo = { width: pw, height: 2 * pw } as never;
					const { words } = prepUploads(photo, W, W + 1, rad, rad + 1);
					expect(words.byteLength).toBe(36);
					expect(bytes(words)).toEqual(
						bytes(oldPrep(W, W + 1, pw, rad, (rad + 1) >>> 0)),
					);
				}
	});
	const oldGrid = (
		S: number,
		NH: number,
		air: number[],
		lam: number,
		jBar: number,
		priorK: number,
	) => {
		const words = new ArrayBuffer(64);
		new Uint32Array(words, 0, 4).set([S, NH, 25, 37]);
		new Float32Array(words, 16, 12).set([
			air[0],
			air[1],
			air[2],
			0,
			BETA_R0[0],
			BETA_R0[1],
			BETA_R0[2],
			0,
			lam,
			jBar,
			priorK,
			0,
		]);
		return words;
	};
	it("gridUploads words are byte-identical (64 bytes)", () => {
		const r = rng(3);
		for (const S of [1, 2, 5]) {
			for (const f of [
				...F32,
				Number.NaN,
				Number.NEGATIVE_INFINITY,
				r(),
				r() * 1e5,
			]) {
				const air: [number, number, number] = [f, r(), -r()];
				const reps = [0, 1, 2].map(() =>
					Array.from({ length: S }, () => new Float64Array(0)),
				);
				const Ic = [0, 1, 2].map(() => Array.from({ length: S }, () => 0.5));
				const wp = Ic;
				const { words } = gridUploads(reps, Ic, wp, air, f, -f, f * 3);
				const NH = new Uint32Array(words)[1];
				expect(words.byteLength).toBe(64);
				expect(bytes(words)).toEqual(bytes(oldGrid(S, NH, air, f, -f, f * 3)));
			}
		}
	});
	it("bandWords is byte-identical (32 bytes)", () => {
		for (const W of [2, 3, 480, 1024, 4096]) {
			const H = Math.round(W * 0.75);
			const a = bandWords(W, H);
			// reference: the eight words the old Uint32Array literal listed
			const { a0, a1, nCol, kMax } = bandShape(W, H);
			const ref = new Uint32Array([
				W,
				H,
				nCol,
				a0,
				a1,
				keyBelow(0.5),
				keyBelow(0.7),
				kMax,
			]);
			expect(a.byteLength).toBe(32);
			expect(bytes(a)).toEqual(bytes(ref));
		}
	});
});

describe("reliefWords", () => {
	// the former DataView sequence
	const old = (res: number, px: number, sun: number[]) => {
		const resH = res >> 1;
		const hz = Math.hypot(sun[0], sun[1]);
		const degenerate = sun[2] <= -0.02 || hz < 1e-4;
		const xMajor = Math.abs(sun[0]) >= Math.abs(sun[1]);
		const major = xMajor ? sun[0] : sun[1];
		const slope = degenerate ? 0 : (xMajor ? sun[1] : sun[0]) / Math.abs(major);
		const tanEl = degenerate ? 0 : sun[2] / hz;
		const drop = px * Math.hypot(1, slope) * tanEl;
		const ra = Math.max(1, Math.round(60 / px));
		const rb = Math.max(3, Math.round(250 / px));
		const da = Math.max(1, Math.round(ra / Math.SQRT2));
		const db = Math.max(1, Math.round(rb / Math.SQRT2));
		const words = new ArrayBuffer(80);
		const dv = new DataView(words);
		let o = 0;
		const u32 = (v: number) => {
			dv.setUint32(o, v, true);
			o += 4;
		};
		const i32 = (v: number) => {
			dv.setInt32(o, v, true);
			o += 4;
		};
		const f32 = (v: number) => {
			dv.setFloat32(o, v, true);
			o += 4;
		};
		u32(res);
		u32(resH);
		u32(xMajor ? 1 : res);
		u32(xMajor ? res : 1);
		i32(major > 0 ? 1 : -1);
		i32(Math.floor(slope));
		f32(slope - Math.floor(slope));
		f32(drop);
		f32(Math.max(8, 0.6 * drop));
		f32(0.6 + 0.15 * px);
		i32(degenerate ? (sun[2] <= -0.02 ? 0 : 255) : -1);
		f32(px * 2);
		i32(ra);
		i32(rb);
		i32(da);
		i32(db);
		f32((0.55 / (ra * px * 0.35)) * 0.125);
		f32((0.45 / (rb * px * 0.3)) * 0.125);
		f32(1 / (2 * ra * px));
		f32(3000); // SVF_R
		return words;
	};
	it("is byte-identical (80 bytes) over sun directions incl. degenerate", () => {
		const r = rng(11);
		const suns: number[][] = [
			[1, 0, 0.5],
			[0, 1, 0.5],
			[-1, -0.3, 0.2],
			[0.3, -1, 1],
			[0, 0, 1],
			[1, 1, -0.02],
			[1, 1, -0.5],
			[1e-5, 0, 1],
			[-1, 0, 0],
		];
		for (let i = 0; i < 20; i++)
			suns.push([r() * 2 - 1, r() * 2 - 1, r() * 2 - 0.5]);
		for (const res of [2, 64, 512, 2048])
			for (const px of [0.5, 1, 4.7, 30, 250, 1000])
				for (const sun of suns) {
					const { words } = reliefWords(res, px, sun as never);
					expect(words.byteLength).toBe(80);
					const ref = new Uint8Array(old(res, px, sun));
					const got = new Uint8Array(words);
					expect(Array.from(got)).toEqual(Array.from(ref));
				}
	});
});

describe("packCoarse", () => {
	const plan = (
		nH: number,
		step: number,
		nObs: number,
		nYaw: number,
		nPitch: number,
	): CoarsePlan => {
		const r = rng(nH + nObs);
		return {
			horizon: {
				step,
				elevation: Array.from({ length: nH }, () => r() * 20 - 5),
			} as never,
			az: Array.from({ length: nObs }, () => r() * 720 - 360),
			el: Array.from({ length: nObs }, () => r() * 30),
			w: Array.from({ length: nObs }, () => r()),
			wSum: nObs * 0.5,
			trunc: 3.5,
			dys: Array.from({ length: nYaw }, (_, i) => i * 0.3 - 5),
			dps: Array.from({ length: nPitch }, (_, i) => i * 0.2 - 1),
			sigmaYaw: 2,
			sigmaPitch: 1,
		};
	};
	const old = (
		p: CoarsePlan,
		hz: Float32Array,
		nBlk: number,
		epsScale: number,
	) => {
		const ub = new ArrayBuffer(32);
		const uU = new Uint32Array(ub);
		const uF = new Float32Array(ub);
		uU.set([
			p.az.length,
			p.dps.length,
			p.dys.length,
			p.horizon.elevation.length,
		]);
		uF.set([p.trunc, p.wSum], 4);
		uU[6] = nBlk;
		const eps = costBound(p, hz) * Math.max(1, epsScale);
		uF[7] = 2.5 * eps;
		return { ub, eps };
	};
	it("ub is byte-identical to the hand-packed words", () => {
		for (const [nH, step, nObs, nYaw, nPitch] of [
			[360, 1, 5, 10, 3],
			[720, 0.5, 40, 100, 300],
			[36, 10, 1, 1, 1],
		] as const)
			for (const epsScale of [undefined, 1, 4, 0.1, 1e6]) {
				const p = plan(nH, step, nObs, nYaw, nPitch);
				const got = packCoarse(p, { epsScale } as never);
				expect(got).not.toBeNull();
				if (!got) continue;
				const hz = profileHz(p.horizon) as Float32Array;
				const ref = old(p, hz, got.nBlk, epsScale ?? 1);
				expect(got.ub.byteLength).toBe(32);
				expect(bytes(got.ub)).toEqual(bytes(ref.ub));
				expect(got.eps).toBe(ref.eps);
			}
	});
	it("edge plan values (zero, negative, subnormal trunc / wSum)", () => {
		for (const trunc of [0, -1, 1e-40, 3.4e38])
			for (const wSum of [0, -0, 1 / 3, 1e30]) {
				const p = { ...plan(360, 1, 4, 6, 2), trunc, wSum };
				const got = packCoarse(p, {} as never);
				if (!got) continue;
				const hz = profileHz(p.horizon) as Float32Array;
				expect(bytes(got.ub)).toEqual(bytes(old(p, hz, got.nBlk, 1).ub));
			}
	});
});
