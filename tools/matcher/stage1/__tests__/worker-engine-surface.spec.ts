// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node-only smoke for the stage-1 render workers (no browser is launched): both parse (`node --check`), and
// every member of window.__engine they touch exists on the Renderer interface and on both deck engines.
// What this cannot show (needs the batch browser pass, see reports/batch-ledger.md): that the calls behave.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const workers = [
	"tools/matcher/stage1/vendor/worker.mjs",
	"tools/matcher/stage1/vendor_v03/render_worker.mjs",
];
const read = (file: string) =>
	fs.readFileSync(path.join(repoRoot, file), "utf8");

// Engine members the workers read or call (e.<name> inside page.evaluate blocks). Keep in sync: the
// "no unknown e.<member>" test below fails when a worker starts using one that is not listed here.
const ENGINE_MEMBERS = [
	"loadFullTerrain",
	"autoAlign",
	"renderSet",
	"horizonDirs",
	"silTiming",
	"loadSatellite",
	"renderPoseView",
	"solvePins",
	"controlPins",
	"demAtCamera",
	"aspect",
	"terrain",
	"prior",
	"photo",
	"eye",
	"frame",
	"edge",
];
// `e.<name>` that are Playwright / node / local objects, not the engine
const NOT_ENGINE = new Set([
	"now",
	"evaluate",
	"route",
	"apply",
	"isClosed",
	"close",
	"waitForSelector",
	"resolve",
	"reload",
	"on",
	"goto",
	"error",
	"endsWith",
	"createInterface",
	"clear",
	"addInitScript",
	"message",
	"__benchFullTerrain",
	"__matcherSat",
	"x",
	"y",
	"z",
	"w",
	"h",
	"lat",
	"lon",
	"id",
	"width",
	"height",
	"fine",
	"coarse",
	"fg",
	"rgb",
	"sky",
	"length",
	"data",
]);

// not on the Renderer interface (harness-only fields of the engines)
const HARNESS_ONLY = [
	"renderSet",
	"horizonDirs",
	"silTiming",
	"controlPins",
	"edge",
];

const engineFiles = [
	"src/lib/renderer.ts",
	"src/lib/deck/engine.ts",
	"src/lib/deck-webgpu/engine.ts",
];

describe("stage-1 workers vs the deck engines", () => {
	for (const worker of workers) {
		it(`${worker} parses`, () => {
			const result = spawnSync(
				process.execPath,
				["--check", path.join(repoRoot, worker)],
				{ encoding: "utf8" },
			);
			expect(result.stderr).toBe("");
			expect(result.status).toBe(0);
		});

		it(`${worker} only touches listed engine members`, () => {
			const used = new Set(
				[
					...read(worker)
						.split("\n")
						.filter((line) => !line.trimStart().startsWith("//"))
						.join("\n")
						.matchAll(/\be\.([A-Za-z_][A-Za-z0-9_]*)/g),
				].map((match) => match[1]),
			);
			const unknown = [...used].filter(
				(name) => !ENGINE_MEMBERS.includes(name) && !NOT_ENGINE.has(name),
			);
			expect(unknown).toEqual([]);
		});
	}

	it("the two workers are identical copies", () => {
		expect(read(workers[0])).toBe(read(workers[1]));
	});

	for (const file of engineFiles) {
		it(`${file} declares every member the workers use`, () => {
			const source = read(file);
			const missing = ENGINE_MEMBERS.filter((name) => {
				// the Renderer interface only lists the public contract; the engines carry the harness-only fields
				if (file.endsWith("renderer.ts") && HARNESS_ONLY.includes(name)) {
					return false;
				}
				return !new RegExp(`(^|[\\s.])${name}\\b`, "m").test(source);
			});
			expect(missing).toEqual([]);
		});
	}

	it("the page-side modules the workers import still exist", () => {
		for (const worker of workers) {
			const imports = [
				...read(worker).matchAll(/import\("\/(src\/[^"]+\.ts)"\)/g),
			].map((match) => match[1]);
			expect(imports.length).toBeGreaterThan(0);
			for (const file of imports) {
				expect(fs.existsSync(path.join(repoRoot, file)), file).toBe(true);
			}
		}
	});
});
