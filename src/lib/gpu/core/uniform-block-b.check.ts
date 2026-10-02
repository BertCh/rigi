// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The horizon march, skyglobal, skyline, sky prep / refine and splat-sort uniform packers
// (gpu/{horizon,skyglobal,skyline,sky,splat-sort}/uniforms.ts) are byte-identical to the
// hand-packed words they replaced. Each "old" function below is the former code, copied inline.
// Inputs include -0, subnormals, f32 max, NaN (canonical and with payload bits), Infinity,
// u32 max and non-integers (ToUint32 truncation).
import { MARCH_U, packMarchUniform } from "../horizon/uniforms";
import { packSkyPrepParams, packSkyRefineParams } from "../sky/uniforms";
import { packSkyGlobalUniform, SKYGLOBAL_U } from "../skyglobal/uniforms";
import { packSkylineParams } from "../skyline/uniforms";
import { packSplatSortParams } from "../splat-sort/uniforms";

let failed = 0;
let compared = 0;
function sameBytes(label: string, a: ArrayBuffer, b: ArrayBuffer) {
	compared++;
	const x = new Uint8Array(a);
	const y = new Uint8Array(b);
	const ok = x.length === y.length && x.every((v, i) => v === y[i]);
	if (!ok) {
		failed++;
		if (failed < 20) console.error(`FAIL ${label}\n  old ${x}\n  new ${y}`);
	}
}

const NAN_PAYLOADS = Array.from(
	new Float32Array(
		new Uint32Array([0x7fc00001, 0xffc12345, 0x7f800001]).buffer,
	),
);
const F32 = [
	0,
	-0,
	0.1,
	-3.4e38,
	3.4028234663852886e38,
	1e-40,
	-1e-45,
	1 / 3,
	1e-5,
	12345.678901234,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	...NAN_PAYLOADS,
];
const U32 = [0, 1, 7, 2.5, 0x7ffffffe, 0xffffffff];
const SIZES = [1, 2, 7, 480, 1080, 4096, 65535];

// seeded inputs (mulberry32)
let seed = 0x5eed;
function rnd() {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const anyU32 = () => (rnd() < 0.5 ? pick(U32) : Math.floor(rnd() * 2 ** 32));
const anyF32 = () =>
	rnd() < 0.5 ? pick(F32) : (rnd() - 0.5) * 10 ** (rnd() * 20 - 10);

// ---- horizon.wgsl.ts struct U (64 B)
function oldMarch(v: number[], mipSkip: boolean, f: number[]) {
	const ub = new ArrayBuffer(64);
	const uu = new Uint32Array(ub);
	const uf = new Float32Array(ub);
	for (let i = 0; i < 7; i++) uu[i] = v[i];
	uu[7] = mipSkip ? 1 : 0;
	uf[8] = f[0];
	uf[9] = f[1];
	uf[10] = f[2];
	uu[11] = 1_000_000;
	uu[12] = 0;
	return ub;
}
if (MARCH_U.byteLength !== 64) {
	failed++;
	console.error("FAIL march U is", MARCH_U.byteLength, "B");
}
for (let k = 0; k < 4000; k++) {
	const v = Array.from({ length: 7 }, () => (k < 100 ? pick(SIZES) : anyU32()));
	const f = [anyF32(), anyF32(), anyF32()];
	const mipSkip = rnd() < 0.5;
	sameBytes(
		`march ${v} ${f} ${mipSkip}`,
		oldMarch(v, mipSkip, f),
		packMarchUniform({
			nAz: v[0],
			nEyes: v[1],
			eyeStride: v[2],
			azOff: v[3],
			eyeOff: v[4],
			ringOff: v[5],
			nRings: v[6],
			mipSkip,
			stepFactor: f[0],
			nearFactor: f[1],
			inv2R: f[2],
		}),
	);
}

// ---- skyglobal.wgsl.ts struct U (48 B)
function oldSkyGlobal(u: number[], cntMin: number, f: (number | undefined)[]) {
	const ub = new ArrayBuffer(48);
	const uu = new Uint32Array(ub);
	const uf = new Float32Array(ub);
	uu.set([u[0], u[1], u[2], u[3], u[4], u[5], Math.floor(cntMin) + 1, u[6]]);
	uf.set([f[0] ?? 5e-3, f[1] ?? 1e-5, f[2] as number, f[3] as number], 8);
	return ub;
}
if (SKYGLOBAL_U.byteLength !== 48) {
	failed++;
	console.error("FAIL skyglobal U is", SKYGLOBAL_U.byteLength, "B");
}
for (let k = 0; k < 4000; k++) {
	const u = Array.from({ length: 7 }, () => (k < 100 ? pick(SIZES) : anyU32()));
	const cntMin = pick([0, 0.5, 2.9, 7, 1e6, -0.5, 4294967294.5]);
	const f = [
		rnd() < 0.2 ? undefined : anyF32(),
		rnd() < 0.2 ? undefined : anyF32(),
		anyF32(),
		anyF32(),
	];
	sameBytes(
		`skyglobal ${u} ${cntMin} ${f}`,
		oldSkyGlobal(u, cntMin, f),
		packSkyGlobalUniform({
			w: u[0],
			h: u[1],
			n: u[2],
			sy: u[3],
			nYaw: u[4],
			nCombo: u[5],
			cntMin,
			cap: u[6],
			eps: f[0],
			zeps: f[1],
			smin: f[2] as number,
			smax: f[3] as number,
		}),
	);
}

// ---- skyline.wgsl.ts struct P (32 B)
function oldSkyline(w: number, h: number, sigma: number) {
	const words = new ArrayBuffer(32);
	new Uint32Array(words).set([w, h, w * h]);
	new Float32Array(words)[4] = sigma;
	return words;
}
for (const w of SIZES)
	for (const h of SIZES)
		for (const s of F32)
			sameBytes(
				`skyline ${w} ${h} ${s}`,
				oldSkyline(w, h, s),
				packSkylineParams(w, h, s),
			);

// ---- sky prep.wgsl.ts / refine.wgsl.ts struct P (32 B each)
function oldPrep(W: number, H: number, lw: number, lh: number) {
	const rowBytes = Math.ceil((W * 4) / 256) * 256;
	const words = new Uint32Array(8);
	words.set([W, H, lw, lh, rowBytes / 4]);
	return words.buffer;
}
function oldRefine(u: number[], eps: number) {
	const words = new ArrayBuffer(32);
	new Uint32Array(words, 0, 6).set(u);
	new Float32Array(words, 24, 1)[0] = eps;
	return words;
}
for (const W of SIZES)
	for (const H of SIZES) {
		const lw = Math.max(1, Math.round(W / 4));
		const lh = Math.max(1, Math.round(H / 4));
		const rowBytes = Math.ceil((W * 4) / 256) * 256;
		sameBytes(
			`sky prep ${W} ${H}`,
			oldPrep(W, H, lw, lh),
			packSkyPrepParams(W, H, lw, lh, rowBytes),
		);
		for (const eps of F32) {
			const u = [lw, lh, W, H, pick([0, 3, 7]), pick([0, 3, 0xffffffff])];
			sameBytes(
				`sky refine ${u} ${eps}`,
				oldRefine(u, eps),
				packSkyRefineParams({
					lw: u[0],
					lh: u[1],
					W: u[2],
					H: u[3],
					r: u[4],
					br: u[5],
					eps,
				}),
			);
		}
	}

// ---- splat-sort.wgsl.ts struct Params (32 B)
function oldSplat(row: readonly number[], count: number, blocks: number) {
	const w = new ArrayBuffer(32);
	const fl = new Float32Array(w);
	const u = new Uint32Array(w);
	fl.set(row, 0);
	fl[4] = 0;
	u[5] = count;
	u[6] = blocks;
	return w;
}
for (let k = 0; k < 4000; k++) {
	const row = [anyF32(), anyF32(), anyF32(), anyF32()] as const;
	const count = anyU32();
	const blocks = anyU32();
	sameBytes(
		`splat ${row} ${count} ${blocks}`,
		oldSplat(row, count, blocks),
		packSplatSortParams(row, count, blocks),
	);
}

if (failed) {
	console.error(`uniform-block-b: ${failed}/${compared} cases differ`);
	process.exit(1);
}
console.log(`uniform-block-b: ${compared} cases byte-identical`);
