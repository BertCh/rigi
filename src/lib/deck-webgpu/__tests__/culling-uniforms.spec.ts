// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { deckCompositeStyle } from "#/lib/style/deck-apply";
import { CLASSIC } from "#/lib/style/defaults";
import { seededRandom } from "#/test/helpers";
import {
	type CameraUniforms,
	cameraUniforms,
	photoCamera,
	sphereInView,
} from "../camera";
import {
	atmosphereFogPart,
	FOG_ATMOSPHERE,
	hexToLinear,
	WORLD_SKY,
} from "../layers/atm-sky";
import {
	compositeDefines,
	compositeUniforms,
	defaultCompositeSettings,
	revealUniforms,
} from "../layers/composite";
import { DEFAULT_RIDGES, ridgeUniforms } from "../layers/ridges";
import {
	CAND_BYTES,
	CULL_SLOTS,
	RECORD_WORDS,
} from "../layers/terrain-cull.wgsl";
import {
	compactTwin,
	inViewF32,
	packCandidates,
	packCullParams,
	padRadius,
	unpackParams,
} from "../layers/terrain-cull-math";
import {
	harmonizeUniforms,
	styleFeatures,
	terrainStyleName,
} from "../layers/terrain-styles";
import { DEFAULT_FOG, fogFromLook } from "../wgsl";

const cam = (extra = {}): CameraUniforms =>
	cameraUniforms(
		photoCamera({
			pose: { yaw: 20, pitch: 5, roll: 0, vfov: 45 },
			eye: [100, -50, 800],
			width: 640,
			height: 480,
			...extra,
		}),
	);

describe("terrain-cull-math", () => {
	it("padRadius pads 2% + 1 m", () => {
		expect(padRadius(100)).toBeCloseTo(103);
	});

	it("packCullParams / unpackParams round-trip the f32 camera fields", () => {
		const u = cam();
		const buf = packCullParams(u, 1234);
		expect(buf.byteLength).toBe(80);
		const p = unpackParams(buf);
		expect(p.n).toBe(1234);
		expect(p.eye).toEqual(u.eye.map(Math.fround));
		expect(p.near).toBe(Math.fround(u.near));
		expect(p.tanX).toBe(Math.fround(u.tanHalfX));
		expect(p.kx).toBeCloseTo(Math.sqrt(1 + u.tanHalfX ** 2), 6);
		expect(p.fwd).toEqual(u.forward.map(Math.fround));
	});

	it("packCandidates stores padded spheres, row and seg; capacity is honoured", () => {
		const buf = packCandidates([{ sphere: [1, 2, 3, 100], row: 7, seg: 2 }], 4);
		expect(buf.byteLength).toBe(4 * CAND_BYTES);
		const f = new Float32Array(buf);
		const u = new Uint32Array(buf);
		expect(Array.from(f.slice(0, 4))).toEqual([
			1,
			2,
			3,
			Math.fround(padRadius(100)),
		]);
		expect([u[4], u[5]]).toEqual([7, 2]);
		expect(packCandidates([]).byteLength).toBe(CAND_BYTES);
	});

	it("inViewF32 never culls what the f64 sphere test keeps (conservative), and agrees away from the boundary", () => {
		const rnd = seededRandom(3);
		const u = cam();
		const p = unpackParams(packCullParams(u, 0));
		let inside = 0;
		let outside = 0;
		for (let i = 0; i < 2000; i++) {
			const s: [number, number, number, number] = [
				(rnd() - 0.5) * 20_000,
				(rnd() - 0.5) * 20_000,
				rnd() * 3000,
				10 + rnd() * 500,
			];
			const exact = sphereInView(u, s);
			const padded = [s[0], s[1], s[2], padRadius(s[3])];
			const f32 = inViewF32(p, padded);
			if (exact) {
				expect(f32).toBe(true);
				inside++;
			} else outside++;
		}
		expect(inside).toBeGreaterThan(50);
		expect(outside).toBeGreaterThan(50);
	});

	it("compactTwin gives one slot per seg with its rows in candidate order and a record", () => {
		const segs = [
			{ indexCount: 100, firstIndex: 0 },
			{ indexCount: 200, firstIndex: 100 },
			{ indexCount: 300, firstIndex: 300 },
		];
		const cands = [
			{ sphere: [0, 0, 0, 1] as const, row: 10, seg: 2 },
			{ sphere: [0, 0, 0, 1] as const, row: 11, seg: 0 },
			{ sphere: [0, 0, 0, 1] as const, row: 12, seg: 2 },
			{ sphere: [0, 0, 0, 1] as const, row: 13, seg: 1 },
		];
		const r = compactTwin(cands, [true, false, true, true], segs);
		expect(r.slots.length).toBe(CULL_SLOTS);
		expect(r.slots[0]).toEqual({ seg: 0, rows: [] });
		expect(r.slots[1]).toEqual({ seg: 1, rows: [13] });
		expect(r.slots[2]).toEqual({ seg: 2, rows: [10, 12] });
		expect(r.slots[3].seg).toBe(-1);
		expect(Array.from(r.args.slice(0, 3))).toEqual([100, 0, 0]);
		expect(Array.from(r.args.slice(RECORD_WORDS, RECORD_WORDS + 3))).toEqual([
			200, 1, 100,
		]);
		const none = compactTwin(cands, [false, false, false, false], segs);
		expect(none.slots.every((s) => s.rows.length === 0)).toBe(true);
		expect(none.args[1]).toBe(0);
	});
});

describe("hexToLinear", () => {
	it("decodes hex, short hex and css rgb()", () => {
		expect(hexToLinear("#ffffff")).toEqual([1, 1, 1]);
		expect(hexToLinear("#000")).toEqual([0, 0, 0]);
		expect(hexToLinear("#f00")[0]).toBe(1);
		const g = hexToLinear("rgb(128, 128, 128)");
		expect(g[0]).toBeCloseTo(0.2158, 3);
		expect(hexToLinear("rgba(255, 0, 0, 0.5)")).toEqual([1, 0, 0]);
		expect(hexToLinear("#808080ff")[1]).toBeCloseTo(0.2158, 3);
	});

	it("unparseable input falls back to the world sky (never NaN)", () => {
		const fb = hexToLinear(WORLD_SKY);
		expect(hexToLinear("not a colour")).toEqual(fb);
		for (const v of fb) expect(Number.isFinite(v)).toBe(true);
	});
});

describe("atmosphereFogPart", () => {
	it("is a fog plugin that disables the plain fog and follows the current look", () => {
		const part = atmosphereFogPart(() => null);
		expect(part.defines?.[FOG_ATMOSPHERE]).toBe(true);
		expect(part.defines?.TERRAIN_NO_FOG).toBe(true);
		expect(part.apply).toBe("atm_fog_terrain");
		const ctx = { camera: { eye: [1, 2, 3] } } as never;
		const props = part.props?.(ctx) as {
			uniforms: {
				atmosphere: { strength: number; eye: number[]; nebelDensity: number };
			};
		};
		// no look: neutral atmosphere (strength 0 = identity), at the camera eye
		expect(props.uniforms.atmosphere.strength).toBe(0);
		expect(props.uniforms.atmosphere.eye).toEqual([1, 2, 3]);
		expect(props.uniforms.atmosphere.nebelDensity).toBe(0);
	});

	it("passes a look's atmosphere values through", () => {
		const values = {
			eye: [0, 0, 0],
			betaR: [1, 2, 3],
			sunDir: [0, 0, 1],
			sunColor: [1, 1, 1],
			airlight: [0.5, 0.5, 0.5],
			h: [8000, 1200],
			betaM: 2e-5,
			strength: 0.7,
			mieG: 0.7,
			airlightMix: 0.2,
			nebel: [1500, 0.002, 400],
			nebelColor: [0.9, 0.9, 1],
		};
		const part = atmosphereFogPart(() => values as never);
		const u = (
			part.props?.({ camera: { eye: [0, 0, 5] } } as never) as {
				uniforms: { atmosphere: Record<string, unknown> };
			}
		).uniforms.atmosphere;
		expect(u.strength).toBe(0.7);
		expect(u.betaR).toEqual([1, 2, 3]);
		expect(u.nebelTop).toBe(1500);
		expect(u.nebelDensity).toBe(0.002);
		expect(u.nebelFalloff).toBe(400);
		expect(u.nebelColor).toEqual([0.9, 0.9, 1]);
	});
});

describe("ridges / fog / styles uniforms", () => {
	const style = deckCompositeStyle(CLASSIC);

	it("ridgeUniforms without a look uses the style and neutral ink", () => {
		const r = ridgeUniforms(style, { nearFade: 60 }, null, [800, 600]);
		expect(r.outSize).toEqual([800, 600]);
		expect(r.nearFade).toBe(60);
		expect(r.inkWidth).toBe(1);
		expect(r.inkFade).toBe(60000);
		expect(r.refine).toBe(0);
		expect(r.inner[3]).toBe(1);
		expect(r.inkInner[3]).toBe(0);
		expect(r.gainO).toBe(style.ridgeGainO);
		expect(DEFAULT_RIDGES.sketch).toBeDefined();
	});

	it("ridgeUniforms with a look takes ink fields and its outSize", () => {
		const look = {
			inkInner: [0.1, 0.2, 0.3],
			inkSky: [0, 0, 0],
			outSize: [1024, 768],
			inkWidth: 2,
			inkStrength: 0.8,
			inkCrease: 0.4,
			inkFade: 5000,
			refine: 1,
		} as never;
		const r = ridgeUniforms(style, { nearFade: 0 }, look, [1, 1]);
		expect(r.inkInner).toEqual([0.1, 0.2, 0.3, 0.8]);
		expect(r.outSize).toEqual([1024, 768]);
		expect([r.inkWidth, r.inkFade, r.inkCrease, r.refine]).toEqual([
			2, 5000, 0.4, 1,
		]);
	});

	it("fogFromLook maps the haze look; DEFAULT_FOG is a sane classic", () => {
		const L = {
			hazeColor: [0.5, 0.6, 0.7],
			haze: 0.9,
			hazeParams: [1e-5, 0.8],
			shade: [0.3, 0.7],
			sunDir: [0, 0, 1],
		} as never;
		const f = fogFromLook(L);
		expect(f.color).toEqual([0.5, 0.6, 0.7, 0.9]);
		expect(f.params).toEqual([1e-5, 0.8, 0.3, 0.7]);
		expect(f.sun).toEqual([0, 0, 1, 0]);
		expect(fogFromLook(L, 0.1).color[3]).toBe(0.1);
		expect(Math.hypot(...DEFAULT_FOG.sun.slice(0, 3))).toBeCloseTo(1, 2);
	});

	it("terrainStyleName falls back to hillshade", () => {
		expect(terrainStyleName("contours")).toBe("contours");
		expect(terrainStyleName("slopeClass")).toBe("slopeClass");
		expect(terrainStyleName("geometry")).toBe("hillshade");
	});

	it("styleFeatures only enables features the style uses", () => {
		const look = {
			defines: [
				"LOOK_ALPINE",
				"LOOK_WATER",
				"LOOK_WATER_WAVES",
				"LOOK_RELIEF",
				"LOOK_ATMOSPHERE",
				"LOOK_TANAKA",
			],
			rel: {},
			atm: {},
		} as never;
		const hs = styleFeatures("hillshade", look);
		expect(hs).toMatchObject({
			alpine: true,
			relief: true,
			tanaka: false,
			atmosphere: true,
			water: true,
			waves: true,
		});
		const co = styleFeatures("contours", look);
		expect(co).toMatchObject({
			alpine: false,
			relief: false,
			tanaka: true,
			atmosphere: false,
			water: false,
			waves: false,
		});
		const el = styleFeatures("elevation", look);
		expect(el.relief).toBe(true);
		expect(el.atmosphere).toBe(false);
		// a look without the structure for a define turns it off
		const bare = styleFeatures("hillshade", {
			defines: ["LOOK_RELIEF", "LOOK_ATMOSPHERE"],
			rel: null,
			atm: null,
		} as never);
		expect(bare.relief).toBe(false);
		expect(bare.atmosphere).toBe(false);
		const noWater = styleFeatures("hillshade", {
			defines: ["LOOK_WATER", "LOOK_WATER_WAVES"],
			rel: null,
			atm: null,
		} as never);
		expect(noWater.water).toBe(false);
		expect(noWater.waves).toBe(false);
	});

	it("harmonizeUniforms adds the padding words", () => {
		const v = {
			pm: [1],
			ps: [2],
			lm: [3],
			ls: [4],
			amount: 0.5,
			chroma: 0.6,
		} as never;
		expect(harmonizeUniforms(v)).toMatchObject({
			amount: 0.5,
			pad0: 0,
			pad1: 0,
		});
	});
});

describe("composite uniforms / defines", () => {
	it("compositeDefines keeps composite defines and derives LOOK_BLEND / LOOK_MASK", () => {
		expect(compositeDefines([])).toEqual({});
		const a = compositeDefines(["LOOK_REFINE"] as never);
		expect(a.LOOK_REFINE).toBe(true);
		expect(a.LOOK_BLEND).toBe(true);
		expect(a.LOOK_MASK).toBe(true);
		const b = compositeDefines(["LOOK_INK", "LOOK_ATMOSPHERE"] as never);
		expect(b.LOOK_INK).toBe(true);
		expect(b.LOOK_MASK).toBe(true);
		expect(b.LOOK_BLEND).toBeUndefined();
		expect(b.LOOK_ATMOSPHERE).toBeUndefined(); // not a composite define
		expect(compositeDefines(["LOOK_OUTPUT"] as never).LOOK_BLEND).toBe(true);
	});

	it("revealUniforms is all zero when off and copies the fields when on", () => {
		const off = revealUniforms(null);
		for (const v of Object.values(off)) expect(v).toEqual([0, 0, 0, 0]);
		const r = {
			a: [1, 2, 3, 4],
			win: [1, 1, 1, 1],
			qD: [2, 2, 2, 2],
			qE: [3, 3, 3, 3],
			shape: [4, 4, 4, 4],
			focus: [5, 5, 5, 5],
			glow: [6, 6, 6, 6],
			F: [7, 8, 9],
			R: [1, 0, 0],
			U: [0, 1, 0],
		} as never;
		const on = revealUniforms(r);
		expect(on.reveal).toEqual([1, 2, 3, 4]);
		expect(on.revealF).toEqual([7, 8, 9, 0]);
		expect(on.revealU).toEqual([0, 1, 0, 0]);
	});

	it("compositeUniforms derives aspect, flags and metres from the settings", () => {
		const style = deckCompositeStyle(CLASSIC);
		const base = {
			settings: {
				...defaultCompositeSettings,
				rangeKm: 12,
				protectPeople: true,
				keepSky: true,
				mode: "overlay" as const,
			},
			style,
			reveal: null,
			width: 800,
			height: 400,
			hasPhoto: true,
			hasForeground: true,
			hasOccluder: false,
		};
		const u = compositeUniforms(base);
		expect(u.aspect).toBe(2);
		expect(u.rangeM).toBe(12_000);
		expect(u.fgOn).toBe(1);
		expect(u.hasPhoto).toBe(1);
		expect(u.occlOn).toBe(0);
		expect(u.mode).toBe(0);
		expect(u.keepSky).toBe(1);
		const v = compositeUniforms({
			...base,
			hasForeground: false,
			hasPhoto: false,
			hasOccluder: true,
			settings: { ...base.settings, mode: "replace" as never, keepSky: false },
		});
		expect(v.fgOn).toBe(0);
		expect(v.hasPhoto).toBe(0);
		expect(v.occlOn).toBe(1);
		expect(v.mode).toBe(1);
		expect(v.keepSky).toBe(0);
	});
});
