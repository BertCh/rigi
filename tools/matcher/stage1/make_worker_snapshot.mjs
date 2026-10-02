// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors
//
// Regenerates the two stage-1 render workers from the service worker (tools/matcher/server/render_worker.mjs,
// the deck/WebGPU port). The three.js PhotoEngine workers they replace stopped working with 583e2b7.
//   node tools/matcher/stage1/make_worker_snapshot.mjs          # rewrite both snapshots
//   node tools/matcher/stage1/make_worker_snapshot.mjs --check  # exit 1 when a snapshot has drifted
// The snapshots stay verbatim copies except for three mechanical changes (below), so the T6 arms run the
// same render code the app serves while still being pinned against later edits of the server file.
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
export const SERVER_WORKER = path.join(HERE, "../server/render_worker.mjs");
export const SNAPSHOT_PATHS = [
	path.join(HERE, "vendor/worker.mjs"),
	path.join(HERE, "vendor_v03/render_worker.mjs"),
];

const SNAPSHOT_NOTE = `// STAGE-1 SNAPSHOT (wave5/S1): generated from tools/matcher/server/render_worker.mjs by
// tools/matcher/stage1/make_worker_snapshot.mjs. Do not edit by hand. Differences from the server file:
// ROOT and the gpu-args import resolve one directory deeper, and the \`closeAll\` command that s1.py
// sends is added.`;

const ROOT_FROM = 'path.resolve(import.meta.dirname, "../../..")';
const ROOT_TO = 'path.resolve(import.meta.dirname, "../../../..")';
const GPU_ARGS_FROM = 'import("../../../scripts/deck-webgpu/gpu-args.mjs")';
const GPU_ARGS_TO = 'import("../../../../scripts/deck-webgpu/gpu-args.mjs")';
const RELEASE_BRANCH = '\t\t\telse if (req.cmd === "release")\n';
const CLOSE_ALL_BRANCH = `\t\t\telse if (req.cmd === "closeAll") {
\t\t\t\tfor (const pageKey of [...pages.keys()]) await dropPage(pageKey);
\t\t\t\treply = { ok: true };
\t\t\t} else if (req.cmd === "release")\n`;

function replaceOnce(source, from, to) {
	// A server-file edit that moves one of these anchors must fail loudly, not silently drop a change.
	if (source.split(from).length !== 2)
		throw new Error(`snapshot anchor not found exactly once: ${from.trim()}`);
	return source.replace(from, () => to);
}

/** Turns the server worker source into the stage-1 snapshot source. */
export function snapshotWorkerSource(serverSource) {
	let source = replaceOnce(serverSource, ROOT_FROM, ROOT_TO);
	source = replaceOnce(source, GPU_ARGS_FROM, GPU_ARGS_TO);
	source = replaceOnce(source, RELEASE_BRANCH, CLOSE_ALL_BRANCH);
	const lines = source.split("\n");
	const spdxEnd = lines.findIndex((line) =>
		line.startsWith("// SPDX-FileCopyrightText"),
	);
	lines.splice(spdxEnd + 1, 0, "//", ...SNAPSHOT_NOTE.split("\n"));
	return lines.join("\n");
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === path.join(HERE, "make_worker_snapshot.mjs")
) {
	const expected = snapshotWorkerSource(fs.readFileSync(SERVER_WORKER, "utf8"));
	const check = process.argv.includes("--check");
	let drifted = 0;
	for (const target of SNAPSHOT_PATHS) {
		const current = fs.existsSync(target)
			? fs.readFileSync(target, "utf8")
			: null;
		if (current === expected) continue;
		if (check) {
			console.error(`drifted: ${path.relative(process.cwd(), target)}`);
			drifted += 1;
		} else {
			fs.writeFileSync(target, expected);
			console.log(`wrote ${path.relative(process.cwd(), target)}`);
		}
	}
	process.exit(drifted ? 1 : 0);
}
