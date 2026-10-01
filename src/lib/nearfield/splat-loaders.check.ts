// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { decodeGaussianPly, encodeSplatV1 } from "./splat-io";
// Checks the loaders.gl-shaped splat loaders. Run: npx tsx src/lib/nearfield/splat-loaders.check.ts
// - .splat-v1: write -> parse -> write is byte-identical (ENU + source array, camera frame).
// - PLY: a synthetic 3DGS fixture built here parses identically through SplatPlyLoader and the
//   decodeGaussianPly path, and to hand-computed values.
import {
	parseSplatSync,
	SPLAT_LOADERS,
	SplatPlyLoader,
	SplatV1Loader,
	selectSplatLoader,
} from "./splat-loaders";
import type { GaussianCloud } from "./types";

let failures = 0;
const ok = (c: boolean, m: string) => {
	if (!c) {
		failures++;
		console.error(`FAIL ${m}`);
	}
};
const same = (a: ArrayLike<number>, b: ArrayLike<number>) =>
	a.length === b.length &&
	Array.prototype.every.call(a, (v, i) => Object.is(v, b[i]));
const sameBytes = (a: ArrayBuffer, b: ArrayBuffer) =>
	same(new Uint8Array(a), new Uint8Array(b));
const sameCloud = (a: GaussianCloud, b: GaussianCloud) =>
	a.count === b.count &&
	a.frame === b.frame &&
	same(a.positions, b.positions) &&
	same(a.scales, b.scales) &&
	same(a.rotations, b.rotations) &&
	same(a.colors, b.colors) &&
	same(a.provenance, b.provenance);

function makeCloud(n: number, frame: "enu" | "camera", withSource: boolean) {
	let s = 12345;
	const rnd = () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
	const f = (len: number) =>
		Float32Array.from({ length: len }, () => Math.fround(rnd() * 10 - 5));
	const cloud: GaussianCloud = {
		count: n,
		frame,
		positions: f(3 * n),
		scales: f(3 * n).map(Math.abs),
		rotations: f(4 * n),
		colors: Uint8Array.from({ length: 4 * n }, () => (rnd() * 256) | 0),
		provenance: Uint8Array.from({ length: n }, () => (rnd() * 4) | 0),
	};
	if (withSource)
		cloud.source = Uint16Array.from({ length: n }, () => (rnd() * 65536) | 0);
	return cloud;
}

// ---- splat-v1 round trip ----
for (const [n, frame, src] of [
	[0, "camera", false],
	[7, "enu", true],
	[33, "camera", false],
	[101, "enu", false],
] as const) {
	const origin = frame === "enu" ? { lat: 46.7, lon: 7.9, h: 1234.5 } : null;
	const first = encodeSplatV1(makeCloud(n, frame, src), origin);
	ok(SplatV1Loader.tests[0](first), `v1 magic test n=${n}`);
	const parsed = SplatV1Loader.parseSync(first);
	ok(parsed.count === n && parsed.frame === frame, `v1 header n=${n}`);
	ok(
		sameBytes(first, encodeSplatV1(parsed, origin)),
		`v1 byte-identical n=${n} ${frame}`,
	);
	ok(
		sameCloud(parsed, await SplatV1Loader.parse(first)),
		`v1 parse == parseSync n=${n}`,
	);
	ok(sameCloud(parsed, parseSplatSync(first)), `v1 sniffed n=${n}`);
}

// ---- PLY synthetic fixture ----
function makePly(n: number) {
	const props = [
		"x",
		"y",
		"z",
		"nx",
		"ny",
		"nz",
		"f_dc_0",
		"f_dc_1",
		"f_dc_2",
		"f_rest_0",
		"opacity",
		"scale_0",
		"scale_1",
		"scale_2",
		"rot_0",
		"rot_1",
		"rot_2",
		"rot_3",
	];
	const head = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props
		.map((p) => `property float ${p}\n`)
		.join("")}end_header\n`;
	const hb = new TextEncoder().encode(head);
	const out = new Uint8Array(hb.length + n * props.length * 4);
	out.set(hb);
	const dv = new DataView(out.buffer);
	let o = hb.length;
	for (let i = 0; i < n; i++)
		for (let k = 0; k < props.length; k++, o += 4) {
			const name = props[k];
			let v = Math.sin(i * 7 + k) * 2;
			if (name.startsWith("scale")) v = -3 + Math.cos(i + k);
			if (name === "rot_0") v = 1 + 0.1 * i;
			dv.setFloat32(o, v, true);
		}
	return out.buffer;
}
const ply = makePly(9);
ok(SplatPlyLoader.tests[0](ply), "ply test");
ok(
	!SplatPlyLoader.tests[0](encodeSplatV1(makeCloud(1, "camera", false))),
	"ply test rejects v1",
);
ok(selectSplatLoader(ply) === SplatPlyLoader, "select ply");
ok(selectSplatLoader(new ArrayBuffer(4)) === null, "select none");
ok(
	SPLAT_LOADERS.every(
		(l) =>
			l.binary &&
			l.extensions.length > 0 &&
			typeof l.parseSync === "function" &&
			typeof l.parse === "function",
	),
	"loader shape",
);
const viaLoader = SplatPlyLoader.parseSync(ply, {
	"splat-ply": { frame: "enu", provenance: 2 },
});
const viaOld = decodeGaussianPly(ply, { frame: "enu", provenance: 2 });
ok(sameCloud(viaLoader, viaOld), "ply loader == decodeGaussianPly");
ok(
	sameCloud(await SplatPlyLoader.parse(ply), decodeGaussianPly(ply)),
	"ply default options",
);
ok(
	viaLoader.count === 9 &&
		viaLoader.frame === "enu" &&
		viaLoader.provenance[0] === 2,
	"ply options applied",
);
{
	// hand-computed: row 0 position is sin(k)*2 for k=0..2, scale_0 = exp(-3 + cos(11)) in f32
	const p0 = [0, 1, 2].map((k) => Math.fround(Math.sin(k) * 2));
	ok(
		same(viaLoader.positions.subarray(0, 3), Float32Array.from(p0)),
		"ply positions",
	);
	const q = viaLoader.rotations;
	ok(
		Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) < 1e-6,
		"ply rotation normalised",
	);
}
try {
	SplatPlyLoader.parseSync(new ArrayBuffer(16));
	ok(false, "ply bad header should throw");
} catch {}
try {
	parseSplatSync(new ArrayBuffer(16));
	ok(false, "unknown format should throw");
} catch {}

if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("splat-loaders check: ok");
