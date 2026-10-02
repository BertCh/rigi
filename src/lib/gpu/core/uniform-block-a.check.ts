// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The align / solve / horizon uniform packers (gpu/{align,solve,horizon}/uniforms.ts) are
// byte-identical to the hand-packed words they replaced. Each "old" block below is the former code,
// copied inline. Certified-f32 paths depend on exact bits, so inputs include -0, subnormals, u32 max,
// i32 min and NaN.
import { U_WORDS } from "../align/cert-refine";
import {
	CERT_U,
	packCertProbeUniform,
	packCertUniform,
	packPoseBoundUniform,
	packPoseGridUniform,
} from "../align/uniforms";
import {
	MOSAIC_MIP_P,
	packCertHorizonUniform,
	packRidgesUniform,
} from "../horizon/uniforms";
import { FOLD_U } from "../solve/uniforms";

let failed = 0;
let compared = 0;
function sameBytes(label: string, a: ArrayBuffer, b: ArrayBuffer) {
	compared++;
	const x = new Uint8Array(a);
	const y = new Uint8Array(b);
	const ok = x.length === y.length && x.every((v, i) => v === y[i]);
	if (!ok) {
		failed++;
		console.error(`FAIL ${label}\n  old ${x}\n  new ${y}`);
	}
}

const U32 = [0, 1, 7, 0x7ffffffe, 0xffffffff];
const SIZES = [1, 2, 7, 480, 1080, 4096, 65535];
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
];

// ---- align: cert.wgsl.ts struct U (128 B)
if (CERT_U.byteLength !== U_WORDS * 4) {
	failed++;
	console.error("FAIL cert U is", CERT_U.byteLength, "B, not", U_WORDS * 4);
}
for (const h of SIZES)
	for (const f of F32)
		for (const n of U32) {
			const w = 3 * h;
			const asp = [f, f * 1e-8];
			const nonce = n;
			const [slackDB, slackT, slackV, pen] = [f, -f, f / 3, 1e-30];
			const uw = new ArrayBuffer(U_WORDS * 4);
			const ui = new Uint32Array(uw);
			const ii = new Int32Array(uw);
			const uf = new Float32Array(uw);
			ui[0] = w;
			ui[1] = h;
			ui[2] = n;
			ui[3] = 7;
			ii[4] = Math.max(2, Math.round(h * 0.035));
			ii[5] = Math.max(1, Math.round(h * 0.012));
			ii[6] = Math.max(1, Math.round(h * 0.006));
			uf[7] = f;
			ui[8] = 256;
			ui[9] = nonce;
			uf[10] = f * 2;
			uf[11] = n;
			ui[12] = 4096;
			ui[13] = 0;
			uf[14] = slackDB;
			uf[15] = slackT;
			uf[16] = slackV;
			uf[17] = pen;
			uf[18] = f / 7;
			uf[19] = asp[0];
			uf[20] = asp[1];
			uf[21] = -f;
			sameBytes(
				`cert ${h} ${f} ${n}`,
				uw,
				packCertUniform({
					w,
					h,
					nDirs: n,
					nLanes: 7,
					aspect: f,
					window: 256,
					nonce,
					eCoef: f * 2,
					logCap: 4096,
					dB: slackDB,
					relT: slackT,
					relV: slackV,
					pen,
					e2Coef: f / 7,
					aspectHi: asp[0],
					aspectLo: asp[1],
					fault: -f,
				}),
			);
			// the probe: only nDirs
			const pw = new ArrayBuffer(U_WORDS * 4);
			new Uint32Array(pw)[2] = n;
			sameBytes(`cert probe ${n}`, pw, packCertProbeUniform(n));
		}

// ---- align: pose-bound struct U (48 B) and pose-grid struct U (32 B)
for (const h of SIZES)
	for (const f of F32)
		for (const n of U32) {
			const w = 4 * h;
			{
				const uw = new ArrayBuffer(48);
				const ui = new Uint32Array(uw);
				const ii = new Int32Array(uw);
				const uf = new Float32Array(uw);
				ui[0] = w;
				ui[1] = h;
				ui[2] = n;
				ui[3] = 99;
				ii[4] = Math.max(2, Math.round(h * 0.035));
				ii[5] = Math.max(1, Math.round(h * 0.012));
				ii[6] = Math.max(1, Math.round(h * 0.006));
				uf[7] = f;
				ui[8] = n;
				sameBytes(
					`pose-bound ${h} ${f} ${n}`,
					uw,
					packPoseBoundUniform({
						w,
						h,
						nDirs: n,
						nPoses: 99,
						aspect: f,
						nonce: n,
					}),
				);
			}
			{
				const uw = new ArrayBuffer(32);
				const ui = new Uint32Array(uw);
				const ii = new Int32Array(uw);
				const uf = new Float32Array(uw);
				ui[0] = w;
				ui[1] = h;
				ui[2] = n;
				ui[3] = 5;
				ii[4] = Math.max(2, Math.round(h * 0.035));
				ii[5] = Math.max(1, Math.round(h * 0.012));
				uf[6] = f;
				uf[7] = n;
				sameBytes(
					`pose-grid ${h} ${f} ${n}`,
					uw,
					packPoseGridUniform({ w, h, nDirs: n, nPoses: 5, aspect: f }),
				);
			}
		}

// ---- solve: FOLD_WGSL struct FU (16 B)
for (const nYaw of U32)
	for (const nBlk of [0, 3, 0xffffffff])
		for (const eps of F32) {
			const fb = new ArrayBuffer(16);
			new Uint32Array(fb).set([nYaw, nBlk, 17]);
			new Float32Array(fb)[3] = 2 * eps;
			sameBytes(
				`fold ${nYaw} ${nBlk} ${eps}`,
				fb,
				FOLD_U.pack({ nYaw, nBlk, nPitch: 17, e2: 2 * eps }),
			);
		}

// ---- horizon: certified.wgsl.ts struct U (32 B)
for (const n of U32)
	for (const nCols of U32)
		for (const f of F32) {
			const b = new ArrayBuffer(32);
			const u = new Uint32Array(b);
			const fl = new Float32Array(b);
			u[0] = n;
			u[1] = nCols;
			u[2] = 0;
			fl[3] = -3.0000001e38;
			fl[4] = f;
			fl[5] = -f * 3;
			sameBytes(
				`horizon cert ${n} ${nCols} ${f}`,
				b,
				packCertHorizonUniform({
					n,
					nCols,
					noHit: -3.0000001e38,
					lumpEnu: f,
					lumpEnuRel: -f * 3,
				}),
			);
		}

// ---- horizon: ridges.wgsl.ts struct U (64 B), including the f32 pair of the eye height
for (const h of [...F32, 2962.123456789, -12.000000001, 8848.86, 1e-40])
	for (const off of U32) {
		const ub = new ArrayBuffer(64);
		const uu = new Uint32Array(ub);
		const uf = new Float32Array(ub);
		uu[0] = 1024;
		uu[1] = 6;
		uu[2] = 300;
		uu[3] = off;
		uu[4] = off;
		uu[5] = 12;
		uu[6] = 0;
		uu[7] = off;
		uf[8] = 7.8e-8;
		uu[9] = 0;
		uf[10] = h;
		uf[11] = h - uf[10];
		uf[12] = Math.sin(0.8);
		uf[13] = Math.cos(0.8);
		sameBytes(
			`ridges ${h} ${off}`,
			ub,
			packRidgesUniform({
				nCols: 1024,
				nSlabs: 6,
				nDist: 300,
				nRings: off,
				azOff: off,
				distOff: 12,
				ringOff: 0,
				slabOff: off,
				inv2R: 7.8e-8,
				eyeH: h,
				sinP1: Math.sin(0.8),
				cosP1: Math.cos(0.8),
			}),
		);
	}

// ---- horizon: mosaic-mips.ts struct P (32 B)
for (const a of U32)
	for (const b of U32)
		for (const lvl of [0, 3, 10]) {
			const words = new Uint32Array([a, b, a, b, a, b, 1 << lvl, 0]);
			sameBytes(
				`mosaic-mip ${a} ${b} ${lvl}`,
				words.buffer,
				MOSAIC_MIP_P.pack({
					srcOff: a,
					srcW: b,
					srcH: a,
					dstOff: b,
					dstW: a,
					dstH: b,
					factor: 1 << lvl,
				}),
			);
		}

if (failed) {
	console.error(`${failed} of ${compared} uniform packings differ`);
	process.exit(1);
}
console.log(
	`uniform-block-a: ${compared} packings byte-identical to the hand-packed words`,
);
