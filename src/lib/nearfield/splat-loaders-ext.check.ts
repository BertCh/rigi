// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WAG W2.6 check: SPZ / KSPLAT through @loaders.gl/splats into GaussianCloud.
// Run: npx tsx src/lib/nearfield/splat-loaders-ext.check.ts
// @loaders.gl/splats has no writer, so the fixtures are hand-built from the format layouts:
//  - SPZ v4 (zstd streams, node:zlib), v3 and v2 (one gzip stream): 24-bit fixed-point positions, log-byte
//    scales, alpha bytes, SPZ colour bytes (SH DC · 0.15 + 0.5), smallest-three (v3/v4) or xyz-byte (v2)
//    quaternions; expected values computed here from the byte values
//  - KSPLAT compression 0 (float32) and 1 (bucketed u16 centres, half-float scales / quaternions)
// Also: sniffing order (v1, PLY, SPZ, KSPLAT), parseSplat end to end through the lazy loaders, parseSplatSync
// refusing the async formats, and splat-loaders.ts importing @loaders.gl only dynamically.
import { readFileSync } from "node:fs";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { encodeSplatV1, SH_C0, to8 } from "./splat-io";
import {
	parseSplat,
	parseSplatSync,
	SplatKsplatLoaderLazy,
	SplatSpzLoaderLazy,
	SplatV1Loader,
	selectSplatLoader,
} from "./splat-loaders";
import { SplatKsplatLoader, SplatSpzLoader } from "./splat-loaders-ext";
import type { GaussianCloud } from "./types";

let failures = 0;
const ok = (c: boolean, m: string) => {
	console.log(`${c ? "PASS" : "FAIL"}  ${m}`);
	if (!c) failures++;
};
const sameArr = (a: ArrayLike<number>, b: ArrayLike<number>) =>
	a.length === b.length &&
	Array.prototype.every.call(a, (v: number, i: number) => Object.is(v, b[i]));
const maxAbs = (a: ArrayLike<number>, b: ArrayLike<number>) => {
	let m = 0;
	for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
	return m;
};

// ---------------------------------------------------------------- source splats

const N = 7;
const FB = 12; // SPZ fractional bits
/** Unit quaternions (w, x, y, z): identity, 90° about each axis, and two generic ones. */
const QUATS: [number, number, number, number][] = [
	[1, 0, 0, 0],
	[Math.SQRT1_2, Math.SQRT1_2, 0, 0],
	[Math.SQRT1_2, 0, -Math.SQRT1_2, 0],
	[0.5, 0.5, 0.5, 0.5],
	[-0.2, 0.4, -0.6, 0.66332495807108],
	[0.9, -0.1, 0.3, -0.3],
	[0.1, 0.2, 0.3, 0.9273618495495703],
].map(([w, x, y, z]) => {
	const q = Math.hypot(w, x, y, z);
	return [w / q, x / q, y / q, z / q] as [number, number, number, number];
});
const fixed = Array.from({ length: 3 * N }, (_, i) =>
	Math.round(Math.sin(i * 1.7) * 40000 + (i % 3) * 1000),
);
const scaleBytes = Array.from({ length: 3 * N }, (_, i) => (i * 37 + 50) % 256);
const alphaBytes = Array.from({ length: N }, (_, i) => (i * 61 + 5) % 256);
const colorBytes = Array.from({ length: 3 * N }, (_, i) => (i * 29 + 3) % 256);

/** Expected cloud from the byte values (the SPZ spec's decode, in f64, stored as f32). */
function expectedSpz(rotations: Float32Array): GaussianCloud {
	const colors = new Uint8Array(4 * N);
	for (let i = 0; i < N; i++) {
		for (let k = 0; k < 3; k++) {
			const dc = Math.fround((colorBytes[3 * i + k] / 255 - 0.5) / 0.15);
			colors[4 * i + k] = to8(0.5 + SH_C0 * dc);
		}
		colors[4 * i + 3] = to8(Math.fround(alphaBytes[i] / 255));
	}
	return {
		count: N,
		frame: "camera",
		positions: Float32Array.from(fixed, (f) => f / 2 ** FB),
		scales: Float32Array.from(scaleBytes, (b) => Math.exp(b / 16 - 10)),
		rotations,
		colors,
		provenance: new Uint8Array(N).fill(1),
	};
}

function positionBytes() {
	const b = new Uint8Array(9 * N);
	for (let i = 0; i < 3 * N; i++) {
		const v = fixed[i] & 0xffffff;
		b[3 * i] = v & 255;
		b[3 * i + 1] = (v >> 8) & 255;
		b[3 * i + 2] = (v >> 16) & 255;
	}
	return b;
}

/** Smallest-three quaternion (SPZ v3/v4): 2 bits largest index (x, y, z, w order), 3 × (9-bit magnitude, sign). */
function smallestThree(): { bytes: Uint8Array; decoded: Float32Array } {
	const bytes = new Uint8Array(4 * N);
	const decoded = new Float32Array(4 * N);
	const MASK = 511;
	for (let i = 0; i < N; i++) {
		const [w, x, y, z] = QUATS[i];
		let xyzw = [x, y, z, w];
		let largest = 0;
		for (let k = 1; k < 4; k++)
			if (Math.abs(xyzw[k]) > Math.abs(xyzw[largest])) largest = k;
		if (xyzw[largest] < 0) xyzw = xyzw.map((v) => -v);
		let comp = largest << 30;
		let shift = 0;
		const back = [0, 0, 0, 0];
		let sum = 0;
		for (let k = 3; k >= 0; k--) {
			if (k === largest) continue;
			const mag = Math.round((Math.abs(xyzw[k]) / Math.SQRT1_2) * MASK);
			const neg = xyzw[k] < 0 ? 1 : 0;
			comp |= (mag | (neg << 9)) << shift;
			shift += 10;
			const v = ((Math.SQRT1_2 * mag) / MASK) * (neg ? -1 : 1);
			back[k] = v;
			sum += v * v;
		}
		back[largest] = Math.sqrt(Math.max(0, 1 - sum));
		const u = comp >>> 0;
		bytes.set([u & 255, (u >>> 8) & 255, (u >>> 16) & 255, u >>> 24], 4 * i);
		const [bx, by, bz, bw] = back;
		const q = Math.hypot(bw, bx, by, bz);
		decoded.set([bw / q, bx / q, by / q, bz / q], 4 * i);
	}
	return { bytes, decoded };
}

/** SPZ v2 quaternion: x, y, z as signed bytes / 127 (w ≥ 0 implied). */
function xyzBytes(): { bytes: Uint8Array; decoded: Float32Array } {
	const bytes = new Uint8Array(3 * N);
	const decoded = new Float32Array(4 * N);
	for (let i = 0; i < N; i++) {
		let [w, x, y, z] = QUATS[i];
		if (w < 0) [w, x, y, z] = [-w, -x, -y, -z];
		const q = [x, y, z].map((v) => Math.round(v * 127));
		bytes.set(
			q.map((v) => v & 255),
			3 * i,
		);
		const [bx, by, bz] = q.map((v) => v / 127);
		const bw = Math.sqrt(Math.max(0, 1 - bx * bx - by * by - bz * bz));
		const n = Math.hypot(bw, bx, by, bz);
		decoded.set([bw / n, bx / n, by / n, bz / n], 4 * i);
	}
	return { bytes, decoded };
}

const concat = (parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
};
const ab = (u: Uint8Array) =>
	u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

function spzLegacy(version: 2 | 3) {
	const rot = version === 2 ? xyzBytes() : smallestThree();
	const head = new Uint8Array(16);
	const dv = new DataView(head.buffer);
	dv.setUint32(0, 0x5053474e, true);
	dv.setUint32(4, version, true);
	dv.setUint32(8, N, true);
	dv.setUint8(12, 0);
	dv.setUint8(13, FB);
	const raw = concat([
		head,
		positionBytes(),
		Uint8Array.from(alphaBytes),
		Uint8Array.from(colorBytes),
		Uint8Array.from(scaleBytes),
		rot.bytes,
	]);
	return { file: ab(new Uint8Array(gzipSync(raw))), rot: rot.decoded };
}

function spzV4() {
	const rot = smallestThree();
	const streams = [
		positionBytes(),
		Uint8Array.from(alphaBytes),
		Uint8Array.from(colorBytes),
		Uint8Array.from(scaleBytes),
		rot.bytes,
	];
	const packed = streams.map((s) => new Uint8Array(zstdCompressSync(s)));
	const head = new Uint8Array(32 + 16 * streams.length);
	const dv = new DataView(head.buffer);
	dv.setUint32(0, 0x5053474e, true);
	dv.setUint32(4, 4, true);
	dv.setUint32(8, N, true);
	dv.setUint8(12, 0);
	dv.setUint8(13, FB);
	dv.setUint8(14, 0);
	dv.setUint8(15, streams.length);
	dv.setUint32(16, 32, true);
	for (let k = 0; k < streams.length; k++) {
		dv.setBigUint64(32 + 16 * k, BigInt(packed[k].length), true);
		dv.setBigUint64(32 + 16 * k + 8, BigInt(streams[k].length), true);
	}
	return { file: ab(concat([head, ...packed])), rot: rot.decoded };
}

const cloudDiff = (got: GaussianCloud, want: GaussianCloud) => {
	const bad: string[] = [];
	if (got.count !== want.count) bad.push(`count ${got.count}`);
	if (got.frame !== want.frame) bad.push(`frame ${got.frame}`);
	if (!sameArr(got.positions, want.positions)) bad.push("positions");
	if (!sameArr(got.scales, want.scales)) bad.push("scales");
	if (!sameArr(got.rotations, want.rotations))
		bad.push(
			`rotations (max ${maxAbs(got.rotations, want.rotations).toExponential(1)})`,
		);
	if (!sameArr(got.colors, want.colors)) bad.push("colors");
	if (!sameArr(got.provenance, want.provenance)) bad.push("provenance");
	return bad;
};
const source = Float32Array.from(QUATS.flat());

for (const [label, fx] of [
	["SPZ v4 (zstd)", spzV4()],
	["SPZ v3 (gzip)", spzLegacy(3)],
	["SPZ v2 (gzip)", spzLegacy(2)],
] as const) {
	const sel = selectSplatLoader(fx.file);
	ok(sel === SplatSpzLoaderLazy, `${label}: sniffed as SPZ`);
	const got = await SplatSpzLoader.parse(fx.file);
	const bad = cloudDiff(got, expectedSpz(fx.rot));
	ok(
		bad.length === 0,
		`${label}: decoded == expected${bad.length ? ` (differs: ${bad.join(", ")})` : ""}`,
	);
	// quantisation of the source quaternions (sign: q and -q are the same rotation)
	let qerr = 0;
	for (let i = 0; i < N; i++) {
		const a = got.rotations.subarray(4 * i, 4 * i + 4);
		const b = source.subarray(4 * i, 4 * i + 4);
		const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
		qerr = Math.max(qerr, 1 - d);
	}
	ok(
		qerr < 1e-4,
		`${label}: rotations within quantisation of the source (1 − |q·q₀| ≤ ${qerr.toExponential(1)})`,
	);
	const viaLazy = await parseSplat(fx.file, { frame: "enu", provenance: 3 });
	ok(
		viaLazy.frame === "enu" &&
			viaLazy.provenance.every((p) => p === 3) &&
			sameArr(viaLazy.positions, got.positions) &&
			sameArr(viaLazy.colors, got.colors),
		`${label}: parseSplat (lazy import) == SplatSpzLoader, options applied`,
	);
}
{
	// SPZ coordinate conversion is the package's: RUB → LUF negates x and z (and the quaternion's x, z)
	const fx = spzV4();
	const a = await SplatSpzLoader.parse(fx.file);
	const b = await SplatSpzLoader.parse(fx.file, {
		"splat-spz": {
			sourceCoordinateSystem: "RUB",
			targetCoordinateSystem: "LUF",
		},
	});
	let flip = true;
	for (let i = 0; i < N; i++) {
		flip &&=
			Object.is(b.positions[3 * i], -a.positions[3 * i]) &&
			Object.is(b.positions[3 * i + 1], a.positions[3 * i + 1]) &&
			Object.is(b.positions[3 * i + 2], -a.positions[3 * i + 2]) &&
			Object.is(b.rotations[4 * i + 1], -a.rotations[4 * i + 1]) &&
			Object.is(b.rotations[4 * i + 3], -a.rotations[4 * i + 3]);
	}
	ok(
		flip,
		"SPZ: sourceCoordinateSystem RUB → LUF passed through to @loaders.gl/splats",
	);
}

// ---------------------------------------------------------------- KSPLAT

/** IEEE binary16 bits of a value exactly representable in half precision (normal or zero). */
function toHalf(v: number): number {
	if (v === 0) return Object.is(v, -0) ? 0x8000 : 0;
	const sign = v < 0 ? 0x8000 : 0;
	const a = Math.abs(v);
	const e = Math.floor(Math.log2(a));
	const m = Math.round((a / 2 ** e - 1) * 1024);
	if ((1 + m / 1024) * 2 ** e !== a) throw new Error(`${v} is not a half`);
	return sign | ((e + 15) << 10) | m;
}

const K_SCALES = [
	0.5, 0.25, 2, 0.125, 1, 0.75, 3, 0.0625, 1.5, 0.375, 4, 0.5, 0.25, 0.25, 0.25,
	1, 1, 1, 0.5, 2, 8,
];
/** Half-exact quaternions (w, x, y, z), normalised by the loader. */
const K_QUATS = [
	[1, 0, 0, 0],
	[0.5, 0.5, 0.5, 0.5],
	[0, 1, 0, 0],
	[0.5, -0.5, 0.5, -0.5],
	[0.75, 0.25, -0.5, 0.25],
	[0, 0, 0, 1],
	[-0.5, 0.5, 0.5, 0.5],
];
const K_COLORS = Array.from({ length: 4 * N }, (_, i) => (i * 53 + 11) % 256);
const K_POS = Array.from({ length: 3 * N }, (_, i) =>
	Math.fround(Math.cos(i) * 12.5),
);

function ksplat(level: 0 | 1) {
	const bytesPerSplat = level === 0 ? 44 : 24;
	const bucketBytes = level === 1 ? 12 : 0;
	const size = 4096 + 1024 + bucketBytes + bytesPerSplat * N;
	const buf = new ArrayBuffer(size);
	const dv = new DataView(buf);
	dv.setUint8(0, 0);
	dv.setUint8(1, 1);
	dv.setUint32(4, 1, true); // maxSectionCount
	dv.setUint32(8, 1, true); // sectionCount
	dv.setUint32(12, N, true);
	dv.setUint32(16, N, true);
	dv.setUint16(20, level, true);
	const sh = 4096;
	dv.setUint32(sh, N, true);
	dv.setUint32(sh + 4, N, true);
	const B = 64; // bucket block size (m)
	const center = [1.5, -2.25, 100];
	const qpos: number[] = [];
	if (level === 1) {
		dv.setUint32(sh + 8, N, true); // bucketSize
		dv.setUint32(sh + 12, 1, true); // bucketCount
		dv.setFloat32(sh + 16, B, true);
		dv.setUint16(sh + 20, 12, true); // bucketStorageSizeBytes
		dv.setUint32(sh + 24, 32767, true);
		dv.setUint32(sh + 32, 1, true); // fullBucketCount
		for (let k = 0; k < 3; k++)
			dv.setFloat32(4096 + 1024 + 4 * k, center[k], true);
	}
	const data = 4096 + 1024 + bucketBytes;
	const positions = new Float32Array(3 * N);
	for (let i = 0; i < N; i++) {
		const o = data + i * bytesPerSplat;
		for (let k = 0; k < 3; k++) {
			if (level === 0) {
				dv.setFloat32(o + 4 * k, K_POS[3 * i + k], true);
				positions[3 * i + k] = K_POS[3 * i + k];
			} else {
				const v = (i * 9001 + k * 17000 + 300) % 65536;
				qpos.push(v);
				dv.setUint16(o + 2 * k, v, true);
				positions[3 * i + k] = (v - 32767) * (B / 2 / 32767) + center[k];
			}
		}
		const so = o + (level === 0 ? 12 : 6);
		const vals = [
			K_SCALES[3 * i],
			K_SCALES[3 * i + 1],
			K_SCALES[3 * i + 2],
			...K_QUATS[i],
		];
		vals.forEach((v, k) => {
			if (level === 0) dv.setFloat32(so + 4 * k, v, true);
			else dv.setUint16(so + 2 * k, toHalf(v), true);
		});
		const co = o + (level === 0 ? 40 : 20);
		for (let k = 0; k < 4; k++) dv.setUint8(co + k, K_COLORS[4 * i + k]);
	}
	const rotations = new Float32Array(4 * N);
	for (let i = 0; i < N; i++) {
		const [w, x, y, z] = K_QUATS[i];
		const q = Math.hypot(w, x, y, z);
		rotations.set([w / q, x / q, y / q, z / q], 4 * i);
	}
	const want: GaussianCloud = {
		count: N,
		frame: "camera",
		positions,
		scales: Float32Array.from(K_SCALES.slice(0, 3 * N)),
		rotations,
		// KSPLAT stores display RGBA: the SH DC round trip must give the bytes back
		colors: Uint8Array.from(K_COLORS),
		provenance: new Uint8Array(N).fill(1),
	};
	return { file: buf, want };
}

for (const level of [0, 1] as const) {
	const { file, want } = ksplat(level);
	ok(
		selectSplatLoader(file) === SplatKsplatLoaderLazy,
		`KSPLAT level ${level}: sniffed as KSPLAT`,
	);
	const got = await SplatKsplatLoader.parse(file);
	const bad = cloudDiff(got, want);
	ok(
		bad.length === 0,
		`KSPLAT level ${level}: decoded == expected${bad.length ? ` (differs: ${bad.join(", ")})` : ""}`,
	);
	const viaLazy = await parseSplat(file, { provenance: 0 });
	ok(
		viaLazy.provenance.every((p) => p === 0) &&
			sameArr(viaLazy.scales, got.scales),
		`KSPLAT level ${level}: parseSplat (lazy import) == SplatKsplatLoader`,
	);
}

// ---------------------------------------------------------------- sniffing and wiring

{
	const v1 = encodeSplatV1({
		count: 1,
		frame: "camera",
		positions: new Float32Array(3),
		scales: new Float32Array(3),
		rotations: Float32Array.of(1, 0, 0, 0),
		colors: new Uint8Array(4),
		provenance: new Uint8Array(1),
	});
	ok(selectSplatLoader(v1) === SplatV1Loader, "v1 still sniffed first");
	ok(
		selectSplatLoader(new ArrayBuffer(8192)) === null,
		"8 KiB of zeros: no format (KSPLAT needs version 0.≥1)",
	);
	let threw = false;
	try {
		parseSplatSync(spzV4().file);
	} catch (e) {
		threw = /asynchronously/.test((e as Error).message);
	}
	ok(threw, "parseSplatSync refuses SPZ with a pointer to parseSplat");
	const src = readFileSync(
		new URL("./splat-loaders.ts", import.meta.url),
		"utf8",
	);
	ok(
		!/^import[^;]*from\s+["']@loaders\.gl/m.test(src) &&
			!/^import[^;]*from\s+["']\.\/splat-loaders-ext["']/m.test(src),
		"splat-loaders.ts has no static import of @loaders.gl or splat-loaders-ext",
	);
}

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nsplat-loaders-ext check: ok");
