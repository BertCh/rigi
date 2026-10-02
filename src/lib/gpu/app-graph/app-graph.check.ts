// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// App graph manifest ↔ code (WAG W0.3), node-only. Every core cachedGraph group used in
// src/lib/gpu/**, src/lib/deck-webgpu/** and src/lib/matcher/** is declared in manifest.ts (GPU_MODULES or
// TEST_GRAPH_GROUPS), and every declared group is used. Group arguments are string literals or
// constants (`const X = "…"` / `const X = OTHER`, resolved in the same file, else in the file a relative
// import names, else across the scanned tree when unambiguous). Also: island ids valid, ids and groups unique, declared paths exist.
// Run: npx tsx src/lib/gpu/app-graph/app-graph.check.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
	GPU_MODULES,
	ISLAND_IDS,
	ISLANDS,
	listModules,
	moduleOfGraph,
	registerIsland,
	TEST_GRAPH_GROUPS,
} from "./manifest";

const ROOT = join(import.meta.dirname, "../../../..");
const SCAN = ["src/lib/gpu", "src/lib/deck-webgpu", "src/lib/matcher"];

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

const walk = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) return walk(p);
		return /\.tsx?$/.test(name) ? [p] : [];
	});

/** Source without comments (line comments, block comments, JSDoc), strings kept. */
const stripComments = (src: string) =>
	src
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((l) => (/^\s*\/\//.test(l) ? "" : l))
		.join("\n");

const files = SCAN.flatMap((d) => walk(join(ROOT, d))).map((path) => ({
	path,
	rel: relative(ROOT, path),
	src: stripComments(readFileSync(path, "utf8")),
}));

// string constants: NAME → values per file (`const NAME = "v"` or `const NAME = OTHER`)
const consts = new Map<string, { rel: string; value: string }[]>();
for (const f of files)
	for (const m of f.src.matchAll(
		/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*("[^"\n]*"|[A-Za-z_$][\w$]*)\s*;/g,
	)) {
		const list = consts.get(m[1]) ?? [];
		list.push({ rel: f.rel, value: m[2] });
		consts.set(m[1], list);
	}

/** The scanned file a relative import of NAME in `rel` points at (null: not imported relatively). */
const importedFrom = (name: string, rel: string): string | null => {
	const src = files.find((f) => f.rel === rel)?.src ?? "";
	for (const m of src.matchAll(
		/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"(\.[^"]+)"/g,
	))
		if (
			m[1].split(",").some((n) => n.trim().replace(/^type\s+/, "") === name)
		) {
			const base = join(rel, "..", m[2]);
			for (const ext of [".ts", ".tsx", "/index.ts"])
				if (files.some((f) => f.rel === base + ext)) return base + ext;
		}
	return null;
};

const resolve = (expr: string, rel: string, depth = 0): string | null => {
	if (expr.startsWith('"')) return expr.slice(1, -1);
	if (depth > 8) return null;
	const list = consts.get(expr) ?? [];
	const own = list.filter((c) => c.rel === rel);
	const from = importedFrom(expr, rel);
	const imported = list.filter((c) => c.rel === from);
	const pick = own.length ? own : imported.length ? imported : list;
	const values = new Set(
		pick
			.map((c) => resolve(c.value, c.rel, depth + 1))
			.filter((v) => v !== null),
	);
	return values.size === 1 ? [...values][0] : null;
};

// cachedGraph / cachedGraphFrom(device, GROUP, …) call sites (core's; files with their own cachedGraph are skipped)
const used = new Map<string, string[]>();
const unresolved: string[] = [];
for (const f of files) {
	if (f.rel === "src/lib/gpu/core/graph.ts") continue;
	if (/\bfunction\s+cachedGraph\b/.test(f.src)) continue;
	for (const m of f.src.matchAll(
		/\bcachedGraph(?:From)?\s*(?:<[^()]*?>)?\s*\(\s*[^,()]+,\s*([^,()]+?)\s*,/g,
	)) {
		const group = resolve(m[1].trim(), f.rel);
		if (group === null) {
			unresolved.push(`${f.rel}: ${m[1].trim()}`);
			continue;
		}
		const at = used.get(group) ?? [];
		at.push(f.rel);
		used.set(group, at);
	}
}

check(
	"every cachedGraph group argument resolves to a string",
	unresolved.length === 0,
	unresolved.join("; "),
);
check(
	"the scan finds the known call sites",
	used.has("sky-refine") && used.has("solve-coarse") && used.size >= 10,
	`${used.size} groups`,
);

const declared = new Map<string, string>();
const dupGroups: string[] = [];
for (const m of GPU_MODULES)
	for (const g of m.groups) {
		if (declared.has(g)) dupGroups.push(g);
		declared.set(g, m.id);
	}
for (const g of TEST_GRAPH_GROUPS) {
	if (declared.has(g)) dupGroups.push(g);
	declared.set(g, "(test)");
}
check("each group is declared once", dupGroups.length === 0, dupGroups.join());

const missing = [...used.keys()].filter((g) => !declared.has(g));
check(
	"code → manifest: every cachedGraph group is declared",
	missing.length === 0,
	missing.map((g) => `${g} (${used.get(g)?.join(", ")})`).join("; "),
);
const stale = [...declared.keys()].filter((g) => !used.has(g));
check(
	"manifest → code: every declared group is used",
	stale.length === 0,
	stale.map((g) => `${g} (${declared.get(g)})`).join("; "),
);

const ids = GPU_MODULES.map((m) => m.id);
check(
	"module ids unique",
	new Set(ids).size === ids.length,
	ids.filter((id, i) => ids.indexOf(id) !== i).join(),
);
check(
	"islands: I0–I12 once each, in order",
	ISLANDS.map((i) => i.id).join() === ISLAND_IDS.join(),
);
const badIsland = GPU_MODULES.filter((m) => !ISLAND_IDS.includes(m.island));
check(
	"modules name a valid island",
	badIsland.length === 0,
	badIsland.map((m) => m.id).join(),
);
const noPath = GPU_MODULES.flatMap((m) =>
	m.paths.filter((p) => !existsSync(join(ROOT, p))).map((p) => `${m.id}: ${p}`),
);
check("declared paths exist", noPath.length === 0, noPath.join("; "));
const empty = ISLANDS.filter(
	(i) => !GPU_MODULES.some((m) => m.island === i.id),
).map((i) => i.id);
check(
	"every island has at least one module (except I0 loaders)",
	empty.join() === "I0",
	empty.join(),
);

// lookups and the dynamic hook
check(
	"moduleOfGraph: cached id and prefix",
	moduleOfGraph("look-haze-prep|n512")?.id === "look-haze" &&
		moduleOfGraph("look-tex|masks:512")?.id === "look-textures" &&
		moduleOfGraph("nope|x") === undefined,
);
const unregister = registerIsland({
	id: "lab-experiment",
	island: "I9",
	paths: [],
	groups: ["lab-x"],
	realms: ["page"],
	cadence: "per settle",
	resources: [],
	readbacks: [],
	status: "opt-in",
});
const registered = moduleOfGraph("lab-x|k")?.id === "lab-experiment";
unregister();
check(
	"registerIsland adds a module, its unregister removes it",
	registered && !listModules().some((m) => m.id === "lab-experiment"),
);

console.log(
	failures
		? `${failures} FAIL`
		: `app-graph.check: ${used.size} groups in code = manifest (${GPU_MODULES.length} modules)`,
);
process.exit(failures ? 1 : 0);
