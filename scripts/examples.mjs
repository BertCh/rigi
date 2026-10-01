// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The standalone luma.gl / deck.gl examples under examples/ (see examples/README.md). Each example is a folder
// with its own package.json, laid out like luma.gl's examples/, but resolving packages from the root install
// (luma.gl runs them as yarn workspaces; we keep one lockfile).
//
//   node scripts/examples.mjs list
//   node scripts/examples.mjs start deck/summit-view      vite dev server for one example
//   node scripts/examples.mjs build [id…]                 tsc -p + vite build into out/examples/<id> (all by default)
//   node scripts/examples.mjs check [id…]                 tsc -p only (CI fast tier: no browser, no network)
//   node scripts/examples.mjs smoke [id…]                 scripts/visual-smoke.mjs, under the machine-wide render lock

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const examplesRoot = join(root, "examples");

function findExamples(directory = examplesRoot) {
	const found = [];
	for (const name of readdirSync(directory)) {
		if (name === "node_modules" || name === "dist") continue;
		const path = join(directory, name);
		if (!statSync(path).isDirectory()) continue;
		if (existsSync(join(path, "package.json")))
			found.push(relative(examplesRoot, path));
		else found.push(...findExamples(path));
	}
	return found.sort();
}

function run(command, args, options = {}) {
	console.log(`$ ${command} ${args.join(" ")}`);
	const result = spawnSync(command, args, {
		stdio: "inherit",
		cwd: root,
		...options,
	});
	return result.status ?? 1;
}

const [action = "list", ...requested] = process.argv.slice(2);
const all = findExamples();
const unknown = requested.filter((id) => !all.includes(id));
if (unknown.length) {
	console.error(
		`unknown example(s): ${unknown.join(", ")}; have: ${all.join(", ")}`,
	);
	process.exit(2);
}
const selected = requested.length ? requested : all;

let failures = 0;
switch (action) {
	case "list":
		for (const id of all) console.log(id);
		break;
	case "start": {
		if (selected.length !== 1) {
			console.error("start takes exactly one example id");
			process.exit(2);
		}
		process.exit(run("npx", ["vite", join("examples", selected[0])]));
		break;
	}
	case "check":
	case "build":
		for (const id of selected) {
			const directory = join("examples", id);
			failures += run("npx", ["tsc", "--noEmit", "-p", directory]) ? 1 : 0;
			if (action === "build")
				failures += run("npx", [
					"vite",
					"build",
					directory,
					"--outDir",
					join(root, "out", "examples", id),
					"--emptyOutDir",
				])
					? 1
					: 0;
		}
		break;
	case "smoke":
		for (const id of selected) {
			const script = join("examples", id, "scripts", "visual-smoke.mjs");
			if (!existsSync(join(root, script))) {
				console.log(`${id}: no scripts/visual-smoke.mjs, skipped`);
				continue;
			}
			failures += run("node", [
				"scripts/gpu/with-render-lock.mjs",
				"--",
				"node",
				script,
			])
				? 1
				: 0;
		}
		break;
	default:
		console.error(
			`unknown action ${action}: list | start | build | check | smoke`,
		);
		process.exit(2);
}
if (failures) {
	console.error(`${failures} step(s) failed`);
	process.exit(1);
}
