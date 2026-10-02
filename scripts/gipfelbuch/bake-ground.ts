// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * The per-photo ground palette for the Gipfelbuch explainer grammar (grammar.md §3): for each demo photo,
 * the median tone of the sky above the eye's skyline, of the terrain below it and of a ±2 % band around
 * it. Figure turns it into `--fig-*` CSS vars (viz/ground.ts), so a figure's ground takes its cue from
 * its own photo without the photo itself ever being filtered.
 *
 *   npx tsx scripts/gipfelbuch/bake-ground.ts        (macOS: decodes with `sips`; needs public/demo/gipfelbuch/<id>.json)
 *
 * Writes src/components/gipfelbuch/viz/ground-palette.json (about 1.5 KB). Deterministic: re-running on
 * the same photos gives the same file.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type GroundPalette,
	measurePalette,
} from "../../src/components/gipfelbuch/viz/ground";
import { ROOT } from "../lib/node-io";

const DATA = path.join(ROOT, "public", "demo", "gipfelbuch");
const OUT = path.join(
	ROOT,
	"src",
	"components",
	"gipfelbuch",
	"viz",
	"ground-palette.json",
);

/** A 24-bit BMP (as `sips` writes it) to row-major RGB. */
function readBmp(file: string): {
	rgb: Uint8Array;
	width: number;
	height: number;
} {
	const b = fs.readFileSync(file);
	if (b.toString("ascii", 0, 2) !== "BM") throw new Error(`${file}: not a BMP`);
	const offset = b.readUInt32LE(10);
	const width = b.readInt32LE(18);
	const rawH = b.readInt32LE(22);
	const bpp = b.readUInt16LE(28);
	if (bpp !== 24 && bpp !== 32) throw new Error(`${file}: ${bpp} bpp`);
	const height = Math.abs(rawH);
	const px = bpp / 8;
	const stride = Math.ceil((width * px) / 4) * 4;
	const rgb = new Uint8Array(width * height * 3);
	for (let y = 0; y < height; y++) {
		// a positive height is stored bottom-up
		const src = offset + (rawH > 0 ? height - 1 - y : y) * stride;
		for (let x = 0; x < width; x++) {
			const i = src + x * px;
			const o = (y * width + x) * 3;
			rgb[o] = b[i + 2];
			rgb[o + 1] = b[i + 1];
			rgb[o + 2] = b[i];
		}
	}
	return { rgb, width, height };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rigi-ground-"));
const out: Record<string, GroundPalette> = {};
try {
	const ids = fs
		.readdirSync(DATA)
		.filter((f) => /^demo-\d+\.json$/.test(f))
		.map((f) => f.replace(/\.json$/, ""))
		.sort();
	for (const id of ids) {
		const data = JSON.parse(
			fs.readFileSync(path.join(DATA, `${id}.json`), "utf8"),
		);
		const photo = path.join(ROOT, "public", data.photo.src);
		const rows: (number | null)[] = data.skyline?.rows ?? data.solvedRows;
		if (!fs.existsSync(photo) || !rows) {
			console.warn(`${id}: no photo or skyline, skipped`);
			continue;
		}
		const bmp = path.join(tmp, `${id}.bmp`);
		// the photo at its working size (the skyline rows' px)
		execFileSync(
			"sips",
			[
				"-s",
				"format",
				"bmp",
				"-z",
				String(data.photo.height),
				String(data.photo.width),
				photo,
				"--out",
				bmp,
			],
			{ stdio: "ignore" },
		);
		const img = readBmp(bmp);
		const palette = measurePalette(img.rgb, img.width, img.height, rows);
		if (!palette) {
			console.warn(`${id}: no sky, terrain or horizon pixels, skipped`);
			continue;
		}
		out[id] = palette;
		console.log(id, palette.sky, palette.terrain, palette.horizon);
	}
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
fs.writeFileSync(OUT, `${JSON.stringify(out, null, "\t")}\n`);
console.log(
	`wrote ${path.relative(ROOT, OUT)} (${fs.statSync(OUT).size} bytes)`,
);
