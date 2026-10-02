// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	BRAND,
	BRAND_CODES,
	BRAND_LIGHT,
	BRAND_LIGHT_CODES,
	BREZINE,
	type BrandRole,
	brandAlpha,
	brandVar,
} from "../khipu";

const ROLES = Object.keys(BRAND_CODES) as BrandRole[];

const luminance = (hex: string) => {
	const n = Number.parseInt(hex.slice(1), 16);
	const lin = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
		const c = v / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
};
const contrast = (a: string, b: string) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};

describe("BREZINE chart", () => {
	it("every swatch is a lowercase #rrggbb with a name and class", () => {
		for (const [code, c] of Object.entries(BREZINE)) {
			expect(c.hex, code).toMatch(/^#[0-9a-f]{6}$/);
			expect(c.name.length, code).toBeGreaterThan(0);
			expect(c.cls, code).toMatch(
				/^(white|red|orange|yellow|green|blue-green|brown|olive|grey|black)$/,
			);
		}
	});
	it("has unique codes and no two codes share a hex swatch except documented ones", () => {
		const byHex = new Map<string, string[]>();
		for (const [code, c] of Object.entries(BREZINE))
			byHex.set(c.hex, [...(byHex.get(c.hex) ?? []), code]);
		for (const [hex, codes] of byHex) expect(codes, hex).toHaveLength(1);
	});
	it("class members are neighbours in the chart order (rows are contiguous)", () => {
		const classes = Object.values(BREZINE).map((c) => c.cls);
		const seen = new Set<string>();
		let prev = "";
		for (const c of classes) {
			if (c !== prev) {
				expect(seen.has(c), `class ${c} reappears`).toBe(false);
				seen.add(c);
				prev = c;
			}
		}
	});
});

describe("brand roles", () => {
	it("dark and light tables cover the same ten roles", () => {
		expect(Object.keys(BRAND_LIGHT_CODES).sort()).toEqual([...ROLES].sort());
		expect(Object.keys(BRAND).sort()).toEqual([...ROLES].sort());
		expect(Object.keys(BRAND_LIGHT).sort()).toEqual([...ROLES].sort());
		expect(ROLES).toHaveLength(10);
	});
	it("BRAND / BRAND_LIGHT hexes are the chart swatches of the role codes", () => {
		for (const r of ROLES) {
			expect(BRAND[r], r).toBe(BREZINE[BRAND_CODES[r]].hex);
			expect(BRAND_LIGHT[r], r).toBe(BREZINE[BRAND_LIGHT_CODES[r]].hex);
		}
	});
	it("known anchors: ink is black, paper white-ish; light inverts them", () => {
		expect(BRAND.ink).toBe("#131313");
		expect(BRAND.paper).toBe("#f4f4f4");
		expect(BRAND_LIGHT.ink).toBe("#f4f4f4");
		expect(BRAND_LIGHT.paper).toBe("#131313");
	});
	it("body text is readable on its own ground in both themes (WCAG AAA 7:1)", () => {
		expect(contrast(BRAND.paper, BRAND.ink)).toBeGreaterThan(7);
		expect(contrast(BRAND_LIGHT.paper, BRAND_LIGHT.ink)).toBeGreaterThan(7);
	});
	it("callout tones keep at least 3:1 against the page ground (large text / UI)", () => {
		for (const r of ["glow", "lesson", "trap", "result"] as const)
			expect(contrast(BRAND[r], BRAND.ink), `dark ${r}`).toBeGreaterThan(3);
		// light-theme counterparts re-ink so they stay legible on the light ground
		for (const r of ["glow", "lesson", "trap", "result"] as const)
			expect(
				contrast(BRAND_LIGHT[r], BRAND_LIGHT.ink),
				`light ${r}`,
			).toBeGreaterThan(3);
	});
	it("slate is a raised panel: distinct from but close to the ground", () => {
		expect(BRAND.slate).not.toBe(BRAND.ink);
		expect(contrast(BRAND.slate, BRAND.ink)).toBeLessThan(2);
		expect(BRAND_LIGHT.slate).not.toBe(BRAND_LIGHT.ink);
	});
});

describe("src/styles.css mirrors khipu.ts", () => {
	const css = readFileSync(
		new URL("../../styles.css", import.meta.url),
		"utf8",
	);
	it("--khipu-* swatches equal BREZINE", () => {
		const found = [
			...css.matchAll(/--khipu-([a-z0-9]+):\s*(#[0-9a-fA-F]{6})/g),
		];
		expect(found.length).toBeGreaterThan(10);
		for (const [, code, hex] of found) {
			const key = Object.keys(BREZINE).find((k) => k.toLowerCase() === code);
			expect(key, `--khipu-${code}`).toBeDefined();
			expect(hex.toLowerCase()).toBe(BREZINE[key as keyof typeof BREZINE].hex);
		}
	});
	const block = (selector: string) => {
		const start = css.indexOf(selector);
		expect(start, selector).toBeGreaterThanOrEqual(0);
		return css.slice(start, css.indexOf("}", start));
	};
	const roles = (b: string) =>
		Object.fromEntries(
			[...b.matchAll(/--rigi-([a-z]+):\s*var\(--khipu-([a-z0-9]+)\)/g)].map(
				(m) => [m[1], m[2]],
			),
		);
	it("the dark role block maps roles to BRAND_CODES", () => {
		const dark = roles(block("[data-theme='dark'] {"));
		for (const r of ROLES)
			expect(dark[r], r).toBe(BRAND_CODES[r].toLowerCase());
	});
	it("the light role block maps roles to BRAND_LIGHT_CODES (slate is the documented CSS-only mix)", () => {
		const light = roles(block(":root[data-theme='light'] {"));
		for (const r of ROLES) {
			if (r === "slate") continue;
			expect(light[r], r).toBe(BRAND_LIGHT_CODES[r].toLowerCase());
		}
	});
});

describe("brandAlpha", () => {
	it("builds rgba() from the dark or light value", () => {
		expect(brandAlpha("ink", 0.5)).toBe("rgba(19,19,19,0.5)");
		expect(brandAlpha("paper", 1)).toBe("rgba(244,244,244,1)");
		expect(brandAlpha("ink", 0.25, "light")).toBe("rgba(244,244,244,0.25)");
	});
});

describe("brandVar", () => {
	it("is the bare CSS variable when opaque or alpha is omitted", () => {
		expect(brandVar("glow")).toBe("var(--rigi-glow)");
		expect(brandVar("glow", 1)).toBe("var(--rigi-glow)");
		expect(brandVar("glow", 3)).toBe("var(--rigi-glow)");
	});
	it("is a percentage colour-mix for translucency", () => {
		expect(brandVar("paper", 0.35)).toBe(
			"color-mix(in oklab, var(--rigi-paper) 35%, transparent)",
		);
		expect(brandVar("paper", 0)).toBe(
			"color-mix(in oklab, var(--rigi-paper) 0%, transparent)",
		);
	});
});
