// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	contrastRatio,
	desaturate,
	ensureContrast,
	GROUND_BASE,
	GROUND_CONTRAST,
	type GroundPalette,
	groundPalette,
	groundVars,
	hexToRgb,
	measurePalette,
	mixHex,
	relativeLuminance,
	rgbToHex,
} from "../viz/ground";
import PALETTES from "../viz/ground-palette.json";

describe("colour math", () => {
	it("round-trips hex and mixes in sRGB", () => {
		expect(rgbToHex(hexToRgb("#95500c"))).toBe("#95500c");
		expect(hexToRgb("#abc")).toEqual([0xaa, 0xbb, 0xcc]);
		expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
		expect(mixHex("#123456", "#abcdef", 0)).toBe("#123456");
		expect(mixHex("#123456", "#abcdef", 1)).toBe("#abcdef");
		expect(desaturate("#ff0000", 0)).toBe(rgbToHex(hexToRgb("#363636")));
	});

	it("matches the WCAG contrast of known pairs", () => {
		expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
		expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
		expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 6);
	});

	it("ensureContrast keeps a passing ink and lifts a failing one just past the floor", () => {
		expect(ensureContrast("#131313", "#f4f3f0", 4.5)).toBe("#131313");
		const lifted = ensureContrast("#c8c8c8", "#f4f3f0", 3);
		expect(contrastRatio(lifted, "#f4f3f0")).toBeGreaterThanOrEqual(3);
		expect(contrastRatio(lifted, "#f4f3f0")).toBeLessThan(3.2);
		const onDark = ensureContrast("#333333", "#131313", 3);
		expect(contrastRatio(onDark, "#131313")).toBeGreaterThanOrEqual(3);
		expect(relativeLuminance(onDark)).toBeGreaterThan(
			relativeLuminance("#333333"),
		);
	});
});

const EXTREMES: GroundPalette[] = [
	// white sky, black terrain, a mid band; then a dark dusk; then a saturated noon
	{
		sky: "#ffffff",
		terrain: "#000000",
		horizon: "#808080",
		skyL: 1,
		terrainL: 0,
		horizonL: 0.22,
	},
	{
		sky: "#202838",
		terrain: "#0a0a0a",
		horizon: "#141820",
		skyL: 0.02,
		terrainL: 0.003,
		horizonL: 0.008,
	},
	{
		sky: "#2f7fff",
		terrain: "#3fa020",
		horizon: "#e0e0d0",
		skyL: 0.24,
		terrainL: 0.27,
		horizonL: 0.75,
	},
];

describe("groundVars", () => {
	const palettes = [
		...Object.values(PALETTES as Record<string, GroundPalette>),
		...EXTREMES,
	];

	it("holds every ink to its floor on its wash, on paper and on a dark plate", () => {
		for (const p of palettes)
			for (const surface of ["paper", "plate-dark"] as const) {
				const v = groundVars(p, surface);
				const wash = v["--fig-wash"] as string;
				expect(
					contrastRatio(v["--fig-sky-ink"] as string, wash),
				).toBeGreaterThanOrEqual(GROUND_CONTRAST.line - 1e-6);
				expect(
					contrastRatio(v["--fig-terrain-ink"] as string, wash),
				).toBeGreaterThanOrEqual(GROUND_CONTRAST.line - 1e-6);
				expect(
					contrastRatio(v["--fig-horizon-ink"] as string, wash),
				).toBeGreaterThanOrEqual(GROUND_CONTRAST.text - 1e-6);
			}
	});

	it("keeps the paper wash a breath off paper-deep and the plate dark", () => {
		for (const p of palettes) {
			const paper = groundVars(p, "paper")["--fig-wash"] as string;
			expect(contrastRatio(paper, GROUND_BASE.paperDeep)).toBeLessThan(1.15);
			const plate = groundVars(p, "plate-dark")["--fig-wash"] as string;
			expect(relativeLuminance(plate)).toBeLessThan(0.03);
		}
	});

	it("takes its cue from the photo: a different sky gives a different wash", () => {
		const a = groundVars(EXTREMES[0])["--fig-wash"];
		const c = groundVars(EXTREMES[2])["--fig-wash"];
		expect(a).not.toBe(c);
	});

	it("picks a dark halo over a bright horizon and a light one over a dark horizon", () => {
		expect(groundVars(EXTREMES[2])["--fig-halo"]).toBe(GROUND_BASE.ink);
		expect(groundVars(EXTREMES[1])["--fig-halo"]).toBe(GROUND_BASE.paper);
	});

	it("is empty for an unknown photo, so every reader falls back", () => {
		expect(groundVars("demo-99")).toEqual({});
		expect(groundVars(undefined)).toEqual({});
		expect(groundPalette("demo-01")).toBeDefined();
	});
});

describe("measurePalette", () => {
	it("splits a synthetic photo at its skyline", () => {
		const W = 40;
		const H = 30;
		const rows = Array.from({ length: W }, (_, x) => (x < 4 ? null : 12));
		const rgb = new Uint8Array(W * H * 3);
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const c =
					y < 11 ? [120, 160, 220] : y > 13 ? [90, 80, 60] : [200, 200, 200];
				rgb.set(c, (y * W + x) * 3);
			}
		const p = measurePalette(rgb, W, H, rows, { band: 0.04, step: 1 });
		expect(p).toMatchObject({
			sky: "#78a0dc",
			terrain: "#5a503c",
			horizon: "#c8c8c8",
		});
		expect(p?.skyL).toBeCloseTo(relativeLuminance("#78a0dc"), 3);
	});

	it("gives null without a skyline", () => {
		expect(
			measurePalette(new Uint8Array(12), 2, 2, [null, null], { step: 1 }),
		).toBeNull();
	});

	it("keeps the bake small", () => {
		expect(JSON.stringify(PALETTES).length).toBeLessThan(4096);
	});
});
