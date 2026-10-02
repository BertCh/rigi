// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Contrast gate for the Gipfelbuch inks (design book A7, I1 table): every text ink must reach
// WCAG 4.5:1 on paper and on paper-deep; relief (BL) and MG are never text colours. Tokens are read
// from theme.css, and the role table must agree with SWISS in inks.ts.
// Run: npx tsx src/components/gipfelbuch/swiss/contrast.check.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(join(here, relative), "utf8");
const themeCss = read("theme.css");
const notebookCss = read("../notebook/notebook.css");
const paletteTs = read("inks.ts"); // SWISS lives in inks.ts (no css import); palette.ts re-exports it

type Rgb = [number, number, number];
const parseHex = (hex: string): Rgb => {
	const value = Number.parseInt(hex.slice(1), 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
	a[0] * (1 - t) + b[0] * t,
	a[1] * (1 - t) + b[1] * t,
	a[2] * (1 - t) + b[2] * t,
];
const luminance = ([r, g, b]: Rgb): number => {
	const lin = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (a: Rgb, b: Rgb): number => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};

const failures: string[] = [];
const token = (name: string): string => {
	const match = themeCss.match(
		new RegExp(`--gb-${name}:\\s*(#[0-9a-fA-F]{6})`),
	);
	if (!match) {
		failures.push(`theme.css has no --gb-${name} hex`);
		return "#000000";
	}
	return match[1].toLowerCase();
};

// Paper is W 90% + YY 10%; paper-deep is paper 80% + LG 20% (same maths as theme.css).
const paper = mix(parseHex("#f4f4f4"), parseHex("#ffdb8b"), 0.1);
const paperDeep = mix(paper, parseHex("#baaf96"), 0.2);

const textInks = [
	"ink",
	"secondary",
	"water",
	"forest",
	"contour",
	"red",
	"navy",
	"pencil",
] as const;

console.log("ink        hex      on paper  on paper-deep");
for (const name of textInks) {
	const hex = token(name);
	const onPaper = ratio(parseHex(hex), paper);
	const onDeep = ratio(parseHex(hex), paperDeep);
	console.log(
		`${name.padEnd(10)} ${hex}  ${onPaper.toFixed(2).padStart(6)}  ${onDeep.toFixed(2).padStart(10)}`,
	);
	if (onPaper < 4.5)
		failures.push(`${name} ${hex} is ${onPaper.toFixed(2)}:1 on paper (< 4.5)`);
	if (onDeep < 4.5)
		failures.push(
			`${name} ${hex} is ${onDeep.toFixed(2)}:1 on paper-deep (< 4.5)`,
		);
}

// Relief (BL) must stay under 4.5 by design: if it ever passes, the role table is stale.
const relief = token("relief");
console.log(
	`relief     ${relief}  ${ratio(parseHex(relief), paper).toFixed(2).padStart(6)}  (hairlines only)`,
);

// Role table: BL (relief) and MG are never a text colour in the Gipfelbuch stylesheets.
for (const [file, css] of [
	["theme.css", themeCss],
	["notebook.css", notebookCss],
]) {
	for (const [index, line] of css.split("\n").entries()) {
		const declaration = line.trim();
		if (declaration.startsWith("--") || declaration.startsWith("/*")) continue;
		if (
			/(^|[\s;])color:\s*(var\(--gb-relief|#919192|#817066)/i.test(declaration)
		) {
			failures.push(
				`${file}:${index + 1} sets a text colour from relief/MG: ${declaration}`,
			);
		}
	}
}
for (const textClass of [
	/\.gb-coord\s*\{[^}]*color:\s*([^;]+);/,
	/\.gb-caps\s*\{[^}]*color:\s*([^;]+);/,
]) {
	const match = themeCss.match(textClass);
	if (match && /relief|919192|817066/i.test(match[1])) {
		failures.push(`${textClass} uses relief/MG as its text colour`);
	}
}
if (!/\.gb-coord\s*\{[^}]*color:\s*var\(--gb-secondary\)/.test(themeCss)) {
	failures.push(".gb-coord must be coloured with --gb-secondary");
}

// theme.css tokens and inks.ts SWISS come from the same Brezine swatches.
for (const [name, code] of [
	["ink", "LK"],
	["contour", "NB"],
	["water", "GL"],
	["forest", "GG"],
	["relief", "BL"],
	["red", "SR"],
	["secondary", "BG"],
	["pencil", "GR"],
	["navy", "PB"],
] as const) {
	if (!new RegExp(`${name}:\\s*BREZINE\\.${code}\\.hex`).test(paletteTs)) {
		failures.push(`inks.ts SWISS.${name} is not BREZINE.${code}`);
	}
}

if (failures.length) {
	console.error(`\nFAIL (${failures.length})`);
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
console.log("\ngipfelbuch-contrast: ok");
