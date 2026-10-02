// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { CLASSIC } from "#/lib/style/defaults";
import type { LabelStyle } from "#/lib/style/types";
import { seededRandom } from "#/test/helpers";
import {
	boxLuma,
	contrastFilter,
	contrastGlow,
	contrastNeed,
	type LumaMap,
} from "../labels/contrast";
import { cssMixColor, labelCssVars } from "../labels/css";
import {
	GLOW_DEFAULT,
	GLOW_STRIDE,
	glowMarkersFor,
	glowUniformsOf,
	sameGlowMarkers,
} from "../labels/glow";
import { declutterClassic, peakRank, rankPeaks } from "../labels/rank";

const peak = (
	name: string,
	u: number,
	v: number,
	rank: number,
	extra = {},
) => ({
	name,
	ele: 2000,
	u,
	v,
	rank,
	...extra,
});

describe("peakRank", () => {
	it("weights prominence 3x, adds elevation, subtracts range", () => {
		expect(peakRank(100, 2000, 10000)).toBeCloseTo(300 + 2000 - 120, 9);
		expect(peakRank(null, null, 0)).toBe(0);
	});
});

describe("rankPeaks", () => {
	it("sorts by rank desc and breaks ties by prominence, elevation, name, u", () => {
		const a = peak("B", 0.1, 0.1, 5, { prominence: 10 });
		const b = peak("A", 0.2, 0.1, 5, { prominence: 10 });
		const c = peak("C", 0.3, 0.1, 5, { prominence: 50 });
		const d = peak("D", 0.4, 0.1, 9);
		const e = peak("A", 0.05, 0.1, 5, { prominence: 10 });
		expect(rankPeaks([a, b, c, d, e]).map((p) => `${p.name}${p.u}`)).toEqual([
			"D0.4",
			"C0.3",
			"A0.05",
			"A0.2",
			"B0.1",
		]);
	});
});

describe("declutterClassic", () => {
	it("keeps the first of two close labels and drops the second", () => {
		const out = declutterClassic(
			[peak("Eiger", 0.5, 0.3, 3), peak("Mönch", 0.51, 0.31, 2)],
			10,
		);
		expect(out.map((p) => p.name)).toEqual(["Eiger"]);
	});
	it("keeps labels that are far apart horizontally or vertically", () => {
		const out = declutterClassic(
			[peak("A", 0.2, 0.3, 3), peak("B", 0.8, 0.3, 2), peak("C", 0.2, 0.6, 1)],
			10,
		);
		expect(out).toHaveLength(3);
	});
	it("honours max and never leaves an overlapping pair on random input", () => {
		const rand = seededRandom(11);
		const ranked = Array.from({ length: 80 }, (_, i) =>
			peak(`P${i}`, rand(), rand() * 0.5, 100 - i),
		);
		const out = declutterClassic(ranked, 12);
		expect(out.length).toBeLessThanOrEqual(12);
		const half = (l: { name: string }) => Math.max(l.name.length, 12) * 0.0034;
		for (let i = 0; i < out.length; i++)
			for (let j = i + 1; j < out.length; j++)
				expect(
					Math.abs(out[i].u - out[j].u) < half(out[i]) + half(out[j]) &&
						Math.abs(out[i].v - out[j].v) < 0.075,
				).toBe(false);
	});
});

describe("boxLuma", () => {
	// 4 x 2 map, left half dark (0.05), right half bright (0.9)
	const m: LumaMap = {
		w: 4,
		h: 2,
		data: Float32Array.from([0.05, 0.05, 0.9, 0.9, 0.05, 0.05, 0.9, 0.9]),
	};
	it("reads the bright end under a box in frame pixels", () => {
		expect(
			boxLuma(m, { x0: 0, y0: 0, x1: 100, y1: 100 }, 400, 200),
		).toBeCloseTo(0.05, 6);
		expect(
			boxLuma(m, { x0: 200, y0: 0, x1: 400, y1: 200 }, 400, 200),
		).toBeCloseTo(0.9, 6);
	});
	it("clamps boxes that stick out of the frame", () => {
		expect(
			boxLuma(m, { x0: -50, y0: -50, x1: 1000, y1: 1000 }, 400, 200),
		).toBeCloseTo(0.9, 6);
	});
});

describe("contrastNeed / glow", () => {
	const st: LabelStyle = CLASSIC.labels as unknown as LabelStyle;
	it("is 0 over dark backdrops for white text, 1 over white, and monotone in between", () => {
		expect(contrastNeed(st, 0)).toBe(0);
		expect(contrastNeed(st, 1)).toBeCloseTo(1, 6);
		let prev = -1;
		for (let y = 0; y <= 1.0001; y += 0.05) {
			const n = contrastNeed(st, y);
			expect(n).toBeGreaterThanOrEqual(prev - 1e-12);
			prev = n;
		}
	});
	it("is 0 when adaptive is off", () => {
		const off = { ...st, halo: { ...st.halo, adaptive: 0 } };
		expect(contrastNeed(off, 1)).toBe(0);
	});
	it("scales with halo.adaptive", () => {
		const half = { ...st, halo: { ...st.halo, adaptive: 0.5 } };
		expect(contrastNeed(half, 1)).toBeCloseTo(0.5, 6);
	});
	it("contrastGlow is null for tiny need, else a blur of at least 3 px that grows with the font", () => {
		expect(contrastGlow(st, 0.01, 12)).toBeNull();
		expect(contrastGlow(st, 1, 4)?.blur).toBe(3);
		expect(contrastGlow(st, 1, 40)?.blur).toBeCloseTo(18, 9);
		expect(contrastGlow(st, 1, 12)?.color).toContain("rgba");
	});
	it("a 'none' halo glows black behind white text and white behind dark text", () => {
		const none = { ...st, halo: { ...st.halo, kind: "none" as const } };
		expect(contrastGlow(none, 1, 12)?.color).toMatch(/0,\s*0,\s*0/);
		const dark = { ...none, name: { ...st.name, color: "#000000" as const } };
		expect(contrastGlow(dark, 1, 12)?.color).toMatch(/255,\s*255,\s*255/);
	});
	it("contrastFilter is empty without need and two drop-shadows with it", () => {
		expect(contrastFilter(st, 0, 12)).toBe("");
		expect(contrastFilter(st, 1, 12).match(/drop-shadow/g)).toHaveLength(2);
	});
});

describe("css variables", () => {
	it("cssMixColor: opaque is rgb(), translucent is color-mix, alphaMul scales", () => {
		expect(cssMixColor("#ff0000")).toBe("rgb(255,0,0)");
		expect(cssMixColor([1, 1, 1, 0.75])).toBe(
			"color-mix(in oklab, rgb(255,255,255) 75%, transparent)",
		);
		expect(cssMixColor([1, 1, 1, 0.9], 0)).toContain(" 0%");
	});
	it("labelCssVars emits the full variable set for classic", () => {
		const v = labelCssVars(CLASSIC.labels as unknown as LabelStyle) as Record<
			string,
			string
		>;
		expect(v["--lbl-name-px"]).toBe("12px");
		expect(v["--lbl-name-w"]).toBe("600");
		expect(v["--lbl-halo"]).toMatch(/^drop-shadow\(0 1px 3px /);
		expect(v["--lbl-stroke"]).toBe("0 transparent");
		expect(v["--lbl-lead-to"]).toContain(" 0%"); // fade
		expect(v["--lbl-dot-shadow"]).toMatch(/^0 0 6px /);
	});
	it("stroke halos fill --lbl-stroke and drop the shadow filter", () => {
		const st = CLASSIC.labels as unknown as LabelStyle;
		const v = labelCssVars({
			...st,
			halo: { ...st.halo, kind: "stroke", strokePx: 2 },
			dot: { ...st.dot, glow: undefined },
		} as never) as Record<string, string>;
		expect(v["--lbl-halo"]).toBe("none");
		expect(v["--lbl-stroke"]).toMatch(/^2px /);
		expect(v["--lbl-dot-shadow"]).toBe("none");
	});
});

describe("glow markers", () => {
	const labels = [
		{ u: 0.1, v: 0.2 },
		{ u: 0.7, v: 0.4 },
	];
	it("is null when off, zero-strength, or no labels", () => {
		expect(glowMarkersFor(labels, null)).toBeNull();
		expect(
			glowMarkersFor(labels, { ...GLOW_DEFAULT, intensity: 0 }),
		).toBeNull();
		expect(glowMarkersFor(labels, { ...GLOW_DEFAULT, radiusPx: 0 })).toBeNull();
		expect(glowMarkersFor([], GLOW_DEFAULT)).toBeNull();
	});
	it("packs u, v per label", () => {
		const g = glowMarkersFor(labels, GLOW_DEFAULT);
		expect(g?.points.length).toBe(labels.length * GLOW_STRIDE);
		expect(Array.from(g?.points ?? [])).toEqual([
			Math.fround(0.1),
			Math.fround(0.2),
			Math.fround(0.7),
			Math.fround(0.4),
		]);
	});
	it("sameGlowMarkers compares points and look", () => {
		const a = glowMarkersFor(labels, GLOW_DEFAULT);
		const b = glowMarkersFor(labels, GLOW_DEFAULT);
		expect(sameGlowMarkers(a, b)).toBe(true);
		expect(sameGlowMarkers(a, null)).toBe(false);
		expect(sameGlowMarkers(null, null)).toBe(true);
		expect(sameGlowMarkers(a, glowMarkersFor([labels[0]], GLOW_DEFAULT))).toBe(
			false,
		);
		expect(
			sameGlowMarkers(
				a,
				glowMarkersFor(labels, { ...GLOW_DEFAULT, falloff: 2 }),
			),
		).toBe(false);
		const moved = glowMarkersFor(
			[labels[0], { u: 0.7, v: 0.41 }],
			GLOW_DEFAULT,
		);
		expect(sameGlowMarkers(a, moved)).toBe(false);
	});
	it("glowUniformsOf converts the tint to linear and forwards the module props", () => {
		const u = glowUniformsOf({ ...GLOW_DEFAULT, tint: "#ffffff" });
		expect(u.tint[0]).toBeCloseTo(1, 6);
		const dark = glowUniformsOf({ ...GLOW_DEFAULT, tint: "#808080" });
		expect(dark.tint[0]).toBeLessThan(0.25);
		expect(u.pointGlow.falloff).toBe(GLOW_DEFAULT.falloff);
		expect(u.radiusPx).toBe(GLOW_DEFAULT.radiusPx);
	});
});
