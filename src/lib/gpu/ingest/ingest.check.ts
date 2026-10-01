// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// npx tsx src/lib/gpu/ingest/ingest.check.ts
// Node check of gpu/ingest's pure parts (no browser, no GPU):
//  1. Terrarium f32 exactness: for ALL 2^24 (R, G, B) triples, the kernel's f32 arithmetic
//     (terrarium-f32.ts terrariumF32, Math.fround per step in the WGSL's order) is bit-identical to
//     dem/decode.ts decodeTerrarium (f64, then a Float32Array store), and every partial sum a
//     reassociating / FMA-contracting compiler could form is exactly representable in f32;
//  2. unorm8 → byte: round(f32(k/255) · 255) == k for all 256 k, also with the load perturbed by
//     up to ±4 ULP;
//  3. the WGSL multiplies by 1/256 (never divides) and uses the twin's constants;
//  4. layout math: raster formats, byte sizes, copy alignment, workgroups.
// What this does not cover: the texel BYTES copyExternalImageToTexture produces (browser check
// scripts/gpu/terrarium-ingest-check.mjs).
import { decodeTerrarium } from "#/lib/dem/decode";
import {
	bufferByteLength,
	bytesPerTexel,
	copyBytesPerRow,
	isCopyAligned,
	rasterFormatOf,
	rasterLength,
	texelWorkgroups,
} from "./layout";
import {
	INV_256,
	inexactPartial,
	OFFSET,
	SEA_FLOOR,
	terrariumF32,
	unormToByte,
} from "./terrarium-f32";

let failures = 0;
const check = (name: string, ok: boolean, info = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? ` ${info}` : ""}`);
};

// ---------------- 1. all 2^24 RGB triples ----------------
{
	const t0 = performance.now();
	const bits = new Uint32Array(1);
	const f32 = new Float32Array(bits.buffer);
	const rgba = new Uint8Array(256 * 256 * 4);
	let compared = 0;
	let mismatched = 0;
	let inexact = 0;
	let firstBad = "";
	let negZero = 0;
	for (let r = 0; r < 256; r++) {
		// one decodeTerrarium call per R plane (G × B), the CPU twin's own loop
		for (let g = 0; g < 256; g++)
			for (let b = 0; b < 256; b++) {
				const o = (g * 256 + b) * 4;
				rgba[o] = r;
				rgba[o + 1] = g;
				rgba[o + 2] = b;
				rgba[o + 3] = 255;
			}
		const cpu = decodeTerrarium(rgba);
		const cpuBits = new Uint32Array(cpu.buffer);
		for (let g = 0; g < 256; g++)
			for (let b = 0; b < 256; b++) {
				const i = g * 256 + b;
				f32[0] = terrariumF32(r, g, b);
				if (Object.is(f32[0], -0)) negZero++;
				compared++;
				if (bits[0] !== cpuBits[i]) {
					mismatched++;
					firstBad ||= `rgb(${r},${g},${b}): gpu ${f32[0]} cpu ${cpu[i]}`;
				}
				const bad = inexactPartial(r, g, b);
				if (bad) {
					inexact++;
					firstBad ||= `rgb(${r},${g},${b}): ${bad} inexact in f32`;
				}
			}
	}
	check(
		"terrariumF32 == decodeTerrarium, bit for bit, over all 2^24 RGB",
		mismatched === 0,
		`${compared} compared, ${mismatched} differ${firstBad ? `; first: ${firstBad}` : ""}`,
	);
	check(
		"every partial sum (any order / FMA) exactly representable in f32",
		inexact === 0,
		`${inexact} triples with an inexact partial`,
	);
	check("no -0 heights", negZero === 0, `${negZero}`);
	console.log(`     ${(performance.now() - t0).toFixed(0)} ms`);
}

// ---------------- 2. unorm8 round trip ----------------
{
	const ulps = new Float32Array(1);
	const u = new Uint32Array(ulps.buffer);
	let bad = 0;
	for (let k = 0; k < 256; k++) {
		ulps[0] = k / 255;
		const base = u[0];
		for (let d = -4; d <= 4; d++) {
			if (k === 0 && d < 0) continue; // below 0 is clamped by the kernel
			u[0] = base + d;
			const v = Math.min(1, ulps[0]);
			if (unormToByte(v) !== k) bad++;
		}
		u[0] = base;
	}
	check(
		"round(f32(k/255)·255) == k for all k, load within ±4 ULP",
		bad === 0,
		`${bad} wrong`,
	);
}

// ---------------- 3. WGSL source ----------------
// terrarium.ts imports the luma runtime (core/kernel); load it lazily so a luma import problem in
// node reports as one failed check instead of aborting the exhaustive tests above
try {
	const { TERRARIUM_WGSL } = await import("./terrarium");
	const body = TERRARIUM_WGSL.replace(/\/\/.*$/gm, "");
	check("WGSL never divides (f32 / is 2.5 ULP)", !body.includes("/"));
	check(
		"WGSL uses the twin's constants",
		body.includes(`* ${INV_256}`) &&
			body.includes(`- ${OFFSET}.0`) &&
			body.includes(`> ${SEA_FLOOR}.0`) &&
			body.includes("* 256.0 + c.g + c.b") &&
			body.includes("round(clamp(v, vec4f(0.0), vec4f(1.0)) * 255.0)"),
	);
} catch (e) {
	check("load terrarium.ts in node", false, String(e).slice(0, 200));
}

// ---------------- 4. layout math ----------------
{
	const cases: [string, unknown, unknown][] = [
		[
			"Float32Array → r32float",
			rasterFormatOf(new Float32Array(1)),
			"r32float",
		],
		[
			"Float32Array ×4 → rgba32float",
			rasterFormatOf(new Float32Array(4), 4),
			"rgba32float",
		],
		["Uint8Array → r8unorm", rasterFormatOf(new Uint8Array(1)), "r8unorm"],
		[
			"Uint8ClampedArray ×4 → rgba8unorm",
			rasterFormatOf(new Uint8ClampedArray(4), 4),
			"rgba8unorm",
		],
		[
			"Uint8Array ×4 integer → rgba8uint",
			rasterFormatOf(new Uint8Array(4), 4, true),
			"rgba8uint",
		],
		["Uint16Array → r16uint", rasterFormatOf(new Uint16Array(1)), "r16uint"],
		["Int32Array → r32sint", rasterFormatOf(new Int32Array(1)), "r32sint"],
		["bytesPerTexel rgba32float", bytesPerTexel("rgba32float"), 16],
		["bytesPerTexel rgba8unorm-srgb", bytesPerTexel("rgba8unorm-srgb"), 4],
		["rasterLength 512² ×4", rasterLength(512, 512, 4), 1048576],
		["copyBytesPerRow 512 r32float", copyBytesPerRow(512, "r32float"), 2048],
		["copyBytesPerRow 100 rgba8", copyBytesPerRow(100, "rgba8unorm"), 512],
		["copyBytesPerRow 64 r8", copyBytesPerRow(64, "r8unorm"), 256],
		["isCopyAligned 256 r32float", isCopyAligned(256, "r32float"), true],
		["isCopyAligned 512 rgba8", isCopyAligned(512, "rgba8unorm"), true],
		["isCopyAligned 100 r32float", isCopyAligned(100, "r32float"), false],
		["bufferByteLength 0", bufferByteLength(0), 4],
		["bufferByteLength 5", bufferByteLength(5), 8],
		["bufferByteLength 8", bufferByteLength(8), 8],
		["texelWorkgroups 512²", texelWorkgroups(512, 512).join(","), "64,64"],
		["texelWorkgroups 257×9", texelWorkgroups(257, 9).join(","), "33,2"],
	];
	let bad = 0;
	for (const [name, got, want] of cases)
		if (got !== want) {
			bad++;
			console.log(`     ${name}: got ${got}, want ${want}`);
		}
	let threw = false;
	try {
		rasterFormatOf(new Uint16Array(3), 2);
	} catch {
		threw = true;
	}
	check(
		"layout math",
		bad === 0 && threw,
		`${cases.length} cases, ${bad} wrong${threw ? "" : "; 2-band Uint16 did not throw"}`,
	);
}

console.log(
	failures
		? `FAIL: ${failures} check(s)`
		: "PASS: GPU Terrarium decode arithmetic is f32-exact and bit-identical to decodeTerrarium",
);
process.exit(failures ? 1 : 0);
