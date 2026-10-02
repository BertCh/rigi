// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { encodeGaussianPly } from "../../export/splat";
import { encodeSplatV1 } from "../splat-io";
import {
	isKsplat,
	isPlainSplat,
	isSpz,
	KSPLAT_LOADER_INFO,
	parseSplat,
	parseSplatSync,
	SPLAT_LOADERS,
	SPLAT_RECORD_BYTES,
	SplatPlyLoader,
	SplatV1Loader,
	selectSplatLoader,
} from "../splat-loaders";
import { cloudFromSplatsTable } from "../splat-loaders-ext";
import { type GaussianCloud, PROVENANCE_CODE } from "../types";

function cloud(n = 3): GaussianCloud {
	return {
		count: n,
		frame: "camera",
		positions: Float32Array.from({ length: 3 * n }, (_, i) => i * 0.5 - 1),
		scales: Float32Array.from({ length: 3 * n }, (_, i) => 0.05 + 0.01 * i),
		rotations: Float32Array.from({ length: 4 * n }, (_, i) =>
			i % 4 === 0 ? 1 : 0,
		),
		colors: Uint8Array.from({ length: 4 * n }, (_, i) => (i * 37) % 256),
		provenance: new Uint8Array(n).fill(PROVENANCE_CODE.observed),
	};
}

/** Plain .splat records: f32 position, f32 scale, u8 rgba, u8 quaternion. */
function plainSplat(n: number, mutate?: (dv: DataView, i: number) => void) {
	const buf = new ArrayBuffer(n * SPLAT_RECORD_BYTES);
	const dv = new DataView(buf);
	for (let i = 0; i < n; i++) {
		const o = i * SPLAT_RECORD_BYTES;
		dv.setFloat32(o, i, true);
		dv.setFloat32(o + 4, 2 * i, true);
		dv.setFloat32(o + 8, -i, true);
		for (let k = 0; k < 3; k++)
			dv.setFloat32(o + 12 + 4 * k, 0.1 + 0.01 * k, true);
		dv.setUint8(o + 24, 255);
		dv.setUint8(o + 25, 128);
		dv.setUint8(o + 26, 0);
		dv.setUint8(o + 27, 200);
		dv.setUint8(o + 28, 255); // quaternion w = (255 - 128)/128
		dv.setUint8(o + 29, 128);
		dv.setUint8(o + 30, 128);
		dv.setUint8(o + 31, 128);
		mutate?.(dv, i);
	}
	return buf;
}

describe("format sniffers", () => {
	it("isSpz accepts NGSP and gzip streams, nothing else", () => {
		expect(isSpz(Uint8Array.from([0x4e, 0x47, 0x53, 0x50, 0, 0]).buffer)).toBe(
			true,
		);
		expect(isSpz(Uint8Array.from([0x1f, 0x8b, 8]).buffer)).toBe(true);
		expect(isSpz(Uint8Array.from([1]).buffer)).toBe(false);
		expect(isSpz(Uint8Array.from([0x1f, 0x00]).buffer)).toBe(false);
		expect(isSpz(new ArrayBuffer(0))).toBe(false);
	});
	function ksplatHeader(
		opts: {
			size?: number;
			maxSections?: number;
			sections?: number;
			compression?: number;
			major?: number;
			minor?: number;
		} = {},
	) {
		const maxSections = opts.maxSections ?? 1;
		const buf = new ArrayBuffer(opts.size ?? 4096 + maxSections * 1024);
		const dv = new DataView(buf);
		dv.setUint8(0, opts.major ?? 0);
		dv.setUint8(1, opts.minor ?? 1);
		dv.setUint32(4, maxSections, true);
		dv.setUint32(8, opts.sections ?? 1, true);
		dv.setUint16(20, opts.compression ?? 0, true);
		return buf;
	}
	it("isKsplat checks the header invariants", () => {
		expect(isKsplat(ksplatHeader())).toBe(true);
		expect(isKsplat(ksplatHeader({ compression: 3 }))).toBe(false);
		expect(isKsplat(ksplatHeader({ major: 1 }))).toBe(false);
		expect(isKsplat(ksplatHeader({ minor: 0 }))).toBe(false);
		expect(isKsplat(ksplatHeader({ maxSections: 0 }))).toBe(false);
		expect(isKsplat(ksplatHeader({ sections: 2 }))).toBe(false);
		expect(isKsplat(ksplatHeader({ size: 100 }))).toBe(false);
		expect(
			isKsplat(ksplatHeader({ maxSections: 4, size: 4096 + 2 * 1024 })),
		).toBe(false);
	});
	it("isPlainSplat needs whole 32-byte records with finite positions and positive finite scales", () => {
		expect(isPlainSplat(plainSplat(5))).toBe(true);
		expect(isPlainSplat(new ArrayBuffer(0))).toBe(false);
		expect(isPlainSplat(new ArrayBuffer(33))).toBe(false);
		expect(
			isPlainSplat(
				plainSplat(
					3,
					(dv, i) => i === 1 && dv.setFloat32(32 + 4, Number.NaN, true),
				),
			),
		).toBe(false);
		expect(
			isPlainSplat(
				plainSplat(3, (dv, i) => i === 2 && dv.setFloat32(64 + 12, 0, true)),
			),
		).toBe(false);
		expect(
			isPlainSplat(
				plainSplat(
					3,
					(dv, i) =>
						i === 0 && dv.setFloat32(12 + 8, Number.POSITIVE_INFINITY, true),
				),
			),
		).toBe(false);
		expect(
			isPlainSplat(
				plainSplat(3, (dv, i) => i === 0 && dv.setFloat32(12, -1, true)),
			),
		).toBe(false);
	});
	it("loader info entries carry their test and id", () => {
		expect(KSPLAT_LOADER_INFO.id).toBe("splat-ksplat");
		expect(KSPLAT_LOADER_INFO.tests[0]).toBe(isKsplat);
	});
});

describe("selectSplatLoader", () => {
	it("picks v1 by magic, PLY by magic, then SPZ, KSPLAT, plain .splat", () => {
		expect(selectSplatLoader(encodeSplatV1(cloud()))?.id).toBe("splat-v1");
		const ply = encodeGaussianPly(cloud(), ["x"]);
		expect(selectSplatLoader(ply)?.id).toBe("splat-ply");
		expect(
			selectSplatLoader(
				Uint8Array.from([0x4e, 0x47, 0x53, 0x50, 4, 0, 0, 0]).buffer,
			)?.id,
		).toBe("splat-spz");
		expect(selectSplatLoader(plainSplat(4))?.id).toBe("splat-plain");
		expect(selectSplatLoader(Uint8Array.from([1, 2, 3]).buffer)).toBeNull();
	});
	it("every sync loader has the loaders.gl shape", () => {
		for (const l of SPLAT_LOADERS) {
			expect(l.binary).toBe(true);
			expect(l.extensions.length).toBeGreaterThan(0);
			expect(typeof l.parse).toBe("function");
			expect(l.options[l.id]).toBeDefined();
		}
		expect(SplatV1Loader.tests[0](new ArrayBuffer(3))).toBe(false); // shorter than the magic
		expect(
			SplatPlyLoader.tests[0](
				new TextEncoder().encode("ply\n").buffer as ArrayBuffer,
			),
		).toBe(true);
	});
});

describe("parseSplatSync / parseSplat", () => {
	it("round-trips v1 and PLY by sniffing", async () => {
		const c = cloud(4);
		const v1 = parseSplatSync(encodeSplatV1(c));
		expect(v1.count).toBe(4);
		expect(Array.from(v1.positions)).toEqual(Array.from(c.positions));
		expect(Array.from((await parseSplat(encodeSplatV1(c))).colors)).toEqual(
			Array.from(c.colors),
		);
		const ply = encodeGaussianPly(c, ["t"]);
		const p = parseSplatSync(ply, {
			frame: "enu",
			provenance: PROVENANCE_CODE.generated,
		});
		expect(p.count).toBe(4);
		expect(p.frame).toBe("enu");
		expect(p.provenance.every((v) => v === PROVENANCE_CODE.generated)).toBe(
			true,
		);
		for (let i = 0; i < c.positions.length; i++)
			expect(p.positions[i]).toBeCloseTo(c.positions[i], 5);
		const viaAsync = await parseSplat(ply, { frame: "camera" });
		expect(viaAsync.frame).toBe("camera");
		expect(await SplatPlyLoader.parse(ply)).toMatchObject({ count: 4 });
		expect((await SplatV1Loader.parse(encodeSplatV1(c))).count).toBe(4);
	});
	it("rejects unknown formats; the sync parser refuses the async formats", async () => {
		const junk = Uint8Array.from([9, 9, 9]).buffer;
		expect(() => parseSplatSync(junk)).toThrow(/unknown gaussian format/);
		await expect(parseSplat(junk)).rejects.toThrow(/unknown gaussian format/);
		expect(() => parseSplatSync(plainSplat(3))).toThrow(/asynchronously/);
	});
	it("parses a plain .splat through loaders.gl into a cloud with display colours", async () => {
		const c = await parseSplat(plainSplat(3), { frame: "enu" });
		expect(c.count).toBe(3);
		expect(c.frame).toBe("enu");
		expect(c.provenance.every((v) => v === PROVENANCE_CODE.reconstructed)).toBe(
			true,
		);
		expect(Array.from(c.positions.subarray(3, 6))).toEqual([1, 2, -1]);
		expect(c.scales[0]).toBeCloseTo(0.1, 5);
		expect(Array.from(c.colors.subarray(0, 4))).toEqual([255, 128, 0, 200]);
		expect(Math.hypot(...Array.from(c.rotations.subarray(0, 4)))).toBeCloseTo(
			1,
			1,
		);
	});
});

describe("cloudFromSplatsTable", () => {
	const col = (v: number[]) => ({
		length: v.length,
		data: [{ length: v.length, values: Float32Array.from(v), children: [] }],
	});
	const listCol = (v: number[], size: number) => ({
		length: v.length / size,
		data: [
			{
				length: v.length / size,
				children: [
					{ length: v.length, values: Float32Array.from(v), children: [] },
				],
			},
		],
	});
	function table() {
		const cols: Record<string, unknown> = {
			POSITION: listCol([1, 2, 3, 4, 5, 6], 3),
			opacity: col([0, 1]),
		};
		for (let k = 0; k < 3; k++) {
			cols[`f_dc_${k}`] = col([0, 1 / 0.28209479177387814]);
			cols[`scale_${k}`] = col([0.1 * (k + 1), 0.2]);
		}
		for (let k = 0; k < 4; k++)
			cols[`rot_${k}`] = col([k === 0 ? 1 : 0, k === 1 ? 1 : 0]);
		return { numRows: 2, getChild: (n: string) => (cols[n] as never) ?? null };
	}
	it("converts SH DC and opacity to bytes and interleaves scalar columns", () => {
		const c = cloudFromSplatsTable(
			{ shape: "arrow-table", data: table() as never },
			{ provenance: 7 },
		);
		expect(c.count).toBe(2);
		expect(c.frame).toBe("camera");
		expect(Array.from(c.positions)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(Array.from(c.colors.subarray(0, 4))).toEqual([128, 128, 128, 0]);
		expect(Array.from(c.colors.subarray(4, 8))).toEqual([255, 255, 255, 255]);
		expect(
			Array.from(c.scales.subarray(0, 3)).map((v) => +v.toFixed(5)),
		).toEqual([0.1, 0.2, 0.3]);
		expect(Array.from(c.rotations)).toEqual([1, 0, 0, 0, 0, 1, 0, 0]);
		expect(c.provenance.every((v) => v === 7)).toBe(true);
	});
	it("rejects other shapes and missing or non-float columns", () => {
		expect(() =>
			cloudFromSplatsTable({ shape: "columnar-table", data: table() as never }),
		).toThrow(/unexpected shape/);
		const t = table();
		expect(() =>
			cloudFromSplatsTable({
				shape: "arrow-table",
				data: { ...t, getChild: () => null } as never,
			}),
		).toThrow(/missing/);
		const bad = {
			...t,
			getChild: (n: string) =>
				n === "opacity"
					? {
							length: 2,
							data: [{ length: 2, values: new Uint8Array(2), children: [] }],
						}
					: t.getChild(n),
		};
		expect(() =>
			cloudFromSplatsTable({ shape: "arrow-table", data: bad as never }),
		).toThrow(/not float32/);
	});
});
