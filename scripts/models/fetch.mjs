#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Fetches or produces every model in scripts/models/manifest.json into public/models and verifies
// each file's sha256 and size. See README.md.
//   node scripts/models/fetch.mjs                 # every missing or wrong file
//   node scripts/models/fetch.mjs --only a,b      # rows whose file starts with a or b
//   node scripts/models/fetch.mjs --check         # verify only (exit 1 on a missing or wrong file)
//   node scripts/models/fetch.mjs --force         # re-fetch even when the file verifies
//   node scripts/models/fetch.mjs --dir <path>    # another target directory
// A row's `producer` is either an http(s) URL (downloaded as is) or a repo-relative script
// (`.mjs` run with node, `.py` with $MODELS_PYTHON / tools/matcher/.venv / python3) called with the
// output path as its one argument.

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { download, python, ROOT, run, sha256File } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const check = args.includes("--check");
const force = args.includes("--force");
const only = opt("--only")?.split(",").filter(Boolean);
const dir = resolve(opt("--dir") ?? join(ROOT, "public/models"));

const manifest = JSON.parse(
	readFileSync(join(ROOT, "scripts/models/manifest.json"), "utf8"),
);
const rows = manifest.filter(
	(r) => !only || only.some((o) => r.file.startsWith(o)),
);
if (only && rows.length === 0) {
	console.error(`no manifest row matches ${only.join(",")}`);
	process.exit(2);
}

async function verify(row, path) {
	if (!existsSync(path)) return "missing";
	if (statSync(path).size !== row.bytes)
		return `size ${statSync(path).size} != ${row.bytes}`;
	const sha = await sha256File(path);
	return sha === row.sha256
		? "ok"
		: `sha256 ${sha.slice(0, 16)}… != ${row.sha256.slice(0, 16)}…`;
}

async function produce(row, out) {
	const p = row.producer;
	if (/^https?:\/\//.test(p)) return download(p, out);
	const script = join(ROOT, p);
	if (!existsSync(script)) throw new Error(`producer ${p} not found`);
	if (p.endsWith(".mjs") || p.endsWith(".js"))
		return run(process.execPath, [script, out]);
	if (p.endsWith(".py")) return run(python(), [script, out]);
	throw new Error(`producer ${p}: expected a URL, .mjs or .py`);
}

mkdirSync(dir, { recursive: true });
let failed = 0;
for (const row of rows) {
	const path = join(dir, row.file);
	const mb = `${(row.bytes / 1e6).toFixed(1)} MB`;
	const state = await verify(row, path);
	if (state === "ok" && !force) {
		console.log(`ok       ${row.file} (${mb})`);
		continue;
	}
	if (check) {
		console.log(
			`${state === "missing" ? "MISSING" : "BAD    "}  ${row.file}${state === "missing" ? "" : `: ${state}`}`,
		);
		failed++;
		continue;
	}
	console.log(`fetch    ${row.file} (${mb}, ${row.licence}) ← ${row.producer}`);
	const tmp = `${path}.new`;
	try {
		rmSync(tmp, { force: true });
		await produce(row, tmp);
		const got = await verify(row, tmp);
		if (got !== "ok") throw new Error(got);
		renameSync(tmp, path);
		console.log(`ok       ${row.file}`);
	} catch (e) {
		rmSync(tmp, { force: true });
		console.error(
			`FAIL     ${row.file}: ${e instanceof Error ? e.message : e}`,
		);
		failed++;
	}
}
process.exit(failed ? 1 : 0);
