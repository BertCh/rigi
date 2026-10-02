// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import { CLASSIC } from "#/lib/style/defaults";
import { mergeStyle } from "#/lib/style/schema";
import { seededRandom, uniform } from "#/test/helpers";
import { defineBlock } from "../glsl/block";
import { WATER_FNS, waterWgsl } from "../water/water";
import {
	isWebdriver,
	WATER_WAVES_BLOCK,
	WATER_WAVES_FNS,
	WATER_WAVES_WGSL,
	WAVE_STILL_TIME,
	waterWaveSeconds,
	waterWavesAnimate,
	waterWavesOn,
	waterWaveTilt,
	waveNoise,
} from "../water/waves";

const wavy = mergeStyle(CLASSIC, {
	world: { water: "waves" },
	terrain: { albedo: { mode: "alpine", water: true } },
} as never);

describe("waveNoise", () => {
	it("is in [0,1), deterministic, and continuous", () => {
		const rand = seededRandom(2);
		for (let k = 0; k < 200; k++) {
			const x = uniform(rand, -50, 50);
			const y = uniform(rand, -50, 50);
			const n = waveNoise(x, y);
			expect(n).toBeGreaterThanOrEqual(0);
			expect(n).toBeLessThan(1);
			expect(n).toBe(waveNoise(x, y));
			expect(Math.abs(waveNoise(x + 1e-6, y) - n)).toBeLessThan(1e-3);
		}
	});
	it("equals the lattice hash at integer points", () => {
		const h = (ix: number, iy: number) => {
			const s = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
			return s - Math.floor(s);
		};
		expect(waveNoise(3, -2)).toBeCloseTo(h(3, -2), 12);
	});
});

describe("waterWaveTilt", () => {
	it("is finite, deterministic and bounded", () => {
		const rand = seededRandom(4);
		for (let k = 0; k < 100; k++) {
			const args: [number, number, number, number] = [
				uniform(rand, -5000, 5000),
				uniform(rand, -5000, 5000),
				uniform(rand, 0, 100),
				uniform(rand, 10, 40000),
			];
			const [gx, gy] = waterWaveTilt(...args);
			expect(Number.isFinite(gx) && Number.isFinite(gy)).toBe(true);
			expect(Math.hypot(gx, gy)).toBeLessThan(1);
			expect(waterWaveTilt(...args)).toEqual([gx, gy]);
		}
	});
	it("fades with range (finer packets attenuate) and moves with time", () => {
		const rms = (range: number) => {
			let s = 0;
			for (let i = 0; i < 200; i++) {
				const [gx, gy] = waterWaveTilt(i * 7.3, i * 3.1, 5, range);
				s += gx * gx + gy * gy;
			}
			return Math.sqrt(s / 200);
		};
		expect(rms(200000)).toBeLessThan(rms(50));
		expect(waterWaveTilt(10, 10, 1, 100)).not.toEqual(
			waterWaveTilt(10, 10, 9, 100),
		);
	});
});

describe("wave switches and clock", () => {
	it("waterWavesOn needs waves + alpine albedo + water", () => {
		expect(waterWavesOn(wavy)).toBe(true);
		expect(waterWavesOn(CLASSIC)).toBe(false);
		expect(
			waterWavesOn(mergeStyle(wavy, { world: { water: "flat" } } as never)),
		).toBe(false);
	});
	it("under webdriver the clock is still and animation is off", () => {
		vi.stubGlobal("navigator", { webdriver: true });
		expect(isWebdriver()).toBe(true);
		expect(waterWaveSeconds()).toBe(WAVE_STILL_TIME);
		expect(waterWavesAnimate(wavy)).toBe(false);
	});
	it("for a user the clock runs and animation follows waterWavesOn", () => {
		vi.stubGlobal("navigator", { webdriver: false });
		expect(isWebdriver()).toBe(false);
		expect(waterWaveSeconds()).toBeGreaterThanOrEqual(0);
		expect(waterWavesAnimate(wavy)).toBe(true);
		expect(waterWavesAnimate(CLASSIC)).toBe(false);
	});
});

describe("shader texts and blocks", () => {
	it("water shaders mention the shared entry point", () => {
		expect(WATER_FNS).toContain("water");
		expect(waterWgsl(false)).toContain("ts_water_shade");
		expect(waterWgsl(true)).toContain(WATER_WAVES_WGSL.trim().slice(0, 20));
		expect(waterWgsl(true)).toContain("ts_water_wave_tilt");
		expect(waterWgsl(false)).not.toContain("ts_water_wave_tilt");
		expect(WATER_WAVES_FNS.length).toBeGreaterThan(100);
	});
	it("defineBlock names accessors, packs vec3 as vec4, and declares plain uniforms", () => {
		const b = defineBlock("tst", "testBlock", { gain: "float", dir: "vec3" });
		expect(b.uniformName("gain")).toBe("uTstGain");
		expect(b.glslDecl).toContain("uniform float uTstGain;");
		expect(b.lumaModule.vs).toContain("#define tst_dir testBlock.dir.xyz");
		expect(b.pack({ gain: 2, dir: [1, 2, 3] })).toEqual({
			gain: 2,
			dir: [1, 2, 3, 0],
		});
		expect(b.pack({})).toEqual({});
		expect(WATER_WAVES_BLOCK.name).toBe("waterWaves");
	});
});
