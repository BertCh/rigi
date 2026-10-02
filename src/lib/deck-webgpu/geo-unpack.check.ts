// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check for the GPU unpack of the geometry target (geo-unpack.ts), no GPU.
// Run: npx tsx src/lib/deck-webgpu/geo-unpack.check.ts
// The kernel's logic (unpackGeometryReference, statement for statement) is run on synthetic
// textures and compared BYTE FOR BYTE with the CPU loop the engine used before (unpackGeometryCpu):
//   1. words that are neither denormal nor NaN where copied (sky, NaN / -0 / negative / -Infinity /
//      denormal-negative w, +Infinity, -0 and huge xyz, minimum normals): odd = false and both planes
//      equal the CPU loop's bytes, in all three modes (range, xyz, both);
//   2. a positive denormal w, or a denormal / NaN xyz word next to a positive w: odd = true (the
//      caller then takes the CPU loop, so the GPU never has to be trusted with such a word);
//   3. the WGSL source has no arithmetic on texel values (no float ops, no f32 casts).
import {
	GEO_UNPACK_WGSL,
	UNPACK_RANGE,
	UNPACK_XYZ,
	unpackGeometryCpu,
	unpackGeometryReference,
} from "./geo-unpack";

let failures = 0;
const fail = (msg: string) => {
	failures++;
	console.log(`FAIL ${msg}`);
};
let seed = 4242;
const rand = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 2 ** 32;
};
const pick = <T>(a: readonly T[]) => a[Math.floor(rand() * a.length)];

const W_CLEAN = [
	0x00000000, // +0 (sky)
	0x80000000, // -0 (sky)
	0x7fc00000, // NaN
	0xffc00000, // negative NaN
	0x7f800001, // signalling NaN
	0xff800000, // -Infinity
	0xbf800000, // -1
	0x80000001, // negative denormal
	0x7f800000, // +Infinity (copied: w > 0)
	0x3f800000, // 1
	0x00800000, // minimum positive normal
	0x7f7fffff, // maximum finite
	0x461c4000, // 10000
];
const XYZ_CLEAN = [
	0x00000000, 0x80000000, 0x3f800000, 0xbf800000, 0x7f800000, 0xff800000,
	0x00800000, 0x7f7fffff, 0xc5a1e000, 0x45a1e000,
];
const W_ODD = [0x00000001, 0x007fffff, 0x00400000];
const XYZ_ODD = [0x00000001, 0x80000001, 0x7fc00000, 0x7f800001, 0xffc00000];

function texels(n: number, w: readonly number[], xyz: readonly number[]) {
	const t = new Uint32Array(n * 4);
	for (let i = 0; i < n; i++) {
		t[i * 4] = pick(xyz);
		t[i * 4 + 1] = pick(xyz);
		t[i * 4 + 2] = pick(xyz);
		t[i * 4 + 3] = pick(w);
	}
	return t;
}

const bytesEqual = (a: Uint32Array, b: Float32Array) => {
	const u = new Uint32Array(b.buffer, b.byteOffset, b.length);
	if (u.length !== a.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== u[i]) return false;
	return true;
};

// ---------- 1. clean words: byte equality ----------
const N = 4096;
for (const mode of [UNPACK_RANGE, UNPACK_XYZ, UNPACK_RANGE | UNPACK_XYZ]) {
	const t = texels(N, W_CLEAN, XYZ_CLEAN);
	const ref = unpackGeometryReference(t, N, mode);
	if (ref.odd) fail(`mode ${mode}: clean words flagged odd`);
	const range = new Float32Array(N);
	const xyz = new Float32Array(N * 3);
	unpackGeometryCpu(new Float32Array(t.buffer), range, xyz);
	if (mode & UNPACK_RANGE && !bytesEqual(ref.rng, range))
		fail(`mode ${mode}: range plane differs from the CPU loop`);
	if (mode & UNPACK_XYZ && !bytesEqual(ref.pos, xyz))
		fail(`mode ${mode}: xyz plane differs from the CPU loop`);
	if (!(mode & UNPACK_RANGE) && ref.rng.length) fail("range plane not skipped");
	if (!(mode & UNPACK_XYZ) && ref.pos.length) fail("xyz plane not skipped");
	// the range-only CPU loop (no xyz plane) agrees too
	const r2 = new Float32Array(N);
	unpackGeometryCpu(new Float32Array(t.buffer), r2);
	if (!bytesEqual(unpackGeometryReference(t, N, UNPACK_RANGE).rng, r2))
		fail("range-only CPU loop differs");
}

// every clean w alone, against every clean xyz word (exhaustive pairs, one pixel each)
for (const w of W_CLEAN)
	for (const x of XYZ_CLEAN) {
		const t = new Uint32Array([x, x, x, w]);
		const ref = unpackGeometryReference(t, 1, UNPACK_RANGE | UNPACK_XYZ);
		const range = new Float32Array(1);
		const xyz = new Float32Array(3);
		unpackGeometryCpu(new Float32Array(t.buffer), range, xyz);
		if (ref.odd || !bytesEqual(ref.rng, range) || !bytesEqual(ref.pos, xyz))
			fail(`w ${w.toString(16)} x ${x.toString(16)}`);
	}

// ---------- 2. odd words are flagged ----------
for (const w of W_ODD) {
	const t = new Uint32Array([0x3f800000, 0x3f800000, 0x3f800000, w]);
	if (!unpackGeometryReference(t, 1, UNPACK_RANGE).odd)
		fail(`positive denormal w ${w.toString(16)} not flagged (range)`);
	if (!unpackGeometryReference(t, 1, UNPACK_XYZ).odd)
		fail(`positive denormal w ${w.toString(16)} not flagged (xyz)`);
}
for (const x of XYZ_ODD)
	for (let c = 0; c < 3; c++) {
		const t = new Uint32Array([0x3f800000, 0x3f800000, 0x3f800000, 0x3f800000]);
		t[c] = x;
		if (!unpackGeometryReference(t, 1, UNPACK_XYZ).odd)
			fail(`odd xyz word ${x.toString(16)} channel ${c} not flagged`);
		if (unpackGeometryReference(t, 1, UNPACK_RANGE).odd)
			fail("range-only mode flagged an xyz word it does not copy");
		// the same word under a sky w is never copied: not flagged
		t[3] = 0;
		if (unpackGeometryReference(t, 1, UNPACK_XYZ | UNPACK_RANGE).odd)
			fail(`sky pixel flagged for xyz word ${x.toString(16)}`);
	}
{
	const t = texels(N, W_CLEAN.concat(W_ODD), XYZ_CLEAN.concat(XYZ_ODD));
	if (!unpackGeometryReference(t, N, UNPACK_RANGE | UNPACK_XYZ).odd)
		fail("random mixed texture with odd words not flagged");
}

// ---------- 3. the WGSL does no arithmetic on texel values ----------
if (/bitcast<f32>|\bf32\(|\bmax\(|\bmin\(|\babs\(/.test(GEO_UNPACK_WGSL))
	fail("WGSL has float casts / math");
// (output index expressions such as pos[i * 3u + 1u] are addresses, not texel values: dropped)
for (const line of GEO_UNPACK_WGSL.split("\n"))
	if (
		/\b(bw|bx|by|bz|t\.[xyzw])\b/.test(line) &&
		/[+\-*/]/.test(line.replace(/\[[^\]]*\]/g, "[]"))
	)
		fail(`WGSL line computes on a texel value: ${line.trim()}`);

if (failures) {
	console.log(`geo-unpack: ${failures} failure(s)`);
	process.exit(1);
}
console.log("geo-unpack: ok");
