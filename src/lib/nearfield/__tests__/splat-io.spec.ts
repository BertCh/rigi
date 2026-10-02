// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import {
	decodeGaussianPly,
	decodeSplatV1,
	encodeSplatV1,
	readSplatV1Origin,
	SH_C0,
	to8,
} from "../splat-io";
import { type GaussianCloud, PROVENANCE_CODE } from "../types";

function randomCloud(
	n: number,
	frame: GaussianCloud["frame"],
	withSource: boolean,
): GaussianCloud {
	const r = seededRandom(7);
	const f32 = (len: number) =>
		Float32Array.from({ length: len }, () => uniform(r, -50, 50));
	const u8 = (len: number) =>
		Uint8Array.from({ length: len }, () => Math.floor(uniform(r, 0, 256)));
	const cloud: GaussianCloud = {
		count: n,
		frame,
		positions: f32(3 * n),
		scales: f32(3 * n),
		rotations: f32(4 * n),
		colors: u8(4 * n),
		provenance: Uint8Array.from({ length: n }, (_, i) => i % 4),
	};
	if (withSource)
		cloud.source = Uint16Array.from({ length: n }, (_, i) => i * 3);
	return cloud;
}

describe("splat-v1 encode / decode", () => {
	it.each([
		[1, false],
		[5, true], // 5 splats: provenance block is not 4-byte aligned, so padding matters
		[7, true],
		[64, false],
	])("round-trips %i splats (source=%s) exactly", (n, withSource) => {
		const cloud = randomCloud(n, "enu", withSource);
		const back = decodeSplatV1(encodeSplatV1(cloud, { lat: 1, lon: 2, h: 3 }));
		expect(back.count).toBe(n);
		expect(back.frame).toBe("enu");
		expect(back.positions).toEqual(cloud.positions);
		expect(back.scales).toEqual(cloud.scales);
		expect(back.rotations).toEqual(cloud.rotations);
		expect(back.colors).toEqual(cloud.colors);
		expect(back.provenance).toEqual(cloud.provenance);
		if (withSource) expect(back.source).toEqual(cloud.source);
		else expect(back.source).toBeUndefined();
	});

	it("pads to a 4-byte boundary before the source array", () => {
		const cloud = randomCloud(5, "camera", true);
		const bytes = encodeSplatV1(cloud).byteLength;
		// header 40 + 5*45 = 265 -> pad 268, + 5*2 source
		expect(bytes).toBe(268 + 10);
	});

	it("stores the origin for ENU clouds and null for camera clouds", () => {
		const origin = { lat: 46.7107, lon: 7.7724, h: 1923.5 };
		expect(
			readSplatV1Origin(encodeSplatV1(randomCloud(2, "enu", false), origin)),
		).toEqual(origin);
		expect(
			readSplatV1Origin(encodeSplatV1(randomCloud(2, "camera", false), origin)),
		).toBeNull();
	});

	it("reads from a typed-array view with a byte offset", () => {
		const cloud = randomCloud(3, "enu", true);
		const enc = new Uint8Array(encodeSplatV1(cloud, { lat: 1, lon: 2, h: 3 }));
		const padded = new Uint8Array(enc.length + 16);
		padded.set(enc, 8);
		const back = decodeSplatV1(padded.subarray(8, 8 + enc.length));
		expect(back.positions).toEqual(cloud.positions);
	});

	it("rejects bad magic and truncated buffers", () => {
		const good = new Uint8Array(encodeSplatV1(randomCloud(4, "enu", false)));
		const bad = good.slice();
		bad[0] = 0;
		expect(() => decodeSplatV1(bad)).toThrow(/bad magic/);
		expect(() => decodeSplatV1(good.slice(0, 20))).toThrow(/truncated/);
		expect(() => decodeSplatV1(good.slice(0, good.length - 4))).toThrow(
			/truncated/,
		);
		expect(() => readSplatV1Origin(new ArrayBuffer(4))).toThrow(/truncated/);
	});
});

describe("to8", () => {
	it("rounds and clamps", () => {
		expect(to8(0)).toBe(0);
		expect(to8(1)).toBe(255);
		expect(to8(0.5)).toBe(128);
		expect(to8(-3)).toBe(0);
		expect(to8(7)).toBe(255);
	});
});

/** Build a minimal binary little-endian 3DGS ply with the given per-vertex float rows. */
function makePly(props: string[], rows: number[][], extraHeader = "") {
	const header = `ply\nformat binary_little_endian 1.0\n${extraHeader}element vertex ${rows.length}\n${props
		.map((p) => `property float ${p}`)
		.join("\n")}\nend_header\n`;
	const head = new TextEncoder().encode(header);
	const body = new DataView(new ArrayBuffer(rows.length * props.length * 4));
	for (const [i, row] of rows.entries())
		for (const [k, v] of row.entries())
			body.setFloat32((i * props.length + k) * 4, v, true);
	const out = new Uint8Array(head.length + body.byteLength);
	out.set(head, 0);
	out.set(new Uint8Array(body.buffer), head.length);
	return out;
}

const PLY_PROPS = [
	"x",
	"y",
	"z",
	"f_dc_0",
	"f_dc_1",
	"f_dc_2",
	"opacity",
	"scale_0",
	"scale_1",
	"scale_2",
	"rot_0",
	"rot_1",
	"rot_2",
	"rot_3",
];

describe("decodeGaussianPly", () => {
	it("applies SH-DC colour, sigmoid opacity, exp scales and normalised quaternions", () => {
		const ply = makePly(PLY_PROPS, [
			[1, 2, 3, 0, 1, -1, 0, Math.log(0.5), Math.log(2), 0, 2, 0, 0, 0],
		]);
		const c = decodeGaussianPly(ply, {
			frame: "enu",
			provenance: PROVENANCE_CODE.dem,
		});
		expect(c.count).toBe(1);
		expect(c.frame).toBe("enu");
		expect([...c.positions]).toEqual([1, 2, 3]);
		expect(c.colors[0]).toBe(to8(0.5));
		expect(c.colors[1]).toBe(to8(0.5 + SH_C0));
		expect(c.colors[2]).toBe(to8(0.5 - SH_C0));
		expect(c.colors[3]).toBe(128); // sigmoid(0) = 0.5
		expect(c.scales[0]).toBeCloseTo(0.5, 6);
		expect(c.scales[1]).toBeCloseTo(2, 6);
		expect(c.scales[2]).toBeCloseTo(1, 6);
		expect([...c.rotations]).toEqual([1, 0, 0, 0]);
		expect(c.provenance[0]).toBe(PROVENANCE_CODE.dem);
	});

	it("defaults: camera frame, reconstructed provenance, opaque, unit quaternion for zero rotation", () => {
		const ply = makePly(
			["x", "y", "z", "rot_0", "rot_1", "rot_2", "rot_3"],
			[[0, 0, 0, 0, 0, 0, 0]],
		);
		const c = decodeGaussianPly(ply);
		expect(c.frame).toBe("camera");
		expect(c.provenance[0]).toBe(PROVENANCE_CODE.reconstructed);
		expect(c.colors[3]).toBe(255); // default logit 10 -> ~1
		expect(c.colors[0]).toBe(128); // no colour properties -> mid grey
		expect(c.scales[0]).toBeCloseTo(0.01, 6);
		expect(Array.from(c.rotations)).toEqual([0, 0, 0, 0]); // hypot 0 -> divisor 1 (degenerate stays zero)
	});

	it("a NaN or infinite rotation becomes the identity quaternion", () => {
		const ply = makePly(
			["x", "y", "z", "rot_0", "rot_1", "rot_2", "rot_3"],
			[
				[0, 0, 0, Number.NaN, 0, 0, 0],
				[0, 0, 0, Number.POSITIVE_INFINITY, 1, 0, 0],
			],
		);
		const c = decodeGaussianPly(ply);
		expect(Array.from(c.rotations)).toEqual([1, 0, 0, 0, 1, 0, 0, 0]);
	});

	it("skips a leading non-vertex element and handles CRLF-free headers", () => {
		const header =
			"ply\nformat binary_little_endian 1.0\nelement extra 2\nproperty uchar a\nproperty float b\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n";
		const head = new TextEncoder().encode(header);
		const body = new DataView(new ArrayBuffer(2 * 5 + 12));
		body.setFloat32(10, 4, true);
		body.setFloat32(14, 5, true);
		body.setFloat32(18, 6, true);
		const out = new Uint8Array(head.length + body.byteLength);
		out.set(head);
		out.set(new Uint8Array(body.buffer), head.length);
		const c = decodeGaussianPly(out);
		expect([...c.positions]).toEqual([4, 5, 6]);
	});

	it("throws on ascii, missing vertex, truncated body and missing xyz", () => {
		const ascii = new TextEncoder().encode(
			"ply\nformat ascii 1.0\nelement vertex 0\nend_header\n",
		);
		expect(() => decodeGaussianPly(ascii)).toThrow(/binary_little_endian/);
		expect(() => decodeGaussianPly(new Uint8Array([1, 2, 3]))).toThrow(
			/bad header/,
		);
		const full = makePly(PLY_PROPS, [new Array(14).fill(0)]);
		expect(() => decodeGaussianPly(full.slice(0, full.length - 4))).toThrow(
			/truncated/,
		);
		expect(() => decodeGaussianPly(makePly(["x", "y"], [[0, 0]]))).toThrow(
			/missing property z/,
		);
		const noVertex = new TextEncoder().encode(
			"ply\nformat binary_little_endian 1.0\nend_header\n",
		);
		expect(() => decodeGaussianPly(noVertex)).toThrow(/no vertex/);
	});
});
