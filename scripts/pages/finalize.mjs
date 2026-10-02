// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// After `RIGI_PAGES=1 vite build`: turn .output/public into a GitHub Pages site. Pages serves 404.html for
// any path it has no file for, so a copy of the SPA shell there lets deep links (/rigi/gipfelbuch, …) boot
// the client router. The baked data under public/ (demo/manifest.json, demo/gipfelbuch/*.json, …) stores
// root-absolute URLs ("/demo/thumbs/demo-01.jpg"), which code uses as-is, so every such URL in a .json
// is rebased onto the Pages base (RIGI_PAGES_BASE, default /rigi/, as in vite.config.ts). Also drops
// macOS .DS_Store files and reports the site size (Pages caps a site at 1 GB).
import {
	copyFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? ".output/public";
const shell = join(root, "index.html");
// the SPA shell is prerendered by tanstackStart({ spa }) in vite.config.ts when RIGI_PAGES=1
if (!existsSync(shell))
	throw new Error(`${shell} missing: build with RIGI_PAGES=1`);
copyFileSync(shell, join(root, "404.html"));
writeFileSync(join(root, ".nojekyll"), "");

const base = process.env.RIGI_PAGES_BASE ?? "/rigi/";
// top-level public/ entries ("demo", "photos", "fonts", …): a JSON string starting with "/<entry>/" is a
// public URL; Vite's own output (assets/) is already based
const publicDirs = readdirSync(root, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && entry.name !== "assets")
	.map((entry) => entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const publicUrlInJson = new RegExp(`"/(${publicDirs.join("|")})/`, "g");
let rebasedFiles = 0;

let bytes = 0;
const walk = (dir) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.name === ".DS_Store") rmSync(path);
		else if (entry.isDirectory()) walk(path);
		else {
			if (entry.name.endsWith(".json")) rebaseJson(path);
			bytes += statSync(path).size;
		}
	}
};
function rebaseJson(path) {
	const text = readFileSync(path, "utf8");
	const rebased = text.replace(publicUrlInJson, `"${base}$1/`);
	if (rebased === text) return;
	writeFileSync(path, rebased);
	rebasedFiles++;
}
walk(root);
console.log(
	`pages: ${root} ready, ${(bytes / 2 ** 20).toFixed(0)} MB, ${rebasedFiles} JSON files rebased onto ${base}`,
);
if (bytes > 1e9) throw new Error("GitHub Pages sites are limited to 1 GB");
