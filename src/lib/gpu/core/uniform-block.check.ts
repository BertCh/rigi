// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// defineUniformBlock packs byte-identically to the hand-packed words it replaced.
import type { CameraUniforms } from "#/lib/deck-webgpu/camera";
import { packCullParams } from "#/lib/deck-webgpu/layers/terrain-cull-math";
import { defineUniformBlock } from "./uniform-block";

let failed = 0;
function sameBytes(label: string, a: ArrayBuffer, b: ArrayBuffer) {
	const x = new Uint8Array(a);
	const y = new Uint8Array(b);
	const ok = x.length === y.length && x.every((v, i) => v === y[i]);
	if (!ok) {
		failed++;
		console.error(`FAIL ${label}\n  old ${x}\n  new ${y}`);
	}
}

// edge values: negatives, signed zero, f32-unrepresentable doubles, subnormals, u32 max
const U32 = [0, 1, 7, 0x7ffffffe, 0xffffffff];
const I32 = [0, 1, -1, 4096, 2147483647, -2147483648];
const F32 = [0, -0, 0.1, -3.4e38, 1e-40, 1 / 3, 1e-5, 12345.678901234];

// geo-query P { n: u32, nonce: u32, w: i32, h: i32 }
{
	const blk = defineUniformBlock({
		n: "u32",
		nonce: "u32",
		w: "i32",
		h: "i32",
	});
	for (const n of U32)
		for (const nonce of U32)
			for (const w of I32)
				for (const h of [0, 2048, -5]) {
					const words = new ArrayBuffer(16);
					new Uint32Array(words).set([n, nonce]);
					new Int32Array(words).set([w, h], 2);
					sameBytes(
						`geo ${n} ${nonce} ${w} ${h}`,
						words,
						blk.pack({ n, nonce, w, h }),
					);
				}
}

// silhouette P (48 B)
{
	const blk = defineUniformBlock({
		w: "i32",
		h: "i32",
		groups: "i32",
		base: "u32",
		nonce: "u32",
		rmax: "f32",
		khi: "f32",
		klo: "f32",
		zlo: "f32",
		zhi: "f32",
		flo: "f32",
		fhi: "f32",
	});
	for (const W of I32)
		for (const base of U32)
			for (const f of F32) {
				const t = {
					rmax: f,
					khi: f * 3,
					klo: -f,
					zlo: 0.5 + f,
					zhi: f,
					flo: 1e-30,
					fhi: f / 7,
				};
				const words = new ArrayBuffer(48);
				const iv = new Int32Array(words);
				const uv = new Uint32Array(words);
				const fv = new Float32Array(words);
				iv[0] = W;
				iv[1] = 1080;
				iv[2] = 9;
				uv[3] = base;
				uv[4] = 12345;
				fv.set([t.rmax, t.khi, t.klo, t.zlo, t.zhi, t.flo, t.fhi], 5);
				sameBytes(
					`silhouette ${W} ${base} ${f}`,
					words,
					blk.pack({ w: W, h: 1080, groups: 9, base, nonce: 12345, ...t }),
				);
			}
}

// terrain-cull P (80 B): vec3 + f32 rows, vec2 + f32 + u32
{
	const blk = defineUniformBlock({
		eye: "vec3<f32>",
		near: "f32",
		right: "vec3<f32>",
		tanX: "f32",
		up: "vec3<f32>",
		tanY: "f32",
		fwd: "vec3<f32>",
		kx: "f32",
		off: "vec2<f32>",
		ky: "f32",
		n: "u32",
	});
	if (blk.byteLength !== 80) {
		failed++;
		console.error("FAIL terrain-cull block is", blk.byteLength, "B, not 80");
	}
	for (const a of F32)
		for (const b of F32)
			for (const n of U32) {
				const eye = [a, b, a * b];
				const right = [b, a, 1];
				const up = [0, a, b];
				const fwd = [a, 0, -b];
				const tanX = Math.abs(a) + 0.3;
				const tanY = Math.abs(b) + 0.2;
				const near = 0.1;
				const kx = Math.sqrt(1 + tanX * tanX);
				const ky = Math.sqrt(1 + tanY * tanY);
				const off: [number, number] = [a * tanX, b * tanY];
				const out = new ArrayBuffer(80);
				const fl = new Float32Array(out);
				fl.set([...eye, near], 0);
				fl.set([...right, tanX], 4);
				fl.set([...up, tanY], 8);
				fl.set([...fwd, kx], 12);
				fl.set([off[0], off[1], ky], 16);
				new Uint32Array(out)[19] = n;
				sameBytes(
					`cull ${a} ${b} ${n}`,
					out,
					blk.pack({ eye, near, right, tanX, up, tanY, fwd, kx, off, ky, n }),
				);
				// the migrated packCullParams itself
				const cam = {
					eye,
					near,
					right,
					up,
					forward: fwd,
					tanHalfX: tanX,
					tanHalfY: tanY,
					offset: [a, b],
				} as unknown as CameraUniforms;
				sameBytes(`packCullParams ${a} ${b} ${n}`, out, packCullParams(cam, n));
			}
}

// mat4x4 (the layout rule new kernels rely on): column-major, 16 B per column
{
	const blk = defineUniformBlock({ m: "mat4x4<f32>", s: "f32" });
	const m = Array.from({ length: 16 }, (_, i) => i + 0.5);
	const expect = new Float32Array(20);
	expect.set(m);
	expect[16] = 2;
	sameBytes("mat4", expect.buffer, blk.pack({ m, s: 2 }));
}

if (failed) {
	console.error(`${failed} uniform-block checks failed`);
	process.exit(1);
}
console.log(
	"uniform-block: all packings byte-identical to the hand-packed words",
);
