// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Runs the stdlib-only Python unit tests of the v3 tooling (manifest seal, arm stamps, v2 finalisation and the
// V2_SUGGEST_ONLY dry-run replay). No pytest, no venv, no torch: `python3 -m unittest` per directory.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const python = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!python)("v3 tooling python unit tests", () => {
	for (const directory of [
		"tools/matcher/stage1/__tests__",
		"tools/bench/final/__tests__",
		"tools/matcher/v2/__tests__",
	]) {
		it(directory, () => {
			const result = spawnSync(
				"python3",
				["-m", "unittest", "discover", "-s", directory, "-p", "test_*.py"],
				{
					cwd: repoRoot,
					encoding: "utf8",
					env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
				},
			);
			expect(result.stderr + result.stdout).toMatch(/\nOK\b/);
			expect(result.status).toBe(0);
		});
	}
});
