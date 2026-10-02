// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device, Texture } from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";
import { describe, expect, it } from "vitest";
import { deckTerrainStyle } from "../../style/deck-apply";
import { CLASSIC } from "../../style/defaults";
import {
	currentTerrainPass,
	LOG_DEPTH_FAR,
	maskTexture,
	RANGE_SAMPLER,
	rangeTexture,
	STYLE,
	setTerrainShaderProps,
	type TerrainDrawProps,
	terrainShaders,
	withTerrainPass,
} from "../terrain-layer";

const look = deckTerrainStyle(CLASSIC, "overlay");
const tex = (id: string) => ({ id }) as unknown as Texture;
const empty = tex("empty");

function drawProps(over: Partial<TerrainDrawProps> = {}): TerrainDrawProps {
	return {
		style: "hillshade",
		look,
		contourInterval: 50,
		contourOpacity: 0.8,
		elevRange: [400, 3000],
		haze: null,
		projectPhoto: 0.7,
		photoViewProj: null,
		photoPos: [1, 2, 3],
		photoMinRange: 9,
		nearFade: 30,
		nearDiscard: 60,
		protectPeople: false,
		harmonize: null,
		truth: 0.4,
		terroir: null,
		photoTexture: null,
		photoRange: null,
		photoFg: null,
		emptyTexture: empty,
		reliefTex: null,
		...over,
	};
}

/** Collects every `terrain` uniform prop object a draw sets. */
function drawInto(
	p: TerrainDrawProps,
	map?: Texture,
	pass?: "geometry" | "color" | "normal",
) {
	const calls: Record<string, Record<string, unknown>>[] = [];
	const model = {
		shaderInputs: { setProps: (x: never) => calls.push(x) },
	} as unknown as Model;
	const run = () =>
		setTerrainShaderProps(model, p, map, { cameraPosition: [0, 0, 0] });
	if (pass) withTerrainPass(pass, run);
	else run();
	return calls.find((c) => c.terrain)?.terrain as Record<string, unknown>;
}

describe("withTerrainPass", () => {
	it("sets the pass for the duration, nests, and restores even when the body throws", () => {
		expect(currentTerrainPass()).toBeNull();
		const seen: unknown[] = [];
		withTerrainPass("color", () => {
			seen.push(currentTerrainPass());
			withTerrainPass("geometry", () => seen.push(currentTerrainPass()));
			seen.push(currentTerrainPass());
		});
		expect(seen).toEqual(["color", "geometry", "color"]);
		expect(() =>
			withTerrainPass("normal", () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(currentTerrainPass()).toBeNull();
	});

	it("returns the body's value", () => {
		expect(withTerrainPass("geometry", () => 42)).toBe(42);
	});
});

describe("setTerrainShaderProps", () => {
	it("canvas pass: the layer's own style, no discard, sRGB out, projection per the photo textures", () => {
		const u = drawInto(drawProps({ style: "contours" }));
		expect(u.style).toBe(STYLE.contours);
		expect(u.linearOut).toBe(0);
		expect(u.nearDiscard).toBe(0);
		expect(u.nearFade).toBe(30);
		// no photo texture / range / viewProj: nothing to project even with projectPhoto > 0
		expect(u.projectPhoto).toBe(0);
		expect(u.truth).toBe(0.4);
		expect(u.hasMap).toBe(0);
		expect(u.terrainMap).toBe(empty);
		expect(u.photoPos).toEqual([1, 2, 3, 9]);
		expect(u.logDepthFC).toBeCloseTo(1 / Math.log2(LOG_DEPTH_FAR + 1), 12);
	});

	it("projects the photo only on the canvas pass with texture, range and matrix present", () => {
		const full = drawProps({
			photoTexture: tex("p"),
			photoRange: tex("r"),
			photoViewProj: new Array(16).fill(0),
		});
		expect(drawInto(full).projectPhoto).toBe(0.7);
		expect(drawInto(full).photoTexture).toEqual(tex("p"));
		expect(drawInto(full, undefined, "color").projectPhoto).toBe(0);
		expect(drawInto({ ...full, photoRange: null }).projectPhoto).toBe(0);
		expect(drawInto({ ...full, photoViewProj: null }).projectPhoto).toBe(0);
	});

	it("geometry pass: style 3, half the near discard, no truth tint, sRGB flag off", () => {
		const u = drawInto(drawProps(), undefined, "geometry");
		expect(u.style).toBe(3);
		expect(u.nearDiscard).toBe(30);
		expect(u.truth).toBe(0);
		expect(u.linearOut).toBe(0);
	});

	it("colour pass writes linear; normal pass is style 7", () => {
		expect(drawInto(drawProps(), undefined, "color").linearOut).toBe(1);
		expect(
			drawInto(drawProps({ style: "imagery" }), undefined, "color").style,
		).toBe(STYLE.imagery);
		expect(drawInto(drawProps(), undefined, "normal").style).toBe(7);
	});

	it("hasMap follows the tile texture; haze override replaces the look's amount", () => {
		const m = tex("map");
		const u = drawInto(drawProps({ haze: 0.25 }), m);
		expect(u.hasMap).toBe(1);
		expect(u.terrainMap).toBe(m);
		const hc = u.hazeColor as number[];
		expect(hc).toHaveLength(4);
		expect(hc[3]).toBe(0.25);
		expect((drawInto(drawProps()).hazeColor as number[])[3]).toBe(look.haze);
	});

	it("protectPeople needs the foreground mask", () => {
		expect(drawInto(drawProps({ protectPeople: true })).photoFgOn).toBe(0);
		expect(
			drawInto(drawProps({ protectPeople: true, photoFg: tex("fg") }))
				.photoFgOn,
		).toBe(1);
		expect(
			drawInto(drawProps({ protectPeople: false, photoFg: tex("fg") }))
				.photoFgOn,
		).toBe(0);
	});

	it("packs the ramp lengths into one vec4", () => {
		const u = drawInto(drawProps());
		expect(u.rampN).toEqual([look.relief.n, look.line.n, look.band.n, 0]);
	});
});

describe("terrainShaders", () => {
	it("classic look: base modules and no defines", () => {
		const s = terrainShaders({ look, style: "hillshade" }, "VS");
		expect(s.vs).toBe("VS");
		expect("defines" in s).toBe(false);
		const names = s.modules.map((m) => m.name);
		expect(names).toContain("terrain");
		expect(names).toContain("terrainLogDepth");
	});

	it("the slope layer adds LOOK_SLOPE and its module; extra modules are appended", () => {
		const extra = { name: "extra" } as never;
		const s = terrainShaders({ look, style: "slopeClass" }, "VS", [extra]);
		expect((s as { defines: Record<string, boolean> }).defines.LOOK_SLOPE).toBe(
			true,
		);
		const names = s.modules.map((m) => m.name);
		expect(names).toContain("extra");
		expect(names.length).toBeGreaterThan(3);
		// the same look without the slope layer has no LOOK_SLOPE
		expect(
			"defines" in terrainShaders({ look, style: "hillshade" }, "VS"),
		).toBe(false);
	});
});

describe("range / mask textures", () => {
	function fakeDevice() {
		const made: Record<string, unknown>[] = [];
		const device = {
			createTexture: (p: Record<string, unknown>) => {
				made.push(p);
				return p;
			},
		} as unknown as Device;
		return { device, made };
	}

	it("rangeTexture is r32float with the nearest sampler", () => {
		const { device, made } = fakeDevice();
		const data = new Float32Array(6);
		rangeTexture(device, { data, width: 3, height: 2 } as never);
		expect(made[0]).toMatchObject({
			width: 3,
			height: 2,
			format: "r32float",
			sampler: RANGE_SAMPLER,
		});
		expect(made[0].data).toBe(data);
		expect(RANGE_SAMPLER.minFilter).toBe("nearest");
	});

	it("maskTexture expands a byte mask to rgba with r = mask and a = 255", () => {
		const { device, made } = fakeDevice();
		maskTexture(device, {
			width: 2,
			height: 2,
			data: Uint8Array.from([0, 10, 128, 255]),
		});
		const rgba = made[0].data as Uint8Array;
		expect(Array.from(rgba)).toEqual([
			0, 0, 0, 255, 10, 0, 0, 255, 128, 0, 0, 255, 255, 0, 0, 255,
		]);
		expect(made[0]).toMatchObject({ width: 2, height: 2 });
		expect((made[0].sampler as { minFilter: string }).minFilter).toBe("linear");
	});
});
