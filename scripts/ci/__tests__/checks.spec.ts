// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The regression gate's registry (scripts/ci/checks.mjs) is itself under test: ids unique, commands
// point at files that exist, browser checks go through the render lock and pin their engine, and
// every standalone check script in the tree is either registered or listed below with a reason.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs registry without type declarations
import { CHECKS } from "../checks.mjs";

type Check = {
	id: string;
	tier: "fast" | "full";
	group: string;
	cmd?: string[];
	builtin?: string;
	browser?: boolean;
	needs?: string[];
	timeoutS?: number;
	gate?: unknown;
};

const checks = CHECKS as Check[];

/** Check scripts deliberately outside the registry: they need a real browser / GPU, or are type-only. */
const UNREGISTERED: Record<string, string> = {
	"src/lib/renderer.check.ts": "type-only; enforced by the tsc row",
	"src/lib/deck-webgpu/engine.check.ts":
		"in-browser check (imports virtual:photos, needs a WebGPU device)",
};

const tracked = (patterns: string[]) =>
	execFileSync("git", ["ls-files", ...patterns], { encoding: "utf8" })
		.trim()
		.split("\n")
		.filter(Boolean);

describe("check registry", () => {
	it("has unique ids", () => {
		const ids = checks.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("gives every check a tier, a group and a command or builtin", () => {
		for (const c of checks) {
			expect(["fast", "full"], c.id).toContain(c.tier);
			expect(c.group, c.id).toBeTruthy();
			expect(!!c.cmd || !!c.builtin, c.id).toBe(true);
			if (c.timeoutS != null) expect(c.timeoutS, c.id).toBeGreaterThan(0);
		}
	});

	it("only references scripts that exist", () => {
		for (const c of checks)
			for (const arg of c.cmd ?? [])
				if (/^(src|scripts|tools)\/.*\.(ts|mjs|js)$/.test(arg))
					expect(existsSync(arg), `${c.id}: ${arg}`).toBe(true);
	});

	it("keeps the fast tier off the browser and the full tier under the render lock", () => {
		for (const c of checks) {
			if (c.tier === "fast") expect(c.browser ?? false, c.id).toBe(false);
			if (c.browser)
				expect(c.cmd?.slice(0, 2), c.id).toEqual([
					"node",
					"scripts/gpu/with-render-lock.mjs",
				]);
		}
	});

	it("pins the engine in every browser check that takes --renderer", () => {
		for (const c of checks.filter((x) => x.browser)) {
			const i = c.cmd?.indexOf("--renderer") ?? -1;
			if (i < 0) continue;
			expect(["webgpu", "deck"], c.id).toContain(c.cmd?.[i + 1]);
		}
	});

	it("registers the unit test system", () => {
		const unit = checks.find((c) => c.id === "unit");
		expect(unit?.tier).toBe("fast");
		expect(unit?.cmd).toContain("vitest");
	});

	it("registers every tracked check script (or lists why not)", () => {
		const registered = new Set(checks.flatMap((c) => c.cmd ?? []));
		const scripts = tracked([
			"src/**/*.check.ts",
			"src/**/*.test.ts",
			"scripts/**/*.check.ts",
			"scripts/**/*.check.mjs",
			"tools/**/*.check.ts",
		]);
		const orphans = scripts.filter(
			(f) => !registered.has(f) && !(f in UNREGISTERED),
		);
		expect(orphans).toEqual([]);
		for (const f of Object.keys(UNREGISTERED))
			expect(existsSync(f), `stale UNREGISTERED entry ${f}`).toBe(true);
	});

	it("keeps known-failures.json well formed and pointing at real checks", () => {
		const known = JSON.parse(
			readFileSync("scripts/ci/known-failures.json", "utf8"),
		);
		const ids = new Set(checks.map((c) => c.id));
		for (const id of Object.keys(known.checks ?? {}))
			expect(ids.has(id), `known failure for unknown check ${id}`).toBe(true);
	});
});

describe("scripts/ci/README.md", () => {
	// A row's first cell names one or more ids: "a, b", "fam-x / -y" (shorthand for fam-y), or "fam-*".
	const cells = readFileSync("scripts/ci/README.md", "utf8")
		.split("\n")
		.filter((l) => /^\| [a-z]/.test(l))
		.map((l) => l.split("|")[1]);
	const documented = (id: string) =>
		cells.some((cell) => {
			const tokens = cell
				.replace(/\([^)]*\)/g, (m) => m.replace(/,/g, " "))
				.split(/[,/]/)
				.flatMap((t) => t.trim().split(/\s+/))
				.filter(Boolean);
			const family = tokens[0]?.split("-")[0];
			return tokens.some(
				(t) =>
					t === id ||
					(t.endsWith("*") && id.startsWith(t.slice(0, -1))) ||
					(t.startsWith("-") && id === `${family}${t}`) ||
					(t.startsWith("-") && id.endsWith(t) && id.startsWith(family)) ||
					(cell.includes("layer-*") && id === `layer-${t}`),
			);
		});

	it("documents every check id in the table", () => {
		expect(checks.map((c) => c.id).filter((id) => !documented(id))).toEqual([]);
	});
});
