// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Unpacking of the geometry target (rgba32float: xyz = ENU m, w = range, 0 = sky) into the planes
// of the GeometrySource contract (deck/geometry-source.ts): range[i] = w, +Infinity where w is not
// > 0 (sky); xyz[3i..] = the texel's xyz, NaN for sky. Three implementations of one rule:
//   unpackGeometryCpu        the CPU loop (the diet-off path and the reference the check compares to)
//   GEO_UNPACK_WGSL          the same rule on the render device (GeoQueryGpu.unpack), so only the
//                            planes a consumer needs cross to the CPU (range 4 B per pixel, xyz 12 B
//                            instead of the whole 16 B texel, no stride copy, no CPU loop)
//   unpackGeometryReference  the WGSL's logic in TS over u32 words (geo-unpack.check.ts proves it
//                            byte-equal to the CPU loop on sky / NaN / Inf / denormal / -0 words)
//
// Exactness argument. Every output word of the kernel is a pure copy of one input word or a select
// between an input word and a constant: no arithmetic is done on texel values, only integer
// comparisons of their bit patterns (the "terrain" test w > 0 as 0 < bits <= 0x7f800000, which is
// exactly the float test for positive non-NaN w, +Infinity included). Sky words are the constants
// of the CPU loop: +Infinity (0x7f800000) for range, the canonical NaN (0x7fc00000, what JS writes
// into a Float32Array) for xyz. The one thing a GPU may do to a copied float is flush a denormal or
// canonicalise a NaN payload; the kernel cannot see a flushed word, so, as the point queries do
// (deck/geo-query.ts), it flags any copied word that is a denormal or a NaN (tag word 1) and the
// caller then reads the target back in full and runs the CPU loop instead. In practice neither
// occurs, so the flag stays 0 and the planes equal the CPU loop's byte for byte.
//
// Layout of the outputs: `rng` n words, `pos` 3n words (x y z per pixel), `tag` 2 words: the call's
// nonce (written by pixel 0, so a run whose commands did not execute is rejected) and the odd flag.
export const UNPACK_RANGE = 1;
export const UNPACK_XYZ = 2;

/** w > 0 for a positive non-NaN float, as bits: 0 < bits <= +Infinity. */
const TERRAIN_MAX_BITS = 0x7f800000;
const SKY_RANGE_BITS = 0x7f800000;
const SKY_XYZ_BITS = 0x7fc00000;
export const UNPACK_WG = 256;

export const GEO_UNPACK_WGSL = /* wgsl */ `
struct P { n: u32, nonce: u32, w: u32, mode: u32 };
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var geo: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> rng: array<u32>;
@group(0) @binding(3) var<storage, read_write> pos: array<u32>;
@group(0) @binding(4) var<storage, read_write> tag: array<atomic<u32>>;

// Copies and selects only: no arithmetic on texel values (see geo-unpack.ts).
fn isTerrain(b: u32) -> bool { return b != 0u && b <= ${TERRAIN_MAX_BITS}u; }
fn isOdd(b: u32) -> bool {
	let m = b & 0x7fffffu;
	let e = (b >> 23u) & 0xffu;
	return m != 0u && (e == 0u || e == 0xffu);
}

@compute @workgroup_size(${UNPACK_WG})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
	let i = id.x;
	if (i >= prm.n) { return; }
	let t = textureLoad(geo, vec2<i32>(i32(i % prm.w), i32(i / prm.w)), 0);
	let bw = bitcast<u32>(t.w);
	let terrain = isTerrain(bw);
	var odd = terrain && isOdd(bw);
	if ((prm.mode & ${UNPACK_RANGE}u) != 0u) {
		rng[i] = select(${SKY_RANGE_BITS}u, bw, terrain);
	}
	if ((prm.mode & ${UNPACK_XYZ}u) != 0u) {
		let bx = bitcast<u32>(t.x);
		let by = bitcast<u32>(t.y);
		let bz = bitcast<u32>(t.z);
		pos[i * 3u] = select(${SKY_XYZ_BITS}u, bx, terrain);
		pos[i * 3u + 1u] = select(${SKY_XYZ_BITS}u, by, terrain);
		pos[i * 3u + 2u] = select(${SKY_XYZ_BITS}u, bz, terrain);
		odd = odd || (terrain && (isOdd(bx) || isOdd(by) || isOdd(bz)));
	}
	if (odd) { atomicOr(&tag[1], 1u); }
	if (i == 0u) { atomicStore(&tag[0], prm.nonce); }
}
`;

/** xyzr (top-first, tightly packed texels) → range (+ xyz). No row flip. The CPU twin of the kernel. */
export function unpackGeometryCpu(
	xyzr: Float32Array,
	range: Float32Array,
	xyz?: Float32Array,
) {
	const n = range.length;
	if (!xyz) {
		for (let i = 0; i < n; i++) {
			const r = xyzr[i * 4 + 3];
			range[i] = r > 0 ? r : Number.POSITIVE_INFINITY;
		}
		return;
	}
	for (let i = 0; i < n; i++) {
		const o = i * 4;
		const r = xyzr[o + 3];
		if (r > 0) {
			range[i] = r;
			xyz[i * 3] = xyzr[o];
			xyz[i * 3 + 1] = xyzr[o + 1];
			xyz[i * 3 + 2] = xyzr[o + 2];
		} else {
			range[i] = Number.POSITIVE_INFINITY;
			xyz[i * 3] = xyz[i * 3 + 1] = xyz[i * 3 + 2] = Number.NaN;
		}
	}
}

const isOddBits = (b: number) => {
	const m = b & 0x7fffff;
	const e = (b >>> 23) & 0xff;
	return m !== 0 && (e === 0 || e === 0xff);
};

/**
 * The kernel's logic over the texel words (`texels`: 4 u32 per pixel, x y z w bit patterns),
 * statement for statement. `mode` is UNPACK_RANGE | UNPACK_XYZ. `odd` mirrors tag word 1.
 */
export function unpackGeometryReference(
	texels: Uint32Array,
	n: number,
	mode: number,
) {
	const rng = new Uint32Array(mode & UNPACK_RANGE ? n : 0);
	const pos = new Uint32Array(mode & UNPACK_XYZ ? n * 3 : 0);
	let odd = false;
	for (let i = 0; i < n; i++) {
		const bw = texels[i * 4 + 3];
		const terrain = bw !== 0 && bw <= TERRAIN_MAX_BITS;
		let o = terrain && isOddBits(bw);
		if (mode & UNPACK_RANGE) rng[i] = terrain ? bw : SKY_RANGE_BITS;
		if (mode & UNPACK_XYZ) {
			const bx = texels[i * 4];
			const by = texels[i * 4 + 1];
			const bz = texels[i * 4 + 2];
			pos[i * 3] = terrain ? bx : SKY_XYZ_BITS;
			pos[i * 3 + 1] = terrain ? by : SKY_XYZ_BITS;
			pos[i * 3 + 2] = terrain ? bz : SKY_XYZ_BITS;
			o = o || (terrain && (isOddBits(bx) || isOddBits(by) || isOddBits(bz)));
		}
		if (o) odd = true;
	}
	return { rng, pos, odd };
}
