// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// After `RIGI_PAGES=1 vite build`: turn .output/public into a GitHub Pages site. Pages serves 404.html for
// any path it has no file for, so a copy of the SPA shell there lets deep links (/rigi/gipfelbuch, …) boot
// the client router. Also drops macOS .DS_Store files and reports the site size (Pages caps a site at 1 GB).
import {
	copyFileSync,
	existsSync,
	readdirSync,
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

let bytes = 0;
const walk = (dir) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.name === ".DS_Store") rmSync(path);
		else if (entry.isDirectory()) walk(path);
		else bytes += statSync(path).size;
	}
};
walk(root);
console.log(`pages: ${root} ready, ${(bytes / 2 ** 20).toFixed(0)} MB`);
if (bytes > 1e9) throw new Error("GitHub Pages sites are limited to 1 GB");
