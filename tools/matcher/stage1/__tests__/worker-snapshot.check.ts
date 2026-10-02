// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check for the stage-1 render workers: `npx tsx tools/matcher/stage1/__tests__/worker-snapshot.check.ts`
//  - both snapshots equal what make_worker_snapshot.mjs generates from the server worker (no drift)
//  - the snapshot only differs from the server file by the documented changes
//  - no three.js PhotoEngine API (e.renderer.*, geoRT, e.scene / e.cam) is left in either worker
//  - the worker speaks every command s1.py and tools/bench/final send
//  - the relative ROOT / gpu-args paths resolve to real files from the snapshot directories
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
	SERVER_WORKER,
	SNAPSHOT_PATHS,
	snapshotWorkerSource,
	// @ts-expect-error plain .mjs tool without type declarations
} from "../make_worker_snapshot.mjs";

const serverSource = fs.readFileSync(SERVER_WORKER, "utf8");
const expected: string = snapshotWorkerSource(serverSource);

for (const snapshotPath of SNAPSHOT_PATHS as string[]) {
	const source = fs.readFileSync(snapshotPath, "utf8");
	assert.equal(
		source,
		expected,
		`${snapshotPath} drifted: run node tools/matcher/stage1/make_worker_snapshot.mjs`,
	);

	// documented differences only: the diff is the note, two path edits and the closeAll branch
	const serverLines = new Set(serverSource.split("\n"));
	const added = source.split("\n").filter((line) => !serverLines.has(line));
	assert.ok(
		added.length <= 12,
		`unexpected extra lines in ${snapshotPath}: ${added.length}`,
	);

	// the removed engine's API must not come back
	for (const forbidden of [
		/\be\.renderer\./,
		/\bgeoRT\b/,
		/renderer\.getContext/,
		/readRenderTargetPixels/,
		/\be\.scene\b/,
		/\be\.cam\b/,
	]) {
		const codeLines = source
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("//"));
		const hit = codeLines.find((line) => forbidden.test(line));
		assert.equal(
			hit,
			undefined,
			`three.js API ${forbidden} in ${snapshotPath}`,
		);
	}

	// every command the Python clients send
	for (const cmd of [
		"ping",
		"render",
		"align",
		"edges",
		"closeAll",
		"release",
		"reload",
	]) {
		assert.ok(
			source.includes(`req.cmd === "${cmd}"`),
			`${cmd} missing in ${snapshotPath}`,
		);
	}
	// the deck engine's matcher hooks
	for (const hook of ["loadSatellite", "renderPoseView", "loadFullTerrain"]) {
		assert.ok(source.includes(hook), `${hook} missing in ${snapshotPath}`);
	}

	// ROOT and the lazily imported gpu-args module resolve from this directory
	const rootExpression = source.match(
		/const ROOT = path\.resolve\(import\.meta\.dirname, "([^"]+)"\)/,
	);
	assert.ok(rootExpression, "ROOT expression");
	const root = path.resolve(path.dirname(snapshotPath), rootExpression[1]);
	assert.ok(
		fs.existsSync(path.join(root, "package.json")),
		`ROOT ${root} is not the repo root`,
	);
	const gpuArgs = source.match(/import\("([^"]+gpu-args\.mjs)"\)/);
	assert.ok(gpuArgs, "gpu-args import");
	assert.ok(
		fs.existsSync(path.resolve(path.dirname(snapshotPath), gpuArgs[1])),
		"gpu-args.mjs not found from the snapshot directory",
	);
}

// the anchors fail loudly when the server file moves them
assert.throws(() => snapshotWorkerSource("// nothing"), /anchor not found/);

// Python clients: every cmd literal they send is handled
const matcherDir = path.resolve(import.meta.dirname, "../..");
const clientSources = [
	path.join(matcherDir, "stage1/s1.py"),
	path.join(matcherDir, "worker_client.py"),
].map((file) => fs.readFileSync(file, "utf8"));
const sentCommands = new Set<string>();
for (const text of clientSources)
	for (const match of text.matchAll(/"cmd":\s*"(\w+)"/g))
		sentCommands.add(match[1]);
for (const cmd of sentCommands)
	assert.ok(
		expected.includes(`req.cmd === "${cmd}"`),
		`client sends ${cmd}, worker lacks it`,
	);

console.log(
	`worker-snapshot: ok (${[...sentCommands].sort().join(", ")} handled)`,
);
