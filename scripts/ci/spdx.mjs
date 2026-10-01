#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// SPDX header check (luma.gl convention: every first-party source file declares its licence AND each
// copyright holder in its first lines).
//   node scripts/ci/spdx.mjs          report: files missing the header, and files left for a human
//   node scripts/ci/spdx.mjs --fix    prepend the Rigi header to the files that are plainly ours
//   node scripts/ci/spdx.mjs --list   also print every file that is missing a header
//   node scripts/ci/spdx.mjs --strict also fail on files that need a human decision
//
// Scope: src/**/*.{ts,tsx,css}, scripts/**/*.{ts,mjs,js}, tools/**/*.{ts,mjs,js}, examples/**/*.{ts,css,html,mjs}.
// Left out: node_modules, out, dist, dot-directories (.venv, .pylib*, .vite*), vendored or generated trees
// (tools/matcher/stage1/vendor*, tools/bench/data*, tools/bench/final, src/routeTree.gen.ts).
//
// A file that lacks the header but already mentions another licence, copyright, "ported from" or
// "adapted from" in its first lines is SKIPPED, never rewritten: a human decides which licence and
// holders apply. (Never infer MIT for vendored or third-party code.)
//
// Exit 1 when any file lacks the header and --fix was not given (skipped files only count with --strict).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

const ROOTS = {
	src: [".ts", ".tsx", ".css"],
	scripts: [".ts", ".mjs", ".js"],
	tools: [".ts", ".mjs", ".js"],
	examples: [".ts", ".css", ".html", ".mjs"],
};
const SKIP_DIR_NAMES = new Set(["node_modules", "out", "dist", "target"]);
const SKIP_PREFIXES = [
	"tools/matcher/stage1/vendor",
	"tools/bench/data",
	"tools/bench/final",
];
const SKIP_FILES = new Set(["src/routeTree.gen.ts"]);

const HEADER_LINES = 5;
const SCAN_LINES = 30;
const OTHER_ORIGIN =
	/copyright|\blicen[cs]e\b|\blicen[cs]ed\b|\bported from\b|\badapted from\b|\b(MIT|BSD|Apache|GPL|LGPL|MPL)\b|SPDX-/i;

const LINE_HEADER = [
	"// Rigi",
	"// SPDX-License-Identifier: MIT",
	"// SPDX-FileCopyrightText: Copyright (c) Rigi contributors",
	"",
	"",
].join("\n");
const BLOCK_HEADER = [
	"/* Rigi",
	" * SPDX-License-Identifier: MIT",
	" * SPDX-FileCopyrightText: Copyright (c) Rigi contributors",
	" */",
	"",
	"",
].join("\n");
const HTML_HEADER = [
	"<!-- Rigi",
	"     SPDX-License-Identifier: MIT",
	"     SPDX-FileCopyrightText: Copyright (c) Rigi contributors",
	"-->",
	"",
].join("\n");

function* walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) continue;
		const path = join(dir, entry.name);
		const rel = relative(ROOT, path).split("\\").join("/");
		if (SKIP_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;
		if (entry.isDirectory()) yield* walk(path);
		else if (entry.isFile()) yield path;
	}
}

function collectFiles() {
	const files = [];
	for (const [root, extensions] of Object.entries(ROOTS)) {
		const dir = join(ROOT, root);
		if (!existsSync(dir)) continue;
		for (const path of walk(dir)) {
			const rel = relative(ROOT, path).split("\\").join("/");
			if (SKIP_FILES.has(rel)) continue;
			if (extensions.includes(extname(path))) files.push(rel);
		}
	}
	return files.sort();
}

function classify(text) {
	const lines = text.split("\n");
	const head = lines.slice(0, HEADER_LINES).join("\n");
	if (
		head.includes("SPDX-License-Identifier") &&
		head.includes("SPDX-FileCopyrightText")
	)
		return { status: "ok" };
	const scan = lines.slice(0, SCAN_LINES).join("\n");
	const hit = OTHER_ORIGIN.exec(scan);
	if (hit) return { status: "skipped", reason: `mentions "${hit[0]}"` };
	return { status: "missing" };
}

function addHeader(path, text) {
	const extension = extname(path);
	const header =
		extension === ".css"
			? BLOCK_HEADER
			: extension === ".html"
				? HTML_HEADER
				: LINE_HEADER;
	if (text.startsWith("#!")) {
		const newline = text.indexOf("\n");
		return `${text.slice(0, newline + 1)}${header}${text.slice(newline + 1)}`;
	}
	return header + text;
}

const args = new Set(process.argv.slice(2));
const files = collectFiles();
const missing = [];
const skipped = [];
for (const rel of files) {
	const text = readFileSync(join(ROOT, rel), "utf8");
	const result = classify(text);
	if (result.status === "missing") missing.push(rel);
	else if (result.status === "skipped")
		skipped.push({ rel, reason: result.reason });
}

if (args.has("--fix")) {
	for (const rel of missing) {
		const path = join(ROOT, rel);
		writeFileSync(path, addHeader(path, readFileSync(path, "utf8")));
	}
}

const fixed = args.has("--fix");
console.log(
	`spdx: ${files.length} files, ${files.length - missing.length - skipped.length} with header, ${missing.length} ${fixed ? "fixed" : "missing"}, ${skipped.length} skipped (need a human decision)`,
);
if (args.has("--list") && !fixed)
	for (const rel of missing) console.log(`  missing  ${rel}`);
for (const { rel, reason } of skipped)
	console.log(`  skipped  ${rel}  (${reason})`);
if (missing.length && !fixed && !args.has("--list")) {
	console.log(
		"Run with --list to see the missing files, --fix to add the header.",
	);
}
process.exit(
	(missing.length && !fixed) || (args.has("--strict") && skipped.length)
		? 1
		: 0,
);
