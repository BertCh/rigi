// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	decodeGaussianPly,
	decodeSplatV1,
	readSplatV1Origin,
} from "#/lib/nearfield/splat-io";
import type { GaussianCloud, NearFieldScene } from "#/lib/nearfield/types";
import type { Renderer } from "#/lib/renderer";
import { expectArrayClose } from "#/test/helpers";
import {
	buildSplatExport,
	encodeGaussianPly,
	engineNearFieldScene,
	exportableCloud,
	exportSplatsFromEngine,
	SPLAT_EXPORT_FORMATS,
	splatLicence,
} from "../splat";

// provenance codes: 0 observed, 1 reconstructed, 2 dem, 3 generated, 9 unknown
function cloud(prov: number[], frame: "enu" | "camera" = "enu"): GaussianCloud {
	const n = prov.length;
	const positions = new Float32Array(3 * n);
	const scales = new Float32Array(3 * n);
	const rotations = new Float32Array(4 * n);
	const colors = new Uint8Array(4 * n);
	for (let i = 0; i < n; i++) {
		positions.set([i, 2 * i + 0.5, 100 + i], 3 * i);
		scales.set([0.1, 0.2, 0.4], 3 * i);
		rotations.set([1, 0, 0, 0], 4 * i);
		colors.set([200, 100, 50, 255 - i], 4 * i);
	}
	return {
		count: n,
		frame,
		positions,
		scales,
		rotations,
		colors,
		provenance: Uint8Array.from(prov),
	};
}

const scene = (
	prov: number[],
	extra: Partial<NearFieldScene> = {},
): NearFieldScene =>
	({
		photoId: "IMG_1",
		anchor: {
			scale: 1.2,
			shift: 0,
			residualLog: 0.05,
			inlierFrac: 0.8,
			n: 100,
			quality: 0.6,
			maxRange: 150,
		},
		split: {} as never,
		splats: cloud(prov),
		confidenceRadius: 50,
		...extra,
	}) as NearFieldScene;

const origin = { lat: 46.97596, lon: 8.66849, h: 1361.3 };

describe("splatLicence", () => {
	it("flags SHARP as research-only", () => {
		const l = splatLicence("sharp-v1");
		expect(l.commercial).toBe(false);
		expect(l.note).toMatch(/RESEARCH-ONLY/);
	});
	it("allows MoGe and Depth-Anything-3 Base/Small", () => {
		expect(splatLicence("lift/moge-2-vitl-normal").commercial).toBe(true);
		expect(splatLicence("da3-base").commercial).toBe(true);
		expect(splatLicence("depth-anything-3").commercial).toBe(true);
	});
	it("leaves a bare lift or unknown model unverified", () => {
		expect(splatLicence("lift").commercial).toBeNull();
		expect(splatLicence("whatever").commercial).toBeNull();
		expect(splatLicence(null).commercial).toBeNull();
		expect(splatLicence(undefined).note).toMatch(/unknown/);
	});
	it("does not call DA3 Large commercial", () => {
		expect(splatLicence("da3-large").commercial).toBeNull();
	});
});

describe("exportableCloud", () => {
	it("drops generated and unknown provenance and counts the rest", () => {
		const { cloud: c, stats } = exportableCloud(scene([0, 3, 1, 9, 2, 3]));
		expect(c.count).toBe(3);
		expect(Array.from(c.provenance)).toEqual([0, 1, 2]);
		expect(stats).toEqual({
			total: 6,
			kept: 3,
			counts: { observed: 1, reconstructed: 1, dem: 1, generated: 0 },
			droppedGenerated: 2,
			droppedUnknown: 1,
		});
	});
	it("keeps the surviving splats' attributes aligned", () => {
		const { cloud: c } = exportableCloud(scene([3, 0, 3, 1]));
		expectArrayClose(c.positions, [1, 2.5, 101, 3, 6.5, 103]);
	});
	it("refuses a camera-frame cloud", () => {
		const s = scene([0]);
		s.splats = cloud([0], "camera");
		expect(() => exportableCloud(s)).toThrow(/not in the ENU frame/);
	});
});

describe("encodeGaussianPly", () => {
	it("round-trips through decodeGaussianPly", () => {
		const c = cloud([0, 1, 2]);
		const back = decodeGaussianPly(encodeGaussianPly(c), { frame: "enu" });
		expect(back.count).toBe(3);
		expectArrayClose(back.positions, c.positions, 1e-6);
		expectArrayClose(back.scales, c.scales, 1e-6);
		expectArrayClose(back.rotations, c.rotations, 1e-6);
		for (let i = 0; i < c.colors.length; i++)
			expect(Math.abs(back.colors[i] - c.colors[i])).toBeLessThanOrEqual(1);
	});
	it("normalises quaternions and guards degenerate scales", () => {
		const c = cloud([0]);
		c.rotations.set([0, 0, 0, 0]);
		c.scales.set([0, -1, Number.NaN]);
		const back = decodeGaussianPly(encodeGaussianPly(c), { frame: "enu" });
		expectArrayClose(back.rotations, [1, 0, 0, 0]);
		for (const s of back.scales) expect(s).toBeGreaterThan(0);
		expect(Math.max(...back.scales)).toBeLessThan(1e-6);
	});
	it("writes ASCII comment lines, stripping newlines and non-ASCII", () => {
		const buf = encodeGaussianPly(cloud([0]), ["a\nb – ü"]);
		const head = new TextDecoder().decode(new Uint8Array(buf, 0, 300));
		expect(head).toContain("comment a b - ?");
		expect(head.split("end_header")[0]).toContain("element vertex 1");
	});
	it("has the documented stride", () => {
		const buf = encodeGaussianPly(cloud([0, 0]));
		const head = new TextDecoder().decode(
			new Uint8Array(buf, 0, Math.min(600, buf.byteLength)),
		);
		const hdrLen = head.indexOf("end_header\n") + "end_header\n".length;
		expect(buf.byteLength - hdrLen).toBe(2 * (17 * 4 + 1));
	});
});

describe("buildSplatExport", () => {
	it("ply: header comments carry origin, model and licence and the body is filtered", () => {
		const r = buildSplatExport(
			scene([0, 3, 1], { model: "lift/moge-2" }),
			"splat-ply",
			{
				origin,
				createdAt: "2026-01-01T00:00:00Z",
				geoidUndulation: 49,
				pose: { yaw: 10, pitch: -2, roll: 0.5, vfov: 50 },
				eye: [0, 0, 1361.3],
			},
		);
		expect(r.ext).toBe(".enu.ply");
		expect(r.stats.kept).toBe(2);
		const h = r.header.join("\n");
		expect(h).toContain("origin_lat 46.975960000");
		expect(h).toContain("origin_h_ellipsoid 1410.300");
		expect(h).toContain("created 2026-01-01T00:00:00Z");
		expect(h).toContain("commercial_use allowed");
		expect(h).toContain("pose_deg yaw 10.0000 pitch -2.0000");
		expect(h).toContain("provenance_dropped generated 1 unknown 0");
		expect(decodeGaussianPly(r.bytes, { frame: "enu" }).count).toBe(2);
		expect(r.notes).toContain("2 splats");
		expect(r.notes).toContain("1 generated splats left out");
		expect(r.notes).toContain("no LV95 (not available in this build)");
	});
	it("splat-v1: round-trips count, frame and origin", () => {
		const r = buildSplatExport(scene([0, 1]), "splat-v1", { origin });
		expect(r.ext).toBe(".splat-v1");
		const c = decodeSplatV1(r.bytes);
		expect(c.count).toBe(2);
		expect(c.frame).toBe("enu");
		expect(readSplatV1Origin(r.bytes)).toEqual(origin);
		expect(r.notes).toContain(
			"origin h is the DEM (MSL) height; splat-v1 has no datum field",
		);
	});
	it("notes untrusted anchors, research-only models and the N=0 caveat", () => {
		const s = scene([0], { model: "sharp" });
		s.anchor.quality = 0.05;
		const r = buildSplatExport(s, "splat-ply", {
			origin: { lat: 0, lon: 0, h: 0 },
		});
		expect(r.notes.some((n) => n.startsWith("anchor quality 0.05"))).toBe(true);
		expect(r.notes).toContain("research-only model: no commercial use");
		expect(r.header.join("\n")).toContain(
			"N=0: MSL height used as ellipsoidal",
		);
		expect(r.header.join("\n")).toContain("BELOW");
		// outside Switzerland: no LV95 note
		expect(r.notes.some((n) => n.includes("LV95"))).toBe(false);
	});
	it("writes LV95 when a transform is supplied", () => {
		const r = buildSplatExport(scene([0]), "splat-ply", {
			origin,
			toLv95: () => ({ E: 2600000, N: 1200000, H: 1300 }),
		});
		const h = r.header.join("\n");
		expect(h).toContain("origin_lv95_E 2600000.000");
		expect(r.notes.some((n) => n.includes("LV95"))).toBe(false);
	});
	it("rejects an unknown kind", () => {
		expect(() =>
			buildSplatExport(scene([0]), "x" as never, { origin }),
		).toThrow(/unknown kind/);
	});
	it("registers both kinds in the format table", () => {
		expect(SPLAT_EXPORT_FORMATS.map((f) => f.kind)).toEqual([
			"splat-ply",
			"splat-v1",
		]);
	});
});

describe("engineNearFieldScene / exportSplatsFromEngine", () => {
	const eng = (extra: Record<string, unknown>) =>
		({
			photo: { id: "IMG_1" },
			frame: origin,
			pose: { yaw: 0, pitch: 0, roll: 0, vfov: 50 },
			eye: { x: 0, y: 0, z: 1 },
			...extra,
		}) as unknown as Renderer;
	it("reads the scene from a property, a getter function or getNearFieldScene", () => {
		const s = scene([0]);
		expect(engineNearFieldScene(eng({ nearFieldScene: s }))).toBe(s);
		expect(engineNearFieldScene(eng({ nearFieldScene: () => s }))).toBe(s);
		expect(engineNearFieldScene(eng({ getNearFieldScene: () => s }))).toBe(s);
	});
	it("returns null for no engine, no scene, an empty cloud or a throwing getter", () => {
		expect(engineNearFieldScene(null)).toBeNull();
		expect(engineNearFieldScene(eng({}))).toBeNull();
		expect(engineNearFieldScene(eng({ nearFieldScene: scene([]) }))).toBeNull();
		expect(
			engineNearFieldScene(
				eng({
					getNearFieldScene: () => {
						throw new Error("x");
					},
				}),
			),
		).toBeNull();
	});
	it("exports a blob named after the photo", async () => {
		const r = exportSplatsFromEngine(eng({}), "splat-v1", {
			scene: scene([0, 1]),
			geoidUndulation: 0,
		});
		expect(r.filename).toBe("IMG_1.splat-v1");
		expect(decodeSplatV1(await r.blob.arrayBuffer()).count).toBe(2);
	});
	it("throws without a scene or for another photo", () => {
		expect(() => exportSplatsFromEngine(eng({}), "splat-ply")).toThrow(
			/no near-field scene/,
		);
		expect(() =>
			exportSplatsFromEngine(eng({}), "splat-ply", {
				scene: scene([0], { photoId: "OTHER" }),
			}),
		).toThrow(/another photo/);
	});
});
