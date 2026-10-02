// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { HEIGHTS_PARAMS, TILE_ROW } from "../look/relief-heights";
// The look / precision uniform blocks pack byte-identically to the hand-packed words they replaced
// (the old packing is copied inline). Edge values: u32 max, i32 min, -0, subnormals, NaN.
import {
	GUIDED_PARAMS,
	HAZE_COUNT_PARAMS,
	HAZE_PASS_PARAMS,
	HAZE_PREP_PARAMS,
	PACK_MASKS_PARAMS,
	TEX_HAZE_PARAMS,
	TEX_MASKS_PARAMS,
	TEX_PHOTO_PARAMS,
	TEX_STATS_PARAMS,
} from "../look/uniform-blocks";
import { PROBE_UNIFORM } from "../precision/ieee-probe";

let failed = 0;
let cases = 0;
/** old words zero-padded to the block's size (core/kernel.ts uniform() pads to 16 B) */
function sameBytes(label: string, old: ArrayBuffer, now: ArrayBuffer) {
	cases++;
	const y = new Uint8Array(now);
	const x = new Uint8Array(y.length);
	if (old.byteLength > y.length) {
		failed++;
		console.error(
			`FAIL ${label}: old ${old.byteLength} B > block ${y.length} B`,
		);
		return;
	}
	x.set(new Uint8Array(old));
	if (!x.every((v, i) => v === y[i])) {
		failed++;
		console.error(`FAIL ${label}\n  old ${x}\n  new ${y}`);
	}
}

const U32 = [0, 1, 7, 0x7ffffffe, 0xffffffff];
const SMALL = [0, 1, 2, 4096];
const F32 = [
	0,
	-0,
	0.1,
	-3.4e38,
	1e-40,
	1 / 3,
	1e-5,
	12345.678901234,
	Number.NaN,
];
const I32 = [0, 1, -1, 4096, 2147483647, -2147483648];
const u32Words = (...v: number[]) => new Uint32Array(v).buffer;

// guided-filter P { w, h, r: u32, eps: f32 }
for (const w of U32)
	for (const h of [0, 640, 0xffffffff])
		for (const r of [0, 3, 0xffffffff])
			for (const eps of F32) {
				const words = new ArrayBuffer(16);
				new Uint32Array(words, 0, 3).set([w, h, r]);
				new Float32Array(words, 12, 1)[0] = eps;
				sameBytes(
					`guided ${w} ${h} ${r} ${eps}`,
					words,
					GUIDED_PARAMS.pack({ w, h, r, eps }),
				);
			}

// TEX_PHOTO P (8 u32)
for (const w of U32)
	for (const ph of U32)
		for (const flip of [0, 1])
			for (const srgb of [0, 1])
				sameBytes(
					`photo ${w} ${ph}`,
					u32Words(w, 5, ph, flip, srgb, 0, 0, 0),
					TEX_PHOTO_PARAMS.pack({ W: w, H: 5, srcH: ph, flip, srgb }),
				);

// TEX_MASKS P (16 u32)
for (const a of U32)
	for (const b of SMALL)
		for (const f of [0, 1]) {
			sameBytes(
				`masks ${a} ${b} ${f}`,
				u32Words(a, b, a, b, a, f, f, f ^ 1, a, f, f, b, f, 0, 0, 0),
				TEX_MASKS_PARAMS.pack({
					w: a,
					h: b,
					gw: a,
					gh: b,
					ss: a,
					flipGeo: f,
					sky: f,
					flipSky: f ^ 1,
					skyH: a,
					fg: f,
					flipFg: f,
					fgH: b,
					geoR: f,
				}),
			);
		}

// TEX_STATS P (12 u32)
for (const a of U32)
	for (const b of SMALL)
		for (const f of [0, 1])
			sameBytes(
				`tex-stats ${a} ${b} ${f}`,
				u32Words(a, b, a, f, f ^ 1, f, f, a, f, 0, 0, 0),
				TEX_STATS_PARAMS.pack({
					w: a,
					h: b,
					gh: a,
					flipGeo: f,
					flipLayer: f ^ 1,
					fg: f,
					flipFg: f,
					fgH: a,
					geoR: f,
				}),
			);

// TEX_HAZE P (12 u32)
for (const a of U32)
	for (const b of SMALL)
		for (const f of [0, 1])
			sameBytes(
				`tex-haze ${a} ${b} ${f}`,
				u32Words(a, b, a, f, f, f ^ 1, a, f, f, b, f, 0),
				TEX_HAZE_PARAMS.pack({
					W: a,
					H: b,
					gh: a,
					flipGeo: f,
					sky: f,
					flipSky: f ^ 1,
					skyH: a,
					fg: f,
					flipFg: f,
					fgH: b,
					geoR: f,
				}),
			);

// PACK_MASKS P (8 u32)
for (const a of U32)
	for (const b of SMALL)
		for (const f of [0, 1])
			sameBytes(
				`pack ${a} ${b} ${f}`,
				u32Words(a, b, a, b, f, f ^ 1, 0, 0),
				PACK_MASKS_PARAMS.pack({
					w: a,
					h: b,
					rowWords: a,
					fmt: b,
					cut: f,
					fg: f ^ 1,
				}),
			);

// haze prep P (36 B: 5 u32 + 4 f32, uniform() pads to 48)
for (const W of U32)
	for (const rad of [1, 3, 0xffffffff])
		for (const lo of F32) {
			const words = new ArrayBuffer(36);
			new Uint32Array(words, 0, 5).set([W, 7, 1024, rad, 0xffffffff]);
			new Float32Array(words, 20, 4).set([
				lo,
				lo - 2,
				Math.max(150, 100),
				1e-40,
			]);
			sameBytes(
				`haze-prep ${W} ${rad} ${lo}`,
				words,
				HAZE_PREP_PARAMS.pack({
					W,
					H: 7,
					pw: 1024,
					rad,
					fgRad: 0xffffffff,
					lo,
					span: lo - 2,
					rmin: Math.max(150, 100),
					rmax: 1e-40,
				}),
			);
		}

// haze pass S and count C (4 u32)
for (const a of U32)
	for (const p of [0, 1, 2]) {
		sameBytes(
			`pass ${a} ${p}`,
			new Uint32Array([a, 9, p, 0]).buffer,
			HAZE_PASS_PARAMS.pack({ W: a, H: 9, pass_: p }),
		);
		sameBytes(
			`count ${a} ${p}`,
			new Uint32Array([a, p, 0, 0]).buffer,
			HAZE_COUNT_PARAMS.pack({ N: a, nBlk: p }),
		);
		sameBytes(
			`count-K ${a} ${p}`,
			new Uint32Array([a, 3, p, 0]).buffer,
			HAZE_COUNT_PARAMS.pack({ N: a, nBlk: 3, K: p }),
		);
	}

// ieee-probe U (4 u32)
for (const n of U32)
	sameBytes(
		`probe ${n}`,
		new Uint32Array([n, 0, 0, 0]).buffer,
		PROBE_UNIFORM.pack({ n }),
	);

// relief-heights P { res, nT: u32, hole: f32, pad }
for (const res of U32)
	for (const nT of U32)
		for (const hole of F32) {
			const uni = new ArrayBuffer(16);
			const u = new DataView(uni);
			u.setUint32(0, res, true);
			u.setUint32(4, nT, true);
			u.setFloat32(8, hole, true);
			sameBytes(
				`heights ${res} ${nT} ${hole}`,
				uni,
				HEIGHTS_PARAMS.pack({ res, nT, hole }),
			);
		}

// relief-heights Tile row (12 words, p0 / p1 left 0), as written at row offset o
for (const ax of F32)
	for (const S of U32)
		for (const i of I32) {
			const buf = new ArrayBuffer(48);
			const dv = new DataView(buf);
			let o = 0;
			dv.setFloat32(o, ax, true);
			dv.setFloat32(o + 4, -ax, true);
			dv.setFloat32(o + 8, 0.1, true);
			dv.setUint32(o + 12, S, true);
			dv.setUint32(o + 16, 0xffffffff, true);
			dv.setUint32(o + 20, S, true);
			o += 24;
			for (const v of [i, i, -i | 0, 5]) {
				dv.setInt32(o, v, true);
				o += 4;
			}
			sameBytes(
				`tile ${ax} ${S} ${i}`,
				buf,
				TILE_ROW.pack({
					ax,
					ay: -ax,
					k: 0.1,
					S,
					stride: 0xffffffff,
					off: S,
					i0: i,
					i1: i,
					j0: -i | 0,
					j1: 5,
				}),
			);
		}

if (failed) {
	console.error(`uniform-block-look: ${failed} of ${cases} case(s) FAILED`);
	process.exit(1);
}
console.log(`uniform-block-look: ${cases} cases byte-identical`);
