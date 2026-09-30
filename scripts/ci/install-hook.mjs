#!/usr/bin/env node
// Optional git pre-push hook that runs the fast tier of the regression gate (scripts/ci/run.mjs).
// Nothing installs this automatically; run it yourself if you want it:
//   node scripts/ci/install-hook.mjs              install .git/hooks/pre-push
//   node scripts/ci/install-hook.mjs --uninstall  remove it (only if this script wrote it)
//   node scripts/ci/install-hook.mjs --force      replace a pre-push hook something else wrote
// Bypass once with `git push --no-verify`. The hook checks biome on the files changed since the
// upstream (--biome changed); CI checks every file.
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const MARK = "# rigi-ci pre-push hook (scripts/ci/install-hook.mjs)";
const hooksDir = resolve(
	ROOT,
	execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
		cwd: ROOT,
		encoding: "utf8",
	}).trim(),
);
const hook = join(hooksDir, "pre-push");
const ours = existsSync(hook) && readFileSync(hook, "utf8").includes(MARK);

if (process.argv.includes("--uninstall")) {
	if (!existsSync(hook)) console.log("no pre-push hook installed");
	else if (!ours) {
		console.error(`${hook} was not written by this script; leaving it alone`);
		process.exit(1);
	} else {
		rmSync(hook);
		console.log(`removed ${hook}`);
	}
	process.exit(0);
}

if (existsSync(hook) && !ours && !process.argv.includes("--force")) {
	console.error(
		`${hook} already exists and was not written by this script; pass --force to replace it`,
	);
	process.exit(1);
}

mkdirSync(hooksDir, { recursive: true });
writeFileSync(
	hook,
	`#!/bin/sh
${MARK}
# Runs the fast tier of the regression gate before every push. Skip once: git push --no-verify
cd "$(git rev-parse --show-toplevel)" || exit 1
exec node scripts/ci/run.mjs fast --biome changed
`,
);
chmodSync(hook, 0o755);
console.log(`installed ${hook} (fast tier; bypass with git push --no-verify)`);
