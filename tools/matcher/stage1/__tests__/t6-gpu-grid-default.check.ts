// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check: `npx tsx tools/matcher/stage1/__tests__/t6-gpu-grid-default.check.ts`
// The T6 GPU skyline grid is on by default and T6_GPU_GRID=0|off|false opts out, identically in the
// render worker (SKY_GPU) and in t6.py (GPU_GRID). Each declaration is extracted from the source and
// evaluated here, so the two sides cannot drift apart.
import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const serverDir = path.join(import.meta.dirname, "../../server");
const cases: Array<[string | undefined, boolean]> = [
	[undefined, true],
	["", true],
	["1", true],
	["0", false],
	["off", false],
	["False", false],
	[" 0 ", false],
];

const workerSource = fs.readFileSync(
	path.join(serverDir, "render_worker.mjs"),
	"utf8",
);
const jsMatch = workerSource.match(/const SKY_GPU = ([^;]*);/);
assert.ok(jsMatch, "render_worker.mjs: SKY_GPU declaration not found");
const pySource = fs.readFileSync(path.join(serverDir, "t6.py"), "utf8");
const pyMatch = pySource.match(/^GPU_GRID = (.*)$/m);
assert.ok(pyMatch, "t6.py: GPU_GRID declaration not found");

for (const [value, expected] of cases) {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.T6_GPU_GRID;
	if (value !== undefined) env.T6_GPU_GRID = value;
	const js: unknown = new Function("process", `return ${jsMatch[1]};`)({ env });
	assert.equal(js, expected, `worker SKY_GPU for T6_GPU_GRID=${value}`);
	const py: SpawnSyncReturns<string> = spawnSync(
		"python3",
		["-c", `import os\nprint(${pyMatch[1]})`],
		{
			env,
			encoding: "utf8",
		},
	);
	if (py.error || py.status !== 0) {
		console.log("SKIP python side: python3 unavailable");
		continue;
	}
	assert.equal(
		py.stdout.trim(),
		expected ? "True" : "False",
		`t6.py GPU_GRID for T6_GPU_GRID=${value}`,
	);
}
console.log("t6-gpu-grid-default: ok");
