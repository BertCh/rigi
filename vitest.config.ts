// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Unit test system (Vitest). Standalone on purpose: it does not load vite.config.ts, whose TanStack
// Start, Nitro and Tailwind plugins are for the app and only slow the test graph down.
//
//   npm test                 run every unit spec once (node + DOM projects)
//   npm run test:watch       watch mode
//   npm run test:coverage    v8 coverage → out/coverage (thresholds below are a ratchet)
//
// Specs are `*.spec.ts` (node) and `*.spec.tsx` (happy-dom), colocated with the code or in a sibling
// `__tests__/`. `*.check.ts` and the older `*.test.ts` files are standalone tsx scripts run by
// scripts/ci/run.mjs, not Vitest suites. See src/test/README.md.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// Same virtual module as vite.config.ts: public/photos/photos.json is gitignored, so fall back to [].
function photosJson(): Plugin {
	const file = fileURLToPath(
		new URL("./public/photos/photos.json", import.meta.url),
	);
	const id = "virtual:photos";
	return {
		name: "photos-json",
		resolveId: (s) => (s === id ? `\0${id}` : undefined),
		load(s) {
			if (s !== `\0${id}`) return;
			return `export default ${existsSync(file) ? readFileSync(file, "utf8") : "[]"}`;
		},
	};
}

const SRC = fileURLToPath(new URL("./src/", import.meta.url));

export default defineConfig({
	cacheDir: "node_modules/.vite-vitest",
	plugins: [photosJson()],
	resolve: {
		alias: [
			{ find: /^#\/(.*)$/, replacement: `${SRC}$1` },
			{ find: /^@\/(.*)$/, replacement: `${SRC}$1` },
		],
	},
	test: {
		globals: false,
		// Numeric solvers take seconds; the tree is shared by many sessions and CI runners are slow, so
		// the 5 s default flakes under load. A spec that needs more says so itself.
		testTimeout: 30_000,
		hookTimeout: 30_000,
		restoreMocks: true,
		unstubGlobals: true,
		unstubEnvs: true,
		setupFiles: ["src/test/setup.ts"],
		reporters: process.env.CI ? ["default", "junit"] : ["default"],
		outputFile: { junit: "out/test/junit.xml" },
		projects: [
			{
				extends: true,
				test: {
					name: "node",
					environment: "node",
					include: [
						"src/**/*.spec.ts",
						"scripts/**/*.spec.ts",
						"tools/**/*.spec.ts",
					],
				},
			},
			{
				extends: true,
				test: {
					name: "dom",
					environment: "happy-dom",
					include: ["src/**/*.spec.tsx"],
				},
			},
		],
		coverage: {
			provider: "v8",
			reportsDirectory: "out/coverage",
			reporter: ["text-summary", "html", "json-summary"],
			include: ["src/lib/**/*.ts", "src/brand/**/*.ts"],
			exclude: [
				"**/*.check.ts",
				"**/*.test.ts",
				"**/*.spec.ts",
				"**/*.d.ts",
				"**/__tests__/**",
				"src/test/**",
			],
			// Ratchet, set 2-3 points under the 2026-10-02 measurement (lines 50.5% overall): raise these
			// when coverage grows, never lower them to make a change pass. The pure-CPU core (geometry,
			// pose, refine, DEM, export, horizon) has its own, higher floor.
			thresholds: {
				statements: 48,
				branches: 43,
				functions: 44,
				lines: 48,
				"src/lib/{geo,refine,pose6dof,dem,export,horizon-fast,linalg,camera,concord}/**/*.ts":
					{ statements: 85, branches: 75, functions: 85, lines: 85 },
			},
		},
	},
});
