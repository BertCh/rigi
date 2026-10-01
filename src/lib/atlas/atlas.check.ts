// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Atlas graph integrity check. Run: npx tsx src/lib/atlas/atlas.check.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ATLAS_NODES } from "./graph";
import {
	conceptView,
	isConceptId,
	isMethodId,
	NODE_OF_CONCEPT,
	NODES_OF_METHOD,
	ONTOLOGY_STATS,
} from "./ontology";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const GROUPS = [
	"capture",
	"world",
	"camera",
	"evidence",
	"solve",
	"render",
	"gpu",
	"nearfield",
	"roll",
	"product",
	"research",
	"infra",
	"math",
];
const KINDS = [
	"concept",
	"subsystem",
	"algorithm",
	"data",
	"experiment",
	"ui",
	"infra",
];
const STATUSES = ["live", "flagged", "research", "killed"];
const STRICT = process.argv.includes("--strict");
const errors: string[] = [];
const warnings: string[] = [];
const err = (m: string) => errors.push(m);
const warn = (m: string) => warnings.push(m);

const ids = new Set<string>();
for (const n of ATLAS_NODES) {
	if (ids.has(n.id)) err(`duplicate id ${n.id}`);
	ids.add(n.id);
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(n.id)) err(`${n.id}: id not kebab-case`);
	if (!GROUPS.includes(n.group)) err(`${n.id}: bad group ${n.group}`);
	if (!KINDS.includes(n.kind)) err(`${n.id}: bad kind ${n.kind}`);
	if (!STATUSES.includes(n.status)) err(`${n.id}: bad status ${n.status}`);
	if (!n.title || !n.summary || !n.visual)
		err(`${n.id}: missing title/summary/visual`);
	if (n.tagline.length === 0 || n.tagline.length > 90)
		err(`${n.id}: tagline length ${n.tagline.length}`);
	for (const p of [...n.modules, ...n.reports])
		if (!existsSync(resolve(ROOT, p))) err(`${n.id}: missing path ${p}`);
}

const adj = new Map<string, Set<string>>(
	ATLAS_NODES.map((n) => [n.id, new Set()]),
);
const deg = new Map<string, number>(ATLAS_NODES.map((n) => [n.id, 0]));
for (const n of ATLAS_NODES) {
	const seen = new Set<string>();
	for (const e of n.related) {
		if (!ids.has(e.id)) {
			err(`${n.id}: dangling edge -> ${e.id}`);
			continue;
		}
		if (e.id === n.id) err(`${n.id}: self loop`);
		if (seen.has(e.id)) err(`${n.id}: duplicate edge -> ${e.id}`);
		seen.add(e.id);
		if (!e.rel) err(`${n.id}: empty rel`);
		adj.get(n.id)!.add(e.id);
		adj.get(e.id)!.add(n.id);
		deg.set(n.id, deg.get(n.id)! + 1);
		deg.set(e.id, deg.get(e.id)! + 1);
	}
}
for (const [id, d] of deg) if (d < 2) err(`${id}: fewer than 2 edges`);

const start = ATLAS_NODES[0]?.id;
const vis = new Set<string>([start]);
const stack = [start];
while (stack.length)
	for (const y of adj.get(stack.pop()!) ?? [])
		if (!vis.has(y)) {
			vis.add(y);
			stack.push(y);
		}
for (const n of ATLAS_NODES)
	if (!vis.has(n.id)) err(`${n.id}: not connected to ${start}`);

// ---- ontology link ----------------------------------------------------------------------------
const byId = new Map(ATLAS_NODES.map((n) => [n.id, n]));
const owner = new Map<string, string>();
for (const n of ATLAS_NODES) {
	if (n.ontologyId !== undefined) {
		if (!isConceptId(n.ontologyId))
			err(`${n.id}: ontologyId ${n.ontologyId} is not a concept in CONCEPTS`);
		else if (owner.has(n.ontologyId))
			err(
				`${n.id}: ontologyId ${n.ontologyId} also claimed by ${owner.get(n.ontologyId)}`,
			);
		else owner.set(n.ontologyId, n.id);
	}
	if (isConceptId(n.id) && n.ontologyId !== n.id) {
		err(
			`${n.id}: node id is a concept id but ontologyId is ${n.ontologyId === undefined ? "missing" : n.ontologyId}`,
		);
	}
	for (const m of n.methodIds ?? [])
		if (!isMethodId(m)) err(`${n.id}: unknown methodId ${m}`);
}

// Taxonomy agreement: a curated is-a / part-of edge between two linked nodes must match the ontology.
// Edge direction: node --rel--> e.id reads "node is-a e.id" / "node part-of e.id".
const ancestors = (c: string): Set<string> => {
	const out = new Set<string>();
	for (
		let cur = isConceptId(c) ? conceptView(c).parent?.concept : undefined;
		cur && !out.has(cur);
		cur = isConceptId(cur) ? conceptView(cur).parent?.concept : undefined
	)
		out.add(cur);
	return out;
};
for (const n of ATLAS_NODES) {
	if (!n.ontologyId || !isConceptId(n.ontologyId)) continue;
	for (const e of n.related) {
		const t = byId.get(e.id);
		if (
			!t?.ontologyId ||
			!isConceptId(t.ontologyId) ||
			(e.rel !== "is-a" && e.rel !== "part-of")
		)
			continue;
		const a = n.ontologyId;
		const b = t.ontologyId;
		if (a === b) continue; // double-link, reported above
		const va = conceptView(a);
		const isAB = ancestors(a).has(b);
		const isBA = ancestors(b).has(a);
		const hasAB = va.partOf.some(
			(p) => p.concept === b || ancestors(b).has(p.concept),
		); // a is a part of b
		const hasBA = va.parts.some(
			(p) => p.concept === b || ancestors(b).has(p.concept),
		); // b is a part of a
		const edge = `${n.id} ${e.rel} ${e.id}`;
		if (e.rel === "is-a") {
			if (isAB) continue;
			if (isBA) err(`${edge}: inverted, ontology says ${b} is-a ${a}`);
			else if (hasAB || hasBA)
				err(
					`${edge}: contradicts ontology, ${hasBA ? `${a} HAS ${b}` : `${b} HAS ${a}`} (a has/part-of, not is-a)`,
				);
			else
				warn(
					`${edge}: atlas-only is-a between linked nodes (${a}, ${b} unrelated in the ontology)`,
				);
		} else {
			if (hasAB) continue;
			if (hasBA) err(`${edge}: inverted, ontology says ${b} is a part of ${a}`);
			else if (isAB || isBA)
				err(
					`${edge}: contradicts ontology, ${isAB ? `${a} IS-A ${b}` : `${b} IS-A ${a}`}`,
				);
			else
				warn(
					`${edge}: atlas-only part-of between linked nodes (${a}, ${b} unrelated in the ontology)`,
				);
		}
	}
}

// No coverage warnings: the Atlas is a deliberately tiny curated subset, not a mirror of the ontology.
const allConcepts = ONTOLOGY_STATS.concepts;
const allMethods = ONTOLOGY_STATS.methods;

// Summaries that restate ontology counts drift; they must cite the live numbers via the adapter instead.
const COUNT_RE =
	/\b\d+\s+(nouns|concepts|scales|policies|states|unions|methods|entries)\b/;
for (const n of ATLAS_NODES) {
	const cites =
		n.modules.some((p) => p.startsWith("src/lib/ontology/")) ||
		n.reports.some((p) => /^reports\/ontology[^/]*\.md$/.test(p));
	const m = cites ? COUNT_RE.exec(n.summary) : null;
	if (m)
		err(
			`${n.id}: summary hard-codes an ontology count ("${m[0]}"), which will drift`,
		);
}

// ---- import boundary --------------------------------------------------------------------------
const walk = (dir: string): string[] => {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((f) => {
		const p = resolve(dir, f);
		return statSync(p).isDirectory()
			? walk(p)
			: /\.(ts|tsx|mts|mjs|js|jsx)$/.test(f)
				? [p]
				: [];
	});
};
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");
const atlasFiles = [
	...walk(resolve(ROOT, "src/lib/atlas")),
	...walk(resolve(ROOT, "src/components/atlas")),
	...readdirSync(resolve(ROOT, "src/routes"))
		.filter((f) => /^atlas.*\.tsx$/.test(f))
		.map((f) => resolve(ROOT, "src/routes", f)),
];
const ontologyFiles = walk(resolve(ROOT, "src/lib/ontology"));
const IMPORT_RE =
	/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
const resolveSpec = (file: string, spec: string): string | null => {
	if (spec.startsWith("#/")) return `src/${spec.slice(2)}`;
	if (spec.startsWith(".")) return rel(resolve(dirname(file), spec));
	return null;
};
const ADAPTER = "src/lib/atlas/ontology.ts";
for (const f of atlasFiles) {
	const r = rel(f);
	const src = readFileSync(f, "utf8");
	for (const m of src.matchAll(IMPORT_RE)) {
		const spec = m[1];
		const path = resolveSpec(f, spec);
		const typeOnly = /^import\s+type\b/.test(
			src.slice(src.lastIndexOf("\nimport", m.index) + 1),
		);
		if (
			/\/crosswalk\//.test(spec) ||
			(path && /^src\/lib\/ontology\/crosswalk(\/|$)/.test(path))
		) {
			err(`${r}: imports the ontology crosswalk (${spec})`);
			continue;
		}
		if (
			path === "src/lib/ontology" ||
			/^src\/lib\/ontology\/index(\.tsx?)?$/.test(path ?? "") ||
			/\/ontology\/index$/.test(spec)
		) {
			err(
				`${r}: imports the ontology barrel (${spec}); import a specific module`,
			);
			continue;
		}
		if (
			path?.startsWith("src/lib/ontology/") &&
			r !== ADAPTER &&
			!(r === "src/lib/atlas/types.ts" && typeOnly)
		) {
			err(
				`${r}: imports ${spec}; only ${ADAPTER} (and type-only imports in types.ts) may import src/lib/ontology`,
			);
		}
	}
}
for (const f of ontologyFiles) {
	const r = rel(f);
	for (const m of readFileSync(f, "utf8").matchAll(IMPORT_RE)) {
		const path = resolveSpec(f, m[1]);
		if (
			path &&
			(/^src\/lib\/atlas(\/|$)/.test(path) ||
				/^src\/components\/atlas(\/|$)/.test(path) ||
				/^src\/routes\/atlas/.test(path))
		)
			err(`${r}: ontology imports atlas (${m[1]})`);
	}
}

const rels = new Set(ATLAS_NODES.flatMap((n) => n.related.map((e) => e.rel)));
for (const w of warnings) console.warn(`warning: ${w}`);
const fatal = errors.length > 0 || (STRICT && warnings.length > 0);
if (fatal) {
	console.error(errors.join("\n"));
	if (STRICT && warnings.length)
		console.error(`--strict: ${warnings.length} warning(s) treated as errors`);
	process.exit(1);
}
console.log(
	`linked ${NODE_OF_CONCEPT.size}/${allConcepts} concepts, ${NODES_OF_METHOD.size}/${allMethods} methods`,
);
console.log(
	`atlas ok: ${ATLAS_NODES.length} nodes, ${ATLAS_NODES.reduce((a, n) => a + n.related.length, 0)} edges, ${rels.size} rels${warnings.length ? `, ${warnings.length} warnings` : ""}`,
);
